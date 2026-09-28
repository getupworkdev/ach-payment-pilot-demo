import { Pool, type PoolClient } from "jsr:@db/postgres@0.19.5";
import type { Db, Queryable } from "./db.ts";

function wrap(client: PoolClient): Queryable {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await client.queryObject<T>(sql, params);
      return { rows: res.rows };
    },
  };
}

export function createPostgresDb(url: string, poolSize = 3): Db & { end(): Promise<void> } {
  const pool = new Pool(url, poolSize, true);

  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const client = await pool.connect();
      try {
        return await wrap(client).query<T>(sql, params);
      } finally {
        client.release();
      }
    },

    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.queryArray("begin");
        try {
          const result = await fn(wrap(client));
          await client.queryArray("commit");
          return result;
        } catch (err) {
          await client.queryArray("rollback");
          throw err;
        }
      } finally {
        client.release();
      }
    },

    end: () => pool.end(),
  };
}

let shared: Db | undefined;

/** Pool for the Edge Functions, built from SUPABASE_DB_URL on first use. */
export const postgresDb: Db = {
  query: (sql, params) => getShared().query(sql, params),
  transaction: (fn) => getShared().transaction(fn),
};

function getShared(): Db {
  if (!shared) {
    const url = Deno.env.get("SUPABASE_DB_URL");
    if (!url) throw new Error("SUPABASE_DB_URL is not set");
    shared = createPostgresDb(url);
  }
  return shared;
}
