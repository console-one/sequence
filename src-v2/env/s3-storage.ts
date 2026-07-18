/**
 * env/s3-storage.ts — In-memory IStorage stub for Lambda snapshot handoff.
 *
 * Ported verbatim from sequenceutils transport/env/s3-storage.ts
 * (deletion-ledger stage 3) — engine-independent, no node imports.
 *
 * The Lambda env needs to pull the agent's last-known snapshot from
 * object storage at cold-start and push the updated one back on
 * success. Real production deployments would use `@aws-sdk/client-s3`
 * (or DynamoDB for very small snapshots) — that's a deployment
 * concern, not a concern here.
 *
 * This class implements `IStorage` so it's a drop-in test double
 * for NodeStorage. Keys are bucket-relative paths (e.g.
 * `agents/alice/snapshot.ft`); values are UTF-8 strings just like
 * NodeStorage. All state lives in a shared in-process Map, so
 * multiple env invocations in the same test can round-trip
 * snapshots through a "bucket" without touching real S3.
 *
 * Why keep this separate from NodeStorage: the trusted-root
 * traversal guards in NodeStorage don't apply to S3 (no path
 * namespace), and S3's error model is different (NoSuchKey vs
 * ENOENT). A real S3 impl would also need retry/backoff, etag
 * conditional writes, and multipart upload for large payloads —
 * none of which exist here. The stub is just enough to exercise
 * the Lambda env's pull/push flow in tests.
 */

import type { IStorage } from './storage';

/** In-process buckets, keyed by bucket name. Module-global so
 *  multiple S3Storage instances can see the same state — simulates
 *  the real S3 invariant of "all clients see the same bucket". */
const BUCKETS = new Map<string, Map<string, string>>();

export interface S3StorageConfig {
  /** Bucket name. Defaults to `office-space`. */
  bucket?: string;
}

export class S3Storage implements IStorage {
  private bucket: string;
  private store: Map<string, string>;

  constructor(config: S3StorageConfig = {}) {
    this.bucket = config.bucket ?? 'office-space';
    let b = BUCKETS.get(this.bucket);
    if (!b) { b = new Map(); BUCKETS.set(this.bucket, b); }
    this.store = b;
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async read(key: string): Promise<string> {
    const v = this.store.get(key);
    if (v === undefined) {
      const err: any = new Error(`NoSuchKey: ${this.bucket}/${key}`);
      err.code = 'NoSuchKey';
      throw err;
    }
    return v;
  }

  async write(key: string, data: string): Promise<void> {
    this.store.set(key, data);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) out.push(k);
    }
    return out;
  }

  async mkdir(_dir: string): Promise<void> {
    // S3 has no directory concept — keys are flat. No-op keeps
    // IStorage's contract honored without surfacing the
    // impedance mismatch to callers.
  }

  async append(key: string, data: string): Promise<void> {
    const prev = this.store.get(key) ?? '';
    this.store.set(key, prev + data);
  }

  /** Test-only: wipe this bucket. Not part of IStorage. */
  clear(): void {
    this.store.clear();
  }

  /** Test-only: peek the raw backing map size. */
  size(): number {
    return this.store.size;
  }
}

/**
 * Test-only: clear every bucket. Useful from afterEach to keep
 * suites isolated from cross-test snapshot leakage.
 */
export function resetAllS3Buckets(): void {
  for (const b of BUCKETS.values()) b.clear();
}
