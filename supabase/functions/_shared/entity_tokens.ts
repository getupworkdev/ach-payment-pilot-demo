// One provider access token per entity.
//
// Each entity (merchant / legal entity) has its own client credentials at the
// provider. Tokens are fetched with the client-credentials grant, cached per
// entity, and refreshed shortly before they expire. Concurrent callers for the
// same entity share one in-flight refresh.
//
// A token is only cached after checking its `sub` claim is the entity we asked
// for. If credentials are mis-filed (entity A's slot holds B's secret), the
// provider would happily issue B a token; this check turns that into a hard
// error instead of A's transactions going out under B's identity.

import { decodeClaims } from "./jwt.ts";

export interface EntityCredentials {
  clientId: string;
  clientSecret: string;
}

export interface CredentialStore {
  /** Throws UnknownEntityError if there are no credentials for this entity. */
  get(entityId: string): Promise<EntityCredentials>;
}

export class UnknownEntityError extends Error {
  constructor(readonly entityId: string) {
    super(`no provider credentials for entity ${entityId}`);
    this.name = "UnknownEntityError";
  }
}

export class EntityTokenMismatchError extends Error {
  constructor(readonly requested: string, readonly issuedFor: string | undefined) {
    super(`asked for a token for ${requested} but the provider issued one for ${issuedFor ?? "nobody"}`);
    this.name = "EntityTokenMismatchError";
  }
}

export class TokenRequestError extends Error {
  constructor(readonly entityId: string, readonly status: number | null, detail: string) {
    super(`token request for ${entityId} failed: ${detail}`);
    this.name = "TokenRequestError";
  }
  /** 5xx, 429 or no response at all: worth retrying later. Bad credentials are not. */
  get temporary(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

/**
 * Credentials kept per entity, each in its own record. In production this
 * would read Supabase Vault (one secret per entity); here it's a map.
 */
export class InMemoryCredentialStore implements CredentialStore {
  #byEntity: Map<string, EntityCredentials>;

  constructor(entries: Record<string, EntityCredentials>) {
    this.#byEntity = new Map(Object.entries(entries).map(([id, c]) => [id, { ...c }]));
  }

  async get(entityId: string): Promise<EntityCredentials> {
    const c = this.#byEntity.get(entityId);
    if (!c) throw new UnknownEntityError(entityId);
    return { ...c };
  }

  /** `{"store-001":{"client_id":"...","client_secret":"..."}}` */
  static fromJson(json: string): InMemoryCredentialStore {
    const raw = JSON.parse(json) as Record<string, { client_id: string; client_secret: string }>;
    return new InMemoryCredentialStore(
      Object.fromEntries(
        Object.entries(raw).map(([id, c]) => [id, { clientId: c.client_id, clientSecret: c.client_secret }]),
      ),
    );
  }
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export interface EntityTokenManagerOptions {
  credentials: CredentialStore;
  tokenUrl: string;
  fetch?: typeof fetch;
  /** Refresh this long before expiry, so a token never expires mid-request. Default 60s. */
  refreshBeforeMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export class EntityTokenManager {
  #cache = new Map<string, CachedToken>();
  #inflight = new Map<string, Promise<CachedToken>>();
  #fetch: typeof fetch;
  #refreshBeforeMs: number;
  #timeoutMs: number;
  #now: () => number;
  #fetches = new Map<string, number>();

  constructor(private readonly opts: EntityTokenManagerOptions) {
    this.#fetch = opts.fetch ?? fetch;
    this.#refreshBeforeMs = opts.refreshBeforeMs ?? 60_000;
    this.#timeoutMs = opts.timeoutMs ?? 5_000;
    this.#now = opts.now ?? Date.now;
  }

  /** A valid token for this entity, from cache or freshly issued. */
  async token(entityId: string): Promise<string> {
    const cached = this.#cache.get(entityId);
    if (cached && this.#now() < cached.expiresAt - this.#refreshBeforeMs) return cached.accessToken;
    return (await this.#refresh(entityId)).accessToken;
  }

  /**
   * Drop a token the provider rejected. Only drops it if it's still the one
   * cached, so a late 401 can't throw away a newer token.
   */
  invalidate(entityId: string, token: string): void {
    if (this.#cache.get(entityId)?.accessToken === token) this.#cache.delete(entityId);
  }

  /** Token requests made per entity (for tests and metrics). */
  fetchCount(entityId: string): number {
    return this.#fetches.get(entityId) ?? 0;
  }

  #refresh(entityId: string): Promise<CachedToken> {
    let pending = this.#inflight.get(entityId);
    if (!pending) {
      pending = this.#issue(entityId).finally(() => this.#inflight.delete(entityId));
      this.#inflight.set(entityId, pending);
    }
    return pending;
  }

  async #issue(entityId: string): Promise<CachedToken> {
    const creds = await this.opts.credentials.get(entityId);
    this.#fetches.set(entityId, this.fetchCount(entityId) + 1);

    let res: Response;
    try {
      res = await this.#fetch(this.opts.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new TokenRequestError(entityId, null, (err as Error).name);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new TokenRequestError(entityId, res.status, `HTTP ${res.status}`);
    }

    const body = await res.json() as { access_token: string; expires_in: number };
    const claims = decodeClaims(body.access_token);
    if (claims.sub !== entityId) throw new EntityTokenMismatchError(entityId, claims.sub);

    const byExpiresIn = this.#now() + body.expires_in * 1000;
    const byClaim = typeof claims.exp === "number" ? claims.exp * 1000 : Infinity;
    const token = { accessToken: body.access_token, expiresAt: Math.min(byExpiresIn, byClaim) };
    this.#cache.set(entityId, token);
    return token;
  }
}
