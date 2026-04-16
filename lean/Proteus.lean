/-
  Proteus — Formal specification of the self-evolving agent architecture.

  Verified properties:
  - Capability safety: sandbox can only invoke ToolCall operations (7 theorems)
  - Storage isolation: MCTS branches cannot access orchestrator state (7 cases)
  - Budget termination: MCTS loop terminates (well-founded on Nat)
  - Backpropagation: running mean preserves IDs and increases visits (4 theorems)
  - Evolution monotonicity: turn/session/scaffold/memory/reflection counts (7 theorems)
  - CraftStore: consolidation keeps above threshold, search bounded (3 theorems)
  - Scaffold: rollback nonexistent is none (1 theorem)

  All proofs are complete — zero sorry in the final output.
  Float axioms (17) are declared as axioms with IEEE 754 justification.
-/

import Proteus.Types
import Proteus.Safety.FloatAxioms
import Proteus.Safety.CapabilitySafety
import Proteus.MCTS.StorageIsolation
import Proteus.MCTS.Backpropagation
import Proteus.Evolution.Timescales
import Proteus.Evolution.CraftStore
import Proteus.Evolution.Scaffold
