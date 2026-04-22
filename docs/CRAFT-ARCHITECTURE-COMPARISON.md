# Proteus Crafted-Tool Architecture — Seal Comparison

## 0. Background

Three user-visible failures motivate this analysis:

1. **Same-turn invisibility loop.** The LLM calls `workspace.createTool("double", ..., "(n) => n*2")`, which reports `ok: true`, then immediately calls `codemode.double(7)` and gets an empty result (or a `Tool "double" not found` error). The frozen provider snapshot inside `@cloudflare/codemode`'s `createCodeTool` is the root cause; Proteus works around it with a bespoke `LiveCraftedExecutor` that reimplements the sandbox module from scratch (`packages/cf-backend/src/crafted-tool-registry.ts:361-388`).
2. **Opaque errors.** Crafted-tool failures surface to the LLM as bare `.message` strings (`packages/cf-backend/src/crafted-tool-registry.ts:217`, `packages/cf-backend/src/craft-executor.ts:165`). No stack, no tool name, no structured payload.
3. **No workspace/codemode cross-scope from inside a crafted tool.** Because each crafted tool runs as its own child Worker with `const fn = (${code})` and no ambient `workspace` / `codemode` bindings (`packages/cf-backend/src/crafted-tool-registry.ts:67-86`), a crafted tool cannot call `workspace.readFile`, cannot call another crafted tool, and has no standard globals beyond what workerd injects.

Seal solves (1)–(3) almost for free by adopting a *preamble-injection* pattern on top of upstream codemode's `DynamicWorkerExecutor`. This doc compares the two architectures and lays out a phased upgrade plan.

## 1. Seal Execution Harness

Seal defers the sandbox Worker module to upstream `@cloudflare/codemode` and composes `DynamicWorkerExecutor` as-is:

- **Harness construction.** `new DynamicWorkerExecutor({ loader })` at `/workspace/seal/packages/agent-utils/src/codemode/builder.ts:217`. Only `loader` is passed. No `globalOutbound`, no `modules`, no `timeout` — Seal inherits every codemode default (no `fetch`, no `fs`, no `require`, a `Proxy` per provider namespace, console logs captured into `__logs[]`).
- **Signature enforcement.** Crafted code MUST start with `async ( … ) => { … }`. Validated at `/workspace/seal/apps/seal/worker/agent/tools/craft-tool.ts:141-148` with a chained `.trim()` + `startsWith("async")` + `includes("=>")`. Non-conforming code is rejected at `craft_tool` call time.
- **Injection point.** The LLM's own script is ALSO an `async (...) => { ... }` arrow — that is codemode's sandbox entry shape. Seal splices a `const tools = { ... }` preamble into the head of that arrow:
  - Preamble builder: `/workspace/seal/packages/agent-utils/src/codemode/builder.ts:114-121`.
  - Regex splice: `/workspace/seal/packages/agent-utils/src/codemode/builder.ts:140-144`.
- **Two lexical namespaces inside one sandbox.** Because the preamble is injected *inside* the LLM's arrow, two names are both in scope:
  - `tools.<name>` — a literal fn reference on the object literal. Crafted-to-crafted calls are late-bound on the object; no dispatcher hop.
  - `codemode.<name>` — the upstream codemode `Proxy` that dispatches over RPC to the host `DynamicWorkerExecutor`.
- **Crafted-to-crafted calls.** A crafted tool's body can freely call `tools.other(args)`; the object-literal property lookup happens at call time, so tools can refer to each other by name even if they were authored in arbitrary order.
- **Crafted-to-host calls.** A crafted tool's body can call `codemode.host_tool(args)` because `codemode` is the Proxy bound in the outer arrow's closure — still in lexical scope when the preamble's arrow runs.

## 2. Seal Error Propagation

- Errors surface as **bare strings** (`err.message`), NOT a structured `{error, stack, toolName}` envelope.
  - Stream emission: `/workspace/seal/apps/seal/worker/agent/ai/stream.ts:196`.
  - Codemode builder rethrow: `/workspace/seal/packages/agent-utils/src/codemode/builder.ts:67-68`.
- **Logs DO surface** through a different channel. Codemode's module stubs override `console.log/warn/error` to push into `__logs[]`, and the host reads that array back as `logs` on the `CodemodeResult`: `/workspace/seal/packages/agent-utils/src/codemode/builder.ts:181`. The LLM can thus `console.log` inside a crafted tool and see the output on the next turn.
- No `stack` is sent back. No `toolName` attribution. Seal has chosen "logs for positive signal, short strings for failures".

