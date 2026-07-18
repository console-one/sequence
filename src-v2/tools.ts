/**
 * tools.ts (v2) — the base effect primitives, on THE kernel.
 *
 * Deletion-ledger stage 2 (2026-07-17): ports sequenceutils' base tools
 * (http/fs/schedule) to v2 — impl logic reused verbatim where engine-
 * independent; registration is v2's shape (impls.set + insert fn type,
 * so every primitive is a typed name in the environment and appears in
 * hoistCatalog frames). The sequenceutils v1 registrars are superseded
 * by this module and die with that package (ledger stage 3).
 *
 * Decoration (auth headers, endpoint specialisation, rate policy) stays
 * the composition story: narrow the type at a NEW path; never fork the
 * impl. fs.* is storage-KEY I/O over an injected minimal storage — real
 * filesystem semantics (watch/tail/glob) are SEPARATE primitives added
 * when a consumer needs them (connector transcript sources), not bolted
 * onto this interface.
 */

// NO static node-only imports here: this module is re-exported by the
// v2 index, which browser bundlers consume (office GUI → shared →
// index). fsnode.*/proc.exec lazy-import node:fs/path/child_process
// inside their impls (dynamic import — ESM-clean, unlike the require()
// class c5df66c fixed), so the node edge is paid only where the grant
// is actually mounted and exercised.
import { FT } from '../src/builder';
import type { Sequence } from './sequence';

/** The minimal storage a host injects for fs.* — NodeStorage/Browser/S3
 *  shaped; structural on purpose (no dependency on sequenceutils). */
export type ToolStorage = {
  read(key: string): Promise<string>;
  write(key: string, content: string): Promise<number> | Promise<void>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  append(key: string, content: string): Promise<number> | Promise<void>;
};

function register(seq: Sequence, path: string, impl: (input: unknown) => unknown, type: unknown): void {
  seq.impls.set(path, impl);
  seq.insert({ path, type: type as never });
}

/** `http.fetch` — the one HTTP primitive; LLM endpoints etc. are typed
 *  narrowings of this, never new impls. */
export function registerHttp(seq: Sequence): void {
  register(
    seq,
    'http.fetch',
    async (input: unknown) => {
      const { url, method = 'GET', headers, body } = (input ?? {}) as {
        url: string; method?: string; headers?: Record<string, string>; body?: string;
      };
      if (typeof url !== 'string') throw new Error('http.fetch: url must be a string');
      const res = await fetch(url, { method, headers, body });
      const responseBody = await res.text();
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { responseHeaders[k] = v; });
      return { status: res.status, body: responseBody, headers: responseHeaders };
    },
    FT.fn({
      input: FT.object({ url: FT.string(), 'method?': FT.string(), 'headers?': FT.object(), 'body?': FT.string() }),
      output: FT.object({ status: FT.number(), body: FT.string(), headers: FT.object() }),
      description: 'fetch a URL — the one HTTP primitive; endpoints compose by type narrowing',
    }),
  );
}

/** `fs.read/write/exists/list/append` — storage-key I/O over the
 *  injected storage (path-traversal scoping is the storage's job). */
export function registerFs(seq: Sequence, storage: ToolStorage): void {
  register(seq, 'fs.read', async (input: unknown) => {
    const { key } = (input ?? {}) as { key: string };
    if (typeof key !== 'string') throw new Error('fs.read: key must be a string');
    return { content: await storage.read(key) };
  }, FT.fn({
    input: FT.object({ key: FT.string() }),
    output: FT.object({ content: FT.string() }),
    description: 'read a storage key',
  }));

  register(seq, 'fs.write', async (input: unknown) => {
    const { key, content } = (input ?? {}) as { key: string; content: string };
    if (typeof key !== 'string') throw new Error('fs.write: key must be a string');
    const bytes = await storage.write(key, String(content ?? ''));
    return { bytes: typeof bytes === 'number' ? bytes : String(content ?? '').length };
  }, FT.fn({
    input: FT.object({ key: FT.string(), content: FT.string() }),
    output: FT.object({ bytes: FT.number() }),
    description: 'write a storage key',
  }));

  register(seq, 'fs.exists', async (input: unknown) => {
    const { key } = (input ?? {}) as { key: string };
    if (typeof key !== 'string') throw new Error('fs.exists: key must be a string');
    return { exists: await storage.exists(key) };
  }, FT.fn({
    input: FT.object({ key: FT.string() }),
    output: FT.object({ exists: FT.boolean() }),
    description: 'does a storage key exist',
  }));

  register(seq, 'fs.list', async (input: unknown) => {
    const { prefix } = (input ?? {}) as { prefix: string };
    if (typeof prefix !== 'string') throw new Error('fs.list: prefix must be a string');
    return { keys: await storage.list(prefix) };
  }, FT.fn({
    input: FT.object({ prefix: FT.string() }),
    output: FT.object({ keys: FT.array(FT.string()) }),
    description: 'list storage keys under a prefix',
  }));

  register(seq, 'fs.append', async (input: unknown) => {
    const { key, content } = (input ?? {}) as { key: string; content: string };
    if (typeof key !== 'string') throw new Error('fs.append: key must be a string');
    const bytes = await storage.append(key, String(content ?? ''));
    return { bytes: typeof bytes === 'number' ? bytes : String(content ?? '').length };
  }, FT.fn({
    input: FT.object({ key: FT.string(), content: FT.string() }),
    output: FT.object({ bytes: FT.number() }),
    description: 'append to a storage key',
  }));
}

