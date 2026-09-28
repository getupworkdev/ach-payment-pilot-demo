// Minimal SQL interface the domain code depends on. Production wiring uses
// deno-postgres against SUPABASE_DB_URL (see postgres_db.ts); tests use PGlite
// with the real migration applied, so the trigger and constraints are the ones
// that actually ship.

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** SQLSTATE raised by the payments trigger for a refused transition. */
export const ILLEGAL_TRANSITION = "PX409";

/** Pull a SQLSTATE out of whichever driver threw. */
export function sqlState(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { code?: unknown; fields?: { code?: unknown } };
  if (typeof e.fields?.code === "string") return e.fields.code; // deno-postgres
  if (typeof e.code === "string") return e.code; // PGlite, node-postgres
  return undefined;
}

export function isIllegalTransition(err: unknown): boolean {
  return sqlState(err) === ILLEGAL_TRANSITION;
}