## 3. Seal Tool Registry

Seal treats the SQL `CraftStore` as the single source of truth — no in-memory mirror.

- **No in-memory mutation cache.** `craft_tool` → `store.create()` → SQL `INSERT`: `/workspace/seal/apps/seal/worker/agent/tools/craft-tool.ts:130` → `/workspace/seal/packages/agent-utils/src/stores/craft.ts:83-96`.
- **Same-turn visibility via re-read, not via mutation.** `CraftedToolExecutor.execute` calls `craftStore.getAll()` fresh on every `execute()` (`/workspace/seal/packages/agent-utils/src/codemode/builder.ts:136`). No registry, no subscription — just "query the DB every call".
- **Next-step, not next-arrow.** A newly saved tool is callable in the NEXT codemode invocation — same turn, different step. Within a single `execute_tools` arrow the tool set is frozen (the preamble is built once from that `getAll()` snapshot).
- **LiveToolExecutor parallel.** The MCP path uses the same pattern: `LiveToolExecutor.execute` rebuilds its fns per execute from `getLiveTools()`. Mid-turn MCP tool discovery works the same way.
- **Surfacing.** Crafted tools are ONLY available inside codemode as `tools.<name>`. They are NOT surfaced as top-level AI SDK tools. The LLM is told so by the system prompt: `"Crafted tools are available in codemode as tools.name(args)"` at `/workspace/seal/apps/seal/worker/agent/ai/system-prompt.ts:244`.
- **LLM-visible namespace docs.** The `execute_tools` description at `/workspace/seal/apps/seal/worker/agent/codemode.ts:12-26` spells BOTH namespaces explicitly: "workspace tools … as `codemode.toolName(args)`" and "Agent-crafted tools … as `tools.name(args)`".

## 4. Seal LOADER Worker Module

Seal does NOT own a LOADER Worker module at all. A grep for `env.LOADER.get(` across the Seal tree returns **zero** direct hits — all LOADER plumbing flows through upstream codemode's `DynamicWorkerExecutor`. The executor module source that runs inside the child Worker is upstream codemode `@0.1.3` unmodified.

The only platform-owned piece is the string manipulation that produces the LLM's arrow-body-plus-preamble before handing it to `DynamicWorkerExecutor.execute`:

```ts
// /workspace/seal/packages/agent-utils/src/codemode/builder.ts:114-121
function buildToolsPreamble(craftedTools: CraftedTool[]): string {
  if (craftedTools.length === 0) return "";
  const entries = craftedTools.map((t) => {
    const code = t.code.trim();
    return `    ${t.name}: ${code}`;
  });
  return `const tools = {\n${entries.join(",\n")}\n  };\n  `;
}
```

```ts
// /workspace/seal/packages/agent-utils/src/codemode/builder.ts:140-144
const injected = code.replace(
  /^(\s*async\s*\([^)]*\)\s*=>\s*\{)/,
  `$1\n  ${preamble}`,
);
```

Normalization of stored code is a single `.trim()`. No semicolon stripping, no declaration→expression rewriting, no parenthesization. The stored form is already a legal expression because the `craft_tool` signature gate enforces it.

## 5. Proteus Current State

Direct reading of the Proteus tree follows. All paths are relative to repo root (`/workspace/proteus/`).

### 5.1 Files observed

