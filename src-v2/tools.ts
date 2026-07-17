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

/** Register the whole base toolset. `storage` optional — without it the
 *  fs.* family is simply absent from the environment (an honest hole,
 *  not a stub). */
export function registerBaseTools(seq: Sequence, opts: { storage?: ToolStorage } = {}): void {
  registerHttp(seq);
  registerSchedule(seq);
  if (opts.storage) registerFs(seq, opts.storage);
}
