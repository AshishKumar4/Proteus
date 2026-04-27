# Proteus — Stability Audit (forensic)

Real-usage bugs the programmatic E2E missed. Every claim cites `file:line` from
read-only investigation across the React UI, the Think framework, the Cloudflare
Sandbox SDK, and our orchestrator/runtime. Authored 2026-04-24.

Legend (severity): **C** critical · **H** high · **M** medium

---

## §A — Streaming + WebSocket reliability

### A1 (C) — Disconnect UI unmounts the chat tree, deleting the in-progress turn
- **Evidence:** `packages/cf-backend/src/pages/WorkspacePage.tsx:802-806` returns
  `<EmptyTab/>` whenever `connectionStatus === "error"`, replacing the entire
  `<PanelGroup>`. The chat hook's in-memory message list is destroyed.
- **Compounding:** `packages/cf-backend/src/hooks/use-proteus.ts:74-77` sets
  `connectionStatus = "error"` on any `onError` event but never recovers — the
  user's screen is pinned to the empty tab even after the socket reopens.
- **Symptom:** "Agent's turn disappears from screen on WS drops."
- **Fix:** Render disconnect as a non-destructive overlay banner; never unmount
  the chat panel. Make `onOpen` flip the status back to `"connected"` regardless
  of prior state.

### A2 (C) — `useChat.resumeStream()` only fires once on mount
- **Evidence:** `@ai-sdk/react/dist/index.js:257-261` — the resume effect's deps
  are `[resume, chatRef]`, neither of which changes when partysocket
  auto-reconnects (`partysocket/dist/ws.js:55-65`). The server *does* buffer
  chunks for resume in `cf_ai_chat_stream_chunks`
  (`@cloudflare/ai-chat/dist/index.js:354-368, 461-505`), but the client never
  asks to resume after a reconnect.
- **Symptom:** "Agent messages don't appear at all sometimes."
- **Fix:** Add a `useEffect` in `use-proteus.ts` that listens for `agent`'s
  `"open"` event and calls `chatRef.current.resumeStream()` on *every*
  reconnect, not just the first mount.

### A3 (H) — Listeners attached to private `_ws`, not the stable PartySocket EventTarget
- **Evidence:** `use-proteus.ts:140-143` and `:385-405` cast
  `(agent as { _ws?: WebSocket })._ws` to add `"message"` listeners. The `_ws`
  field is recreated on each reconnect; broadcasts arriving in the close→open
  gap are dropped because the OLD listener was on a dead socket and the NEW one
  isn't bound yet.
- **Symptom:** Silent loss of `executor-output` / `mcts-progress` events.
- **Fix:** Listen on `agent` (which extends `EventTarget`) directly — same
  pattern used by `@cloudflare/ai-chat/dist/react.js:924-931`.

### A4 (H) — No application-level heartbeat → idle WS reaped after ~100s
- **Evidence:** `packages/cf-backend/src/lib/protocol.ts:93` defines
  `{ type: "ping" }` in the wire union but it is never sent (grep returns 0
  hits across `cf-backend/src`). Cloudflare's edge tears down idle WS after
  ~100s.
- **Symptom:** Long-paused turns silently die.
- **Fix:** Send `{ type: "ping" }` from the client every 25s; server already
  no-ops unknown messages.

### A5 (H) — Streaming throughput: no throttle, no memo, full-tree re-render every token
- **Evidence:**
  - `useAgentChat` is called without `experimental_throttle`
    (`use-proteus.ts:80-86`).
  - `MarkdownContent` has no `React.memo` (`WorkspacePage.tsx:58-72`);
    `react-markdown` re-parses the whole growing string on every chunk.
  - `MessageView` not memoized (`WorkspacePage.tsx:151-246`).
  - `messagesEndRef.scrollIntoView({ behavior: "smooth" })` runs on every
    `state.messages` change (`WorkspacePage.tsx:786`).
  - `use-proteus.ts:111-117` polls 5 RPCs/s during streaming.
  - Index-based keys for `message.parts.map` (`WorkspacePage.tsx:216, 219, 226`).
- **Symptom:** "Streaming takes a long time."
- **Fix:** `experimental_throttle: 50`, memo `MarkdownContent`/`MessageView`,
  fix scroll behavior, pause side-poll during stream, stable part keys.
  *(Phase 2 — non-blocking.)*

---

## §B — Sandbox reliability

### B1 (H) — Container hibernation + cold-start race
- **Evidence:** SDK default `sleepAfter = "10m"`
  (`@cloudflare/sandbox/dist/file-stream-Bn2PceyF.js:3821`). Proteus never
  overrides it (`packages/cf-backend/src/runtime.ts:119-123` passes only
  `{ normalizeId: true }`). After 10 min idle the container stops; first
  request triggers a cold start with up to 120s budget.