- `packages/core/src/tools/builtins.ts` — the canonical 5-tool factory. Crafted tools are materialized as object-shaped entries in a `craftedToolSet` via `buildCraftedToolSetFromExecute` (`:107-150`) and handed to codemode through `deps.createExecuteTool({ tools: craftedToolSet, providers, loader })` (`:197-204`) or bypassed entirely via `deps.preBuiltExecuteTool` (`:195-196`). The CF path takes the `preBuiltExecuteTool` branch (see §5.5).
- `packages/core/src/tools/crafted-executor.ts` — type-only module. Defines `CraftedToolSource` (`:26-30`), `CraftedToolExecuteFn` (`:38`), `CraftedToolExecute` factory type (`:47`), and a platform-probe helper `codegenDisallowed()` (`:67-77`). No runtime behaviour.
- `packages/core/src/tools/registry.ts` — name table. 5 builtin names, 3 session tools (`:12-26`). Description of `execute_tools` at `:40-41` reads: *"Write JS to accomplish tasks. workspace.* for files/shell, codemode.* for learned patterns. Runs in sandboxed Worker."* No `tools.*` namespace mentioned anywhere.
- `packages/cf-backend/src/crafted-tool-registry.ts` — houses BOTH the per-tool child Worker factory (`CraftedToolRegistry`, `:113-221`) AND a full reimplementation of `DynamicWorkerExecutor` (`LiveCraftedExecutor`, `:274-408`).
- `packages/cf-backend/src/craft-executor.ts` — earlier per-tool LOADER executor (`createCFCraftedExecute`, `:129-170`). Currently unused on the CF path because the orchestrator takes the `preBuiltExecuteTool` branch; the child-Worker module source is duplicated almost verbatim between this file (`:55-74`) and `crafted-tool-registry.ts` (`:67-86`).
- `packages/core/src/execution/inline.ts` — the `workspace` provider. Exposes `readFile`, `writeFile`, `readdir`, `exists`, `exec`, `searchMemory`, `saveNote`, `listTools`, `createTool`. The `createTool` execute body (`:133-184`) calls `onToolRegistered` (`:152` and `:178`) to wake the live registry.
- `packages/cf-backend/src/orchestrator.ts` — the Think subclass. Imports `createCodeTool` from `@cloudflare/codemode/ai` (`:48`) and assembles its own wiring (`getExecuteToolsTool`, `:161-203`), passing `LiveCraftedExecutor` into `createCodeTool` as the `executor:` option.
- `packages/cf-backend/src/runtime.ts` — plumbing. Wires `onToolRegistered` from orchestrator hooks into the inline executor (`:105`). Also constructs an *unrelated* DWE for scaffold-parse-gate use (`createExecutor`, `:233-245`) — this DWE is NOT the one the crafted-tool path uses.

### 5.2 Directory check — `crafted.ts` absence

`ls packages/core/src/tools/` returns exactly:

```
builtins.ts
crafted-executor.ts
registry.ts
```

There is **no `crafted.ts`** in `packages/core/src/tools/`. If prior designs or docs reference such a file, it has been deleted or renamed to `crafted-executor.ts`.

### 5.3 `new Function` audit

`grep -rn "new Function" packages/cf-backend/src/ packages/core/src/tools/` returns only doc-comment mentions:

- `packages/cf-backend/src/craft-executor.ts:5` — comment explaining why codegen is banned.
- `packages/cf-backend/src/crafted-tool-registry.ts:17` — comment explaining the fix.

No runtime `new Function(…)` call on the CF path. Good.

### 5.4 Harness ownership — Proteus reimplements the sandbox

`LiveCraftedExecutor.execute` at `packages/cf-backend/src/crafted-tool-registry.ts:274-408` builds its OWN executor module string (`:361-388`) and spawns it directly via `this.#loader.get(...)` (`:391-397`). The module re-creates (from scratch) the exact pieces upstream codemode's DWE provides for free:

- Per-provider `Proxy` over `__dispatchers.<p.name>.call(name, argsJson)` (`:370-375`).
- Log capture into `__logs[]` via console rebinding (`:366-369`).
- Timeout via `Promise.race` + `setTimeout` (`:378-381`).
- Error-to-result envelope (`:383-385`).

The reason cited at `:224-236` is that codemode's DWE sanitizes dispatcher keys (e.g. reserved words like `double` → `double_`), which broke `codemode.double(7)` on the user's repro. The fix is to skip the sanitize pass and keep keys intact (`:332-337`).

### 5.5 Signature

Proteus does NOT enforce a signature. `workspace.createTool` (`packages/core/src/execution/inline.ts:133-184`) accepts arbitrary `code: string` and stores it. The child-Worker wrapper is `const fn = (${code});` at:

- `packages/cf-backend/src/crafted-tool-registry.ts:71`
- `packages/cf-backend/src/craft-executor.ts:59`

Any expression that parenthesizes cleanly is accepted — arrow functions, function expressions, IIFEs, etc. The comment at `craft-executor.ts:51-54` notes the store-time normalizer *should* guarantee expression shape, but there is no such normalizer in the code.

### 5.6 Same-turn visibility

