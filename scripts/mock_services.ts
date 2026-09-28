// Mock ACH provider + mock POS on one port, for running the Edge Functions
// locally. State is in memory and gone on restart.
//
//   deno task mock
//
// Provider API (called by the functions)
//   POST /provider/debits                     idempotency-key header
//   GET  /provider/payments[/:id]
// POS API (called by the functions)
//   POST /pos/orders                          idempotency-key header
//   GET  /pos/orders?idempotency_key=...
// Control (called by you, to drive scenarios)
//   POST /control/payments/:id/settle         -> sends signed payment.settled
//   POST /control/payments/:id/return         {"code":"R01"} -> payment.returned
//   POST /control/payments/:id/refund         -> refund.completed
//   POST /control/events/:event_id/redeliver  -> sends the same event again
//   POST /control/pos/fault                   {"fault":"timeout_after_commit"}
//   POST /control/provider-api/outage         {"down":true} / {"down":false}
//   POST /control/provider-api/fault          {"fault":"rate_limited"}
//   GET  /control/state
// Authenticated provider API (called by the outbox worker)
//   POST /provider-api/oauth/token            client credentials per entity
//   POST /provider-api/refunds                bearer token + x-entity-id + idempotency-key

import { MockPos, type PosFault } from "../supabase/functions/_shared/mock_pos.ts";
import { MockProvider } from "../supabase/functions/_shared/mock_provider.ts";
import { type ApiFault, MockProviderApi } from "../supabase/functions/_shared/mock_provider_api.ts";
import { PosTimeoutError } from "../supabase/functions/_shared/pos.ts";
import type { ProviderEvent } from "../supabase/functions/_shared/provider.ts";
import { sign, SIGNATURE_HEADER } from "../supabase/functions/_shared/signature.ts";
import { json } from "../supabase/functions/_shared/http.ts";

const port = Number(Deno.env.get("MOCK_PORT") ?? "54400");
const webhookUrl = Deno.env.get("WEBHOOK_URL") ?? "http://127.0.0.1:54321/functions/v1/payment-webhook";
const secret = Deno.env.get("PROVIDER_WEBHOOK_SECRET") ?? "whsec_local_demo_only";
// How long a "timed out" POS call hangs. Must exceed the functions' POS_TIMEOUT_MS.
const hangMs = Number(Deno.env.get("MOCK_POS_HANG_MS") ?? "10000");

const provider = new MockProvider();
const pos = new MockPos();
const sent = new Map<string, ProviderEvent>();

// Same default as supabase/functions/.env.example.
const entityClients = JSON.parse(
  Deno.env.get("PROVIDER_ENTITY_CREDENTIALS") ??
    '{"store-001":{"client_id":"client-store-001","client_secret":"secret-store-001"},' +
      '"store-002":{"client_id":"client-store-002","client_secret":"secret-store-002"}}',
) as Record<string, { client_id: string; client_secret: string }>;

// Payments created through /provider/debits don't carry an entity in this
// mock; they all belong to store-001.
const providerApi = new MockProviderApi({
  clients: Object.fromEntries(
    Object.entries(entityClients).map(([id, c]) => [id, { clientId: c.client_id, clientSecret: c.client_secret }]),
  ),
  payments: (id) => {
    const p = provider.peek(id);
    return p ? { entityId: "store-001", amountCents: p.amount_cents, status: p.status } : null;
  },
});

