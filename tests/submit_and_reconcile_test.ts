import { assertEquals, assertMatch } from "@std/assert";
import { reconcile, reconcileOrders, reconcilePayments } from "../supabase/functions/_shared/reconcile.ts";
import { createSubmitOrderHandler, submitOrder } from "../supabase/functions/_shared/submit_order.ts";
import { processProviderEvent } from "../supabase/functions/_shared/webhook.ts";
import { count, setup } from "./helpers.ts";

const order = (key: string) => ({
  idempotencyKey: key,
  amountCents: 1875,
  accountToken: "tok_ok",
  items: [{ sku: "burrito", qty: 1 }],
});

/** The invariant everything below is protecting. */
async function assertExactlyOneOfEverything(env: Awaited<ReturnType<typeof setup>>) {
  assertEquals(env.pos.orderCount(), 1, "orders in the POS");
  assertEquals(env.provider.chargeCount(), 1, "charges at the provider");
  assertEquals(await count(env.db, `select 1 from orders`), 1, "order rows");
  assertEquals(await count(env.db, `select 1 from payments`), 1, "payment rows");
}

Deno.test("happy path: charged once, confirmed by the POS", async () => {
  const env = await setup();
  try {
    const { order: o } = await submitOrder(env, order("key-happy-0001"));
    assertEquals(o.pos_status, "confirmed");
    assertMatch(o.pos_order_id!, /^pos_/);
    await assertExactlyOneOfEverything(env);
  } finally {
    await env.db.close();
  }
});

Deno.test("POS timeout (order was created) -> unconfirmed, no blind retry; reconcile confirms by lookup", async () => {
  const env = await setup();
  try {
    env.pos.injectFault("timeout_after_commit");

    const { order: o } = await submitOrder(env, order("key-ghost-0001"));
    assertEquals(o.pos_status, "unconfirmed");
    assertMatch(o.last_pos_error!, /PosTimeoutError/);
    assertEquals(env.pos.submitCallCount(), 1, "submit-order must call the POS once and stop");

    const results = await reconcileOrders(env);
    assertEquals(results.map((r) => r.resolution), ["confirmed_by_lookup"]);
    assertEquals(env.pos.submitCallCount(), 1, "lookup found it, so no resubmit");

    const { rows: [after] } = await env.db.query<{ pos_status: string }>(`select pos_status from orders`);
    assertEquals(after.pos_status, "confirmed");
    await assertExactlyOneOfEverything(env);
  } finally {
    await env.db.close();
  }
});

Deno.test("POS timeout (order never arrived) -> reconcile resubmits with the same key", async () => {
  const env = await setup();
  try {
    env.pos.injectFault("timeout_before_commit");

    const { order: o } = await submitOrder(env, order("key-lost-00001"));
    assertEquals(o.pos_status, "unconfirmed");
    assertEquals(env.pos.orderCount(), 0);

    const results = await reconcileOrders(env);
    assertEquals(results.map((r) => r.resolution), ["confirmed_by_resubmit"]);
    assertEquals(results[0].idempotencyKey, "key-lost-00001");
    await assertExactlyOneOfEverything(env);
  } finally {
    await env.db.close();
  }
});

Deno.test("reconcile run twice, or racing a late POS commit, still yields one order", async () => {
  const env = await setup();
  try {
    env.pos.injectFault("timeout_before_commit");
    await submitOrder(env, order("key-race-00001"));

    // First reconcile: the lookup itself times out -> order stays unconfirmed.
    env.pos.injectFault("lookup_timeout");
    assertEquals((await reconcileOrders(env)).map((r) => r.resolution), ["still_unconfirmed"]);

    // Second reconcile: resubmit times out but the POS commits it.
    env.pos.injectFault("timeout_after_commit");
    assertEquals((await reconcileOrders(env)).map((r) => r.resolution), ["still_unconfirmed"]);

    // Third: lookup finds the order the previous resubmit created.
    assertEquals((await reconcileOrders(env)).map((r) => r.resolution), ["confirmed_by_lookup"]);
    // Fourth: nothing left to do.
    assertEquals(await reconcileOrders(env), []);

    await assertExactlyOneOfEverything(env);
  } finally {
    await env.db.close();
  }
});

