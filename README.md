# ach-payment-pilot-demo

[![test](https://github.com/getupworkdev/ach-payment-pilot-demo/actions/workflows/test.yml/badge.svg)](https://github.com/getupworkdev/ach-payment-pilot-demo/actions/workflows/test.yml)

A small, self-contained demo of the parts of an ACH payments pilot that are easy to get wrong:

- a payment **state machine enforced by Postgres**, not by application code
- **idempotent webhook** handling (a redelivered event is acknowledged, never re-applied)
- **POS submission that never blind-retries** on timeout, plus a **reconciler** that resolves the ambiguity safely
- **provider ↔ database drift detection**

Stack: Supabase (Postgres) + Deno Edge Functions + TypeScript. The ACH provider and the POS are mocks.

---

## State diagrams

### Payment (`payments.status`)

```mermaid
stateDiagram-v2
    [*] --> authorized: submit-order debits via provider
    authorized --> settled: payment.settled
    settled --> returned: payment.returned (R-code)
    settled --> refunded: refund.completed
    returned --> [*]
    refunded --> [*]
```

```
authorized ──► settled ──► returned   (R01, R10, ... stored in return_code)
                       └─► refunded
```

The allowed edges live in the `payment_status_transitions` table. The `trg_payments_enforce_transition` trigger refuses anything else with SQLSTATE `PX409`. That includes `returned → settled`, `authorized → returned`, inserting a payment that is already `settled`, and deleting a payment. It doesn't matter which code path tries it: an Edge Function, a SQL console, a future admin tool. The refusal comes from the database. Every accepted change is appended to `payment_status_history`.

### Order (`orders.pos_status`)

```mermaid
stateDiagram-v2
    [*] --> submitted: row written before calling POS
    submitted --> confirmed: POS returned an order id
    submitted --> unconfirmed: timeout / error, outcome unknown
    unconfirmed --> confirmed: reconcile found it by key, or resubmitted with the same key
    unconfirmed --> unconfirmed: reconcile failed again (after N tries, flagged for staff)
```

A `submitted` row older than `RECONCILE_STALE_SUBMITTED_SECONDS` counts as `unconfirmed`. That covers a function that crashed mid-request.

---

## How the pieces fit

| Piece | File | What it does |
| --- | --- | --- |
| Migration | `supabase/migrations/20260928000000_payments_pilot.sql` | `payments` + transition trigger, `webhook_events` (PK on `event_id`), `orders`, `reconciliation_flags` |
| `payment-webhook` | `supabase/functions/_shared/webhook.ts` | Verifies HMAC signature, inserts `event_id` and applies the transition **in one transaction**. Duplicate → `200 duplicate`, nothing touched. Handles `payment.settled`, `payment.returned` (R-code, flags the order for staff), `refund.completed`. |
| `submit-order` | `supabase/functions/_shared/submit_order.ts` | Debits through the provider (idempotency key derived from the order key), records payment + order, calls the POS **once**. Timeout → `unconfirmed`, `202`. |
| `reconcile` | `supabase/functions/_shared/reconcile.ts` | Looks up each unconfirmed order at the POS by idempotency key: found → `confirmed`; not found → resubmit with the **same** key. Then diffs every payment against the provider and writes `reconciliation_flags`. |
| Mock provider | `supabase/functions/_shared/mock_provider.ts` | In-memory ACH processor: idempotent debits, settle / return / refund, produces webhook events |
| Mock POS | `supabase/functions/_shared/mock_pos.ts` | In-memory POS, idempotent on key, with injectable `timeout_before_commit`, `timeout_after_commit`, `lookup_timeout` |
| Mock services over HTTP | `scripts/mock_services.ts` | Serves both mocks on `:54400` for running the functions for real, plus control endpoints to drive scenarios |

The domain code depends on small interfaces (`Db`, `PaymentProvider`, `PosClient`). The function entrypoints (`supabase/functions/*/index.ts`) are three-line files that wire in the real Postgres pool and the HTTP clients.

### Why these choices

- **Idempotency lives in a primary key, not a lookup.** `insert ... on conflict (event_id) do nothing returning` inside the same transaction as the state change. Two concurrent deliveries of the same event serialise on the key, and one wins. If applying the event fails, the insert rolls back with it, so the provider's retry gets a clean second attempt.
- **Out-of-order events are refused, not swallowed.** If `payment.returned` arrives before `payment.settled`, the trigger refuses it and we answer `409`. The event is not recorded, so the provider's redelivery succeeds once settlement has landed. A payment we don't know yet is handled the same way.
- **A POS timeout is "unknown", not "failed".** The POS may have created the order and lost the response. Retrying in the request path is how you get two burritos and one very confused kitchen. Only a lookup by idempotency key can resolve it, and that's the reconciler's job.
- **Resubmitting with the same key is safe even if the original is still in flight.** The POS dedupes on the key, so "not found → resubmit" cannot create a second order.
- **Reconciliation flags payment drift; it does not fix it.** A mismatch means a webhook was lost or mis-applied. Guessing and moving money state automatically is how refunds get issued twice. Flags are de-duplicated: at most one open flag per `(kind, subject)`.
- **Returns go to a human.** An R01 after settlement means the customer has the goods and the money bounced. The order gets `needs_staff_review = true` with a reason. Unauthorized-class returns (R05, R07, R10, R29, …) are called out as "do not re-present".

---

## Running it

Prerequisites: [Deno 2](https://deno.com). The Supabase CLI and Docker are needed only for the full local stack.

### 1. Tests, no Docker

```sh
deno task test
```

Each test gets a fresh in-process Postgres ([PGlite](https://pglite.dev)) with the real migration applied. That means the trigger, constraints and unique keys under test are exactly the ones that ship.

### 2. The same tests against a real Postgres

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres deno task test
```

Each test creates and drops its own database on that server. It goes through the same `deno-postgres` pool the Edge Functions use, with real concurrent connections. PGlite is single-connection, so the concurrency tests only genuinely race in this mode.

### 3. Database tests (pgTAP)

```sh
supabase start
supabase test db
```

`supabase/tests/database/payments_state_machine.test.sql` checks the trigger directly: legal path, every illegal edge, R-code constraints, the no-delete rule and `event_id` uniqueness.

### 4. The full stack locally

```sh
supabase start                                  # Postgres + gateway, applies the migration
cp supabase/functions/.env.example supabase/functions/.env
deno task mock                                  # mock provider + POS on :54400
supabase functions serve --env-file supabase/functions/.env
SUPABASE_ANON_KEY=<anon key from `supabase status`> deno task demo
```

No Docker? Point at any Postgres that has the migration applied, and serve the three functions from one Deno process instead:

```sh
PROVIDER_WEBHOOK_SECRET=whsec_local_demo_only deno task mock
SUPABASE_DB_URL=postgres://... PROVIDER_WEBHOOK_SECRET=whsec_local_demo_only \
  MOCK_SERVICES_URL=http://127.0.0.1:54400 POS_TIMEOUT_MS=1000 deno task serve
MOCK_POS_HANG_MS=3000 deno task demo
```

`deno task demo` walks through the whole scenario:

1. The POS times out after committing, so the order is `unconfirmed`.
2. The client retries with the same key. It is not charged again and the POS is not called.
3. `reconcile` finds the order by key and marks it `confirmed`.
4. The provider settles the payment.
5. The same event is redelivered and comes back as `duplicate`.
6. An R01 return moves the payment to `returned` and flags the order for staff.
7. The run ends with exactly 1 POS order and 1 charge.

You can also drive the mocks by hand:

```sh
curl -XPOST localhost:54400/control/pos/fault -d '{"fault":"timeout_before_commit"}'
curl -XPOST localhost:54400/control/payments/<py_id>/settle
curl -XPOST localhost:54400/control/payments/<py_id>/return -d '{"code":"R10"}'
curl -XPOST localhost:54400/control/events/<evt_id>/redeliver
curl localhost:54400/control/state
```

### Scheduling reconcile

On a hosted project you would run `reconcile` every few minutes with `pg_cron` + `pg_net`:

```sql
select cron.schedule('reconcile-orders', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://<project>.supabase.co/functions/v1/reconcile',
    headers := jsonb_build_object('Authorization', 'Bearer ' || '<service role key from Vault>')
  );
$$);
```

---

## What the tests cover

| Requirement | Test |
| --- | --- |
| Duplicate webhook processed once | `payment_webhook_test.ts`: *duplicate webhook is acknowledged and processed exactly once*, *concurrent duplicate deliveries still apply once* |
| R01 after settlement → `returned`, order flagged for staff | `payment_webhook_test.ts`: *R01 return after settlement …* |
| POS timeout + reconcile → exactly one order, exactly one charge | `submit_and_reconcile_test.ts`: *POS timeout (order was created) …*, *POS timeout (order never arrived) …*, *reconcile run twice, or racing a late POS commit …*, *client retrying submit-order with the same key …* |
| Illegal transition refused by the database | `state_machine_test.ts` and `supabase/tests/database/payments_state_machine.test.sql` |
| Provider/DB drift flagged | `submit_and_reconcile_test.ts`: *payment diff flags a lost webhook …*, *… a charge the database never recorded* |

---

## What this proves / what it does not

> **This is a simulation. The ACH provider and the POS are in-memory mocks written for this repo. Nothing here moves money, talks to a bank, or is production ACH.**

### What it proves

- The database refuses illegal payment transitions on its own. The rule holds even if application code is buggy or bypassed.
- Webhook handling is idempotent by construction (primary key plus a shared transaction). This holds under concurrent duplicate delivery against a real Postgres.
- A POS timeout never causes a blind retry in the request path. Reconciliation by idempotency key ends with exactly one POS order and one provider charge across the failure modes modelled here: timeout before commit, timeout after commit, lookup timeout, repeated reconcile runs, and client double-submits.
- An R01 return after settlement is recorded with its code and surfaces the order to staff.
- A lost webhook or an unrecorded charge is detected and flagged, not silently absorbed.

### What it does not prove

- **That any real provider behaves like the mock.** Real ACH processors differ in event names, in whether "settled" means funds available, in retry schedules, signature schemes, and in whether a return can arrive before a settlement event. The adapter for a real provider has to be written and tested against its sandbox.
- **ACH timing and rules.** No settlement windows, same-day ACH cutoffs, the 2-banking-day return window versus the 60-day window for unauthorized returns, NOC (change notification) handling, re-presentment limits, or NACHA return-rate thresholds.
- **Money correctness beyond state.** No ledger, no partial refunds, no fees, no currency handling. A refund and a later return on the same payment are modelled as mutually exclusive; in reality they can both happen and need a ledger to reconcile.
- **That the real POS is idempotent.** The whole no-double-order argument rests on the POS honouring an idempotency key and supporting lookup by it. That must be confirmed with the actual POS vendor. If it can't be, this design doesn't hold.
- **Production concerns.** Auth for `submit-order` is just Supabase's JWT gate. There is no account tokenisation or bank-account verification, no NACHA-compliant authorisation capture, no PII handling, no rate limiting, alerting or metrics, and no locking between concurrent reconciler runs (safe here only because every POS call is idempotent).
- **Grace periods.** Reconciliation flags any drift immediately, including a webhook that is merely in flight. A real run would ignore payments updated in the last few minutes.
- **That the Supabase-hosted runtime was exercised.** The tests run the handlers directly against PGlite and Postgres 17. The Edge Function entrypoints are thin wrappers around the same handlers.
