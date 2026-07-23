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
import type { Type } from '../src/type';
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

/** `fsnode.snapshot` — the CHANGE edge: stat a directory tree against a
 *  prior snapshot and return the new snapshot + itemized changes
 *  (add/modify/delete with size+mtime), timestamped by the caller's
 *  moment. The diff law lives HERE (one primitive) so capture flows are
 *  pure data: prior = read stored snapshot → snapshot() → append the
 *  changes → store the new snapshot; the stored snapshot's VERSION
 *  HISTORY is the replay stream. Same grant class as fsnode.* (realFs). */
export function registerFsSnapshot(seq: Sequence): void {
  register(seq, 'fsnode.snapshot', async (input: unknown) => {
    const { dir, ext, prior } = (input ?? {}) as {
      dir: string; ext?: string; prior?: Record<string, { size: number; mtimeMs: number }>;
    };
    if (typeof dir !== 'string') throw new Error('fsnode.snapshot: dir must be a string');
    const nodeFs = await import('node:fs');
    const nodePath = await import('node:path');
    const now: Record<string, { size: number; mtimeMs: number }> = {};
    const walk = (d: string): void => {
      let entries: import('node:fs').Dirent[];
      try { entries = nodeFs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const full = nodePath.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (ext && !e.name.endsWith(ext)) continue;
        try {
          const st = nodeFs.statSync(full);
          now[full] = { size: st.size, mtimeMs: st.mtimeMs };
        } catch { /* raced deletion — absent from the snapshot, honestly */ }
      }
    };
    walk(dir);
    const before = prior ?? {};
    const changes: Array<{ path: string; kind: 'add' | 'modify' | 'delete'; size?: number; mtimeMs?: number }> = [];
    for (const [p2, st] of Object.entries(now)) {
      const old = before[p2];
      if (!old) changes.push({ path: p2, kind: 'add', size: st.size, mtimeMs: st.mtimeMs });
      else if (old.size !== st.size || old.mtimeMs !== st.mtimeMs) {
        changes.push({ path: p2, kind: 'modify', size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    for (const p2 of Object.keys(before)) {
      if (!now[p2]) changes.push({ path: p2, kind: 'delete' });
    }
    changes.sort((a, b) => (a.path < b.path ? -1 : 1));
    return { snapshot: now, changes, files: Object.keys(now).length };
  }, FT.fn({
    input: FT.object({ dir: FT.string(), 'ext?': FT.string(), 'prior?': FT.object() }),
    output: FT.object({ snapshot: FT.object(), changes: FT.array(FT.any()), files: FT.number() }),
    description: 'stat-diff a directory tree against a prior snapshot — itemized add/modify/delete; the capture edge (node_modules/.git skipped)',
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
/** Walk a dotted attr path into a value ("body.kind", "position.seq").
 *  Non-objects along the way yield undefined — the tolerant read every
 *  list combinator shares. */
function walkAttr(v: unknown, path: string): unknown {
  let cur: unknown = v;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

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
  register(seq, 'str.padEnd', (input: unknown) => {
    const { s, width, fill } = (input ?? {}) as { s?: unknown; width?: number; fill?: unknown };
    return String(s ?? '').padEnd(Number(width ?? 0), String(fill ?? ' '));
  }, FT.fn({
    input: FT.object({ s: FT.string(), width: FT.number(), 'fill?': FT.string() }),
    output: FT.string(),
    description: 'pad s on the right to width (default fill: space) — column layout as a string op',
  }));
  register(seq, 'json.encode', (input: unknown) => {
    const { v } = (input ?? {}) as { v?: unknown };
    return JSON.stringify(v);
  }, FT.fn({
    input: FT.object({ 'v?': FT.any() }),
    output: FT.string(),
    description: 'JSON.stringify(v) — the quoted/escaped form of a value',
  }));
  register(seq, 'list.some', (input: unknown) => {
    const { items, attr, value } = (input ?? {}) as {
      items?: unknown[]; attr?: string; value?: unknown;
    };
    if (!Array.isArray(items)) return false;
    if (attr === undefined) return items.length > 0;
    return items.some((it) => walkAttr(it, attr) === value);
  }, FT.fn({
    input: FT.object({ 'items?': FT.array(FT.any()), 'attr?': FT.string(), 'value?': FT.any() }),
    output: FT.boolean(),
    description: 'does any item[attr] equal value (no attr: is the list non-empty) — the content-ls attr/value query shape as a predicate',
  }));
  register(seq, 'list.each', async (input: unknown) => {
    const { items, fn, with: extra } = (input ?? {}) as {
      items?: unknown[]; fn?: string; with?: Record<string, unknown>;
    };
    if (typeof fn !== 'string' || fn === '') throw new Error('list.each: fn (a registered definition name) is required');
    const impl = seq.impls.get(fn);
    if (!impl) throw new Error(`list.each: no implementation registered at '${fn}'`);
    const out: unknown[] = [];
    for (const item of items ?? []) {
      const args = extra && typeof item === 'object' && item !== null
        ? { ...extra, ...(item as Record<string, unknown>) }
        : extra !== undefined && (item === null || typeof item !== 'object')
          ? { ...extra, item }
          : item;
      out.push(await impl(args));
    }
    return out;
  }, FT.fn({
    input: FT.object({ 'items?': FT.array(FT.any()), fn: FT.string(), 'with?': FT.object() }),
    output: FT.array(FT.any()),
    description: 'call the NAMED definition once per item, sequentially, awaiting each — the body is a fn-def-as-fact (a path in the env), never an anonymous expression. Object items pass as the input (merged over `with`); scalar items pass as {…with, item}. Fail-fast: a throw stops the loop (wrap the fn body in attempt for collect-and-continue). Returns the per-item results in order.',
  }));
  register(seq, 'curve.parse', (input: unknown) => {
    const { s } = (input ?? {}) as { s?: string | number };
    if (typeof s === 'number') {
      if (!Number.isFinite(s) || s <= 0) throw new Error('curve.parse: must be a positive number');
      return s;
    }
    if (typeof s !== 'string' || !s.trim()) throw new Error('curve.parse: s is required');
    const t = s.trim();
    const pm = /^(\d+(?:\.\d+)?)\s*(?:±|\+\-|\+\/-)\s*(\d+(?:\.\d+)?)$/.exec(t);
    if (pm) {
      const mean = Number(pm[1]);
      const sd = Number(pm[2]);
      if (mean <= 0 || sd <= 0) throw new Error(`curve.parse '${t}': mean and spread must be positive`);
      // Moment-matched gamma: shape=(m/s)², rate=m/s² — the ONE
      // m±s reading (parity with the office amount grammar).
      return { $tv: { fn: 'posteriorPredictive', family: 'gamma', params: { shape: (mean / sd) ** 2, rate: mean / sd ** 2 } } };
    }
    if (t.startsWith('{')) {
      let parsed: unknown;
      try { parsed = JSON.parse(t); } catch { throw new Error(`curve.parse '${t}' is not valid JSON`); }
      const tv = (parsed as { $tv?: { fn?: unknown; family?: unknown; params?: unknown } }).$tv;
      if (!tv || typeof tv.fn !== 'string' || typeof tv.family !== 'string' || typeof tv.params !== 'object') {
        throw new Error('curve.parse: not a valid $tv envelope ({$tv:{fn,family,params}})');
      }
      return parsed;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`curve.parse '${t}' is not a positive number, "m±s", or a $tv envelope`);
    }
    return n;
  }, FT.fn({
    input: FT.object({ s: FT.any() }),
    output: FT.any(),
    description: 'the curve LITERAL reader: "220" → scalar (the degenerate curve) · "220±50" → moment-matched gamma $tv envelope · \'{"$tv":…}\' → the envelope verbatim. Types are curves; a planned quantity is this value.',
  }));
  register(seq, 'at', (input: unknown) => {
    const { v, path } = (input ?? {}) as { v?: unknown; path?: string };
    if (typeof path !== 'string' || path === '') return v;
    let cur: unknown = v;
    for (const seg of path.split('.')) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
  }, FT.fn({
    input: FT.object({ 'v?': FT.any(), 'path?': FT.string() }),
    output: FT.any(),
    description: 'value at a dotted path inside v (the deref law as a value-level fn — for call-result expressions, where name-deref cannot reach)',
  }));
  register(seq, 'json.decode', (input: unknown) => {
    const { s } = (input ?? {}) as { s?: string };
    if (typeof s !== 'string' || !s.trim()) return undefined;
    try { return JSON.parse(s); } catch { return undefined; }
  }, FT.fn({
    input: FT.object({ 's?': FT.string() }),
    output: FT.any(),
    description: 'JSON.parse(s); absent/invalid → absent (json.encode\'s tolerant inverse)',
  }));
  register(seq, 'num.add', (input: unknown) => {
    const { a, b } = (input ?? {}) as { a?: number; b?: number };
    return Number(a ?? 0) + Number(b ?? 0);
  }, FT.fn({
    input: FT.object({ 'a?': FT.number(), 'b?': FT.number() }),
    output: FT.number(),
    description: 'a + b (absent = 0)',
  }));
  register(seq, 'num.max', (input: unknown) => {
    const { a, b } = (input ?? {}) as { a?: number; b?: number };
    if (a === undefined || a === null) return b as number;
    if (b === undefined || b === null) return a;
    return Math.max(Number(a), Number(b));
  }, FT.fn({
    input: FT.object({ 'a?': FT.number(), 'b?': FT.number() }),
    output: FT.number(),
    description: 'max(a, b); an absent side yields the other',
  }));
  register(seq, 'list.find', (input: unknown) => {
    const { items, attr, value } = (input ?? {}) as {
      items?: unknown[]; attr?: string; value?: unknown;
    };
    if (!Array.isArray(items) || attr === undefined) return undefined;
    return items.find((it) => walkAttr(it, attr) === value);
  }, FT.fn({
    input: FT.object({ 'items?': FT.array(FT.any()), 'attr?': FT.string(), 'value?': FT.any() }),
    output: FT.any(),
    description: 'the first item whose [attr] equals value (attr may be a dotted path), else absent — list.some\'s extracting sibling',
  }));
  register(seq, 'json.decode', (input: unknown) => {
    const { s, fallback } = (input ?? {}) as { s?: unknown; fallback?: unknown };
    if (typeof s !== 'string' || !s.trim()) return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
  }, FT.fn({
    input: FT.object({ 's?': FT.any(), 'fallback?': FT.any() }),
    output: FT.any(),
    description: 'JSON.parse(s); absent/invalid input returns `fallback` — the tolerant read of a JSON-encoded field',
  }));
  register(seq, 'str.split', (input: unknown) => {
    const { s, sep } = (input ?? {}) as { s?: unknown; sep?: unknown };
    return String(s ?? '').split(String(sep ?? ''));
  }, FT.fn({
    input: FT.object({ s: FT.string(), sep: FT.string() }),
    output: FT.array(FT.string()),
    description: 'String.split — s cut on sep',
  }));
  register(seq, 'list.uniq', (input: unknown) => {
    const { items } = (input ?? {}) as { items?: unknown[] };
    return Array.isArray(items) ? [...new Set(items)] : [];
  }, FT.fn({
    input: FT.object({ 'items?': FT.array(FT.any()) }),
    output: FT.array(FT.any()),
    description: 'distinct items, order kept (identity comparison — meant for scalars/keys)',
  }));
  register(seq, 'list.compact', (input: unknown) => {
    const { items } = (input ?? {}) as { items?: unknown[] };
    return (Array.isArray(items) ? items : []).filter(
      (v) => v !== null && v !== undefined && v !== '',
    );
  }, FT.fn({
    input: FT.object({ 'items?': FT.array(FT.any()) }),
    output: FT.array(FT.any()),
    description: 'drop null/undefined/"" — collect-and-continue loops return "" for success and a message for failure, then compact',
  }));
  register(seq, 'list.concat', (input: unknown) => {
    const { lists } = (input ?? {}) as { lists?: unknown[][] };
    return (Array.isArray(lists) ? lists : []).flatMap((l) => (Array.isArray(l) ? l : []));
  }, FT.fn({
    input: FT.object({ lists: FT.array(FT.array(FT.any())) }),
    output: FT.array(FT.any()),
    description: 'concatenate lists in order (non-lists contribute nothing)',
  }));
  register(seq, 'list.diff', (input: unknown) => {
    const { a, b, on } = (input ?? {}) as { a?: unknown[]; b?: unknown[]; on?: string[] };
    const keys = Array.isArray(on) ? on : null;
    const keyOf = (it: unknown) =>
      keys ? keys.map((k) => String(walkAttr(it, k))).join('\u0000') : String(it);
    const present = new Set((Array.isArray(b) ? b : []).map(keyOf));
    return (Array.isArray(a) ? a : []).filter((it) => !present.has(keyOf(it)));
  }, FT.fn({
    input: FT.object({ 'a?': FT.array(FT.any()), 'b?': FT.array(FT.any()), on: FT.array(FT.string()) }),
    output: FT.array(FT.any()),
    description: 'items of a not present in b — by `on`-key tuple when given (SQL EXCEPT), by scalar identity without',
  }));
  register(seq, 'list.max', (input: unknown) => {
    const { items, attr } = (input ?? {}) as { items?: unknown[]; attr?: string };
    let max: number | undefined;
    for (const it of Array.isArray(items) ? items : []) {
      const v = attr === undefined ? it : walkAttr(it, attr);
      if (typeof v === 'number' && Number.isFinite(v) && (max === undefined || v > max)) max = v;
    }
    return max;
  }, FT.fn({
    input: FT.object({ 'items?': FT.array(FT.any()), 'attr?': FT.string() }),
    output: FT.number(),
    description: 'the largest finite number at [attr] (dotted ok; no attr: the items themselves); absent when none — pair with or() for a default',
  }));
  register(seq, 'list.pluck', (input: unknown) => {
    const { items, attr } = (input ?? {}) as { items?: unknown[]; attr?: string };
    if (typeof attr !== 'string' || attr === '') throw new Error('list.pluck: attr is required');
    return (Array.isArray(items) ? items : []).map((it) => walkAttr(it, attr));
  }, FT.fn({
    input: FT.object({ 'items?': FT.array(FT.any()), attr: FT.string() }),
    output: FT.array(FT.any()),
    description: 'each item\'s value at [attr] (dotted ok) — how a caller reads the `r` binds out of list.each over a definition (a nested definition returns its full locals)',
  }));
  register(seq, 'obj.keys', (input: unknown) => {
    const { v } = (input ?? {}) as { v?: unknown };
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
  }, FT.fn({
    input: FT.object({ 'v?': FT.any() }),
    output: FT.array(FT.string()),
    description: 'Object.keys(v) — [] for anything that is not a plain object',
  }));
  register(seq, 'obj.merge', (input: unknown) => {
    const { base, patch } = (input ?? {}) as { base?: unknown; patch?: unknown };
    const isObj = (v: unknown): v is Record<string, unknown> =>
      v !== null && typeof v === 'object' && !Array.isArray(v);
    const merge = (b: Record<string, unknown>, o: Record<string, unknown>): Record<string, unknown> => {
      const out = { ...b };
      for (const [k, v] of Object.entries(o)) {
        const cur = out[k];
        out[k] = isObj(v) && isObj(cur) ? merge(cur, v) : v;
      }
      return out;
    };
    if (!isObj(base)) return isObj(patch) ? patch : {};
    if (!isObj(patch)) return base;
    return merge(base, patch);
  }, FT.fn({
    input: FT.object({ 'base?': FT.object(), 'patch?': FT.object() }),
    output: FT.object(),
    description: 'deep merge: patch wins per key; nested plain objects merge recursively; arrays/scalars replace — the merge-patch read of a partial update',
  }));
  register(seq, 'is.object', (input: unknown) => {
    const { v } = (input ?? {}) as { v?: unknown };
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }, FT.fn({
    input: FT.object({ 'v?': FT.any() }),
    output: FT.boolean(),
    description: 'is v a plain object (not null, not an array)',
  }));
  register(seq, 'str.join', (input: unknown) => {
    const { items, sep } = (input ?? {}) as { items?: unknown[]; sep?: unknown };
    return (Array.isArray(items) ? items : []).map(String).join(String(sep ?? ''));
  }, FT.fn({
    input: FT.object({ 'items?': FT.array(FT.any()), sep: FT.string() }),
    output: FT.string(),
    description: 'items joined by sep — str.split\'s inverse',
  }));
  register(seq, 'list.length', (input: unknown) => {
    const { items } = (input ?? {}) as { items?: unknown[] };
    return Array.isArray(items) ? items.length : 0;
  }, FT.fn({
    input: FT.object({ 'items?': FT.array(FT.any()) }),
    output: FT.number(),
    description: 'items.length (0 for non-lists)',
  }));
  register(seq, 'obj.fromPairs', (input: unknown) => {
    const { pairs } = (input ?? {}) as { pairs?: Array<{ key?: unknown; value?: unknown }> };
    const out: Record<string, unknown> = {};
    for (const p of Array.isArray(pairs) ? pairs : []) {
      if (p && typeof p === 'object' && typeof (p as { key?: unknown }).key === 'string') {
        out[(p as { key: string }).key] = (p as { value?: unknown }).value;
      }
    }
    return out;
  }, FT.fn({
    input: FT.object({ pairs: FT.array(FT.object()) }),
    output: FT.object(),
    description: 'build an object from {key, value} pairs — the dynamic-key construction the literal syntax cannot express',
  }));
  register(seq, 'assert', (input: unknown) => {
    const { cond, message } = (input ?? {}) as { cond?: unknown; message?: string };
    if (!cond) throw new Error(message ?? 'assert failed');
    return true;
  }, FT.fn({
    input: FT.object({ 'cond?': FT.any(), 'message?': FT.string() }),
    output: FT.boolean(),
    description: 'throw the message when cond is falsy — the typed-error path a definition raises deliberately',
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
  if (opts.realFs) { registerFsNode(seq); registerFsSnapshot(seq); }
  if (opts.proc) registerProc(seq);
}

// ─── Endpoint-qualified tools — the type IS the connector ───────────────
//
// endpoint()/auth() (src/type.ts) declare a concrete tool instance:
// address + HTTP shape + credential path. Until 2026-07-19 they were
// stored but never executed — the header comment above PROMISED
// "endpoints compose by type narrowing, never new impls" while every
// consumer hand-rolled its own template-fill compiler around http.fetch
// (the office connector build carried ~200 lines of exactly that). This
// is the ONE generic executor: install an fn type carrying
// endpoint(url, {method?, headers?, body?}) and the impl derives FROM
// the type. No per-tool compile step; no second params vocabulary.
//
// The fill contract (proven live by the office build it replaces):
// - `{{arg.x}}` in url/headers: URI-encoded fill from call args.
// - `{{arg.x}}` in a body template: JSON-encoded fill (string quoted,
//   number raw, object serialized, missing → null) so the template
//   stays valid JSON.
// - `{{secret}}` fills from the resolved credential in url/headers
//   ONLY — never bodies (bodies are the widest leak surface).
// - auth(identityPath) resolves through the OPTIONAL `auth.resolve`
//   impl ({ path } → string | undefined). No resolver or no value =
//   the provider's unauthenticated tier: a header template that
//   references {{secret}} is OMITTED entirely (a malformed "Bearer "
//   401s — caught live 2026-07-17).
// - Required params are read off the fn type's param constraint: the
//   type is the validator.
// - non-2xx throws `path: METHOD → status`; a JSON body parses, any
//   other body returns { body }.

function fillUri(template: string, args: Record<string, unknown>, secret: string | undefined): string {
  return template
    .replace(/\{\{arg\.(\w+)\}\}/g, (_, k: string) => encodeURIComponent(String(args[k] ?? '')))
    .replace(/\{\{secret\}\}/g, secret ?? '');
}

function fillBody(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{\{arg\.(\w+)\}\}/g, (_, k: string) => JSON.stringify(args[k] ?? null));
}

/** Install one endpoint-qualified fn: insert the type, derive the impl.
 *  Throws at install on a missing endpoint or a non-http(s) scheme
 *  (mcp:// etc. are future transports — refusing now beats a dead
 *  mount). Wrap `seq.impls.get(path)` afterwards for metering/ledgers —
 *  observation is the host's concern, not the transport's. */
export function installEndpointTool(seq: Sequence, path: string, type: Type): void {
  const ep = type.constraints.find((c) => c.op === 'endpoint');
  if (!ep) throw new Error(`installEndpointTool: ${path} carries no endpoint constraint`);
  const urlTemplate = ep.args[0] as string;
  if (!/^https?:\/\//.test(urlTemplate)) {
    throw new Error(`installEndpointTool: ${path} endpoint scheme unsupported (http/https only): ${urlTemplate}`);
  }
  const opts = (ep.args[1] ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
  const identityPath = type.constraints.find((c) => c.op === 'auth')?.args[0] as string | undefined;
  // Required params, read off the fn type's own param constraint.
  const inputType = type.constraints.find((c) => c.op === 'param')?.args[0] as Type | undefined;
  const required: string[] = [];
  for (const c of inputType?.constraints ?? []) {
    if (c.op === 'property' && !c.args[2]) required.push(c.args[0] as string);
  }

  seq.insert({ path, type: type as never });
  seq.impls.set(path, async (argsIn: unknown) => {
    const args = (argsIn ?? {}) as Record<string, unknown>;
    for (const k of required) {
      if (args[k] === undefined) throw new Error(`${path}: param '${k}' is required`);
    }
    let secret: string | undefined;
    if (identityPath) {
      const resolve = seq.impls.get('auth.resolve');
      if (resolve) secret = (await resolve({ path: identityPath })) as string | undefined;
    }
    const fetchImpl = seq.impls.get('http.fetch');
    if (!fetchImpl) throw new Error(`${path}: http.fetch transport is not mounted`);
    const headers: Record<string, string> = {};
    for (const [h, v] of Object.entries(opts.headers ?? {})) {
      if (v.includes('{{secret}}') && !secret) continue;
      const filled = fillUri(v, args, secret);
      if (filled.trim()) headers[h] = filled;
    }
    const method = opts.method ?? 'GET';
    const res = (await fetchImpl({
      url: fillUri(urlTemplate, args, secret),
      method,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(opts.body ? { body: fillBody(opts.body, args) } : {}),
    })) as { status: number; body: string };
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${path}: ${method} → ${res.status}`);
    }
    try {
      return JSON.parse(res.body);
    } catch {
      return { body: res.body };
    }
  });
}
