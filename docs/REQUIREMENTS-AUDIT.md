# Proteus — Requirements Audit

Tracks every user request from this conversation with current status, commit SHAs, and evidence. Last updated 2026-04-24 (post-E2E green).

Legend: ✅ shipped · ⚠️ partial · ❌ missing · 🔜 deferred

---

## 1. Root-cause same-turn `codemode.double(7)` failure
**Status:** ✅ Shipped. Fix: `2641c96` — live crafted tool registry mutates `providers.fns` on each `workspace.createTool` call. Evidence: `docs/CRAFT-ARCHITECTURE.md`.

## 2. Make the environment more capable (not force agent to accept limits)
**Status:** ✅ Shipped. Fix: `734af72` — preamble pattern. Tool bodies ambiently access `workspace.*`, `codemode.*`, `fetch`, `crypto`, `Date`, console. −130 LOC.

## 3. Structured error propagation from tool execution
**Status:** ✅ Shipped. Fix: `734af72` — `wrapProvidersWithStructuredErrors` returns `{error, stack, toolName, providerName}`.

## 4. Tools dynamically available same step + next turn
**Status:** ✅ Shipped. Live registry covers same-turn. E2E harness in `scripts/phase-express-e2e.ts` proves craft+invoke in same turn.

## 5. Compare with reference implementation; adopt the best ideas
**Status:** ✅ Shipped. Artifact: `docs/CRAFT-ARCHITECTURE.md`.

## 6. Push everything to GitHub + deploy to production
**Status:** ✅ Shipped. origin/main up to date; live at https://proteus.ashishkumarsingh.com (200).

## 7. Switch default model to Kimi K2.6
**Status:** ✅ Shipped. Fix: `4b5b125` — all source files, UI selector, settings default updated.

## 8. Replace dummy workspace executor with real exec
**Status:** ✅ Shipped via Cloudflare Sandbox SDK. Fixes: `118eb30`, `30ced92`, `7fce04f`. `ProteusSandbox extends Sandbox<Env>` DO + container binding + migration v2. Inline executor retained for internal-only scratch state.

## 9. Nimbus integration
**Status:** 🔜 Deferred per user decision on 2026-04-24T04:38. Sandbox SDK chosen instead. Design preserved in `docs/EXECUTOR-V2.md` for possible revival.

## 10. Executor UI redesign (per-executor tabs, terminal, file manager, preview iframes)
**Status:** ✅ Shipped. Fix: `f0032b7`. Components: `ExecutorPane`, `ExecutorTerminal` (xterm.js), `ExecutorFileTree`, `ExecutorPreviews` (4s polling + pinnable iframes).

## 11. Remove "workspace" from user-facing executor list
**Status:** ✅ Shipped. Evidence: `packages/cf-backend/src/runtime.ts` — sandbox is default, inline is internal.

## 12. Remote PC access via curl one-liner
**Status:** ✅ Shipped. Fixes: `118eb30`, `30ced92`. Daemon at `packages/pc-agent/` (~200 LOC), WebSocket tunnel at `packages/cf-backend/src/pc-handler.ts`, `@callable issuePcToken()`, "Generate install command" button in Your PC tab.

## 13. Unified deploy script for Proteus (+ Nimbus if present)
**Status:** ✅ Shipped. Fix: `9a66b6a` — `scripts/deploy.sh` with `NIMBUS_PATH`, `SKIP_NIMBUS=1`, idempotent.

## 14. Upgrade @cloudflare/think to latest
**Status:** ✅ Shipped. Merged via `feat/think-upgrade-and-forking` (squashed). `0.2.4 → 0.4.0`, agents `0.11.0 → 0.11.5`. 102 tests pass (+16 new).

## 15. Replace custom code with Think helpers where possible (preserving differentiators)
**Status:** ✅ Shipped. Catalog in `docs/THINK-UPGRADE-AND-FORKING.md`. Preserved: SqliteFS, crafted tool registry, CraftStore, EvolutionEngine, MCTS.

## 16. Agent forking from any chat point
**Status:** ✅ Shipped. Fork lineage schema, `forkAgent`/`rawCopyFromFork`/`getForkLineage` RPCs, UI fork menu, lineage chip.

## 17. No regressions during Think upgrade
**Status:** ✅ Verified. 102 tests pass, 34 RPCs preserved (+7 new), 0 Seal refs, live site 200 throughout.

## 18. Agent fork works end-to-end empirically
**Status:** ✅ Shipped after fixing 2 bugs surfaced by Puppeteer: assistant_messages table copy (`f349496`) and fork-marker UI mirror (`8c2ae7f`). 41/41 green checks.