- **Symptom:** Visible as "Network connection lost" during the cold-start
  window.
- **Fix (deferred Phase 2):** Pass `{ sleepAfter: "30m", keepAlive: true }`
  and add a warm-ping fiber. The Phase 1 retry wrapper (B2/B3) already covers
  the user-facing impact transparently.

### B2 (H) — Mid-request 500 from `tcpPort.fetch` is NOT retried by SDK
- **Evidence:** `@cloudflare/containers/dist/lib/container.js:947-948` catches
  `"Network connection lost."` mid-request and converts to **HTTP 500** with
  body `"Container suddenly disconnected, try again"`. `BaseTransport.fetch`
  only retries 503s
  (`@cloudflare/sandbox/dist/file-stream-Bn2PceyF.js:752-771`).
- **Symptom:** "Network connection lost" surfaces to the agent as
  `exec error: HTTP error! status: 500`.
- **Fix:** Wrap each `handle.*(...)` call in
  `packages/core/src/execution/sandbox.ts` with a retry helper. Up to 2
  retries, 500ms × 2^attempt backoff, when the lower-cased error contains:
  `network connection lost`, `container suddenly disconnected`,
  `container is starting`, or `no container instance`.

### B3 (H) — DO-to-DO RPC drop bypasses SDK retry entirely
- **Evidence:** `runtime.ts:119-123` builds a `getSandbox` proxy; every method
  call is a cross-DO RPC (Orchestrator DO → Sandbox DO). The Sandbox DO is
  *not* kept warm by chat traffic — it hibernates independently. RPC failures
  during eviction throw `"Network connection lost."` *before* any SDK code
  runs.
- **Symptom:** Same as B2.
- **Fix:** Same retry wrapper; substring matcher catches DO-RPC failures too.

### B4 (H) — Errors in `executeInExecutor` don't broadcast → terminal silently shows nothing
- **Evidence:** `packages/cf-backend/src/orchestrator.ts:925-944`. Success
  branch broadcasts `executor-output` (`:933-936`). Error branch only writes a
  SQL row and returns (`:939-944`). UI's terminal renders only from the
  broadcast (`use-proteus.ts:391-400`); the RPC return value is discarded
  (`WorkspacePage.tsx:699`, `components/ExecutorTerminal.tsx:86-89`).
- **Symptom:** User types a command, sees blank prompt, can't tell if it ran.
- **Fix:** In the catch block, broadcast `executor-output` with
  `{stderr: errMsg, exitCode: 1}` symmetric with the success branch.

### B5 (M) — Container image / SDK version skew
- **Evidence:** `wrangler.jsonc:43` pins `cloudflare/sandbox:0.8.10`; SDK is
  `0.8.11` (`file-stream-Bn2PceyF.js:3705`). 0.8.11 ships transient-error
  detection improvements not present in 0.8.10.
- **Fix:** Bump container image to `0.8.11`.

---

## §C — Preview UX gaps

### C1 (H) — System prompt never tells the LLM that exposePort is mandatory for previews
- **Evidence:** `packages/core/src/prompt.ts:55-89` (`buildSystemPromptSync`)
  has only a 1-line sandbox bullet (`:33-34`): `**sandbox.*** — Linux VM over
  Container`. Default soul (`orchestrator.ts:757`) is also silent.
- **Symptom:** "Build a hello world app" → can't preview anything (the LLM
  doesn't know to call `exposePort`).
- **Fix:** Append to `renderExecutorSection` whenever sandbox is registered:
  > For the user to *see* a running web app, you MUST call
  > `sandbox.exposePort(port)` after starting the server. The returned URL
  > renders as a live iframe in the user's Executors tab.

### C2 (H) — `execute_tools` description doesn't mention sandbox or preview
- **Evidence:** `packages/core/src/tools/registry.ts:48-51` covers `workspace.*`
  and `codemode.*` but never `sandbox.*` or the preview workflow.
- **Fix:** Update description to mention `sandbox.*` and the
  dev-server-then-exposePort idiom.

### C3 (M) — Codemode `types` namespace doesn't promote the workflow
- **Evidence:** `packages/core/src/execution/sandbox.ts:288-304` lists
  `exposePort` alongside `exec`, `readFile`, no priority.
- **Fix (Phase 2):** Add a JSDoc on the `sandbox` namespace block showing the
  canonical "background dev-server + exposePort" pattern.

### C4 (H) — Default tab is Identity; pinned-port iframes only render under Executors
- **Evidence:** `WorkspacePage.tsx:778` (`useState<Tab>("Identity")`);
  pinned-ports rendered inside the `ExecutorsTab` subtree
  (`WorkspacePage.tsx:664-683, :1005-1014`); the `getExposedPorts` poll only
  mounts when that tab is open (`:545-561`).
