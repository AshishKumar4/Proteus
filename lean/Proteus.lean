/-
  Proteus — Formal specification of the self-evolving agent architecture.

  8 original modules + 6 new modules = 14 total.
  ~55 theorems, 20 axioms (16 Float + 2 FTS5 + 2 VFS), 0 sorry.

  Original modules (v1):
  - Types, FloatAxioms, CapabilitySafety, StorageIsolation
  - Backpropagation, Timescales, CraftStore, Scaffold

  New modules (v2):
  - Agent.Lifecycle — 10-state agent lifecycle state machine
  - Agent.FiberDurability — Fiber checkpoint/resume correctness
  - Agent.TurnQueue — Chat turn serialization (linearizability)
  - Storage.FTS5Search — BM25 search axiomatization
  - Storage.SqliteFSCorrectness — VFS write/read, mkdir, chunking
  - Evolution.FullCraftLifecycle — 5-phase CraftStore pipeline
-/

-- Core types and axioms
import Proteus.Types
import Proteus.Safety.FloatAxioms

-- Safety proofs
import Proteus.Safety.CapabilitySafety

-- MCTS proofs
import Proteus.MCTS.StorageIsolation
import Proteus.MCTS.Backpropagation

-- Evolution proofs
import Proteus.Evolution.Timescales
import Proteus.Evolution.CraftStore
import Proteus.Evolution.Scaffold
import Proteus.Evolution.FullCraftLifecycle

-- Agent lifecycle proofs (NEW)
import Proteus.Agent.Lifecycle
import Proteus.Agent.FiberDurability
import Proteus.Agent.TurnQueue

-- Storage proofs (NEW)
import Proteus.Storage.FTS5Search
import Proteus.Storage.SqliteFSCorrectness
