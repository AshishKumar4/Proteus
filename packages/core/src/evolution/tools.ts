/**
 * Agent tools — Vercel AI SDK ToolSet.
 *
 * Built-in tools (6) + dynamically loaded crafted tools from the CraftStore.
 * Every execute function is wrapped in try/catch — tools NEVER throw.
 * On error they return an informative string the model can reason about.
 */

import { tool, jsonSchema } from 'ai';
import type { ToolSet } from 'ai';
import type { AgentRuntime } from '../types/agent-runtime.js';
import type { CraftedTool } from '../types/craft.js';

/** Wrap an async tool function so it never throws — returns error string instead */
function safe<T extends Record<string, unknown>>(
  fn: (args: T) => Promise<string>,
): (args: T) => Promise<string> {
  return async (args: T) => {
    try {
      return await fn(args);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}

export function buildAgentTools(rt: AgentRuntime): ToolSet {
  const builtIn: ToolSet = {
    search_memory: tool({
      description: "Search the agent's long-term memory for relevant information.",
      inputSchema: jsonSchema<{ query: string }>({
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      }),
      execute: safe(async (args: { query: string }) => {
        const results = await rt.memory.search(args.query, 5);
        if (results.length === 0) return 'No results found.';
        return results.map(r => `[${r.path}] ${r.snippet}`).join('\n');
      }),
    }),

    read_file: tool({
      description: "Read a file from the agent's workspace.",
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        properties: { path: { type: 'string', description: 'File path to read' } },
        required: ['path'],
      }),
      execute: safe(async (args: { path: string }) => {
        const content = await rt.memory.read(args.path);
        return content ?? 'File not found.';
      }),
    }),

    write_file: tool({
      description: "Write content to a file in the agent's workspace.",
      inputSchema: jsonSchema<{ path: string; content: string }>({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      }),
      execute: safe(async (args: { path: string; content: string }) => {
        await rt.memory.write(args.path, args.content);
        return `Written ${args.content.length} bytes to ${args.path}.`;
      }),
    }),

    execute_code: tool({
      description: 'Execute JavaScript code in a sandboxed environment. Returns the result.',
      inputSchema: jsonSchema<{ code: string }>({
        type: 'object',
        properties: { code: { type: 'string', description: 'JavaScript code to execute' } },
        required: ['code'],
      }),
      execute: safe(async (args: { code: string }) => {
        const result = await rt.executor.execute(args.code, []);
        if (result.error) return `Error: ${result.error}`;
        const output = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
        const logs = result.logs?.length ? `\nLogs: ${result.logs.join('\n')}` : '';
        return `${output}${logs}`;
      }),
    }),

    save_note: tool({
      description: 'Save a note to long-term memory for future reference.',
      inputSchema: jsonSchema<{ note: string }>({
        type: 'object',
        properties: { note: { type: 'string', description: 'The note content to remember' } },
        required: ['note'],
      }),
      execute: safe(async (args: { note: string }) => {
        const datestamp = new Date().toISOString().slice(0, 10);
        await rt.memory.append('memory/MEMORY.md', `\n### Note (${datestamp})\n${args.note}\n`);
        await rt.memory.index('memory/MEMORY.md');
        return 'Note saved to memory.';
      }),
    }),

    list_tools: tool({
      description: 'List all available tools including crafted ones the agent has learned.',
      inputSchema: jsonSchema<Record<string, never>>({
        type: 'object',
        properties: {},
      }),
      execute: safe(async () => {
        const crafted = rt.craftStore.list();
        const builtInNames = [
          'read', 'write', 'edit', 'list', 'find', 'grep', 'delete',
          'shell_exec', 'search_memory', 'save_note', 'execute_code',
          'list_tools', 'explore',
        ];
        const lines = builtInNames.map(n => `[built-in] ${n}`);
        for (const t of crafted) lines.push(`[crafted] ${t.name}: ${t.description}`);
        return lines.join('\n');
      }),
    }),
  };

  const crafted = loadCraftedTools(rt);
  return { ...builtIn, ...crafted };
}

function loadCraftedTools(rt: AgentRuntime): ToolSet {
  const tools: ToolSet = {};
  let crafted: CraftedTool[];
  try {
    crafted = rt.craftStore.list();
  } catch {
    return tools;
  }

  // Filter by effective score — tools below threshold are not loaded.
  // Previously, ALL crafted tools were loaded regardless of score.
  const minScore = 0.2; // DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection
  const now = Date.now();
  const scores = new Map<string, { score: number; lastUsedAt: number }>();
  try {
    const rows = rt.storage.sql<{ tool_name: string; score: number; last_used_at: number }>`
      SELECT tool_name, score, last_used_at FROM craft_scores`;
    for (const r of rows) scores.set(r.tool_name, { score: r.score, lastUsedAt: r.last_used_at });
  } catch {
    // craft_scores table may not exist yet; load all tools
  }

  for (const ct of crafted) {
    if (!ct.code || ct.code.startsWith('//')) continue;

    // Skip tools with effective score below threshold
    const scoreEntry = scores.get(ct.name);
    if (scoreEntry) {
      const daysSince = (now - scoreEntry.lastUsedAt) / 86_400_000;
      const effective = scoreEntry.score * Math.pow(0.5, daysSince / 30);
      if (effective < minScore) continue;
    }

    const defaultSchema = {
      type: 'object' as const,
      properties: { input: { type: 'string', description: 'Input for this tool' } },
      required: ['input'],
    };
    let schema: Record<string, unknown>;
    try {
      const raw = ct.params;
      if (!raw) schema = defaultSchema;
      else if (typeof raw === 'string') schema = JSON.parse(raw);
      else schema = raw as Record<string, unknown>;
    } catch {
      schema = defaultSchema;
    }

    tools[ct.name] = tool({
      description: ct.description || `Crafted tool: ${ct.name}`,
      inputSchema: jsonSchema(schema),
      execute: safe(async (args: Record<string, unknown>) => {
        const wrappedCode = `const fn = ${ct.code};\nreturn await fn(${JSON.stringify(args)});`;
        const result = await rt.executor.execute(wrappedCode, []);
        if (result.error) return `Error: ${result.error}`;
        return typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      }),
    });
  }

  return tools;
}
