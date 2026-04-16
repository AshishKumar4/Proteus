# Proteus — Agent Development Guide

## Project Overview

Self-evolving agent framework with MCTS parallel exploration, mutable scaffolding,
and durable skill evolution. Two backends: Cloudflare Workers (AIChatAgent + DO) and
local CLI (bun:sqlite). Shared core with abstract interfaces.

Monorepo with `bun` workspaces: `packages/*`.

## Build & Check

```bash
bun install                              # install all dependencies
bun run check                            # TypeScript type-check (tsc --noEmit)
bun test --cwd packages/core             # run all unit tests
bun test packages/core/tests/unit-*.test.ts  # run only unit tests
bun test tests/e2e-lifecycle.test.ts     # run E2E tests (needs LLM credentials)
```

## Package Structure

```
packages/
  core/         @proteus/core — abstract interfaces, MCTS, evolution, scaffold, craft
  cf-backend/   Cloudflare Workers backend — AIChatAgent + Agent DOs, React UI, Vite+Wrangler
  cli/          CLI frontend (commander-based)
  cli-backend/  CLI-specific backend (bun:sqlite, Node vm)
tests/          E2E tests (run from repo root)
```

### cf-backend Architecture

- `OrchestratorAgent extends AIChatAgent` — handles chat, tools, evolution hooks
- `ExplorationAgent extends Agent` — MCTS branch sub-agent via Facets
- `wrangler.jsonc` — DO bindings, AI binding, SPA assets
- `vite.config.ts` — cloudflare() + react + agents + tailwindcss plugins
- React UI uses `useAgent()` + `useAgentChat()` from agents/react and @cloudflare/ai-chat/react
- `wrangler dev` (via `vite dev`) runs everything locally — real DOs, real SQLite, real WebSocket

### Core Subsystems (packages/core/src/)

| Directory    | Purpose                                                 |
|-------------|----------------------------------------------------------|
| identity/   | Agent creation, reopening, soul (immutable purpose), DDL |
| evolution/  | 3-timescale auto-evolution engine, tool building         |
| mcts/       | Monte Carlo Tree Search — UCT, backprop, convergence     |
| scaffold/   | Agentic loop versioning — bootstrap, modify, rollback    |
| craft/      | Tool quality store — EMA scoring, discovery, conflict    |
| types/      | TypeScript interfaces for all primitives                 |
| utils/      | nanoid, date helpers                                     |

## Key Interfaces

- `AgentRuntime` — the one struct the agent core receives (types/agent-runtime.ts)
- `SqlExecutor` — tagged-template SQL (types/primitives.ts)
- `VFS`, `Memory`, `Executor`, `LLM`, `Schedule`, `Identity` — six abstract primitives
- `buildRuntime()` — assembles AgentRuntime from platform-specific components
- `buildAgentTools()` — creates Vercel AI SDK ToolSet (evolution/tools.ts)
- Both backends (CF + CLI) satisfy the same interfaces differently

## Code Style

- TypeScript strict mode, ES2022 target, ESNext modules, bundler resolution
- All imports use `.js` extension (ESM convention)
- Tagged-template SQL via `SqlExecutor` for parameterized queries
- `RawSqlExec` (plain string) only for DDL (CREATE TABLE, CREATE INDEX)
- All DDL uses `IF NOT EXISTS` — schema init is idempotent
- Use Vercel AI SDK v6 `tool()` + `jsonSchema()` for tool definitions
- `ToolSet` type from `ai` package for tool collections
- maxSteps = 500 default, configurable via `PROTEUS_MAX_STEPS`

## CF Backend Specifics

- OrchestratorAgent extends `AIChatAgent` from `@cloudflare/ai-chat`
- Uses `workers-ai-provider` with `this.env.AI` binding for LLM calls
- `onChatMessage()` returns `streamText().toUIMessageStreamResponse()`
- `onChatResponse()` fires evolution hooks (turn quality assessment, pattern extraction)
- `@callable()` methods for RPC from React UI via `agent.call()`
- ExplorationAgent uses `@callable()` for MCTS branch operations
- React UI uses `useAgent()` and `useAgentChat()` — no hand-rolled WS hooks

## Architecture Invariants

- The agent_soul table is immutable — write once at creation, never modify
- agent_identity holds a single row with stable UUID
- Scaffold is versioned in VFS (`scaffold/agent.js`) + `scaffold_versions` table
- Memory lives in VFS under `memory/` prefix
- MCTS nodes stored in `search_nodes` table
- Crafted tools stored in `crafted_tools` table with EMA scoring
- Port 3000 is reserved (platform relay) — never bind to it