Proteus implements same-turn visibility via an **in-memory live registry** whose `fns` dict is mutated synchronously by `workspace.createTool`:

- `onToolRegistered` hook on the inline executor (`packages/core/src/execution/inline.ts:152, :178`).
- CF runtime forwards the hook to the orchestrator (`packages/cf-backend/src/runtime.ts:105`).
- Orchestrator wires it to `this.getCraftRegistry().addOrRefresh(tool)` (`packages/cf-backend/src/orchestrator.ts:105-111`).
- `CraftedToolRegistry.addOrRefresh` inserts into `this.fns[tool.name]` (`packages/cf-backend/src/crafted-tool-registry.ts:132-144`).
- `LiveCraftedExecutor.execute` spreads `{ ...this.#registry.fns }` into the `codemode` provider's fns on every call (`packages/cf-backend/src/crafted-tool-registry.ts:313`), so a tool created inside one `execute_tools` call is visible to the NEXT `execute_tools` call in the same turn.

Note: visibility is **still cross-step**, not cross-arrow. Within a single `execute_tools` arrow the `codemode` Proxy dispatches into the registry at call time, so in principle a tool created by `workspace.createTool` earlier in the SAME arrow would be dispatchable — but only if the LLM writes that sequence, which is rare in practice. Seal deliberately does not attempt this.

### 5.7 Error format

Proteus also returns string-form errors, consistently:

- Per-tool child Worker: `return { error: err && err.message ? err.message : String(err) }` — `packages/cf-backend/src/crafted-tool-registry.ts:81`, `packages/cf-backend/src/craft-executor.ts:69`.
- Registry execute closure: `if (res.error) throw new Error(res.error)` — `packages/cf-backend/src/crafted-tool-registry.ts:217`, `packages/cf-backend/src/craft-executor.ts:165`.
- `LiveCraftedExecutor` dispatcher: `JSON.stringify({ error: err instanceof Error ? err.message : String(err) })` — `packages/cf-backend/src/crafted-tool-registry.ts:352-356`.
- LiveCraftedExecutor top-level: `{ result: undefined, error: err.message, logs: __logs }` — `packages/cf-backend/src/crafted-tool-registry.ts:384`.

No stack, no `toolName` in the payload.

### 5.8 Logs

`LiveCraftedExecutor`'s reimplemented module captures logs into `__logs[]` (`packages/cf-backend/src/crafted-tool-registry.ts:366-369`) and returns them in the response (`:382-384`). So logs DO surface via that path.

The **per-tool child Worker** (`craftedToolWorkerModule`) has NO log capture (`:67-86`) — a crafted tool's `console.log` inside its own function body runs in the child Worker's isolated console and is lost.

### 5.9 In-sandbox cross-namespace access from crafted tool bodies

Crafted code runs inside `const fn = (${code});` in a child Worker (`packages/cf-backend/src/crafted-tool-registry.ts:71`, `packages/cf-backend/src/craft-executor.ts:59`). No `workspace`, no `codemode`, no `tools` binding exists in that lexical scope. A crafted tool cannot call another crafted tool, cannot read a file, cannot search memory. Its only capability is computing over the arguments it receives.

The `LiveCraftedExecutor`'s executor-module Proxies (`codemode`, `workspace`, etc.) are defined in the OUTER `evaluate()` async fn only (`packages/cf-backend/src/crafted-tool-registry.ts:370-375`). The LLM's user code runs in that scope as `(${code})()` (`:379`). But when the LLM calls `codemode.double(7)`, dispatch hops back to the host, which calls the child Worker's `fn`, which has its own fresh environment. The crafted fn never sees the outer Proxies.

### 5.10 Surfacing

Crafted tools are surfaced ONLY inside `execute_tools` as `codemode.*`. They are not surfaced as top-level AI SDK tools. This matches Seal.

Proteus's `execute_tools` description (`packages/core/src/tools/registry.ts:40-41`) tells the LLM: `"workspace.* for files/shell, codemode.* for learned patterns"`. No mention of `tools.*`.

### 5.11 Normalization of stored code

None. `workspace.createTool` stores `String(code)` directly (`packages/core/src/execution/inline.ts:149, :168-174`). Whitespace trimming, signature validation, and expression-shape checks are all absent.

## 6. Delta Table

