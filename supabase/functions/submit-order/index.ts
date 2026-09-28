import { envDeps } from "../_shared/env.ts";
import { createSubmitOrderHandler } from "../_shared/submit_order.ts";

Deno.serve(createSubmitOrderHandler(envDeps()));
