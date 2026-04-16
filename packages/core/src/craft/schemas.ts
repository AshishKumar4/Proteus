/**
 * CraftStore quality tracking schema.
 * Architecture reference: final-architecture.md §6
 */

import type { RawSqlExec } from '../types/primitives.js';

export function initCraftScoreTables(execRaw: RawSqlExec): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS craft_scores (
      tool_name    TEXT PRIMARY KEY,
      score        REAL NOT NULL DEFAULT 0.5,
      uses         INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
}
