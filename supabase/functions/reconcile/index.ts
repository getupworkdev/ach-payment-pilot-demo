import { envDeps } from "../_shared/env.ts";
import { createReconcileHandler } from "../_shared/reconcile.ts";

Deno.serve(createReconcileHandler(envDeps(), {
  staleSubmittedSeconds: Number(Deno.env.get("RECONCILE_STALE_SUBMITTED_SECONDS") ?? "120"),
}));
