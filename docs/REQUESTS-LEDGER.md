# Requests ledger

Every request made in conversation, with the state I last **verified** and the command
that verifies it. A row is `DONE` only when the command in it passes. A row with no
verifying command is `UNVERIFIED` and counts as open.

This file exists because an audit found four requests that were designed, discussed,
built and never wired, plus a doc corpus that had drifted from the code it described.
Memory was the tracking mechanism and it failed. See `docs/TRACEABILITY.md` for the
gates that make each row mechanical rather than remembered.

## Open

| Request | State | Verify |
| --- | --- | --- |
| Per-node private home reaches a shipped search | OPEN. `agentHomeNodeProvisioner` has no production caller, so every node reports `shared-origin-plane` | `grep -c provisionHome packages/core/src/tools/agents-tool.ts` is 0 |
| Mission port charges a node's steps | OPEN. `SwarmRunDeps.mission` has no producer, and `agents-tool.ts:918` already charges a lump, so naive wiring double-bills | `grep -n "mission" packages/core/src/strategy/swarm-run.ts` shows the thread, no setter |
| Deploy latest to production | OPEN. Production serves an older build | `curl -sS $ORIGIN/api/health` sha equals `git rev-parse --short HEAD` |
| `@kinu.run/*` → `@kinu.run/*` | NOT STARTED. 463 sites, 7 non-mechanical traps, one atomic commit | `grep -rc "@kinu.run" package.json` is 0 |
| `advance:'pareto'` | REFUSED BY DESIGN. It needs a per-instance measurement path and a dominance comparison; the error names both | `grep -n "pareto" packages/core/src/strategy/swarm-run.ts` |

## Done, with the check that proves it

| Request | Verify |
| --- | --- |
| `fork` off the delegation surface | `AGENTS_TOOL_ACTIONS` has seven entries and none is `fork` |
| Six axes; six named presets including `prove`, plus `custom` | `AXES` in `strategy/swarm.ts`; `NAMED_SWARM_PRESETS` filters `custom` out of the seven tokens |
| A node is a full agent on one shared loop | `head-inference.ts` owns no loop; `runChat` is the body for a CLI session and a node |
| A node backgrounds work and is woken | `unit-node-backgrounding.test.ts` |
| One suite over orchestrator, subordinate and node | `unit-three-kinds-one-contract.test.ts`, 44 tests, zero skips |
| Nimbus fixes upstreamed, published, patches dropped | `patches/` holds `@plannotator/ui` only |
| Never weaken a gate | `AGENTS.md` § "A red gate is work" |
| Errors carry their cause chain | `gate:silent-drop` |
| Docs name the tree swarm as the differentiator | `README.md` opening |
| How to write docs, verbatim | `AGENTS.md` § "How To Write Docs…" and the global file |
| History rewritten, internal records off the remote | `git log --oneline origin/main | wc -l`; no removed doc resolves on any remote branch |
| No unwarranted timeouts | Every bound in the agent path is measured, derived, or reasoned; the one invented level clock is deleted |

## Rules this ledger follows

- A row moves to Done when its command passes, not when work feels finished.
- A number in a row carries the command that produced it, or the row says unmeasured.
- A request I cannot verify mechanically stays in Open and says why.
