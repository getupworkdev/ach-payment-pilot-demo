import { assertEquals, assertMatch } from "@std/assert";
import { sign, SIGNATURE_HEADER } from "../supabase/functions/_shared/signature.ts";
import { submitOrder } from "../supabase/functions/_shared/submit_order.ts";
import type { ProviderEvent } from "../supabase/functions/_shared/provider.ts";
import { createWebhookHandler, processProviderEvent } from "../supabase/functions/_shared/webhook.ts";
import { count, setup } from "./helpers.ts";

const SECRET = "whsec_test";

async function signedRequest(event: unknown, secret = SECRET): Promise<Request> {
  const body = JSON.stringify(event);
  return new Request("http://localhost/payment-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", [SIGNATURE_HEADER]: await sign(secret, body) },
    body,
  });
}

/** A confirmed order with an authorized payment, created the normal way. */
async function placeOrder(env: Awaited<ReturnType<typeof setup>>, key = "order-key-0001") {
  const { order } = await submitOrder(env, {
    idempotencyKey: key,
    amountCents: 2400,
    accountToken: "tok_ok",
    items: [],
  });
  const { rows: [p] } = await env.db.query<{ provider_payment_id: string }>(
    `select provider_payment_id from payments where id = $1`,
    [order.payment_id],
  );
  return { orderId: order.id, paymentId: order.payment_id!, providerPaymentId: p.provider_payment_id };
}

async function paymentRow(env: Awaited<ReturnType<typeof setup>>, id: string) {
  const { rows: [r] } = await env.db.query<{ status: string; return_code: string | null }>(
    `select status, return_code from payments where id = $1`,
    [id],
  );
  return r;
}

Deno.test("duplicate webhook is acknowledged and processed exactly once", async () => {
  const env = await setup();
  try {
    const handle = createWebhookHandler({ db: env.db, webhookSecret: SECRET });
    const { paymentId, providerPaymentId } = await placeOrder(env);
    const settled = env.provider.settle(providerPaymentId);

    const first = await handle(await signedRequest(settled));
    const second = await handle(await signedRequest(settled));
    const third = await handle(await signedRequest(settled));

    assertEquals([first.status, second.status, third.status], [200, 200, 200]);
    assertEquals((await first.json()).outcome, "processed");
    assertEquals((await second.json()).outcome, "duplicate");
    assertEquals((await third.json()).outcome, "duplicate");

    assertEquals((await paymentRow(env, paymentId)).status, "settled");
    assertEquals(await count(env.db, `select 1 from webhook_events where event_id = $1`, [settled.event_id]), 1);
    // One authorized row + one settled row. The replays touched nothing.
    assertEquals(await count(env.db, `select 1 from payment_status_history where payment_id = $1`, [paymentId]), 2);
  } finally {
    await env.db.close();
  }
});

Deno.test("concurrent duplicate deliveries still apply once", async () => {
  const env = await setup();
  try {
    const { paymentId, providerPaymentId } = await placeOrder(env);
    const settled = env.provider.settle(providerPaymentId);

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => processProviderEvent(env.db, settled)),
    );

    assertEquals(outcomes.filter((o) => o.kind === "processed").length, 1);
    assertEquals(outcomes.filter((o) => o.kind === "duplicate").length, 4);
    assertEquals(
      await count(env.db, `select 1 from payment_status_history where payment_id = $1 and to_status = 'settled'`, [
        paymentId,
      ]),
      1,
    );
  } finally {
    await env.db.close();
  }
});

Deno.test("R01 return after settlement moves payment to returned and flags the order for staff", async () => {
  const env = await setup();
  try {
    const { orderId, paymentId, providerPaymentId } = await placeOrder(env);

    assertEquals((await processProviderEvent(env.db, env.provider.settle(providerPaymentId))).kind, "processed");
    const outcome = await processProviderEvent(env.db, env.provider.returnPayment(providerPaymentId, "R01"));

    assertEquals(outcome, { kind: "processed", paymentId, status: "returned" });
    assertEquals(await paymentRow(env, paymentId), { status: "returned", return_code: "R01" });

    const { rows: [order] } = await env.db.query<{ needs_staff_review: boolean; staff_review_reason: string }>(
      `select needs_staff_review, staff_review_reason from orders where id = $1`,
      [orderId],
    );
    assertEquals(order.needs_staff_review, true);
    assertMatch(order.staff_review_reason, /R01: Insufficient funds/);
  } finally {
    await env.db.close();
  }
});

