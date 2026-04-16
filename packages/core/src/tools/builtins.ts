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
  const craftedToolSet = loadFilteredCraftedTools(rt, {
    invocation: 'inline-function',
    minScore: deps.minEffectiveScore ?? DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection,
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
          // Also expose crafted tools as a flat `codemode` proxy in the fallback
          // so scripts written for the real sandbox keep working.
          const codemode = craftedToolSet;
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
