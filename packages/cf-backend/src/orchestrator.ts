/**
 * OrchestratorAgent — self-evolving chat agent extending Think.
 *
 * 13 top-level tools the LLM sees:
 *   execute       — codemode sandbox (workspace.*, nimbus.*, sandbox.*, laptop.* APIs)
 *   explore       — MCTS tree search via durable fiber
 *   read/write/edit/list/find/grep/delete — filesystem, optional executor param
 *   shell_exec    — POSIX shell, optional executor param
 *   save_note     — append to MEMORY.md
 *   search_memory — FTS5 search over memory
 *   list_tools    — list built-in + crafted tools
 *
 * Filesystem tools accept an optional `executor` string param to route through
 * a specific execution provider (nimbus, sandbox, laptop). Default: workspace.
 * These names overwrite Think's built-in workspace tools.
 */

import { callable } from "agents";
import { Think, Session } from "@cloudflare/think";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { tool, jsonSchema } from "ai";
import type { LanguageModel, ToolSet } from "ai";
// tool + jsonSchema still used by explore tool
import type {
  TurnContext, TurnConfig, ChatResponseResult,
  ToolCallResultContext, StepContext,
} from "@cloudflare/think";
import {
  EvolutionEngine,
  bootstrapScaffold,
  initAllTables, initSearchTables, initScaffoldTables, initCraftScoreTables,
  resolveMaxSteps,
  type CompletedTurn, type ToolCallRecord, type AgentRuntime,
  type SessionWriter, type SessionMessage,
} from "@proteus/core";
import { createCFRuntime, type CFRuntime } from "./runtime.js";
import { createShell } from "@proteus/agent-utils/shell";

const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.5";
const SESSION_REFLECTION_INTERVAL = 5; // turns between session reflections

