/**
 * Crafted-tool loader — shared between CF and CLI surfaces.
 *
 * Applies the min-effective-score filter (fixes F5 on the CF path, which
 * previously injected every crafted tool regardless of quality) and produces
 * a flat { name → {description, execute} } map. Two invocation modes:
 *
 *   'inline-function'  — compile `t.code` via `new Function()` once at load.
 *                        Same-process, no executor indirection. Used by CF,
 *                        where crafted tools run inside the codemode sandbox
 *                        that already isolates them.
 *
 *   'executor'         — wrap `t.code` in `rt.executor.execute(wrapped, [])`.
 *                        Used by CLI, which lacks codemode and relies on the
 *                        sandboxed executor for isolation.
 *
 * Invocation mode is explicit so the refactor preserves both surfaces'
 * pre-existing semantics byte-for-byte — no behavioral drift for already-
 * stored crafted-tool code.
 */

import type { AgentRuntime } from '../types/agent-runtime.js';
import { effectiveScore } from '../craft/ema.js';
import { DEFAULT_CONFIG } from '../config.js';

export interface CraftedToolHandle {
  description: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

export interface CraftedToolsOptions {
  /** Effective-score cutoff. Defaults to the config-wide injection threshold. */
  minScore?: number;
  /** Injected for deterministic testing of time-decay. */
  now?: number;
  /** See module docstring. */
  invocation: 'inline-function' | 'executor';
}

export function loadFilteredCraftedTools(
  rt: AgentRuntime,
  opts: CraftedToolsOptions,
): Record<string, CraftedToolHandle> {
  const out: Record<string, CraftedToolHandle> = {};
  let tools;
  try {
    tools = rt.craftStore.list();
  } catch {
    return out;
  }

  const minScore = opts.minScore ?? DEFAULT_CONFIG.craftStore.minEffectiveScoreForInjection;
  const now = opts.now ?? Date.now();

  const scores = new Map<string, { score: number; lastUsedAt: number }>();
  try {
    const rows = rt.storage.sql<{ tool_name: string; score: number; last_used_at: number }>`
      SELECT tool_name, score, last_used_at FROM craft_scores`;
    for (const r of rows) scores.set(r.tool_name, { score: r.score, lastUsedAt: r.last_used_at });
  } catch {
    // craft_scores may not exist yet on a fresh DB; treat all tools as unscored
  }

  for (const t of tools) {
    if (!t.code || t.code.startsWith('//')) continue;

    const s = scores.get(t.name);
    if (s) {
      const eff = effectiveScore(s.score, s.lastUsedAt, now);
      if (eff < minScore) continue;
    }

    const description = t.description || `Crafted tool: ${t.name}`;
    try {
      if (opts.invocation === 'inline-function') {
        const fn = new Function('return ' + t.code)() as (...args: unknown[]) => Promise<unknown>;
        if (typeof fn !== 'function') continue;
        out[t.name] = { description, execute: async (...args) => fn(...args) };
      } else {
        // executor path — re-serialize args each call
        out[t.name] = {
          description,
          execute: async (...args: unknown[]) => {
            const wrappedCode = `const fn = ${t.code};\nreturn await fn(${args.map((a) => JSON.stringify(a)).join(',')});`;
            const result = await rt.executor.execute(wrappedCode, []);
            if (result.error) return `Error: ${result.error}`;
            return typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
          },
        };
      }
    } catch (err) {
      // Broken crafted tool — skip silently; engine will decay its score next turn
      console.warn(`[proteus] Skipping broken crafted tool "${t.name}":`, (err as Error).message);
    }
  }

  return out;
}
