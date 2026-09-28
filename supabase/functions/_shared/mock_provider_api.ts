// In-memory stand-in for the provider's authenticated HTTP API:
//
//   POST /oauth/token   client-credentials grant, one client per entity,
//                       returns a signed JWT with sub = entity id
//   POST /refunds       create a refund, idempotent on the Idempotency-Key header
//
// It is strict on purpose - it verifies signature, expiry, and that the token's
// entity, the x-entity-id header, the body's entity_id and the payment's owner
// all agree - and it logs every request so tests can assert on exactly what
// was sent. `fetch` is a drop-in for globalThis.fetch, so the real client code
// runs against it in-process; mock_services.ts serves the same handler over HTTP.

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(raw).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export interface ProviderPaymentRecord {
  entityId: string;
  amountCents: number;
  status: "authorized" | "settled" | "returned" | "refunded";
}

export type ApiFault =
  | "timeout" // no response; nothing processed
  | "timeout_after_commit" // processed, response lost
  | "unavailable" // 503
  | "rate_limited"; // 429 with Retry-After

export interface RequestLogEntry {
  path: string;
  status: number;
  tokenEntity: string | null;
  headerEntity: string | null;
  bodyEntity: string | null;
  idempotencyKey: string | null;
}

interface StoredRefund {
  id: string;
  entityId: string;
  paymentId: string;
  amountCents: number;
  fingerprint: string;
}

export interface MockProviderApiOptions {
  clients: Record<string, { clientId: string; clientSecret: string }>;
  payments: (paymentId: string) => ProviderPaymentRecord | null;
  now?: () => number;
  tokenTtlSeconds?: number;
  signingKey?: string;
}

export class MockProviderApi {
  readonly log: RequestLogEntry[] = [];
  #refunds = new Map<string, StoredRefund>();
  #faults: ApiFault[] = [];
  #down = false;
  #liveTokens = new Map<string, Set<string>>(); // entity -> jtis issued
  #revoked = new Set<string>();
  #tokensIssued = new Map<string, number>();
  #seq = 0;
  #key: Promise<CryptoKey>;
  #now: () => number;
  #ttl: number;

