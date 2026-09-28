// In-memory POS. Idempotent on the idempotency key, like the real thing is
// supposed to be, with injectable faults for the two timeout cases that matter:
//
//   timeout_before_commit - request never reached the POS; nothing was created
//   timeout_after_commit  - POS created the order, the response was lost
//
// From the caller's side both look identical, which is the whole problem.

import { type PosClient, type PosOrder, type PosOrderRequest, PosTimeoutError } from "./pos.ts";

export type PosFault = "timeout_before_commit" | "timeout_after_commit" | "lookup_timeout";

export class MockPos implements PosClient {
  #orders = new Map<string, PosOrder & { request: PosOrderRequest }>();
  #faults: PosFault[] = [];
  #submitCalls = 0;
  #seq = 0;

  /** Queue a fault for the next matching call. */
  injectFault(fault: PosFault): void {
    this.#faults.push(fault);
  }

  async submitOrder(req: PosOrderRequest): Promise<PosOrder> {
    this.#submitCalls++;
    const fault = this.#takeFault("timeout_before_commit", "timeout_after_commit");
    if (fault === "timeout_before_commit") throw new PosTimeoutError();

    let order = this.#orders.get(req.idempotencyKey);
    if (!order) {
      order = { posOrderId: `pos_${++this.#seq}`, idempotencyKey: req.idempotencyKey, request: req };
      this.#orders.set(req.idempotencyKey, order);
    }

    if (fault === "timeout_after_commit") throw new PosTimeoutError();
    return { posOrderId: order.posOrderId, idempotencyKey: order.idempotencyKey };
  }

  async findOrder(idempotencyKey: string): Promise<PosOrder | null> {
    if (this.#takeFault("lookup_timeout")) throw new PosTimeoutError("POS lookup timed out");
    const order = this.#orders.get(idempotencyKey);
    return order ? { posOrderId: order.posOrderId, idempotencyKey } : null;
  }

  /** Orders that actually exist in the POS (i.e. what the kitchen sees). */
  orderCount(): number {
    return this.#orders.size;
  }

  submitCallCount(): number {
    return this.#submitCalls;
  }

  #takeFault(...kinds: PosFault[]): PosFault | undefined {
    const i = this.#faults.findIndex((f) => kinds.includes(f));
    return i === -1 ? undefined : this.#faults.splice(i, 1)[0];
  }
}
