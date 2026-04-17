/**
 * Phase B evidence: CLI Node executor round-trips a crafted tool through
 * the canonical code path — stored in CraftStore, filtered by effective
 * score, built into the codemode.* namespace, invoked from sandbox code,
 * returns the right answer.
 *
 * Replays the exact sequence a live chat turn would produce (without an
 * LLM): createTool via workspace, then execute_tools code that calls
 * codemode.<name>(arg). The assertion pins the end-to-end value so a
 * regression in the executor factory breaks this test loudly.
 */

import { describe, test, expect } from 'bun:test';
import { createTestRuntime } from './helpers.js';
import {
  buildBuiltinTools,
  EvolutionEngine,
  type CraftedToolExecute,
} from '../src/index.js';

// Phase B ships the CLI executor in @proteus/cli-backend. Reproduce the
// same logic inline here so core tests stay dep-free (cli-backend is a
// downstream workspace and importing it would invert the dep graph).
const createNodeCraftedExecute: () => CraftedToolExecute = () => (tool) => {
  let compiled: ((arg: unknown) => Promise<unknown>) | null = null;
  return async (arg) => {
    if (!compiled) {
      const fn = new Function('return (' + tool.code + ')')();
      if (typeof fn !== 'function') throw new Error(`${tool.name} not a function`);
      compiled = fn as (arg: unknown) => Promise<unknown>;
    }
    return compiled(arg);
  };
};

describe('Phase B — Node crafted-tool executor', () => {
  test('codemode.<name>(arg) round-trips a stored tool with Node executor', async () => {
    const { rt } = createTestRuntime();
    // craft_scores table needs to exist for the score filter to query it
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);

    // Store the tool (simulates a successful workspace.createTool from an earlier turn)
    rt.craftStore.create({
      name: 'double',
      description: 'doubles its arg',
      params: null,
      code: 'async (n) => n * 2',
      scope: 'local',
    });

    const engine = new EvolutionEngine(rt, { enabled: false });
    const tools = buildBuiltinTools({
      rt,
      engine,
      craftedToolExecute: createNodeCraftedExecute(),
    });

    // execute_tools fallback path (no codemode loader in test runtime)
    // exposes crafted tools under the `codemode` global so the LLM-style
    // call matches production prompt contract.
    const execTool = tools.execute_tools as {
      execute: (a: { code: string }) => Promise<{ result: unknown; error?: string }>;
    };
    const res = await execTool.execute({
      code: 'return await codemode.double(21);',
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toBe(42);
  });

  test('craftedToolExecute factory is called once per tool per getTools build', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'identity',
      description: 'returns arg',
      params: null,
      code: 'async (x) => x',
      scope: 'local',
    });

    let factoryCalls = 0;
    const factory: CraftedToolExecute = (tool) => {
      factoryCalls++;
      return async (arg) => `${tool.name}:${JSON.stringify(arg)}`;
    };

    const engine = new EvolutionEngine(rt, { enabled: false });
    buildBuiltinTools({ rt, engine, craftedToolExecute: factory });
    expect(factoryCalls).toBe(1);
  });

  test('low-scoring tools are filtered out before the factory is invoked', async () => {
    const { rt } = createTestRuntime();
    rt.storage.execRaw(`CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name TEXT PRIMARY KEY, score REAL NOT NULL DEFAULT 0.5,
      uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0
    )`);
    rt.craftStore.create({
      name: 'noisy',
      description: 'noisy',
      params: null,
      code: 'async () => "nope"',
      scope: 'local',
    });
    rt.storage.sql`INSERT INTO craft_scores (tool_name, score, last_used_at) VALUES ('noisy', 0.01, ${Date.now()})`;

    let factoryCalls = 0;
    const factory: CraftedToolExecute = () => {
      factoryCalls++;
      return async () => 'never';
    };
    const engine = new EvolutionEngine(rt, { enabled: false });
    buildBuiltinTools({ rt, engine, craftedToolExecute: factory });
    expect(factoryCalls).toBe(0);
  });
});
