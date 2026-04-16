/**
 * Agent soul — the immutable purpose.
 * The agent cannot modify this. It is the constitutional safety boundary.
 */

import type { SqlExecutor } from '../types/primitives.js';

/** Read the agent's immutable purpose */
export function readSoul(sql: SqlExecutor): string | null {
  const rows = sql<{ purpose: string }>`SELECT purpose FROM agent_soul LIMIT 1`;
  return rows[0]?.purpose ?? null;
}

/** Write the soul (only at creation time — errors if already exists) */
export function writeSoul(sql: SqlExecutor, purpose: string): void {
  const existing = readSoul(sql);
  if (existing) {
    throw new Error('Agent soul already exists. The soul is immutable — it cannot be rewritten.');
  }
  sql`INSERT INTO agent_soul (purpose, created_at) VALUES (${purpose}, ${Date.now()})`;
}