## 19. Agent can build and preview apps end-to-end
**Status:** ✅ Shipped.
**Evidence (2026-04-24 13:04 E2E on live deployment \`71eeb959\`):**
- Write \`/workspace/server.js\` ✅
- \`npm install express\` ✅
- \`node server.js\` bound port 8080 ✅
- \`exposePort(8080)\` → \`https://proteus.ashishkumarsingh.com/_preview/8080/proteus-express-e2e-.../p8080_.../\` ✅
- \`getExposedPorts()\` returned in 3s (was [] for 210s pre-fix) ✅
- Fetching preview URL returned "Hello World from Proteus Sandbox" ✅
- UI iframe rendered the URL ✅
- Transcript: \`docs/screenshots/e2e-express-app/transcript.txt\`

## G1 — \`getExposedPorts\` returns \`[]\` — CLOSED 2026-04-24
**Fix in commit \`a6e254f\`:** \`packages/core/src/execution/sandbox.ts\` \`listPorts\` tool calls \`handle.getExposedPorts(hostname)\` and remaps SDK URLs into path-style. Orchestrator \`getExposedPorts\` RPC forwards the provider output.

## G2 — \`exposePort\` URL rewrite — CLOSED 2026-04-24
**Fix in commit \`a6e254f\`:** \`exposePort\` tool generates a stable token, calls SDK with it, and returns \`buildPathPreviewUrl(hostname, port, sandboxId, token)\`. \`preview-proxy.ts\` on incoming side validates + forwards.

## G3 — Full build+preview E2E green — CLOSED 2026-04-24
Full transcript + iframe screenshot in \`docs/screenshots/e2e-express-app/\`.

---

## Stability Phase 1 — 18-bug audit + 4 atomic fixes — CODE COMPLETE 2026-04-27

User-reported real-usage bugs the programmatic E2E missed:
1. UI rendering / streaming bugs
2. Agent's turn disappears from screen on WS drops
3. Agent messages don't appear at all sometimes
4. Streaming takes a long time
5. Sandbox: "Network connection lost" intermittently
6. "Build a hello world app" → can't preview anything

### Audit
\`docs/STABILITY-AUDIT.md\` (commit \`947c256\`) — 18 bugs across §A streaming/WS,
§B sandbox reliability, §C preview UX, §D UI rendering. Every claim cites
file:line. Phase 1 (this pass) covers §A1-A4, §B2-B5, §C1+C2+C4, §D2.
Phase 2 deferred items listed in §E.

### Phase 1 commits

| Commit | Subject | Closes |
|---|---|---|
| \`947c256\` | docs(stability): forensic audit — 18 bugs across WS/sandbox/preview/UI | (audit) |
| \`c31f3b1\` | fix(ws): non-destructive disconnect UI + reconnect resume + heartbeat + outer EventTarget | §A1, §A2, §A3, §A4, §C4 (UI hoist + badge + inline preview card), §D5 |
| \`88bc5b5\` | fix(sandbox): retry transient errors + broadcast failures + image bump | §B2, §B3, §B4, §B5 |
| \`403319b\` | feat(prompt): teach LLM the sandbox + exposePort preview workflow | §C1, §C2 |
| \`59e26d3\` | fix(ui): per-tab + chat ErrorBoundary contains render-time throws | §D2 |
| \`(this)\` | test(stability): Phase 1 4-test E2E suite + Express E2E re-run | (verification) |

### Verification status
- ✅ Tests: 102 pass / 3 skip / 0 fail
- ✅ Vite build succeeds (new bundle hash \`index-CURdKZXl\`)
- ✅ Express E2E (regression check) GREEN — \`/_preview/\` URL still
  serves "Hello World from Proteus Sandbox"
- ✅ 4 Puppeteer tests PASSED (transcript:
  \`docs/screenshots/stability-phase1/transcript.txt\`):
  - T1 chat panel survived WS drop
  - T2 110s idle WS still open
  - T3 cold-start exec succeeded in 1728ms
  - T4 build+show iframe rendered with body "Hello World from Proteus Sandbox"
- ⚠️ **Deployment gap:** wrangler OAuth expired during this pass. The
  Phase 1 commits are in main but the live site (bundle
  \`index-D3YTqtNR\`) is still on the pre-Phase-1 build. Tests passed on
  STALE code; re-running them after deploy will exercise the actual new
  paths (heartbeat, banner overlay, ErrorBoundary, retry wrapper).
  User action required: \`wrangler login\` (or set
  \`CLOUDFLARE_API_TOKEN\`) and re-run \`bash scripts/deploy.sh\`.
  Honest caveat documented in
  \`docs/screenshots/stability-phase1/transcript.txt\`.

### Phase 2 deferred (tracked in STABILITY-AUDIT.md §E)
- §A5 streaming throughput: throttle + memo + scroll fix + stable part keys
- §B1 keepAlive + warm-ping fiber
- §C3 codemode types JSDoc
- §C5 \`runDevServer\` crafted tool
- §D1 scroll behavior
- §D3 hoist \`useProteus\` to route context
- §D4 log idempotency + preserve client logs across server polls
- §D6 \`initialPrompt\` setTimeout cleanup
- §D7 stable part keys
- §D8 \`hasContent\` for compacted parts
- §D9 initial-message cache invalidation
- §D10 fork-mirror serialization

### Constraint check
- 0 Seal references in source/docs ✅
- 102+ tests pass ✅
- 41 \`@callable\` RPCs preserved (≥34 baseline) ✅
- Live site 200 ✅

