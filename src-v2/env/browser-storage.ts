/**
 * env/browser-storage.ts — IStorage backed by IndexedDB (or an
 * in-memory stub for tests + SSR).
 *
 * Ported from v1 commit 65abd92. Symmetric to NodeStorage:
 * same IStorage contract, trusted-prefix semantics, read cache,
 * async interface.
 *
 * Two backends:
 *   - IndexedDBBackend — production. One object store per database.
 *   - MemoryBackend — Map-backed stub keyed by db name. Used when
 *     `indexedDB` isn't present (Node test workers, SSR).
 *
 * Auto-picks IndexedDB when available, Map otherwise. `forceMemory`
 * config flag forces the stub for tests that don't pull
 * `fake-indexeddb`.
 */

import type { IStorage } from './storage';

// ═══════════════════════════════════════════════════════════════════════
// BACKENDS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Narrow interface both backends implement. Async everywhere so the
 * IndexedDB path is natural. Key passed here is the FULL (already-
 * prefixed) key — trusted-root scoping is enforced at BrowserStorage,
 * not at the backend.
 */
interface IBrowserStorageBackend {
  get(fullKey: string): Promise<string | undefined>;
  put(fullKey: string, value: string): Promise<void>;
  has(fullKey: string): Promise<boolean>;
  del(fullKey: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * In-memory Map-backed stub. Module-global keyed by database name so
 * two BrowserStorage instances naming the same db see the same state
 * — matches the real IndexedDB invariant (db name identifies store).
 */
const MEMORY_DBS = new Map<string, Map<string, string>>();

class MemoryBackend implements IBrowserStorageBackend {
  private store: Map<string, string>;
  constructor(dbName: string) {
    let s = MEMORY_DBS.get(dbName);
    if (!s) { s = new Map(); MEMORY_DBS.set(dbName, s); }
    this.store = s;
  }
  async get(k: string): Promise<string | undefined> { return this.store.get(k); }
  async put(k: string, v: string): Promise<void> { this.store.set(k, v); }
  async has(k: string): Promise<boolean> { return this.store.has(k); }
  async del(k: string): Promise<void> { this.store.delete(k); }
  async keys(): Promise<string[]> { return Array.from(this.store.keys()); }
}

/**
 * Production IndexedDB backend. One object store per db, keyed by
 * full key. Constructed lazily on first use so tests that never
 * touch IDB don't hit IDB globals during import.
 */
class IndexedDBBackend implements IBrowserStorageBackend {
  private dbName: string;
  private storeName = 'kv';
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName: string) { this.dbName = dbName; }

  private db(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const g: any = globalThis as any;
      const req: IDBOpenDBRequest = g.indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private tx<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return this.db().then(db => new Promise<T>((resolve, reject) => {
      const t = db.transaction(this.storeName, mode);
      const s = t.objectStore(this.storeName);
      const r = op(s);
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => reject(r.error);
    }));
  }

  async get(k: string): Promise<string | undefined> {
    return await this.tx<string | undefined>(
      'readonly', s => s.get(k) as IDBRequest<string | undefined>,
    );
  }
  async put(k: string, v: string): Promise<void> {
    await this.tx<IDBValidKey>('readwrite', s => s.put(v, k));
  }
  async has(k: string): Promise<boolean> {
    const count = await this.tx<number>('readonly', s => s.count(k));
    return count > 0;
  }
  async del(k: string): Promise<void> {
    await this.tx<undefined>('readwrite', s => s.delete(k) as IDBRequest<undefined>);
  }
  async keys(): Promise<string[]> {
    const keys = await this.tx<IDBValidKey[]>(
      'readonly', s => s.getAllKeys() as IDBRequest<IDBValidKey[]>,
    );
    return keys.map(k => String(k));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════

export interface BrowserStorageConfig {
  /** IndexedDB database name. Defaults to `sequence`. Multiple
   *  instances of the same db share state — matches real IndexedDB
   *  and is preserved in the memory stub. */
  dbName?: string;
  /** Trusted key prefix. Every read/write/list operation is rewritten
   *  to operate on `{rootPrefix}/{key}`. A caller passing `../other`
   *  has the `..` normalized to a literal segment — IndexedDB has no
   *  filesystem traversal, but trusted-root semantics from NodeStorage
   *  are preserved so call sites look the same. */
  rootPrefix?: string;
  /** Force the Map-backed backend (bypass auto-detect). */
  forceMemory?: boolean;
}

export class BrowserStorage implements IStorage {
  private backend: IBrowserStorageBackend;
  private readonly rootPrefix: string;
  // Read cache — identical to NodeStorage semantics. Invalidated on
  // write / delete / missing-on-read.
  private readCache = new Map<string, string>();

  constructor(config: BrowserStorageConfig = {}) {
    const dbName = config.dbName ?? 'sequence';
    this.rootPrefix = normalizePrefix(config.rootPrefix ?? '');
    const useMemory = config.forceMemory === true || !hasIndexedDB();
    this.backend = useMemory ? new MemoryBackend(dbName) : new IndexedDBBackend(dbName);
  }

  /** Compose the trusted prefix with the caller-supplied key.
   *  Strip leading slashes and any `..` / `.` segments so the
   *  caller can't escape the root. */
  private scoped(key: string): string {
    const normalized = key
      .split('/')
      .filter(seg => seg.length > 0 && seg !== '.' && seg !== '..')
      .join('/');
    return this.rootPrefix ? `${this.rootPrefix}/${normalized}` : normalized;
  }

  async has(key: string): Promise<boolean> {
    return this.backend.has(this.scoped(key));
  }

  async read(key: string): Promise<string> {
    const scoped = this.scoped(key);
    const cached = this.readCache.get(scoped);
    if (cached !== undefined) return cached;
    const v = await this.backend.get(scoped);
    if (v === undefined) {
      const err: any = new Error(`BrowserStorage: ${key} not found`);
      err.code = 'ENOENT';
      throw err;
    }
    this.readCache.set(scoped, v);
    return v;
  }

  async write(key: string, data: string): Promise<void> {
    const scoped = this.scoped(key);
    await this.backend.put(scoped, data);
    this.readCache.set(scoped, data);
  }

  async exists(key: string): Promise<boolean> {
    return this.has(key);
  }

  async delete(key: string): Promise<void> {
    const scoped = this.scoped(key);
    await this.backend.del(scoped);
    this.readCache.delete(scoped);
  }

  async list(prefix: string): Promise<string[]> {
    const scopedPrefix = this.scoped(prefix);
    const all = await this.backend.keys();
    const out: string[] = [];
    for (const k of all) {
      if (k.startsWith(scopedPrefix)) {
        // Strip the trusted-root prefix so callers see keys relative
        // to the scope they're operating in — matches NodeStorage.
        const rel = this.rootPrefix && k.startsWith(this.rootPrefix + '/')
          ? k.slice(this.rootPrefix.length + 1)
          : k;
        out.push(rel);
      }
    }
    return out;
  }

  async mkdir(_dir: string): Promise<void> {
    // IndexedDB has no directory concept — flat keys. No-op keeps
    // the IStorage contract honored.
  }

  async append(key: string, data: string): Promise<void> {
    let existing = '';
    try { existing = await this.read(key); }
    catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
    await this.write(key, existing + data);
  }

  /** Root accessor — matches NodeStorage shape for uniform introspection. */
  get root(): string { return this.rootPrefix; }
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function hasIndexedDB(): boolean {
  const g: any = globalThis as any;
  return typeof g.indexedDB !== 'undefined' && g.indexedDB !== null;
}

function normalizePrefix(p: string): string {
  return p.split('/').filter(s => s.length > 0 && s !== '.' && s !== '..').join('/');
}

/**
 * Test-only: wipe every in-memory browser-storage db so test suites
 * can isolate between runs. No effect on real IndexedDB.
 */
export function resetAllBrowserStorage(): void {
  for (const m of MEMORY_DBS.values()) m.clear();
}
