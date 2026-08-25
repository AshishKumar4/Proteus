# Requests ledger

Every request made in conversation, with the state I last verified and the command that
verifies it. A row is DONE only when the command in it passes. A row with no verifying
command is UNVERIFIED and counts as open.

This file exists because an audit found four requests that were designed, discussed, built
and never wired, plus a doc corpus that had drifted from the code it described. Memory was
the tracking mechanism and it failed. `AGENTS.md` holds the gates that make each row
mechanical rather than remembered.

## Open

| Request | State | Verify |
| --- | --- | --- |
| Private node home on the hosted backend | OPEN. A local swarm node receives `nodeHome`; a hosted node reports `shared-origin-plane` and shares the parent home | `packages/cf-backend/src/actor-agent.ts:2511` states that `nodeHome` is deliberately not wired; `cli-backend/src/runtime.ts:601` supplies it |
| Deploy latest to production | OPEN. The live commit must match current `main` | `curl -sS $ORIGIN/api/health \| jq -r .build.sha` equals `git rev-parse --short HEAD` |
| `advance:'pareto'` | UNIMPLEMENTED. It needs a per-instance measurement path and a dominance comparison, not a store | `packages/core/src/strategy/swarm-run.ts:473` refuses it and states that cause |
| No unwarranted timeouts | UNVERIFIED, so it counts as open. Every bound in the agent path was read and is measured, derived or reasoned, and the one invented level clock is deleted. No gate holds that true, and this row stays here until one does | none. The 24 gates in `package.json` include no bounds gate |
| Two doc-claims blind spots, one instrument | OPEN. The gate proves a named symbol or path exists; it cannot judge a prose claim about behaviour ("this suite does not load" names no symbol and stayed green while false), and it reads documents but not code comments (the same dead `workspace-snapshot.ts` citation was caught in `docs/BENCH.md` and rotted in a `.ts` header). Found twice in one wave, by accident both times | none yet. The fix is a claim-shape lint over behaviour sentences plus a path-existence pass over source comments; this row stays open until a gate holds either |
| Nimbus esbuild fix released to npm, patch dropped | OPEN. The fix is merged upstream (`AshishKumar4/Nimbus` PR #1, `ceb3b736`) and carried locally as a pinned patch until a release ships it | `patches/` holds `@nimbus-sh%2Fcore@0.6.0.patch` today; the row closes when `bun run gate:patch-parity` reports no `@nimbus-sh` entry after a version bump |

## Done, with the check that proves it

| Request | Verify |
| --- | --- |
| `fork` off the delegation surface | `AGENTS_TOOL_ACTIONS` has seven entries and none is `fork` |
| Six axes; six named searches including `prove`, plus `custom` | `AXES` in `strategy/swarm.ts:967` names six; `NAMED_SWARM_PRESETS` in `strategy/swarm-presets.ts:15` filters `custom` out of the seven tokens |
| A swarm node is a full agent on one shared loop | `packages/core/src/heads/head-inference.ts:7` states that it owns no loop. `runChat` is the turn body, and a node reaches it through `runHeadInference` (`packages/core/src/strategy/node-agent.ts:684`) |
| A swarm node backgrounds work and is woken | `packages/core/tests/unit-node-backgrounding.test.ts` |
| One suite over orchestrator, subordinate and swarm node | `packages/cf-backend/tests/unit-three-kinds-one-contract.test.ts`: 59 pass, 0 fail, measured 2026-08-24 at `4fd73892b` |
| Mission limits charge swarm node steps | `packages/core/src/tools/agents-tool.ts` supplies `mission`; `packages/core/tests/unit-mission-budget-seams.test.ts:297` charges a toolless node's one call |
| Never weaken a gate | `AGENTS.md:43` |
| Errors carry their cause chain | `bun run gate:silent-drop` |
| Docs name the swarm as the differentiator | `grep -c 'letting executable checks choose the winner' README.md` is 1 |
| How to write docs, verbatim | `AGENTS.md` § "How To Write Docs, Write-Ups, Descriptions, READMEs" |
| Internal records off the remote | `git ls-tree -r --name-only origin/main -- docs/` names none of the three removed audits |

## Rules this ledger follows

- A row moves to Done when its command passes, not when work feels finished.
- A number in a row carries the command that produced it, or the row says unmeasured.
- A request I cannot verify mechanically stays in Open and says why.
