# Crafted Tool Loading — Worker-Loader Architecture

**Status**: implementation plan. Fixes the production CF runtime error
`"Code generation from strings disallowed for this context"` produced by
`new Function()` inside V8 isolates.

## 1. What changed vs v2.0

v2.0 centralized tool construction in `@proteus/core/tools/builtins.ts` but
*preserved* `new Function()` — so crafted tools still fail in CF production.

The fix is smaller than v2.0's auxiliary `CraftedToolLoader` abstraction
(now dropped): crafted tools are *just* entries in the `tools` record that
`createCodeTool` already accepts. Codemode places them under `codemode.*`
and dispatches every call over RPC to a host-side function. The fix is to
make that host-side function platform-correct — a child Worker call on CF,
a Node `new Function` on CLI.

```
                 ┌─────────────────────────────────────────────────────┐
                 │                    Orchestrator DO                  │
                 │   (V8 isolate — codegen DISALLOWED)                 │
                 │                                                     │
LLM ──code──▶    │  execute_tools.execute({code})                      │
                 │    │                                                │
                 │    ▼                                                │
                 │  createCodeTool({tools, providers, loader}).execute │
                 │    │                                                │
                 │    │  spawns a child Worker via LOADER.get(...)     │
                 │    ▼                                                │
                 │  ┌────────────────────────────────────────────────┐ │
                 │  │ Sandbox Worker (isolate — LLM code runs here)  │ │
                 │  │                                                │ │
                 │  │  const codemode = new Proxy({}, {              │ │
                 │  │    get: (_, name) => async (args) =>           │ │
                 │  │      __dispatchers.codemode.call(name, args)   │ │
                 │  │  });                                           │ │
                 │  │                                                │ │
                 │  │  codemode.double(21)                           │ │
                 │  │    │                                           │ │
                 │  │    └─── RPC ──┐                                │ │
                 │  └───────────────┼────────────────────────────────┘ │
                 │                  │                                  │
                 │                  ▼                                  │
                 │  ToolDispatcher.call("double", "[21]")              │
                 │    │                                                │
                 │    ▼                                                │
                 │  fns["double"](21)   ◀── our host-side fn ──┐       │
                 │    │                                       │       │
                 │    │  CF: LOADER.get("crafted-double-<h>") │       │
                 │    │         .getEntrypoint().invoke("[21]")       │
                 │    │  CLI: (new Function("return "+code))()(21)    │
                 │    ▼                                                │
                 │  42                                                 │
                 └─────────────────────────────────────────────────────┘
```

Key insight: the LLM-facing `codemode.double(args)` call never runs
crafted code in the orchestrator DO. The DO only dispatches. The
crafted code itself runs in a child Worker on CF (where `new Function`
is banned but module compilation is fine), or via `new Function` on
CLI (where V8 codegen is allowed).

## 2. What we keep / drop from the earlier plan

**Kept**:
- Child-Worker execution for crafted tools on CF (via `env.LOADER`).
- Node `new Function` on CLI.
- One-time migration to merge pre-fix case-collision duplicates
  (`multiplyNumbers` + `multiplynumbers`).
- Scaffold-validator fix: CF uses LOADER-based probe; CLI keeps eval.

**Dropped**:
- `CraftedToolLoader` interface as a separate abstraction.
- `WorkerLoaderCraftedLoader` / `NodeEvalCraftedLoader` classes.
- `workspace.invokeCrafted()` helper — no longer needed (see §5).
- Proxy-based live-lookup in the codemode namespace (builtins.ts:180-208).
- The `loadFilteredCraftedTools` intermediary — merged into `buildBuiltinTools`.

## 3. Design

### 3.1 Factory injection

`buildBuiltinTools` grows one new dependency: a platform-specific
function that turns a stored crafted tool into an `execute` callback.

