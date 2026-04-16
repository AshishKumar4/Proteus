/**
 * OrchestratorAgent — self-evolving chat agent extending Think.
 *
 * Think auto-includes workspace tools (read, write, edit, list, find, grep, delete)
 * that target Think's internal Workspace storage. We OVERWRITE all 7 with our own
 * SqliteFS-backed implementations in getTools(), unifying the two filesystems.
 *
 * The merge order in Think._runInferenceLoop is:
 *   { ...workspaceTools, ...baseTools(getTools()), ...extensions, ... }
 * Our tools come AFTER Think's, so same-named keys replace them.
 *
 * Consolidated tool list (no duplicates):
 *   Filesystem: read, write, edit, list, find, grep, delete (SqliteFS)
 *   Shell:      shell_exec (POSIX emulator over SqliteFS)
 *   Memory:     search_memory, save_note
 *   Code:       execute_code (codemode sandbox or new Function fallback)
 *   Meta:       list_tools, explore (MCTS)
 *   Dynamic:    crafted tools from CraftStore
 */

import { callable } from "agents";
import { Think, Session } from "@cloudflare/think";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { tool, jsonSchema } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import type {
  TurnContext, TurnConfig, ChatResponseResult,
  ToolCallResultContext, StepContext,
} from "@cloudflare/think";
import {
  EvolutionEngine,
  buildAgentTools,
  bootstrapScaffold,
  initAllTables, initSearchTables, initScaffoldTables, initCraftScoreTables,
  resolveMaxSteps,
  type CompletedTurn, type ToolCallRecord, type AgentRuntime,
  type SessionWriter, type SessionMessage,
} from "@proteus/core";
import { createShell } from "@proteus/agent-utils/shell";
import { createCFRuntime, type CFRuntime } from "./runtime.js";

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

