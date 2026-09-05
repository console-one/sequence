/**
 * elect-frame.ts (v2) — ELECTION + COMMITMENT: the one frame call.
 *
 * THE ELECTED FRAME, stage 1. The pipeline in four pre-existing
 * substrate words: cells → case → election → commitment.
 *
 *   · CASE lives in case.ts: a declared walk spec poses the question;
 *     the yield is cells with assigned meaning (traversal context).
 *   · ELECTION is the ONE judgment: `selectUnderPrices` over the yield
 *     under declared capacities. value(cell) = one expression over the
 *     collected context — access posterior ⊕ declared preference
 *     weights ⊕ temporal proximity — weighted by the CONCERN's declared
 *     posture, never a switch on kind. cost(cell) = tokens of its
 *     receivable rendering + costs its cell already carries (observed
 *     latency posterior → expected ms). Omissions are spoken; the DUAL
 *     PRICES come back INTO the frame — the frame carries its own
 *     attention prices, as session facts a receiver can query.
 *   · COMMITMENT: emitting the frame is a BINDING ACT, not output. The
 *     session record mounts, validity attaches, continue/expand become
 *     owed endpoints, chain reports become obligations — text and
 *     `_sessions.*` facts are ONE act, statement AND accountability.
 *     The round-trip/strip-guard law is the commitment's integrity
 *     condition: you may not commit to other than what was elected,
 *     and what you committed must be holdable against you.
 *
 * The document assembly and session machinery here are vend's,
 * MOVED (not forked): vend() is now the tools-weighted degenerate
 * case of electFrame — see vend.ts. Everything that held for vended
 * frames still holds here:
 *
 *   · every load-bearing fact is a receivable statement; `--` lines
 *     carry courtesy narration only (the strip guard).
 *   · annotation honesty: reliability/latency emit ONLY from observed
 *     posteriors at `<path>._prior.*`. This module never authors a
 *     number.
 *   · budget overflow is spoken, never a silent cut: fn definitions
 *     fall back to receivable stubs behind type-expansion tokens;
 *     everything else that misses the window is named in `[[more :]]`.
 *
 * Non-fn cells commit as fact binds (`path = value`), and a cell whose
 * type carries a FUTURE time bound also states it (`path._validUntil`)
 * — a claim. Wakes, commitments and expiries are already cells with
 * future bounds, so "predictions" appear in frames for free; there is
 * no prediction generator (the lumping correction).
 */

import { Sequence } from './sequence';
import { type Type, constraintOf } from '../src/type';
import { conjugateUpdate } from '../src/compose';
import { renderTypeFt } from '../src/hoist';
import { timeHorizon } from './validity';
import { receiveDocument } from './receive-doc';
import { selectUnderPrices, type SelectCandidate, type SelectCapacities } from './select';
import { caseWalk, readConcern, type CaseYield, type ConcernSpec } from './case';

// ─── shared frame-grammar helpers (moved from vend.ts) ───────────────

export const approxTokens = (s: string): number => Math.ceil(s.length / 4);

/** Render a fn type's signature halves in the receivable form. */
export function fnSignature(type: Type): { params: string; returns: string } {
  const paramT = constraintOf(type, 'param')?.args[0] as Type | undefined;
  const returnsT = constraintOf(type, 'returns')?.args[0] as Type | undefined;
  const params = paramT
    ? renderTypeFt(paramT).replace(/\s+/g, ' ').replace(/^\{\s*/, '(').replace(/\s*\}$/, ')')
    : '()';
  const returns = returnsT ? renderTypeFt(returnsT).replace(/\s+/g, ' ') : '{ ok: true }';
  return { params, returns };
}

/** Collapse whitespace for single-line string binds (elected narrative
 *  variants are prose; the emitted bind must stay one statement). */
export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

export const quote = (s: string): string => JSON.stringify(oneLine(s));

/** Label references inside description text: `[[dotted.path]]` with no
 *  spaces or colon — distinct from expansion tokens (`[[doc:… : …]]`)
 *  and the omission token (`[[more : …]]`). */