```ts
// @proteus/core/tools/builtins.ts
export type CraftedExecutor = (
  tool: { name: string; description: string; code: string },
) => (...args: unknown[]) => Promise<unknown>;

export interface BuiltinToolDeps {
  rt: AgentRuntime;
  engine: EvolutionEngine;
  /** Platform-correct host-side callback for each crafted tool.
   *  CF adapter: dispatches to a child Worker spawned via env.LOADER.
   *  CLI adapter: wraps `new Function()` (Node codegen is allowed).
   *  Absent: crafted tools are skipped silently (warn). */
  craftedExecutor?: CraftedExecutor;
  // ... existing optional fields (codemodeLoader, createExecuteTool, etc.)
}
```

`buildBuiltinTools` body (roughly):

```ts
const crafted = loadFilteredCraftedTools(rt);
// crafted is Array<{ name, description, code, effectiveScore }>
// already filtered by minEffectiveScoreForInjection

const craftedTools: Record<string, { description: string; execute: ... }> = {};
if (deps.craftedExecutor) {
  for (const t of crafted) {
    craftedTools[t.name] = {
      description: t.description,
      execute: deps.craftedExecutor(t),  // platform-specific
    };
  }
}

// Pass to codemode: crafted tools are just more entries under the
// default "codemode" namespace. NO namespace collision with workspace.*.
tools.execute_tools = deps.createExecuteTool({
  tools: craftedTools,
  providers: router?.getProviders() ?? [],
  loader: deps.codemodeLoader,
});
```

The existing execute-fn map (`loadFilteredCraftedTools` with
`invocation: 'inline-function'`) disappears. The fallback-path Proxy
(`builtins.ts:180-208`) disappears. Two removals are worth ~50 net LOC.

### 3.2 CF adapter — `packages/cf-backend/src/runtime.ts`

```ts
import type { CraftedExecutor } from "@proteus/core";

function createCraftedExecutor(loader: WorkerLoader): CraftedExecutor {
  return (tool) => {
    // Content-addressed name: code changes produce a new Worker.
    // LOADER's own cache handles re-use across calls to the same
    // (name, factory) pair; code change → different name → new Worker.
    const codeHash = sha256hex(tool.code).slice(0, 10);
    const workerName = `crafted-${sanitizeIdent(tool.name)}-${codeHash}`;
    const moduleSrc = craftedToolWorkerModule(tool.code);

    return async (...args: unknown[]) => {
      const stub = loader.get(workerName, () => ({
        compatibilityDate: "2025-06-01",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "tool.js",
        modules: { "tool.js": moduleSrc },
        globalOutbound: null,  // no external network by default
      }));
      const entry = stub.getEntrypoint() as unknown as {
        invoke(argsJson: string): Promise<{ result?: unknown; error?: string }>;
      };
      const res = await entry.invoke(JSON.stringify(args));
      if (res.error) throw new Error(res.error);
      return res.result;
    };
  };
}
```

`sha256hex` is stdlib-only (`crypto.subtle.digest`). `sanitizeIdent`
strips non-ident chars so the LOADER key is always valid.

### 3.3 Worker module template

A single constant in `packages/cf-backend/src/crafted-worker-module.ts`
(or inlined in `runtime.ts`):

```ts
export function craftedToolWorkerModule(code: string): string {
  // `code` is the stored crafted-tool source. Convention: an async
  // function expression like `async (x) => x * 2` or a full function
  // declaration. We normalize at store-time (see §6) so this splice
  // is always safe.
  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    '',
    `const fn = (${code});`,
    '',
    'export default class CraftedTool extends WorkerEntrypoint {',
    '  async invoke(argsJson) {',
    '    try {',
    '      const args = argsJson ? JSON.parse(argsJson) : [];',
    '      const arr = Array.isArray(args) ? args : [args];',
    '      const result = await fn(...arr);',
    '      return { result };',
    '    } catch (err) {',
    '      return { error: err?.message ?? String(err) };',
    '    }',
    '  }',
    '}',
  ].join('\n');
}
```

Rationale for each line:
- `import { WorkerEntrypoint }` — required so the child can expose RPC methods.
- `const fn = (${code})` — parens force expression context. Works for arrow
  functions and function-expression declarations. Does NOT work for
  `async function foo() {}` statement form — normalizer handles that.