- **Symptom:** Even when `exposePort` is called, the user sees nothing until
  they manually click Executors.
- **Fix:**
  1. Hoist `getExposedPorts` polling into `useProteus`.
  2. Show a count badge on the Executors tab when ports > 0.
  3. Inline preview card under any assistant message whose tool result
     contains a `/_preview/` URL.

### C5 (M) — No auto-expose-on-listen
- **Evidence:** SDK exposes `proc.waitForPort` but requires a known port. No
  event for "any port started listening".
- **Fix (Phase 2):** Add a built-in `sandbox.runDevServer(cmd, { hint?: number })`
  that races `waitForPort` against `[3000, 3001, 5173, 8000, 8080, 4000, 8787]`
  and auto-exposes on first hit.

---

## §D — UI rendering glitches

### D1 (H) — Auto-scroll fights the user
- **Evidence:** `WorkspacePage.tsx:786` runs `scrollIntoView({ behavior:
  "smooth" })` on every `state.messages` change. During streaming this cancels
  and re-queues the smooth-scroll continuously and yanks the user back to
  bottom every time they try to scroll up.
- **Fix (Phase 2):** Track `userIsAtBottom`; only auto-scroll when at bottom.
  `behavior: "auto"` during stream.

### D2 (C) — No ErrorBoundary anywhere
- **Evidence:** Grep across `cf-backend/src` returns 0 hits for
  `ErrorBoundary`. A single render-time throw whitescreens the app.
- **Fix:** Wrap each top-level tab in `<ErrorBoundary fallback={...}>`.

### D3 (H) — Multiple `useProteus` mounts → multiple WS connections + stacked polling
- **Evidence:** `useProteus(agentId)` mounts on `WorkspacePage`,
  `SettingsPage`, `MCTSExplorer`. Each opens its own `useAgent` socket and
  runs the 1s/5s polling intervals. Settings only needs `agentStatus` but
  creates the full chat hook.
- **Fix (Phase 2):** Hoist `useProteus` to a route-level context provider so
  the three pages share one connection + one poll loop.

### D4 (H) — `addLog` infinite re-fires + 5s server-poll wipes client logs
- **Evidence:**
  - `use-proteus.ts:198-214` log-tool-call effect runs on every `messages`
    change with no idempotency for `output-available`/`output-error`. Log list
    grows by N per token.
  - `use-proteus.ts:186-191` server poll wipes every non-connection client log
    each 5s tick: `setLogs(prev => { const clientOnly = prev.filter(l => l.type === "connection"); ... })`.
- **Fix:** Track per-tool-call lifecycle in a Map keyed on `toolCallId`; tag
  client-origin entries and preserve them across server polls.

### D5 (H) — Reaching into private `_ws`
- Same root cause as A3. Listed here for UI completeness.

### D6 (M) — `initialPrompt` setTimeout never cleared on unmount
- **Evidence:** `WorkspacePage.tsx:788-795` — `setTimeout(() =>
  state.sendChat(...), 300)` with no cleanup. If user navigates away in the
  300ms window, the timer fires against a stale closure.
- **Fix:** Capture timer in a ref, `clearTimeout` in cleanup.

### D7 (M) — Index-keyed message parts cause flicker on reorder
- **Evidence:** `WorkspacePage.tsx:216, 219, 226` use `key={i}` for
  text/reasoning parts. The `StreamAccumulator` can insert parts mid-stream,
  causing React to reconcile the wrong DOM nodes.
- **Fix:** `key={part.toolCallId ?? \`${message.id}:${i}:${part.type}\`}`.

### D8 (H) — Provider-truncated tool payloads → forever-thinking dots
- **Evidence:** `@cloudflare/ai-chat/dist/index.js:1437-1444, 1519-1554`
  silently rewrites tool payloads >1.8MB. `WorkspacePage.tsx:186-190`
  `hasContent` doesn't account for `metadata.compactedToolOutputs` /
  `compactedTextParts`, so a truncated message renders as typing dots forever.
- **Fix (Phase 2):** Update `hasContent` to also return true on non-empty
  `metadata.compactedToolOutputs` or `compactedTextParts`.

### D9 (M) — Initial-message cache never invalidates
- **Evidence:** `@cloudflare/ai-chat/dist/react.js:464` — module-level
  `requestCache` keyed on URL, no TTL. Cleared only on unmount. Cross-tab
  edits or forks leave the second tab stale.
- **Fix (Phase 2):** Pass `getInitialMessages: null` after first mount, or
  invalidate on `cf_agent_chat_clear`.

