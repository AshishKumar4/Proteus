/**
 * CompositeVFS — the workspace file plane.
 *
 * Phase 0 pins the risk-retirement contract: with only /local mounted, the
 * composite is byte-identical to the bare SqliteFS-backed Storage.vfs it
 * replaced — same rows, same addressing, same interop with raw-SQL writers.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { writeVfsFileSync } from '@proteus/agent-utils/vfs';
import { CompositeVFS, cleanAbsolutePath } from '../src/vfs/index.js';
import { createInlineVFS } from '../src/identity/inline-primitives.js';
import { makeSql } from './helpers.js';

function createComposite() {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const vfs = new CompositeVFS({ local: createInlineVFS(sql) });
  return { sql, vfs };
}

describe('cleanAbsolutePath', () => {
  test('preserves the leading slash and resolves dot segments', () => {
    expect(cleanAbsolutePath('/a/./b/../c')).toBe('/a/c');
    expect(cleanAbsolutePath('/a//b/')).toBe('/a/b');
    expect(cleanAbsolutePath('/')).toBe('/');
  });

  test(".. above root clamps at root (chroot semantics)", () => {
    expect(cleanAbsolutePath('/../..')).toBe('/');
    expect(cleanAbsolutePath('/a/../../b')).toBe('/b');
  });
});

describe('Phase 0 — compat routing to /local', () => {
  test('bare, deeper-absolute, and /local-prefixed paths address the same file', async () => {
    const { vfs } = createComposite();
    await vfs.writeFile('scaffold/agent.js', 'v1');
    expect(await vfs.readFile('/scaffold/agent.js', { encoding: 'utf8' })).toBe('v1');
    expect(await vfs.readFile('/local/scaffold/agent.js', { encoding: 'utf8' })).toBe('v1');

    await vfs.writeFile('/local/scaffold/agent.js', 'v2');
    expect(await vfs.readFile('scaffold/agent.js', { encoding: 'utf8' })).toBe('v2');
  });

  test('relative paths resolve against the default cwd /local', async () => {
    const { vfs } = createComposite();
    expect(vfs.cwd).toBe('/local');
    await vfs.writeFile('notes/./a/../b.md', 'hello');
    expect(await vfs.readFile('/local/notes/b.md', { encoding: 'utf8' })).toBe('hello');
  });

  test('vfs_files rows are byte-identical to a direct SqliteFS write', async () => {
    const { sql, vfs } = createComposite();
    await vfs.writeFile('/local/a.txt', 'same-content');
    writeVfsFileSync(sql, 'b.txt', 'same-content');

    const rows = sql<{ path: string; chunk_index: number; parent_path: string; is_dir: number; size: number; t: string }>`
      SELECT path, chunk_index, parent_path, is_dir, size, typeof(data) AS t
      FROM vfs_files WHERE path IN ('a.txt', 'b.txt') ORDER BY path
    `;
    expect(rows.length).toBe(2);
    const [a, b] = rows;
    expect({ ...a, path: '' }).toEqual({ ...b, path: '' });
  });

  test('raw-SQL writes (writeVfsFileSync) are readable through the composite', async () => {
    const { sql, vfs } = createComposite();
    writeVfsFileSync(sql, 'SOUL.md', '# Jarvis');
    expect(await vfs.readFile('SOUL.md', { encoding: 'utf8' })).toBe('# Jarvis');
    expect(await vfs.readFile('/local/SOUL.md', { encoding: 'utf8' })).toBe('# Jarvis');
  });

  test('binary content round-trips byte-for-byte', async () => {
    const { vfs } = createComposite();
    const bytes = new Uint8Array(512).map((_, i) => i % 251);
    await vfs.writeFile('bin/blob.dat', bytes);
    const back = (await vfs.readFile('/local/bin/blob.dat')) as Uint8Array;
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  test('the full 7-method surface delegates to /local', async () => {
    const { vfs } = createComposite();
    await vfs.mkdir('proj/src', { recursive: true });
    await vfs.writeFile('proj/src/main.ts', 'x');

    expect(await vfs.readdir('proj')).toEqual(['src']);
    expect(await vfs.readdir('/local/proj/src')).toEqual(['main.ts']);
    expect(await vfs.exists('/proj/src/main.ts')).toBe(true);
    const st = await vfs.stat('proj/src/main.ts');
    expect(st).toEqual({ size: 1, mtime: st!.mtime, isDir: false });
    expect((await vfs.stat('/local/proj'))!.isDir).toBe(true);

    await vfs.unlink('/local/proj/src/main.ts');
    expect(await vfs.exists('proj/src/main.ts')).toBe(false);
    expect(await vfs.stat('proj/src/missing.ts')).toBeNull();
    expect(await vfs.readFile('nope.txt').catch((e: { code?: string }) => e.code)).toBe('ENOENT');
  });

  test('ENOENT reads match the bare-VFS contract', async () => {
    const { vfs } = createComposite();
    expect(await vfs.exists('missing.txt')).toBe(false);
    expect(await vfs.stat('/local/missing.txt')).toBeNull();
  });
});

describe('mount table basics', () => {
  test('/local is always mounted, writable, durable — and never unmounts', () => {
    const { vfs } = createComposite();
    expect(vfs.listMounts()).toEqual([{
      name: 'local',
      prefix: '/local',
      live: true,
      policy: { readOnly: false, rootPath: '', consistency: 'durable', credentialsStayInHost: false },
      cwd: '/local',
      reason: null,
    }]);
    expect(() => vfs.unmount('local')).toThrow(/never unmounts/);
  });

  test("mount names are validated and 'local' is not remountable", () => {
    const { vfs } = createComposite();
    const spec = {
      vfs: createInlineVFS(makeSql(new Database(':memory:'))),
      policy: { readOnly: false, rootPath: '/', consistency: 'ephemeral' as const, credentialsStayInHost: true },
    };
    expect(() => vfs.mount('local', spec)).toThrow(/permanent writable base/);
    expect(() => vfs.mount('Bad Name', spec)).toThrow(/invalid mount name/);
  });
});