- `invoke(argsJson)` — RPC entrypoint. Positional args: `[x, y, z]` JSON.
  Match convention with `ToolDispatcher.#positionalArgs` so codemode
  dispatches args correctly. (We ensure `positionalArgs: true` is set
  on the provider wrapping these tools if needed — see §4.)
- `globalOutbound: null` on the LOADER config — child Workers can't
  fetch() the public internet. Matches codemode's default.

### 3.4 CLI adapter — `packages/cli-backend/src/runtime.ts`

```ts
function createCraftedExecutor(): CraftedExecutor {
  return (tool) => {
    let fn: ((...args: unknown[]) => Promise<unknown>) | null = null;
    let lastHash = "";
    const currentHash = () => tool.code;  // Node-only; no subtle needed

    return async (...args: unknown[]) => {
      const h = currentHash();
      if (!fn || h !== lastHash) {
        fn = new Function("return " + tool.code)() as typeof fn;
        lastHash = h;
      }
      if (typeof fn !== "function") {
        throw new Error(`Crafted tool "${tool.name}" did not evaluate to a function.`);
      }
      return fn(...args);
    };
  };
}
```

Simple, stateless, eval is safe on Node.

## 4. Codemode provider shape

Crafted tools need to live under the default `codemode` namespace so the
LLM's `codemode.double(...)` calls resolve. That's already the behavior
when we pass them as `options.tools` (the unnamed provider). But we need
`positionalArgs: true` so the LLM convention of positional args matches
how Proteus stores crafted code (`async (x) => x * 2` expects positional).

Looking at codemode `index.js:127-131`:

```js
for (const provider of providers) { ... }
dispatchers[provider.name] = new ToolDispatcher(sanitizedFns, provider.positionalArgs);
```

`options.tools` becomes a provider without `positionalArgs`. Problem: the
stored crafted-code convention is positional.

**Fix**: instead of passing crafted tools as `options.tools` (unnamed,
non-positional), pass them as an explicit provider in `options.providers`
with `positionalArgs: true`:

```ts
tools.execute_tools = deps.createExecuteTool({
  tools: {},  // no legacy path
  providers: [
    ...(router?.getProviders() ?? []),   // workspace (positionalArgs), nimbus, etc.
    { name: "codemode", tools: craftedTools, positionalArgs: true },
  ],
  loader: deps.codemodeLoader,
});
```

Wait — codemode's `createExecuteTool` in `@cloudflare/think/tools/execute.js`
wraps `options.tools` as `{tools: options.tools}` and prepends it. That
wrapper has no `name`, defaulting to `codemode`. If we instead pass a named
provider with `name: "codemode"` in `options.providers`, we'd get a
duplicate-provider-name error.

Two clean options:

**(a)** Keep crafted in `options.tools`, use single-object-arg convention.
Change the stored crafted-code convention from positional `async (x) => x*2`
to single-object `async ({x}) => x*2`. Breaking for existing tools —
requires migration.

**(b)** Pass crafted tools as the `tools` param but via a wrapper that
forwards positional args. Specifically, adapt each crafted fn to accept
a single-object arg and unpack: `async ({0: a, 1: b, ...}) => fn(a, b, ...)`.
Non-breaking for stored code; a tiny wrapper in `createCraftedExecutor`.

**(c)** Omit `options.tools` entirely. Pass crafted tools as one
provider in `options.providers` with `name: "codemode"` and
`positionalArgs: true`. Then the default-wrapper crafted-tools param
isn't needed. `createExecuteTool` in `@cloudflare/think` prepends
`{tools: options.tools}` unconditionally (`ai.js:65`: `const providers = [{ tools }, ...options.providers ?? []]`) — so we must pass
`tools: {}` to make the default wrapper empty.

Codemode's duplicate-name check (`index.js:93-96`) triggers if TWO
providers share `name: "codemode"`. With `tools: {}`, the wrapper
provider has no fns — but still has the default `name: "codemode"`.
Duplicate. We'd get `Provider name "codemode" is reserved for default`
or `Duplicate provider name "codemode"`.

Verified in `@cloudflare/codemode/dist/index.js:84-97`:
```js
for (const provider of providers) {
  if (RESERVED_NAMES.has(provider.name)) return { error: `reserved` };
  if (!VALID_IDENT.test(provider.name)) return { error: `invalid` };
  if (seenNames.has(provider.name)) return { error: `duplicate` };
  seenNames.add(provider.name);
}
```

