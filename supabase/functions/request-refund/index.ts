import { envDeps } from "../_shared/env.ts";
import { createRequestRefundHandler } from "../_shared/refund_http.ts";

Deno.serve(createRequestRefundHandler(envDeps().db));
