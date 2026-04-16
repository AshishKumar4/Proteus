/**
 * InlineExecutor — the "workspace" provider inside the codemode sandbox.
 *
 * Wraps the agent's DO-local resources (SqliteFS, MemoryStore, shell emulator)
 * as workspace.* APIs callable from LLM-generated JS:
 *
 *   workspace.readFile("/src/main.ts")
 *   workspace.writeFile("/src/util.ts", code)
 *   workspace.exec("grep -rn TODO /src")
 *   workspace.searchMemory("how to handle errors")
 *   workspace.saveNote("User prefers TypeScript strict mode")
 *   workspace.listTools()
 */

import type { ExecutorProvider, ExecutorCapability } from './types.js';
import type { VFS, Memory, SqlExecutor } from '../types/primitives.js';
import type { CraftStore } from '../types/agent-runtime.js';

interface ShellExec {
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface InlineExecutorDeps {
  vfs: VFS;
  memory: Memory;
  craftStore: CraftStore;
  shell: ShellExec;
  /** Optional — used to look up craft_scores for listTools(). Falls back to 0.7 if missing. */
  sql?: SqlExecutor;
}

export function createInlineExecutor(deps: InlineExecutorDeps): ExecutorProvider {
  const { vfs, memory, craftStore, shell, sql } = deps;

  const tools: ExecutorProvider['tools'] = {
    readFile: {
      description: 'Read a file from the agent workspace. Returns content as string.',
      execute: async (path: unknown) => {
        const content = await vfs.readFile(String(path), { encoding: 'utf8' });
        return content ?? `File not found: ${path}`;
      },
    },

    writeFile: {
      description: 'Write content to a file. Creates parent directories automatically.',
      execute: async (path: unknown, content: unknown) => {
        const p = String(path);
        const dir = p.split('/').slice(0, -1).join('/');
        if (dir) {
          try { await vfs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
        }
        await vfs.writeFile(p, String(content));
        if (p.startsWith('memory/')) await memory.index(p);
        return `Written ${String(content).length} bytes to ${p}`;
      },
    },

    readdir: {
      description: 'List entries in a directory.',
      execute: async (path: unknown) => {
        return vfs.readdir(String(path || '/'));
      },
    },

    exists: {
      description: 'Check if a path exists.',
      execute: async (path: unknown) => {
        return vfs.exists(String(path));
      },
    },

    exec: {
      description: 'Execute a POSIX shell command. Supports cat, grep, find, sed, ls, tree, head, tail, wc, mkdir, rm, cp, mv, echo, sort, uniq, xargs. Pipes (|) and redirects (>, >>) work.',
      execute: async (command: unknown) => {
        const result = await shell.exec(String(command));
        if (result.exitCode !== 0) return `Error (exit ${result.exitCode}): ${result.stderr}`;
        return result.stdout || '(no output)';
      },
    },

    searchMemory: {
      description: 'Search long-term memory using FTS5 full-text search. Returns matching chunks.',
      execute: async (query: unknown) => {
        const results = await memory.search(String(query), 10);
        if (results.length === 0) return 'No results found.';
        return results.map(r => `[${r.path}:${r.startLine}-${r.endLine}] (score ${r.score.toFixed(2)})\n${r.snippet}`).join('\n\n');
      },
    },

    saveNote: {
      description: 'Save a note to long-term memory (MEMORY.md). The note is FTS5-indexed for search.',
      execute: async (content: unknown) => {
        const ts = new Date().toISOString().split('T')[0];
        await memory.append('memory/MEMORY.md', `\n### Note (${ts})\n${String(content)}\n`);
        await memory.index('memory/MEMORY.md');
        return 'Note saved to memory.';
      },
    },

    listTools: {
      description: 'List crafted tools as an array of { name, description, qualityScore }.',
      execute: async () => {
        // Return a real array so LLM code like `const tools = await workspace.listTools(); tools.filter(...)` works.
        // Previous implementation returned a joined markdown string and broke .filter/.map.
        const crafted = craftStore.list();
        // Pull EMA scores if available; default to 0.7 when unscored.
        const scoreByName = new Map<string, number>();
        if (sql) {
          try {
            const rows = sql<{ tool_name: string; score: number }>`
              SELECT tool_name, score FROM craft_scores
            `;
            for (const r of rows) scoreByName.set(r.tool_name, r.score);
          } catch { /* craft_scores may not exist yet */ }
        }
        return crafted.map(t => ({
          name: t.name,
          description: t.description,
          qualityScore: scoreByName.get(t.name) ?? 0.7,
        }));
      },
    },

    invokeCrafted: {
      description: 'Invoke a crafted tool BY NAME with positional args. Use this to call a tool just created via workspace.createTool() in the SAME turn, since codemode.<name> is only wired up at the start of a turn (getTools() cache). Returns the tool\'s return value, or an error object { error } on failure.',
      execute: async (name: unknown, ...args: unknown[]) => {
        const toolName = String(name);
        if (!toolName) return { error: 'invokeCrafted requires a name argument.' };
        const tool = craftStore.get(toolName);
        if (!tool) return { error: `Crafted tool "${toolName}" not found in CraftStore.` };
        if (!tool.code || tool.code.startsWith('//')) {
          return { error: `Crafted tool "${toolName}" has no executable code.` };
        }
        try {
          // Compile the crafted code to a function and invoke with positional args.
          // Same semantics as loadFilteredCraftedTools('inline-function').
          const fn = new Function('return ' + tool.code)() as (...args: unknown[]) => Promise<unknown>;
          if (typeof fn !== 'function') return { error: `Crafted tool "${toolName}" code did not evaluate to a function.` };
          return await fn(...args);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    },

    createTool: {
      description: 'Create or update a reusable tool in CraftStore. To call the tool in the SAME turn, use workspace.invokeCrafted(name, ...args). The tool also becomes callable as codemode.<name>(args) in the NEXT turn (getTools() is cached per-turn). Returns { ok, name, action: "created"|"updated" }.',
      execute: async (name: unknown, description: unknown, code: unknown) => {
        if (!name || !description || !code) {
          return { ok: false, error: 'createTool requires name, description, and code arguments.' };
        }
        // Preserve original case — the LLM often wants camelCase identifiers.
        // Only strip characters that aren't valid in a JS identifier, but do NOT lowercase.
        // Also prepend '_' if the first char is a digit so it's a valid JS ident.
        const raw = String(name);
        let toolName = raw.replace(/[^A-Za-z0-9_]/g, '_');
        if (!toolName) return { ok: false, error: 'Tool name must contain at least one identifier character.' };
        if (/^[0-9]/.test(toolName)) toolName = '_' + toolName;
        try {
          // Upsert: update if exists, else create. CraftStore has no upsert helper,
          // and `name` is PRIMARY KEY so raw INSERT on existing row would throw.
          const existing = craftStore.get(toolName);
          if (existing) {
            craftStore.update(toolName, { description: String(description), code: String(code) });
            return { ok: true, name: toolName, action: 'updated' };
          }
          craftStore.create({
            name: toolName,
            description: String(description),
            code: String(code),
            scope: 'local',
            params: null,
          });
          return { ok: true, name: toolName, action: 'created' };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
  };

  const types = `declare namespace workspace {
  function readFile(path: string): Promise<string>;
  function writeFile(path: string, content: string): Promise<string>;
  function readdir(path: string): Promise<string[]>;
  function exists(path: string): Promise<boolean>;
  function exec(command: string): Promise<string>;
  function searchMemory(query: string): Promise<string>;
  function saveNote(content: string): Promise<string>;
  /** Returns Array<{name, description, qualityScore}> of crafted tools. */
  function listTools(): Promise<Array<{ name: string; description: string; qualityScore: number }>>;
  /**
   * Create or update a crafted tool. To CALL the tool in the SAME turn, use
   * workspace.invokeCrafted(name, ...args). It also becomes callable as
   * \`codemode.<name>(args)\` in the NEXT turn (getTools() caches per-turn).
   * Name is sanitized to a valid JS identifier; original case preserved.
   */
  function createTool(
    name: string, description: string, code: string
  ): Promise<{ ok: boolean; name?: string; action?: 'created' | 'updated'; error?: string }>;
  /**
   * Invoke a crafted tool by name with positional args. Use this when you
   * just created a tool in the same turn and want to call it before codemode.<name>
   * is wired up.
   */
  function invokeCrafted(name: string, ...args: unknown[]): Promise<unknown>;
}`;

  return {
    name: 'workspace',
    kind: 'workspace',
    capabilities: new Set<ExecutorCapability>(['javascript', 'typescript', 'shell', 'fs_shared']),
    isAvailable: () => true,
    connect: async () => {},
    disconnect: async () => {},
    tools,
    types,
    positionalArgs: true,
  };
}