const LABEL_REF = /\[\[([A-Za-z_][A-Za-z0-9_.]*)\]\]/g;

function labelRefsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LABEL_REF)) out.push(m[1]);
  return out;
}

/** Resolve a label to text. Direct string cell → that text. Cell with
 *  string-valued children → a VARIANT GROUP: elect the largest variant
 *  fitting `budgetTokens`, else the smallest. Null when nothing there. */
export function electLabel(
  seq: Sequence,
  label: string,
  budgetTokens: number,
): { text: string; variant: string | null } | null {
  const direct = seq.get(label);
  if (typeof direct === 'string') return { text: direct, variant: null };
  const variants: Array<{ key: string; text: string }> = [];
  for (const key of seq.keys(label)) {
    const v = seq.get(`${label}.${key}`);
    if (typeof v === 'string') variants.push({ key, text: v });
  }
  if (variants.length === 0) return null;
  variants.sort((a, b) => b.text.length - a.text.length); // largest first
  const fitting = variants.find((v) => approxTokens(v.text) <= budgetTokens);
  const chosen = fitting ?? variants[variants.length - 1];
  return { text: chosen.text, variant: chosen.key };
}

type PriorLatency = { family?: string; rate?: number; mu?: number; sigma?: number };
type PriorReliability = { alpha?: number; beta?: number };

/** The latency suffix for a definition line — ONLY from an observed
 *  posterior mounted at `<path>._prior.latency`. Absent → ''. */
export function latencySuffix(seq: Sequence, path: string): string {
  const p = seq.get(`${path}._prior.latency`) as PriorLatency | undefined;
  if (!p || typeof p !== 'object') return '';
  if ((p.family === 'exponential' || p.family === 'exp') && typeof p.rate === 'number') {
    return ` ~survival(exp, ${p.rate})`;
  }
  if (p.family === 'lognormal' && typeof p.mu === 'number' && typeof p.sigma === 'number') {
    return ` ~lognormal(mu=${p.mu}, sigma=${p.sigma})`;
  }
  return '';
}

// ─── the receivable rendering of ONE cell ────────────────────────────

/** A tool definition block: signature line (with observed latency
 *  suffix) + sibling-fact binds. Pure — chain upstreams are RETURNED,
 *  registered by the caller only for blocks that actually commit. */
function renderToolBlock(
  seq: Sequence,
  path: string,
  type: Type,
  sessionId: string,
  expiresAt: number,
): { text: string; upstream: string[] } {
  const { params, returns } = fnSignature(type);
  const block: string[] = [`${path} = ${params} -> ${returns}${latencySuffix(seq, path)}`];
  const desc = seq.get(`${path}._description`);
  if (typeof desc === 'string') block.push(`${path}._description = ${quote(desc)}`);
  const rel = seq.get(`${path}._prior.reliability`) as PriorReliability | undefined;
  if (rel && typeof rel.alpha === 'number' && typeof rel.beta === 'number') {
    block.push(`${path}._reliability = { alpha: ${rel.alpha}, beta: ${rel.beta} }`);
  }
  // The latency SUFFICIENT STATISTICS ride alongside the ~survival
  // display form: a merge or planner needs the evidence (gamma shape/
  // rate), not just the point rate.
  const latPrior = seq.get(`${path}._prior.latency`) as
    { gamma?: { shape?: number; rate?: number } } | undefined;
  if (typeof latPrior?.gamma?.shape === 'number' && typeof latPrior?.gamma?.rate === 'number') {
    block.push(`${path}._latency = { shape: ${latPrior.gamma.shape}, rate: ${latPrior.gamma.rate} }`);
  }
  // TEMPORAL MEET: a tool whose type already carries a time bound (a
  // received grant being re-vended) can never be granted PAST that
  // bound — validity only tightens through the chain (beat 12).
  const horizons = (type.constraints ?? [])
    .map((c) => timeHorizon(c))
    .filter((h): h is number => h !== null);
  block.push(`${path}._validUntil = ${Math.min(expiresAt, ...horizons)}`);
  // CHAIN PROVENANCE (beat 12): a received grant being re-vended
  // extends its origin chain and owes each upstream session a report.
  const upstream: string[] = [];
  const parentChain = seq.get(`${path}._origin.chain`);
  if (typeof parentChain === 'string' && parentChain.length > 0) {
    block.push(`${path}._origin.chain = "${parentChain} ${sessionId}"`);
    upstream.push(...parentChain.split(' '));
  }
  return { text: block.join('\n'), upstream };
}

