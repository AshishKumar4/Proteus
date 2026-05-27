# Proteus v2 — Handoff

**When you're back.** Here's what landed, what to deploy, what to test, and what's queued for next.

## What landed (10 milestones, ~10000 lines)

All on branch `worktree-proteus-v2-runtime`. Each milestone is a single logical commit.

```
a325832  feat(memory): Vectorize semantic memory + RRF hybrid search
cc9d270  docs(v2): V2-ARCHITECTURE.md + end-to-end integration test
95fcf12  feat(deploy): /api/v2/health endpoint + scripts/deploy-v2.sh
977cf53  feat(review): Hermes-style background-review fork as Facet
fde6056  feat(mcp): Proteus as MCP server — distribution play
6018246  feat(events): durable run-event log + SSE streaming
694d6d7  feat(core): compaction, approval gate, fiber recovery hook
3cb88aa  feat(scaffold): close the loop — scaffold execution + shadow rollout
771f5e8  feat(heads): branching heads — parallel reasoning streams w/ LLM merge
78cc9e9  feat(sandbox): unified SandboxApi + 4 implementations + registry + adapter
e38bc9c  chore(v2): worktree setup — plan, research notes, baseline cleanup, CI
```

Tests: **218/218 unit tests pass.** Type-check clean. Vite build succeeds.

The three pillars from your brief are all live:

1. **Branching heads** — a working LLM-callable `split_heads({ rationale, heads: [...] })` primitive. Heads share full conversation context, accumulate ephemeral interim state, recursively split with depth budgets, merge back via Zod-validated LLM synthesis. Distinct from sub-agents and MCTS branches. See `docs/v2/V2-ARCHITECTURE.md §2`.

2. **Pluggable sandbox abstraction** — unified `SandboxApi` contract. Four implementations:
   - `VirtualSandbox` (SqliteFS + virtual bash, always-on)
   - `CloudflareSandbox` (@cloudflare/sandbox container)
   - `NimbusSandbox` (WebSocket client for github.com/AshishKumar4/Nimbus)
   - `SSHSandbox` (your laptop/Mac/RPi via the existing pc-agent reverse-WebSocket tunnel)
   Adding a 5th is one file under `packages/core/src/sandbox/impls/`. See `docs/v2/V2-ARCHITECTURE.md §1`.

3. **Scaffold loop closure** — `runScaffold` executes the agent's mutable `scaffold/agent.js` through the codemode sandbox with host bridges for LLM streaming, tool dispatch, and event emission. Shadow-mode rollout runs the pending version alongside the current for N turns, judges, auto-promotes or rolls back. RPC-driven; the automatic `onChatMessage` takeover is a v2.1 follow-up. See `docs/v2/V2-ARCHITECTURE.md §3`.

Plus a substantial platform layer:

4. **Durable run-event log + SSE** — Flue-style discriminated event union persisted in `run_events`; SSE endpoint with `Last-Event-ID` resume. `GET /api/agents/<name>/runs/<id>/stream`.
5. **MCP server surface** — Proteus is now an MCP server. External agents (Cursor, Claude Code, browser AI) connect at `/mcp/v1/<agentName>`. Tools: `search_memory`, `save_note`, `list_skills`, `run_scaffold_once`, `get_shadow_status`, `list_runs`, `list_run_events`. Resource: `proteus://agent/<name>/memory`.
6. **Vectorize semantic memory + RRF hybrid search** — when `env.AI` + `env.MEMORY_VECTORS` are configured, memory chunks get embedded via Workers AI `@cf/baai/bge-small-en-v1.5` (384-dim). Hybrid retrieval merges FTS5 + Vectorize via Reciprocal Rank Fusion. `@callable searchMemoryHybrid(query, limit?)`.
7. **Hermes background-review fork** — `ReviewAgent` Facet spawned fire-and-forget after each turn. Runs `_SKILL_REVIEW_PROMPT` against the turn; appends memory lessons to `MEMORY.md` when meaningful.
8. **Compaction** — Flue/Hermes-style summarize-middle / preserve-head-and-tail with configurable token thresholds.
9. **Approval gate** — regex-based pre-exec review (allow/warn/gate/deny) for shell commands. Rules include rm-rf-root, fork-bomb, sudo, chmod-setuid, git force-push, cloud-metadata SSRF, secret-file-read.
10. **`onFiberRecovered` hook** — logs + writes a memory note when a fiber (MCTS or otherwise) was interrupted by DO eviction and recovered.

## How to deploy

```bash
# In one of these worktrees:
cd /home/mrwhite0racle/Proteus/.claude/worktrees/proteus-v2-runtime

# 1) Auth — either:
wrangler login                                        # interactive
# OR:
export CLOUDFLARE_API_TOKEN=<token>

# 2) Run the deploy script — it does install + check + tests + build + deploy + health probe:
./scripts/deploy-v2.sh

# 3) Once it succeeds, confirm:
curl https://proteus.ashishkumarsingh.com/api/v2/health
```

You'll see a JSON listing every v2 feature flag + endpoint.

