# Agent Tools

The agent has 8 built-in domain tools, dynamically-learned crafted tools, and Think's 7 workspace tools.

## Built-in Domain Tools

| Tool | Description | Implementation |
|------|-------------|----------------|
| `search_memory` | Search long-term memory using FTS5 full-text search with BM25 ranking | `rt.memory.search(query, limit)` → MemoryStore FTS5 MATCH |
| `read_file` | Read a file from the agent's virtual filesystem | `rt.memory.read(path)` → SqliteFS.readFile |
| `write_file` | Write content to a file in the VFS | `rt.memory.write(path, content)` → SqliteFS.writeFile |
| `execute_code` | Execute JavaScript code. On CF with LOADER: sandboxed Worker isolate. Otherwise: `new Function()` | `rt.executor.execute(code)` |
| `save_note` | Save a note to long-term memory (MEMORY.md) with FTS5 indexing | `rt.memory.append` + `rt.memory.index` |
| `list_tools` | List all available tools including dynamically crafted ones | `rt.craftStore.list()` |
| `shell_exec` | POSIX shell emulator over VFS (see below) | `createShell(sqliteFS).exec(command)` |
| `explore` | Trigger MCTS exploration on a complex subproblem via durable fiber | `runFiber` → `engine.onLifetimeEvolution` → `runMCTS` |

## Think Workspace Tools (auto-included)

Think automatically adds these file manipulation tools:

| Tool | Description |
|------|-------------|
| `read` | Read file contents with line numbers |
| `write` | Write content to a file |
| `edit` | Targeted string replacement with fuzzy matching |
| `list` | List directory entries |
| `find` | Glob-based file search |
| `grep` | Regex search across file contents |
| `delete` | Delete a file |

## Shell Emulator

The `shell_exec` tool provides a POSIX shell emulator that runs directly over the agent's SqliteFS. No real OS shell exists on Cloudflare Workers — this emulator fills that gap.

**Supported commands (16):**

| Command | Flags | Example |
|---------|-------|---------|
| `cat` | `-n` (line numbers) | `cat -n memory/MEMORY.md` |
| `head` | `-n N` | `head -n 20 file.txt` |
| `tail` | `-n N` | `tail -n 10 file.txt` |
| `ls` | `-l`, `-a`, `-R`, `-h`, `-t`, `-1` | `ls -la memory/` |
| `tree` | `--depth N`, `--ignore` | `tree scaffold/ --depth 2` |
| `find` | `-name`, `-type f/d`, `-maxdepth` | `find . -name "*.md" -type f` |
| `grep` | `-r`, `-n`, `-i`, `-l`, `-c`, `-v`, `--include` | `grep -rn "TODO" . --include "*.ts"` |
| `echo` | | `echo "hello" > file.txt` |
| `mkdir` | `-p` (recursive) | `mkdir -p memory/logs` |
| `touch` | | `touch newfile.txt` |
| `rm` | `-r` | `rm -r temp/` |
| `cp` | | `cp file.txt backup.txt` |
| `mv` | | `mv old.txt new.txt` |
| `sed` | `s/pat/rep/[g]`, `-i` | `sed -i 's/old/new/g' file.txt` |
| `stat` | | `stat file.txt` |
| `wc` | `-l`, `-w`, `-c` | `wc -l file.txt` |

**Pipeline support:** `grep pattern file | head -5`  
**Redirects:** `echo hello > file.txt`, `cat a >> b`  
**Chaining:** `cmd1 && cmd2`, `cmd1 || cmd2`, `cmd1 ; cmd2`

**Blocked commands:** Real programs (`node`, `npm`, `git`, `python`) are blocked with a message directing to `execute_code`.

## Crafted Tools (Dynamic)

The CraftStore learns new tools from successful conversations:

1. Agent uses `execute_code` or other tools to solve a problem
2. EvolutionEngine's `extractPattern()` asks the LLM to generalize the pattern
3. LLM returns `{"name": "...", "description": "...", "params": {...}, "code": "async (args) => {...}"}`
4. Tool stored in `crafted_tools` table with FTS5 index
5. On next `getTools()` call, `loadCraftedTools()` wraps the stored code as a real AI SDK `tool()` object
6. The model can now call this tool by name

Crafted tools have EMA scoring (α=0.3) with 30-day half-life time decay. Tools scoring below 0.1 are retired during periodic consolidation.

## Code Execution

| Platform | Mechanism | Sandbox | Timeout |
|----------|-----------|---------|---------|
| CF Workers (with LOADER) | `createExecuteTool` from `@cloudflare/think/tools/execute` | Worker isolate — no global access | Workers CPU limit |
| CF Workers (fallback) | `new Function('return (async () => { code })()')` | None — has access to JS globals | None |
| CLI | Bun subprocess | Separate process | 30 seconds |