/** `fsnode.*` — REAL filesystem primitives (distinct from the storage-key
 *  `fs.*` above): the irreducible edge a transcript-source connector needs
 *  — enumerate files, offset-advancing tail, stat for change detection.
 *  "Watching" is NOT a primitive: it is polling on the clock (schedule.at
 *  / the host wake loop) over these three — no setInterval in a tool.
 *  These are the seam-B′ transports the connector maps named MISSING. */
export function registerFsNode(seq: Sequence): void {
  register(seq, 'fsnode.list', async (input: unknown) => {
    const { dir, ext, recursive = true } = (input ?? {}) as { dir: string; ext?: string; recursive?: boolean };
    if (typeof dir !== 'string') throw new Error('fsnode.list: dir must be a string');
    const nodeFs = await import('node:fs');
    const nodePath = await import('node:path');
    const out: string[] = [];
    const walk = (d: string): void => {
      let entries: import('node:fs').Dirent[];
      try { entries = nodeFs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = nodePath.join(d, e.name);
        if (e.isDirectory()) { if (recursive) walk(full); }
        else if (!ext || e.name.endsWith(ext)) out.push(full);
      }
    };
    walk(dir);
    return { files: out.sort() };
  }, FT.fn({
    input: FT.object({ dir: FT.string(), 'ext?': FT.string(), 'recursive?': FT.boolean() }),
    output: FT.object({ files: FT.array(FT.string()) }),
    description: 'list files under a real directory, optionally by extension (recursive by default)',
  }));

  register(seq, 'fsnode.stat', async (input: unknown) => {
    const { path } = (input ?? {}) as { path: string };
    if (typeof path !== 'string') throw new Error('fsnode.stat: path must be a string');
    const nodeFs = await import('node:fs');
    try {
      const st = nodeFs.statSync(path);
      return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return { exists: false, size: 0, mtimeMs: 0 };
    }
  }, FT.fn({
    input: FT.object({ path: FT.string() }),
    output: FT.object({ exists: FT.boolean(), size: FT.number(), mtimeMs: FT.number() }),
    description: 'stat a real file — existence, size, mtime (for change detection)',
  }));

  register(seq, 'fsnode.tail', async (input: unknown) => {
    const { path, offset = 0 } = (input ?? {}) as { path: string; offset?: number };
    if (typeof path !== 'string') throw new Error('fsnode.tail: path must be a string');
    const nodeFs = await import('node:fs');
    let size = 0;
    try { size = nodeFs.statSync(path).size; } catch { return { content: '', offset: 0, eof: 0 }; }
    // Truncation guard: if the file shrank below the offset, restart.
    const from = offset > size ? 0 : offset;
    if (from >= size) return { content: '', offset: size, eof: size };
    const length = size - from;
    const buf = Buffer.alloc(length);
    const fd = nodeFs.openSync(path, 'r');
    try { nodeFs.readSync(fd, buf, 0, length, from); } finally { nodeFs.closeSync(fd); }
    return { content: buf.toString('utf8'), offset: size, eof: size };
  }, FT.fn({
    input: FT.object({ path: FT.string(), 'offset?': FT.number() }),
    output: FT.object({ content: FT.string(), offset: FT.number(), eof: FT.number() }),
    description: 'read a real file from a byte offset to EOF, returning the new offset (offset-advancing tail)',
  }));
}

/** `proc.exec` — run a subprocess and collect its output. The general
 *  edge for CLI-shaped connectors (Codex/Gemini/gh/…) exactly as
 *  http.fetch is the edge for REST: render a descriptor {cmd,args,stdin},
 *  hand it to the effect, decode {stdout,stderr,code}. Arbitrary command
 *  execution is a categorically large grant — a manifest DECLARES this
 *  import so it is visible at install (the consent surface). */
