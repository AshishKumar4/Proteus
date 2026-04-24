/**
 * Worker entry point — exports all DO classes and routes agent requests.
 * The Vite cloudflare() plugin serves the React SPA for non-agent paths.
 */

import { routeAgentRequest } from "agents";
import { proxyToSandbox } from "@cloudflare/sandbox";
import { handlePcRequest } from "./pc-handler.js";

export { OrchestratorAgent } from "./orchestrator.js";
export { ExplorationAgent } from "./exploration.js";
export { ProteusSandbox } from "./proteus-sandbox.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // PC agent WebSocket tunnel + install endpoint.
    if (url.pathname.startsWith("/pc/")) {
      return handlePcRequest(request, env);
    }

    // Preview ports exposed via Sandbox.exposePort are served on preview
    // subdomains; proxyToSandbox handles the routing when a request hits
    // one of those. Returns null for non-preview requests so we fall through.
    const sandboxResp = await proxyToSandbox(request, env);
    if (sandboxResp) return sandboxResp;

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
