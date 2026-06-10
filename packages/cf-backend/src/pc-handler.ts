/**
 * Device tunnel — reverse-WebSocket from the user's laptop, at the USER level.
 *
 * Routes:
 *   GET  /pc/install                — daemon updater/starter for an existing local config
 *   GET  /pc/daemon.js              — the Node daemon binary (JS)
 *   POST /pc/connect-ticket         — exchange local device token for short-lived WS ticket
 *   WS   /pc/connect?user=U&ticket=T — daemon WS upgrade
 *
 * A device links ONCE to the user (token minted by UserDO.registerDevice), and
 * every one of that user's agents can then reach it. The daemon stores that
 * token locally, exchanges it over HTTPS for a one-minute ticket, then connects
 * the WebSocket with the ticket so long-lived secrets do not appear in URLs.
 */

import PC_AGENT_DAEMON_SOURCE from "../../pc-agent/src/index.js?raw";

const DAEMON_JS_URL = "/pc/daemon.js";

export async function handlePcRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/pc/install") {
    return installScriptResponse(url.origin);
  }
  if (path === "/pc/daemon.js") {
    return daemonJsResponse();
  }
  if (path === "/pc/connect-ticket") {
    return handlePcConnectTicket(request, env);
  }
  if (path === "/pc/connect") {
    return handlePcConnect(request, env);
  }
  return new Response("Not found", { status: 404 });
}

function installScriptResponse(origin: string): Response {
  // `proteus connect` writes ~/.proteus/device.json with the device token over
  // an authenticated HTTPS API call. This script only updates/starts the daemon
  // for users who already have that local config.
  const script = `#!/usr/bin/env bash
set -eu
PROTEUS_ORIGIN="\${PROTEUS_ORIGIN:-${origin}}"

DIR="\$HOME/.proteus"
mkdir -p "\$DIR"
chmod 700 "\$DIR"
if [ ! -f "\$DIR/device.json" ]; then
  echo "No Proteus device config found at \$DIR/device.json."
  echo "Run: proteus auth --origin \$PROTEUS_ORIGIN && proteus connect"
  exit 1
fi
echo "Downloading Proteus device daemon…"
curl -fsSL "\$PROTEUS_ORIGIN${DAEMON_JS_URL}" -o "\$DIR/pc-agent.js"
chmod 600 "\$DIR/device.json"

if command -v node >/dev/null 2>&1; then
  echo "Starting daemon (node)…"
  nohup node "\$DIR/pc-agent.js" > "\$DIR/pc-agent.log" 2>&1 &
  echo "  PID=\$! log=\$DIR/pc-agent.log"
else
  echo "Node.js required. Install https://nodejs.org/ then re-run."
  exit 1
fi
echo "Proteus device connected. Check the Devices tab — it should flip to connected within a few seconds."
`;
  return new Response(script, {
    status: 200,
    headers: { "content-type": "text/x-shellscript; charset=utf-8" },
  });
}

function daemonJsResponse(): Response {
  // The daemon source is packages/pc-agent/src/index.js, bundled as a string
  // at build time via vite's `?raw` import — one source of truth, no copies.
  return new Response(PC_AGENT_DAEMON_SOURCE, {
    status: 200,
    headers: { "content-type": "application/javascript; charset=utf-8" },
  });
}

async function handlePcConnectTicket(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await safeJson<{ user?: string; token?: string }>(request);
  if (!body?.user || !body.token) return json({ error: "user and token required" }, { status: 400 });
  if (!/^[a-f0-9]{32}$/.test(body.user)) return json({ error: "invalid user" }, { status: 400 });

  const ns = env.UserDO;
  if (!ns) return json({ error: "No UserDO binding" }, { status: 500 });
  const stub = ns.get(ns.idFromName(body.user)) as unknown as {
    issueDeviceConnectTicket(token: string): Promise<{ ok: boolean; ticket?: string; expiresAt?: number }>;
  };
  const issued = await stub.issueDeviceConnectTicket(body.token);
  if (!issued.ok || !issued.ticket || !issued.expiresAt) return json({ error: "unauthorized" }, { status: 401 });
  return json({ ticket: issued.ticket, expiresAt: issued.expiresAt });
}

async function handlePcConnect(request: Request, env: Env): Promise<Response> {
  const upgrade = request.headers.get("Upgrade");
  if (upgrade !== "websocket") return new Response("Expected WebSocket", { status: 426 });

  const url = new URL(request.url);
  const userId = url.searchParams.get("user");
  const ticket = url.searchParams.get("ticket");
  if (!userId || !ticket) {
    return new Response("Missing ?user or ?ticket", { status: 400 });
  }
  if (!/^[a-f0-9]{32}$/.test(userId)) return new Response("invalid user", { status: 400 });

  const ns = env.UserDO;
  if (!ns) return new Response("No UserDO binding", { status: 500 });
  const stub = ns.get(ns.idFromName(userId)) as unknown as {
    verifyDeviceConnectTicket(ticket: string): Promise<{ ok: boolean; deviceId?: string }>;
    attachDeviceSocket(deviceId: string, ws: WebSocket): Promise<void>;
  };

  // Verify and consume the short-lived ticket before upgrading.
  const verified = await stub.verifyDeviceConnectTicket(ticket);
  if (!verified?.ok || !verified.deviceId) return new Response("unauthorized", { status: 401 });

  // Accept the WebSocket and hand the server side to the UserDO (it accepts +
  // wires the JSON-RPC tunnel; the agents forward calls to it).
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  await stub.attachDeviceSocket(verified.deviceId, server);

  return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

async function safeJson<T = unknown>(request: Request): Promise<T | null> {
  try { return (await request.json()) as T; } catch { return null; }
}
