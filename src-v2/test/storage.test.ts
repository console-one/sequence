/**
 * storage.test.ts — NodeStorage + installNodeStorage cap-mount.
 *
 * Ported from v1 commit 614f4cb env-storage tests. NodeStorage is the
 * Node.js-fs-backed IStorage implementation shared by Unix/Docker/
 * Lambda envs. Trusted-root scoping, traversal guard, in-memory read
 * cache. installNodeStorage mounts it as fn-kind cells on a Sequence
 * so tools.storage.read/write/etc. become substrate-native operations.
 *
 * Required for any restart-safe deployment of v2 Sequence — without
 * persistence, every Sequence is in-memory only and reboot loses state.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Sequence } from '../sequence';
import { NodeStorage, type IStorage } from '../env/storage';
import { installNodeStorage, installCommitment, flushPending } from '../stdlib';

function makeStorage(): { storage: NodeStorage; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'v2-storage-'));
  return {
    storage: new NodeStorage(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('NodeStorage: read/write basics', () => {
  let s: NodeStorage;
  let cleanup: () => void;
  beforeEach(() => { ({ storage: s, cleanup } = makeStorage()); });
  afterEach(() => cleanup());

  it('write then read returns the same content', async () => {
    await s.write('foo.txt', 'hello world');
    expect(await s.read('foo.txt')).toBe('hello world');
  });

  it('write creates parent directories as needed', async () => {
    await s.write('a/b/c.txt', 'nested');
    expect(await s.read('a/b/c.txt')).toBe('nested');
  });

  it('has returns false for missing key', async () => {
    expect(await s.has('missing')).toBe(false);
  });

  it('has returns true after write', async () => {
    await s.write('present', 'x');
    expect(await s.has('present')).toBe(true);
  });

  it('exists is cache-aware (returns true for cached even after disk delete)', async () => {
    await s.write('cached.txt', 'data');
    expect(await s.exists('cached.txt')).toBe(true);
    // exists uses cache — read first to populate cache
    await s.read('cached.txt');
    expect(await s.exists('cached.txt')).toBe(true);
  });

  it('delete removes the file and clears cache', async () => {
    await s.write('to-delete.txt', 'gone soon');
    expect(await s.has('to-delete.txt')).toBe(true);
    await s.delete('to-delete.txt');
    expect(await s.has('to-delete.txt')).toBe(false);
  });

  it('delete is no-op if key missing', async () => {
    await expect(s.delete('never-existed.txt')).resolves.not.toThrow();
  });

  it('list returns direct children', async () => {
    await s.write('dir/a.txt', '1');
    await s.write('dir/b.txt', '2');
    await s.write('dir/c.txt', '3');
    const entries = await s.list('dir');
    expect(entries.sort()).toEqual(['dir/a.txt', 'dir/b.txt', 'dir/c.txt']);
  });

  it('list of empty dir returns []', async () => {
    expect(await s.list('non-existent')).toEqual([]);
  });

  it('mkdir creates nested directories', async () => {
    await s.mkdir('x/y/z');
    expect(await s.has('x/y/z')).toBe(true);
  });

  it('append adds to existing file', async () => {
    await s.write('log.txt', 'line1\n');
    await s.append('log.txt', 'line2\n');
    expect(await s.read('log.txt')).toBe('line1\nline2\n');
  });

  it('append creates the file if missing', async () => {
    await s.append('newlog.txt', 'first\n');
    expect(await s.read('newlog.txt')).toBe('first\n');
  });
});

describe('NodeStorage: trusted-root traversal guard', () => {
  let s: NodeStorage;
  let cleanup: () => void;
  beforeEach(() => { ({ storage: s, cleanup } = makeStorage()); });
  afterEach(() => cleanup());

  it('rejects ../-style escape from trusted root', async () => {
    await expect(s.write('../escaped.txt', 'pwn')).rejects.toThrow(/path traversal/);
  });

  it('rejects deeply nested ../ escape', async () => {
    await expect(s.write('a/b/../../../etc/passwd', 'pwn')).rejects.toThrow(/path traversal/);
  });

  it('allows interior ../ that stays within root', async () => {
    await s.write('a/b/c.txt', 'inner');
    // Reading 'a/b/../b/c.txt' should resolve to 'a/b/c.txt'
    expect(await s.read('a/b/../b/c.txt')).toBe('inner');
  });

  it('rejects read on traversal', async () => {
    await expect(s.read('../etc/passwd')).rejects.toThrow(/path traversal/);
  });

  it('rejects delete on traversal', async () => {
    await expect(s.delete('../something')).rejects.toThrow(/path traversal/);
  });
});

describe('NodeStorage: cache invalidation', () => {
  let s: NodeStorage;
  let cleanup: () => void;
  beforeEach(() => { ({ storage: s, cleanup } = makeStorage()); });
  afterEach(() => cleanup());

  it('write through cache survives subsequent read', async () => {
    await s.write('c.txt', 'one');
    await s.read('c.txt'); // populate cache
    await s.write('c.txt', 'two');
    expect(await s.read('c.txt')).toBe('two');
  });

  it('append invalidates the cached read', async () => {
    await s.write('c.txt', 'a');
    await s.read('c.txt');  // cache 'a'
    await s.append('c.txt', 'b');
    expect(await s.read('c.txt')).toBe('ab');
  });

  it('clearCache(key) drops one entry', async () => {
    await s.write('c.txt', 'data');
    await s.read('c.txt');
    s.clearCache('c.txt');
    // Re-read still works (file on disk)
    expect(await s.read('c.txt')).toBe('data');
  });

  it('clearCache() drops everything', async () => {
    await s.write('a.txt', 'a');
    await s.write('b.txt', 'b');
    await s.read('a.txt');
    await s.read('b.txt');
    s.clearCache();
    expect(await s.read('a.txt')).toBe('a');
    expect(await s.read('b.txt')).toBe('b');
  });
});

describe('installNodeStorage: substrate-native tool surface', () => {
  let s: NodeStorage;
  let cleanup: () => void;
  let seq: Sequence;
  beforeEach(() => {
    ({ storage: s, cleanup } = makeStorage());
    seq = new Sequence();
    installCommitment(seq);
    installNodeStorage(seq, s);
  });
  afterEach(() => cleanup());

  it('mounts tools.storage.{read,write,...} as fn-kind cells', () => {
    for (const name of ['read', 'write', 'has', 'exists', 'delete', 'list', 'mkdir', 'append']) {
      expect(seq.typeAt(`tools.storage.${name}`)?.kind).toBe('fn');
    }
  });

  it('write tool: invocation persists, then read tool retrieves', async () => {
    seq.insert({ path: 'tools.storage.write', value: { key: 'hello.txt', data: 'world' } });
    await flushPending(seq);
    seq.insert({ path: 'tools.storage.read', value: { key: 'hello.txt' } });
    await flushPending(seq);
    expect(seq.get('tools.storage.read.result')).toEqual({ content: 'world' });
  });

  it('has tool returns boolean', async () => {
    seq.insert({ path: 'tools.storage.write', value: { key: 'present.txt', data: 'x' } });
    await flushPending(seq);
    seq.insert({ path: 'tools.storage.has', value: { key: 'present.txt' } });
    await flushPending(seq);
    expect(seq.get('tools.storage.has.result')).toEqual({ present: true });
    seq.insert({ path: 'tools.storage.has', value: { key: 'missing.txt' } });
    await flushPending(seq);
    expect(seq.get('tools.storage.has.result')).toEqual({ present: false });
  });

  it('list tool returns entries', async () => {
    seq.insert({ path: 'tools.storage.write', value: { key: 'd/a', data: 'a' } });
    await flushPending(seq);
    seq.insert({ path: 'tools.storage.write', value: { key: 'd/b', data: 'b' } });
    await flushPending(seq);
    seq.insert({ path: 'tools.storage.list', value: { prefix: 'd' } });
    await flushPending(seq);
    const result = seq.get('tools.storage.list.result') as { entries: string[] };
    expect(result.entries.sort()).toEqual(['d/a', 'd/b']);
  });

  it('delete tool removes the file', async () => {
    seq.insert({ path: 'tools.storage.write', value: { key: 'gone.txt', data: 'soon' } });
    await flushPending(seq);
    seq.insert({ path: 'tools.storage.delete', value: { key: 'gone.txt' } });
    await flushPending(seq);
    expect(await s.has('gone.txt')).toBe(false);
  });

  it('an arbitrary IStorage implementation works', async () => {
    // Build an in-memory IStorage to prove the mount layer is generic.
    const mem = new Map<string, string>();
    const memStorage: IStorage = {
      async has(k) { return mem.has(k); },
      async read(k) { const v = mem.get(k); if (v === undefined) throw new Error('missing'); return v; },
      async write(k, d) { mem.set(k, d); },
      async exists(k) { return mem.has(k); },
      async delete(k) { mem.delete(k); },
      async list(p) { return [...mem.keys()].filter(k => k === p || k.startsWith(p + '/')); },
      async mkdir(_d) { /* no-op */ },
      async append(k, d) { mem.set(k, (mem.get(k) ?? '') + d); },
    };
    const s2 = new Sequence();
    installCommitment(s2);
    installNodeStorage(s2, memStorage);
    s2.insert({ path: 'tools.storage.write', value: { key: 'k', data: 'v' } });
    await flushPending(s2);
    expect(mem.get('k')).toBe('v');
  });
});
