# Formal Specification

Proteus has a Lean 4 formal specification covering safety, correctness, and liveness properties. The proofs are in `formal-spec/SelfEvolvingAgent/`.

## Proven Properties

### Capability Safety (7/7 theorems — fully proven)

The strongest verified module. Proves that the code execution sandbox can ONLY invoke `ToolCall` operations:

| Theorem | What it proves |
|---------|----------------|
| `sandboxCaps_only_toolcall` | All sandbox capabilities are ToolCall variants |
| `sqlwrite_not_grantable` | SQLWrite cannot be granted to sandbox |
| `sqlread_not_grantable` | SQLRead cannot be granted to sandbox |
| `scaffoldwrite_not_grantable` | ScaffoldWrite cannot be granted |
| `spawnsubagent_not_grantable` | SpawnSubAgent cannot be granted |
| `networkfetch_not_grantable` | NetworkFetch cannot be granted |
| `branch_cannot_modify_orchestrator` | Branch storage ID is always disjoint from orchestrator |

### Storage Isolation (7/7 cases — fully proven)

The `StorageIsolated` invariant is preserved through all MCTS transitions:

```
StorageIsolated(s) ≡ ∀ b ∈ s.branches, b.storageId ≠ s.orch.storageId
```

All 7 transition cases (Select, Expand, BranchExplore, BranchEvaluate, Backpropagate, Prune, Converge) are proven to preserve this invariant. The key strengthening (v4.0): each transition explicitly constrains `s'.branches` storageIds.

### Backpropagation (3/3 base theorems)

| Theorem | What it proves |
|---------|----------------|
| `initial_valid` | Initial state `{visits:0, rewardSum:0, value:0}` is Valid |
| `backprop_preserves_ids` | Backprop does not change node IDs |
| `backprop_increases_visits` | Each ancestor's visit count increases by 1 |

### CraftStore (3/3 + 1 new)

| Theorem | What it proves |
|---------|----------------|
| `consolidate_keeps_above` | After consolidation, remaining tools score ≥ threshold |
| `search_length_bound` | Search results length ≤ limit |
| `consolidation_nondecreasing_with_guard` | Non-empty guard ensures quality |
| `consolidate_with_decay_keeps_above` | Time-decayed consolidation preserves threshold (v4.0) |

### Convergence & Termination

| Theorem | What it proves |
|---------|----------------|
| `budget_well_founded` | Budget is a well-founded measure (MCTS terminates) |
| `pruning_safety` | Best open node survives pruning |

### Scaffold Safety

| Theorem | What it proves |
|---------|----------------|
| `rollback_nonexistent_is_none` | Rollback to missing version returns none |
| `append_preserves_increasing` | Version numbers are monotonically increasing |

### Evolution (7 theorems — v4.0, all proven)

| Theorem | What it proves |
|---------|----------------|
| `turnCount_increases` | Turn count strictly increases with each assessTurn |
| `scaffoldVersion_nondecreasing` | Scaffold version never decreases |
| `memorySize_nondecreasing` | Memory only grows |
| `sessionCount_nondecreasing` | Session count never decreases |
| `reflectionCount_nondecreasing` | Reflection count never decreases |
| `nested_budget_bounded` | Total nested MCTS budget is positive |
| `deeper_nesting_costs_more` | Deeper nesting requires more total budget |

## Float Axioms

Lean 4 core lacks `LinearOrder Float`. We provide 17 IEEE 754 axioms in `FloatAxioms.lean` for the operating range of finite, non-NaN, non-Inf floats:

- Zero/identity: `mul_zero`, `zero_mul`, `add_zero`, `zero_add`, `div_one`, `zero_div`
- Cancellation: `div_mul_cancel` (exact for integer divisors)
- Ordering: `mul_nonneg`, `add_nonneg`, `mul_le_mul_of_nonneg_left`, `add_le_add`, `lt_iff_not_le`
- Square root: `sqrt_zero`, `sqrt_lt_sqrt`
- Conversion: `ofNat_zero`, `ofNat_one`, `ofNat_ne_zero`

## TSLean Type Bridge

[TSLean](https://github.com/AshishKumar4/TSLean) compiles TypeScript interfaces to Lean 4 structures. Generated types live in `lean/generated/Proteus/`:

| TypeScript File | Generated Lean | Contents |
|-----------------|---------------|----------|
| `types/primitives.ts` | `Proteus/Types/Primitives.lean` | VFS, Memory, Executor, LLM, Schedule, Identity |
| `types/agent-runtime.ts` | `Proteus/Types/AgentRuntime.lean` | AgentRuntime, CraftStore, BranchHandle |
| `types/craft.ts` | `Proteus/Types/Craft.lean` | CraftedTool, CraftScoreEntry |
| `evolution/types.ts` | `Proteus/Evolution/Types.lean` | CompletedTurn, EvolutionConfig |
| `config.ts` | `Proteus/Config.lean` | AgentConfig, MCTSDefaults |

Regenerate with:
```bash
cd /workspace/TSLean
for f in primitives agent-runtime craft; do
  bun run src/cli.ts compile "../proteus/packages/core/src/types/${f}.ts" --namespace Proteus.Types
done
bun run src/cli.ts compile ../proteus/packages/core/src/evolution/types.ts --namespace Proteus.Evolution
bun run src/cli.ts compile ../proteus/packages/core/src/config.ts --namespace Proteus
```

## File Structure

```
formal-spec/
  SelfEvolvingAgent.lean          Root module (imports all)
  SelfEvolvingAgent/
    Types.lean                    Domain types (NodeData, Op, CraftedTool, etc.)
    Primitives.lean               Abstract primitives (Storage, LLMOracle)
    FloatAxioms.lean              17 IEEE 754 axioms
    MCTSTree.lean                 Rose tree, path navigation
    UCT.lean                      UCT formula, selection
    Backpropagation.lean          Running mean, backprop correctness
    CapabilitySafety.lean         Sandbox capability bounds
    ScaffoldSafety.lean           Version monotonicity, rollback
    CraftStore.lean               EMA, consolidation, search
    DistributedModel.lean         Veil transition system, storage isolation
    Convergence.lean              Termination, pruning safety
    Evolution.lean                3-timescale evolution model
  lakefile.toml                   Lean build config
  lean-toolchain                  leanprover/lean4:v4.29.0
```