export function registerProc(seq: Sequence): void {
  register(seq, 'proc.exec', async (input: unknown) => {
    const { cmd, args = [], stdin, timeoutMs = 120_000, cwd } = (input ?? {}) as {
      cmd: string; args?: string[]; stdin?: string; timeoutMs?: number; cwd?: string;
    };
    if (typeof cmd !== 'string') throw new Error('proc.exec: cmd must be a string');
    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, Array.isArray(args) ? args : [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(cwd ? { cwd } : {}),
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`proc.exec: '${cmd}' timed out after ${timeoutMs}ms`)); }, timeoutMs);
      proc.stdout.on('data', (c) => { stdout += c.toString(); });
      proc.stderr.on('data', (c) => { stderr += c.toString(); });
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? -1 }); });
      if (stdin !== undefined) proc.stdin.end(String(stdin), 'utf8');
      else proc.stdin.end();
    });
  }, FT.fn({
    input: FT.object({ cmd: FT.string(), 'args?': FT.array(FT.string()), 'stdin?': FT.string(), 'timeoutMs?': FT.number(), 'cwd?': FT.string() }),
    output: FT.object({ stdout: FT.string(), stderr: FT.string(), code: FT.number() }),
    description: 'run a subprocess (the CLI-connector edge, as http.fetch is the REST edge) — declared as an import for install-time consent',
  }));
}

/** `schedule.at` — one-shot deadline binding as pending facts; the host
 *  wake machinery is THE clock (never setInterval in a tool). */
export function registerSchedule(seq: Sequence): void {
  let nextId = 1;
  register(seq, 'schedule.at', (input: unknown) => {
    const { deadline } = (input ?? {}) as { deadline: number };
    if (typeof deadline !== 'number') throw new Error('schedule.at: deadline must be a number');
    const wid = `s_${nextId++}`;
    seq.insert({ path: `_schedule.pending.${wid}.deadline`, value: deadline });
    seq.insert({ path: `_schedule.pending.${wid}.status`, value: 'pending' });
    return { id: wid };
  }, FT.fn({
    input: FT.object({ deadline: FT.number() }),
    output: FT.object({ id: FT.string() }),
    description: 'bind a one-shot deadline as a pending fact',
  }));
}

/** Pure value combinators — fallback, branching, and string assembly as
 *  ordinary calls, so formatter/renderer fn definitions can live IN the
 *  language (seam 3's flavor templates) instead of compiled per-type
 *  functions. No effects, no grant: mounted unconditionally. A
 *  conditional is a call, exactly like everything else — no new syntax. */
