// HTTP clients for the provider and POS. In this repo they point at
// scripts/mock_services.ts; the interfaces are what a real adapter would fill.

import type { CreateDebitInput, PaymentProvider, ProviderPayment } from "./provider.ts";
import { type PosClient, type PosOrder, type PosOrderRequest, PosTimeoutError } from "./pos.ts";

async function expectOk(res: Response): Promise<unknown> {
  if (!res.ok) throw new Error(`${res.url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

export class HttpProviderClient implements PaymentProvider {
  constructor(private baseUrl: string) {}

  async createDebit(input: CreateDebitInput): Promise<ProviderPayment> {
    const res = await fetch(`${this.baseUrl}/provider/debits`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({ amount_cents: input.amountCents, account_token: input.accountToken }),
    });
    return (await expectOk(res)) as ProviderPayment;
  }

  async getPayment(id: string): Promise<ProviderPayment | null> {
    const res = await fetch(`${this.baseUrl}/provider/payments/${encodeURIComponent(id)}`);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    return (await expectOk(res)) as ProviderPayment;
  }

  async listPayments(): Promise<ProviderPayment[]> {
    return (await expectOk(await fetch(`${this.baseUrl}/provider/payments`))) as ProviderPayment[];
  }
}

export class HttpPosClient implements PosClient {
  constructor(private baseUrl: string, private timeoutMs: number) {}

  async submitOrder(req: PosOrderRequest): Promise<PosOrder> {
    const res = await this.#fetch(`${this.baseUrl}/pos/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": req.idempotencyKey },
      body: JSON.stringify({ order_id: req.orderId, amount_cents: req.amountCents, items: req.items }),
    });
    return (await expectOk(res)) as PosOrder;
  }

  async findOrder(idempotencyKey: string): Promise<PosOrder | null> {
    const res = await this.#fetch(`${this.baseUrl}/pos/orders?idempotency_key=${encodeURIComponent(idempotencyKey)}`);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    return (await expectOk(res)) as PosOrder;
  }

  async #fetch(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new PosTimeoutError(`POS did not respond within ${this.timeoutMs}ms`);
      }
      throw err;
    }
  }
}
