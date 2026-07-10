/**
 * CompositeVFS — the workspace file plane.
 *
 * One VFS (the same 7 methods as `Storage.vfs`, primitives.ts) over a mount
 * table of environments:
 *
 *   /local    SqliteFS (durable base)     — always mounted, never unmounts
 *   /sandbox  container root              — dynamic (when configured)
 *   /nimbus   Nimbus sandbox root         — dynamic (when provisioned)
 *   /pc       user's device root          — dynamic (when connected + consented)
 *
 * Each mount's file view is a VFS adapter over the executor's RAW handle
 * (never its LLM tools — those return error strings). A mount's root maps to
 * the environment's REAL root (`policy.rootPath`), so absolute environment
 * paths stay reachable — a faithful window, not a lossy rewrite.
 *
 * Addressing: relative paths resolve against the composite `cwd` (default
 * /local); absolute non-mount paths compat-route to /local so pre-composite
 * callers (`writeFile('scaffold/agent.js')`, `writeFile('/src/main.ts')`)
 * keep working byte-identically.
 *
 * Resolution does its OWN dot-segment cleaning that PRESERVES the leading
 * slash and the mount prefix — agent-utils' normalizePath strips the leading
 * slash and must never see a prefixed composite path.
 */

import type { VFS } from '../types/primitives.js';

export type MountConsistency = 'durable' | 'ephemeral' | 'live-shared';

/** Declared, inspectable per-mount semantics (not tribal knowledge). */
export interface MountPolicy {
  readOnly: boolean;
  /**
   * Environment-native path the mount root maps onto. '/' exposes the
   * environment's real root; '' is the SqliteFS root (relative addressing).
   */
  rootPath: string;
  /** durable (survives everything) / ephemeral (dies with the container) /
   *  live-shared (the user's own machine — shared with them, live). */
  consistency: MountConsistency;
  /** Environment credentials are held by the host and never enter the mount. */
  credentialsStayInHost: boolean;
}

export interface MountSpec {
  /** VFS over the environment's raw handle. Receives environment-NATIVE paths. */
  vfs: VFS;
  policy: MountPolicy;
  /** Evaluated per access — dynamic environments appear/disappear without
   *  remounting. Default: always live. */
  live?: () => boolean;
  /** Environment-native working directory (e.g. '/workspace') — the ergonomic
   *  default cwd for actors entering this mount, and UI metadata. */
  workingDir?: string;
}

/** One row of the mount-table data surface (file-manager UI, cross-env copy). */
export interface MountInfo {
  name: string;
  /** Composite prefix, e.g. '/sandbox'. */
  prefix: string;
  live: boolean;
  policy: MountPolicy;
  /** Composite-addressed working dir (e.g. '/sandbox/workspace'); null for
   *  reserved-but-unavailable rows. */
  cwd: string | null;
  /** Why the name is reserved but not mounted; null for real mounts. */
  reason: string | null;
}

export interface VfsError extends Error {
  code: string;
  errno: number;
  path: string;
}

const ERRNO: Record<string, number> = {
  ENOENT: -2, EACCES: -13, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, EROFS: -30, ENXIO: -6,
};

/** Errno-style error shared by the composite and its mount adapters. */
export function makeVfsError(code: string, message: string, path: string): VfsError {
  const err = new Error(`${code}: ${message}`) as VfsError;
  err.code = code;
  err.errno = ERRNO[code] ?? -1;
  err.path = path;
  return err;
}

/**
 * Clean '.'/'..'/'//' segments of an absolute composite path, PRESERVING the
 * leading slash. '..' above root clamps at root (chroot semantics).
 */
