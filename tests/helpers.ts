// Each test gets a fresh database with every migration in supabase/migrations
// applied, so the trigger and constraints under test are exactly the ones that
// ship.
//
// Default: in-process Postgres (PGlite). No Docker, but a single connection,
// so "concurrent" tests interleave rather than truly race.
// With TEST_DATABASE_URL set: a throwaway database per test on that server,
// through the same deno-postgres adapter the Edge Functions use, with real
// concurrent connections.

import { PGlite } from "@electric-sql/pglite";
import { Client } from "jsr:@db/postgres@0.19.5";
import type { Db, Queryable } from "../supabase/functions/_shared/db.ts";
import { createPostgresDb } from "../supabase/functions/_shared/postgres_db.ts";
import { MockPos } from "../supabase/functions/_shared/mock_pos.ts";
import { MockProvider } from "../supabase/functions/_shared/mock_provider.ts";

const migrationsDir = new URL("../supabase/migrations/", import.meta.url);

async function loadMigrations(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(migrationsDir)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();
  return Promise.all(names.map((n) => Deno.readTextFile(new URL(n, migrationsDir))));
}

export interface TestDb extends Db {
  close(): Promise<void>;
}

export function freshDb(): Promise<TestDb> {
  const url = Deno.env.get("TEST_DATABASE_URL");
  return url ? freshServerDb(url) : freshPgliteDb();
}

async function freshServerDb(adminUrl: string): Promise<TestDb> {
  const name = `pilot_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client(adminUrl);
  await admin.connect();
  await admin.queryArray(`create database ${name}`);

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const setup = new Client(url.toString());
  await setup.connect();
  for (const sql of await loadMigrations()) await setup.queryArray(sql);
  await setup.end();

  const db = createPostgresDb(url.toString(), 10);
  return {
    ...db,
    async close() {
      await db.end();
      await admin.queryArray(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}

async function freshPgliteDb(): Promise<TestDb> {
  const pg = new PGlite();
  for (const sql of await loadMigrations()) await pg.exec(sql);

  const wrap = (q: { query: PGlite["query"] }): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await q.query<T>(sql, params);
      return { rows: res.rows };
    },
  });

  return {
    ...wrap(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
}

export async function setup() {
  const db = await freshDb();
  return { db, provider: new MockProvider(), pos: new MockPos() };
}

/** Insert a payment directly, optionally walking it through legal transitions. */
export async function seedPayment(
  db: Queryable,
  opts: { providerPaymentId?: string; amountCents?: number; path?: ("settled" | "returned" | "refunded")[] } = {},
): Promise<string> {
  const { rows: [p] } = await db.query<{ id: string }>(
    `insert into payments (provider_payment_id, amount_cents) values ($1, $2) returning id`,
    [opts.providerPaymentId ?? `py_seed_${crypto.randomUUID()}`, opts.amountCents ?? 1250],
  );
  for (const step of opts.path ?? []) {
    await db.query(
      `update payments set status = $2::text::payment_status,
         return_code = case when $2::text = 'returned' then 'R01' end
       where id = $1`,
      [p.id, step],
    );
  }
  return p.id;
}

export async function count(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const { rows: [r] } = await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) s`, params);
  return r.n;
}
