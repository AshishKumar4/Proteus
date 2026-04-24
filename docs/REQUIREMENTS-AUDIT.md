# Proteus — Requirements Audit

Tracks every user request from this conversation with current status, commit SHAs, and evidence. Last updated 2026-04-24.

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
**Status:** ⚠️ Partial. Build flow works; preview URL wiring has 2 remaining gaps.
- ✅ Write file, `npm install express`, `node server.js`, in-container curl all succeed
- ✅ `exposePort(8080)` returns a URL  
- ❌ `getExposedPorts()` returns `[]` (see G1 below)
- ❌ `exposePort` URL still subdomain-shaped (see G2)

## 20. Zero Seal references in source/docs
**Status:** ✅ Verified. `grep -rni 'seal' packages/ docs/` → 0.

---

## Open gaps (staged for immediate next pass)

### G1 — `getExposedPorts` returns `[]` despite successful `exposePort`
**Severity:** High — blocks preview iframe auto-populate.
**Root cause:** Orchestrator RPC reads from agent-DO-local `tools.listPorts`, not sandbox DO.
**Fix plan:** `getExposedPorts` calls `getSandbox(env.SANDBOX, agentId).listPorts()` directly.

### G2 — `exposePort` URL rewrite to `/_preview/…` not applied
**Severity:** High — preview iframes won't load until rewritten.
**Fix plan:** Override `exposePort` in `ProteusSandbox` to return `https://proteus.ashishkumarsingh.com/_preview/<port>/<sandboxId>/<token>/`. Proxy handler (`preview-proxy.ts`) already wired in `server.ts`.

### G3 — Full "build + preview" Puppeteer E2E green
**Severity:** Medium (evidence bar).
**Fix plan:** After G1+G2, re-run `scripts/phase-express-e2e.ts`, expect all green + iframe HTTP 200 + screenshot.

---

## Deployment trail (most recent first)
- `a6e254f` feat(preview): path-based proxy /_preview/<port>/<sandbox>/<token>/* + E2E harness
- `f0032b7` feat(exec): port auto-refresh + xterm terminal + PC install-command UI
- `8c2ae7f` feat(F2): mirror fork-marker into assistant_messages
- `f349496` fix(F2): copy Think's assistant_messages table on fork
- `ae5720b` fix(F2): unify sql binding via boundSql
- `bdae3d1` fix(F2): bind this.sql before passing to forkAgentStorage
- Active deployment: `8870b589-74a8-447b-813a-ff80479c89f5` @ 2026-04-24T12:57:32Z

## Tests
- Core: 102 pass / 3 skip / 0 fail / 326 expect()
- cf-backend: passing
- 0 Seal references

## Hosting
- Live: https://proteus.ashishkumarsingh.com (200)
- Account: `f44999d1ddda7012e9a87729eba250f1`
- Wrangler OAuth active

