// In-memory stand-in for an ACH processor. It keeps its own view of each
// payment (which is what reconciliation diffs against) and produces the
// webhook events a real processor would send.
//
// Settlement, returns and refunds are triggered explicitly by calling
// settle / returnPayment / refund - there is no clock and no bank.

import type {
  CreateDebitInput,
  PaymentProvider,
  ProviderEvent,
  ProviderPayment,
  ProviderPaymentStatus,
} from "./provider.ts";

const ALLOWED: Record<ProviderPaymentStatus, ProviderPaymentStatus[]> = {
  authorized: ["settled"],
  settled: ["returned", "refunded"],
  returned: [],
  refunded: [],
};

export class MockProvider implements PaymentProvider {
  #payments = new Map<string, ProviderPayment>();
  #byKey = new Map<string, string>();
  #debitCalls = 0;
  #seq = 0;

  async createDebit(input: CreateDebitInput): Promise<ProviderPayment> {
    this.#debitCalls++;
    const existing = this.#byKey.get(input.idempotencyKey);
    if (existing) return { ...this.#payments.get(existing)! };

    const payment: ProviderPayment = {
      id: `py_${this.#nextId()}`,
      status: "authorized",
      amount_cents: input.amountCents,
      return_code: null,
    };
    this.#payments.set(payment.id, payment);
    this.#byKey.set(input.idempotencyKey, payment.id);
    return { ...payment };
  }

  async getPayment(id: string): Promise<ProviderPayment | null> {
    const p = this.#payments.get(id);
    return p ? { ...p } : null;
  }

  async listPayments(): Promise<ProviderPayment[]> {
    return [...this.#payments.values()].map((p) => ({ ...p }));
  }

  // --- simulation controls -------------------------------------------------

  settle(paymentId: string): ProviderEvent {
    this.#move(paymentId, "settled");
    return this.#event("payment.settled", paymentId);
  }

  returnPayment(paymentId: string, returnCode: string): ProviderEvent {
    if (!/^R\d{2}$/.test(returnCode)) throw new Error(`not an ACH return code: ${returnCode}`);
    const p = this.#move(paymentId, "returned");
    p.return_code = returnCode;
    return this.#event("payment.returned", paymentId, { return_code: returnCode });
  }

  refund(paymentId: string): ProviderEvent {
    this.#move(paymentId, "refunded");
    return this.#event("refund.completed", paymentId, { refund_id: `re_${this.#nextId()}` });
  }

  /** Number of distinct debits (charges) the provider holds. */
  chargeCount(): number {
    return this.#payments.size;
  }

  /** Number of createDebit calls, including idempotent replays. */
  debitCallCount(): number {
    return this.#debitCalls;
  }

  #move(paymentId: string, to: ProviderPaymentStatus): ProviderPayment {
    const p = this.#payments.get(paymentId);
    if (!p) throw new Error(`unknown payment ${paymentId}`);
    if (!ALLOWED[p.status].includes(to)) {
      throw new Error(`provider refuses ${p.status} -> ${to} for ${paymentId}`);
    }
    p.status = to;
    return p;
  }

  #event(type: ProviderEvent["type"], paymentId: string, extra: Partial<ProviderEvent["data"]> = {}): ProviderEvent {
    const p = this.#payments.get(paymentId)!;
    return {
      event_id: `evt_${this.#nextId()}`,
      type,
      created_at: new Date().toISOString(),
      data: { payment_id: paymentId, amount_cents: p.amount_cents, ...extra },
    };
  }

  #nextId(): string {
    this.#seq++;
    return `${Date.now().toString(36)}${this.#seq.toString(36).padStart(4, "0")}`;
  }
}
