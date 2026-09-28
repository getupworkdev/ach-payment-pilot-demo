import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { EntityTokenManager, InMemoryCredentialStore } from "../supabase/functions/_shared/entity_tokens.ts";
import { MockProviderApi, type ProviderPaymentRecord } from "../supabase/functions/_shared/mock_provider_api.ts";
import {
  backoffDelay,
  createRefund,
  OutboxWorker,
  type OutboxWorkerOptions,
  RefundRequestError,
  requestRefund,
} from "../supabase/functions/_shared/outbox.ts";
import { ProviderApiClient } from "../supabase/functions/_shared/provider_api.ts";
import { count, freshDb, seedPayment, type TestDb } from "./helpers.ts";

const CLIENTS = {
  "store-a": { clientId: "client-a", clientSecret: "secret-a" },
  "store-b": { clientId: "client-b", clientSecret: "secret-b" },
};

async function setup(workerOpts: Partial<OutboxWorkerOptions> = {}) {
  const db = await freshDb();
  let t = Date.parse("2026-09-28T12:00:00Z");
  const clock = { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };

  const providerPayments = new Map<string, ProviderPaymentRecord>();
  const api = new MockProviderApi({
    clients: CLIENTS,
    payments: (id) => providerPayments.get(id) ?? null,
    now: clock.now,
  });
  const tokens = new EntityTokenManager({
    credentials: new InMemoryCredentialStore(CLIENTS),
    tokenUrl: "https://provider.test/oauth/token",
    fetch: api.fetch,
    now: clock.now,
  });
  const client = new ProviderApiClient({ baseUrl: "https://provider.test/", tokens, fetch: api.fetch });
  const worker = new OutboxWorker({ db, client, now: clock.now, random: () => 0.5, ...workerOpts });

  /** A settled payment for an entity, known to both our DB and the provider. */
  async function settledPayment(entityId: keyof typeof CLIENTS, amountCents = 5_000) {
    const providerPaymentId = `py_${entityId}_${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedPayment(db, { providerPaymentId, amountCents, path: ["settled"] });
    await db.query(`update payments set entity_id = $2 where id = $1`, [id, entityId]);
    providerPayments.set(providerPaymentId, { entityId, amountCents, status: "settled" });
    return { id, providerPaymentId };
  }

  /** Run the worker whenever something is due, jumping the clock forward in between. */
  async function drain(maxRuns = 50) {
    for (let i = 0; i < maxRuns; i++) {
      const next = await nextDue(db, "pending");
      if (next === null) return;
      clock.set(Math.max(clock.now(), next));
      await worker.runOnce();
    }
    throw new Error("outbox did not drain");
  }

  return { db, api, worker, clock, settledPayment, drain, providerPayments };
}

/** Earliest next_attempt_at as epoch ms (timezone-proof), or null. */
async function nextDue(db: TestDb, status?: string): Promise<number | null> {
  const { rows: [r] } = await db.query<{ at: number | null }>(
    `select (extract(epoch from min(next_attempt_at)) * 1000)::float8 as at from outbox
     where $1::text is null or status = $1`,
    [status ?? null],
  );
  return r.at === null ? null : Number(r.at);
}

async function statuses(db: TestDb) {
  const { rows } = await db.query<{ status: string; n: number }>(
    `select status, count(*)::int as n from outbox group by status order by status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

// --- writing side ----------------------------------------------------------------------

Deno.test("refund and its outbox row are written in one transaction", async () => {
  const env = await setup();
  try {
    const p = await env.settledPayment("store-a");

    // Something later in the same transaction fails: neither row survives.
    await assertRejects(() =>
      env.db.transaction(async (tx) => {
        await requestRefund(tx, { paymentId: p.id, amountCents: 1_000, reason: "synthetic" });
        throw new Error("boom after the refund was recorded");
      })
    );
    assertEquals(await count(env.db, `select 1 from refunds`), 0);
    assertEquals(await count(env.db, `select 1 from outbox`), 0);

    // Normal path: both rows, tied together.
    const { refundId } = await createRefund(env.db, { paymentId: p.id, amountCents: 1_000, reason: "synthetic" });
    const { rows: [row] } = await env.db.query<{ entity_id: string; idempotency_key: string; status: string }>(
      `select entity_id, idempotency_key, status from outbox`,
    );
    assertEquals(row, { entity_id: "store-a", idempotency_key: `refund:${refundId}`, status: "pending" });
  } finally {
    await env.db.close();
  }
});

Deno.test("refunds are only accepted for settled payments and up to the payment amount", async () => {
  const env = await setup();
  try {
    const unsettled = await seedPayment(env.db);
    await assertRejects(
      () => createRefund(env.db, { paymentId: unsettled, amountCents: 100, reason: "x" }),
      RefundRequestError,
      "only settled",
    );
    const p = await env.settledPayment("store-a", 2_000);
    await createRefund(env.db, { paymentId: p.id, amountCents: 1_500, reason: "partial" });
    await assertRejects(
      () => createRefund(env.db, { paymentId: p.id, amountCents: 600, reason: "too much" }),
      RefundRequestError,
      "exceeds",
    );
    assertEquals(await count(env.db, `select 1 from outbox`), 1);
  } finally {
    await env.db.close();
  }
});

// --- sending side ----------------------------------------------------------------------

Deno.test("API outage: nothing is lost, and everything is sent exactly once when it recovers", async () => {
  const env = await setup({ baseDelayMs: 2_000, maxDelayMs: 10 * 60_000, maxAttempts: 10 });
  try {
    const refundIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const p = await env.settledPayment(i % 2 ? "store-b" : "store-a");
      refundIds.push(
        (await createRefund(env.db, { paymentId: p.id, amountCents: 500, reason: `synthetic ${i}` })).refundId,
      );
    }

    // The provider is down. A few requests fail differently on the way in.
    env.api.setDown(true);
    const gaps: number[] = [];
    let previousDue = env.clock.now();
    for (let run = 0; run < 5; run++) {
      const summary = await env.worker.runOnce();
      assertEquals(summary.sent, 0);
      assertEquals(summary.review, 0, "temporary failures are never sent to review before max attempts");
      const due = (await nextDue(env.db))!;
      gaps.push(due - previousDue);
      previousDue = due;
      env.clock.set(due);
    }
    assertEquals(await statuses(env.db), { pending: 12 }, "every message still there");
    assertEquals(env.api.refundCount(), 0);
    for (let i = 1; i < gaps.length; i++) assert(gaps[i] > gaps[i - 1], `backoff should grow: ${gaps}`);

    // Recovery is messy: a timeout with nothing processed, a 429 with
    // Retry-After, and a response lost after the provider created the refund.
    env.api.setDown(false);
    env.api.injectFault("timeout");
    env.api.injectFault("rate_limited");
    env.api.injectFault("timeout_after_commit");
    await env.drain();

    assertEquals(await statuses(env.db), { sent: 12 });
    assertEquals(env.api.refundCount(), 12, "exactly one refund per message at the provider");
    assertEquals(
      await count(env.db, `select 1 from refunds where status = 'submitted' and provider_refund_id is not null`),
      12,
    );
    const replays = env.api.log.filter((l) => l.path === "/refunds" && l.status === 200);
    assertEquals(replays.length, 1, "the lost-response message was replayed, not duplicated");
  } finally {
    await env.db.close();
  }
});

Deno.test("validation failure goes to the review list and is never retried", async () => {
  const env = await setup();
  try {
    const ok = await env.settledPayment("store-a");
    const bad = await env.settledPayment("store-b");
    // Our DB thinks it's settled; the provider disagrees (drift). The provider
    // answers 422 - retrying can't change that.
    env.providerPayments.get(bad.providerPaymentId)!.status = "returned";

    await createRefund(env.db, { paymentId: ok.id, amountCents: 500, reason: "synthetic" });
    const { refundId } = await createRefund(env.db, { paymentId: bad.id, amountCents: 500, reason: "synthetic" });

    const first = await env.worker.runOnce();
    assertEquals(first, { claimed: 2, sent: 1, retrying: 0, review: 1 });

    // Hours pass and the worker keeps running: the bad one is never picked up again.
    for (let i = 0; i < 5; i++) {
      env.clock.advance(60 * 60_000);
      assertEquals((await env.worker.runOnce()).claimed, 0);
    }
    assertEquals(env.api.attemptsFor(`refund:${refundId}`), 1);

    const { rows: review } = await env.db.query<{ entity_id: string; attempts: number; last_error: string }>(
      `select entity_id, attempts, last_error from outbox_review`,
    );
    assertEquals(review.length, 1);
    assertEquals(review[0].entity_id, "store-b");
    assertEquals(review[0].attempts, 1);
    assertMatch(review[0].last_error, /HTTP 422: payment is returned, not settled/);
    const { rows: [r] } = await env.db.query<{ status: string }>(`select status from refunds where id = $1`, [
      refundId,
    ]);
    assertEquals(r.status, "needs_review");
  } finally {
    await env.db.close();
  }
});

Deno.test("a message that keeps failing temporarily ends up in review after max attempts", async () => {
  const env = await setup({ maxAttempts: 4 });
  try {
    const p = await env.settledPayment("store-a");
    await createRefund(env.db, { paymentId: p.id, amountCents: 500, reason: "synthetic" });
    env.api.setDown(true);
    await env.drain();

    const { rows: [row] } = await env.db.query<{ status: string; attempts: number; last_error: string }>(
      `select status, attempts, last_error from outbox`,
    );
    assertEquals(row.status, "review");
    assertEquals(row.attempts, 4);
    assertMatch(row.last_error, /gave up after 4 attempts; last error HTTP 503/);
  } finally {
    await env.db.close();
  }
});

Deno.test("a message left 'sending' by a crashed worker is picked up after its lease", async () => {
  const env = await setup({ leaseMs: 60_000 });
  try {
    const p = await env.settledPayment("store-a");
    await createRefund(env.db, { paymentId: p.id, amountCents: 500, reason: "synthetic" });
    // Simulate a worker that claimed the row and died.
    await env.db.query(
      `update outbox set status = 'sending', attempts = 1, locked_until = $1::timestamptz`,
      [new Date(env.clock.now() + 60_000).toISOString()],
    );
    assertEquals((await env.worker.runOnce()).claimed, 0, "still leased");
    env.clock.advance(61_000);
    assertEquals((await env.worker.runOnce()).sent, 1);
    assertEquals(env.api.refundCount(), 1);
  } finally {
    await env.db.close();
  }
});

Deno.test("two workers running at once send each message once", async () => {
  const env = await setup({ batchSize: 5 });
  try {
    for (let i = 0; i < 20; i++) {
      const p = await env.settledPayment(i % 2 ? "store-b" : "store-a");
      await createRefund(env.db, { paymentId: p.id, amountCents: 500, reason: `synthetic ${i}` });
    }
    // runOnce keeps no state between calls, so four concurrent calls behave
    // like four workers. Against real Postgres (TEST_DATABASE_URL) the claims
    // genuinely race and SKIP LOCKED keeps the batches disjoint.
    const results = await Promise.all([
      env.worker.runOnce(),
      env.worker.runOnce(),
      env.worker.runOnce(),
      env.worker.runOnce(),
    ]);
    assertEquals(results.reduce((n, r) => n + r.claimed, 0), 20);
    assertEquals(env.api.refundCount(), 20);
    const keys = env.api.log.filter((l) => l.path === "/refunds").map((l) => l.idempotencyKey);
    assertEquals(new Set(keys).size, keys.length, "no idempotency key was sent twice");
  } finally {
    await env.db.close();
  }
});

Deno.test("every refund from the outbox goes out under its own entity's token", async () => {
  const env = await setup();
  try {
    for (let i = 0; i < 10; i++) {
      const p = await env.settledPayment(i % 2 ? "store-b" : "store-a");
      await createRefund(env.db, { paymentId: p.id, amountCents: 500, reason: `synthetic ${i}` });
    }
    await env.drain();
    const sent = env.api.log.filter((l) => l.path === "/refunds");
    assertEquals(sent.length, 10);
    for (const l of sent) {
      assertEquals(l.tokenEntity, l.bodyEntity);
      assertEquals(l.headerEntity, l.bodyEntity);
    }
  } finally {
    await env.db.close();
  }
});

Deno.test("backoff doubles up to the cap, with jitter in the upper half", () => {
  const base = 2_000;
  const max = 60_000;
  const caps = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
  caps.forEach((cap, i) => {
    assertEquals(backoffDelay(i + 1, base, max, () => 0), cap / 2);
    assertEquals(backoffDelay(i + 1, base, max, () => 1), cap);
    const d = backoffDelay(i + 1, base, max);
    assert(d >= cap / 2 && d <= cap);
  });
});
