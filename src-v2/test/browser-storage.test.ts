/**
 * browser-storage.test.ts — port of v1 browser-storage tests.
 *
 * BrowserStorage backed by MemoryBackend (auto-selected because
 * IndexedDB isn't present in the Jest worker). Same IStorage
 * contract as NodeStorage — these tests assert the symmetry.
 *
 * installNodeStorage works against ANY IStorage; BrowserStorage
 * passes that contract. The renderer-side cross-sequence demo
 * needs this so persistence works in both processes.
 */

import { Sequence } from '../sequence';
import {
  BrowserStorage, resetAllBrowserStorage,
} from '../env/browser-storage';
import { installNodeStorage, installCommitment, flushPending } from '../stdlib';

describe('BrowserStorage: read/write basics', () => {
  beforeEach(() => resetAllBrowserStorage());

  it('write then read returns the same content', async () => {
    const s = new BrowserStorage({ forceMemory: true });
    await s.write('foo.txt', 'hello world');
    expect(await s.read('foo.txt')).toBe('hello world');
  });

  it('read of missing key throws ENOENT', async () => {
    const s = new BrowserStorage({ forceMemory: true });
    await expect(s.read('missing')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('has returns false for missing, true after write', async () => {
    const s = new BrowserStorage({ forceMemory: true });
    expect(await s.has('k')).toBe(false);
    await s.write('k', 'v');
    expect(await s.has('k')).toBe(true);
  });

  it('delete removes the key', async () => {
    const s = new BrowserStorage({ forceMemory: true });
    await s.write('gone', 'soon');
    await s.delete('gone');
    expect(await s.has('gone')).toBe(false);
  });

  it('exists is alias for has', async () => {
    const s = new BrowserStorage({ forceMemory: true });
    await s.write('e', '');
    expect(await s.exists('e')).toBe(true);
    expect(await s.exists('missing')).toBe(false);
  });

  it('append adds to existing key', async () => {
    const s = new BrowserStorage({ forceMemory: true });
    await s.write('log', 'first\n');
    await s.append('log', 'second\n');
    expect(await s.read('log')).toBe('first\nsecond\n');
  });

  it('append on missing key creates it', async () => {
    const s = new BrowserStorage({ forceMemory: true });
    await s.append('newlog', 'first\n');
    expect(await s.read('newlog')).toBe('first\n');
  });

  it('mkdir is a no-op (IndexedDB is flat)', async () => {
    const s = new BrowserStorage({ forceMemory: true });
    await expect(s.mkdir('any/path')).resolves.not.toThrow();
  });
});

describe('BrowserStorage: trusted-prefix scoping', () => {
  beforeEach(() => resetAllBrowserStorage());

  it('rootPrefix scopes all keys under that prefix', async () => {
    const a = new BrowserStorage({ forceMemory: true, dbName: 'shared', rootPrefix: 'workspace' });
    const b = new BrowserStorage({ forceMemory: true, dbName: 'shared', rootPrefix: '_client' });
    await a.write('foo', 'A');
    await b.write('foo', 'B');
    // Same key string, different scopes.
    expect(await a.read('foo')).toBe('A');
    expect(await b.read('foo')).toBe('B');
  });

  it('list strips the trusted prefix from returned keys', async () => {
    const s = new BrowserStorage({ forceMemory: true, rootPrefix: 'ws' });
    await s.write('a', 'A');
    await s.write('b', 'B');
    const keys = await s.list('');
    expect(keys.sort()).toEqual(['a', 'b']);
  });

  it('../-style keys collapse to literal segments — no escape', async () => {
    const s = new BrowserStorage({ forceMemory: true, rootPrefix: 'safe' });
    await s.write('../escape', 'tried');
    // The `..` was stripped; key landed at `escape` within scope.
    expect(await s.read('escape')).toBe('tried');
    // Other scope can't reach in.
    const other = new BrowserStorage({ forceMemory: true, rootPrefix: 'other' });
    await expect(other.read('escape')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('two instances with same dbName + rootPrefix share state', async () => {
    const a = new BrowserStorage({ forceMemory: true, dbName: 'd', rootPrefix: 'p' });
    const b = new BrowserStorage({ forceMemory: true, dbName: 'd', rootPrefix: 'p' });
    await a.write('shared-key', 'shared-value');
    expect(await b.read('shared-key')).toBe('shared-value');
  });
});

describe('BrowserStorage: read cache', () => {
  beforeEach(() => resetAllBrowserStorage());

  it('subsequent read returns cached value (no backend hit)', async () => {
    const s = new BrowserStorage({ forceMemory: true });
    await s.write('c', 'first');
    expect(await s.read('c')).toBe('first');
    expect(await s.read('c')).toBe('first');
  });

  it('write invalidates and updates cache', async () => {
    const s = new BrowserStorage({ forceMemory: true });
    await s.write('c', 'a');
    await s.read('c');  // cache 'a'
    await s.write('c', 'b');
    expect(await s.read('c')).toBe('b');
  });

  it('append invalidates cache (next read sees concatenated value)', async () => {
    const s = new BrowserStorage({ forceMemory: true });
    await s.write('c', 'one');
    await s.read('c');  // cache 'one'
    await s.append('c', 'two');
    expect(await s.read('c')).toBe('onetwo');
  });

  it('delete invalidates cache', async () => {
    const s = new BrowserStorage({ forceMemory: true });
    await s.write('c', 'data');
    await s.read('c');
    await s.delete('c');
    await expect(s.read('c')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('installNodeStorage works against BrowserStorage', () => {
  beforeEach(() => resetAllBrowserStorage());

  it('substrate-native tools backed by BrowserStorage round-trip', async () => {
    const storage = new BrowserStorage({ forceMemory: true, rootPrefix: 'workspace' });
    const seq = new Sequence();
    installCommitment(seq);
    installNodeStorage(seq, storage, { mountPath: 'tools.storage' });

    seq.insert({ path: 'tools.storage.write', value: { key: 'note.txt', data: 'persisted' } });
    await flushPending(seq);
    seq.insert({ path: 'tools.storage.read', value: { key: 'note.txt' } });
    await flushPending(seq);
    expect(seq.get('tools.storage.read.result')).toEqual({ content: 'persisted' });
  });

  it('two adapters on different processes (simulated) keep separate workspaces', async () => {
    // Simulates: browser + main process each running their own
    // BrowserStorage scoped to their own role. Same db, different
    // rootPrefix — they don't see each other's writes.
    const renderer = new BrowserStorage({ forceMemory: true, dbName: 'app', rootPrefix: 'renderer' });
    const main = new BrowserStorage({ forceMemory: true, dbName: 'app', rootPrefix: 'main' });

    const rseq = new Sequence();
    installCommitment(rseq);
    installNodeStorage(rseq, renderer, { mountPath: 'tools.storage' });

    const mseq = new Sequence();
    installCommitment(mseq);
    installNodeStorage(mseq, main, { mountPath: 'tools.storage' });

    rseq.insert({ path: 'tools.storage.write', value: { key: 'foo', data: 'renderer-data' } });
    mseq.insert({ path: 'tools.storage.write', value: { key: 'foo', data: 'main-data' } });
    await Promise.all([flushPending(rseq), flushPending(mseq)]);

    rseq.insert({ path: 'tools.storage.read', value: { key: 'foo' } });
    mseq.insert({ path: 'tools.storage.read', value: { key: 'foo' } });
    await Promise.all([flushPending(rseq), flushPending(mseq)]);

    expect(rseq.get('tools.storage.read.result')).toEqual({ content: 'renderer-data' });
    expect(mseq.get('tools.storage.read.result')).toEqual({ content: 'main-data' });
  });
});
