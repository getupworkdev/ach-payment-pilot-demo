import { type Db, isIllegalTransition, type Queryable } from "./db.ts";
import type { ProviderEvent } from "./provider.ts";
import { staffReviewReason } from "./return_codes.ts";
import { json } from "./http.ts";
import { SIGNATURE_HEADER, verify } from "./signature.ts";

export type WebhookOutcome =
  | { kind: "processed"; paymentId: string; status: string }
  | { kind: "duplicate" }
  | { kind: "ignored" }
  // The two below roll back and are NOT recorded, so the provider's redelivery
  // gets another go once the missing piece (our payment row, an earlier event)
  // has landed.
  | { kind: "unknown_payment" }
  | { kind: "illegal_transition"; message: string };

class Rollback extends Error {
  constructor(readonly outcome: WebhookOutcome) {
    super(outcome.kind);
  }
}

export function parseEvent(input: unknown): ProviderEvent | string {
  if (typeof input !== "object" || input === null) return "body must be a JSON object";
  const e = input as Partial<ProviderEvent>;
  if (typeof e.event_id !== "string" || !e.event_id) return "event_id is required";
  if (typeof e.type !== "string" || !e.type) return "type is required";
  if (typeof e.data?.payment_id !== "string") return "data.payment_id is required";
  if (e.type === "payment.returned" && !/^R\d{2}$/.test(e.data.return_code ?? "")) {
    return "payment.returned requires data.return_code like R01";
  }
  return e as ProviderEvent;
}

/**
 * Apply one provider event exactly once.
 *
 * The event_id insert and the state change share a transaction: either both
 * commit or neither does. A duplicate delivery hits the primary key, inserts
 * nothing, and is acknowledged without touching the payment.
 */
export async function processProviderEvent(db: Db, event: ProviderEvent): Promise<WebhookOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx.query(
        `insert into webhook_events (event_id, type, provider_payment_id, payload)
         values ($1, $2, $3, $4)
         on conflict (event_id) do nothing
         returning event_id`,
        [event.event_id, event.type, event.data.payment_id, JSON.stringify(event)],
      );
      if (inserted.rows.length === 0) return { kind: "duplicate" } as const;

      switch (event.type) {
        case "payment.settled":
          return await transition(tx, event, "settled", `settled_at = coalesce(settled_at, now())`);
        case "payment.returned":
          return await applyReturn(tx, event);
        case "refund.completed":
          return await transition(tx, event, "refunded", `refunded_at = coalesce(refunded_at, now())`);
        default:
          await tx.query(`update webhook_events set outcome = 'ignored' where event_id = $1`, [event.event_id]);
          return { kind: "ignored" } as const;
      }
    });
  } catch (err) {
    if (err instanceof Rollback) return err.outcome;
    if (isIllegalTransition(err)) {
      return { kind: "illegal_transition", message: (err as Error).message };
    }
    throw err;
  }
}

async function transition(
  tx: Queryable,
  event: ProviderEvent,
  status: "settled" | "refunded",
  extraSet: string,
): Promise<WebhookOutcome> {
  const res = await tx.query<{ id: string }>(
    `update payments set status = $2, ${extraSet}
     where provider_payment_id = $1
     returning id`,
    [event.data.payment_id, status],
  );
  if (res.rows.length === 0) throw new Rollback({ kind: "unknown_payment" });
  return { kind: "processed", paymentId: res.rows[0].id, status };
}

async function applyReturn(tx: Queryable, event: ProviderEvent): Promise<WebhookOutcome> {
  const code = event.data.return_code!;
  const res = await tx.query<{ id: string }>(
    `update payments
     set status = 'returned', return_code = $2, returned_at = now()
     where provider_payment_id = $1
     returning id`,
    [event.data.payment_id, code],
  );
  if (res.rows.length === 0) throw new Rollback({ kind: "unknown_payment" });
  const paymentId = res.rows[0].id;

  // The customer already has their food; the money has bounced. A person
  // decides what happens next - nothing here tries to re-debit.
  await tx.query(
    `update orders set needs_staff_review = true, staff_review_reason = $2
     where payment_id = $1`,
    [paymentId, staffReviewReason(code)],
  );
  return { kind: "processed", paymentId, status: "returned" };
}

// --- HTTP ------------------------------------------------------------------

export interface WebhookDeps {
  db: Db;
  webhookSecret: string;
}

export function createWebhookHandler(deps: WebhookDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json(405, { error: "method not allowed" });

    const raw = await req.text();
    if (!(await verify(deps.webhookSecret, raw, req.headers.get(SIGNATURE_HEADER)))) {
      return json(401, { error: "bad signature" });
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "invalid JSON" });
    }
    const event = parseEvent(body);
    if (typeof event === "string") return json(400, { error: event });

    const outcome = await processProviderEvent(deps.db, event);
    switch (outcome.kind) {
      case "processed":
      case "duplicate":
      case "ignored":
        return json(200, { received: true, outcome: outcome.kind });
      case "unknown_payment":
      case "illegal_transition":
        console.warn(`webhook ${event.event_id} not applied: ${outcome.kind}`, outcome);
        // Non-2xx so the provider redelivers later.
        return json(409, { received: false, outcome: outcome.kind });
    }
  };
}
