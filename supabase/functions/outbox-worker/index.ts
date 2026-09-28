import { envOutboxWorker } from "../_shared/env.ts";
import { createOutboxWorkerHandler } from "../_shared/refund_http.ts";

Deno.serve(createOutboxWorkerHandler(envOutboxWorker()));