| Dimension | Seal | Proteus | Gap | Fix |
|---|---|---|---|---|
| Sandbox harness ownership | Upstream `DynamicWorkerExecutor({ loader })` at `builder.ts:217`, module source from codemode `@0.1.3` unmodified. | Custom `LiveCraftedExecutor` (`packages/cf-backend/src/crafted-tool-registry.ts:274-408`) that hand-rolls Proxies, log capture, timeout, error envelope — reimplementing the codemode sandbox module inside Proteus's tree. | ~130 LOC of codegen that duplicates upstream codemode and drifts on every codemode release. | Delete the hand-rolled executor module. Delegate to `DynamicWorkerExecutor` and inject a Seal-style `const tools = {...}` preamble instead. |
| Crafted-tool signature enforcement | Hard gate at `craft-tool.ts:141-148`: must start with `async` and include `=>`. | None. `String(code)` accepted as-is (`packages/core/src/execution/inline.ts:149`), wrapped as `const fn = (${code})` (`packages/cf-backend/src/crafted-tool-registry.ts:71`). Any expression flies. | Invalid code is only caught at child-Worker compile time, as a runtime error on first call. No next-turn callability guarantee. | Validate at `workspace.createTool` time; reject with actionable message before write. Update description/prompts. |
| In-sandbox `workspace.*` access from crafted tool body | Free — `workspace` is a Proxy in the enclosing arrow's lexical scope; crafted code runs inline as `tools.<name>` in the same arrow. | Absent. Crafted code runs in a per-tool child Worker with `const fn = (${code});` only (`packages/cf-backend/src/crafted-tool-registry.ts:67-86`). No `workspace` binding. | Crafted tools cannot compose with workspace primitives at all. | Same fix as harness: move crafted tools to preamble inside the main sandbox arrow → `workspace` is lexically in scope. |
| In-sandbox `codemode.*` access from crafted tool body | Free — `codemode` Proxy is also lexically in scope inside the arrow. A crafted tool can call a host tool. | Absent for same reason. | Crafted tools cannot call host tools. | Same fix; single change unlocks both namespaces. |
| In-sandbox `fetch` / `crypto` / standard globals | Whatever codemode's sandbox grants (no `fetch` by default; `crypto` available as workerd global). | Per-tool child Worker gets workerd defaults with `globalOutbound: null` — no outbound `fetch`. Standard globals (crypto, URL, etc.) present. | Parity with Seal on most axes, but Proteus is less flexible because each tool gets its own Worker, paying cold-start and LOADER cache cost. | After delegating to DWE, globals match codemode's exactly. `globalOutbound: null` can be set as a DWE option. |
| Error format | Bare string `err.message` propagated to LLM (`stream.ts:196`, `builder.ts:67-68`). | Bare string `err.message` at every layer (`packages/cf-backend/src/crafted-tool-registry.ts:81, :217, :352-356, :384`; `packages/cf-backend/src/craft-executor.ts:69, :165`). | Matches Seal. But the *project* wants structured `{error, stack, toolName}` — neither currently produces this. | Wrap the executor result with a structured envelope on the way back to the tool-output channel. Include `toolName` from the dispatcher, `stack` from `err.stack`. |
| Logs surfaced to LLM | Yes — codemode module rebinds console, returns `logs` on `CodemodeResult` (`builder.ts:181`). | Partial. The `LiveCraftedExecutor`-built module captures logs (`packages/cf-backend/src/crafted-tool-registry.ts:366-369, :382`). Per-tool child Worker does NOT (`packages/cf-backend/src/crafted-tool-registry.ts:67-86`). | Logs inside a crafted-tool body are dropped on the floor. | Once crafted tools run as preamble inside the DWE arrow, console rebinding from upstream codemode captures them automatically. |
| Same-turn visibility mechanism | Re-read `craftStore.getAll()` on every `execute()` (`builder.ts:136`). SQL is the source of truth. No in-memory mirror. | In-memory `CraftedToolRegistry.fns` dict mutated synchronously by `onToolRegistered`. `LiveCraftedExecutor.execute` spreads it into the codemode provider (`packages/cf-backend/src/crafted-tool-registry.ts:313`). Registry is re-synced from SQL at each `getTools()` rebuild (`packages/cf-backend/src/orchestrator.ts:210-221, :335`). | Proteus carries a dual-store (SQL + registry) with cache-coherence rules. Seal has one store. | After Phase A, delete the registry and read `rt.craftStore.list()` at preamble-build time — same pattern. |
| Dual surfacing (top-level AI SDK tools) | No. Only `tools.<name>` inside codemode. System prompt explicitly says so (`system-prompt.ts:244`). | No. Only `codemode.<name>`. Registry description (`packages/core/src/tools/registry.ts:40-41`) matches. | Matches Seal. | No change (Phase E covers the optional inverse). |
| Normalization of stored code | `.trim()` only. No decl→expr rewrite (signature gate makes it unnecessary). | None. Raw `String(code)` stored. | Proteus relies on `const fn = (${code})` to implicitly parenthesize arbitrary expressions. Function declarations and statement-form code silently fail. | After Phase D's signature gate, `.trim()` is sufficient because only arrow-form code passes. |