export function cleanAbsolutePath(abs: string): string {
  const out: string[] = [];
  for (const seg of abs.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

type MountRow =
  | { kind: 'mount'; vfs: VFS; policy: MountPolicy; live: () => boolean; workingDir: string }
  | { kind: 'reserved'; policy: MountPolicy; reason: string };

export type ResolvedPath =
  /** The synthetic '/' itself. */
  | { kind: 'root' }
  /** A single top-level segment at '/' that is not a mount name. */
  | { kind: 'rootEntry'; name: string }
  /** A reserved/registered mount that is not currently available. */
  | { kind: 'unavailable'; name: string; reason: string }
  /** A path inside a mount; `sub` is the environment-native path. */
  | { kind: 'mount'; name: string; vfs: VFS; policy: MountPolicy; sub: string };

const NAME_RE = /^[a-z][a-z0-9_-]*$/;

export class CompositeVFS implements VFS {
  /** The actor's working directory — composite-addressed, default '/local'. */
  readonly cwd: string;
  private readonly rows = new Map<string, MountRow>();

  constructor(opts: { local: VFS; cwd?: string }) {
    this.rows.set('local', {
      kind: 'mount',
      vfs: opts.local,
      policy: { readOnly: false, rootPath: '', consistency: 'durable', credentialsStayInHost: false },
      live: () => true,
      workingDir: '',
    });
    this.cwd = opts.cwd ?? '/local';
  }

  /** Attach (or replace a reservation for) a dynamic mount. */
  mount(name: string, spec: MountSpec): void {
    this.assertMountName(name);
    this.rows.set(name, {
      kind: 'mount',
      vfs: spec.vfs,
      policy: spec.policy,
      live: spec.live ?? (() => true),
      workingDir: spec.workingDir ?? spec.policy.rootPath,
    });
  }

  /**
   * Reserve a mount name that exists as a concept on this backend but is not
   * available (e.g. sandbox binding missing). Reserved names never
   * compat-route to /local — access yields a clear unavailability error, so a
   * later-configured environment can't be shadowed by silently-created local
   * files under the same prefix.
   */
  reserve(name: string, reason: string, policy: MountPolicy): void {
    this.assertMountName(name);
    if (this.rows.get(name)?.kind === 'mount') {
      throw new Error(`'${name}' is already mounted`);
    }
    this.rows.set(name, { kind: 'reserved', policy, reason });
  }

  unmount(name: string): void {
    if (name === 'local') throw new Error("'/local' is the writable base and never unmounts");
    this.rows.delete(name);
  }

  /** The mount-table data surface: every registered row with live state. */
  listMounts(): MountInfo[] {
    return [...this.rows.entries()].map(([name, row]) => ({
      name,
      prefix: `/${name}`,
      live: row.kind === 'mount' && row.live(),
      policy: row.policy,
      cwd: row.kind === 'mount' ? `/${name}${row.workingDir === '/' ? '' : row.workingDir}` : null,
      reason: row.kind === 'reserved' ? row.reason : null,
    }));
  }

  /**
   * The resolve algorithm. Mount names are reserved top-level identifiers,
   * matched on segment boundaries ('/sandboxes/x' does NOT hit '/sandbox');
   * everything else compat-routes to /local.
   */
  resolve(path: string): ResolvedPath {
    const abs = cleanAbsolutePath(path.startsWith('/') ? path : `${this.cwd}/${path}`);
    const local = this.rows.get('local') as Extract<MountRow, { kind: 'mount' }>;
    const slash = abs.indexOf('/', 1);
    const seg0 = slash === -1 ? abs.slice(1) : abs.slice(1, slash);
    const rest = slash === -1 ? '' : abs.slice(slash);
    const row = seg0 ? this.rows.get(seg0) : undefined;
    if (row) {
      if (row.kind === 'reserved') return { kind: 'unavailable', name: seg0, reason: row.reason };
      if (!row.live()) {
        return {
          kind: 'unavailable', name: seg0,
          reason: `the ${seg0} environment is not available right now`,
        };
      }
      return { kind: 'mount', name: seg0, vfs: row.vfs, policy: row.policy, sub: envPath(row.policy.rootPath, rest) };
    }
    // COMPAT: bare and deeper-absolute non-mount paths belong to /local.
    return { kind: 'mount', name: 'local', vfs: local.vfs, policy: local.policy, sub: envPath(local.policy.rootPath, abs) };
  }

  // ── The 7 VFS methods ─────────────────────────────────────────────

  async readFile(path: string, opts?: { encoding?: string }): Promise<Uint8Array | string> {
    const r = this.demandMount(path, 'open');
    return r.vfs.readFile(r.sub, opts);
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const r = this.demandMount(path, 'open');
    this.assertWritable(r, path);
    return r.vfs.writeFile(r.sub, data);
  }

  async readdir(path: string): Promise<string[]> {
    const r = this.demandMount(path, 'scandir');
    return r.vfs.readdir(r.sub);
  }

  async stat(path: string): Promise<{ size: number; mtime: number; isDir: boolean } | null> {
    const r = this.demandMount(path, 'stat');
    return r.vfs.stat(r.sub);
  }

  async unlink(path: string): Promise<void> {
    const r = this.demandMount(path, 'unlink');
    this.assertWritable(r, path);
    return r.vfs.unlink(r.sub);
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const r = this.demandMount(path, 'mkdir');
    this.assertWritable(r, path);
    return r.vfs.mkdir(r.sub, opts);
  }

  async exists(path: string): Promise<boolean> {
    const r = this.resolve(path);
    if (r.kind !== 'mount') return false;
    return r.vfs.exists(r.sub);
  }

  // ── internals ─────────────────────────────────────────────────────

  private demandMount(path: string, op: string): Extract<ResolvedPath, { kind: 'mount' }> {
    const r = this.resolve(path);
    if (r.kind === 'unavailable') {
      throw makeVfsError('ENXIO', `/${r.name} is not available (${r.reason}), ${op} '${path}'`, path);
    }
    if (r.kind !== 'mount') {
      // Phase 0: unreachable — resolve() compat-routes everything to a mount.
      throw makeVfsError('ENOENT', `no such file or directory, ${op} '${path}'`, path);
    }
    return r;
  }

  private assertWritable(r: Extract<ResolvedPath, { kind: 'mount' }>, path: string): void {
    if (r.policy.readOnly) {
      throw makeVfsError('EROFS', `/${r.name} is a read-only mount, write '${path}'`, path);
    }
  }

  private assertMountName(name: string): void {
    if (name === 'local') throw new Error("'local' is the permanent writable base mount");
    if (!NAME_RE.test(name)) throw new Error(`invalid mount name '${name}'`);
  }
}

/** Map a mount-relative remainder ('' or '/x/y') onto the environment path. */
function envPath(rootPath: string, rest: string): string {
  if (rootPath === '') return rest.replace(/^\//, '');
  if (rootPath === '/') return rest === '' ? '/' : rest;
  return rest === '' ? rootPath : rootPath + rest;
}
