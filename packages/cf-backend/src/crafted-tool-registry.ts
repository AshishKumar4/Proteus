/**
 * CraftedToolRegistry — live, mid-turn-mutable crafted-tool surface.
 *
 * The bug this solves: `@cloudflare/codemode`'s `createCodeTool` freezes
 * `provider.fns` at construction via `extractFns(filterTools(provider.tools))`.
 * Crafted tools created MID-TURN via `workspace.createTool` are invisible to
 * subsequent `execute_tools` calls in the same turn — repro confirmed:
 *
 *     [0] workspace.createTool("double", ..., "(n) => n*2") → ok:true
 *     [1] codemode.double(7)                                → empty result
 *
 * Fix: two cooperating pieces.
 *
 * 1. CraftedToolRegistry holds the live `{name → execute closure}` map.
 *    `workspace.createTool` mutates it synchronously via `addOrRefresh()`.
 *    Each execute closure dispatches to a per-tool child Worker spawned
 *    via `env.LOADER.get()` — no host-side `new Function()` (preserves
 *    the v2.1 codegen fix).
 *
 * 2. LiveCraftedExecutor wraps DynamicWorkerExecutor and ignores the
 *    `providers` argument codemode hands us (frozen at construction).
 *    It rebuilds the dispatcher's `fns` map from the registry's current
 *    state at each execute call — so mid-turn additions ARE picked up.
 *
 * Same approach that `@seals/agent-utils` uses for MCP tools discovered
 * after worker startup (see codemode/builder.ts::LiveToolExecutor).
 */

import type { CraftedToolExecuteFn } from '@proteus/core';

/** Minimal shape of a crafted-tool row (name, description, code). */
export interface CraftedToolSnapshot {
  name: string;
  description: string;
  code: string;
}

/** RPC surface of the spawned crafted-tool Worker. */
interface CraftedToolEntrypoint {
  invoke(argsJson: string): Promise<{ result?: unknown; error?: string }>;
}

/** Minimal WorkerLoader shape. */
interface WorkerLoaderLike {
  get(
    name: string,
    factory: () => {
      compatibilityDate: string;
      compatibilityFlags?: string[];
      mainModule: string;
      modules: Record<string, string>;
      globalOutbound?: unknown;
    },
  ): { getEntrypoint(): unknown };
}

interface CachedStub {
  codeHash: string;
  entrypoint: CraftedToolEntrypoint;
}

/**
 * Build the child Worker's main module source. The crafted code is spliced
 * as an expression into `const fn = (...)`; `invoke` JSON-parses its
 * positional-args array and spreads into `fn(...args)`.
 */
export function craftedToolWorkerModule(code: string): string {
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
    '      return { error: err && err.message ? err.message : String(err) };',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

async function codeHashHex(code: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    const buf = new TextEncoder().encode(code);
    const digest = await subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(digest);
    let out = '';
    for (let i = 0; i < 5; i++) out += bytes[i]!.toString(16).padStart(2, '0');
    return out;
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function sanitizeLoaderName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64) || 'tool';
}

/**
 * Live registry. One instance per OrchestratorAgent DO lifetime.
 */
export class CraftedToolRegistry {
  /** MUTABLE — read by LiveCraftedExecutor at every execute call. */
  readonly fns: Record<string, CraftedToolExecuteFn> = Object.create(null);
  readonly descriptions: Record<string, string> = Object.create(null);

  readonly #loader: WorkerLoaderLike;
  readonly #agentTag: string;
  readonly #snapshots = new Map<string, CraftedToolSnapshot>();
  readonly #stubs = new Map<string, CachedStub>();

  constructor(loader: WorkerLoaderLike, agentIdForNamespace: string) {
    this.#loader = loader;
    this.#agentTag = sanitizeLoaderName(agentIdForNamespace).slice(0, 16);
  }

  /**
   * Register or refresh a crafted tool. Idempotent. Returns true if the
   * registry's exposed surface (fns or descriptions) actually changed.
   */
  addOrRefresh(tool: CraftedToolSnapshot): boolean {
    if (!tool.code || tool.code.startsWith('//')) return false;
    const prevSnap = this.#snapshots.get(tool.name);
    this.#snapshots.set(tool.name, tool);
    const prevDesc = this.descriptions[tool.name];
    const newDesc = tool.description || `Crafted tool: ${tool.name}`;
    this.descriptions[tool.name] = newDesc;
    if (!this.fns[tool.name]) {
      this.fns[tool.name] = this.#buildExecute(tool.name);
      return true;
    }
    return prevSnap?.code !== tool.code || prevDesc !== newDesc;
  }

  /** Remove a tool (retire/consolidation). */
  remove(name: string): void {
    delete this.fns[name];
    delete this.descriptions[name];
    this.#snapshots.delete(name);
    this.#stubs.delete(name);
  }

  /**
   * Bulk-sync from a CraftStore list. Removes entries not in `tools`
   * unless `keepExtras` is true.
   */
  bulkLoad(tools: ReadonlyArray<CraftedToolSnapshot>, keepExtras = false): void {
    if (!keepExtras) {
      const present = new Set(tools.map(t => t.name));
      for (const name of Object.keys(this.fns)) {
        if (!present.has(name)) this.remove(name);
      }
    }
    for (const t of tools) this.addOrRefresh(t);
  }