## 7. Upgrade Plan — 5 Phases

### Phase A — Adopt Seal's preamble pattern

**Title.** `refactor(crafted): delegate sandbox to DynamicWorkerExecutor with preamble injection`

**Files touched.**
- `packages/cf-backend/src/crafted-tool-registry.ts` — delete `LiveCraftedExecutor` (`:274-408`) and the reimplemented executor-module source (`:361-388`). Keep `CraftedToolRegistry`'s loader plumbing only if still needed for per-tool Worker fallback; otherwise delete the whole file.
- `packages/cf-backend/src/orchestrator.ts` — replace `getExecuteToolsTool()` (`:161-203`) with a wrapper around upstream `DynamicWorkerExecutor` that injects the preamble from `rt.craftStore.list()` at every execute.
- `packages/core/src/tools/builtins.ts` — `buildCraftedToolSetFromExecute` (`:107-150`) becomes unused on the CF path once crafted tools move to preamble; keep for CLI-backed `createExecuteTool` or adapt both to the preamble model.

**Before.** The CF path calls `createCodeTool({ tools: [craftedProvider, ...executorProviders], executor: new LiveCraftedExecutor(...) })` (`packages/cf-backend/src/orchestrator.ts:197-200`). Crafted tools are dispatcher-backed over RPC into per-tool child Workers; `LiveCraftedExecutor` reimplements the sandbox.

**After.** The CF path calls a Seal-shaped wrapper: upstream `DynamicWorkerExecutor({ loader })`, and a thin `CraftedToolExecutor` that (a) reads `rt.craftStore.list()` on every call, (b) builds the `const tools = {\n  ${name}: ${code.trim()},\n  ...\n};` preamble, (c) splices via `code.replace(/^(\s*async\s*\([^)]*\)\s*=>\s*\{)/, $1\n  ${preamble})`, and (d) hands the injected code to `dwe.execute(injected, providers)`.

**Empirical test.**
- Repro 1: `workspace.createTool("double", "double a number", "async ({n}) => n*2")` then `codemode.double({n:7})` in next step → returns `14`.
- Repro 2: crafted `triple` body `async ({n}) => tools.double({n}) * 1.5` then `codemode.triple({n:4})` → returns `12` (crafted-to-crafted via preamble namespace).
- Repro 3: crafted `readAndReturn` body `async ({path}) => codemode.workspace_readFile(path)` → works because `codemode` proxy is in lexical scope of the spliced arrow. (Or the equivalent `workspace.readFile` binding — whichever namespace the preamble sits inside.)
- `console.log` inside a crafted tool body shows up in the tool-output logs array.

---

### Phase B — Structured error payload

**Title.** `feat(crafted): structured error payloads with stack + toolName`

**Files touched.**
- `packages/cf-backend/src/orchestrator.ts` — wrap the DWE result before handing it to Think's tool-output-available channel. Build `{ error, stack, toolName }` on non-null `error`.
- `packages/core/src/tools/crafted-executor.ts` — extend `CraftedToolSource` type, or add a new `CraftedToolError` type.
- Child-Worker module string (if any remain) — capture `err.stack` and `toolName` alongside `err.message`.

**Before.** Error surfaces as a string: `{ error: "something broke" }` — no stack, no attribution. `packages/cf-backend/src/crafted-tool-registry.ts:81, :352-356, :384`; `packages/cf-backend/src/craft-executor.ts:69, :165`.

**After.** Error surfaces as a JSON object: `{ error: { message, stack, toolName, providerName } }`. The LLM sees the tool name that failed and a truncated stack (first 10 frames, function names stripped of randomized Worker ids).

