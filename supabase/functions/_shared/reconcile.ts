import type { Db } from "./db.ts";
import { json } from "./http.ts";
import type { PaymentProvider } from "./provider.ts";
import type { PosClient } from "./pos.ts";
import { markConfirmed } from "./submit_order.ts";

export interface ReconcileDeps {
  db: Db;
  provider: PaymentProvider;
  pos: PosClient;
}

export interface ReconcileOptions {
  /** An order stuck in 'submitted' this long is treated like 'unconfirmed' (crashed mid-request). */
  staleSubmittedSeconds?: number;
  /** After this many failed reconcile attempts the order is flagged for staff. */
  maxAttempts?: number;
}

export type OrderResolution = "confirmed_by_lookup" | "confirmed_by_resubmit" | "still_unconfirmed";

export interface OrderReconcileResult {
  orderId: string;
  idempotencyKey: string;
  resolution: OrderResolution;
  error?: string;
}

export interface PaymentMismatch {
  kind: "payment_state_mismatch" | "payment_missing_in_db" | "payment_missing_at_provider";
  providerPaymentId: string;
  dbStatus: string | null;
  providerStatus: string | null;
  /** false if an identical open flag already existed from a previous run. */
  newlyFlagged: boolean;
}

interface PendingOrder {
  id: string;
  idempotency_key: string;
  amount_cents: number;
  items: unknown[];
  reconcile_attempts: number;
}

/**
 * Resolve orders whose POS outcome we don't know.
 *
 * For each one: ask the POS "do you have an order with this key?".
 *   yes -> it went through; record the POS order id.
 *   no  -> resubmit with the SAME key. If the original request is somehow
 *          still in flight, the POS dedupes on the key, so this cannot make
 *          a second order.
 * A lookup or resubmit that fails again leaves the order unconfirmed for the
 * next run; after maxAttempts it is also flagged for staff.
 */
export async function reconcileOrders(
  deps: ReconcileDeps,
  opts: ReconcileOptions = {},
): Promise<OrderReconcileResult[]> {
  const staleSeconds = opts.staleSubmittedSeconds ?? 120;
  const maxAttempts = opts.maxAttempts ?? 5;

  const { rows } = await deps.db.query<PendingOrder>(
    `select id, idempotency_key, amount_cents, items, reconcile_attempts
     from orders
     where pos_status = 'unconfirmed'
        or (pos_status = 'submitted' and updated_at < now() - make_interval(secs => $1))
     order by created_at`,
    [staleSeconds],
  );

  const results: OrderReconcileResult[] = [];
  for (const order of rows) {
    const base = { orderId: order.id, idempotencyKey: order.idempotency_key };
    try {
      const found = await deps.pos.findOrder(order.idempotency_key);
      if (found) {
        await markConfirmed(deps.db, order.id, found.posOrderId);
        results.push({ ...base, resolution: "confirmed_by_lookup" });
        continue;
      }
      const created = await deps.pos.submitOrder({
        idempotencyKey: order.idempotency_key,
        orderId: order.id,
        amountCents: order.amount_cents,
        items: order.items,
      });
      await markConfirmed(deps.db, order.id, created.posOrderId);
      results.push({ ...base, resolution: "confirmed_by_resubmit" });
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      await deps.db.query(
        `update orders
         set pos_status = 'unconfirmed',
             last_pos_error = $2,
             reconcile_attempts = reconcile_attempts + 1,
             needs_staff_review = needs_staff_review or reconcile_attempts + 1 >= $3,
             staff_review_reason = case
               when reconcile_attempts + 1 >= $3 and staff_review_reason is null
               then 'POS could not confirm order after ' || (reconcile_attempts + 1) || ' reconcile attempts'
               else staff_review_reason end
         where id = $1`,
        [order.id, message, maxAttempts],
      );
      results.push({ ...base, resolution: "still_unconfirmed", error: message });
    }
  }
  return results;
}

/**
 * Compare the provider's view of every payment with ours and raise a flag for
 * each disagreement. Deliberately does not "fix" anything: a mismatch means a
 * webhook was lost, reordered or mis-applied, and moving money state on a
 * guess is how you end up refunding twice.
 */
export async function reconcilePayments(deps: ReconcileDeps): Promise<PaymentMismatch[]> {
  const { rows: ours } = await deps.db.query<{ provider_payment_id: string; status: string }>(
    `select provider_payment_id, status from payments`,
  );
  const theirs = new Map((await deps.provider.listPayments()).map((p) => [p.id, p]));

  const mismatches: Omit<PaymentMismatch, "newlyFlagged">[] = [];
  for (const row of ours) {
    const remote = theirs.get(row.provider_payment_id);
    theirs.delete(row.provider_payment_id);
    if (!remote) {
      mismatches.push({
        kind: "payment_missing_at_provider",
        providerPaymentId: row.provider_payment_id,
        dbStatus: row.status,
        providerStatus: null,
      });
    } else if (remote.status !== row.status) {
      mismatches.push({
        kind: "payment_state_mismatch",
        providerPaymentId: row.provider_payment_id,
        dbStatus: row.status,
        providerStatus: remote.status,
      });
    }
  }
  // Charged at the provider, never recorded here (e.g. crash between debit and insert).
  for (const remote of theirs.values()) {
    mismatches.push({
      kind: "payment_missing_in_db",
      providerPaymentId: remote.id,
      dbStatus: null,
      providerStatus: remote.status,
    });
  }

  const flagged: PaymentMismatch[] = [];
  for (const m of mismatches) {
    const res = await deps.db.query(
      `insert into reconciliation_flags (kind, subject_id, details)
       values ($1, $2, $3)
       on conflict (kind, subject_id) where resolved_at is null do nothing
       returning id`,
      [m.kind, m.providerPaymentId, JSON.stringify({ db_status: m.dbStatus, provider_status: m.providerStatus })],
    );
    flagged.push({ ...m, newlyFlagged: res.rows.length > 0 });
  }
  return flagged;
}

export async function reconcile(deps: ReconcileDeps, opts: ReconcileOptions = {}) {
  const orders = await reconcileOrders(deps, opts);
  const payments = await reconcilePayments(deps);
  return { orders, payments };
}

export function createReconcileHandler(deps: ReconcileDeps, opts: ReconcileOptions = {}) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    return json(200, await reconcile(deps, opts));
  };
}