`RESERVED_NAMES = new Set(["__dispatchers", "__logs"])`. `"codemode"` is
NOT reserved — it's just the default-wrapper's default. So IF we also pass
`tools: {}`, we still get a `{tools: {}}` auto-wrapped provider with
`name: "codemode"`. Adding our own `{name: "codemode", ...}` to
`options.providers` is a duplicate.

**Decision (option b)** — wrapper at build time, simplest and non-breaking.

```ts
// In createCraftedExecutor for CF:
return async (argObj: unknown) => {
  // codemode calls non-positional by default — argObj is a single object
  // or a primitive. Our stored convention is positional. If argObj is an
  // array, spread it; else pass as a single arg.
  const args = Array.isArray(argObj) ? argObj : [argObj];
  const stub = loader.get(workerName, factory);
  const res = await stub.getEntrypoint().invoke(JSON.stringify(args));
  // ... as before
};
```

Actually re-reading: LLMs calling `codemode.double(21)` pass `21` — a primitive.
Codemode's `ToolDispatcher.call` (non-positional path) does
`JSON.parse(argsJson)` and passes to `fn(args)`. So our fn receives `21`.

For `codemode.add({a:1, b:2})`, fn receives `{a:1, b:2}`.

For `codemode.join(['a', 'b'])`, fn receives `['a', 'b']`.

The cleanest behavior: crafted code expects **exactly what the LLM passed**.
If the stored code is `async (x) => x * 2`, it gets `21` and returns `42`.
If stored code is `async ({a, b}) => a + b`, it gets `{a:1, b:2}` and
returns `3`. No argument mangling needed.

For a multi-positional call like the LLM-written `codemode.add(1, 2, 3)`,
codemode's non-positional dispatcher (`index.js:33`) calls
`fn(argsJson ? JSON.parse(argsJson) : {})` — it only passes the FIRST
argument. So the LLM can't pass positional args to a crafted tool via
`codemode.*` without using `positionalArgs: true` at the provider level.

This was a latent issue before the v2 refactor too. Practical impact:
crafted tools accept a single argument (object or primitive). If the LLM
needs to pass multiple, it puts them in an object. This matches the AI
SDK's standard tool-call convention.

**Final decision**: the wrapper in `createCraftedExecutor` simply passes
the one received arg through. No positional spreading. Match what
codemode delivers.

Revised factories:

```ts
// CF:
return async (arg: unknown) => {
  const stub = loader.get(workerName, factory);
  const res = await stub.getEntrypoint().invoke(JSON.stringify([arg]));
  if (res.error) throw new Error(res.error);
  return res.result;
};

// CLI:
return async (arg: unknown) => {
  if (!fn || codeChanged) fn = new Function("return " + tool.code)();
  return fn(arg);
};
```

And the Worker module's `invoke` unpacks the JSON array:

```js
async invoke(argsJson) {
  const args = argsJson ? JSON.parse(argsJson) : [];
  return { result: await fn(...args) };
}
```

So the host wraps `[arg]`, the Worker spreads with `...args`, `fn` is
called as `fn(arg)`. Clean.

## 5. Same-turn create-and-invoke

