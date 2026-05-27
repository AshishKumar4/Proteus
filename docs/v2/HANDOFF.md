# Proteus v2 — Handoff (post-cleanup)

**When you're back.** Here's what landed, what to deploy, what to test, what's queued.

## What landed

All on branch `worktree-proteus-v2-runtime`. The v2 sprint shipped 11 feature commits, then a 4-pass cleanup removed ~4000 lines of parallel-system slop. Final state below.

```
252566b  feat(safety):   wire approval gate into the `run` builtin tool
de637ef  fix(scaffold):  modifyScaffold + maybeEvolveScaffold + dead-code (pass 3)
0863a69  refactor:       consolidate (memory-note helper, hybrid search, dead container.ts) — pass 2
3d2cfb2  refactor:       remove parallel systems (sandbox/, HeadAgent, ReviewAgent, compaction) — pass 1
712560d  feat(craft):    SKILL.md export/import
5e7565b  feat(heads):    recursive head splitting — split_subheads tool
96d7482  docs(v2):       HANDOFF.md
a325832  feat(memory):   Vectorize semantic memory + RRF hybrid search
95fcf12  feat(deploy):   /api/v2/health + scripts/deploy-v2.sh
cc9d270  docs(v2):       V2-ARCHITECTURE.md + e2e integration test
977cf53  feat(review):   (REMOVED in pass 1 — was a duplicate of EvolutionEngine)
fde6056  feat(mcp):      Proteus as MCP server
6018246  feat(events):   durable run-event log + SSE with Last-Event-ID
694d6d7  feat(core):     compaction + approval gate + fiber recovery
3cb88aa  feat(scaffold): scaffold execution + shadow-mode rollout
771f5e8  feat(heads):    branching heads — parallel reasoning + LLM merge
78cc9e9  feat(sandbox):  (REMOVED in pass 1 — was a parallel system to ExecutorProvider)
e38bc9c  chore(v2):      worktree setup + plan + research notes + CI
```

Tests: **204/204 core unit tests pass**. Type-check clean. Vite build clean.

## What's actually in the runtime now

### Three pillars (from your original brief)

1. **Branching heads** — `split_heads({rationale, heads:[...]})` LLM tool. Each head shares the whole conversation context, has its own ephemeral SqliteFS + virtual-bash scratch, can recursively spawn child heads under a depth budget (`split_subheads`), and all heads merge via LLM synthesis with a Zod-validated structured-output schema. Heads run as a *mode* of the existing `ExplorationAgent` Facet — no separate `HeadAgent` class.

2. **Pluggable executors** — the *existing* `ExecutorProvider` + `ExecutionRouter` system was already the right shape. The `SandboxApi` I'd built was a duplicate — removed in pass 1. The only genuinely-new behavior (Nimbus WebSocket protocol) was folded into `execution/nimbus.ts`. Today's executors:
   - `createInlineExecutor` (workspace.* — SqliteFS + virtual-bash, always available)
   - `createSandboxExecutor` (sandbox.* — `@cloudflare/sandbox` container with port preview)
   - `createNimbusExecutor` (nimbus.* — WebSocket client to github.com/AshishKumar4/Nimbus, sentinel-wrapped exec + fs-* RPC + JWT auth)
   - `createSSHTunnelExecutor` (laptop.* — reverse-WebSocket tunnel to your machine via `packages/pc-agent/`)

3. **Scaffold loop closure** — `runScaffold` executes the agent's mutable `scaffold/agent.js` via codemode with three host bridges (`host.emit`, `host.callTool`, `host.llmStream`). Shadow-mode rollout: `modifyScaffold` now correctly writes new versions with `status='pending'` (bug fixed in pass 3); `maybeEvolveScaffold` skips proposals when a pending is in flight (also pass 3); `applyScaffoldDecision('auto'|'promote'|'rollback')` flips statuses + restores prior code on rollback.

### Platform layer

4. **Durable run-event log** — `RunEvent` discriminated union (15 types: run_start, turn_start, text_delta, tool_call_*, step_finish, head_split, head_merge, scaffold_promotion, scaffold_rollback, memory_write, fiber_recovered, error, turn_end, run_end). Persisted in `run_events`. Emit points wired across the chat lifecycle. `GET /api/agents/<name>/runs/<id>/stream` for SSE with `Last-Event-ID` resume; `GET .../events` for paginated query.

5. **Proteus as MCP server** — `POST/GET/DELETE /mcp/v1/<agentName>`. Tools exposed: `search_memory` (auto-hybrid), `save_note`, `list_skills`, `run_scaffold_once`, `get_shadow_status`, `list_runs`, `list_run_events`. Resource: `proteus://agent/<name>/memory`. External clients (Cursor, Claude Code, browser AI) can drive Proteus as a tool provider.

6. **Vectorize semantic memory + RRF hybrid search** — opt-in via `wrangler vectorize create proteus-memory --dimensions=384 --metric=cosine` + uncomment bindings in wrangler.jsonc. When wired, `search_memory` (builtin tool + MCP) auto-uses hybrid FTS5 + Vectorize via Reciprocal Rank Fusion. Falls back gracefully to FTS5-only.

