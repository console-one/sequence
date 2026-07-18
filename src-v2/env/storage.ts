/**
 * env/storage.ts — IStorage interface + NodeStorage implementation.
 *
 * Ported from v1 commit 614f4cb (services/contextgraph/src/env/storage.ts).
 * Lifted there from lens-desktop's LocalStorage; lifted here to v2.
 *
 * Trusted-root scoping, path-traversal guards on every read/write/
 * delete, in-memory read cache with invalidation on write/delete/
 * missing-on-disk. Async throughout — same interface for the future
 * BrowserStorage (IndexedDB) impl.
 *
 * Why this lives in env/ rather than the kernel: it's an environment
 * adapter — the Sequence kernel itself stays storage-agnostic. Each
 * runtime (Unix, Docker, Lambda, Browser) constructs an IStorage
 * with its own trusted root and injects it into the substrate via
 * `installNodeStorage` (or its browser-side equivalent), which mounts
 * fn-kind tool cells at a configured path so the substrate can
 * read/write through the normal commitment machinery.
 */

// DEFAULT imports (not named): same browser-safety contract as stdlib's
// `import nodeCrypto from 'crypto'` — a *named* `import { promises } from
// 'fs'` hard-fails browser bundlers (vite's node-builtin stub has no named
// exports), which would drag node:fs into every browser consumer of the v2
// index once this module is exported there. A default import builds
// everywhere — the browser gets a proxy that only throws IF accessed, and
// the browser never constructs a NodeStorage — while node sees the real
// module.
// Property access is deferred to call time (constructor/methods) — the
// stub proxy throws on ACCESS, so no module-scope destructuring here.
import nodeFs from 'fs';
import nodePath from 'path';

// ═══════════════════════════════════════════════════════════════════════
// INTERFACE
// ═══════════════════════════════════════════════════════════════════════

/**
 * Storage abstraction shared across envs. All methods are async so
 * Node fs-backed and browser IndexedDB-backed impls share one
 * interface. Errors escape as thrown exceptions — the caller
 * (typically a tool impl wrapping these) catches them and surfaces
 * via the commitment violation path.
 */
export interface IStorage {
  /** True iff a value exists at `key`. */
  has(key: string): Promise<boolean>;
  /** Read a UTF-8 string. Throws if missing. */
  read(key: string): Promise<string>;
  /** Write a UTF-8 string, creating parent directories as needed. */
  write(key: string, data: string): Promise<void>;
  /** True iff the path exists. Cache-aware so hot-file writes don't
   *  require a stat round-trip. */
  exists(key: string): Promise<boolean>;
  /** Remove. No-op if missing. */
  delete(key: string): Promise<void>;
  /** List the direct children of a directory key. */
  list(prefix: string): Promise<string[]>;
  /** Ensure a directory exists (recursive mkdir -p). */
  mkdir(dir: string): Promise<void>;
  /** Append to an existing file, creating parent dirs if needed. */
  append(key: string, data: string): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════
// NODE IMPLEMENTATION — shared by Unix / Docker / Lambda envs with
// different trusted roots:
//   Unix:   ~/.sequence/{user}/workspace
//   Docker: /var/lib/sequence/workspace
//   Lambda: /tmp/sequence (ephemeral, per-invocation)
//
// Trusted-root policy enforced in `resolvePath`: any `..`-style
// path traversal that would escape the root throws.
// ═══════════════════════════════════════════════════════════════════════

export class NodeStorage implements IStorage {
  private rootDir: string;
  private cache: Map<string, string>;

  constructor(rootDir: string) {
    // Normalize once so resolvePath's prefix check is reliable.
    this.rootDir = nodePath.normalize(rootDir);
    this.cache = new Map();
  }

  /**
   * Resolve a caller-supplied key to an absolute path within the
   * trusted root. Throws on traversal. Single chokepoint for every
   * read/write/delete/list/exists method.
   */
  private resolvePath(key: string): string {
    const abs = nodePath.normalize(nodePath.join(this.rootDir, key));
    if (!abs.startsWith(this.rootDir)) {
      throw new Error(`NodeStorage: path traversal outside trusted root: ${key}`);
    }
    return abs;
  }

  async has(key: string): Promise<boolean> {
    try {
      await nodeFs.promises.stat(this.resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async read(key: string): Promise<string> {
    // Cache-with-invalidation: if the file has been removed out
    // from under us (sidecar tool overwrote, etc.), drop the stale
    // entry and re-read.
    if (this.cache.has(key)) {
      const abs = this.resolvePath(key);
      try {
        await nodeFs.promises.stat(abs);
        return this.cache.get(key)!;
      } catch {
        this.cache.delete(key);
      }
    }
    const data = await nodeFs.promises.readFile(this.resolvePath(key), 'utf-8');
    this.cache.set(key, data);
    return data;
  }

  async write(key: string, data: string): Promise<void> {
    const abs = this.resolvePath(key);
    await nodeFs.promises.mkdir(nodePath.dirname(abs), { recursive: true });
    await nodeFs.promises.writeFile(abs, data, 'utf-8');
    this.cache.set(key, data);
  }

  async exists(key: string): Promise<boolean> {
    if (this.cache.has(key)) return true;
    return this.has(key);
  }

  async delete(key: string): Promise<void> {
    try {
      await nodeFs.promises.rm(this.resolvePath(key), { recursive: true, force: true });
    } finally {
      this.cache.delete(key);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.resolvePath(prefix);
    try {
      const entries = await nodeFs.promises.readdir(dir);
      return entries.map((name) => (prefix ? `${prefix}/${name}` : name));
    } catch (e: any) {
      if (e?.code === 'ENOENT') return [];
      throw e;
    }
  }

  async mkdir(dir: string): Promise<void> {
    await nodeFs.promises.mkdir(this.resolvePath(dir), { recursive: true });
  }

  async append(key: string, data: string): Promise<void> {
    const abs = this.resolvePath(key);
    await nodeFs.promises.mkdir(nodePath.dirname(abs), { recursive: true });
    await nodeFs.promises.appendFile(abs, data, 'utf-8');
    // Appending invalidates any cached full-file read.
    this.cache.delete(key);
  }

  /** Drop one cached entry or the whole cache. */
  clearCache(key?: string): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }

  /** The trusted root this instance was constructed with. */
  get root(): string { return this.rootDir; }
}