export function registerCombinators(seq: Sequence): void {
  register(seq, 'str.concat', (input: unknown) => {
    const { parts } = (input ?? {}) as { parts: unknown[] };
    if (!Array.isArray(parts)) throw new Error('str.concat: parts must be an array');
    return parts.filter((p) => p !== undefined && p !== null && p !== '').map(String).join('');
  }, FT.fn({
    input: FT.object({ parts: FT.array(FT.any()) }),
    output: FT.string(),
    description: 'join parts into one string; null/undefined/empty parts drop',
  }));
  register(seq, 'or', (input: unknown) => {
    const { a, b } = (input ?? {}) as { a?: unknown; b?: unknown };
    return a ?? b;
  }, FT.fn({
    input: FT.object({ 'a?': FT.any(), 'b?': FT.any() }),
    output: FT.any(),
    description: 'a when present (non-null), else b',
  }));
  register(seq, 'pick', (input: unknown) => {
    const { cond, a, b } = (input ?? {}) as { cond?: unknown; a?: unknown; b?: unknown };
    return cond ? a : b;
  }, FT.fn({
    input: FT.object({ 'cond?': FT.any(), 'a?': FT.any(), 'b?': FT.any() }),
    output: FT.any(),
    description: 'cond ? a : b — branching as an ordinary call',
  }));
  // The combinators below are TOLERANT of absent inputs (undefined flows
  // through JS semantics, never a throw): argument evaluation is eager,
  // so the unchosen branch of a `pick` is still computed — a combinator
  // that throws on a hole would break every guarded expression.
  register(seq, 'eq', (input: unknown) => {
    const { a, b } = (input ?? {}) as { a?: unknown; b?: unknown };
    return a === b;
  }, FT.fn({
    input: FT.object({ 'a?': FT.any(), 'b?': FT.any() }),
    output: FT.boolean(),
    description: 'strict equality (a === b)',
  }));
  // Named `present`, not `exists` — `exists` is the dsl's reserved
  // constraint operator (tokenizer KEYWORDS) and cannot be a call name.
  register(seq, 'present', (input: unknown) => {
    const { v } = (input ?? {}) as { v?: unknown };
    return v !== null && v !== undefined;
  }, FT.fn({
    input: FT.object({ 'v?': FT.any() }),
    output: FT.boolean(),
    description: 'presence (v is neither null nor undefined) — distinct from truthiness: 0/""/false are present',
  }));
  register(seq, 'num.gt', (input: unknown) => {
    const { a, b } = (input ?? {}) as { a?: number; b?: number };
    return (a as number) > (b as number);
  }, FT.fn({
    input: FT.object({ a: FT.number(), b: FT.number() }),
    output: FT.boolean(),
    description: 'a > b (JS comparison; absent operands compare false)',
  }));
  register(seq, 'num.round', (input: unknown) => {
    const { v } = (input ?? {}) as { v?: number };
    return Math.round(v as number);
  }, FT.fn({
    input: FT.object({ v: FT.number() }),
    output: FT.number(),
    description: 'Math.round(v)',
  }));
  register(seq, 'num.mul', (input: unknown) => {
    const { a, b } = (input ?? {}) as { a?: number; b?: number };
    return (a as number) * (b as number);
  }, FT.fn({
    input: FT.object({ a: FT.number(), b: FT.number() }),
    output: FT.number(),
    description: 'a * b',
  }));
  register(seq, 'num.div', (input: unknown) => {
    const { a, b } = (input ?? {}) as { a?: number; b?: number };
    return (a as number) / (b as number);
  }, FT.fn({
    input: FT.object({ a: FT.number(), b: FT.number() }),
    output: FT.number(),
    description: 'a / b (JS semantics: /0 = Infinity — guard with pick where it matters)',
  }));
  register(seq, 'str.lower', (input: unknown) => {
    const { s } = (input ?? {}) as { s?: unknown };
    return String(s ?? '').toLowerCase();
  }, FT.fn({
    input: FT.object({ s: FT.string() }),
    output: FT.string(),
    description: 'lowercase',
  }));
  register(seq, 'str.startsWith', (input: unknown) => {
    const { s, prefix } = (input ?? {}) as { s?: unknown; prefix?: unknown };
    return String(s ?? '').startsWith(String(prefix ?? ''));
  }, FT.fn({
    input: FT.object({ s: FT.string(), prefix: FT.string() }),
    output: FT.boolean(),
    description: 's starts with prefix',
  }));
  register(seq, 'str.endsWith', (input: unknown) => {
    const { s, suffix } = (input ?? {}) as { s?: unknown; suffix?: unknown };
    return String(s ?? '').endsWith(String(suffix ?? ''));
  }, FT.fn({
    input: FT.object({ s: FT.string(), suffix: FT.string() }),
    output: FT.boolean(),
    description: 's ends with suffix',
  }));
  register(seq, 'str.stripPrefix', (input: unknown) => {
    const { s, prefix } = (input ?? {}) as { s?: unknown; prefix?: unknown };
    const str = String(s ?? '');
    const pre = String(prefix ?? '');
    return pre.length > 0 && str.startsWith(pre) ? str.slice(pre.length) : str;
  }, FT.fn({
    input: FT.object({ s: FT.string(), prefix: FT.string() }),
    output: FT.string(),
    description: 'remove a leading prefix when present, else identity',
  }));
  register(seq, 'json.encode', (input: unknown) => {
    const { v } = (input ?? {}) as { v?: unknown };
    return JSON.stringify(v);
  }, FT.fn({
    input: FT.object({ 'v?': FT.any() }),
    output: FT.string(),
    description: 'JSON.stringify(v) — the quoted/escaped form of a value',
  }));
}

/** Register the whole base toolset. `storage` optional — without it the
 *  fs.* family is simply absent from the environment (an honest hole,
 *  not a stub). */
export function registerBaseTools(seq: Sequence, opts: { storage?: ToolStorage; realFs?: boolean; proc?: boolean } = {}): void {
  registerHttp(seq);
  registerSchedule(seq);
  registerCombinators(seq);
  if (opts.storage) registerFs(seq, opts.storage);
  // Real-fs + proc are opt-in: they are large grants (arbitrary file
  // read, arbitrary command execution). A connector manifest that
  // imports them makes the grant visible at install.
  if (opts.realFs) registerFsNode(seq);
  if (opts.proc) registerProc(seq);
}