  constructor(private readonly opts: MockProviderApiOptions) {
    this.#now = opts.now ?? Date.now;
    this.#ttl = opts.tokenTtlSeconds ?? 3600;
    this.#key = crypto.subtle.importKey(
      "raw",
      encoder.encode(opts.signingKey ?? "mock-provider-signing-key"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  // --- simulation controls ----------------------------------------------------

  /** Queue a fault for the next /refunds request. */
  injectFault(fault: ApiFault): void {
    this.#faults.push(fault);
  }

  /** Outage: every /refunds request fails with 503 until turned off. */
  setDown(down: boolean): void {
    this.#down = down;
  }

  /** Revoke every token issued to this entity so far (the next request gets 401). */
  revokeTokens(entityId: string): void {
    for (const jti of this.#liveTokens.get(entityId) ?? []) this.#revoked.add(jti);
  }

  refundCount(): number {
    return this.#refunds.size;
  }

  tokensIssued(entityId: string): number {
    return this.#tokensIssued.get(entityId) ?? 0;
  }

  /** How many /refunds requests carried this idempotency key. */
  attemptsFor(idempotencyKey: string): number {
    return this.log.filter((l) => l.path === "/refunds" && l.idempotencyKey === idempotencyKey).length;
  }

  // --- transport ------------------------------------------------------------------

  /** Same signature as globalThis.fetch. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname.replace(/^.*?(\/oauth\/token|\/refunds)$/, "$1");

    if (path === "/refunds") {
      const fault = this.#down ? "unavailable" : this.#faults.shift();
      if (fault === "timeout") throw new DOMException("The signal has been aborted", "TimeoutError");
      if (fault === "unavailable") return this.#logged(req, path, json(503, { error: "service unavailable" }));
      if (fault === "rate_limited") {
        return this.#logged(req, path, json(429, { error: "slow down" }, { "retry-after": "30" }));
      }
      const res = await this.handle(req, path);
      if (fault === "timeout_after_commit") throw new DOMException("The signal has been aborted", "TimeoutError");
      return res;
    }
    return this.handle(req, path);
  };

  async handle(req: Request, path = new URL(req.url).pathname): Promise<Response> {
    if (req.method === "POST" && path === "/oauth/token") return this.#token(req);
    if (req.method === "POST" && path === "/refunds") {
      const pristine = req.clone(); // #createRefund consumes the body; the log needs it
      return this.#logged(pristine, path, await this.#createRefund(req));
    }
    return json(404, { error: "not found" });
  }

  // --- endpoints --------------------------------------------------------------------

  async #token(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const entry = Object.entries(this.opts.clients).find(([, c]) => c.clientId === form.get("client_id"));
    if (
      form.get("grant_type") !== "client_credentials" || !entry || entry[1].clientSecret !== form.get("client_secret")
    ) {
      return json(401, { error: "invalid_client" });
    }
    const [entityId] = entry;
    const iat = Math.floor(this.#now() / 1000);
    const jti = `tok_${++this.#seq}`;
    const token = await this.#sign({ sub: entityId, iat, exp: iat + this.#ttl, jti });
    this.#tokensIssued.set(entityId, this.tokensIssued(entityId) + 1);
    if (!this.#liveTokens.has(entityId)) this.#liveTokens.set(entityId, new Set());
    this.#liveTokens.get(entityId)!.add(jti);
    return json(200, { access_token: token, token_type: "Bearer", expires_in: this.#ttl });
  }

  async #createRefund(req: Request): Promise<Response> {
    const auth = await this.#authenticate(req);
    if (auth instanceof Response) return auth;
    const entityId = auth;

    if (req.headers.get("x-entity-id") !== entityId) return json(403, { error: "x-entity-id does not match token" });
    const key = req.headers.get("idempotency-key");
    if (!key) return json(400, { error: "Idempotency-Key header required" });

    const body = await req.json() as {
      entity_id?: string;
      payment_id?: string;
      amount_cents?: number;
      reason?: string;
    };
    if (body.entity_id !== entityId) return json(403, { error: "body entity_id does not match token" });

    const fingerprint = JSON.stringify([body.payment_id, body.amount_cents, body.reason]);
    const previous = this.#refunds.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return json(422, { error: "idempotency key reused with a different request" });
      }
      return json(200, { id: previous.id, status: "pending", replayed: true });
    }

    const payment = body.payment_id ? this.opts.payments(body.payment_id) : null;
    if (!payment) return json(422, { error: "unknown payment" });
    if (payment.entityId !== entityId) return json(403, { error: "payment belongs to another entity" });
    if (payment.status !== "settled") return json(422, { error: `payment is ${payment.status}, not settled` });
    if (!Number.isInteger(body.amount_cents) || body.amount_cents! <= 0 || body.amount_cents! > payment.amountCents) {
      return json(422, { error: "amount_cents must be between 1 and the payment amount" });
    }
    if (!body.reason?.trim()) return json(422, { error: "reason is required" });

    const refund: StoredRefund = {
      id: `re_${++this.#seq}`,
      entityId,
      paymentId: body.payment_id!,
      amountCents: body.amount_cents!,
      fingerprint,
    };
    this.#refunds.set(key, refund);
    return json(201, { id: refund.id, status: "pending" });
  }

  /** Returns the token's entity, or an error response. */
  async #authenticate(req: Request): Promise<string | Response> {
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return json(401, { error: "missing token" });
    const expected = b64url(
      new Uint8Array(await crypto.subtle.sign("HMAC", await this.#key, encoder.encode(`${h}.${p}`))),
    );
    if (expected !== s) return json(401, { error: "bad signature" });
    const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))) as {
      sub: string;
      exp: number;
      jti: string;
    };
    if (this.#now() >= claims.exp * 1000) return json(401, { error: "token expired" });
    if (this.#revoked.has(claims.jti)) return json(401, { error: "token revoked" });
    return claims.sub;
  }

  async #sign(claims: Record<string, unknown>): Promise<string> {
    const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await this.#key, encoder.encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(sig)}`;
  }

  async #logged(req: Request, path: string, res: Response): Promise<Response> {
    let tokenEntity: string | null = null;
    const p = req.headers.get("authorization")?.split(".")[1];
    if (p) {
      try {
        tokenEntity = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/"))).sub ?? null;
      } catch { /* malformed token: leave null */ }
    }
    let bodyEntity: string | null = null;
    try {
      bodyEntity = (await req.clone().json()).entity_id ?? null;
    } catch { /* body already read or not JSON */ }
    this.log.push({
      path,
      status: res.status,
      tokenEntity,
      headerEntity: req.headers.get("x-entity-id"),
      bodyEntity,
      idempotencyKey: req.headers.get("idempotency-key"),
    });
    return res;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
