/**
 * vend.ts (v2) — tool compilation for clients, as the TOOLS-WEIGHTED
 * DEGENERATE CASE of the one frame call.
 *
 * THE ELECTED FRAME, stage 1: vend's bespoke selection walk and its
 * greedy doc-election are DELETED. What remains here is the vending
 * REQUEST SHAPE (query/maxTools/maxTokens/ttl) mapped onto
 * `electFrame` (elect-frame.ts) over the declared `tools` concern:
 *
 *   · case:      `_concerns.tools.*` — structural walk from the root,
 *                fn-typed cells, `_` scopes excluded (declared once,
 *                lazily; the walk engine is case.ts, shared).
 *   · election:  uniform value (base 1, all context weights 0 — the
 *                "tools-weighted" posture), `items` capacity when
 *                maxTools is set → `selectUnderPrices` admits the
 *                path-ordered head, exactly the old slice, with the
 *                dual price of a tool slot now spoken in the frame.
 *   · commitment: the document assembly, session record, endpoints,
 *                chain reports — vend's own machinery, MOVED to
 *                elect-frame.ts (reused, not forked).
 *
 * Everything vend promised still holds and is still enforced by the
 * V1–V19 suite: every load-bearing fact a receivable statement (the
 * strip guard), annotation honesty (no posterior → no annotation),
 * omissions spoken, expiry at the offering, temporal meet, chain
 * provenance. The session machinery (continueSession/expand) and the
 * frame grammar helpers are re-exported from elect-frame.ts so every
 * existing consumer keeps its import path.
 */

import { Sequence } from './sequence';
import {
  type Type, constraintOf, isNever,
} from '../src/type';
import { compose as composeTypes, conjugateUpdate, check } from '../src/compose';
import { renderTypeFt } from '../src/hoist';
import { timeHorizon } from './validity';
import { receiveDocument } from './receive-doc';
import { receiveCall } from './receive-calls';
import { declareConcern } from './case';
import { electFrame, sessionExpiry, quote } from './elect-frame';

export {
  electLabel, continueSession, expand,
  type ContinueResult, type ExpandResult,
} from './elect-frame';

export type VendRequest = {
  /** Session id; omitted → derived from the kernel clock + counter. */
  session?: string;
  /** Case-insensitive match over tool path + description text. */
  query?: string;
  maxTools?: number;
  /** Approximate token budget for the emitted document (chars/4). */
  maxTokens?: number;
  /** Session validity in ms (default 1 hour). */
  ttlMs?: number;
};

export type VendResult = {
  sessionId: string;
  /** The ft definition-set document — every load-bearing fact a statement. */
  text: string;
  tools: string[];
  omitted: string[];
  expandTokens: string[];
  expiresAt: number;
  /** Chain-provenance reports (beat 12): when a RECEIVED grant is
   *  re-vended, one report per upstream session, addressed to it as ft
   *  for its continue endpoint. The kernel cannot transport; the host
   *  delivers these — same contract as continue itself. */
  chainReports: Array<{ session: string; ft: string }>;
};

/** The degenerate walk spec behind vend: declared once per kernel,
 *  lazily, as facts like any other concern — never pre-filled if an
 *  owner already authored it (facts narrow, don't overwrite). */
export const TOOLS_CONCERN = 'tools';

function ensureToolsConcern(seq: Sequence): void {
  if (seq.getCell(`_concerns.${TOOLS_CONCERN}.roots`)?.value !== undefined) return;
  declareConcern(seq, TOOLS_CONCERN, {
    roots: [''],
    axes: ['structural'],
    typeKind: 'fn',
    value: { base: 1, access: 0, preference: 0, temporal: 0 },
  });
}

/** Render the kernel's tool surface as an ft document for a client,
 *  under constraints, and open a session for continuance — the
 *  tools-weighted degenerate election. */