/** A fact cell commits as a bind; a FUTURE time bound on its type is
 *  stated as the `._validUntil` sibling — the claim form. */
function renderFactLines(path: string, value: unknown, timeBound: number | null, now: number): string {
  const lines = [`${path} = ${renderFactValue(value)}`];
  if (timeBound !== null && timeBound >= now) lines.push(`${path}._validUntil = ${timeBound}`);
  return lines.join('\n');
}

/** THE fact-value grammar: render a JS value as a receivable ft
 *  literal (strings quoted one-line, objects/arrays in ft form —
 *  never JSON with quoted keys). Exported as the shared renderer for
 *  any host emitting fact binds (transport delta lines, journals). */
export function renderFactValue(v: unknown): string {
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(renderFactValue).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    return `{ ${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${renderFactValue(x)}`)
      .join(', ')} }`;
  }
  return String(v);
}

// ─── the ONE value expression ────────────────────────────────────────

/** Declared preference weight for a path: the sum of every
 *  `_preferences.<client>.weights.<prefix>` bind whose prefix covers
 *  the path (a weight on `narratives` speaks for everything under it). */
function preferenceWeight(seq: Sequence, client: string | undefined, path: string): number {
  if (!client) return 0;
  const base = `_preferences.${client}.weights`;
  let sum = 0;
  const segs = path.split('.');
  for (let i = 1; i <= segs.length; i++) {
    const w = seq.getCell(`${base}.${segs.slice(0, i).join('.')}`)?.value;
    if (typeof w === 'number' && Number.isFinite(w)) sum += w;
  }
  return sum;
}

/** Temporal proximity: 1 at now, falling linearly to 0 at the concern's
 *  horizon. A concern that wants temporal value declares its window;
 *  without one there is no scale, so proximity is 0. */
function proximity(timeBound: number | null, now: number, horizon: number | undefined): number {
  if (timeBound === null || timeBound < now) return 0;
  if (horizon === undefined || !Number.isFinite(horizon) || horizon <= 0) return 0;
  return Math.max(0, 1 - (timeBound - now) / horizon);
}

/** LEARNED relevance (stage 2): the conjugate posterior over what this
 *  client DID with cells admitted into its prior frames — expanded or
 *  called → success; admitted but ignored → failure (folded by
 *  foldSessionRelevance at the client's next election). Beta(1,1)
 *  prior → 0.5: no evidence is neutral, and an anonymous election
 *  scales every value identically. */
function relevanceMean(seq: Sequence, client: string | undefined, path: string): number {
  if (!client) return 0.5;
  const r = seq.getCell(`_relevance.${client}.${path}`)?.value as
    { alpha?: number; beta?: number } | undefined;
  const a = typeof r?.alpha === 'number' ? r.alpha : 1;
  const b = typeof r?.beta === 'number' ? r.beta : 1;
  return a / (a + b);
}

/** value(cell): ONE expression over the walk's collected context,
 *  weighted by the concern's declared posture and scaled by the
 *  client's learned relevance. Inputs are read off the cell and its
 *  meaning — never a switch on kind. */
function valueOfCell(
  seq: Sequence,
  spec: ConcernSpec,
  client: string | undefined,
  item: CaseYield,
  now: number,
): number {
  const w = spec.value;
  return relevanceMean(seq, client, item.path) * (
    w.base
    + w.access * item.posterior
    + w.preference * preferenceWeight(seq, client, item.path)
    + w.temporal * proximity(item.timeBound, now, spec.horizon)
  );
}

/**
 * THE RELEVANCE LOOP'S FOLD (stage 2; beat 9 at the attention grain).
 * The session is already the instrument: each frame records what was
 * admitted (`.admitted`) and the owed endpoints record what the client
 * touched (`.engaged.*` — written by expand/callThroughSession). At
 * the client's NEXT election, every not-yet-folded session of theirs
 * becomes evidence: engaged → success, ignored → failure, one beta
 * update per admitted cell at `_relevance.<client>.<path>`.
 * `.relevanceFolded` marks the session spent — one real observation
 * must never count twice.
 */
function foldSessionRelevance(seq: Sequence, client: string): void {
  for (const sid of seq.keys('_sessions')) {
    const base = `_sessions.${sid}`;
    if (seq.getCell(`${base}.client`)?.value !== client) continue;
    if (seq.getCell(`${base}.relevanceFolded`)?.value === true) continue;
    const admittedRaw = seq.getCell(`${base}.admitted`)?.value;
    const admittedPaths =
      typeof admittedRaw === 'string' && admittedRaw !== '' ? admittedRaw.split(' ') : [];
    const fold = (path: string, outcome: 'success' | 'failure'): void => {
      const relPath = `_relevance.${client}.${path}`;
      const prior = (seq.getCell(relPath)?.value as
        { alpha?: number; beta?: number } | undefined) ?? { alpha: 1, beta: 1 };
      seq.insert({ path: relPath, value: conjugateUpdate('beta', prior, outcome) });
    };
    for (const path of admittedPaths) {
      const engaged = seq.getCell(`${base}.engaged.${path}`)?.value === true;
      fold(path, engaged ? 'success' : 'failure');
    }
    // REDEMPTION (the omission-correction signal, 2026-07-26): an
    // engaged mark on a path the frame did NOT admit means the client
    // explicitly asked for something we hid — the strongest evidence
    // the election under-valued it. Folds as success, so a hidden cell
    // can earn its way back without exploration. (The ask itself is
    // recorded by callThroughSession even when the call is refused as
    // not-in-frame — the grant stands; the asking is evidence.)
    const admittedSet = new Set(admittedPaths);
    for (const path of engagedLeafPaths(seq, `${base}.engaged`)) {
      if (!admittedSet.has(path)) fold(path, 'success');
    }
    seq.insert({ path: `${base}.relevanceFolded`, value: true });
  }
}

/** Every dotted leaf path under `root` whose cell value is `true` —
 *  engagement marks nest (`engaged.content.put`), so enumeration is a
 *  walk, not a keys() read. A mark that is also a prefix of another
 *  mark is still its own leaf (value check per node, walk continues). */
function engagedLeafPaths(seq: Sequence, root: string): string[] {
  const out: string[] = [];
  const walk = (prefix: string): void => {
    for (const k of seq.keys(prefix)) {
      const p = `${prefix}.${k}`;
      if (seq.getCell(p)?.value === true) out.push(p.slice(root.length + 1));
      walk(p);
    }
  };
  walk(root);
  return out;
}

/** cost(cell): tokens of its receivable rendering, one item slot,
 *  — when an observed latency posterior exists — its expected ms, and
 *  any dimensions the cell DECLARES at its `._costs` sibling (e.g.
 *  `{ sec_overdue: 1 }`: with a unit capacity on that dimension, a
 *  group of alternatives admits at most one — mutual exclusion as
 *  declared data, never code). Numbers observed or declared on the
 *  cell — this module authors none. */
function costsOfItem(seq: Sequence, item: CaseYield, renderedText: string): Record<string, number> {
  const costs: Record<string, number> = {
    tokens: approxTokens(renderedText + '\n'),
    items: 1,
  };
  const lat = seq.getCell(`${item.path}._prior.latency`)?.value as PriorLatency | undefined;
  if (lat && (lat.family === 'exponential' || lat.family === 'exp')
      && typeof lat.rate === 'number' && lat.rate > 0) {
    costs.timeMs = 1 / lat.rate;
  }
  const declared = seq.getCell(`${item.path}._costs`)?.value;
  if (declared !== null && typeof declared === 'object') {
    for (const [dim, v] of Object.entries(declared as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) costs[dim] = v;
    }
  }
  return costs;
}

const fmtDual = (x: number): number => Number(x.toPrecision(6));

// ─── the one entry point ─────────────────────────────────────────────

export type FrameRequest = {
  /** The declared concern (walk spec) this frame answers. */
  concern: string;
  /** Who the frame is for — keys preferences (and, stage 2, learned
   *  relevance). Omitted → anonymous (no preference signal). */
  client?: string;
  /** Session id; omitted → derived from the kernel clock + counter. */
  session?: string;
  /** Case input: case-insensitive match over path + description. */
  query?: string;
  /** Declared capacities for the election (tokens / items / timeMs /
   *  any dimension the costs charge). The duals come back per declared
   *  dimension, INTO the frame. */
  capacities?: SelectCapacities;
  /** Approximate token budget for the emitted document (chars/4) —
   *  the EMISSION window (stub/omission machinery), distinct from the
   *  `tokens` capacity which prices the election itself. */
  maxTokens?: number;
  /** Session validity in ms (default 1 hour). */
  ttlMs?: number;
};

export type FrameResult = {
  sessionId: string;
  /** The ft document — every load-bearing fact a statement. */
  text: string;
  /** Every path that committed into the frame (in path order). */
  admitted: string[];
  /** The fn-typed subset of `admitted` (the tool surface). */
  tools: string[];
  omitted: string[];
  expandTokens: string[];
  expiresAt: number;
  /** The dual price per declared capacity dimension — what one unit of
   *  attention costs under current competition. Also committed as
   *  `_sessions.<id>.duals.*` facts, in the frame and on the store. */
  duals: Record<string, number>;
  /** Chain-provenance reports (beat 12) — host-delivered, as ft. */
  chainReports: Array<{ session: string; ft: string }>;
};

let frameCounter = 0;

/**
 * The one interaction, outbound: elect a frame for (client, concern,
 * capacities) and COMMIT it — session record, validity, owed
 * endpoints, duals, chain obligations. vend() is the tools-weighted
 * degenerate case of this call.
 */
export function electFrame(seq: Sequence, req: FrameRequest): FrameResult {
  const now = seq.now();
  const ttl = req.ttlMs ?? 3_600_000;
  const expiresAt = now + ttl;
  const sessionId = req.session ?? `s${now.toString(36)}${(frameCounter++).toString(36)}`;
  const budget = req.maxTokens ?? Infinity;
  const capacities = req.capacities ?? {};
  const expandTokens: string[] = [];
  const chainSessions = new Set<string>();

  // ── the relevance loop closes FIRST: the client's prior sessions
  //    become evidence before this election prices anything ──────────
  if (req.client !== undefined) foldSessionRelevance(seq, req.client);

  // ── case: the declared walk poses the question ────────────────────
  const spec = readConcern(seq, req.concern);
  if (!spec) throw new Error(`electFrame: concern '${req.concern}' is not declared`);
  const walked = caseWalk(seq, req.concern, { query: req.query });

  // ── election: value → cost → selectUnderPrices ────────────────────
  const rendered = new Map<string, { text: string; upstream: string[] }>();
  for (const item of walked) {
    rendered.set(item.path, item.type?.kind === 'fn'
      ? renderToolBlock(seq, item.path, item.type, sessionId, expiresAt)
      : { text: renderFactLines(item.path, item.value, item.timeBound, now), upstream: [] });
  }
  const candidates: SelectCandidate[] = walked.map((item) => ({
    id: item.path,
    value: valueOfCell(seq, spec, req.client, item, now),
    costs: costsOfItem(seq, item, rendered.get(item.path)!.text),
  }));
  const sel = selectUnderPrices(candidates, capacities);
  const admittedSet = new Set(sel.selected);
  const admitted = walked.filter((i) => admittedSet.has(i.path));
  const omitted: string[] = walked.filter((i) => !admittedSet.has(i.path)).map((i) => i.path);

  // ── commitment: document assembly, budget-aware (vend's, moved) ───
  const lines: string[] = [];
  let spent = 0;
  const emit = (s: string): void => {
    lines.push(s);
    spent += approxTokens(s + '\n');
  };

  emit(`-- vended by sequence·v2 · session ${sessionId} · comments are courtesy; every load-bearing fact below is a statement`);
  emit('');

  const descOf = (path: string): string | undefined => {
    const d = seq.get(`${path}._description`);
    return typeof d === 'string' ? d : undefined;
  };

  // Preludes: every label referenced by ≥1 admitted descriptions,
  // deduped, elected by budget, emitted ONCE as real binds before any
  // definition (the dependency chain forces the prelude — beat 8).
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const item of admitted) {
    for (const l of labelRefsIn(descOf(item.path) ?? '')) {
      if (!seen.has(l)) { seen.add(l); labels.push(l); }
    }
  }
  const elected: Record<string, string | null> = {};
  for (const label of labels) {
    // Elect against HALF the remaining budget: a prelude that ate the
    // whole window would starve the definitions it introduces.
    const doc = electLabel(seq, label, Math.max(0, (budget - spent) / 2));
    if (!doc) continue;
    const line = `${label} = ${quote(doc.text)}`;
    if (spent + approxTokens(line) > budget) {
      const token = `[[doc:${label} : expand for the full documentation]]`;
      expandTokens.push(token);
      emit(`-- ${token}`);
      continue;
    }
    elected[label] = doc.variant;
    emit(line);
  }
  if (labels.length > 0) emit('');

  // Admitted cells, in path order: fn definitions as receivable blocks
  // (with the stub fallback under the emission window), facts as binds
  // (with the claim sibling when future-bounded). Overflow is spoken.
  const vended: string[] = [];
  const committed: string[] = [];
  for (let i = 0; i < admitted.length; i++) {
    const item = admitted[i];
    const r = rendered.get(item.path)!;
    for (const up of r.upstream) chainSessions.add(up);

    if (spent + approxTokens(r.text) > budget) {
      // A tool whose FULL form does not fit is first offered as a
      // receivable STUB (looser types are never wrong) with its
      // complete definition behind a redeemable type-expansion token
      // (V16/beat 8); only if even the stub cannot fit is it omitted.
      if (item.type?.kind === 'fn') {
        const token = `[[type:${item.path} : expand for the full definition]]`;
        const stub = [
          `${item.path} = (input: { }) -> { }`,
          `${item.path}._expandType = ${quote(token)}`,
        ].join('\n');
        if (spent + approxTokens(stub) <= budget) {
          expandTokens.push(token);
          emit(stub);
          emit('');
          vended.push(item.path);
          committed.push(item.path);
          continue;
        }
      }
      omitted.push(...admitted.slice(i).map((c) => c.path));
      break;
    }
    emit(r.text);
    emit('');
    if (item.type?.kind === 'fn') vended.push(item.path);
    committed.push(item.path);
  }

  if (omitted.length > 0) {
    const token = `[[more : ${omitted.length} more matching tool(s) — narrow the query or raise the budget]]`;
    expandTokens.push(token);
    emit(`-- ${token}`);
    emit('');
  }

  // The continuance contract, typed and receivable.
  emit(`_sessions.${sessionId}.expiresAt = ${expiresAt}`);
  emit(`_sessions.${sessionId}.continue = (ft: string) -> { ok: boolean }`);
  emit(`_sessions.${sessionId}.expand = (token: string) -> { content: string, costTokens: number }`);
  emit(`_sessions.${sessionId}.extend = (ttlMs: number) -> { ok: boolean, expiresAt: number }`);

  // The duals, INTO the frame: one price fact per DECLARED capacity
  // dimension — the frame carries its own attention prices, receivable
  // and queryable at the far kernel like every other fact.
  const duals: Record<string, number> = {};
  for (const dim of Object.keys(capacities)) {
    duals[dim] = fmtDual(sel.duals[dim] ?? 0);
    emit(`_sessions.${sessionId}.duals.${dim} = ${duals[dim]}`);
  }

  // ── the session record + endpoints, on the store like everything ──
  const base = `_sessions.${sessionId}`;
  seq.insert({ path: `${base}.createdAt`, value: now });
  seq.insert({ path: `${base}.expiresAt`, value: expiresAt });
  seq.insert({ path: `${base}.tools`, value: vended.join(' ') });
  seq.insert({ path: `${base}.admitted`, value: committed.join(' ') });
  seq.insert({ path: `${base}.concern`, value: req.concern });
  if (req.client !== undefined) seq.insert({ path: `${base}.client`, value: req.client });
  for (const [dim, price] of Object.entries(duals)) {
    seq.insert({ path: `${base}.duals.${dim}`, value: price });
  }
  for (const [label, variant] of Object.entries(elected)) {
    seq.insert({ path: `${base}.elected.${label}`, value: variant ?? 'direct' });
  }
  // Frame snapshot: continuance validates against WHAT WAS VENDED, not
  // whatever the surface later becomes (stale-frame, V7). `withImpl`
  // records which tools were executable here at vend time — losing one
  // of those impls is the surface change a client must hear about.
  seq.insert({
    path: `${base}.frame`,
    value: { tools: [...vended], withImpl: vended.filter((t) => seq.impls.has(t)) },
  });
  seq.impls.set(`${base}.continue`, async (input: unknown) => {
    const ft = (input as { ft?: string })?.ft ?? (typeof input === 'string' ? input : '');
    return continueSession(seq, sessionId, ft);
  });
  seq.impls.set(`${base}.expand`, (input: unknown) => {
    const token = (input as { token?: string })?.token ?? (typeof input === 'string' ? input : '');
    return expand(seq, sessionId, token);
  });
  seq.impls.set(`${base}.extend`, (input: unknown) => {
    const ttlMs = (input as { ttlMs?: number })?.ttlMs ?? (typeof input === 'number' ? input : NaN);
    return extendSession(seq, sessionId, ttlMs);
  });

  const chainReports = [...chainSessions].map((session) => ({
    session,
    ft: `_sessions.${session}.chain.${sessionId} = { tools: "${vended.join(' ')}", expiresAt: ${expiresAt} }`,
  }));

  return {
    sessionId,
    text: lines.join('\n'),
    admitted: committed,
    tools: vended,
    omitted,
    expandTokens,
    expiresAt,
    duals,
    chainReports,
  };
}

// ─── the owed endpoints (vend's session machinery, moved) ────────────

export type ContinueResult =
  | { ok: true; applied: number; errors: string[] }
  | { ok: false; reason: 'unknown-session' | 'expired' | 'stale-frame'; detail?: string };

export function sessionExpiry(seq: Sequence, sessionId: string): number | undefined {
  const v = seq.get(`_sessions.${sessionId}.expiresAt`);
  return typeof v === 'number' ? v : undefined;
}

export type ExtendResult =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: 'unknown-session' | 'expired' | 'invalid-ttl' };

/** The extend endpoint's kernel half: a LIVE session's expiry moves to
 *  now + ttlMs — one value delta on `_sessions.<id>.expiresAt`, the only
 *  session fact that was write-once before this. The frame snapshot is
 *  untouched (V9's law: same contract, later expiry); an expired or
 *  unknown session cannot be revived by name. Hosts bind this to their
 *  transport like `continue`/`expand`; the office's expiry task and its
 *  client-callable extension both ride this one write. The bound is a
 *  stamped constant here — deriving it from the surface's forecast is
 *  the host's open item, not this endpoint's. */
export function extendSession(seq: Sequence, sessionId: string, ttlMs: number): ExtendResult {
  const expiresAt = sessionExpiry(seq, sessionId);
  if (expiresAt === undefined) return { ok: false, reason: 'unknown-session' };
  if (seq.now() > expiresAt) return { ok: false, reason: 'expired' };
  if (!(Number.isFinite(ttlMs) && ttlMs > 0)) return { ok: false, reason: 'invalid-ttl' };
  const next = seq.now() + ttlMs;
  seq.insert({ path: `_sessions.${sessionId}.expiresAt`, value: next });
  return { ok: true, expiresAt: next };
}

/** The continue endpoint's kernel half: ft issued against a session is
 *  applied only while the session is live, and only against the frame
 *  that was actually vended. Hosts bind this to whatever transport they
 *  run — the contract is the data. */
export async function continueSession(
  seq: Sequence,
  sessionId: string,
  ft: string,
): Promise<ContinueResult> {
  const expiresAt = sessionExpiry(seq, sessionId);
  if (expiresAt === undefined) return { ok: false, reason: 'unknown-session' };
  if (seq.now() > expiresAt) return { ok: false, reason: 'expired' };

  // Stale-frame check (V7): a statement that targets a tool from this
  // session's frame snapshot which the kernel no longer offers gets a
  // typed answer — not a crash, not silent success against a world the
  // client never saw.
  const frame = seq.get(`_sessions.${sessionId}.frame`) as
    { tools?: string[]; withImpl?: string[] } | undefined;
  for (const t of frame?.tools ?? []) {
    const typeGone = seq.rawTypeAt(t)?.kind !== 'fn';
    const implGone = (frame?.withImpl ?? []).includes(t) && !seq.impls.has(t);
    if ((typeGone || implGone) && ft.includes(t)) {
      return { ok: false, reason: 'stale-frame', detail: t };
    }
  }

  const r = await receiveDocument(seq, ft);
  return { ok: true, applied: r.applied, errors: r.errors };
}

export type ExpandResult =
  | { ok: true; content: string; costTokens: number }
  | { ok: false; reason: 'unknown-session' | 'expired' | 'unknown-token'; token?: string };

/** Redeem an expansion token through a live session: the full content
 *  plus its honest cost. `[[doc:…]]` yields the document text;
 *  `[[type:…]]` yields the tool's COMPLETE receivable definition line
 *  (the stub's full form). Unknown tokens are refused BY NAME. */
export function expand(seq: Sequence, sessionId: string, token: string): ExpandResult {
  const expiresAt = sessionExpiry(seq, sessionId);
  if (expiresAt === undefined) return { ok: false, reason: 'unknown-session' };
  if (seq.now() > expiresAt) return { ok: false, reason: 'expired' };
  const m = /^\[\[(doc|type):([^\s:]+) : /.exec(token);
  if (!m) return { ok: false, reason: 'unknown-token', token };
  // Engagement is observed where it happens (stage 2): redeeming a
  // token IS attention spent on that cell — the session records it for
  // the relevance fold at the client's next election.
  seq.insert({ path: `_sessions.${sessionId}.engaged.${m[2]}`, value: true });
  if (m[1] === 'type') {
    const type = seq.rawTypeAt(m[2]);
    if (type?.kind !== 'fn') return { ok: false, reason: 'unknown-token', token };
    const { params, returns } = fnSignature(type);
    const line = `${m[2]} = ${params} -> ${returns}${latencySuffix(seq, m[2])}`;
    return { ok: true, content: line, costTokens: approxTokens(line) };
  }
  const doc = electLabel(seq, m[2], Infinity);
  if (!doc) return { ok: false, reason: 'unknown-token', token };
  return { ok: true, content: doc.text, costTokens: approxTokens(doc.text) };
}
