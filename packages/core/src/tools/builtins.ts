/**
 * The canonical 5-tool factory. This replaces the inline tool construction
 * in cf-backend/orchestrator.ts:201-413 and the legacy 6-tool surface in
 * evolution/tools.ts. Both CF and CLI surfaces call this — the single source
 * of truth for the LLM's capability surface.
 *
 * Tools emitted (in registration order):
 *   1. execute_tools  — codemode sandbox OR new-Function fallback
 *   2. run            — shell via executionRouter, workspace fallback to rt.shell
 *   3. explore        — MCTS via engine.onLifetimeEvolution
 *   4. save_note      — memory.append + memory.index
 *   5. search_memory  — memory.search
 *
 * Platform specifics (codemode loader, fiber wrap, MCTS broadcaster, MCTS
 * session factory) are injected through BuiltinToolDeps so the factory stays
 * portable. CF passes all of them; CLI passes none and gets sensible defaults.
 */

import { tool, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { EvolutionEngine } from '../evolution/engine.js';
import type { SessionWriter } from '../mcts/record-node.js';
import { BUILTIN_TOOL_DESCRIPTIONS } from './registry.js';
import { loadFilteredCraftedTools } from './crafted.js';
import type { CraftedToolExecute } from './crafted-executor.js';
import { effectiveScore } from '../craft/ema.js';
import { DEFAULT_CONFIG } from '../config.js';
import { nanoid } from '../utils/nanoid.js';

/**
 * Narrow local shape of @cloudflare/think/tools/execute#createExecuteTool.
 * Duck-typed so core has no peer dep on @cloudflare/think or @cloudflare/codemode.
 */
export type CreateExecuteToolFactory = (opts: {
  tools: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>;
  providers: unknown[];
  loader: unknown;
}) => unknown;

export interface BuiltinToolDeps {
  rt: AgentRuntime;
  /** EvolutionEngine — required for the `explore` tool to trigger MCTS. */
  engine: EvolutionEngine;
  /**
   * Optional CF codemode loader (env.LOADER). When present, `execute_tools`
   * is built via createExecuteTool (real Worker sandbox). When absent, falls
   * back to the new-Function+workspaceApi path — same semantics as the
   * current CF fallback at orchestrator.ts:258-301, also used by CLI.
   */
  codemodeLoader?: unknown;
  /**
   * Optional factory for createExecuteTool, injected by the CF adapter to
   * avoid pulling @cloudflare/think into core. Called only when
   * codemodeLoader is set.
   */
  createExecuteTool?: CreateExecuteToolFactory;
  /** Broadcast MCTS progress (CF pushes to WS; CLI is no-op). */
  onMctsProgress?: (phase: string, iteration?: number, budget?: number) => void;
  /** Factory for the SessionWriter used by `explore`. Default: in-memory. */
  createMctsSession?: () => SessionWriter;
  /**
   * Wrap the `explore` execute function — CF wraps with runFiber for durable
   * checkpointing. CLI omits (no-op wrap).
   */
  wrapExplore?: (
    fn: (args: { task: string; budget?: number }) => Promise<string>,
  ) => (args: { task: string; budget?: number }) => Promise<string>;
  /**
   * Called from inside the explore body at phase transitions so the adapter
   * can (e.g.) checkpoint via ctx.stash. Fires at 'starting' before MCTS,
   * 'running' after session setup, and 'completed' after engine returns.
   */
  onExplorePhase?: (phase: 'starting' | 'running' | 'completed', task: string) => void;
  /** Filter cutoff override (default: DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection). */
  minEffectiveScore?: number;
  /**
   * Platform-correct crafted-tool executor factory.
   *
   * - CF adapter supplies a LOADER-backed implementation that spawns a child
   *   Worker per tool via `env.LOADER.get(toolName, factory)`. Modules are
   *   compiled by workerd, sidestepping V8's codegen ban.
   * - CLI adapter supplies a `new Function(code)()` implementation. Node/Bun
   *   allows codegen, so this is fast and safe there.
   * - Absent: crafted tools are skipped silently (warn). Kept as an escape
   *   hatch for test runtimes / in-memory fixtures that don't wire an adapter.
   *
   * When present, this REPLACES the legacy `loadFilteredCraftedTools({invocation:
   * 'inline-function'})` host-side `new Function` path. When absent, the legacy
   * path is retained (Phases B/C fill in the adapters; Phase E removes the
   * legacy path entirely).
   */
  craftedToolExecute?: CraftedToolExecute;
}

/**
 * Build the crafted-tool map using a platform-correct executor factory.
 * Drops the host-side `new Function` path entirely — each tool's execute is
 * produced by `craftedToolExecute(tool)` which dispatches appropriately for
 * the runtime (LOADER Worker on CF, `new Function` on Node).
 *
 * Filter semantics match `loadFilteredCraftedTools`: effective-score >=
 * minScore, comment-only code dropped, every observed name recorded into
 * `preexistingNames`.
 */
function buildCraftedToolSetFromExecute(
  rt: AgentRuntime,
  factory: CraftedToolExecute,
  minScore: number,
  preexistingNames: Set<string>,
): Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }> {
  const out: Record<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }> = {};
  let list;
  try {
    list = rt.craftStore.list();
  } catch {
    return out;
  }

  const now = Date.now();
  const scores = new Map<string, { score: number; lastUsedAt: number }>();
  try {
    const rows = rt.storage.sql<{ tool_name: string; score: number; last_used_at: number }>`
      SELECT tool_name, score, last_used_at FROM craft_scores`;
    for (const r of rows) scores.set(r.tool_name, { score: r.score, lastUsedAt: r.last_used_at });
  } catch {
    // craft_scores may not exist yet; treat all tools as unscored
  }

  for (const t of list) preexistingNames.add(t.name);

  for (const t of list) {
    if (!t.code || t.code.startsWith('//')) continue;
    const s = scores.get(t.name);
    if (s) {
      const eff = effectiveScore(s.score, s.lastUsedAt, now);
      if (eff < minScore) continue;
    }
    const description = t.description || `Crafted tool: ${t.name}`;
    try {
      const execute = factory({ name: t.name, description, code: t.code });
      out[t.name] = { description, execute: async (arg: unknown) => execute(arg) };
    } catch (err) {
      console.warn(`[proteus] Skipping broken crafted tool "${t.name}":`, (err as Error).message);
    }
  }

  return out;
}