const AVAILABLE_MODELS = [
  { id: "@cf/moonshotai/kimi-k2.5", name: "Kimi K2.5", description: "Reasoning model, slow but smart" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout", description: "Fast, good for quick tasks" },
] as const;

export class OrchestratorAgent extends Think<Env> {
  override maxSteps = resolveMaxSteps();

  private _rt: CFRuntime | null = null;
  private _engine: EvolutionEngine | null = null;
  private _turnToolCalls: ToolCallRecord[] = [];
  private _turnStepCount = 0;
  private _turnStartedAt = 0;
  private _turnHadError = false;
  private _sessionTurnCount = 0;
  private _sessionTurns: CompletedTurn[] = [];
  private _sessionStartedAt = Date.now();

  private get rt(): AgentRuntime {
    if (!this._rt) this._rt = createCFRuntime(this);
    return this._rt;
  }

  private get engine(): EvolutionEngine {
    if (!this._engine) {
      this._engine = new EvolutionEngine(this.rt, {
        enabled: true,
        onMctsProgress: (iteration, remaining) => {
          this.broadcastMctsProgress("iteration", iteration, remaining);
        },
      });
    }
    return this._engine;
  }

  // ── Model resolution ───────────────────────────────────────────

  private getStoredModelId(): string {
    try {
      const rows = this.sql<{ model: string }>`
        SELECT value as model FROM agent_config WHERE key = 'model' LIMIT 1`;
      return rows[0]?.model ?? DEFAULT_MODEL;
    } catch { return DEFAULT_MODEL; }
  }

  private createModel(modelId: string): LanguageModel {
    const env = this.env as Env & Record<string, string>;
    if (env.AI && typeof env.AI !== "string") {
      return createWorkersAI({ binding: env.AI })(modelId, {
        sessionAffinity: this.sessionAffinity,
      });
    }
    const gatewayUrl = env.AI_GATEWAY_URL;
    const gatewayAuth = env.AI_GATEWAY_AUTH;
    if (gatewayUrl && gatewayAuth) {
      // /workers-ai/v1 endpoint — model IDs used as-is (no prefix needed)
      return createOpenAICompatible({
        name: "workers-ai",
        baseURL: gatewayUrl,
        headers: { "Authorization": gatewayAuth },
      }).chatModel(modelId);
    }
    throw new Error("No AI model configured.");
  }

  // ── Think lifecycle overrides ──────────────────────────────────

  getModel(): LanguageModel {
    return this.createModel(this.getStoredModelId());
  }

  getSystemPrompt(): string {
    try {
      const rows = this.sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`;
      const purpose = rows[0]?.purpose ?? "You are a helpful coding assistant.";

      return `${purpose}

## Your environment

You are a Proteus agent — a self-evolving AI running as a Cloudflare Durable Object. You have persistent state: a virtual filesystem, long-term memory with full-text search, and a tool evolution system that improves your capabilities over time.

## Tools

You have 13 tools:

### Filesystem tools (accept optional \`executor\` param)
- **read** — read a file with line numbers (offset/limit for large files)
- **write** — write content to a file (creates parent dirs)
- **edit** — targeted search/replace in a file
- **list** — list directory contents
- **find** — find files by glob pattern
- **grep** — search file contents with regex
- **delete** — delete a file or directory
- **shell_exec** — run a POSIX shell command (cat, grep, find, sed, ls, head, tail, wc, mkdir, rm, cp, mv, echo, sort, uniq; pipes and redirects supported)

By default these operate on your workspace (DO-local SqliteFS). Pass \`executor: "nimbus"\` or \`executor: "sandbox"\` to target a remote execution environment when available.

### Memory tools
- **save_note** — append a note to long-term memory (MEMORY.md, FTS-indexed)
- **search_memory** — full-text search over long-term memory

### Meta tools
- **list_tools** — list all built-in and crafted tools
- **execute** — run JavaScript code in a sandboxed environment with \`workspace.*\`, \`nimbus.*\`, \`sandbox.*\`, \`laptop.*\` APIs (for complex multi-step orchestration)
- **explore** — MCTS tree search for complex subproblems (architecture decisions, multi-step problem solving)

## Evolution

Your capabilities improve automatically:
- **Turn-level**: quality scoring and pattern extraction after each response
- **Session-level**: reflection and consolidation every ~5 turns
- **Lifetime**: MCTS exploration discovers better approaches
- **Tool crafting**: good patterns are automatically extracted into reusable CraftStore tools

## Guidelines

- Use direct tools (read, write, grep, shell_exec, etc.) for simple operations
- Use execute for complex multi-step JS orchestration
- Use explore for genuinely difficult multi-path problems
- Save important information with save_note — recall with search_memory
- Summarize what you did after using tools
- Be honest: you can read/write files, run shell commands, and search memory, but you cannot access the internet, deploy code, or run servers`;
    } catch {
      return "You are a helpful coding assistant.";
    }
  }

  getTools(): ToolSet {
    console.log("[proteus] getTools() called");
    try {
    const orchestrator = this;
    const env = this.env as Env & Record<string, unknown>;
    const tools: ToolSet = {};

    // Helper: resolve an executor provider by name, falling back to workspace
    const router = this.rt.executionRouter;
    const defaultProvider = router?.getProvider("workspace");
    function getExec(name?: string) {
      if (!name || name === "workspace") return defaultProvider;
      return router?.getProvider(name) ?? defaultProvider;
    }
    // Default workspace resources for direct tools
    const vfs = this.rt.storage.vfs;
    const memory = this.rt.memory;
    const craftStore = this.rt.craftStore;
    const shell = createShell(this.rt.sqliteFS);

    // ── execute: codemode sandbox ────────────────────────────────
    if (env.LOADER) {
      try {
        const providers = router?.getProviders() ?? [];
        tools.execute = createExecuteTool({
          tools: {},
          providers,
          loader: env.LOADER as WorkerLoader,
        });
      } catch (err) {
        console.warn("[proteus] createExecuteTool failed:", (err as Error).message);
      }
    }

    // ── explore: MCTS ────────────────────────────────────────────
    tools.explore = tool({
      description: "MCTS tree search for complex subproblems. Spawns branches, evaluates approaches, returns the best.",
      inputSchema: jsonSchema<{ task: string; budget?: number }>({
        type: "object",
        properties: {
          task: { type: "string", description: "The subproblem to explore" },
          budget: { type: "number", description: "MCTS iterations (default: 5)" },
        },
        required: ["task"],
      }),
      execute: async (args: { task: string; budget?: number }) => {
        try {
          return await orchestrator.runFiber(`explore-${Date.now()}`, async (ctx) => {
            ctx.stash({ task: args.task, phase: "starting" });
            orchestrator.broadcastMctsProgress("explore-starting");
            const session = orchestrator.createMCTSSession();
            const { nanoid } = await import("@proteus/core");
            await session.appendMessage(
              { id: nanoid(), role: "user" as const, parts: [{ type: "text" as const, text: args.task }] },
              null,
            );
            ctx.stash({ task: args.task, phase: "running" });
            await orchestrator.engine.onLifetimeEvolution(session);
            orchestrator.broadcastMctsProgress("explore-completed");
            ctx.stash({ task: args.task, phase: "completed" });
            const best = orchestrator.sql<{ action: string; value: number }>`
              SELECT action, value FROM search_nodes WHERE status = 'terminal'
              ORDER BY value DESC LIMIT 1`;
            return best.length > 0
              ? `Exploration complete. Best approach (score ${best[0]!.value.toFixed(2)}): ${best[0]!.action}`
              : "Exploration complete. Check the MCTS tree for detailed results.";
          });
        } catch (err) {
          return `Exploration failed: ${(err as Error).message}`;
        }
      },
    });

    // ── Direct filesystem + shell tools ──────────────────────────
    // Each accepts optional `executor` param to route through a specific
    // provider (nimbus, sandbox, laptop). Default: workspace (SqliteFS).
    // These names overwrite Think's built-in workspace tools.

    tools.read = tool({
      description: "Read a file. Returns content with line numbers.",
      inputSchema: jsonSchema<{ path: string; offset?: number; limit?: number; executor?: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          offset: { type: "number", description: "1-indexed start line" },
          limit: { type: "number", description: "Max lines to return" },
          executor: { type: "string", description: "Executor name (workspace, nimbus, sandbox, laptop). Default: workspace." },
        },
        required: ["path"],
      }),
      execute: async (args: { path: string; offset?: number; limit?: number; executor?: string }) => {
        const exec = getExec(args.executor);
        if (exec?.tools.readFile) {
          const content = await exec.tools.readFile.execute(args.path) as string;
          if (content.startsWith("File not found")) return content;
          const lines = content.split("\n");
          const start = Math.max(0, (args.offset ?? 1) - 1);
          const end = args.limit ? start + args.limit : lines.length;
          return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n") || "(empty file)";
        }
        const content = await vfs.readFile(args.path, { encoding: "utf8" }) as string | null;
        if (content === null) return `File not found: ${args.path}`;
        const lines = content.split("\n");
        const start = Math.max(0, (args.offset ?? 1) - 1);
        const end = args.limit ? start + args.limit : lines.length;
        return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n") || "(empty file)";
      },
    });

    tools.write = tool({
      description: "Write content to a file. Creates parent directories.",
      inputSchema: jsonSchema<{ path: string; content: string; executor?: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "Content to write" },
          executor: { type: "string", description: "Executor (default: workspace)" },
        },
        required: ["path", "content"],
      }),
      execute: async (args: { path: string; content: string; executor?: string }) => {
        const exec = getExec(args.executor);
        if (exec?.tools.writeFile) return exec.tools.writeFile.execute(args.path, args.content) as Promise<string>;
        await vfs.writeFile(args.path, args.content);
        if (args.path.startsWith("memory/")) await memory.index(args.path);
        return `Written ${args.content.length} bytes to ${args.path}`;
      },
    });

    tools.edit = tool({
      description: "Targeted string replacement in a file.",
      inputSchema: jsonSchema<{ path: string; old_string: string; new_string: string; executor?: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          old_string: { type: "string", description: "Exact text to find (empty = create new file)" },
          new_string: { type: "string", description: "Replacement text" },
          executor: { type: "string", description: "Executor (default: workspace)" },
        },
        required: ["path", "old_string", "new_string"],
      }),
      execute: async (args: { path: string; old_string: string; new_string: string; executor?: string }) => {
        const exec = getExec(args.executor);
        const readFn = exec?.tools.readFile?.execute ?? (async (p: unknown) => await vfs.readFile(String(p), { encoding: "utf8" }));
        const writeFn = exec?.tools.writeFile?.execute ?? (async (p: unknown, c: unknown) => { await vfs.writeFile(String(p), String(c)); return `Written to ${p}`; });

        if (!args.old_string) {
          await writeFn(args.path, args.new_string);
          return `Created ${args.path} (${args.new_string.length} bytes)`;
        }
        const content = await readFn(args.path) as string | null;
        if (!content || content.startsWith?.("File not found")) return `File not found: ${args.path}`;
        if (!content.includes(args.old_string)) return `old_string not found in ${args.path}`;
        const count = content.split(args.old_string).length - 1;
        if (count > 1) return `Found ${count} matches — provide more context to identify a unique match`;
        await writeFn(args.path, content.replace(args.old_string, args.new_string));
        return `Edited ${args.path}`;
      },
    });

    tools.list = tool({
      description: "List files and directories at a path.",
      inputSchema: jsonSchema<{ path?: string; executor?: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (default: /)" },
          executor: { type: "string", description: "Executor (default: workspace)" },
        },
      }),
      execute: async (args: { path?: string; executor?: string }) => {
        const exec = getExec(args.executor);
        if (exec?.tools.readdir) {
          const entries = await exec.tools.readdir.execute(args.path || "/");
          return Array.isArray(entries) ? entries.join("\n") : String(entries);
        }
        const result = await shell.exec(`ls -la ${args.path || "/"}`);
        return result.stdout || "(empty directory)";
      },
    });

    tools.find = tool({
      description: "Find files matching a glob pattern.",
      inputSchema: jsonSchema<{ pattern: string; executor?: string }>({
        type: "object",
        properties: {
          pattern: { type: "string", description: 'Glob pattern (e.g. "**/*.ts")' },
          executor: { type: "string", description: "Executor (default: workspace)" },
        },
        required: ["pattern"],
      }),
      execute: async (args: { pattern: string; executor?: string }) => {
        const exec = getExec(args.executor);
        if (exec?.tools.exec) return exec.tools.exec.execute(`find / -name '${args.pattern}'`) as Promise<string>;
        const result = await shell.exec(`find / -name '${args.pattern}'`);
        return result.stdout || "No files found.";
      },
    });

    tools.grep = tool({
      description: "Search file contents using regex. Returns matching lines with paths and line numbers.",
      inputSchema: jsonSchema<{ pattern: string; path?: string; executor?: string }>({
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex or fixed string" },
          path: { type: "string", description: "Directory to search (default: /)" },
          executor: { type: "string", description: "Executor (default: workspace)" },
        },
        required: ["pattern"],
      }),
      execute: async (args: { pattern: string; path?: string; executor?: string }) => {
        const exec = getExec(args.executor);
        if (exec?.tools.exec) return exec.tools.exec.execute(`grep -rn '${args.pattern}' ${args.path || "/"}`) as Promise<string>;
        const result = await shell.exec(`grep -rn '${args.pattern}' ${args.path || "/"}`);
        return result.stdout || "No matches found.";
      },
    });

    tools.delete = tool({
      description: "Delete a file or directory.",
      inputSchema: jsonSchema<{ path: string; executor?: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Path to delete" },
          executor: { type: "string", description: "Executor (default: workspace)" },
        },
        required: ["path"],
      }),
      execute: async (args: { path: string; executor?: string }) => {
        const exec = getExec(args.executor);
        if (exec?.tools.exec) return exec.tools.exec.execute(`rm -rf ${args.path}`) as Promise<string>;
        await vfs.unlink(args.path);
        return `Deleted ${args.path}`;
      },
    });

    tools.shell_exec = tool({
      description: "Run a POSIX shell command. Supports cat, grep, find, sed, ls, tree, head, tail, wc, mkdir, rm, cp, mv, echo, sort, uniq. Pipes (|) and redirects (>, >>) work.",
      inputSchema: jsonSchema<{ command: string; executor?: string }>({
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command" },
          executor: { type: "string", description: "Executor (default: workspace)" },
        },
        required: ["command"],
      }),
      execute: async (args: { command: string; executor?: string }) => {
        const exec = getExec(args.executor);
        if (exec?.tools.exec) return exec.tools.exec.execute(args.command) as Promise<string>;
        const result = await shell.exec(args.command);
        if (result.exitCode !== 0) return `Error (exit ${result.exitCode}): ${result.stderr}`;
        return result.stdout || "(no output)";
      },
    });

    // ── Memory tools ─────────────────────────────────────────────
    tools.save_note = tool({
      description: "Save a note to long-term memory (MEMORY.md). FTS-indexed for later search.",
      inputSchema: jsonSchema<{ content: string }>({
        type: "object",
        properties: { content: { type: "string", description: "Note content" } },
        required: ["content"],
      }),
      execute: async (args: { content: string }) => {
        const ts = new Date().toISOString().split("T")[0];
        await memory.append("memory/MEMORY.md", `\n### Note (${ts})\n${args.content}\n`);
        await memory.index("memory/MEMORY.md");
        return "Note saved to memory.";
      },
    });

    tools.search_memory = tool({
      description: "Search long-term memory using full-text search. Returns matching passages.",
      inputSchema: jsonSchema<{ query: string }>({
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      }),
      execute: async (args: { query: string }) => {
        const results = await memory.search(args.query, 10);
        if (results.length === 0) return "No results found.";
        return results.map(r => `[${r.path}:${r.startLine}-${r.endLine}] (score ${r.score.toFixed(2)})\n${r.snippet}`).join("\n\n");
      },
    });

    tools.list_tools = tool({
      description: "List all available tools including dynamically crafted ones.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => {
        const builtIn = ["execute", "explore", "read", "write", "edit", "list", "find", "grep", "delete", "shell_exec", "save_note", "search_memory", "list_tools"];
        const crafted = craftStore.list();
        const lines = builtIn.map(n => `[built-in] ${n}`);
        for (const t of crafted) lines.push(`[crafted] ${t.name}: ${t.description}`);
        return lines.join("\n");
      },
    });

    console.log(`[proteus] getTools() returning: ${Object.keys(tools).join(", ")}`);
    return tools;
    } catch (err) {
      console.error("[proteus] getTools() FAILED:", err);
      throw err;
    }
  }

  configureSession(session: Session): Session {
    return session
      .withContext("memory", {
        description:
          "Long-term knowledge: learned facts, user preferences, project context, " +
          "discovered patterns, and crafted tool descriptions.",
        maxTokens: 32000,
      })
      .withCachedPrompt();
  }

  // ── Think lifecycle hooks ──────────────────────────────────────

  beforeTurn(_ctx: TurnContext): TurnConfig | void {
    this._turnToolCalls = [];
    this._turnStepCount = 0;
    this._turnStartedAt = Date.now();
    this._turnHadError = false;
    console.log("[proteus] beforeTurn fired");
  }

  afterToolCall(ctx: ToolCallResultContext): void {
    this._turnToolCalls.push({
      name: ctx.toolName,
      args: ctx.args,
      result: ctx.result,
    });
  }

  onStepFinish(_ctx: StepContext): void {
    this._turnStepCount++;
  }

  async onChatResponse(result: ChatResponseResult) {
    if (result.status !== "completed") return;

    const userMessages = this.messages.filter(m => m.role === "user");
    const lastUserMsg = userMessages[userMessages.length - 1];
    const userText = lastUserMsg?.parts
      ?.filter(p => p.type === "text")
      .map(p => (p as { type: "text"; text: string }).text)
      .join("") ?? "";

    const assistantText = result.message.parts
      ?.filter(p => p.type === "text")
      .map(p => (p as { type: "text"; text: string }).text)
      .join("") ?? "";

    const turn: CompletedTurn = {
      userMessage: userText,
      assistantResponse: assistantText,
      toolCalls: this._turnToolCalls,
      steps: this._turnStepCount,
      durationMs: this._turnStartedAt > 0 ? Date.now() - this._turnStartedAt : 0,
      feedback: null,
      hadError: this._turnHadError || result.status === "error",
    };

    // CRITICAL: Evolution hooks make LLM calls (reflection, extraction, session
    // reflection) that take 5-30 seconds each. onChatResponse runs INSIDE
    // Think's TurnQueue — if we await here, the queue is blocked and the next
    // message can't start processing until evolution finishes. The user sees
    // "nothing happens" for the second message.
    //
    // Fix: fire evolution asynchronously. The DO stays alive via keepAliveWhile
    // in the outer scope. Errors are caught and logged, never propagated.
    this._sessionTurnCount++;
    this._sessionTurns.push(turn);

    const sessionTrigger = this._sessionTurnCount >= SESSION_REFLECTION_INTERVAL;
    if (sessionTrigger) {
      const sessionData = {
        sessionId: `${this.ctx.id.toString()}-${Date.now()}`,
        turns: [...this._sessionTurns],
        startedAt: this._sessionStartedAt,
        endedAt: Date.now(),
      };
      this._sessionTurnCount = 0;
      this._sessionTurns = [];
      this._sessionStartedAt = Date.now();

      // Fire session evolution in background
      void this.engine.onSessionComplete(sessionData).catch(err =>
        console.error("[proteus] Session evolution failed:", err)
      );
    }

    // Fire turn-level evolution in background (does NOT block the TurnQueue)
    void this.engine.onTurnComplete(turn).catch(err =>
      console.error("[proteus] onTurnComplete failed:", err)
    );
  }

  // FIX 6: Fiber recovery — log and document
  async onFiberRecovered(ctx: { id: string; name: string; snapshot: unknown }) {
    console.log(`[proteus] Recovering fiber: ${ctx.name} (${ctx.id}), snapshot: ${ctx.snapshot ? "yes" : "none"}`);
    // If we had checkpointed MCTS progress, we could resume here.
    // For now, interrupted MCTS runs start fresh. The search_nodes data persists.
  }

  // ── DO initialization ──────────────────────────────────────────

  async onStart() {
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);

    // Migrate old schemas that conflict with agent-utils implementations.
    try {
      // vfs_files: old schema lacked chunk_index. SqliteFS needs it.
      const vfsCols = this.sql<{ name: string }>`PRAGMA table_info(vfs_files)`;
      if (vfsCols.length > 0 && !vfsCols.some(c => c.name === "chunk_index")) {
        execRaw("DROP TABLE vfs_files");
        console.log("[proteus] Migrated vfs_files to chunked schema");
      }
      // memory_chunks: old schema had 3 columns (id INTEGER, path, content).
      // MemoryStore needs 7 columns (id TEXT, path, start_line, end_line, hash, text, updated_at).
      const mcCols = this.sql<{ name: string }>`PRAGMA table_info(memory_chunks)`;
      if (mcCols.length > 0 && !mcCols.some(c => c.name === "start_line")) {
        execRaw("DROP TABLE IF EXISTS memory_chunks");
        execRaw("DROP TABLE IF EXISTS memory_chunks_fts");
        console.log("[proteus] Migrated memory_chunks to FTS5 schema");
      }
      // search_nodes: add code_used column if missing (new in this version)
      const snCols = this.sql<{ name: string }>`PRAGMA table_info(search_nodes)`;
      if (snCols.length > 0 && !snCols.some(c => c.name === "code_used")) {
        execRaw("ALTER TABLE search_nodes ADD COLUMN code_used TEXT");
        console.log("[proteus] Added code_used column to search_nodes");
      }
    } catch { /* tables don't exist yet — fine */ }

    initAllTables(execRaw);
    initSearchTables(execRaw);
    initScaffoldTables(execRaw);
    initCraftScoreTables(execRaw);

    execRaw(`CREATE TABLE IF NOT EXISTS agent_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    )`);

    try {
      const soul = this.sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`;
      if (soul.length === 0) {
        this.sql`INSERT INTO agent_soul (purpose) VALUES (${"A self-evolving coding assistant with MCTS exploration and durable skill evolution."})`;
      }
      const identity = this.sql<{ id: string }>`SELECT id FROM agent_identity LIMIT 1`;
      if (identity.length === 0) {
        this.sql`INSERT INTO agent_identity (id, name, created_at) VALUES (${this.ctx.id.toString()}, ${this.name}, ${Date.now()})`;
      }
      // Bootstrap scaffold if it doesn't exist — needed for scaffold mutation to work
      const scaffoldExists = await this.rt.identity.scaffold.exists();
      if (!scaffoldExists) {
        await bootstrapScaffold(this.rt);
        console.log("[proteus] Bootstrapped initial scaffold");
      }
    } catch (err) {
      console.error("[proteus] onStart init failed:", err);
    }
  }

  // ── Callable RPC methods ───────────────────────────────────────

  private getDisplayName(): string {
    try {
      const rows = this.sql<{ value: string }>`SELECT value FROM agent_config WHERE key = 'display_name' LIMIT 1`;
      return rows[0]?.value ?? this.name;
    } catch { return this.name; }
  }

  @callable()
  async getAgentStatus() {
    try {
      const rows = this.sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`;
      const purpose = rows[0]?.purpose ?? "";
      const identity = this.sql<{ id: string; name: string; created_at: number }>`
        SELECT id, name, created_at FROM agent_identity LIMIT 1`;
      const scaffoldVersion = this.sql<{ v: number }>`
        SELECT COALESCE(MAX(version), 0) as v FROM scaffold_versions`;
      const searchNodes = this.sql<{ c: number }>`SELECT COUNT(*) as c FROM search_nodes`;
      const craftedTools = this.sql<{ c: number }>`SELECT COUNT(*) as c FROM crafted_tools`;
      const messageCount = this.messages.length;
      return {
        id: identity[0]?.id ?? this.ctx.id.toString(),
        name: identity[0]?.name ?? this.name,
        displayName: this.getDisplayName(),
        purpose,
        createdAt: identity[0]?.created_at ?? 0,
        scaffoldVersion: scaffoldVersion[0]?.v ?? 0,
        searchNodeCount: searchNodes[0]?.c ?? 0,
        craftedToolCount: craftedTools[0]?.c ?? 0,
        messageCount,
        model: this.getStoredModelId(),
      };
    } catch {
      return { id: this.ctx.id.toString(), name: this.name, displayName: this.name, purpose: "", createdAt: 0,
        scaffoldVersion: 0, searchNodeCount: 0, craftedToolCount: 0, messageCount: 0, model: DEFAULT_MODEL };
    }
  }

  @callable() async getToolList() {
    const crafted = this.rt.craftStore.list().map(t => ({
      name: t.name, description: t.description, scope: t.scope,
    }));
    return {
      builtIn: [
        "execute", "explore",
        "read", "write", "edit", "list", "find", "grep", "delete",
        "shell_exec", "save_note", "search_memory", "list_tools",
      ],
      crafted,
    };
  }

  @callable() async doSearchMemory(query: string) { return this.rt.memory.search(query, 10); }

  @callable() async getMctsTree() {
    return this.sql`SELECT id, parent_id, depth, visits, value, status, action, task, observation, created_at
      FROM search_nodes ORDER BY depth, created_at`;
  }

  @callable() async getEvolutionEvents(limit: number = 50) {
    return this.sql`SELECT id, type, message, data, created_at
      FROM evolution_events ORDER BY created_at DESC LIMIT ${limit}`;
  }

  @callable() async getMemoryContent() {
    try { return await this.rt.memory.read("memory/MEMORY.md") ?? ""; }
    catch { return ""; }
  }

  @callable() async getToolDescriptions() {
    const builtIn = [
      { name: "execute", description: "Run JavaScript in a sandboxed codemode environment with workspace.*, nimbus.*, sandbox.*, laptop.* APIs." },
      { name: "explore", description: "MCTS tree search for complex subproblems. Spawns branches, evaluates, returns the best approach." },
      { name: "read", description: "Read a file with line numbers. Optional executor param for remote targets." },
      { name: "write", description: "Write content to a file. Creates parent directories. Optional executor param." },
      { name: "edit", description: "Targeted string replacement in a file. Optional executor param." },
      { name: "list", description: "List files and directories. Optional executor param." },
      { name: "find", description: "Find files matching a glob pattern. Optional executor param." },
      { name: "grep", description: "Search file contents with regex. Returns matches with line numbers. Optional executor param." },
      { name: "delete", description: "Delete a file or directory. Optional executor param." },
      { name: "shell_exec", description: "Run a POSIX shell command (cat, grep, find, sed, ls, etc.). Optional executor param." },
      { name: "save_note", description: "Save a note to long-term memory (MEMORY.md). FTS-indexed." },
      { name: "search_memory", description: "Search long-term memory using full-text search." },
      { name: "list_tools", description: "List all available tools including dynamically crafted ones." },
    ];
    const crafted = this.rt.craftStore.list().map(t => ({
      name: t.name, description: t.description || "Crafted tool", isLearned: true,
    }));
    const executors = this.rt.executionRouter?.listExecutors() ?? [];
    return { builtIn, crafted, executors };
  }

  @callable() async setModel(modelId: string) {
    this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('model', ${modelId})`;
    return { model: modelId };
  }

  @callable() async setDisplayName(displayName: string) {
    this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('display_name', ${displayName})`;
    return { displayName };
  }

  @callable() async getExecutors() {
    return this.rt.executionRouter?.listExecutors() ?? [];
  }

  @callable() async getExecutorOutput(executorId: string, limit: number = 50) {
    return this.sql`SELECT id, executor, command, stdout, stderr, exit_code, created_at
      FROM executor_output WHERE executor = ${executorId}
      ORDER BY created_at DESC LIMIT ${limit}`;
  }

  @callable() async executeInExecutor(executorId: string, command: string) {
    const provider = this.rt.executionRouter?.getProvider(executorId);
    if (!provider) return { error: `Executor "${executorId}" not found` };
    if (!provider.isAvailable()) return { error: `Executor "${executorId}" is not available` };

    const execTool = provider.tools.exec;
    if (!execTool) return { error: `Executor "${executorId}" has no exec tool` };

    try {
      const result = await execTool.execute(command);
      const stdout = typeof result === 'string' ? result : JSON.stringify(result);
      const isError = stdout.startsWith('Error') || stdout.startsWith('exit');

      this.sql`INSERT INTO executor_output (executor, command, stdout, stderr, exit_code)
        VALUES (${executorId}, ${command}, ${stdout}, ${isError ? stdout : ''}, ${isError ? 1 : 0})`;

      this.broadcast(JSON.stringify({
        type: 'executor-output', executor: executorId, command, stdout,
        stderr: isError ? stdout : '', exitCode: isError ? 1 : 0, timestamp: Date.now(),
      }));

      return { stdout, stderr: isError ? stdout : '', exitCode: isError ? 1 : 0 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.sql`INSERT INTO executor_output (executor, command, stderr, exit_code)
        VALUES (${executorId}, ${command}, ${errMsg}, ${1})`;
      return { error: errMsg, exitCode: 1 };
    }
  }

  @callable() async getExecutorFiles(executorId: string, path: string) {
    const provider = this.rt.executionRouter?.getProvider(executorId);
    if (!provider) return { error: `Executor "${executorId}" not found` };
    const readdirTool = provider.tools.readdir;
    if (!readdirTool) return { error: `Executor "${executorId}" has no readdir tool` };
    try {
      const result = await readdirTool.execute(path || '/');
      return { entries: result };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  @callable() async getAvailableModels() {
    return { current: this.getStoredModelId(), models: AVAILABLE_MODELS };
  }

  @callable() async setSoul(purpose: string) {
    this.sql`UPDATE agent_soul SET purpose = ${purpose}`;
    return { purpose };
  }

  @callable() async clearMemory() {
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);
    execRaw("DELETE FROM vfs_files WHERE path LIKE 'memory/%'");
    execRaw("DELETE FROM memory_chunks");
    try { execRaw("DELETE FROM memory_chunks_fts"); } catch { /* FTS table may not exist */ }
    return { cleared: true };
  }

  @callable() async resetMctsTree() {
    const execRaw = (ddl: string) => this.ctx.storage.sql.exec(ddl);
    execRaw("DELETE FROM search_nodes");
    return { cleared: true };
  }

  @callable() async getLogs(limit = 100) {
    // Collect evolution events as log entries
    const events = this.sql<{ id: string; type: string; message: string; created_at: number }>`
      SELECT id, type, message, created_at FROM evolution_events ORDER BY created_at DESC LIMIT ${limit}`;
    return events.map(e => ({
      id: e.id,
      time: e.created_at,
      type: e.type.includes("error") ? "error" as const : "evolution" as const,
      message: `[${e.type}] ${e.message}`,
    }));
  }

  @callable() async getMctsConfig() {
    const rows = this.sql<{ key: string; value: string }>`
      SELECT key, value FROM agent_config WHERE key IN ('mcts_c', 'mcts_iterations', 'mcts_depth', 'mcts_branches')`;
    const cfg: Record<string, string> = {};
    for (const r of rows) cfg[r.key] = r.value;
    return {
      explorationConstant: parseFloat(cfg.mcts_c ?? "1.414"),
      maxIterations: parseInt(cfg.mcts_iterations ?? "50"),
      maxDepth: parseInt(cfg.mcts_depth ?? "5"),
      branchBudget: parseInt(cfg.mcts_branches ?? "3"),
    };
  }

  @callable() async setMctsConfig(config: { explorationConstant?: number; maxIterations?: number; maxDepth?: number; branchBudget?: number }) {
    if (config.explorationConstant !== undefined) this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('mcts_c', ${String(config.explorationConstant)})`;
    if (config.maxIterations !== undefined) this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('mcts_iterations', ${String(config.maxIterations)})`;
    if (config.maxDepth !== undefined) this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('mcts_depth', ${String(config.maxDepth)})`;
    if (config.branchBudget !== undefined) this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('mcts_branches', ${String(config.branchBudget)})`;
    return config;
  }

  /**
   * Broadcast the current MCTS tree to all connected WebSocket clients.
   * Called after each MCTS iteration so the UI updates in real-time.
   */
  broadcastMctsProgress(phase: string, iteration?: number, budget?: number) {
    try {
      const nodes = this.sql`SELECT id, parent_id, depth, visits, value, status, action, task, observation, created_at
        FROM search_nodes ORDER BY depth, created_at`;
      this.broadcast(JSON.stringify({
        type: "mcts-progress",
        phase,
        iteration,
        budget,
        nodeCount: nodes.length,
        nodes,
      }));
    } catch (err) {
      console.warn("[proteus] broadcastMctsProgress failed:", err);
    }
  }

  @callable()
  async triggerEvolution(budget = 5) {
    // Outer fiber for durability + checkpointing. Nested fibers are supported
    // in the Agent SDK (each gets its own ID, cf_agents_runs row, ALS context).
    return this.runFiber("lifetime-evolution", async (ctx) => {
      ctx.stash({ phase: "starting", budget });
      this.broadcastMctsProgress("starting", 0, budget);
      const session = this.createMCTSSession();
      ctx.stash({ phase: "mcts", budget });
      await this.engine.onLifetimeEvolution(session);
      this.broadcastMctsProgress("completed");
      ctx.stash({ phase: "completed" });
      return { status: "completed", budget };
    });
  }

  // ── Internal: MCTS session writer ──────────────────────────────

  private createMCTSSession(): SessionWriter {
    const messages: Array<{ id: string; parentId: string | null; role: "user" | "assistant"; content: string }> = [];
    const agentSql = (strings: TemplateStringsArray, ...values: unknown[]) =>
      (this.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown[])(strings, ...values);

    return {
      async appendMessage(msg: SessionMessage, parentId?: string | null): Promise<void> {
        const content = msg.parts.map(p => p.text).join("");
        messages.push({ id: msg.id, parentId: parentId ?? null, role: msg.role, content });
        agentSql`INSERT INTO messages (id, session_id, parent_id, role, content)
          VALUES (${msg.id}, ${"mcts"}, ${parentId ?? null}, ${msg.role}, ${content})`;
      },
      getHistory(leafId?: string | null): Array<{ role: string; content: string }> {
        if (!leafId) return messages.map(m => ({ role: m.role, content: m.content }));
        const result: Array<{ role: string; content: string }> = [];
        let current = messages.find(m => m.id === leafId);
        while (current) {
          result.unshift({ role: current.role, content: current.content });
          current = current.parentId ? messages.find(m => m.id === current!.parentId) : undefined;
        }
        return result;
      },
      async compact(): Promise<void> {},
    };
  }
}
