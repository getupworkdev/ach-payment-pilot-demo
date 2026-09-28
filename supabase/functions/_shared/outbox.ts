// Transactional outbox + retry worker for calls to the provider.
//
// Writing side: the business change and its outbox row are inserted in ONE
// database transaction (see requestRefund). Either both exist or neither does,
// so there is no window where we've recorded a refund but forgotten to send
// it, or sent one we never recorded.
//
// Sending side: OutboxWorker claims due rows, sends each with its idempotency
// key, and decides what happens next:
//   2xx                               -> sent
//   timeout / no response / 5xx / 429 -> retry later, exponential backoff + jitter
//   other 4xx (validation etc.)       -> review list, never retried automatically
//   still failing after maxAttempts   -> review list
// Every attempt reuses the same idempotency key, so a retry after a lost
// response can't create a second refund at the provider.

import type { Db, Queryable } from "./db.ts";
import { EntityTokenMismatchError, TokenRequestError, UnknownEntityError } from "./entity_tokens.ts";
import {
  EntityRoutingError,
  type ProviderApiClient,
  type ProviderRequest,
  ProviderUnreachableError,
} from "./provider_api.ts";

export interface OutboxRow {
  id: string;
  entity_id: string;
  topic: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  attempts: number;
}

export async function enqueue(
  tx: Queryable,
  msg: { entityId: string; topic: string; payload: Record<string, unknown>; idempotencyKey: string },
): Promise<string> {
  const { rows: [row] } = await tx.query<{ id: string }>(
    `insert into outbox (entity_id, topic, payload, idempotency_key)
     values ($1, $2, $3, $4)
     returning id`,
    [msg.entityId, msg.topic, JSON.stringify(msg.payload), msg.idempotencyKey],
  );
  return row.id;
}

// --- the business change: refunds ----------------------------------------------------

export class RefundRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundRequestError";
  }
}

export interface RefundRequest {
  paymentId: string;
  amountCents: number;
  reason: string;
}

/**
 * Record a refund and queue it for the provider. Takes a transaction handle on
 * purpose: callers compose it into their own transaction, or use createRefund.
 */
export async function requestRefund(
  tx: Queryable,
  input: RefundRequest,
): Promise<{ refundId: string; outboxId: string }> {
  const { rows: [payment] } = await tx.query<
    { id: string; entity_id: string; provider_payment_id: string; amount_cents: number; status: string }
  >(
    `select id, entity_id, provider_payment_id, amount_cents, status from payments where id = $1 for update`,
    [input.paymentId],
  );
  if (!payment) throw new RefundRequestError("payment not found");
  if (payment.status !== "settled") {
    throw new RefundRequestError(`payment is ${payment.status}; only settled payments can be refunded`);
  }

  const { rows: [{ already }] } = await tx.query<{ already: number }>(
    `select coalesce(sum(amount_cents), 0)::int as already from refunds
     where payment_id = $1 and status <> 'needs_review'`,
    [payment.id],
  );
  if (input.amountCents <= 0 || already + input.amountCents > payment.amount_cents) {
    throw new RefundRequestError("refund exceeds the refundable amount");
  }

  const { rows: [refund] } = await tx.query<{ id: string }>(
    `insert into refunds (payment_id, entity_id, amount_cents, reason) values ($1, $2, $3, $4) returning id`,
    [payment.id, payment.entity_id, input.amountCents, input.reason],
  );
  const outboxId = await enqueue(tx, {
    entityId: payment.entity_id,
    topic: "refund.create",
    idempotencyKey: `refund:${refund.id}`,
    payload: {
      refund_id: refund.id,
      provider_payment_id: payment.provider_payment_id,
      amount_cents: input.amountCents,
      reason: input.reason,
    },
  });
  return { refundId: refund.id, outboxId };
}

export function createRefund(db: Db, input: RefundRequest) {
  return db.transaction((tx) => requestRefund(tx, input));
}

// --- topics ------------------------------------------------------------------------

export interface TopicHandler {
  request(msg: OutboxRow): ProviderRequest;
  onSent?(tx: Queryable, msg: OutboxRow, responseBody: unknown): Promise<void>;
  onReview?(tx: Queryable, msg: OutboxRow, reason: string): Promise<void>;
}

export const refundTopic: TopicHandler = {
  request: (msg) => ({
    entityId: msg.entity_id,
    method: "POST",
    path: "/refunds",
    idempotencyKey: msg.idempotency_key,
    body: {
      entity_id: msg.entity_id,
      payment_id: msg.payload.provider_payment_id,
      amount_cents: msg.payload.amount_cents,
      reason: msg.payload.reason,
    },
  }),
  async onSent(tx, msg, body) {
    await tx.query(
      `update refunds set status = 'submitted', provider_refund_id = $2 where id = $1`,
      [msg.payload.refund_id, (body as { id?: string })?.id ?? null],
    );
  },
  async onReview(tx, msg) {
    await tx.query(`update refunds set status = 'needs_review' where id = $1`, [msg.payload.refund_id]);
  },
};

// --- retry policy ----------------------------------------------------------------------

export type Outcome =
  | { kind: "sent"; body: unknown }
  | { kind: "retry"; reason: string; retryAfterMs?: number | null }
  | { kind: "review"; reason: string };

