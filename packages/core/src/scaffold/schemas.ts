/**
 * Scaffold SQL schemas — exact DDL from final-architecture.md §5.2.
 */

import type { RawSqlExec } from '../types/primitives.js';

export function initScaffoldTables(execRaw: RawSqlExec): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS scaffold_versions (
      version        INTEGER PRIMARY KEY,
      written_at     INTEGER NOT NULL,
      rationale      TEXT NOT NULL,
      canary_score   REAL,
      baseline_score REAL
    )
  `);

  execRaw(`
    CREATE TABLE IF NOT EXISTS scaffold_regression_fixtures (
      id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
      task              TEXT NOT NULL,
      expected_keywords TEXT NOT NULL,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  execRaw(`
    CREATE TABLE IF NOT EXISTS task_history (
      id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(9)))),
      task             TEXT NOT NULL,
      scaffold_version INTEGER NOT NULL,
      outcome          TEXT NOT NULL CHECK(outcome IN ('success','error','timeout')),
      score            REAL,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
}