**Empirical test.**
- Create a tool `async () => { throw new Error("boom") }`. Call it. Inspect the tool-output-available payload in the activity log — should contain `error.message === "boom"`, `error.toolName === "boom_tool"`, `error.stack` starting with `Error: boom`.
- Create a tool that re-throws with a chain (`cause`). Verify `cause.message` is preserved.

---

### Phase C — Free ergonomic helpers inside crafted tool bodies

**Title.** `feat(crafted): tools inherit workspace.* and codemode.* scope via preamble`

**Files touched.** None of the core files — this is emergent from Phase A. Only docs and prompts update.
- `packages/core/src/tools/registry.ts` — update `execute_tools` description to call out `tools.*` (the crafted namespace) alongside `workspace.*` and `codemode.*`.
- System prompt — add a sentence à la Seal's `system-prompt.ts:244`: *"Crafted tools are available inside execute_tools as `tools.<name>(args)`. Their bodies may also call `workspace.*` and `codemode.*`."*

**Before.** A crafted tool body runs in a child Worker with no bindings except args. Crafted-to-crafted composition requires the LLM to reimplement logic in each tool.

**After.** Crafted tool bodies compose freely. `tools.helperA` callable from `tools.helperB`; `workspace.readFile` callable from any crafted tool; `codemode.explore` callable from any crafted tool.

**Empirical test.**
- `workspace.createTool("grepFiles", "grep across files", 'async ({query}) => { const files = await workspace.readdir("/src"); return Promise.all(files.map(f => workspace.readFile(f).then(c => c.includes(query) ? f : null))).then(r => r.filter(Boolean)) }')`. Then `codemode.grepFiles({query: "TODO"})` returns a list of files.
- Chain: `tools.a` calls `tools.b` calls `workspace.exec("ls")`. Full chain returns shell output.

---

### Phase D — Signature enforcement + better hint

**Title.** `feat(crafted): enforce async arrow signature + next-turn callability hint`

**Files touched.**
- `packages/core/src/execution/inline.ts` — in `createTool.execute` (`:133-184`), after the name-sanitization block, add signature validation: `codeStr.trim().startsWith("async") && codeStr.includes("=>")`. If fails, return `{ ok: false, error: "Crafted tools must be async arrow functions: async (args) => { ... }. Got: <first 60 chars>" }`.
- `packages/core/src/execution/inline.ts` — update the `types` block (`:187-205`) to reflect the contract. Change `createTool`'s description (`:134`) to document the signature, and update the "same turn" claim to read "callable as `codemode.<name>(args)` in the NEXT step of the same turn".
- `packages/core/src/tools/registry.ts` — add a second sentence to `execute_tools` description: *"Crafted tools appear as `tools.<name>` inside the sandbox; their bodies may also call `workspace.*` and `codemode.*`."*
- System prompt — mirror the Seal wording.

**Before.** Arbitrary code accepted. `const fn = (${code})` silently eats declarations by wrapping them as grouping expressions, failing at first call with a compile error.

**After.** Only valid async arrow functions accepted. Failure surface is immediate and at `createTool`, not later at first `codemode.<name>` call.

**Empirical test.**
- `workspace.createTool("bad", "...", "function x() { return 1 }")` → returns `{ ok: false, error: <signature hint> }`. No row in `crafted_tools`.
- `workspace.createTool("good", "...", "async () => 1")` → `{ ok: true, action: "created" }`.
- Round-trip: `codemode.good()` → `1` on the next step.

---

### Phase E — Dual surfacing (optional, tradeoff-gated)

**Title.** `feat(crafted): optionally expose crafted tools as top-level AI SDK tools`

**Files touched.**
- `packages/core/src/tools/builtins.ts` — loop over `rt.craftStore.list()` and add each as a top-level `ToolSet` entry, driving into the same preamble executor (or a per-tool wrapper that calls the preamble path with a single-tool filter).
- `packages/core/src/tools/registry.ts` — extend `ACTIVE_TOOLS` per-turn from `BUILTIN_TOOLS ∪ {crafted names}` (careful — this grows the request payload).
- Orchestrator cache-key logic — adjust `_craftCacheKey()` (`packages/cf-backend/src/orchestrator.ts:296-310`) to invalidate on crafted-tool name churn.