  /**
   * Snapshot for codemode's `options.tools` at construction. Each entry's
   * `execute` is the SAME closure stored in `this.fns` — identity stable.
   * Mid-turn additions still need LiveCraftedExecutor because codemode
   * freezes this snapshot.
   */
  toolSet(): Record<string, { description: string; execute: CraftedToolExecuteFn }> {
    const out: Record<string, { description: string; execute: CraftedToolExecuteFn }> = {};
    for (const name of Object.keys(this.fns)) {
      out[name] = {
        description: this.descriptions[name] ?? `Crafted tool: ${name}`,
        execute: this.fns[name]!,
      };
    }
    return out;
  }

  /** Current tool-name list. */
  names(): string[] {
    return Object.keys(this.fns);
  }

  /**
   * Execute closure factory. Reads the CURRENT snapshot at call time, hashes
   * the code, and routes to the matching child Worker. Closure identity is
   * stable across code updates.
   */
  #buildExecute(name: string): CraftedToolExecuteFn {
    return async (arg: unknown) => {
      const snap = this.#snapshots.get(name);
      if (!snap) throw new Error(`Crafted tool "${name}" no longer registered`);
      const hash = await codeHashHex(snap.code);
      let cached = this.#stubs.get(name);
      if (!cached || cached.codeHash !== hash) {
        const safeName = sanitizeLoaderName(name);
        const loaderKey = `crafted-${this.#agentTag}-${safeName}-${hash}`;
        const moduleSrc = craftedToolWorkerModule(snap.code);
        const stub = this.#loader.get(loaderKey, () => ({
          compatibilityDate: '2025-06-01',
          compatibilityFlags: ['nodejs_compat'],
          mainModule: 'tool.js',
          modules: { 'tool.js': moduleSrc },
          globalOutbound: null,
        }));
        cached = { codeHash: hash, entrypoint: stub.getEntrypoint() as CraftedToolEntrypoint };
        this.#stubs.set(name, cached);
      }
      const argsArray = arg === undefined ? [] : [arg];
      const res = await cached.entrypoint.invoke(JSON.stringify(argsArray));
      if (res.error) throw new Error(res.error);
      return res.result;
    };
  }
}

/**
 * Types aliased from @cloudflare/codemode for the minimal interface we need.
 * We re-implement execute() in order to bypass codemode's sanitize pass on
 * dispatcher keys — reserved JS words like "double" get rewritten to
 * "double_" before dispatch, causing `codemode.double(...)` from the LLM
 * to miss the dispatcher lookup (found empirically on the user's repro).
 */
interface WorkerStubLike {
  getEntrypoint(): {
    evaluate(
      dispatchers: Record<string, unknown>,
    ): Promise<{ result?: unknown; error?: string; logs?: string[] }>;
  };
}
interface WorkerLoaderExecutorLike {
  get(
    name: string,
    factory: () => {
      compatibilityDate: string;
      compatibilityFlags?: string[];
      mainModule: string;
      modules: Record<string, string>;
      globalOutbound?: unknown;
    },
  ): WorkerStubLike;
}

/**
 * codemode.RpcTarget — the class we extend for ToolDispatcher. We create
 * the class dynamically at construction so we don't import cloudflare:workers
 * at module parse time (avoids dev-mode import issues).
 */
type RpcTargetCtor = new () => object;

/**
 * Live crafted-tool executor — same surface as DynamicWorkerExecutor but
 * bypasses the sanitize-on-key step that mangles reserved-word tool names.
 *
 * Flow per execute():
 *  1. Rebuild the codemode provider's fns from the registry's CURRENT state
 *     (captures mid-turn additions).
 *  2. Build a ToolDispatcher (via codemode's RpcTarget class) whose internal
 *     fns map uses the ORIGINAL (unsanitized) tool name as key — so
 *     `codemode.double(7)` from the sandbox lands on `fns["double"]`.
 *  3. Spawn the child Worker (via WorkerLoader) with codemode-compatible
 *     sandbox code.
 *  4. Return the result — no sanitize rewriting of dispatch results.
 *
 * Non-codemode providers (workspace, nimbus, etc.) are passed through
 * untouched: their keys are already valid identifiers by convention.
 */
export class LiveCraftedExecutor {
  #loader: WorkerLoaderExecutorLike;
  #registry: CraftedToolRegistry;
  #timeoutMs: number;
  #rpcTargetCtor: RpcTargetCtor | null = null;

  constructor(
    loader: WorkerLoaderExecutorLike,
    registry: CraftedToolRegistry,
    opts: { timeoutMs?: number; rpcTargetCtor?: RpcTargetCtor } = {},
  ) {
    this.#loader = loader;
    this.#registry = registry;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#rpcTargetCtor = opts.rpcTargetCtor ?? null;
  }