Deno.test("client retrying submit-order with the same key is not charged twice", async () => {
  const env = await setup();
  try {
    const handle = createSubmitOrderHandler(env);
    const req = () =>
      new Request("http://localhost/submit-order", {
        method: "POST",
        body: JSON.stringify({
          idempotency_key: "key-dblclick-01",
          amount_cents: 1875,
          account_token: "tok_ok",
          items: [],
        }),
      });

    env.pos.injectFault("timeout_after_commit");
    const first = await handle(req());
    const second = await handle(req());
    assertEquals(first.status, 202);
    assertEquals(second.status, 202);
    assertEquals((await second.json()).replayed, true);
    assertEquals(env.pos.submitCallCount(), 1);
    assertEquals(env.provider.debitCallCount(), 1);

    await reconcile(env);
    const third = await handle(req());
    assertEquals(third.status, 200);
    assertEquals((await third.json()).order.pos_status, "confirmed");
    await assertExactlyOneOfEverything(env);
  } finally {
    await env.db.close();
  }
});

Deno.test("concurrent submits with the same key produce one order and one charge", async () => {
  const env = await setup();
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => submitOrder(env, order("key-concurrent1"))));
    assertEquals(new Set(results.map((r) => r.order.id)).size, 1);
    await assertExactlyOneOfEverything(env);
  } finally {
    await env.db.close();
  }
});

Deno.test("order the POS never confirms gets flagged for staff after max attempts", async () => {
  const env = await setup();
  try {
    env.pos.injectFault("timeout_before_commit");
    await submitOrder(env, order("key-stuck-00001"));
    for (let i = 0; i < 3; i++) {
      env.pos.injectFault("lookup_timeout");
      await reconcileOrders(env, { maxAttempts: 3 });
    }
    const { rows: [o] } = await env.db.query<
      { pos_status: string; reconcile_attempts: number; needs_staff_review: boolean; staff_review_reason: string }
    >(`select pos_status, reconcile_attempts, needs_staff_review, staff_review_reason from orders`);
    assertEquals(o.pos_status, "unconfirmed");
    assertEquals(o.reconcile_attempts, 3);
    assertEquals(o.needs_staff_review, true);
    assertMatch(o.staff_review_reason, /after 3 reconcile attempts/);
  } finally {
    await env.db.close();
  }
});

Deno.test("stale 'submitted' orders (crashed mid-request) are picked up by reconcile", async () => {
  const env = await setup();
  try {
    const { order: o } = await submitOrder(env, order("key-crashed-001"));
    // Pretend we died after inserting but before hearing back from the POS,
    // ten minutes ago. (The touch trigger would otherwise reset updated_at.)
    await env.db.query(`alter table orders disable trigger trg_orders_touch`);
    await env.db.query(
      `update orders set pos_status = 'submitted', pos_order_id = null, updated_at = now() - interval '10 minutes'
       where id = $1`,
      [o.id],
    );
    await env.db.query(`alter table orders enable trigger trg_orders_touch`);

    assertEquals((await reconcileOrders(env, { staleSubmittedSeconds: 60 })).map((r) => r.resolution), [
      "confirmed_by_lookup",
    ]);
    await assertExactlyOneOfEverything(env);
  } finally {
    await env.db.close();
  }
});

Deno.test("payment diff flags a lost webhook, once, and leaves the payment alone", async () => {
  const env = await setup();
  try {
    const { order: o } = await submitOrder(env, order("key-diff-00001"));
    const { rows: [p] } = await env.db.query<{ provider_payment_id: string }>(
      `select provider_payment_id from payments where id = $1`,
      [o.payment_id],
    );

    await processProviderEvent(env.db, env.provider.settle(p.provider_payment_id));
    env.provider.returnPayment(p.provider_payment_id, "R01"); // webhook never delivered

    const first = await reconcilePayments(env);
    assertEquals(first, [{
      kind: "payment_state_mismatch",
      providerPaymentId: p.provider_payment_id,
      dbStatus: "settled",
      providerStatus: "returned",
      newlyFlagged: true,
    }]);

    const second = await reconcilePayments(env);
    assertEquals(second[0].newlyFlagged, false);
    assertEquals(await count(env.db, `select 1 from reconciliation_flags where resolved_at is null`), 1);

    const { rows: [after] } = await env.db.query<{ status: string }>(`select status from payments`);
    assertEquals(after.status, "settled", "reconciliation flags, it does not move money state");
  } finally {
    await env.db.close();
  }
});

Deno.test("payment diff flags a charge the database never recorded", async () => {
  const env = await setup();
  try {
    // Provider charged, then we crashed before inserting anything.
    const orphan = await env.provider.createDebit({
      idempotencyKey: "debit:key-orphan",
      amountCents: 900,
      accountToken: "tok_ok",
    });
    const mismatches = await reconcilePayments(env);
    assertEquals(mismatches.map((m) => [m.kind, m.providerPaymentId]), [["payment_missing_in_db", orphan.id]]);
  } finally {
    await env.db.close();
  }
});
