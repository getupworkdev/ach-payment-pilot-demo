import type { Db } from "./db.ts";
import { json } from "./http.ts";
import { createRefund, type OutboxWorker, RefundRequestError } from "./outbox.ts";

/** POST { payment_id, amount_cents, reason } -> 202 with the refund id. Sending happens in the outbox worker. */
export function createRequestRefundHandler(db: Db) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    let body: { payment_id?: unknown; amount_cents?: unknown; reason?: unknown };
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid JSON" });
    }
    if (typeof body.payment_id !== "string") return json(400, { error: "payment_id is required" });
    if (!Number.isInteger(body.amount_cents)) return json(400, { error: "amount_cents must be an integer" });
    if (typeof body.reason !== "string" || !body.reason.trim()) return json(400, { error: "reason is required" });

    try {
      const { refundId, outboxId } = await createRefund(db, {
        paymentId: body.payment_id,
        amountCents: body.amount_cents as number,
        reason: body.reason.trim(),
      });
      return json(202, { refund_id: refundId, outbox_id: outboxId, status: "requested" });
    } catch (err) {
      if (err instanceof RefundRequestError) return json(422, { error: err.message });
      throw err;
    }
  };
}

/** POST -> run one outbox batch. Meant to be called on a schedule (pg_cron + pg_net). */
export function createOutboxWorkerHandler(worker: OutboxWorker) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    return json(200, await worker.runOnce());
  };
}
