# Proteus

A self-evolving agent architecture with MCTS-based parallel exploration, mutable scaffolding, and durable skill evolution. Runs on Cloudflare Workers (Durable Objects) or Linux CLI.

## CLI Quick Start

```bash
# Install
bun install
cd packages/cli && bun link

# Configure (pick one)
export PROTEUS_BASE_URL="https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/workers-ai/v1"
export PROTEUS_AUTH="Bearer <token>"
export PROTEUS_MODEL="@cf/moonshotai/kimi-k2.5"      # optional, this is the default

# Or save to config file
mkdir -p ~/.proteus
echo '{"baseUrl":"...","auth":"Bearer ..."}' > ~/.proteus/config.json

# Use
proteus create atlas --purpose "A code review expert"
proteus chat atlas
proteus status atlas
proteus list
proteus evolve atlas --budget 3
```

## Architecture

The agent uses Monte Carlo Tree Search (LATS) to explore multiple solution approaches in parallel, pruning bad branches and converging on the best. Over time, successful patterns are extracted into a CraftStore and injected into future explorations.

**Key features:**
- **MCTS parallel exploration** with UCT selection, backpropagation, pruning
- **Mutable scaffold** — the agent's own agentic loop is code it can evolve
- **4-gate scaffold validation** — structural, parse, regression, canary testing
- **CraftStore** with EMA scoring, time decay, conflict detection, consolidation
- **Multi-model evaluation** — cross-model judging eliminates self-enhancement bias
- **Portable** — same core runs on CF Workers or Linux CLI

## Packages

| Package | Purpose |
|---------|---------|
| `packages/core` | Platform-independent algorithms, types, config |
| `packages/cli` | CLI frontend (`proteus` command) |
| `packages/cli-backend` | Linux-specific primitives (SQLite, vm, child_process) |
| `packages/cf-backend` | Cloudflare Workers (Think + Durable Objects) |

## Development

```bash
bun install
bun run check                           # TypeScript type-check
bun test --cwd packages/core            # unit + integration tests
NODE_TLS_REJECT_UNAUTHORIZED=0 \
  bun test tests/e2e-full-lifecycle.test.ts  # E2E (needs LLM credentials)
```

## Configuration

All parameters are configurable via `AgentConfig`. See `packages/core/src/config.ts` for defaults.

```typescript
import { mergeConfig } from '@proteus/core';

const config = mergeConfig({
  mcts: { maxDepth: 10, explorationWeight: 1.0 },
  craftStore: { halfLifeDays: 14 },
});
```

## LLM Provider

Uses Vercel AI SDK (`@ai-sdk/openai-compatible`) — works with any OpenAI-compatible endpoint:

```typescript
import { createVercelAILLM } from '@proteus/core';

const llm = createVercelAILLM({
  name: 'workers-ai',
  baseURL: process.env.PROTEUS_BASE_URL!,
  headers: { 'cf-aig-authorization': process.env.PROTEUS_AUTH! },
  model: '@cf/moonshotai/kimi-k2.5',
});
```

## License

MIT
