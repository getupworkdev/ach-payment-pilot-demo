// HTTP client for the provider's API, routed by entity.
//
// Every request names its entity. The client fetches that entity's token and
// sets it together with the x-entity-id header; there is no way to pass a
// token in. If the body also carries an entity_id, it must match, or the
// request is refused before it leaves the process.

import type { EntityTokenManager } from "./entity_tokens.ts";

export interface ProviderRequest {
  entityId: string;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface ProviderResponse {
  status: number;
  body: unknown;
  /** From a Retry-After header, if the provider sent one. */
  retryAfterMs: number | null;
}

export class EntityRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityRoutingError";
  }
}

/** No response: timed out or couldn't connect. The request may or may not have been processed. */
export class ProviderUnreachableError extends Error {
  constructor(readonly failure: string) {
    super(`provider unreachable: ${failure}`);
    this.name = "ProviderUnreachableError";
  }
}

export interface ProviderApiClientOptions {
  baseUrl: string;
  tokens: EntityTokenManager;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ProviderApiClient {
  #fetch: typeof fetch;

  constructor(private readonly opts: ProviderApiClientOptions) {
    this.#fetch = opts.fetch ?? fetch;
  }

  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const bodyEntity = req.body?.entity_id;
    if (bodyEntity !== undefined && bodyEntity !== req.entityId) {
      throw new EntityRoutingError(`request for ${req.entityId} carries a body for ${String(bodyEntity)}`);
    }

    let { res, token } = await this.#attempt(req);
    if (res.status === 401) {
      // Revoked or expired early at the provider: drop it and try once more.
      await res.body?.cancel();
      this.opts.tokens.invalidate(req.entityId, token);
      ({ res } = await this.#attempt(req));
    }

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) };
  }

  async #attempt(req: ProviderRequest): Promise<{ res: Response; token: string }> {
    const token = await this.opts.tokens.token(req.entityId);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "x-entity-id": req.entityId,
    };
    if (req.body) headers["content-type"] = "application/json";
    if (req.idempotencyKey) headers["idempotency-key"] = req.idempotencyKey;
    try {
      const res = await this.#fetch(new URL(req.path.replace(/^\//, ""), withSlash(this.opts.baseUrl)), {
        method: req.method,
        headers,
        body: req.body ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      return { res, token };
    } catch (err) {
      throw new ProviderUnreachableError((err as Error).name);
    }
  }
}

function withSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
}
