import type { Db } from "./db.ts";
import type { PaymentProvider } from "./provider.ts";
import type { PosClient } from "./pos.ts";
import { json } from "./http.ts";

export interface SubmitOrderInput {
  idempotencyKey: string;
  amountCents: number;
  accountToken: string;
  items: unknown[];
}

export interface OrderRow {
  id: string;
  idempotency_key: string;
  payment_id: string | null;
  amount_cents: number;
  pos_status: "submitted" | "confirmed" | "unconfirmed";
  pos_order_id: string | null;
  last_pos_error: string | null;
  needs_staff_review: boolean;
}

export interface SubmitOrderResult {
  order: OrderRow;
  /** true when this call found an existing order for the key and did nothing. */
  replayed: boolean;
}

export interface SubmitOrderDeps {
  db: Db;
  provider: PaymentProvider;
  pos: PosClient;
}

const ORDER_COLUMNS =
  "id, idempotency_key, payment_id, amount_cents, pos_status, pos_order_id, last_pos_error, needs_staff_review";

/**
 * Charge once, record once, send to the POS once.
 *
 *  1. Same key seen before -> return that order untouched. No new charge, no
 *     new POS call; if it is unconfirmed, reconciliation owns it.
 *  2. Debit through the provider with a key derived from the order key, so a
 *     crash-and-retry lands on the same provider payment.
 *  3. Insert payment + order in one transaction (pos_status = submitted).
 *  4. Exactly one POS call. Success -> confirmed. Timeout or any other failure
 *     -> unconfirmed. We do not loop: a timed-out POS call may already have
 *     created the order, and only a lookup by key can tell us.
 */
export async function submitOrder(deps: SubmitOrderDeps, input: SubmitOrderInput): Promise<SubmitOrderResult> {
  const existing = await findByKey(deps.db, input.idempotencyKey);
  if (existing) return { order: existing, replayed: true };

  const charge = await deps.provider.createDebit({
    idempotencyKey: `debit:${input.idempotencyKey}`,
    amountCents: input.amountCents,
    accountToken: input.accountToken,
  });

  const created = await deps.db.transaction(async (tx) => {
    await tx.query(
      `insert into payments (provider_payment_id, amount_cents)
       values ($1, $2)
       on conflict (provider_payment_id) do nothing`,
      [charge.id, charge.amount_cents],
    );
    const { rows: [payment] } = await tx.query<{ id: string }>(
      `select id from payments where provider_payment_id = $1`,
      [charge.id],
    );
    const res = await tx.query<OrderRow>(
      `insert into orders (idempotency_key, payment_id, amount_cents, items)
       values ($1, $2, $3, $4)
       on conflict (idempotency_key) do nothing
       returning ${ORDER_COLUMNS}`,
      [input.idempotencyKey, payment.id, input.amountCents, JSON.stringify(input.items)],
    );
    return res.rows[0] ?? null;
  });

  // Lost a race with a concurrent request carrying the same key; it owns the POS call.
  if (!created) return { order: (await findByKey(deps.db, input.idempotencyKey))!, replayed: true };

  let order: OrderRow;
  try {
    const pos = await deps.pos.submitOrder({
      idempotencyKey: input.idempotencyKey,
      orderId: created.id,
      amountCents: input.amountCents,
      items: input.items,
    });
    order = await markConfirmed(deps.db, created.id, pos.posOrderId);
  } catch (err) {
    order = await markUnconfirmed(deps.db, created.id, err);
  }
  return { order, replayed: false };
}

export async function findByKey(db: Db, key: string): Promise<OrderRow | null> {
  const res = await db.query<OrderRow>(`select ${ORDER_COLUMNS} from orders where idempotency_key = $1`, [key]);
  return res.rows[0] ?? null;
}

export async function markConfirmed(db: Db, orderId: string, posOrderId: string): Promise<OrderRow> {
  const res = await db.query<OrderRow>(
    `update orders set pos_status = 'confirmed', pos_order_id = $2, last_pos_error = null
     where id = $1
     returning ${ORDER_COLUMNS}`,
    [orderId, posOrderId],
  );
  return res.rows[0];
}

export async function markUnconfirmed(db: Db, orderId: string, err: unknown): Promise<OrderRow> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const res = await db.query<OrderRow>(
    `update orders set pos_status = 'unconfirmed', last_pos_error = $2
     where id = $1
     returning ${ORDER_COLUMNS}`,
    [orderId, message],
  );
  return res.rows[0];
}

// --- HTTP ------------------------------------------------------------------

export function parseSubmitOrder(body: unknown): SubmitOrderInput | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.idempotency_key !== "string" || b.idempotency_key.length < 8) {
    return "idempotency_key (string, >= 8 chars) is required";
  }
  if (!Number.isInteger(b.amount_cents) || (b.amount_cents as number) <= 0) {
    return "amount_cents must be a positive integer";
  }
  if (typeof b.account_token !== "string" || !b.account_token) return "account_token is required";
  if (b.items !== undefined && !Array.isArray(b.items)) return "items must be an array";
  return {
    idempotencyKey: b.idempotency_key,
    amountCents: b.amount_cents as number,
    accountToken: b.account_token,
    items: (b.items as unknown[]) ?? [],
  };
}

export function createSubmitOrderHandler(deps: SubmitOrderDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid JSON" });
    }
    const input = parseSubmitOrder(body);
    if (typeof input === "string") return json(400, { error: input });

    const { order, replayed } = await submitOrder(deps, input);
    // 202 for unconfirmed: we took the money and the order exists on our side,
    // but the kitchen may not have it yet. The client should show "pending".
    const status = order.pos_status === "confirmed" ? 200 : 202;
    return json(status, { order, replayed });
  };
}
