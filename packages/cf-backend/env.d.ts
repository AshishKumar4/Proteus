// Generated from wrangler.jsonc bindings
import type { OrchestratorAgent } from "./src/orchestrator.js";
import type { ExplorationAgent } from "./src/exploration.js";

interface Env {
  AI: Ai;
  LOADER: WorkerLoader;
  OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
  ExplorationAgent: DurableObjectNamespace<ExplorationAgent>;
  AI_GATEWAY_URL: string;
  AI_GATEWAY_AUTH: string;
}