export function vend(seq: Sequence, req: VendRequest = {}): VendResult {
  ensureToolsConcern(seq);
  const r = electFrame(seq, {
    concern: TOOLS_CONCERN,
    session: req.session,
    query: req.query,
    capacities: req.maxTools !== undefined ? { items: req.maxTools } : {},
    maxTokens: req.maxTokens,
    ttlMs: req.ttlMs,
  });
  return {
    sessionId: r.sessionId,
    text: r.text,
    tools: r.tools,
    omitted: r.omitted,
    expandTokens: r.expandTokens,
    expiresAt: r.expiresAt,
    chainReports: r.chainReports,
  };
}

export type RevendResult =
  | ({ ok: true } & Pick<VendResult, 'text' | 'tools' | 'omitted' | 'expandTokens' | 'expiresAt' | 'chainReports'>)
  | { ok: false; reason: 'unknown-session' | 'expired' };

/** Re-compile WITHIN a session: new query/budget, same session id, same
 *  contract — expiry unchanged. The frame snapshot moves to the new
 *  surface (a narrower or refreshed vend under the original clock). */
export function revend(
  seq: Sequence,
  sessionId: string,
  req: Omit<VendRequest, 'session' | 'ttlMs'> = {},
): RevendResult {
  const expiresAt = sessionExpiry(seq, sessionId);
  if (expiresAt === undefined) return { ok: false, reason: 'unknown-session' };
  if (seq.now() > expiresAt) return { ok: false, reason: 'expired' };
  const r = vend(seq, { ...req, session: sessionId, ttlMs: expiresAt - seq.now() });
  return {
    ok: true,
    text: r.text, tools: r.tools, omitted: r.omitted,
    expandTokens: r.expandTokens, expiresAt, chainReports: r.chainReports,
  };
}

// ─── frame merge (beat 11): compose over two vended documents ─────────

export type MergeFramesResult = {
  /** The merged frame — same receivable grammar as a vended frame,
   *  minus sessions (a merged frame is a VIEW; its sessions remain the
   *  originals'). */
  text: string;
  tools: string[];
  /** Named conflicts — a genuine contradiction is never silently
   *  overwritten; it is excluded from the surface and NAMED here. */
  conflicts: string[];
};

type FrameFacts = {
  type: Type;
  description?: string;
  reliability?: { alpha: number; beta: number };
  latency?: { shape: number; rate: number };
  validUntil?: number;
};

/**
 * Merge N vended frames into one surface. The rules, in lattice terms:
 *
 *   · same tool from two sources → shared compose(): tightest
 *     consistent type; a contradictory pair is a NAMED conflict, never
 *     a silent overwrite (the kernel's own insert would absorb — this
 *     is why the merge composes explicitly).
 *   · validity → temporal meet: min across stated `_validUntil` facts
 *     and every time bound already on the composed type.
 *   · observed posteriors (reliability beta, latency gamma) → the
 *     MORE-EVIDENCED posterior supersedes (max total evidence). Two
 *     frames from one office share observation history, so summing
 *     would double-count; true compounding of INDEPENDENT observers
 *     needs observer identity (chain provenance) and is beat-12 work.
 *   · descriptions and prelude binds must agree; a difference is a
 *     named conflict.
 *
 * A planner prices the merged surface from the types and facts alone —
 * same standing guard as vend: nothing load-bearing in comments.
 */