  /** Lazy RpcTarget import — `cloudflare:workers` is only available at runtime. */
  async #getRpcTargetCtor(): Promise<RpcTargetCtor> {
    if (this.#rpcTargetCtor) return this.#rpcTargetCtor;
    const mod = await import('cloudflare:workers');
    this.#rpcTargetCtor = (mod as unknown as { RpcTarget: RpcTargetCtor }).RpcTarget;
    return this.#rpcTargetCtor;
  }

  async execute(
    code: string,
    providers:
      | Array<{ name: string; fns: Record<string, unknown>; positionalArgs?: boolean }>
      | Record<string, (...args: unknown[]) => Promise<unknown>>,
  ): Promise<{ result: unknown; error?: string; logs?: string[] }> {
    const providerArr = Array.isArray(providers) ? providers : [];
    const rebuilt: Array<{ name: string; fns: Record<string, unknown>; positionalArgs: boolean }> = [];
    let sawCodemode = false;
    for (const p of providerArr) {
      if (p.name === 'codemode') {
        sawCodemode = true;
        rebuilt.push({
          name: 'codemode',
          fns: { ...this.#registry.fns } as Record<string, unknown>,
          positionalArgs: p.positionalArgs ?? false,
        });
      } else {
        rebuilt.push({ name: p.name, fns: p.fns, positionalArgs: p.positionalArgs ?? false });
      }
    }
    if (!sawCodemode) {
      rebuilt.unshift({
        name: 'codemode',
        fns: { ...this.#registry.fns } as Record<string, unknown>,
        positionalArgs: false,
      });
    }

    try {
      const RpcTarget = await this.#getRpcTargetCtor();
      const dispatchers: Record<string, object> = {};
      for (const p of rebuilt) {
        // KEY CHANGE vs codemode's DWE: no sanitize pass. Original names
        // are the dispatcher keys.
        const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
        for (const [name, fn] of Object.entries(p.fns)) {
          fns[name] = fn as (...args: unknown[]) => Promise<unknown>;
        }
        dispatchers[p.name] = new (class extends (RpcTarget as unknown as { new(): object }) {
          async call(name: string, argsJson: string): Promise<string> {
            const fn = fns[name];
            if (!fn) return JSON.stringify({ error: `Tool "${name}" not found` });
            try {
              if (p.positionalArgs) {
                const parsed = argsJson ? JSON.parse(argsJson) : [];
                const arr = Array.isArray(parsed) ? parsed : [parsed];
                const result = await fn(...arr);
                return JSON.stringify({ result });
              }
              const parsed = argsJson ? JSON.parse(argsJson) : {};
              const result = await fn(parsed);
              return JSON.stringify({ result });
            } catch (err) {
              return JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        })();
      }

      const executorModule = [
        'import { WorkerEntrypoint } from "cloudflare:workers";',
        '',
        'export default class CodeExecutor extends WorkerEntrypoint {',
        '  async evaluate(__dispatchers = {}) {',
        '    const __logs = [];',
        '    console.log = (...a) => { __logs.push(a.map(String).join(" ")); };',
        '    console.warn = (...a) => { __logs.push("[warn] " + a.map(String).join(" ")); };',
        '    console.error = (...a) => { __logs.push("[error] " + a.map(String).join(" ")); };',
        ...rebuilt.map(p => {
          if (p.positionalArgs) {
            return `    const ${p.name} = new Proxy({}, {\n      get: (_, toolName) => async (...args) => {\n        const resJson = await __dispatchers.${p.name}.call(String(toolName), JSON.stringify(args));\n        const data = JSON.parse(resJson);\n        if (data.error) throw new Error(data.error);\n        return data.result;\n      }\n    });`;
          }
          return `    const ${p.name} = new Proxy({}, {\n      get: (_, toolName) => async (args) => {\n        const resJson = await __dispatchers.${p.name}.call(String(toolName), JSON.stringify(args ?? {}));\n        const data = JSON.parse(resJson);\n        if (data.error) throw new Error(data.error);\n        return data.result;\n      }\n    });`;
        }),
        '',
        '    try {',
        '      const result = await Promise.race([',
        `        (${code})(),`,
        `        new Promise((_, reject) => setTimeout(() => reject(new Error("Execution timed out")), ${this.#timeoutMs}))`,
        '      ]);',
        '      return { result, logs: __logs };',
        '    } catch (err) {',
        '      return { result: undefined, error: err.message, logs: __logs };',
        '    }',
        '  }',
        '}',
      ].join('\n');

      const workerName = `proteus-live-codemode-${crypto.randomUUID()}`;
      const stub = this.#loader.get(workerName, () => ({
        compatibilityDate: '2025-06-01',
        compatibilityFlags: ['nodejs_compat'],
        mainModule: 'executor.js',
        modules: { 'executor.js': executorModule },
        globalOutbound: null,
      }));
      const response = await (stub.getEntrypoint() as unknown as {
        evaluate(d: Record<string, unknown>): Promise<{ result?: unknown; error?: string; logs?: string[] }>;
      }).evaluate(dispatchers);

      return response.error
        ? { result: undefined, error: response.error, logs: response.logs }
        : { result: response.result, logs: response.logs };
    } catch (err) {
      return { result: undefined, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