async function deliver(event: ProviderEvent) {
  sent.set(event.event_id, event);
  const body = JSON.stringify(event);
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", [SIGNATURE_HEADER]: await sign(secret, body) },
    body,
  });
  const text = await res.text();
  console.log(`webhook ${event.type} ${event.event_id} -> ${res.status} ${text}`);
  return { event, delivery: { status: res.status, body: safeJson(text) } };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  let m: RegExpMatchArray | null;

  // --- provider ---
  if (req.method === "POST" && path === "/provider/debits") {
    const key = req.headers.get("idempotency-key");
    if (!key) return json(400, { error: "idempotency-key header required" });
    const b = await req.json();
    return json(
      200,
      await provider.createDebit({ idempotencyKey: key, amountCents: b.amount_cents, accountToken: b.account_token }),
    );
  }
  if (req.method === "GET" && path === "/provider/payments") return json(200, await provider.listPayments());
  if (req.method === "GET" && (m = path.match(/^\/provider\/payments\/([^/]+)$/))) {
    const p = await provider.getPayment(decodeURIComponent(m[1]));
    return p ? json(200, p) : json(404, { error: "not found" });
  }

  // --- authenticated provider API ---
  if (path.startsWith("/provider-api/")) {
    try {
      return await providerApi.fetch(req);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "TimeoutError")) throw err;
      await new Promise((r) => setTimeout(r, hangMs)); // caller's timeout fires first
      return json(504, { error: "gateway timeout" });
    }
  }

  // --- POS ---
  if (req.method === "POST" && path === "/pos/orders") {
    const key = req.headers.get("idempotency-key");
    if (!key) return json(400, { error: "idempotency-key header required" });
    const b = await req.json();
    try {
      return json(
        200,
        await pos.submitOrder({
          idempotencyKey: key,
          orderId: b.order_id,
          amountCents: b.amount_cents,
          items: b.items ?? [],
        }),
      );
    } catch (err) {
      if (!(err instanceof PosTimeoutError)) throw err;
      await new Promise((r) => setTimeout(r, hangMs)); // caller gives up before this
      return json(504, { error: "gateway timeout" });
    }
  }
  if (req.method === "GET" && path === "/pos/orders") {
    const o = await pos.findOrder(url.searchParams.get("idempotency_key") ?? "");
    return o ? json(200, o) : json(404, { error: "not found" });
  }

  // --- control ---
  if (req.method === "POST" && (m = path.match(/^\/control\/payments\/([^/]+)\/(settle|return|refund)$/))) {
    const id = decodeURIComponent(m[1]);
    try {
      if (m[2] === "settle") return json(200, await deliver(provider.settle(id)));
      if (m[2] === "refund") return json(200, await deliver(provider.refund(id)));
      const { code } = await req.json();
      return json(200, await deliver(provider.returnPayment(id, code)));
    } catch (err) {
      return json(409, { error: (err as Error).message });
    }
  }
  if (req.method === "POST" && (m = path.match(/^\/control\/events\/([^/]+)\/redeliver$/))) {
    const event = sent.get(decodeURIComponent(m[1]));
    return event ? json(200, await deliver(event)) : json(404, { error: "unknown event" });
  }
  if (req.method === "POST" && path === "/control/pos/fault") {
    const { fault } = await req.json();
    pos.injectFault(fault as PosFault);
    return json(200, { queued: fault });
  }
  if (req.method === "POST" && path === "/control/provider-api/outage") {
    const { down } = await req.json();
    providerApi.setDown(Boolean(down));
    return json(200, { down: Boolean(down) });
  }
  if (req.method === "POST" && path === "/control/provider-api/fault") {
    const { fault } = await req.json();
    providerApi.injectFault(fault as ApiFault);
    return json(200, { queued: fault });
  }
  if (req.method === "GET" && path === "/control/state") {
    return json(200, {
      provider: {
        charges: provider.chargeCount(),
        debit_calls: provider.debitCallCount(),
        payments: await provider.listPayments(),
      },
      pos: { orders: pos.orderCount(), submit_calls: pos.submitCallCount() },
      events_sent: [...sent.keys()],
    });
  }

  return json(404, { error: `no route for ${req.method} ${path}` });
}

Deno.serve({ port, hostname: "0.0.0.0" }, handle);
console.log(`mock provider + POS on :${port}, webhooks -> ${webhookUrl}`);
