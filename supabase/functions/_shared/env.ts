import { HttpPosClient, HttpProviderClient } from "./http_clients.ts";
import { postgresDb } from "./postgres_db.ts";

export function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function envDeps() {
  const mockBase = Deno.env.get("MOCK_SERVICES_URL") ?? "http://host.docker.internal:54400";
  return {
    db: postgresDb,
    provider: new HttpProviderClient(mockBase),
    pos: new HttpPosClient(mockBase, Number(Deno.env.get("POS_TIMEOUT_MS") ?? "3000")),
  };
}
