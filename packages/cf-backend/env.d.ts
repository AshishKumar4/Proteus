// Generated from wrangler.jsonc bindings.
//
// Note on AI binding: we prefer the Workers AI direct binding (env.AI) when
// available, and fall back to the AI Gateway (OpenAI-compatible HTTP) when
// not. The binding is OPTIONAL — to enable it, add this block to wrangler.jsonc:
//
//   "ai": { "binding": "AI" }
//
// and Wrangler will inject the Ai runtime object. Without the binding, code
// paths guard with `if (env.AI && typeof env.AI !== "string") { ... }` and
// transparently fall through to the gateway (AI_GATEWAY_URL + AI_GATEWAY_AUTH).
import type { OrchestratorAgent } from "./src/orchestrator.js";
import type { ExplorationAgent } from "./src/exploration.js";

interface Env {
  /** Workers AI direct binding. OPTIONAL — fallback is the AI Gateway. */
  AI?: Ai;
  LOADER: WorkerLoader;
  OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
  ExplorationAgent: DurableObjectNamespace<ExplorationAgent>;
  AI_GATEWAY_URL: string;
  AI_GATEWAY_AUTH: string;
}