After using tools, summarize what you did.
Use read/write/edit for file operations. Use list/find/grep to browse and search files.
Use shell_exec for complex commands (pipes, redirects, sed, awk).
Use save_note to remember important facts. Use search_memory to recall them.
Use explore to deeply investigate a complex subproblem with MCTS.`;
    } catch {
      return "You are a helpful coding assistant.";
    }
  }

  getTools(): ToolSet {
    console.log("[proteus] getTools() called");
    try {
    // Start with core tools (search_memory, save_note, execute_code, list_tools)
    const coreTools = buildAgentTools(this.rt);

    // Remove old read_file/write_file — replaced by unified read/write below
    delete coreTools.read_file;
    delete coreTools.write_file;

    // ── Unified filesystem tools ─────────────────────────────────
    // These use the SAME names as Think's workspace tools (read, write, edit,
    // list, find, grep, delete) so they overwrite Think's implementations.
    // All backed by SqliteFS — one filesystem, zero confusion.

    const vfs = this.rt.storage.vfs;
    const shell = createShell(this.rt.sqliteFS);

    const fsTools: ToolSet = {
      read: tool({
        description: "Read a file from the workspace. Returns content with line numbers. Use offset/limit for large files.",
        inputSchema: jsonSchema<{ path: string; offset?: number; limit?: number }>({
          type: "object",
          properties: {
            path: { type: "string", description: "File path to read" },
            offset: { type: "number", description: "1-indexed line to start from" },
            limit: { type: "number", description: "Max lines to return" },
          },
          required: ["path"],
        }),
        execute: async (args: { path: string; offset?: number; limit?: number }) => {
          const content = await vfs.readFile(args.path, { encoding: "utf8" }) as string | null;
          if (content === null) return `File not found: ${args.path}`;
          const lines = content.split("\n");
          const start = Math.max(0, (args.offset ?? 1) - 1);
          const end = args.limit ? start + args.limit : lines.length;
          return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n") || "(empty file)";
        },
      }),

      write: tool({
        description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Parent directories are created automatically.",
        inputSchema: jsonSchema<{ path: string; content: string }>({
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            content: { type: "string", description: "Content to write" },
          },
          required: ["path", "content"],
        }),
        execute: async (args: { path: string; content: string }) => {
          await vfs.writeFile(args.path, args.content);
          // Auto-index memory files for FTS search
          if (args.path.startsWith("memory/")) {
            await this.rt.memory.index(args.path);
          }
          return `Written ${args.content.length} bytes to ${args.path}`;
        },
      }),

      edit: tool({
        description: "Make a targeted edit to a file by replacing an exact string match.",
        inputSchema: jsonSchema<{ path: string; old_string: string; new_string: string }>({
          type: "object",
          properties: {
            path: { type: "string", description: "File path to edit" },
            old_string: { type: "string", description: "Exact text to find" },
            new_string: { type: "string", description: "Replacement text" },
          },
          required: ["path", "old_string", "new_string"],
        }),
        execute: async (args: { path: string; old_string: string; new_string: string }) => {
          if (!args.old_string) {
            // Empty old_string = create new file
            await vfs.writeFile(args.path, args.new_string);
            return `Created ${args.path} (${args.new_string.length} bytes)`;
          }
          const content = await vfs.readFile(args.path, { encoding: "utf8" }) as string | null;
          if (content === null) return `File not found: ${args.path}`;
          if (!content.includes(args.old_string)) return `old_string not found in ${args.path}`;
          const count = content.split(args.old_string).length - 1;
          if (count > 1) return `Found ${count} matches — provide more context to identify the unique match`;
          await vfs.writeFile(args.path, content.replace(args.old_string, args.new_string));
          return `Edited ${args.path}`;
        },
      }),

      list: tool({
        description: "List files and directories at a path. Returns names and types.",
        inputSchema: jsonSchema<{ path?: string }>({
          type: "object",
          properties: { path: { type: "string", description: "Directory path (default: /)" } },
        }),
        execute: async (args: { path?: string }) => {
          const result = await shell.exec(`ls -la ${args.path || "/"}`);
          return result.stdout || "(empty directory)";
        },
      }),

      find: tool({
        description: "Find files matching a glob pattern. Supports *, **, ? wildcards.",
        inputSchema: jsonSchema<{ pattern: string }>({
          type: "object",
          properties: { pattern: { type: "string", description: 'Glob pattern (e.g. "**/*.ts")' } },
          required: ["pattern"],
        }),
        execute: async (args: { pattern: string }) => {
          const result = await shell.exec(`find / -name '${args.pattern}'`);
          return result.stdout || "No files found.";
        },
      }),

      grep: tool({
        description: "Search file contents using a regex pattern. Returns matching lines with file paths and line numbers.",
        inputSchema: jsonSchema<{ pattern: string; path?: string }>({
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex or fixed string to search for" },
            path: { type: "string", description: "Directory to search in (default: /)" },
          },
          required: ["pattern"],
        }),
        execute: async (args: { pattern: string; path?: string }) => {
          const result = await shell.exec(`grep -rn '${args.pattern}' ${args.path || "/"}`);
          return result.stdout || "No matches found.";
        },
      }),

      delete: tool({
        description: "Delete a file or directory.",
        inputSchema: jsonSchema<{ path: string }>({
          type: "object",
          properties: { path: { type: "string", description: "Path to delete" } },
          required: ["path"],
        }),
        execute: async (args: { path: string }) => {
          await vfs.unlink(args.path);
          return `Deleted ${args.path}`;
        },
      }),
    };

    // ── Shell emulator ───────────────────────────────────────────

    const shellTool: ToolSet = {
      shell_exec: tool({
        description: "Execute a POSIX shell command over the agent's virtual filesystem. " +
          "Supports: cat, head, tail, ls, tree, find, grep, echo, mkdir, touch, rm, cp, mv, sed, stat, wc. " +
          "Pipelines (|), redirects (>, >>), and chaining (&&, ||, ;) are supported. " +
          "Does NOT execute real programs — use execute_code for that.",
        inputSchema: jsonSchema<{ command: string }>({
          type: "object",
          properties: { command: { type: "string", description: "Shell command to execute" } },
          required: ["command"],
        }),
        execute: async (args: { command: string }) => {
          const result = await shell.exec(args.command);
          if (result.exitCode !== 0) return `Error (exit ${result.exitCode}): ${result.stderr}`;
          return result.stdout || "(no output)";
        },
      }),
    };

    // ── Explore tool (MCTS) ──────────────────────────────────────

    const orchestrator = this;
    const exploreTool: ToolSet = {
      explore: tool({
        description: "Deeply explore a complex subproblem using Monte Carlo Tree Search. " +
          "Spawns multiple exploration branches, evaluates them, and returns the best approach.",
        inputSchema: jsonSchema<{ task: string; budget?: number }>({
          type: "object",
          properties: {
            task: { type: "string", description: "The subproblem to explore" },
            budget: { type: "number", description: "Number of MCTS iterations (default: 2)" },
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
              if (best.length > 0) {
                return `Exploration complete. Best approach (score ${best[0]!.value.toFixed(2)}): ${best[0]!.action}`;
              }
              return "Exploration complete. Check the MCTS tree for detailed results.";
            });
          } catch (err) {
            return `Exploration failed: ${(err as Error).message}`;
          }
        },
      }),
    };

    // ── Merge all tools ──────────────────────────────────────────
    // Order: core domain tools, then fs tools (overwrite Think's workspace),
    // then shell, explore, codemode upgrade.

    const tools: ToolSet = {
      ...coreTools,
      ...fsTools,
      ...shellTool,
      ...exploreTool,
    };

    // Codemode execute (sandboxed Worker) when LOADER binding available
    const env = this.env as Env & Record<string, unknown>;
    if (env.LOADER) {
      try {
        tools.execute_code = createExecuteTool({
          tools,
          loader: env.LOADER as WorkerLoader,
        });
      } catch (err) {
        console.warn("[proteus] createExecuteTool failed:", (err as Error).message);
      }
    }

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
        "read", "write", "edit", "list", "find", "grep", "delete",
        "shell_exec", "search_memory", "save_note", "execute_code",
        "list_tools", "explore",
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
      // Filesystem (SqliteFS — unified, overwrites Think's workspace tools)
      { name: "read", description: "Read a file with line numbers. Supports offset/limit for large files." },
      { name: "write", description: "Write content to a file. Creates parent directories automatically." },
      { name: "edit", description: "Targeted string replacement in a file (find old_string, replace with new_string)." },
      { name: "list", description: "List files and directories at a path." },
      { name: "find", description: "Find files matching a glob pattern (*, **, ?)." },
      { name: "grep", description: "Search file contents using regex. Returns matching lines with paths and line numbers." },
      { name: "delete", description: "Delete a file or directory." },
      // Shell
      { name: "shell_exec", description: "POSIX shell: cat, head, tail, ls, tree, find, grep, sed, wc, echo, mkdir, rm, cp, mv. Pipes and redirects supported." },
      // Memory
      { name: "search_memory", description: "Search long-term memory using FTS5 full-text search." },
      { name: "save_note", description: "Save a note to long-term memory (MEMORY.md) with FTS5 indexing." },
      // Code
      { name: "execute_code", description: "Execute JavaScript code in a sandboxed environment." },
      // Meta
      { name: "list_tools", description: "List all available tools including dynamically crafted ones." },
      { name: "explore", description: "MCTS exploration on a complex subproblem via durable fiber." },
    ];
    const crafted = this.rt.craftStore.list().map(t => ({
      name: t.name, description: t.description || "Crafted tool", isLearned: true,
    }));
    return { builtIn, crafted };
  }

  @callable() async setModel(modelId: string) {
    this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('model', ${modelId})`;
    return { model: modelId };
  }

  @callable() async setDisplayName(displayName: string) {
    this.sql`INSERT OR REPLACE INTO agent_config (key, value) VALUES ('display_name', ${displayName})`;
    return { displayName };
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
