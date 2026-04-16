/**
 * Unit tests for the canonical 5-tool surface (v2.0).
 * CF and CLI both consume buildBuiltinTools, so this test locks in the
 * post-refactor tool inventory and basic per-tool behavior.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import {
  buildBuiltinTools,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_DESCRIPTIONS,
  EvolutionEngine,
} from '../src/index.js';

function tools(rt: ReturnType<typeof createTestRuntime>['rt']) {
  const engine = new EvolutionEngine(rt, { enabled: false });
  return buildBuiltinTools({ rt, engine });
}

describe('Agent tools (v2.0 canonical 5-tool surface)', () => {
  test('buildBuiltinTools returns exactly the 5 canonical tools', () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const names = Object.keys(t);

    for (const canonical of BUILTIN_TOOLS) {
      expect(names).toContain(canonical);
    }
    expect(names.length).toBe(5);
    expect(names.sort()).toEqual([...BUILTIN_TOOLS].sort());
  });

  test('each tool carries description + inputSchema', () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    for (const [, v] of Object.entries(t)) {
      const tool = v as { description?: string; inputSchema?: unknown };
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  test('descriptions use the codemode.* vocabulary, not tools.*', () => {
    // This is the F1 regression gate — the prompt and the real namespace agree.
    expect(BUILTIN_TOOL_DESCRIPTIONS.execute_tools).toContain('codemode.*');
    expect(BUILTIN_TOOL_DESCRIPTIONS.execute_tools).not.toContain('tools.*');
  });

  test('save_note appends to MEMORY.md', async () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = t.save_note as { execute: (args: { content: string }) => Promise<string> };

    const result = await tool.execute({ content: 'Remember: Python prefers snake_case' });
    expect(result).toContain('saved');

    const memory = await rt.memory.read('memory/MEMORY.md');
    expect(memory).toContain('snake_case');
  });

  test('search_memory returns a string', async () => {
    const { rt } = createTestRuntime();
    const t = tools(rt);

    await rt.memory.write('memory/test.md', 'This is about machine learning');
    await rt.memory.index('memory/test.md');

    const tool = t.search_memory as { execute: (args: { query: string }) => Promise<string> };
    const result = await tool.execute({ query: 'machine learning' });
    expect(typeof result).toBe('string');
  });

  test('run in workspace mode falls back gracefully when no shell provided', async () => {
    // Test runtime has no rt.shell — `run` must return an error string rather
    // than throwing. This lets test harnesses exercise the tool shape without
    // providing a real shell dependency.
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = t.run as { execute: (args: { command: string }) => Promise<string> };
    const result = await tool.execute({ command: 'echo hi' });
    expect(typeof result).toBe('string');
    expect(result).toContain('Error');
  });

  test('execute_tools fallback exposes workspace.* and codemode.* in the sandbox', async () => {
    // No codemodeLoader is provided, so builtins.ts uses the new-Function
    // fallback. Verify the injected `workspace` and `codemode` globals exist.
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = t.execute_tools as { execute: (args: { code: string }) => Promise<{ result: unknown }> };
    const result = await tool.execute({
      code: "return typeof workspace + ',' + typeof codemode;",
    });
    expect(result.result).toBe('object,object');
  });

  test('crafted tools become bare callables under codemode.<name> — matches prompt contract', async () => {
    // Regression gate: the fallback path must unwrap `{description, execute}`
    // the same way codemode's extractFns does, so `codemode.foo(args)` (per
    // the system prompt) works verbatim — not `codemode.foo.execute(args)`.
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'double', description: 'doubles a number', params: null,
      code: 'async (x) => x * 2', scope: 'local',
    });

    const t = tools(rt);
    const tool = t.execute_tools as { execute: (a: { code: string }) => Promise<{ result: unknown }> };
    const result = await tool.execute({ code: 'return await codemode.double(21);' });
    expect(result.result).toBe(42);
  });

  test('low-scoring crafted tools filtered out of codemode namespace', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'weak', description: 'low quality', params: null,
      code: 'async () => "should never run"', scope: 'local',
    });
    rt.storage.sql`INSERT INTO craft_scores (tool_name, score, last_used_at) VALUES ('weak', 0.01, ${Date.now()})`;

    const t = tools(rt);
    const tool = t.execute_tools as { execute: (a: { code: string }) => Promise<{ result: unknown }> };
    const result = await tool.execute({ code: 'return typeof codemode.weak;' });
    expect(result.result).toBe('undefined');
  });

  test('same-turn created tool callable via codemode.<name> in the fallback path', async () => {
    // When no LOADER binding is present (CLI / test), builtins.ts uses a Proxy
    // for the `codemode` global inside execute_tools so that a tool created
    // by workspace.createTool earlier in the same execute_tools call becomes
    // callable as codemode.<name> immediately — without waiting for the next
    // getTools() cache refresh.
    const { rt } = createTestRuntime();
    const t = tools(rt);
    const tool = t.execute_tools as { execute: (a: { code: string }) => Promise<{ result: unknown }> };

    // Seed the craftStore via direct insertion at runtime (simulates the
    // workspace.createTool path that runs INSIDE the sandbox).
    const code = `
      await new Promise(r => setTimeout(r, 0));
      // Seed the tool — normally this would be via workspace.createTool.
      // In the test we can't touch rt directly from sandbox, so we test the
      // scenario by pre-seeding and ensuring it's live-looked-up.
      return typeof codemode.newbie;
    `;
    // Pre-seed so the runtime resolves it live (CraftStore lookup path):
    rt.craftStore.create({
      name: 'newbie', description: 'fresh', params: null,
      code: 'async () => "hi"', scope: 'local',
    });
    // Execute_tools was built BEFORE the craftStore was populated, so "newbie"
    // isn't in the upfront craftedToolSet. Only the live-lookup Proxy can
    // expose it.
    // Note: in the real scenario, workspace.createTool does the insert from
    // INSIDE the sandbox — here we do it from outside for test simplicity,
    // but the same Proxy path is exercised.
    const result = await tool.execute({ code });
    expect(result.result).toBe('function');

    // And it actually works:
    const result2 = await tool.execute({ code: 'return await codemode.newbie();' });
    expect(result2.result).toBe('hi');
  });

  test('newly-created tool NOT pre-existing is live-looked-up but score-filtered names stay undefined', async () => {
    // Invariant: low-scoring names that were pre-existing at getTools() time
    // remain undefined in codemode — they shouldn't be resurrected by the
    // live-lookup Proxy fallback path.
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'filteredOut', description: 'weak', params: null,
      code: 'async () => "nope"', scope: 'local',
    });
    rt.storage.sql`INSERT INTO craft_scores (tool_name, score, last_used_at) VALUES ('filteredOut', 0.01, ${Date.now()})`;

    const t = tools(rt);
    const tool = t.execute_tools as { execute: (a: { code: string }) => Promise<{ result: unknown }> };

    // filteredOut was present when getTools() ran — recorded in preexisting set.
    // The Proxy must NOT live-look-it-up even though it exists in CraftStore.
    const result = await tool.execute({ code: 'return typeof codemode.filteredOut;' });
    expect(result.result).toBe('undefined');
  });
});