export function classifyResponse(status: number, body: unknown, retryAfterMs: number | null): Outcome {
  if (status >= 200 && status < 300) return { kind: "sent", body };
  const detail = typeof body === "object" && body && "error" in body ? `: ${(body as { error: string }).error}` : "";
  if (status === 408 || status === 429 || status >= 500) {
    return { kind: "retry", reason: `HTTP ${status}${detail}`, retryAfterMs };
  }
  // 401 here means the client already refreshed the token once and it still
  // failed - most likely an outage on the provider's auth side.
  if (status === 401) return { kind: "retry", reason: `HTTP 401${detail}` };
  return { kind: "review", reason: `HTTP ${status}${detail}` };
}

export function classifyError(err: unknown): Outcome {
  if (err instanceof ProviderUnreachableError) return { kind: "retry", reason: err.message };
  if (err instanceof TokenRequestError) {
    return err.temporary ? { kind: "retry", reason: err.message } : { kind: "review", reason: err.message };
  }
  // Configuration problems: retrying won't fix them and must not route around them.
  if (
    err instanceof EntityTokenMismatchError || err instanceof UnknownEntityError || err instanceof EntityRoutingError
  ) {
    return { kind: "review", reason: err.message };
  }
  return { kind: "retry", reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
}

/**
 * Exponential backoff with "equal jitter": the cap doubles each attempt up to
 * maxMs, and the delay is a random point in the upper half of it. The jitter
 * spreads retries from many messages out after an outage; the floor keeps a
 * retry from firing almost immediately.
 */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(cap / 2 + random() * (cap / 2));
}

// --- worker ------------------------------------------------------------------------

export interface OutboxWorkerOptions {
  db: Db;
  client: ProviderApiClient;
  topics?: Record<string, TopicHandler>;
  now?: () => number;
  random?: () => number;
  batchSize?: number;
  /** How long a claimed row is reserved before another worker may take it (crash recovery). */
  leaseMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface RunSummary {
  claimed: number;
  sent: number;
  retrying: number;
  review: number;
}

export class OutboxWorker {
  #o: Required<OutboxWorkerOptions>;

  constructor(opts: OutboxWorkerOptions) {
    this.#o = {
      topics: { "refund.create": refundTopic },
      now: Date.now,
      random: Math.random,
      batchSize: 25,
      leaseMs: 60_000,
      maxAttempts: 8,
      baseDelayMs: 2_000,
      maxDelayMs: 10 * 60_000,
      ...opts,
    };
  }

  /** Claim what's due and process it. Safe to run on several workers at once. */
  async runOnce(): Promise<RunSummary> {
    const now = this.#o.now();
    const claimed = await this.#claim(now);
    const summary: RunSummary = { claimed: claimed.length, sent: 0, retrying: 0, review: 0 };

    for (const msg of claimed) {
      const outcome = await this.#send(msg);
      await this.#settle(msg, outcome);
      if (outcome.kind === "sent") summary.sent++;
      else if (outcome.kind === "review" || msg.attempts >= this.#o.maxAttempts) summary.review++;
      else summary.retrying++;
    }
    return summary;
  }

  async #claim(now: number): Promise<OutboxRow[]> {
    // SKIP LOCKED lets concurrent workers take disjoint batches. A 'sending'
    // row whose lease ran out belonged to a worker that died mid-send.
    const { rows } = await this.#o.db.query<OutboxRow>(
      `update outbox
       set status = 'sending', locked_until = $2::timestamptz, attempts = attempts + 1
       where id in (
         select id from outbox
         where (status = 'pending' and next_attempt_at <= $1::timestamptz)
            or (status = 'sending' and locked_until <= $1::timestamptz)
         order by next_attempt_at, created_at
         limit $3
         for update skip locked
       )
       returning id, entity_id, topic, payload, idempotency_key, attempts`,
      [iso(now), iso(now + this.#o.leaseMs), this.#o.batchSize],
    );
    return rows.map((r) => ({ ...r, payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload }));
  }

  async #send(msg: OutboxRow): Promise<Outcome> {
    const topic = this.#o.topics[msg.topic];
    if (!topic) return { kind: "review", reason: `no handler for topic ${msg.topic}` };
    try {
      const res = await this.#o.client.send(topic.request(msg));
      return classifyResponse(res.status, res.body, res.retryAfterMs);
    } catch (err) {
      return classifyError(err);
    }
  }

  async #settle(msg: OutboxRow, outcome: Outcome): Promise<void> {
    const topic = this.#o.topics[msg.topic];
    const now = this.#o.now();
    await this.#o.db.transaction(async (tx) => {
      if (outcome.kind === "sent") {
        await tx.query(
          `update outbox set status = 'sent', sent_at = $2::timestamptz, response = $3, locked_until = null, last_error = null
           where id = $1`,
          [msg.id, iso(now), JSON.stringify(outcome.body ?? null)],
        );
        await topic?.onSent?.(tx, msg, outcome.body);
        return;
      }

      const giveUp = outcome.kind === "retry" && msg.attempts >= this.#o.maxAttempts;
      if (outcome.kind === "review" || giveUp) {
        const reason = giveUp ? `gave up after ${msg.attempts} attempts; last error ${outcome.reason}` : outcome.reason;
        await tx.query(
          `update outbox set status = 'review', locked_until = null, last_error = $2 where id = $1`,
          [msg.id, reason],
        );
        await topic?.onReview?.(tx, msg, reason);
        return;
      }

      const delay = Math.max(
        backoffDelay(msg.attempts, this.#o.baseDelayMs, this.#o.maxDelayMs, this.#o.random),
        outcome.retryAfterMs ?? 0,
      );
      await tx.query(
        `update outbox set status = 'pending', next_attempt_at = $2::timestamptz, locked_until = null, last_error = $3
         where id = $1`,
        [msg.id, iso(now + delay), outcome.reason],
      );
    });
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
