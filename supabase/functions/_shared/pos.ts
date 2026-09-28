// The point-of-sale system as the rest of the code sees it.

export interface PosOrderRequest {
  idempotencyKey: string;
  orderId: string;
  amountCents: number;
  items: unknown[];
}

export interface PosOrder {
  posOrderId: string;
  idempotencyKey: string;
}

/**
 * We gave up waiting. The POS may or may not have created the order - the
 * caller must not assume either and must not retry blindly.
 */
export class PosTimeoutError extends Error {
  constructor(message = "POS did not respond in time") {
    super(message);
    this.name = "PosTimeoutError";
  }
}

export interface PosClient {
  /** Idempotent on idempotencyKey. May throw PosTimeoutError. */
  submitOrder(req: PosOrderRequest): Promise<PosOrder>;
  /** Look an order up by the key it was submitted with. null = POS has no such order. */
  findOrder(idempotencyKey: string): Promise<PosOrder | null>;
}
