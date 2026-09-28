// Database-level tests: the trigger is the last line of defence, so these go
// straight at SQL and bypass the application code entirely.

import { assertEquals, assertRejects } from "@std/assert";
import { ILLEGAL_TRANSITION, sqlState } from "../supabase/functions/_shared/db.ts";
import { freshDb, seedPayment } from "./helpers.ts";

async function assertRefused(fn: () => Promise<unknown>, code = ILLEGAL_TRANSITION) {
  const err = await assertRejects(fn);
  assertEquals(sqlState(err), code, `expected SQLSTATE ${code}, got ${sqlState(err)}: ${(err as Error).message}`);
}

async function statusOf(db: Awaited<ReturnType<typeof freshDb>>, id: string) {
  const { rows: [r] } = await db.query<{ status: string }>(`select status from payments where id = $1`, [id]);
  return r.status;
}

Deno.test("illegal transition returned -> settled is refused by the database", async () => {
  const db = await freshDb();
  try {
    const id = await seedPayment(db, { path: ["settled", "returned"] });
    await assertRefused(() =>
      db.query(`update payments set status = 'settled', return_code = null where id = $1`, [id])
    );
    assertEquals(await statusOf(db, id), "returned");
  } finally {
    await db.close();
  }
});

Deno.test("every edge not in the state machine is refused", async () => {
  const db = await freshDb();
  try {
    const cases: { path: ("settled" | "returned" | "refunded")[]; to: string }[] = [
      { path: [], to: "returned" }, // must settle before it can bounce
      { path: [], to: "refunded" }, // nothing to refund yet
      { path: ["settled"], to: "authorized" },
      { path: ["settled", "refunded"], to: "settled" },
      { path: ["settled", "refunded"], to: "returned" },
      { path: ["settled", "returned"], to: "refunded" },
      { path: ["settled", "returned"], to: "authorized" },
    ];
    for (const c of cases) {
      const id = await seedPayment(db, { path: c.path });
      const before = await statusOf(db, id);
      await assertRefused(() =>
        db.query(
          `update payments set status = $2::text::payment_status,
             return_code = case when $2::text = 'returned' then 'R01' end
           where id = $1`,
          [id, c.to],
        )
      );
      assertEquals(await statusOf(db, id), before, `${before} -> ${c.to} should have been refused`);
    }
  } finally {
    await db.close();
  }
});

Deno.test("legal path is accepted and every change lands in the history", async () => {
  const db = await freshDb();
  try {
    const id = await seedPayment(db, { path: ["settled", "returned"] });
    const { rows } = await db.query<{ from_status: string | null; to_status: string; return_code: string | null }>(
      `select from_status, to_status, return_code from payment_status_history where payment_id = $1 order by id`,
      [id],
    );
    assertEquals(rows, [
      { from_status: null, to_status: "authorized", return_code: null },
      { from_status: "authorized", to_status: "settled", return_code: null },
      { from_status: "settled", to_status: "returned", return_code: "R01" },
    ]);
  } finally {
    await db.close();
  }
});

Deno.test("payments must be created as authorized", async () => {
  const db = await freshDb();
  try {
    await assertRefused(() =>
      db.query(`insert into payments (provider_payment_id, amount_cents, status) values ('py_x', 100, 'settled')`)
    );
  } finally {
    await db.close();
  }
});

Deno.test("a return without an R-code, or with a malformed one, is rejected", async () => {
  const db = await freshDb();
  try {
    const id = await seedPayment(db, { path: ["settled"] });
    await assertRefused(() => db.query(`update payments set status = 'returned' where id = $1`, [id]), "23514");
    await assertRefused(
      () => db.query(`update payments set status = 'returned', return_code = 'NSF' where id = $1`, [id]),
      "23514",
    );
    assertEquals(await statusOf(db, id), "settled");
  } finally {
    await db.close();
  }
});

Deno.test("payments cannot be deleted", async () => {
  const db = await freshDb();
  try {
    const id = await seedPayment(db);
    await assertRefused(() => db.query(`delete from payments where id = $1`, [id]));
  } finally {
    await db.close();
  }
});

Deno.test("webhook_events.event_id is unique", async () => {
  const db = await freshDb();
  try {
    const insert = () =>
      db.query(`insert into webhook_events (event_id, type, payload) values ('evt_1', 'payment.settled', '{}')`);
    await insert();
    await assertRefused(insert, "23505");
  } finally {
    await db.close();
  }
});