export async function mergeFrames(docs: string[]): Promise<MergeFramesResult> {
  const conflicts: string[] = [];
  const tools = new Map<string, FrameFacts>();
  const preludes = new Map<string, string>();

  for (const doc of docs) {
    // Each doc parses into its own scratch kernel so cross-doc
    // composition stays explicit (see rule 1).
    const rx = new Sequence(() => 0);
    const rr = await receiveDocument(rx, doc);
    if (rr.errors.length > 0) {
      conflicts.push(...rr.errors.map((e) => `unreceivable: ${e}`));
      continue;
    }
    // Prelude binds: top-level non-underscore string values that are
    // not tool siblings.
    const walkValues = (prefix: string): void => {
      for (const key of rx.keys(prefix || undefined)) {
        if (key.startsWith('_')) continue;
        const path = prefix ? `${prefix}.${key}` : key;
        if (rx.rawTypeAt(path)?.kind === 'fn') continue;
        const v = rx.get(path);
        if (typeof v === 'string' && !path.includes('._')) {
          const prev = preludes.get(path);
          if (prev !== undefined && prev !== v) {
            conflicts.push(`${path}: prelude texts differ between frames`);
          } else {
            preludes.set(path, v);
          }
        }
        walkValues(path);
      }
    };
    walkValues('');

    for (const path of rr.tools.filter((t) => !t.startsWith('_'))) {
      const type = rx.rawTypeAt(path);
      if (type?.kind !== 'fn') continue;
      const facts: FrameFacts = {
        type,
        description: rx.get(`${path}._description`) as string | undefined,
        reliability: rx.get(`${path}._reliability`) as FrameFacts['reliability'],
        latency: rx.get(`${path}._latency`) as FrameFacts['latency'],
        validUntil: rx.get(`${path}._validUntil`) as number | undefined,
      };
      const prior = tools.get(path);
      if (!prior) {
        tools.set(path, facts);
        continue;
      }
      // Rule 1: explicit compose, conflicts named.
      const composed = composeTypes(prior.type, facts.type);
      if (isNever(composed)) {
        conflicts.push(`${path}: contradictory definitions → never`);
        tools.delete(path);
        continue;
      }
      prior.type = composed;
      // Rule 2: temporal meet on the stated facts.
      if (facts.validUntil !== undefined) {
        prior.validUntil = prior.validUntil === undefined
          ? facts.validUntil
          : Math.min(prior.validUntil, facts.validUntil);
      }
      // Rule 3: more-evidenced posterior supersedes.
      if (facts.reliability) {
        const ev = (r?: { alpha: number; beta: number }): number => (r ? r.alpha + r.beta : -1);
        if (ev(facts.reliability) > ev(prior.reliability)) prior.reliability = facts.reliability;
      }
      if (facts.latency) {
        const ev = (l?: { shape: number }): number => l?.shape ?? -1;
        if (ev(facts.latency) > ev(prior.latency)) prior.latency = facts.latency;
      }
      // Rule 4: descriptions agree or conflict.
      if (facts.description !== undefined && prior.description !== undefined
          && facts.description !== prior.description) {
        conflicts.push(`${path}._description: texts differ between frames`);
      } else if (facts.description !== undefined) {
        prior.description = facts.description;
      }
    }
  }

  // ── emission: the same receivable grammar as vend ─────────────────
  const lines: string[] = [];
  lines.push(`-- merged frame · ${docs.length} sources · comments are courtesy; every load-bearing fact below is a statement`);
  lines.push('');
  for (const [path, text] of [...preludes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${path} = ${quote(text)}`);
  }
  if (preludes.size > 0) lines.push('');

  const emittedTools: string[] = [];
  for (const [path, f] of [...tools.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const paramT = constraintOf(f.type, 'param')?.args[0] as Type | undefined;
    const returnsT = constraintOf(f.type, 'returns')?.args[0] as Type | undefined;
    const params = paramT
      ? renderTypeFt(paramT).replace(/\s+/g, ' ').replace(/^\{\s*/, '(').replace(/\s*\}$/, ')')
      : '()';
    const returns = returnsT ? renderTypeFt(returnsT).replace(/\s+/g, ' ') : '{ ok: true }';
    const suffix = f.latency
      ? ` ~survival(exp, ${Number((f.latency.shape / f.latency.rate).toPrecision(3))})`
      : '';
    lines.push(`${path} = ${params} -> ${returns}${suffix}`);
    if (f.description !== undefined) lines.push(`${path}._description = ${quote(f.description)}`);
    if (f.reliability) {
      lines.push(`${path}._reliability = { alpha: ${f.reliability.alpha}, beta: ${f.reliability.beta} }`);
    }
    if (f.latency) {
      lines.push(`${path}._latency = { shape: ${f.latency.shape}, rate: ${f.latency.rate} }`);
    }
    // Temporal meet folds the stated facts AND the composed type's own
    // time bounds (same law as vend's re-vend clamp).
    const horizons = (f.type.constraints ?? [])
      .map((c) => timeHorizon(c))
      .filter((h): h is number => h !== null);
    const bounds = [...horizons, ...(f.validUntil !== undefined ? [f.validUntil] : [])];
    if (bounds.length > 0) lines.push(`${path}._validUntil = ${Math.min(...bounds)}`);
    lines.push('');
    emittedTools.push(path);
  }
  for (const c of conflicts) lines.push(`-- conflict: ${c}`);

  return { text: lines.join('\n'), tools: emittedTools, conflicts };
}

/** THE LEARNING LOOP'S KERNEL HALF (V15/beat 9): observe one tool
 *  call — real measured duration → gamma-exponential conjugate update;
 *  success/failure → beta update — at the `_prior.*` convention the
 *  next vend reads. Exported so hosts instrumenting their own impls
 *  use the same arithmetic; an impl that self-observes marks itself
 *  with `observes = true` and the session path stands down (one real
 *  observation must never count twice). */
export function observeToolCall(seq: Sequence, path: string, dtMs: number, ok: boolean): void {
  const relPath = `${path}._prior.reliability`;
  const rel = (seq.get(relPath) as { alpha?: number; beta?: number } | undefined) ?? { alpha: 1, beta: 1 };
  seq.insert({ path: relPath, value: conjugateUpdate('beta', rel, ok ? 'success' : 'failure') });

  const latPath = `${path}._prior.latency`;
  const prev = seq.get(latPath) as
    { gamma?: { shape?: number; rate?: number }; samples?: number } | undefined;
  // Declared conjugate prior: gamma(shape=1, rate=1ms) — one pseudo-
  // observation of 1ms; posterior mean = shape/rate per ms.
  const g = conjugateUpdate('gamma', prev?.gamma ?? { shape: 1, rate: 1 }, Math.max(dtMs, 1e-6));
  const rate = (g.shape ?? 1) / (g.rate ?? 1);
  seq.insert({
    path: latPath,
    value: {
      family: 'exponential',
      rate: Number(rate.toPrecision(3)),
      gamma: g,
      samples: (prev?.samples ?? 0) + 1,
    },
  });
}

/** Programmatic single-call convenience against a session frame: expiry
 *  + stale-frame checked, then the shared receiveCall path — and the
 *  call is OBSERVED (posterior update, V15) unless the impl declares it
 *  self-observes. */
export async function callThroughSession(
  seq: Sequence,
  sessionId: string,
  fn: string,
  args?: unknown,
  bindPath?: string,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const expiresAt = sessionExpiry(seq, sessionId);
  if (expiresAt === undefined) return { ok: false, reason: 'unknown-session' };
  if (seq.now() > expiresAt) return { ok: false, reason: 'expired' };
  const frame = seq.get(`_sessions.${sessionId}.frame`) as { tools?: string[] } | undefined;
  if (frame?.tools && !frame.tools.includes(fn) && !fn.startsWith('_sessions.')) {
    return { ok: false, reason: 'not-in-frame' };
  }
  const fnType = seq.rawTypeAt(fn);
  if (fnType?.kind !== 'fn') return { ok: false, reason: 'stale-frame' };
  // Refinements ENFORCE at the call (V14): args are validated against
  // the param type — pattern/min/max/literal-union — with the shared
  // check(), before the impl runs and before any observation (a
  // caller's type error is not the endpoint's unreliability).
  const paramT = constraintOf(fnType, 'param')?.args[0] as Type | undefined;
  if (paramT) {
    const c = check(paramT, args ?? {});
    if (!c.ok) {
      const gap = (c as { gaps?: Array<{ path?: string; reason?: string }> }).gaps?.[0];
      return { ok: false, reason: `invalid-args: ${gap?.path ?? ''} ${gap?.reason ?? 'type mismatch'}`.trim() };
    }
  }
  const selfObserving = (seq.impls.get(fn) as { observes?: boolean } | undefined)?.observes === true;
  const t0 = performance.now();
  let ok = false;
  try {
    const out = await receiveCall(seq, fn, args, bindPath);
    ok = true;
    return { ok: true, value: out.value };
  } catch (e) {
    return { ok: false, reason: `call-failed: ${(e as Error).message}` };
  } finally {
    if (!selfObserving) observeToolCall(seq, fn, performance.now() - t0, ok);
  }
}