## Optional: enable Vectorize semantic memory

The code is wired but the binding is commented in `wrangler.jsonc`. To enable:

```bash
# Create the index (one-time):
cd packages/cf-backend
npx wrangler vectorize create proteus-memory --dimensions=384 --metric=cosine

# Uncomment in wrangler.jsonc:
#   "ai": { "binding": "AI" }                             ← Workers AI
#   "vectorize": [                                         ← Vectorize index
#     { "binding": "MEMORY_VECTORS", "index_name": "proteus-memory" }
#   ]

# Re-deploy:
npx wrangler deploy
```

Once both bindings exist, `runtime.ts` auto-detects them and the new
`searchMemoryHybrid` @callable returns RRF-merged FTS5 + semantic results.
Without them, the agent transparently uses FTS5-only (no behavior change).

## How to test (once deployed)

### Sanity probe
```bash
curl https://proteus.ashishkumarsingh.com/api/v2/health | jq .
```

### Branching heads via the chat UI
Open https://proteus.ashishkumarsingh.com, start a new agent, then:

> Use split_heads to explore three angles on integrating Stripe Checkout
> into this app: (1) the standard hosted flow, (2) an embedded element
> approach, (3) edge-case auth flows. Merge with the synthesize strategy.

The agent should fire `split_heads` and you'll see three nested
HeadAgent runs in the durable event log, then a single merged narrative
as the response.

### MCP server
Add to Cursor or Claude Code config:
```json
{
  "mcpServers": {
    "proteus": {
      "url": "https://proteus.ashishkumarsingh.com/mcp/v1/my-agent-name"
    }
  }
}
```
The external client should now see 7 tools and 1 resource.

### Event-log SSE
```bash
# First, find a recent runId
curl https://proteus.ashishkumarsingh.com/api/agents/<name>/runs | jq .

# Stream events for that run (use Last-Event-ID to resume after disconnect)
curl -N https://proteus.ashishkumarsingh.com/api/agents/<name>/runs/<runId>/stream
```

### Scaffold rollout
After the agent generates a new scaffold version via its own evolution:
```bash
# Via the chat UI's settings panel — or via @callable RPCs:
agent.getShadowStatus()        # → pending version + trial counts + decision
agent.runScaffoldOnce("hello") # → fires the current scaffold for a test task
agent.applyScaffoldDecision('auto')  # → promotes or rolls back per the judge
```

## What's queued (v2.1)

Deferred from the master plan, ready as follow-ups:

- **Automatic `onChatMessage` scaffold takeover** — today scaffold execution
  is RPC-driven; v2.1 swaps Think's `streamText()` for scaffold-driven
  inference on the user-facing turn.
- **Think Session migration of MEMORY.md** — already uses `configureSession`
  with a memory block; full migration of `MEMORY.md` storage into Session's
  tree-structured tables is queued.
- **SKILL.md format migration** — crafted tools currently live as
  `crafted_tools` SQL rows. Migrating to YAML-frontmatter `.md` files in
  VFS makes them git-friendly + shareable. Touches CraftStore, tools/builtins,
  evolution.
- **Heads spawning across parent sandboxes** — each head currently gets
  its own VirtualSandbox only. v2.1 adds a parent-RPC bridge so heads
  can drive the orchestrator's Cloudflare/Nimbus/SSH sandboxes in true
  parallel work.
- **Codebase-wide Valibot migration** — current schemas are Zod; swap
  for ergonomics. Lower priority.

## What needed your input but didn't get it (during the build)

- **wrangler auth** — I needed `wrangler login` (or `CLOUDFLARE_API_TOKEN`)
  to deploy. Pushed notifications. Code is build-clean and deploy-ready;
  `scripts/deploy-v2.sh` handles the rest.
- **Vectorize index provisioning** — needs `wrangler vectorize create proteus-memory`
  which also requires the auth above. See the optional section above.

## Files to look at first

If you want to verify the build:
1. `docs/v2/IMPLEMENTATION_PLAN.md` — the original plan (what I was working from)
2. `docs/v2/V2-ARCHITECTURE.md` — the as-shipped architecture w/ deep-dives
3. `docs/v2/RESEARCH_NOTES.md` — API references for Cloudflare Agents SDK / Think / Flue / Nimbus

If you want to verify it works:
4. `packages/core/tests/integration-v2-end-to-end.test.ts` — 6-pillar smoke test
5. `bun test --cwd packages/core` — full unit suite

If you want to see specific subsystems:
- Sandbox: `packages/core/src/sandbox/`
- Heads: `packages/core/src/heads/` + `packages/cf-backend/src/heads/`
- Scaffold: `packages/core/src/scaffold/executor.ts` + `shadow.ts`
- Memory: `packages/core/src/memory/`
- Events: `packages/core/src/events/`
- MCP: `packages/cf-backend/src/mcp-server.ts`
- Approval: `packages/core/src/safety/approval-gate.ts`
- Compaction: `packages/core/src/compaction.ts`

Welcome back. The runtime is real.
