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
});
