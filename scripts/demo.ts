// Walk the main scenario over HTTP against running functions + mock services.
//
//   deno task demo
//
// FUNCTIONS_URL defaults to the local Supabase gateway. If the functions sit
// behind JWT verification (supabase functions serve), set SUPABASE_ANON_KEY.

const functions = Deno.env.get("FUNCTIONS_URL") ?? "http://127.0.0.1:54321/functions/v1";
const mock = Deno.env.get("MOCK_URL") ?? "http://127.0.0.1:54400";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

async function call(method: string, url: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (anonKey && url.startsWith(functions)) headers.authorization = `Bearer ${anonKey}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  return { status: res.status, data };
}

function step(title: string, detail: unknown) {
  console.log(`\n== ${title}`);
  console.log(JSON.stringify(detail, null, 2));
}

const key = `demo-${crypto.randomUUID().slice(0, 8)}`;

await call("POST", `${mock}/control/pos/fault`, { fault: "timeout_after_commit" });
const submitted = await call("POST", `${functions}/submit-order`, {
  idempotency_key: key,
  amount_cents: 2400,
  account_token: "tok_demo",
  items: [{ sku: "burrito", qty: 1 }],
});
step("1. submit-order while the POS times out (it did create the order)", {
  http: submitted.status,
  pos_status: submitted.data.order?.pos_status,
  last_pos_error: submitted.data.order?.last_pos_error,
});

const replay = await call("POST", `${functions}/submit-order`, {
  idempotency_key: key,
  amount_cents: 2400,
  account_token: "tok_demo",
});
step("2. client retries with the same key: no new charge, no POS call", {
  http: replay.status,
  replayed: replay.data.replayed,
});

const rec = await call("POST", `${functions}/reconcile`);
step("3. reconcile looks the order up by key", rec.data.orders);

const paymentId = (await call("GET", `${mock}/control/state`)).data.provider.payments.at(-1).id;
const settled = await call("POST", `${mock}/control/payments/${paymentId}/settle`);
step("4. provider settles", settled.data.delivery);

const again = await call("POST", `${mock}/control/events/${settled.data.event.event_id}/redeliver`);
step("5. provider redelivers the same event", again.data.delivery);

const returned = await call("POST", `${mock}/control/payments/${paymentId}/return`, { code: "R01" });
step("6. R01 return after settlement", returned.data.delivery);

const state = (await call("GET", `${mock}/control/state`)).data;
step("7. what the outside world saw", {
  pos_orders_total: state.pos.orders,
  provider_charges_total: state.provider.charges,
  this_payment_at_provider: state.provider.payments.at(-1),
});

console.log(`\nCheck the database:\n  select * from orders where idempotency_key = '${key}';`);
