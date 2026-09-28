import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  EntityTokenManager,
  EntityTokenMismatchError,
  InMemoryCredentialStore,
  UnknownEntityError,
} from "../supabase/functions/_shared/entity_tokens.ts";
import { MockProviderApi, type ProviderPaymentRecord } from "../supabase/functions/_shared/mock_provider_api.ts";
import { EntityRoutingError, ProviderApiClient } from "../supabase/functions/_shared/provider_api.ts";

const ENTITIES = ["store-a", "store-b", "store-c"] as const;
const CLIENTS = Object.fromEntries(
  ENTITIES.map((e) => [e, { clientId: `client-${e}`, clientSecret: `secret-${e}` }]),
);

/** Provider + token manager + client on a shared fake clock. */
function setup(
  opts: { ttlSeconds?: number; refreshBeforeMs?: number; credentials?: Record<string, typeof CLIENTS[string]> } = {},
) {
  let t = Date.parse("2026-09-28T12:00:00Z");
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };

  // Each entity owns 100 settled synthetic payments: py_<entity>_<n>.
  const payments = (id: string): ProviderPaymentRecord | null => {
    const m = id.match(/^py_(store-[abc])_\d+$/);
    return m ? { entityId: m[1], amountCents: 5_000, status: "settled" } : null;
  };
  const api = new MockProviderApi({
    clients: CLIENTS,
    payments,
    now: clock.now,
    tokenTtlSeconds: opts.ttlSeconds ?? 300,
  });
  const tokens = new EntityTokenManager({
    credentials: new InMemoryCredentialStore(opts.credentials ?? CLIENTS),
    tokenUrl: "https://provider.test/oauth/token",
    fetch: api.fetch,
    refreshBeforeMs: opts.refreshBeforeMs ?? 60_000,
    now: clock.now,
  });
  const client = new ProviderApiClient({ baseUrl: "https://provider.test/", tokens, fetch: api.fetch });
  return { api, tokens, client, clock };
}

function refund(entityId: string, n: number) {
  return {
    entityId,
    method: "POST" as const,
    path: "/refunds",
    idempotencyKey: `refund:${entityId}:${n}`,
    body: {
      entity_id: entityId,
      payment_id: `py_${entityId}_${n}`,
      amount_cents: 100,
      reason: "synthetic test refund",
    },
  };
}

Deno.test("a transaction for one entity is never sent with another entity's token", async () => {
  const { api, tokens, client, clock } = setup({ ttlSeconds: 300, refreshBeforeMs: 60_000 });

  // 300 refunds across three entities, shuffled, sent 25 at a time
  // concurrently, with the clock moving 90s per batch so every entity's token
  // is refreshed several times mid-stream.
  const work = ENTITIES.flatMap((e) => Array.from({ length: 100 }, (_, n) => refund(e, n)));
  for (let i = work.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [work[i], work[j]] = [work[j], work[i]];
  }
  for (let i = 0; i < work.length; i += 25) {
    const results = await Promise.all(work.slice(i, i + 25).map((r) => client.send(r)));
    for (const r of results) assertEquals(r.status, 201);
    clock.advance(90_000);
  }

  const refunds = api.log.filter((l) => l.path === "/refunds");
  assertEquals(refunds.length, 300);
  for (const entry of refunds) {
    const expected = entry.idempotencyKey!.split(":")[1];
    assertEquals(entry.tokenEntity, expected, `token for ${entry.tokenEntity} used on ${expected}'s transaction`);
    assertEquals(entry.headerEntity, expected);
    assertEquals(entry.bodyEntity, expected);
  }
  assertEquals(refunds.filter((l) => l.status !== 201).length, 0, "no 401/403 - never an expired or foreign token");
  for (const e of ENTITIES) {
    assert(tokens.fetchCount(e) >= 4, `${e}'s token should have been refreshed along the way`);
  }
});

Deno.test("mis-filed credentials fail closed: entity A's work is never sent under B's identity", async () => {
  // Store A's slot mistakenly holds B's client credentials.
  const { api, client } = setup({ credentials: { ...CLIENTS, "store-a": CLIENTS["store-b"] } });

  const err = await assertRejects(() => client.send(refund("store-a", 1)), EntityTokenMismatchError);
  assertEquals(err.requested, "store-a");
  assertEquals(err.issuedFor, "store-b");
  assertEquals(api.log.filter((l) => l.path === "/refunds").length, 0, "nothing reached the refunds endpoint");

  // B is unaffected.
  assertEquals((await client.send(refund("store-b", 1))).status, 201);
});

Deno.test("a body for one entity can't be sent on another entity's route", async () => {
  const { api, client } = setup();
  const crossed = { ...refund("store-a", 1), body: { ...refund("store-b", 1).body } };
  await assertRejects(() => client.send(crossed), EntityRoutingError);
  assertEquals(api.log.length, 0);
});

Deno.test("unknown entity is refused before any network call", async () => {
  const { api, client } = setup();
  await assertRejects(() => client.send(refund("store-z", 1)), UnknownEntityError);
  assertEquals(api.log.length, 0);
});

Deno.test("one cached token per entity", async () => {
  const { api, tokens, client } = setup();
  for (let n = 0; n < 10; n++) {
    for (const e of ENTITIES) await client.send(refund(e, n));
  }
  for (const e of ENTITIES) {
    assertEquals(tokens.fetchCount(e), 1);
    assertEquals(api.tokensIssued(e), 1);
  }
});

Deno.test("token is refreshed before it expires, not after", async () => {
  const { tokens, clock } = setup({ ttlSeconds: 300, refreshBeforeMs: 60_000 });
  const first = await tokens.token("store-a");

  clock.advance(239_000); // 61s left: still outside the refresh window
  assertEquals(await tokens.token("store-a"), first);

  clock.advance(2_000); // 59s left: inside the window, so refresh now
  const second = await tokens.token("store-a");
  assert(second !== first);
  assertEquals(tokens.fetchCount("store-a"), 2);
});

Deno.test("concurrent callers for the same entity share one refresh", async () => {
  const { api, tokens } = setup();
  const got = await Promise.all(Array.from({ length: 20 }, () => tokens.token("store-a")));
  assertEquals(new Set(got).size, 1);
  assertEquals(api.tokensIssued("store-a"), 1);
});

Deno.test("a token revoked by the provider is replaced once and the request succeeds", async () => {
  const { api, tokens, client } = setup();
  await client.send(refund("store-a", 1));
  api.revokeTokens("store-a");

  const res = await client.send(refund("store-a", 2));
  assertEquals(res.status, 201);
  assertEquals(tokens.fetchCount("store-a"), 2);
  assertEquals(api.log.filter((l) => l.status === 401).length, 1);
});
