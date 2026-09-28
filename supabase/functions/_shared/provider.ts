// The payment provider as the rest of the code sees it. The only
// implementation in this repo is MockProvider; a real ACH processor adapter
// would implement the same interface.

export type ProviderPaymentStatus = "authorized" | "settled" | "returned" | "refunded";

export interface ProviderPayment {
  id: string;
  status: ProviderPaymentStatus;
  amount_cents: number;
  return_code: string | null;
}

export type ProviderEventType = "payment.settled" | "payment.returned" | "refund.completed";

export interface ProviderEvent {
  event_id: string;
  type: ProviderEventType | string;
  created_at: string;
  data: {
    payment_id: string;
    amount_cents?: number;
    return_code?: string;
    refund_id?: string;
  };
}

export interface CreateDebitInput {
  idempotencyKey: string;
  amountCents: number;
  accountToken: string;
}

export interface PaymentProvider {
  /** Idempotent on idempotencyKey: the same key always yields the same payment. */
  createDebit(input: CreateDebitInput): Promise<ProviderPayment>;
  getPayment(id: string): Promise<ProviderPayment | null>;
  listPayments(): Promise<ProviderPayment[]>;
}