7. **Approval gate** — wired into the `run` builtin tool. Regex-based pre-flight: deny (rm-rf-root, fork-bomb, dd-overwrite-disk, mkfs-physical-disk, curl|sh, wget|bash, cloud-metadata SSRF), gate (sudo, chmod-setuid, rm-recursive, git force-push, ...), warn (env-dump, secret-file-read), allow (everything else).

8. **Background-review** — folded back into `EvolutionEngine.onTurnCompleteAsync` (which already did Hermes-style reflection: quality assess → `### Lesson` to MEMORY.md → pattern extract → upsertCraftedTool → maybeEvolveScaffold). The ReviewAgent Facet I built was a duplicate; removed.

9. **Compaction** — Think Session's built-in `.compactAfter(96_000)` wired into `configureSession()`. My parallel compaction module was duplicate; removed.

10. **Fiber recovery hook** — `onFiberRecovered` on OrchestratorAgent logs + writes a MEMORY note when a fiber (MCTS, etc.) was interrupted by DO eviction and recovered.

11. **SKILL.md export/import** — `craftedToolToSkillMd` / `parseSkillMd` / `exportAllSkillsToVfs` / `importSkillsFromVfs`. Crafted tools can be exported as human-readable .md files with YAML frontmatter (Hermes format), edited, committed to a repo, and reimported.

## How to deploy

```bash
cd /home/mrwhite0racle/Proteus/.claude/worktrees/proteus-v2-runtime

# 1) Auth — either:
wrangler login                                        # interactive
# OR:
export CLOUDFLARE_API_TOKEN=<token>

# 2) Deploy via the script (install + test + build + deploy + health probe):
./scripts/deploy-v2.sh

# 3) Confirm:
curl https://proteus.ashishkumarsingh.com/api/v2/health | jq .
```

### Optional: enable Vectorize

```bash
cd packages/cf-backend
npx wrangler vectorize create proteus-memory --dimensions=384 --metric=cosine
# Uncomment in wrangler.jsonc:
#   "ai": { "binding": "AI" }
#   "vectorize": [{ "binding": "MEMORY_VECTORS", "index_name": "proteus-memory" }]
npx wrangler deploy
```

## How to test (once deployed)

### Branching heads
> "Use split_heads to explore three angles on integrating Stripe Checkout
> into this app: (1) the standard hosted flow, (2) an embedded element
> approach, (3) edge-case auth flows. Merge with the synthesize strategy."

The agent should fire `split_heads`. You'll see 3 `head_split` events in the SSE stream, then 3 head `runAsHead` calls (each spawning an `ExplorationAgent` Facet in head mode), then a `head_merge` event with the synthesized narrative.

### MCP server
```json
{
  "mcpServers": {
    "proteus": { "url": "https://proteus.ashishkumarsingh.com/mcp/v1/my-agent-name" }
  }
}
```
External client sees 7 tools + 1 resource.

### SSE event stream
```bash
curl https://proteus.ashishkumarsingh.com/api/agents/<name>/runs | jq .
curl -N https://proteus.ashishkumarsingh.com/api/agents/<name>/runs/<runId>/stream
```

### Scaffold rollout
```
agent.getShadowStatus()         # pending version + trial counts + decision
agent.runScaffoldOnce("hello")  # fire current scaffold once
agent.runScaffoldOnce("hello", { useShadowOverride: true })  # fire pending shadow
agent.applyScaffoldDecision('auto')  # consult decidePromotion + act
```

## What's NOT in v2 (queued for v2.x)

- **Scaffold takeover of `onChatMessage`** — scaffold execution is RPC-driven today. Replacing Think's `streamText()` with scaffold-driven inference for the user-facing turn requires deeper Think internals work + a robust feature gate. Deferred.
- **Auto-judge shadow evaluation** — running BOTH current + pending per turn and recording per-turn judge scores would double LLM cost. Currently shadow evals are recorded by manual `runScaffoldOnce` calls; auto-judge needs sampling logic to keep cost bounded.
- **UI panels for v2 RPCs** — React UI doesn't yet expose split_heads tree visualization, scaffold shadow status, or run-event browser. The RPCs exist; UI consumption is pending.
- **Approval-channel UX** — `gate` decisions reject until the cf_agent_tool_approval message channel is wired through Think.
- **Codebase-wide Valibot migration** — schemas use Zod throughout; switching to Valibot is ergonomic-only, low-priority.

## File pointers

- `docs/v2/IMPLEMENTATION_PLAN.md` — original plan (historical, kept as-is)
- `docs/v2/V2-ARCHITECTURE.md` — pre-cleanup architecture doc (replaced by this file's "What's in the runtime" section)
- `docs/v2/RESEARCH_NOTES.md` — Cloudflare Agents SDK / Think / Flue / Nimbus API references
- `packages/core/tests/integration-v2-end-to-end.test.ts` — 6-pillar smoke test
- `bun test --cwd packages/core` — full unit suite (204/204)

Welcome back. The runtime is real, and it's no longer carrying parallel systems.
