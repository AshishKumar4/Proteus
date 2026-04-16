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
import type { VFS, Memory } from '../types/primitives.js';
import type { CraftStore } from '../types/agent-runtime.js';

interface ShellExec {
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface InlineExecutorDeps {
  vfs: VFS;
  memory: Memory;
  craftStore: CraftStore;
  shell: ShellExec;
}

export function createInlineExecutor(deps: InlineExecutorDeps): ExecutorProvider {
  const { vfs, memory, craftStore, shell } = deps;

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
      description: 'List all available tools including dynamically crafted ones.',
      execute: async () => {
        const crafted = craftStore.list();
        if (crafted.length === 0) return 'No crafted tools. Built-in tools are available via their namespaces.';
        return crafted.map(t => `- ${t.name}: ${t.description}`).join('\n');
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
  function listTools(): Promise<string>;
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
