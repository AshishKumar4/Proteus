/**
 * Worker entry point — exports all DO classes and routes agent requests.
 * The Vite cloudflare() plugin serves the React SPA for non-agent paths.
 */

import { routeAgentRequest } from "agents";

export { OrchestratorAgent } from "./orchestrator.js";
export { ExplorationAgent } from "./exploration.js";

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