**Before.** Crafted tools are ONLY available via `execute_tools`. The LLM must write JS to invoke them.

**After.** Crafted tools ALSO appear as direct AI SDK tools, so the LLM can call `double({n: 7})` without going through `execute_tools`.

**Tradeoff (flag at PR).**
- Seal deliberately does NOT do this. Every extra top-level tool bloats the system-message tool schema — 100 crafted tools ≈ +5–20k tokens per request.
- The codemode namespace `codemode.<name>` is already more efficient (one tool schema, N implementations) and composes with other sandbox operations.
- Activating dual surfacing erases the "codemode as the crafted-tool gateway" invariant and forces ongoing name-sanity rules (e.g. avoid collisions with `save_note`, `run`).

**Recommendation.** Defer unless there is explicit user-facing benefit. The composability gain from Phase C is probably what the agents want; direct dispatch rarely pays for the context-window cost.

**Empirical test.** (if shipped)
- Newly crafted tool shows up in `getTools()` output within one turn boundary.
- Direct call `double({n:7})` from the LLM returns `14` WITHOUT `execute_tools`.
- Token count of a vanilla chat request, with 20 crafted tools, is within a documented budget.

## 8. Recommended ordering

| Phase | Priority | Rationale |
|---|---|---|
| A — Preamble pattern | **Must do.** | Deletes ~130 LOC of reimplemented sandbox, eliminates drift-on-every-codemode-release, eliminates the reserved-word bug class by construction (no dispatcher-key sanitize pass to bypass), unlocks Phase C automatically. |
| B — Structured errors | **Must do.** | Bare strings are the #2 user-visible pain. `toolName` attribution is table stakes for multi-tool sandboxes. Independent of A; could ship in either order, but ordering A first lets B hook the cleaner DWE result. |
| C — Free ergonomic helpers | **Must do — but free.** | Emergent from A. Only docs/prompt work. Ship immediately after A so the LLM knows the new capability exists (otherwise agents won't discover it). |
| D — Signature enforcement | **Nice-to-have, do soon.** | Prevents a silent-fail class (stored code that never parses as an expression). Only ~30 LOC; cheap to include alongside A/B/C. |
| E — Dual surfacing | **Defer.** | Explicit tradeoff; Seal passes. No current Proteus pain report identifies this as the blocker. Revisit if crafted-tool-discovery inside `execute_tools` proves to be a bottleneck (e.g. model cannot figure out to use `codemode.*` even after prompt changes). |

**Suggested commit order.** A → C (doc-only, piggyback on A's PR) → D → B → (Phase E if/when needed).

## 9. Open questions

1. **Do we keep `globalOutbound: null`?** Seal inherits whatever upstream codemode grants; Proteus currently pins `globalOutbound: null` at both the per-tool Worker (`packages/cf-backend/src/crafted-tool-registry.ts:210`, `packages/cf-backend/src/craft-executor.ts:156`) and the live executor (`packages/cf-backend/src/crafted-tool-registry.ts:396`). Delegating to DWE means picking the codemode default (no outbound `fetch`) or overriding. **Decision needed:** should crafted tools ever `fetch(...)`? If so, what is the allow-list policy? (Seal's answer is "no by default, configured per-deployment".)
2. **Live-dispatch vs static preamble for same-arrow visibility.** Seal's preamble is built once per `execute_tools` call and is frozen for that arrow. Proteus's current `LiveCraftedExecutor` re-reads the registry *inside* the execute path, so in theory a tool created by `workspace.createTool` earlier in the SAME arrow is dispatchable. Is that capability worth keeping, or do we accept Seal's "next-step, not next-arrow" contract? (Recommendation: accept Seal's contract — same-arrow dispatch is a rare pattern and the architectural cost is high.)
3. **Top-level surfacing (Phase E).** Under what conditions would we want crafted tools as direct AI SDK tools? Is there a specific agent-side failure mode (e.g. "LLM forgets `codemode.*` prefix") that would motivate it, and is that failure mode more cheaply fixed by prompt engineering?
4. **Error payload format.** `{ error: { message, stack, toolName, providerName } }` — or flatten to `{ error_message, error_stack, error_tool }`? The flat form is friendlier to Vercel AI SDK's `tool-output-available` JSON-stringification in activity logs; the nested form is more extensible. Decide before Phase B lands.