/** Default in-memory SessionWriter when no backend-specific one is provided. */
function createInMemorySession(): SessionWriter {
  const messages: Array<{ message: { id: string; role: string; parts: unknown[] }; parentId: string | null }> = [];
  return {
    async appendMessage(message, parentId) {
      messages.push({ message: message as never, parentId: parentId ?? null });
    },
    getHistory() {
      return messages.map((m) => ({
        role: m.message.role,
        content: m.message.parts.map((p: unknown) => (p as { text?: string }).text ?? '').join(''),
      }));
    },
    async compact() {
      /* no-op */
    },
  };
}

export function buildBuiltinTools(deps: BuiltinToolDeps): ToolSet {
  const { rt, engine } = deps;
  const memory = rt.memory;
  const router = rt.executionRouter;
  const shell = rt.shell;
  const vfs = rt.storage.vfs;

  const tools: ToolSet = {};

  // ── 1. execute_tools ─────────────────────────────────────────────────────
  // We track pre-existing tool names (regardless of whether they passed the
  // filter) so the live-lookup Proxy below can respect score-based filtering
  // while still allowing same-turn createTool() → codemode.<name> invocation.
  const preexistingCraftNames = new Set<string>();
  const craftedToolSet = deps.craftedToolExecute
    ? buildCraftedToolSetFromExecute(
        rt,
        deps.craftedToolExecute,
        deps.minEffectiveScore ?? DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection,
        preexistingCraftNames,
      )
    : loadFilteredCraftedTools(rt, {
        invocation: 'inline-function',
        minScore: deps.minEffectiveScore ?? DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection,
        recordPreexisting: preexistingCraftNames,
      });

  if (deps.codemodeLoader && deps.createExecuteTool) {
    try {
      const providers = router?.getProviders() ?? [];
      tools.execute_tools = deps.createExecuteTool({
        tools: craftedToolSet,
        providers,
        loader: deps.codemodeLoader,
      }) as ToolSet[string];
    } catch (err) {
      console.error('[proteus] createExecuteTool FAILED:', (err as Error).message);
    }
  }

  // Fallback when no codemode loader or createExecuteTool factory:
  // new-Function + workspaceApi. Semantics match the CF fallback at
  // orchestrator.ts:258-301 exactly, minus the loader path.
  if (!tools.execute_tools) {
    tools.execute_tools = tool({
      description:
        BUILTIN_TOOL_DESCRIPTIONS.execute_tools +
        ' (fallback mode — workspace.* APIs only, no codemode sandbox)',
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object',
        properties: { code: { type: 'string', description: 'JavaScript code to execute' } },
        required: ['code'],
      }),
      execute: async (args: { code: string }) => {
        try {
          const workspaceApi = {
            readFile: async (path: string) => {
              const content = await vfs.readFile(path, { encoding: 'utf8' });
              return content ?? `File not found: ${path}`;
            },
            writeFile: async (path: string, content: string) => {
              await vfs.writeFile(path, content);
              return `Written ${content.length} bytes to ${path}`;
            },
            exec: async (command: string) => {
              if (!shell) return 'Error: no shell available in this runtime.';
              const result = await shell.exec(command);
              if (result.exitCode !== 0) return `Error (exit ${result.exitCode}): ${result.stderr}`;
              return result.stdout || '(no output)';
            },
            readdir: async (path: string) => vfs.readdir(path),
            exists: async (path: string) => vfs.exists(path),
            searchMemory: async (query: string) => {
              const results = await memory.search(query, 10);
              return results.map((r) => `[${r.path}] ${r.snippet}`).join('\n') || 'No results.';
            },
            saveNote: async (content: string) => {
              const ts = new Date().toISOString().split('T')[0];
              await memory.append('memory/MEMORY.md', `\n### Note (${ts})\n${content}\n`);
              await memory.index('memory/MEMORY.md');
              return 'Note saved.';
            },
          };
          // Expose crafted tools under the `codemode` global to mirror the real
          // codemode sandbox (see @cloudflare/codemode/dist/ai.js:163-178, which
          // unwraps .execute via extractFns before exposing).
          //
          // We use a Proxy so the lookup happens at call-time, picking up tools
          // created via workspace.createTool() earlier in the SAME execute_tools
          // call. Without this, a newly created tool is not callable until the
          // next turn (when getTools() rebuilds the cache).
          const codemode = new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
            get(_target, prop: string) {
              // Prefer the upfront-loaded map (applies score filtering).
              const upfront = craftedToolSet[prop];
              if (upfront) return upfront.execute;
              // If the tool WAS present at getTools() time but was filtered out
              // by the score threshold, it stays inaccessible — don't resurrect
              // low-quality tools via the live-lookup path.
              if (preexistingCraftNames.has(prop)) return undefined;
              // Only for tools NEW since getTools() ran (i.e. created in this
              // execute_tools call via workspace.createTool), fall back to live
              // CraftStore lookup so same-turn create-then-use works.
              const live = rt.craftStore.get(prop);
              if (!live || !live.code || live.code.startsWith('//')) return undefined;
              try {
                const fn = new Function('return ' + live.code)() as (...args: unknown[]) => Promise<unknown>;
                if (typeof fn !== 'function') return undefined;
                return (...args: unknown[]) => fn(...args);
              } catch {
                return undefined;
              }
            },
            has(_target, prop: string) {
              if (prop in craftedToolSet) return true;
              if (preexistingCraftNames.has(prop)) return false;
              const live = rt.craftStore.get(prop);
              return !!live;
            },
          });
          const fn = new Function(
            'workspace',
            'codemode',
            `return (async () => {\n${args.code}\n})()`,
          );
          const result = await fn(workspaceApi, codemode);
          return { result: result === undefined ? '(no return value)' : result };
        } catch (e) {
          return { result: undefined, error: (e as Error).message };
        }
      },
    });
  }

  // ── 2. run ───────────────────────────────────────────────────────────────
  tools.run = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.run,
    inputSchema: jsonSchema<{ command: string; executor?: string }>({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
        executor: {
          type: 'string',
          description: 'Target executor: workspace (default), nimbus, sandbox, laptop',
        },
      },
      required: ['command'],
    }),
    execute: async (args: { command: string; executor?: string }) => {
      const key = args.executor ?? 'workspace';
      if (key !== 'workspace') {
        const provider = router?.getProvider(key);
        const execTool = provider?.tools.exec;
        if (execTool) return (await execTool.execute(args.command)) as string;
        return `Executor "${key}" not available.`;
      }
      if (!shell) return 'Error: no workspace shell available in this runtime.';
      const result = await shell.exec(args.command);
      if (result.exitCode !== 0) return `Error (exit ${result.exitCode}): ${result.stderr}`;
      return result.stdout || '(no output)';
    },
  });

  // ── 3. explore ───────────────────────────────────────────────────────────
  const exploreImpl = async (args: { task: string; budget?: number }): Promise<string> => {
    console.log(`[proteus] explore called: task="${args.task.slice(0, 80)}", budget=${args.budget ?? 'default'}`);
    try {
      deps.onExplorePhase?.('starting', args.task);
      deps.onMctsProgress?.('explore-starting');
      const session = deps.createMctsSession?.() ?? createInMemorySession();
      await session.appendMessage(
        { id: nanoid(), role: 'user' as const, parts: [{ type: 'text' as const, text: args.task }] },
        null,
      );
      deps.onExplorePhase?.('running', args.task);
      await engine.onLifetimeEvolution(session);
      deps.onMctsProgress?.('explore-completed');
      deps.onExplorePhase?.('completed', args.task);

      const allNodes = rt.storage.sql<{ id: string; action: string; value: number; status: string }>`
        SELECT id, action, value, status FROM search_nodes ORDER BY value DESC`;
      const best = allNodes.find((n) => n.status === 'terminal') ?? allNodes[0];
      if (best && best.action) {
        return `Exploration complete (${allNodes.length} nodes). Best approach (score ${best.value.toFixed(2)}): ${best.action}`;
      }
      return `Exploration complete. ${allNodes.length} nodes explored. Check the MCTS tree for results.`;
    } catch (err) {
      console.error('[proteus] explore FAILED:', (err as Error).message);
      return `Exploration failed: ${(err as Error).message}`;
    }
  };

  const wrappedExplore = deps.wrapExplore ? deps.wrapExplore(exploreImpl) : exploreImpl;

  tools.explore = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.explore,
    inputSchema: jsonSchema<{ task: string; budget?: number }>({
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The subproblem to explore' },
        budget: { type: 'number', description: 'MCTS iterations (default: 5)' },
      },
      required: ['task'],
    }),
    execute: wrappedExplore,
  });

  // ── 4. save_note ─────────────────────────────────────────────────────────
  tools.save_note = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.save_note,
    inputSchema: jsonSchema<{ content: string }>({
      type: 'object',
      properties: { content: { type: 'string', description: 'Note content' } },
      required: ['content'],
    }),
    execute: async (args: { content: string }) => {
      const ts = new Date().toISOString().split('T')[0];
      await memory.append('memory/MEMORY.md', `\n### Note (${ts})\n${args.content}\n`);
      await memory.index('memory/MEMORY.md');
      return 'Note saved to memory.';
    },
  });

  // ── 5. search_memory ─────────────────────────────────────────────────────
  tools.search_memory = tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.search_memory,
    inputSchema: jsonSchema<{ query: string }>({
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    }),
    execute: async (args: { query: string }) => {
      const results = await memory.search(args.query, 10);
      if (results.length === 0) return 'No results found.';
      return results
        .map((r) => `[${r.path}:${r.startLine}-${r.endLine}] (score ${r.score.toFixed(2)})\n${r.snippet}`)
        .join('\n\n');
    },
  });

  return tools;
}
