/**
 * AgentRuntime — the one struct the agent core receives.
 * Platform-specific; constructed by either CF or Linux backend.
 *
 * Architecture reference: final-architecture.md §3
 */

import type {
  Storage,
  Memory,
  Executor,
  LLM,
  Schedule,
  Identity,
} from './primitives.js';
import type { CraftedTool, CraftScoreEntry } from './craft.js';

/** CraftStore interface — matches seal/agent-utils CraftStore API */
export interface CraftStore {
  create(tool: Omit<CraftedTool, 'createdAt' | 'updatedAt'>): void;
  update(name: string, patch: Partial<CraftedTool>): void;
  get(name: string): CraftedTool | undefined;
  delete(name: string): void;
  list(): CraftedTool[];
  search(query: string, limit?: number): CraftedTool[];
  getAll(): CraftedTool[];
}

export interface BranchHandle {
  explore(
    priorHistory: Array<{ role: string; content: string }>,
    craftedTools: CraftedTool[],
  ): Promise<{ text: string; codeUsed: string | null }>;
  evaluate(task: string): Promise<number>;
  generateReflection(task: string): Promise<string>;
}

/** Factory for creating isolated branch agents — injected by the backend */
export type SpawnBranch = (branchId: string) => Promise<BranchHandle>;
/** Factory for aborting a branch agent */
export type AbortBranch = (branchId: string, reason?: string) => Promise<void>;

export interface AgentRuntime {
  storage: Storage;
  memory: Memory;
  executor: Executor;
  llm: LLM;
  schedule: Schedule;
  identity: Identity;
  craftStore: CraftStore;
  /** Second LLM for cross-model judging (different model from the explorer) */
  judgeModel?: LLM;
  /** Platform-specific branch spawning — injected by CF or CLI backend */
  spawnBranch: SpawnBranch;
  abortBranch: AbortBranch;
}
