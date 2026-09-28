import { EntityTokenManager, InMemoryCredentialStore } from "./entity_tokens.ts";
import { HttpPosClient, HttpProviderClient } from "./http_clients.ts";
import { OutboxWorker } from "./outbox.ts";
import { postgresDb } from "./postgres_db.ts";
import { ProviderApiClient } from "./provider_api.ts";

export function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function mockBase(): string {
  return Deno.env.get("MOCK_SERVICES_URL") ?? "http://host.docker.internal:54400";
}

export function envDeps() {
  return {
    db: postgresDb,
    provider: new HttpProviderClient(mockBase()),
    pos: new HttpPosClient(mockBase(), Number(Deno.env.get("POS_TIMEOUT_MS") ?? "3000")),
  };
}

/**
 * Authenticated provider API client. Credentials come from
 * PROVIDER_ENTITY_CREDENTIALS, a JSON map of entity id -> client credentials.
 * In production each entity's secret would live in Supabase Vault instead.
 */
export function envProviderApi(): ProviderApiClient {
  const base = `${mockBase()}/provider-api`;
  const tokens = new EntityTokenManager({
    credentials: InMemoryCredentialStore.fromJson(required("PROVIDER_ENTITY_CREDENTIALS")),
    tokenUrl: `${base}/oauth/token`,
  });
  return new ProviderApiClient({
    baseUrl: base,
    tokens,
    timeoutMs: Number(Deno.env.get("PROVIDER_TIMEOUT_MS") ?? "5000"),
  });
}

export function envOutboxWorker(): OutboxWorker {
  return new OutboxWorker({ db: postgresDb, client: envProviderApi() });
}
