/**
 * OrchestratorAgent — self-evolving chat agent extending Think.
 *
 * 5-tool architecture:
 *   execute_tools  — codemode sandbox with workspace.* + tools.* (crafted) APIs
 *   run            — POSIX shell command with optional executor routing
 *   explore        — MCTS tree search via durable fiber
 *   save_note      — append to MEMORY.md (FTS-indexed)
 *   search_memory  — FTS5 search over long-term memory
 *
 * All filesystem operations (read, write, edit, grep, find, etc.) are available
 * as workspace.* APIs inside the execute_tools codemode sandbox. Crafted tools
 * from the CraftStore are injected as tools.* inside the sandbox.
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
  ToolCallResultContext, StepContext, ChunkContext,
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
  { id: "@cf/moonshotai/kimi-k2.5", name: "Kimi K2.5", description: "Advanced reasoning model with extended thinking" },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout 17B", description: "General-purpose instruction model" },
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

  // ── Tool cache: avoid rebuilding 5-tool ToolSet + codemode types every turn ──
  private _cachedTools: ToolSet | null = null;
  private _cachedToolsKey: string = "";

  // ── Activity logging: persisted + broadcast to Logs pane ──
  private _turnT0 = 0;
  private _firstChunkReceived = false;

  private logActivity(event: string, detail?: string) {
    const elapsed = this._turnT0 > 0 ? Math.round(performance.now() - this._turnT0) : 0;
    const now = Date.now();
    console.log(`[proteus:${String(elapsed).padStart(6)}ms] ${event}${detail ? ` — ${detail}` : ""}`);
    try {
      this.sql`INSERT INTO activity_log (event, detail, elapsed_ms, created_at)
        VALUES (${event}, ${detail ?? null}, ${elapsed}, ${now})`;
    } catch { /* table may not exist on very first start */ }
    try {
      this.broadcast(JSON.stringify({
        type: "activity-log",
        event,
        detail: detail ?? null,
        elapsed,
        timestamp: now,
      }));
    } catch { /* no connections */ }
  }

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
    this.logActivity("getmodel");
    const model = this.createModel(this.getStoredModelId());
    return model;
  }

  getSystemPrompt(): string {
    this.logActivity("getsystemprompt_start");
    try {
      const rows = this.sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`;
      const purpose = rows[0]?.purpose ?? "You are a helpful coding assistant.";

      const prompt = `${purpose}

## Tools (5 tools)

### execute_tools
Write JavaScript to accomplish tasks. Your code runs in a sandboxed Worker with these APIs:

**workspace.*** — file and shell operations on your persistent virtual filesystem:
  workspace.readFile(path) → string
  workspace.writeFile(path, content) → "ok"
  workspace.readdir(path) → string[]
  workspace.exists(path) → boolean
  workspace.exec(command) → string — POSIX shell (cat, grep, find, sed, ls, head, tail, wc, mkdir, rm, cp, mv)
  workspace.searchMemory(query) → results
  workspace.saveNote(content) → "ok"
  workspace.listTools() → tool list
  workspace.createTool(name, description, code) → "ok"

**tools.*** — your learned tools from the CraftStore (improves over time):
  tools.<name>(args) — call any crafted tool by name

Use Promise.all for parallel operations. Return a value to see the result.

### run
Run a shell command directly: run({ command: "ls -la" })
Supports: cat, grep, find, sed, ls, tree, head, tail, wc, mkdir, rm, cp, mv, echo, sort, uniq.
Pipes (|) and redirects (>, >>) work. Pass executor to target nimbus/sandbox.

### explore
MCTS tree search for complex subproblems. Use for architecture decisions or multi-step problem solving.

### save_note
Save a note to long-term memory (FTS-indexed). Quick persist — no code needed.

### search_memory
Full-text search over long-term memory. Quick recall — no code needed.

## Evolution
Your capabilities improve automatically via CraftStore — good patterns become tools.* APIs inside execute_tools.
Summarize what you did after using tools.`;
      this.logActivity("getsystemprompt_end", `${prompt.length} chars`);
      return prompt;
    } catch {
      this.logActivity("getsystemprompt_end", "fallback");
      return "You are a helpful coding assistant.";
    }
  }

  /**
   * Compute a lightweight cache key from CraftStore state.
   * Uses count + max(updated_at) — two fast indexed queries on SQLite.
   * Returns "" if CraftStore is unavailable.
   */
  private _craftCacheKey(): string {
    try {
      const rows = this.sql<{ cnt: number; latest: number }>`
        SELECT COUNT(*) as cnt, COALESCE(MAX(updated_at), 0) as latest FROM crafted_tools`;
      const { cnt, latest } = rows[0] ?? { cnt: 0, latest: 0 };
      return `${cnt}:${latest}`;
    } catch { return ""; }
  }

  getTools(): ToolSet {
    // getTools() is the first subclass hook called by _runInferenceLoop.
    // Start the per-turn timer here to capture the full pre-inference path.
    this._turnT0 = performance.now();
    this.logActivity("gettools_start");

    // Fast path: return cached tools if CraftStore hasn't changed
    const cacheKey = this._craftCacheKey();
    if (this._cachedTools && cacheKey === this._cachedToolsKey) {
      this.logActivity("gettools_end", "cache hit");
      return this._cachedTools;
    }
    this.logActivity("gettools_rebuilding", `${this._cachedToolsKey} → ${cacheKey}`);

    try {
    const orchestrator = this;
    const env = this.env as Env & Record<string, unknown>;
    const tools: ToolSet = {};

    const router = this.rt.executionRouter;
    const memory = this.rt.memory;
    const craftStore = this.rt.craftStore;
    const shell = createShell(this.rt.sqliteFS);

    // ── 1. execute_tools: codemode sandbox with workspace.* + tools.* ──
    if (env.LOADER) {
      try {
        const providers = router?.getProviders() ?? [];

        // Inject crafted tools so they're callable as tools.* inside codemode
        const craftedToolSet: Record<string, { description: string; execute: Function }> = {};
        try {
          const crafted = craftStore.list();
          for (const t of crafted) {
            if (!t.code || t.code.startsWith("//")) continue;
            try {
              craftedToolSet[t.name] = {
                description: t.description || `Crafted tool: ${t.name}`,
                execute: new Function("return " + t.code)(),
              };
            } catch (e) {
              console.warn(`[proteus] Skipping broken crafted tool "${t.name}":`, (e as Error).message);
            }
          }
        } catch { /* CraftStore may not be initialized yet */ }

        tools.execute_tools = createExecuteTool({
          tools: craftedToolSet,
          providers,
          loader: env.LOADER as WorkerLoader,
        });
      } catch (err) {
        console.error("[proteus] createExecuteTool FAILED:", (err as Error).message, (err as Error).stack);
      }
    } else {
      // Fallback: register a basic execute_tools that uses new Function()
      const vfs = this.rt.storage.vfs;
      tools.execute_tools = tool({
        description: "Execute JavaScript code. Available APIs: workspace.readFile(path), workspace.writeFile(path, content), workspace.exec(command), workspace.searchMemory(query), workspace.saveNote(content). (Running in unsandboxed fallback mode.)",
        inputSchema: jsonSchema<{ code: string }>({
          type: "object",
          properties: { code: { type: "string", description: "JavaScript code to execute" } },
          required: ["code"],
        }),
        execute: async (args: { code: string }) => {
          try {
            const workspaceApi = {
              readFile: async (path: string) => {
                const content = await vfs.readFile(path, { encoding: "utf8" });
                return content ?? `File not found: ${path}`;
              },
              writeFile: async (path: string, content: string) => {
                await vfs.writeFile(path, content);
                return `Written ${content.length} bytes to ${path}`;
              },
              exec: async (command: string) => {
                const result = await shell.exec(command);
                if (result.exitCode !== 0) return `Error (exit ${result.exitCode}): ${result.stderr}`;
                return result.stdout || "(no output)";
              },
              readdir: async (path: string) => vfs.readdir(path),
              exists: async (path: string) => vfs.exists(path),
              searchMemory: async (query: string) => {
                const results = await memory.search(query, 10);
                return results.map(r => `[${r.path}] ${r.snippet}`).join("\n") || "No results.";
              },
              saveNote: async (content: string) => {
                const ts = new Date().toISOString().split("T")[0];
                await memory.append("memory/MEMORY.md", `\n### Note (${ts})\n${content}\n`);
                await memory.index("memory/MEMORY.md");
                return "Note saved.";
              },
            };
            const fn = new Function("workspace", `return (async () => {\n${args.code}\n})()`);
            const result = await fn(workspaceApi);
            return { result: result === undefined ? "(no return value)" : result };
          } catch (e) {
            return { result: undefined, error: (e as Error).message };
          }
        },
      });
    }

    // ── 2. run: shell command with optional executor routing ──
    tools.run = tool({
      description: "Run a shell command. Supports: cat, grep, find, sed, ls, tree, head, tail, wc, mkdir, rm, cp, mv, echo, sort, uniq. Pipes and redirects work.",
      inputSchema: jsonSchema<{ command: string; executor?: string }>({
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          executor: { type: "string", description: "Target executor: workspace (default), nimbus, sandbox" },
        },
        required: ["command"],
      }),
      execute: async (args: { command: string; executor?: string }) => {
        if (args.executor && args.executor !== "workspace") {
          const exec = router?.getProvider(args.executor);
          if (exec?.tools.exec) return exec.tools.exec.execute(args.command) as Promise<string>;
          return `Executor "${args.executor}" not available.`;
        }
        const result = await shell.exec(args.command);
        if (result.exitCode !== 0) return `Error (exit ${result.exitCode}): ${result.stderr}`;
        return result.stdout || "(no output)";
      },
    });

    // ── 3. explore: MCTS ──
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
        console.log(`[proteus] explore called: task="${args.task.slice(0, 80)}", budget=${args.budget ?? "default"}`);
        try {
          return await orchestrator.runFiber(`explore-${Date.now()}`, async (ctx) => {
            console.log("[proteus] explore fiber started");
            ctx.stash({ task: args.task, phase: "starting" });
            orchestrator.broadcastMctsProgress("explore-starting");
            const session = orchestrator.createMCTSSession();
            const { nanoid } = await import("@proteus/core");
            await session.appendMessage(
              { id: nanoid(), role: "user" as const, parts: [{ type: "text" as const, text: args.task }] },
              null,
            );
            ctx.stash({ task: args.task, phase: "running" });
            console.log("[proteus] explore: calling onLifetimeEvolution");
            await orchestrator.engine.onLifetimeEvolution(session);
            console.log("[proteus] explore: onLifetimeEvolution completed");
            orchestrator.broadcastMctsProgress("explore-completed");
            ctx.stash({ task: args.task, phase: "completed" });
            const allNodes = orchestrator.sql<{ id: string; action: string; value: number; status: string }>`
              SELECT id, action, value, status FROM search_nodes ORDER BY value DESC`;
            console.log(`[proteus] explore: ${allNodes.length} search nodes found`);
            const best = allNodes.find(n => n.status === "terminal") ?? allNodes[0];
            if (best && best.action) {
              return `Exploration complete (${allNodes.length} nodes). Best approach (score ${best.value.toFixed(2)}): ${best.action}`;
            }
            return `Exploration complete. ${allNodes.length} nodes explored. Check the MCTS tree for results.`;
          });
        } catch (err) {
          console.error("[proteus] explore FAILED:", (err as Error).message, (err as Error).stack);
          return `Exploration failed: ${(err as Error).message}`;
        }
      },
    });

    // ── 4. save_note: quick memory persist ──
    tools.save_note = tool({
      description: "Save a note to long-term memory (FTS-indexed for later search).",
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

    // ── 5. search_memory: quick memory recall ──
    tools.search_memory = tool({
      description: "Full-text search over long-term memory. Returns matching passages.",
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

    // Cache the result for subsequent turns
    this._cachedTools = tools;
    this._cachedToolsKey = cacheKey;
    this.logActivity("gettools_end", `rebuilt — ${Object.keys(tools).length} tools`);
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

  // Tools the model is allowed to call. Think merges workspace tools (read, write,
  // edit, list, find, grep, delete) with ours, bloating the request by ~2800 tokens.
  // activeTools restricts the model to only our 5 tools + session context tools,
  // preventing Think's workspace tools from being sent in the request payload.
  private static readonly ACTIVE_TOOLS = [
    "execute_tools", "run", "explore", "save_note", "search_memory",
    "set_context", "load_context", "search_context",
  ];

  beforeTurn(_ctx: TurnContext): TurnConfig | void {
    this._turnToolCalls = [];
    this._turnStepCount = 0;
    this._turnStartedAt = Date.now();
    this._turnHadError = false;
    this._firstChunkReceived = false;
    this.logActivity("beforeturn", "streamText() called next");
    return { activeTools: OrchestratorAgent.ACTIVE_TOOLS };
  }

  onChunk(_ctx: ChunkContext): void {
    if (!this._firstChunkReceived) {
      this._firstChunkReceived = true;
      this.logActivity("first_chunk");
    }
  }

  afterToolCall(ctx: ToolCallResultContext): void {
    this.logActivity("tool_call_end", ctx.toolName);
    this._turnToolCalls.push({
      name: ctx.toolName,
      args: ctx.args,
      result: ctx.result,
    });
  }

  onStepFinish(_ctx: StepContext): void {
    this._turnStepCount++;
    this.logActivity("step_finish", `step ${this._turnStepCount}`);
  }

  async onChatResponse(result: ChatResponseResult) {
    this.logActivity("response_complete", result.status);
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
    const crafted = this.rt.craftStore.list().map(t => {
      const scoreRow = this.sql<{ score: number; uses: number }>`
        SELECT score, uses FROM craft_scores WHERE tool_name = ${t.name} LIMIT 1`;
      return {
        name: t.name, description: t.description, scope: t.scope,
        qualityScore: scoreRow[0]?.score ?? 0.5,
        usageCount: scoreRow[0]?.uses ?? 0,
      };
    });
    return {
      builtIn: ["execute_tools", "run", "explore", "save_note", "search_memory"],
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
      { name: "execute_tools", description: "Write JS to accomplish tasks. workspace.* for files/shell, tools.* for learned patterns. Runs in sandboxed Worker." },
      { name: "run", description: "Run a POSIX shell command (cat, grep, find, sed, ls, etc.). Optional executor param for nimbus/sandbox." },
      { name: "explore", description: "MCTS tree search for complex subproblems. Spawns branches, evaluates, returns the best approach." },
      { name: "save_note", description: "Save a note to long-term memory (MEMORY.md). FTS-indexed for later search." },
      { name: "search_memory", description: "Search long-term memory using full-text search. Returns matching passages." },
    ];
    const craftedRaw = this.rt.craftStore.list();
    const crafted = craftedRaw.map(t => {
      const scoreRow = this.sql<{ score: number; uses: number }>`
        SELECT score, uses FROM craft_scores WHERE tool_name = ${t.name} LIMIT 1`;
      return {
        name: t.name,
        description: t.description || "Crafted tool",
        isLearned: true,
        qualityScore: scoreRow[0]?.score ?? 0.5,
        usageCount: scoreRow[0]?.uses ?? 0,
      };
    });
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
    // Merge evolution events + activity log, return newest first
    const evoRows = this.sql<{ id: string; type: string; message: string; created_at: number }>`
      SELECT id, type, message, created_at FROM evolution_events ORDER BY created_at DESC LIMIT ${limit}`;
    const evoLogs = evoRows.map(e => ({
      id: e.id,
      time: e.created_at,
      type: e.type.includes("error") ? "error" as const : "evolution" as const,
      message: `[${e.type}] ${e.message}`,
    }));
    let actLogs: Array<{ id: string; time: number; type: "info"; message: string; detail?: string }> = [];
    try {
      const actRows = this.sql<{ id: string; event: string; detail: string | null; elapsed_ms: number; created_at: number }>`
        SELECT id, event, detail, elapsed_ms, created_at FROM activity_log ORDER BY created_at DESC LIMIT ${limit}`;
      actLogs = actRows.map(a => ({
        id: a.id,
        time: a.created_at,
        type: "info" as const,
        message: `[${a.elapsed_ms}ms] ${a.event}`,
        detail: a.detail ?? undefined,
      }));
    } catch { /* table may not exist yet */ }
    const merged = [...evoLogs, ...actLogs];
    merged.sort((a, b) => b.time - a.time);
    return merged.slice(0, limit);
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
  async getActivityLog(limit = 100) {
    try {
      return this.sql<{ id: string; event: string; detail: string | null; elapsed_ms: number; created_at: number }>`
        SELECT id, event, detail, elapsed_ms, created_at FROM activity_log
        ORDER BY created_at DESC LIMIT ${limit}`;
    } catch { return []; }
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
