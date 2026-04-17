/**
 * CF crafted-tool executor — spawns one child Worker per crafted tool via
 * env.LOADER.get(name, factory). Modules are compiled by workerd, which
 * sidesteps V8's codegen ban ("Code generation from strings disallowed for
 * this context") that breaks host-side new Function() in Durable Objects.
 *
 * The Worker exposes a single RPC method `invoke(argsJson)`:
 *
 *   invoke("[21]") → { result: 42 }      (success)
 *   invoke("[21]") → { error: "..." }    (throw → structured error)
 *
 * The host passes a JSON-encoded positional-args array so crafted code that
 * uses `fn(x)` and `fn(a, b)` both work without spread-serialization tricks
 * at call time.
 *
 * Caching: env.LOADER.get(name, factory) caches the service binding by
 * `name`. We embed the first 10 hex chars of sha256(code) into the name, so
 * an update to the stored code produces a new name → a new Worker (the
 * previous one GCs naturally). We ALSO cache the WorkerStub in a Map keyed
 * by (toolName, codeHash) to avoid re-invoking the LOADER closure on the
 * hot path; the LOADER call is idempotent but saving one indirection per
 * invocation is worthwhile for this code path.
 *
 * Isolation: globalOutbound: null blocks the child from reaching the public
 * internet. If a tool needs network, that's an explicit follow-up (a column
 * on crafted_tools). Default-deny is the right posture.
 */

import type { CraftedToolExecute, CraftedToolExecuteFn } from '@proteus/core';

/** Shape returned by the child Worker's invoke() RPC. */
interface InvokeResult {
  result?: unknown;
  error?: string;
}

/** RPC surface of the spawned crafted-tool Worker. */
interface CraftedToolEntrypoint {
  invoke(argsJson: string): Promise<InvokeResult>;
}

/** Cached stub keyed by (toolName, codeHash). */
interface CachedStub {
  codeHash: string;
  entrypoint: CraftedToolEntrypoint;
}

/**
 * Build the child Worker's main module source. The compiled `fn` is an
 * expression spliced into a `const fn = (...)` binding, so the store-time
 * normalizer must guarantee `tool.code` parses as an expression (arrow fn,
 * function expression, or parenthesized form). `invoke` JSON-parses its
 * args, spreads as positional, awaits the result.
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

/**
 * Stable short hash of a string, for use in LOADER names.
 * SubtleCrypto is available in Workers; falls back to a simple FNV-1a
 * if subtle is unavailable (never happens on CF, but keeps the type tests
 * from breaking on unusual runtimes).
 */
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
  // FNV-1a fallback
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Sanitize a tool name into a valid Worker loader identifier.
 * Worker names are strings, but we use only safe identifier chars to keep
 * the name URL-compatible if the runtime ever exposes it.
 */
function sanitizeLoaderName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64) || 'tool';
}

/** Minimal WorkerLoader shape we rely on (typed loosely so core stays pure). */
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

/**
 * Build the CF crafted-tool executor factory. Agent DO id is embedded in
 * the loader name so agents sharing the same Worker script don't collide
 * on identical tool names.
 */
export function createCFCraftedExecute(
  loader: WorkerLoaderLike,
  agentIdForNamespace: string,
): CraftedToolExecute {
  const agentTag = sanitizeLoaderName(agentIdForNamespace).slice(0, 16);
  const stubs = new Map<string, CachedStub>();

  return (tool) => {
    // Closure over the stored tool snapshot. If the code changes the caller
    // rebuilds buildBuiltinTools (tool cache is invalidated by updated_at
    // and last_used_at — see orchestrator._craftCacheKey), so a new closure
    // is produced with the new code. The per-instance Map prevents cross-
    // turn churn within the DO lifetime.
    const safeName = sanitizeLoaderName(tool.name);

    const execute: CraftedToolExecuteFn = async (arg) => {
      const hash = await codeHashHex(tool.code);
      const loaderKey = `crafted-${agentTag}-${safeName}-${hash}`;

      let cached = stubs.get(tool.name);
      if (!cached || cached.codeHash !== hash) {
        const moduleSrc = craftedToolWorkerModule(tool.code);
        const stub = loader.get(loaderKey, () => ({
          compatibilityDate: '2025-06-01',
          compatibilityFlags: ['nodejs_compat'],
          mainModule: 'tool.js',
          modules: { 'tool.js': moduleSrc },
          globalOutbound: null,
        }));
        const entrypoint = stub.getEntrypoint() as CraftedToolEntrypoint;
        cached = { codeHash: hash, entrypoint };
        stubs.set(tool.name, cached);
      }

      const argsArray = arg === undefined ? [] : [arg];
      const res = await cached.entrypoint.invoke(JSON.stringify(argsArray));
      if (res.error) throw new Error(res.error);
      return res.result;
    };

    return execute;
  };
}
