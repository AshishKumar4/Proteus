# Agent Tools — 5-Tool Architecture

The agent exposes exactly **5 top-level tools** to the LLM. All filesystem operations are available as `workspace.*` APIs inside the `execute_tools` codemode sandbox. Crafted tools from the CraftStore are injected as `tools.*`.

## Top-Level Tools

| Tool | Purpose | Implementation |
|------|---------|----------------|
| `execute_tools` | Codemode sandbox — LLM writes JS with `workspace.*` and `tools.*` APIs | `createExecuteTool({ tools: craftedToolSet, providers, loader })` |
| `run` | POSIX shell command with optional executor routing | `shell.exec(command)` or routed via `ExecutionRouter` |
| `explore` | MCTS tree search for complex subproblems | `runFiber` → `engine.onLifetimeEvolution` → `runMCTS` |
| `save_note` | Quick memory persist (FTS-indexed) | `memory.append("memory/MEMORY.md")` + `memory.index()` |
| `search_memory` | Full-text search over long-term memory | `memory.search(query, limit)` via FTS5 BM25 |

## execute_tools — Codemode Sandbox

The primary tool. The LLM writes JavaScript code that runs in an isolated Worker via the `LOADER` binding (`@cloudflare/codemode`).

### workspace.* APIs (always available)

| API | Signature | What it does |
|-----|-----------|-------------|
| `workspace.readFile` | `(path: string) → string` | Read file contents from SqliteFS |
| `workspace.writeFile` | `(path: string, content: string) → "ok"` | Write file to SqliteFS (auto-creates parents) |
| `workspace.readdir` | `(path: string) → string[]` | List directory entries |
| `workspace.exists` | `(path: string) → boolean` | Check if a path exists |
| `workspace.exec` | `(command: string) → string` | Run POSIX shell command (cat, grep, find, sed, ls, etc.) |
| `workspace.searchMemory` | `(query: string) → results` | FTS5 search over long-term memory |
| `workspace.saveNote` | `(content: string) → "ok"` | Append note to MEMORY.md with FTS indexing |
| `workspace.listTools` | `() → string` | List all built-in + crafted tools |
| `workspace.createTool` | `(name, description, code) → "ok"` | Create/update a crafted tool in CraftStore |

These come from `InlineExecutor` in `packages/core/src/execution/inline.ts`, registered as the `workspace` provider in the `ExecutionRouter`.

### tools.* APIs (dynamically learned)

Crafted tools from the CraftStore are injected into the codemode sandbox as `tools.*`:

```javascript
// Inside execute_tools:
const result = await tools.my_custom_parser({ input: "data" });
```

**How injection works** (orchestrator.ts `getTools()`):
1. `craftStore.list()` reads all crafted tools from SQLite
2. Each tool's `code` field (an async arrow function string) is wrapped via `new Function("return " + code)()`
3. The resulting `craftedToolSet` is passed as the `tools` parameter to `createExecuteTool`
4. Inside the codemode sandbox, the LLM can call `tools.name(args)`

### Example usage

```javascript
// Read a file, transform it, write the result
async () => {
  const pkg = await workspace.readFile("package.json");
  const parsed = JSON.parse(pkg);
  parsed.version = "2.0.0";
  await workspace.writeFile("package.json", JSON.stringify(parsed, null, 2));
  return `Updated version to ${parsed.version}`;
}
```

```javascript
// Parallel file operations
async () => {
  const [src, tests] = await Promise.all([
    workspace.exec("find /src -name '*.ts' | wc -l"),
    workspace.exec("find /tests -name '*.test.ts' | wc -l"),
  ]);
  return { sourceFiles: src.trim(), testFiles: tests.trim() };
}
```

```javascript
// Use a crafted tool
async () => {
  const result = await tools.parse_csv({ input: await workspace.readFile("data.csv") });
  await workspace.saveNote(`Parsed ${result.rows} rows from data.csv`);
  return result;
}
```

### Fallback (no LOADER binding)

When the `LOADER` Worker Loader binding is unavailable (local dev without `worker_loaders`), `execute_tools` is not registered. The LLM falls back to `run` for shell operations and `save_note`/`search_memory` for memory.

## run — Shell Command

Direct POSIX shell execution over the agent's virtual filesystem (SqliteFS).

**Supported commands** (16): `cat`, `head`, `tail`, `ls`, `tree`, `find`, `grep`, `echo`, `mkdir`, `touch`, `rm`, `cp`, `mv`, `sed`, `stat`, `wc`

**Features**: Pipelines (`|`), redirects (`>`, `>>`), chaining (`&&`, `||`, `;`)

**Executor routing**: Pass `executor: "nimbus"` or `executor: "sandbox"` to target a remote environment. Default: `workspace` (SqliteFS).

**Blocked commands**: Real programs (`node`, `npm`, `git`, `python`) are blocked with a message directing to `execute_tools`.

## explore — MCTS Tree Search

Triggers a Monte Carlo Tree Search for complex subproblems. Runs inside a durable fiber (`runFiber`) with checkpoint/resume via `stash`.

See [MCTS.md](./MCTS.md) for the full search algorithm.

## save_note / search_memory

Quick memory operations that don't require the codemode sandbox:

- **save_note**: Appends to `memory/MEMORY.md` with a date header, then re-indexes via FTS5
- **search_memory**: FTS5 MATCH query with BM25 ranking, OR fallback for broad recall

## CraftStore Lifecycle

Crafted tools are discovered, scored, and retired automatically:

1. **Extract**: `EvolutionEngine.extractPattern()` asks the LLM to generalize successful tool-call patterns
2. **Score**: `updateCraftScores()` updates EMA scores (α=0.3) after each turn that uses crafted tools
3. **Filter**: `loadCraftedTools()` skips tools below `minEffectiveScoreForInjection` (0.2)
4. **Inject**: Surviving tools are passed to `createExecuteTool` as the `tools` parameter
5. **Consolidate**: `periodicCraftConsolidation()` retires tools with `effectiveScore < 0.1`

## Token Budget

| Architecture | Tools | Estimated tokens |
|-------------|-------|-----------------|
| Old (13 tools) | read, write, edit, list, find, grep, delete, shell_exec, execute, explore, save_note, search_memory, list_tools | ~5000 |
| **Current (5 tools)** | execute_tools, run, explore, save_note, search_memory | **~400** |

12x reduction in tool schema context window usage.
