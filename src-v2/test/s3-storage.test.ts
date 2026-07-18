/**
 * s3-storage.test.ts — the in-memory S3 IStorage stub.
 *
 * Ported to v2 at deletion-ledger stage 3 (from sequenceutils
 * transport/env/s3-storage.ts, whose behavior contract was pinned
 * downstream by substrate's env-lambda tests). Covers the S3-specific
 * semantics that differ from NodeStorage: NoSuchKey error model,
 * shared-bucket visibility across instances, flat keys (mkdir no-op),
 * and the test-isolation reset.
 */

import { S3Storage, resetAllS3Buckets } from '../env/s3-storage';

afterEach(() => resetAllS3Buckets());

describe('S3Storage: IStorage contract', () => {
  it('write then read round-trips', async () => {
    const s = new S3Storage();
    await s.write('agents/alice/snapshot.ft', 'a = 1');
    expect(await s.read('agents/alice/snapshot.ft')).toBe('a = 1');
    expect(await s.has('agents/alice/snapshot.ft')).toBe(true);
    expect(await s.exists('agents/alice/snapshot.ft')).toBe(true);
  });

  it('read of a missing key throws NoSuchKey (not ENOENT)', async () => {
    const s = new S3Storage({ bucket: 'b1' });
    await expect(s.read('missing')).rejects.toMatchObject({
      code: 'NoSuchKey',
      message: expect.stringContaining('b1/missing'),
    });
  });

  it('append concatenates, delete removes, list filters by prefix', async () => {
    const s = new S3Storage();
    await s.append('log.txt', 'a');
    await s.append('log.txt', 'b');
    expect(await s.read('log.txt')).toBe('ab');

    await s.write('agents/alice/x', '1');
    await s.write('agents/bob/x', '2');
    expect((await s.list('agents/alice')).sort()).toEqual(['agents/alice/x']);

    await s.delete('log.txt');
    expect(await s.has('log.txt')).toBe(false);
  });

  it('mkdir is a no-op — S3 keys are flat', async () => {
    const s = new S3Storage();
    await s.mkdir('some/dir');
    expect(await s.list('some')).toEqual([]);
  });
});

describe('S3Storage: shared-bucket invariant', () => {
  it('two instances on the same bucket see each other\'s writes', async () => {
    const a = new S3Storage({ bucket: 'shared' });
    const b = new S3Storage({ bucket: 'shared' });
    await a.write('k', 'from-a');
    expect(await b.read('k')).toBe('from-a');
  });

  it('different buckets are isolated', async () => {
    const a = new S3Storage({ bucket: 'one' });
    const b = new S3Storage({ bucket: 'two' });
    await a.write('k', 'v');
    expect(await b.has('k')).toBe(false);
  });

  it('resetAllS3Buckets wipes every bucket', async () => {
    const a = new S3Storage({ bucket: 'one' });
    const b = new S3Storage({ bucket: 'two' });
    await a.write('k', 'v');
    await b.write('k', 'v');
    resetAllS3Buckets();
    expect(a.size()).toBe(0);
    expect(b.size()).toBe(0);
  });
});
