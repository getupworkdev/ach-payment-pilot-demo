// Serve all the functions on one port without the Supabase CLI or Docker,
// using the same handlers and env wiring as the real entrypoints. Useful when
// you have a Postgres to point at but no Docker.
//
//   SUPABASE_DB_URL=postgres://... deno task serve
//
// Routes mirror the Supabase gateway: /functions/v1/<name>

import { envDeps, envOutboxWorker, required } from "../supabase/functions/_shared/env.ts";
import { json } from "../supabase/functions/_shared/http.ts";
import { createReconcileHandler } from "../supabase/functions/_shared/reconcile.ts";
import { createOutboxWorkerHandler, createRequestRefundHandler } from "../supabase/functions/_shared/refund_http.ts";
import { createSubmitOrderHandler } from "../supabase/functions/_shared/submit_order.ts";
import { createWebhookHandler } from "../supabase/functions/_shared/webhook.ts";

const deps = envDeps();
const routes: Record<string, (req: Request) => Promise<Response>> = {
  "payment-webhook": createWebhookHandler({ db: deps.db, webhookSecret: required("PROVIDER_WEBHOOK_SECRET") }),
  "submit-order": createSubmitOrderHandler(deps),
  "reconcile": createReconcileHandler(deps, {
    staleSubmittedSeconds: Number(Deno.env.get("RECONCILE_STALE_SUBMITTED_SECONDS") ?? "120"),
  }),
  "request-refund": createRequestRefundHandler(deps.db),
  "outbox-worker": createOutboxWorkerHandler(envOutboxWorker()),
};

const port = Number(Deno.env.get("FUNCTIONS_PORT") ?? "54321");
Deno.serve({ port }, (req) => {
  const name = new URL(req.url).pathname.match(/^\/functions\/v1\/([^/]+)/)?.[1];
  const handler = name ? routes[name] : undefined;
  return handler ? handler(req) : json(404, { error: "no such function" });
});
console.log(`functions on :${port}/functions/v1/{${Object.keys(routes).join(",")}}`);
