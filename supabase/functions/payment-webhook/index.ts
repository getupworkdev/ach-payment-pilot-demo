import { envDeps, required } from "../_shared/env.ts";
import { createWebhookHandler } from "../_shared/webhook.ts";

Deno.serve(createWebhookHandler({
  db: envDeps().db,
  webhookSecret: required("PROVIDER_WEBHOOK_SECRET"),
}));