### D10 (M) — Fork-mirror INSERT races with `cf_agent_chat_clear`
- **Evidence:** `orchestrator.ts:587-605` writes a fork mirror INSERT inside
  `onChatResponse`. A concurrent `cf_agent_chat_clear` deletes
  `cf_ai_chat_agent_messages` but not the fork-mirror table.
- **Fix (Phase 2):** Move mirror writes into a Think hook that serializes
  with the turn-queue lock.

---

## §E — Implementation plan

### Phase 1 (THIS PASS) — atomic commits per group, with empirical verification

**Group 1 — WS resilience (A1+A2+A3+A4):**
- Files: `WorkspacePage.tsx`, `use-proteus.ts`
- Disconnect overlay banner instead of unmounting (A1)
- Recover from `"error"` connectionStatus on `onOpen` (A1)
- `agent.addEventListener("open")` → `chatRef.current.resumeStream()` on each
  reconnect (A2)
- Listen on stable `agent` EventTarget, not private `_ws` (A3, D5)
- 25s heartbeat ping (A4)
- Empirical test: Puppeteer drops WS mid-stream, expects banner + chat panel
  retained + tokens emitted during gap to surface after reconnect.

**Group 2 — Sandbox retry (B2+B3+B4+B5):**
- Files: `packages/core/src/execution/sandbox.ts`, `orchestrator.ts`,
  `wrangler.jsonc`
- Retry wrapper on transient markers (B2, B3)
- Broadcast `executor-output` on error path (B4)
- Bump container image `0.8.10 → 0.8.11` (B5)
- Empirical test: Express E2E + force a transient error, expect retry success
  and visible terminal output on failure.

**Group 3 — Preview discoverability (C1+C2+C4):**
- Files: `prompt.ts`, `tools/registry.ts`, `WorkspacePage.tsx`,
  `use-proteus.ts`
- Prompt addition for sandbox preview workflow (C1)
- `execute_tools` description update (C2)
- Hoist `getExposedPorts` polling, badge on Executors tab, inline preview
  card under tool result (C4)
- Empirical test: chat prompt "Build a hello world Express + show me", expect
  agent to call `exposePort` and a preview card / badge to appear.

**Group 4 — ErrorBoundary (D2):**
- Files: new `components/ErrorBoundary.tsx`, `WorkspacePage.tsx`
- Wrap each top-level tab. Fallback shows the error + "Reload tab" button.
- Empirical test: forced render-time throw inside one tab does not whitescreen
  the others.

### Phase 2 (deferred, tracked here)
- A5 throughput: throttle + memo + scroll fix + stable part keys
- B1 keepAlive + warm-ping fiber
- C3 codemode types JSDoc
- C5 `runDevServer` crafted tool with port heuristic
- D1 scroll behavior (only-when-at-bottom)
- D3 hoist `useProteus` to route context
- D8 `hasContent` for compacted parts
- D9 initial-message cache invalidation
- D10 fork-mirror serialization

---

## §F — Open questions

1. **A2 framework upgrade vs local hack.** Cleanest fix is upstream in
   `@cloudflare/ai-chat` (move resume effect to depend on connection
   lifecycle). Phase 1 ships a local workaround (~15 LOC) that reaches into
   chat internals. Worth filing upstream issue?
2. **C5 `runDevServer` heuristic port list.** Acceptable default
   `[3000, 3001, 5173, 8000, 8080, 4000, 8787]`. Should this be configurable
   per-agent (soul setting)?
3. **B1 `keepAlive` cost.** Setting `keepAlive: true` keeps the container hot
   indefinitely. Cost is real. Better: pulse a warm-ping every 8 min while a
   chat session is active. Phase 2.
4. **D3 route context.** Hoisting `useProteus` is a meaningful refactor. If
   users only ever open one page at a time, the multi-mount cost is moot.
   Defer to Phase 2.
5. **C4 auto-switch tab vs badge-only.** Auto-switching to Executors when a
   port appears is the most discoverable UX but interrupts conversation flow.
   Phase 1 ships badge + inline preview card; auto-switch deferred pending
   user feedback.
6. **A4 heartbeat interval.** 25s vs Cloudflare's documented 100s reap.
   Defensive choice; tunable if it shows up in metrics.

---

## Verification expectations (Phase 1)

- Live site 200 throughout.
- 102+ core tests pass.
- 0 Seal references in source/docs.
- 41+ `@callable` RPCs preserved.
- Express E2E (`scripts/phase-express-e2e.ts`) still green.
- 4 new Puppeteer tests in `docs/screenshots/stability-phase1/`:
  1. WS drop mid-stream → chat panel stays + banner shows + stream resumes.
  2. Idle 110s → connection still alive.
  3. Cold-start exec → no visible failure (broadcast on error path).
  4. "Build hello world Express + show me running app" → preview card / badge
     appears, iframe loads "Hello World".