Deno.test("R10 return is called out as unauthorized in the staff flag", async () => {
  const env = await setup();
  try {
    const { orderId, providerPaymentId } = await placeOrder(env);
    await processProviderEvent(env.db, env.provider.settle(providerPaymentId));
    await processProviderEvent(env.db, env.provider.returnPayment(providerPaymentId, "R10"));

    const { rows: [order] } = await env.db.query<{ staff_review_reason: string }>(
      `select staff_review_reason from orders where id = $1`,
      [orderId],
    );
    assertMatch(order.staff_review_reason, /R10: .*unauthorized return, do not re-present/);
  } finally {
    await env.db.close();
  }
});

Deno.test("refund.completed moves a settled payment to refunded", async () => {
  const env = await setup();
  try {
    const { paymentId, providerPaymentId } = await placeOrder(env);
    await processProviderEvent(env.db, env.provider.settle(providerPaymentId));
    const outcome = await processProviderEvent(env.db, env.provider.refund(providerPaymentId));

    assertEquals(outcome.kind, "processed");
    assertEquals((await paymentRow(env, paymentId)).status, "refunded");
  } finally {
    await env.db.close();
  }
});

Deno.test("out-of-order return is refused, not recorded, and applies cleanly on redelivery", async () => {
  const env = await setup();
  try {
    const handle = createWebhookHandler({ db: env.db, webhookSecret: SECRET });
    const { paymentId, providerPaymentId } = await placeOrder(env);
    const settled = env.provider.settle(providerPaymentId);
    const returned = env.provider.returnPayment(providerPaymentId, "R01");

    // Return arrives before settlement.
    const early = await handle(await signedRequest(returned));
    assertEquals(early.status, 409);
    assertEquals((await early.json()).outcome, "illegal_transition");
    assertEquals((await paymentRow(env, paymentId)).status, "authorized");
    assertEquals(await count(env.db, `select 1 from webhook_events where event_id = $1`, [returned.event_id]), 0);

    // Settlement lands, then the provider retries the return.
    assertEquals((await handle(await signedRequest(settled))).status, 200);
    const retried = await handle(await signedRequest(returned));
    assertEquals(retried.status, 200);
    assertEquals((await retried.json()).outcome, "processed");
    assertEquals((await paymentRow(env, paymentId)).status, "returned");
  } finally {
    await env.db.close();
  }
});

Deno.test("event for a payment we don't know is not recorded, so a retry can succeed", async () => {
  const env = await setup();
  try {
    const event: ProviderEvent = {
      event_id: "evt_orphan",
      type: "payment.settled",
      created_at: new Date().toISOString(),
      data: { payment_id: "py_does_not_exist" },
    };
    assertEquals((await processProviderEvent(env.db, event)).kind, "unknown_payment");
    assertEquals(await count(env.db, `select 1 from webhook_events`), 0);
  } finally {
    await env.db.close();
  }
});

Deno.test("unknown event types are acknowledged and recorded as ignored", async () => {
  const env = await setup();
  try {
    const handle = createWebhookHandler({ db: env.db, webhookSecret: SECRET });
    const res = await handle(
      await signedRequest({
        event_id: "evt_misc",
        type: "customer.updated",
        created_at: new Date().toISOString(),
        data: { payment_id: "py_whatever" },
      }),
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).outcome, "ignored");
  } finally {
    await env.db.close();
  }
});

Deno.test("bad signature and malformed events are rejected before touching the database", async () => {
  const env = await setup();
  try {
    const handle = createWebhookHandler({ db: env.db, webhookSecret: SECRET });
    const { providerPaymentId } = await placeOrder(env);
    const settled = env.provider.settle(providerPaymentId);

    assertEquals((await handle(await signedRequest(settled, "wrong-secret"))).status, 401);
    const noCode = { ...settled, event_id: "evt_bad", type: "payment.returned" };
    assertEquals((await handle(await signedRequest(noCode))).status, 400);
    assertEquals(await count(env.db, `select 1 from webhook_events`), 0);
  } finally {
    await env.db.close();
  }
});
