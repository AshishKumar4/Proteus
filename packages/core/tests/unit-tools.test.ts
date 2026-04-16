/**
 * Unit tests for agent tools — native AI SDK tool() objects.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import { buildAgentTools } from '../src/evolution/tools.js';

describe('Agent tools (AI SDK native)', () => {
  test('buildAgentTools returns a ToolSet with all built-in tools', () => {
    const { rt } = createTestRuntime();
    const tools = buildAgentTools(rt);
    const names = Object.keys(tools);

    expect(names).toContain('search_memory');
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).toContain('execute_code');
    expect(names).toContain('save_note');
    expect(names).toContain('list_tools');
    expect(names.length).toBeGreaterThanOrEqual(6);
  });

  test('each tool has description and inputSchema', () => {
    const { rt } = createTestRuntime();
    const tools = buildAgentTools(rt);

    for (const [name, t] of Object.entries(tools)) {
      const tool = t as { description?: string; inputSchema?: unknown };
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  test('save_note tool appends to MEMORY.md', async () => {
    const { rt } = createTestRuntime();
    const tools = buildAgentTools(rt);
    const tool = tools.save_note as { execute: (args: { note: string }) => Promise<string> };

    const result = await tool.execute({ note: 'Remember that Python prefers snake_case' });
    expect(result).toContain('saved');

    const memory = await rt.memory.read('memory/MEMORY.md');
    expect(memory).toContain('snake_case');
  });

  test('execute_code tool runs code in sandbox', async () => {
    const { rt } = createTestRuntime();
    const tools = buildAgentTools(rt);
    const tool = tools.execute_code as { execute: (args: { code: string }) => Promise<string> };

    const result = await tool.execute({ code: 'return 42' });
    expect(typeof result).toBe('string');
  });

  test('search_memory tool searches indexed content', async () => {
    const { rt } = createTestRuntime();
    const tools = buildAgentTools(rt);

    await rt.memory.write('memory/test.md', 'This is about machine learning');
    await rt.memory.index('memory/test.md');

    const tool = tools.search_memory as { execute: (args: { query: string }) => Promise<string> };
    const result = await tool.execute({ query: 'machine learning' });
    expect(typeof result).toBe('string');
  });
});
