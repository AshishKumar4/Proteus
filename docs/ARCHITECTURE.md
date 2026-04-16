# Architecture

Proteus is a self-evolving AI agent built on Cloudflare's Agents SDK. It uses Monte Carlo Tree Search (MCTS) to explore multiple solution strategies in parallel, learns reusable tool patterns via a CraftStore, and can rewrite its own agentic loop (scaffold) based on observed performance.

## Message Flow

```mermaid
sequenceDiagram
    participant U as User (Browser)
    participant WS as WebSocket
    participant T as Think (OrchestratorAgent)
    participant LLM as AI Gateway / Workers AI
    participant Tools as Tool Execution
    participant Evo as EvolutionEngine
    participant DB as DO SQLite

    U->>WS: Send message
    WS->>T: CF_AGENT_CHAT_REQUEST
    T->>T: beforeTurn() — reset counters
    T->>T: getModel() — read agent_config
    T->>T: getSystemPrompt() — read agent_soul
    T->>T: getTools() — buildAgentTools + shell + explore + codemode
    T->>LLM: streamText(model, system, messages, tools)
    loop Tool calling loop (up to 500 steps)
        LLM-->>T: text delta / tool call
        T-->>U: stream chunk via WebSocket
        opt Tool call
            T->>Tools: execute tool
            Tools-->>T: tool result
            T->>T: afterToolCall() — record for evolution
            T->>LLM: continue with tool result
        end
        T->>T: onStepFinish() — increment counter
    end
    LLM-->>T: done
    T-->>U: done:true
    T->>DB: persist assistant message (Think Session)
    T->>Evo: void onTurnComplete(turn) — fire and forget
    Note over Evo: Runs async — does NOT block next message
    Evo->>DB: assess quality, reflect, extract patterns
    Evo->>DB: write evolution_events
```

## Package Structure

```mermaid
graph TB
    subgraph "packages/"
        Core["core/<br/>Abstract interfaces, MCTS engine,<br/>EvolutionEngine, CraftStore,<br/>scaffold, tools"]
        AgentUtils["agent-utils/<br/>SqliteFS (chunked VFS),<br/>MemoryStore (FTS5),<br/>CraftStore (FTS5),<br/>Shell emulator (16 POSIX cmds)"]
        CFBackend["cf-backend/<br/>OrchestratorAgent extends Think,<br/>ExplorationAgent (Facets),<br/>React UI, Vite+Wrangler"]
        CLI["cli/<br/>proteus create/chat/evolve/status/list<br/>Commander CLI"]
        CLIBackend["cli-backend/<br/>bun:sqlite runtime,<br/>Node vm executor,<br/>child_process MCTS branches"]
    end

    CFBackend --> Core
    CFBackend --> AgentUtils
    CLI --> Core
    CLI --> CLIBackend
    CLIBackend --> Core
    CLIBackend --> AgentUtils

    subgraph "External"
        Think["@cloudflare/think"]
        Agents["agents (Agents SDK)"]
        AISDK["ai (Vercel AI SDK v6)"]
    end

    CFBackend --> Think
    CFBackend --> Agents
    Core --> AISDK
```

## Durable Object Layout

```mermaid
graph LR
    subgraph "Cloudflare Workers"
        Worker["Worker (fetch handler)<br/>routeAgentRequest()"]
    end

    subgraph "Durable Objects"
        Orch["OrchestratorAgent<br/>extends Think&lt;Env&gt;<br/><br/>SQLite: agent_soul, agent_identity,<br/>vfs_files, memory_chunks,<br/>crafted_tools, search_nodes,<br/>evolution_events, agent_config,<br/>scaffold_versions, fibers"]

        subgraph "Facets (MCTS branches)"
            E1["ExplorationAgent #1<br/>extends Agent&lt;Env&gt;<br/>Isolated SQLite: traces"]
            E2["ExplorationAgent #2<br/>Isolated SQLite: traces"]
            E3["ExplorationAgent #N<br/>Isolated SQLite: traces"]
        end
    end

    Worker --> Orch
    Orch -->|"subAgent()"| E1
    Orch -->|"subAgent()"| E2
    Orch -->|"subAgent()"| E3
```

## AgentRuntime Interface

The `AgentRuntime` is the central contract. Every backend (CF Workers or CLI) must provide these 6 primitives:

| Primitive | Interface | CF Backend | CLI Backend |
|-----------|-----------|------------|-------------|
| **Storage** | `VFS` + `SqlExecutor` + `RawSqlExec` | SqliteFS over DO SQLite | SqliteFS over bun:sqlite |
| **Memory** | `write`, `append`, `index`, `search`, `read` | MemoryStore (FTS5 BM25) | MemoryStore (FTS5 BM25) |
| **Executor** | `execute(code, providers)` | `new Function()` fallback / LOADER codemode | Bun subprocess sandbox (30s timeout) |
| **LLM** | `stream`, `complete` | Workers AI binding or AI Gateway | AI Gateway via Vercel AI SDK |
| **Schedule** | `after`, `cron`, `fiber` | `agent.runFiber()` (durable) | SQLite-backed fiber |
| **Identity** | `id`, `name`, `scaffold.*` | DO ID + agent_soul table | UUID + ~/.proteus/ directory |

Additional runtime components:
- **CraftStore** — FTS5-indexed learned tool storage
- **SpawnBranch** / **AbortBranch** — MCTS branch lifecycle (Facets on CF, child_process on CLI)

## Think Lifecycle Hooks

The `OrchestratorAgent` extends Think and implements these hooks:

| Hook | When | What Proteus Does |
|------|------|-------------------|
| `getModel()` | Every turn | Read stored model preference from `agent_config`, create Workers AI or AI Gateway model |
| `getSystemPrompt()` | Every turn | Read agent soul from `agent_soul` table |
| `getTools()` | Every turn | Return domain tools + shell + explore + optional codemode. Think auto-adds workspace tools. |
| `configureSession()` | Session init | Memory context block (3000 tokens) + cached prompt |
| `beforeTurn()` | Before inference | Reset turn tracking (tool calls, step count, timer) |
| `afterToolCall()` | After each tool | Record tool call for evolution pattern extraction |
| `onStepFinish()` | After each step | Increment step counter |
| `onChatResponse()` | After turn complete | Fire-and-forget evolution hooks (async, never blocks TurnQueue) |
| `onFiberRecovered()` | DO wake from hibernation | Log interrupted fibers for debugging |