The existing code path handles "LLM calls `workspace.createTool('foo',
…)` then immediately wants `codemode.foo(…)` in the same execute_tools
call" via a Proxy that live-reads CraftStore on each `get`. That Proxy
was introduced in commit `e37b51d`.

With the new architecture, same-turn invocation works naturally:
- `workspace.createTool` writes to `crafted_tools`.
- Next call to `getTools()` (next turn) sees the new row and wires up
  `codemode.foo` via `createCraftedExecutor({name:'foo', code:...})`.

For **same-turn** access: the Proxy is no longer needed, because:
- The `tools` param to `createCodeTool` is fixed for the turn.
- `codemode.<name>` lookup happens inside the sandbox Worker. The Worker
  calls back to the host `ToolDispatcher.call(name, args)`. The dispatcher
  only knows about tools that were in `fns` when the Worker spawned —
  tools created mid-turn aren't visible.

**Decision**: keep `workspace.invokeCrafted(name, ...args)` as the
same-turn escape hatch. It reads CraftStore at call time and invokes
via the same `craftedExecutor(tool)` factory. Commit `6ba66fe` added
this. We keep it, but replace its `new Function()` internals with the
injected `craftedExecutor` too.

So `workspace.invokeCrafted` in `packages/core/src/execution/inline.ts`
gets a new dep:

```ts
export interface InlineExecutorDeps {
  vfs: VFS;
  memory: Memory;
  craftStore: CraftStore;
  shell: ShellExec;
  sql?: SqlExecutor;
  craftedExecutor?: CraftedExecutor;  // NEW — same factory as buildBuiltinTools uses
}
```

`invokeCrafted(name, ...args)`:

```ts
const tool = craftStore.get(String(name));
if (!tool) return { error: `Crafted tool "${name}" not found.` };
if (!deps.craftedExecutor) return { error: `No executor available.` };
const exec = deps.craftedExecutor(tool);
return exec(args[0] ?? undefined);  // pass first positional
```

Single place of codegen. Same platform-selection.

## 6. Code normalization at store time

Current `CraftStore.create` stores raw `code` (arrow function string).
LLMs sometimes produce:

1. `async (x) => x * 2`                 — arrow expression ✓
2. `async function(x) { return x*2 }`   — anonymous function expression ✓
3. `async function foo(x) {…}`          — function declaration ✗ (invalid in `const fn = (…)`)
4. `{ execute: async (x) => x*2 }`      — object with execute ✗
5. `export default async (x) => x*2`    — ESM ✗
6. statement sequences                   — ambiguous ✗

We normalize at store time (`workspace.createTool` in `inline.ts`) to
form (1) or (2), rejecting if normalization fails. This keeps the
splicing in `craftedToolWorkerModule` trivial and moves the error earlier
— the LLM learns immediately that the code was unusable.

Normalizer sketch (`packages/core/src/tools/normalize.ts`):

```ts
export function normalizeCraftedCode(code: string): { ok: true; code: string } | { ok: false; error: string } {
  const stripped = code.trim()
    .replace(/^export\s+default\s+/, '')
    .replace(/;\s*$/, '');

  // Already an arrow or function expression → wrap in parens and try.
  // Test via a harmless eval-in-Function attempt (Node-only helper;
  // we call this from the CLI or from a LOADER probe on CF).
  //
  // Actually: we can just syntax-check by AST parse. Use @babel/parser
  // OR use a minimal hand-written check: must START with:
  //   async ( / ( / function / async function /
  // and MUST NOT start with a declaration keyword.
  if (/^async\s*\(/.test(stripped) || /^\(/.test(stripped)) return { ok: true, code: stripped };
  if (/^async\s+function\s*\(/.test(stripped) || /^function\s*\(/.test(stripped)) return { ok: true, code: stripped };
  if (/^async\s+function\s+\w+\s*\(/.test(stripped)) {
    // Named function declaration → strip name → becomes anonymous.
    const replaced = stripped.replace(/^async\s+function\s+\w+/, 'async function');
    return { ok: true, code: replaced };
  }
  if (/^function\s+\w+\s*\(/.test(stripped)) {
    return { ok: true, code: stripped.replace(/^function\s+\w+/, 'function') };
  }
  return { ok: false, error: `Crafted tool code must be an arrow or function expression. Got: ${stripped.slice(0, 60)}…` };
}
```

No AST parser dep; regex cover 95%+ of what LLMs produce. The Worker
spawn on CF will fail loudly on pathological cases, which is fine
(becomes a tool-call error the LLM can observe).

## 7. Duplicate-row migration

`multiplyNumbers` + `multiplynumbers` coexist because pre-v2 code
lowercased names, current code preserves case. Same in `craft_scores`.

Migration runs in `OrchestratorAgent.onStart()` after `initAllTables`,
gated by a one-shot flag:

```ts
execRaw(`CREATE TABLE IF NOT EXISTS _v2_codegen_migration_done (id INTEGER PRIMARY KEY)`);
const done = this.sql<{c:number}>`SELECT COUNT(*) c FROM _v2_codegen_migration_done`[0]?.c ?? 0;
if (done === 0) {
  // 1. Merge crafted_tools case-collision groups: keep most-recently-updated row.
  const dupGroups = this.sql<{lower: string; names: string}>`
    SELECT LOWER(name) AS lower, GROUP_CONCAT(name) AS names
    FROM crafted_tools
    GROUP BY LOWER(name) HAVING COUNT(*) > 1`;

  for (const g of dupGroups) {
    const rows = this.sql<{name:string; updated_at:number}>`
      SELECT name, updated_at FROM crafted_tools
      WHERE LOWER(name) = ${g.lower} ORDER BY updated_at DESC`;
    const keep = rows[0]?.name;
    if (!keep) continue;
    for (const r of rows.slice(1)) {
      this.sql`DELETE FROM crafted_tools WHERE name = ${r.name}`;
    }

    // Merge craft_scores across the group into the kept name.
    const s = this.sql<{score:number; uses:number; last_used_at:number; created_at:number}>`
      SELECT MAX(score) as score, SUM(uses) as uses,
             MAX(last_used_at) as last_used_at, MIN(created_at) as created_at
      FROM craft_scores WHERE LOWER(tool_name) = ${g.lower}`[0];
    if (s) {
      this.sql`DELETE FROM craft_scores WHERE LOWER(tool_name) = ${g.lower}`;
      this.sql`INSERT INTO craft_scores (tool_name, score, uses, last_used_at, created_at)
        VALUES (${keep}, ${s.score}, ${s.uses}, ${s.last_used_at}, ${s.created_at})`;
    }
  }

  // 2. Normalize stored code to a form splice-able into the Worker module.
  const all = this.sql<{name:string; code:string}>`SELECT name, code FROM crafted_tools`;
  for (const t of all) {
    const norm = normalizeCraftedCode(t.code);
    if (norm.ok && norm.code !== t.code) {
      this.sql`UPDATE crafted_tools SET code = ${norm.code}, updated_at = ${Date.now()} WHERE name = ${t.name}`;
    }
  }

  this.sql`INSERT INTO _v2_codegen_migration_done (id) VALUES (1)`;
}
```

Idempotent under DO single-writer semantics. Safe to replay.

## 8. `workspace.createTool` hardening

Per user's architectural-decisions input: on case-collision, reject with
an actionable error.

```ts
// In inline.ts::createTool.execute:
const raw = String(name);
let toolName = raw.replace(/[^A-Za-z0-9_]/g, '_');
if (/^[0-9]/.test(toolName)) toolName = '_' + toolName;

// Case-collision check
const existing = craftStore.get(toolName);
const lowerHit = craftStore.list().find(t =>
  t.name !== toolName && t.name.toLowerCase() === toolName.toLowerCase()
);
if (lowerHit) {
  return {
    ok: false,
    error: `A tool named "${lowerHit.name}" already exists (case-insensitive match). ` +
           `Either use "${lowerHit.name}" or pick a genuinely different name.`,
  };
}

// Normalize before writing
const norm = normalizeCraftedCode(String(code));
if (!norm.ok) return { ok: false, error: norm.error };

if (existing) {
  craftStore.update(toolName, { description: String(description), code: norm.code });
  return { ok: true, name: toolName, action: 'updated' };
}
craftStore.create({ name: toolName, description: String(description),
  code: norm.code, scope: 'local', params: null });
return { ok: true, name: toolName, action: 'created' };
```

## 9. Scaffold validators

`packages/core/src/scaffold/modify.ts:50` currently passes a
`new Function(...)` string through `rt.executor.execute` (which itself
uses `new Function` on CF — broken).

**New probe path**:

```ts
// In modifyScaffold:
if (deps.scaffoldProbe) {
  const probe = await deps.scaffoldProbe(code);
  if (!probe.ok) return { ok: false, stage: 2, error: `Parse error: ${probe.error}` };
}
```

`deps.scaffoldProbe`:
- CF: uses LOADER to spawn a throwaway Worker with the code as module
  source, calls `invoke('[]')`, evicts. `SyntaxError` / module-eval errors
  surface. ~30 LOC.
- CLI: `try { new Function(code); return { ok: true }; } catch (e) { ... }`.

Probe wiring goes through the runtime adapter just like `craftedExecutor`.

`packages/core/src/identity/{create,open}.ts:createBunExecutor` —
Node-only, keeps `new Function`. Layering violation deferred (per user
decision).

## 10. Cache & eviction

- **Child-Worker cache**: handled entirely by `env.LOADER.get(name, factory)`
  caching by `name`. We embed the code hash in the name so updates
  produce a NEW Worker automatically. The old-hashed Worker is GC'd by
  the loader without explicit action.
- **Proxy/closure cache**: `createCraftedExecutor(tool)` returns a fresh
  closure each call. That's fine — the closure just captures `tool.name`
  and `tool.code`; the expensive bit (Worker spawn) only runs inside
  the `execute` when LOADER.get is first called for that name+hash.
- **`_cachedTools` in the orchestrator**: existing per-turn cache keyed
  on `COUNT(*):MAX(updated_at):MAX(last_used_at)` still works. When a
  tool's code changes, `updated_at` bumps, the key differs, the ToolSet
  rebuilds, and `buildBuiltinTools` produces new `execute` closures
  with new hash-suffixed names. Old Workers GC.

## 11. Test plan

### 11.1 Unit (`packages/core/tests/`)

- `unit-crafted-normalizer.test.ts` — 6 LLM-produced code shapes
  normalize correctly, invalid ones reject.
- `unit-tools.test.ts` extension — mock `craftedExecutor` returning
  `async (arg) => arg * 2`, verify:
  - tools map contains entry under the tool's name
  - entry's `execute(21)` returns `42`
  - tool missing from CraftStore → no entry
  - low score tool filtered out

### 11.2 Integration (`packages/core/tests/`)

- `integration-createTool-collision.test.ts` — create `foo`, then try
  to create `Foo`; expect rejection with actionable error.

### 11.3 Migration

- `unit-codegen-migration.test.ts` — seed `crafted_tools` with
  `multiplyNumbers` + `multiplynumbers` + scores for both; run
  migration; assert only the most-recent survives with summed scores.

### 11.4 Static gate (`scripts/e2e-test.sh`)

Add after existing "5-tool architecture" check:

```sh
# New-Function ban in CF-reachable source
BANNED=$(grep -n 'new Function(' \
  packages/core/src/tools/builtins.ts \
  packages/core/src/tools/crafted.ts \
  packages/core/src/execution/inline.ts \
  packages/core/src/scaffold/modify.ts \
  packages/cf-backend/src/runtime.ts \
  packages/cf-backend/src/orchestrator.ts \
  2>/dev/null || true)
if [ -z "$BANNED" ]; then
  RESULTS+=("${GREEN}✅ PASS${NC}: No new Function() in CF-reachable source")
else
  RESULTS+=("${RED}❌ FAIL${NC}: new Function() found: $BANNED")
fi
```

### 11.5 Live WebSocket E2E (`scripts/ws-test-harness.ts`)

Add a new test case:

```ts
await sendMessage(ws, 'Create a tool called "double" that takes a number and returns 2× it. Then test it by calling codemode.double(21) and tell me the result.');

const frames = await collectFramesUntil(ws, 'done', 120_000);

// Fail if ANY frame contains the codegen-disallowed error
for (const f of frames) {
  assert(!JSON.stringify(f).includes('Code generation from strings disallowed'),
    'Codegen error found in frame: ' + JSON.stringify(f));
}

// Eventually the assistant says 42
const finalText = frames
  .filter(f => f.type === 'text-delta' || f.type === 'assistant')
  .map(f => f.delta ?? f.text ?? '').join('');
assert(finalText.includes('42'), 'Expected 42 in final text');

// getToolList shows exactly one crafted entry
const tools = await agent.call('getToolList', []);
assert(tools.crafted.filter(t => t.name.toLowerCase() === 'double').length === 1);
```

Run against `wrangler dev` locally; promotion gate before any deploy.

## 12. Migration sequence

1. **Core**: add `CraftedExecutor` type + `BuiltinToolDeps.craftedExecutor?`
   and wire into `buildBuiltinTools`. Add `normalizeCraftedCode`.
2. **Core**: add `InlineExecutorDeps.craftedExecutor?` and use it in
   `workspace.invokeCrafted`. Add case-collision check + normalization
   in `workspace.createTool`.
3. **Core**: add `BuiltinToolDeps.scaffoldProbe?` wiring in
   `scaffold/modify.ts`.
4. **Core**: delete `loadFilteredCraftedTools` `'inline-function'` branch
   (replaced with inline call-site logic that uses `deps.craftedExecutor`).
   Delete the live-lookup Proxy in `builtins.ts:180-208`. Delete the
   `execute_tools` fallback path (or move to CLI if still needed for
   test runtimes).
5. **CF adapter**: implement `createCraftedExecutor(env.LOADER)` and
   `createScaffoldProbe(env.LOADER)` in `cf-backend/src/runtime.ts`.
   Attach both to the `BuiltinToolDeps` passed into `buildBuiltinTools`.
6. **CF adapter**: delete `createExecutor()` at `runtime.ts:207-219`
   (the `new Function` fallback). Wire `rt.executor` to a real
   `DynamicWorkerExecutor` from `@cloudflare/codemode` or a thin
   adapter over `createCraftedExecutor`.
7. **CLI adapter**: implement `createCraftedExecutor()` (Node-eval) in
   `cli-backend/src/runtime.ts`. Scaffold probe uses
   `new Function(code); return { ok: true }`.
8. **Migration**: add duplicate-merge + code-normalize in
   `OrchestratorAgent.onStart()`, flagged by `_v2_codegen_migration_done`.
9. **Tests**: unit, integration, migration, static gate, WS E2E.
10. **Doc**: update `docs/TOOLS.md` §5 / §6 to describe the Worker-Loader
    path for crafted tools. Keep `codemode.*` as the advertised namespace.

Commits: one per phase. Each lands CI-green (additive-first, then swap).

## 13. Why this is simpler than the rejected loader design

| Dimension | Loader-class design (rejected) | Factory-injection (this doc) |
|---|---|---|
| New types in core | `CraftedToolLoader` interface, `CraftedToolHandle` type, `load/evict/clear` lifecycle | `CraftedExecutor` type alias (one line) |
| New classes | `WorkerLoaderCraftedLoader`, `NodeEvalCraftedLoader` with internal Map caches | Zero classes — two factory functions |
| Cache plumbing | Two layers: loader instance Map + LOADER internal | One layer: LOADER only (hash-suffixed names) |
| Live-lookup Proxy in `builtins.ts` | Kept, rewritten around loader | Deleted |
| Same-turn create-and-use | Via live-lookup Proxy | Via `workspace.invokeCrafted` (already works) |
| `loadFilteredCraftedTools` dual-mode | Kept (one more mode) | Deleted — direct inline call |
| Total new LOC | ~300 | ~120 |
| New abstractions to explain in docs | Three (Loader, Handle, lifecycle) | One (executor factory) |

## 14. Accepted risks

- LOADER name collision across agents sharing the same Worker script:
  LOADER keys are global within the Worker script. We namespace by
  agent DO id: `crafted-${agentId}-${toolName}-${hash}`. Low risk.
- Child-Worker cold start on first call per (tool, hash): measured
  elsewhere as 50-200ms. Happens once per new tool. Acceptable.
- Stored-code convention: single-argument invocation (`fn(arg)`). Most
  LLM-written tools already follow this. Multi-arg tools use an object.
- `globalOutbound: null`: crafted tools can't fetch() the internet
  without opt-in. If we add that opt-in later, it's a column on
  `crafted_tools`.

## 15. Non-goals

- Moving `createBunExecutor` / `createBunValidator` out of core
  (flagged as layering debt; deferred per user decision).
- Changing the codemode peer dep.
- Introducing QuickJS/WASM for CLI isolation.
- Runtime opt-out of child-Worker isolation on CF.
