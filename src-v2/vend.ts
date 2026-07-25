/**
 * vend.ts (v2) — tool compilation for clients, on THE kernel.
 *
 * The v1 module (src/vend.ts, 2026-07-24) composed the same rules over
 * the v1 engine; this is its v2 re-base — deletion-ledger direction:
 * v1 vend dies once its consumers re-point here. What changed is not
 * the rules but the HONESTY OF THE CARRIER:
 *
 *   v1 emitted validity, preludes and docs as `--` comment lines. The
 *   standing guard for "interpretable equivalently by non-LLM systems"
 *   is: strip every `--` line from a vended frame and every merge /
 *   planner / expiry / constraint assertion must still pass. v1 fails
 *   that by design-shortcut. Here, EVERY LOAD-BEARING FACT IS A
 *   RECEIVABLE STATEMENT:
 *
 *   · validity     → `<tool>._validUntil = T` (receive-doc mounts
 *                    lte($now, T) on the tool type — the exact family
 *                    validity.ts timeHorizon() reads)
 *   · reliability  → `<tool>._reliability = { alpha, beta }` (observed
 *                    beta posterior → distribution constraint)
 *   · latency      → `~survival(exp, rate)` / `~lognormal(...)` suffix
 *                    on the definition line (parses today; mounts as a
 *                    distribution constraint on receive)
 *   · descriptions → `<tool>._description = "..."` binds (the v2
 *                    installTool convention), label references kept AS
 *                    LABELS (`[[narratives.team]]`) — authoring names
 *                    the label, never the variant
 *   · preludes     → elected narrative variants emitted as REAL BINDS
 *                    at their source path, once, before definitions —
 *                    the receiving kernel gains the document as facts
 *
 *   `--` comments still appear, but carry courtesy narration only.
 *
 * ANNOTATION HONESTY (the storyboard's hard core): reliability and
 * latency are emitted ONLY when an observed posterior exists at
 * `<tool>._prior.reliability` / `<tool>._prior.latency` (the stdlib
 * reliability-rule convention). No posterior → no annotation. This
 * module never authors a number.
 *
 * Variant election (label groups): a label resolves to a cell; if that
 * cell has string-valued children they are variants (short/medium/
 * long); vend elects the largest that fits the remaining budget, falls
 * back to the smallest, and records the election on the session. This
 * is frame-time election by budget — beat 5.
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

const approxTokens = (s: string): number => Math.ceil(s.length / 4);

/** Render a fn type's signature halves in the receivable form. */
function fnSignature(type: Type): { params: string; returns: string } {
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
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

const quote = (s: string): string => JSON.stringify(oneLine(s));

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
function latencySuffix(seq: Sequence, path: string): string {
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

/** Render the kernel's tool surface as an ft document for a client,
 *  under constraints, and open a session for continuance. */
export function vend(seq: Sequence, req: VendRequest = {}): VendResult {
  const now = seq.now();
  const ttl = req.ttlMs ?? 3_600_000;
  const expiresAt = now + ttl;
  const sessionId = req.session ?? `s${now.toString(36)}${(vendCounter++).toString(36)}`;
  const budget = req.maxTokens ?? Infinity;
  const expandTokens: string[] = [];
  const chainSessions = new Set<string>();

  // ── selection: fn-typed cells outside `_` scopes ─────────────────
  const candidates: Array<{ path: string; type: Type }> = [];
  const walkPaths = (prefix: string): void => {
    for (const key of seq.keys(prefix || undefined)) {
      if (key.startsWith('_')) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const t = seq.rawTypeAt(path);
      // EXPIRY IS ENFORCED AT THE OFFERING (V13): a tool whose type
      // carries a time bound in the past — a received grant that has
      // run out — is not offered, with no session machinery involved.
      if (t?.kind === 'fn') {
        const horizons = (t.constraints ?? [])
          .map((c) => timeHorizon(c))
          .filter((h): h is number => h !== null);
        if (horizons.length === 0 || Math.min(...horizons) >= now) {
          candidates.push({ path, type: t });
        }
      }
      walkPaths(path);
    }
  };
  walkPaths('');
  candidates.sort((a, b) => a.path.localeCompare(b.path));

  const descOf = (path: string): string | undefined => {
    const d = seq.get(`${path}._description`);
    return typeof d === 'string' ? d : undefined;
  };

  const q = req.query?.toLowerCase();
  const matches = q
    ? candidates.filter(({ path }) =>
        path.toLowerCase().includes(q) || (descOf(path)?.toLowerCase().includes(q) ?? false))
    : candidates;

  const capped = req.maxTools !== undefined ? matches.slice(0, req.maxTools) : matches;
  const omitted: string[] = matches.slice(capped.length).map((c) => c.path);

  // ── document assembly, budget-aware ──────────────────────────────
  const lines: string[] = [];
  let spent = 0;
  const emit = (s: string): void => {
    lines.push(s);
    spent += approxTokens(s + '\n');
  };

  emit(`-- vended by sequence·v2 · session ${sessionId} · comments are courtesy; every load-bearing fact below is a statement`);
  emit('');

  // Preludes: every label referenced by ≥1 selected descriptions,
  // deduped, elected by budget, emitted ONCE as real binds before any
  // definition (the dependency chain forces the prelude — beat 8).
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const { path } of capped) {
    for (const l of labelRefsIn(descOf(path) ?? '')) {
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

  // Tool definitions: receivable ft, one block per tool. The signature
  // line may carry an OBSERVED latency distribution suffix; validity,
  // reliability and description ride as sibling-fact binds.
  const vended: string[] = [];
  for (let i = 0; i < capped.length; i++) {
    const { path, type } = capped[i];
    const { params, returns } = fnSignature(type);

    const block: string[] = [`${path} = ${params} -> ${returns}${latencySuffix(seq, path)}`];
    const desc = descOf(path);
    if (desc !== undefined) block.push(`${path}._description = ${quote(desc)}`);
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
    const parentChain = seq.get(`${path}._origin.chain`);
    if (typeof parentChain === 'string' && parentChain.length > 0) {
      block.push(`${path}._origin.chain = "${parentChain} ${sessionId}"`);
      for (const upstream of parentChain.split(' ')) {
        chainSessions.add(upstream);
      }
    }
    const blockText = block.join('\n');

    // Budget check BEFORE emitting: overflow is spoken, never a silent
    // mid-definition cut. A tool whose FULL form does not fit is first
    // offered as a receivable STUB (looser types are never wrong) with
    // its complete definition behind a redeemable type-expansion token
    // (V16/beat 8); only if even the stub cannot fit is it omitted.
    if (spent + approxTokens(blockText) > budget) {
      const token = `[[type:${path} : expand for the full definition]]`;
      const stub = [
        `${path} = (input: { }) -> { }`,
        `${path}._expandType = ${quote(token)}`,
      ].join('\n');
      if (spent + approxTokens(stub) <= budget) {
        expandTokens.push(token);
        emit(stub);
        emit('');
        vended.push(path);
        continue;
      }
      omitted.push(...capped.slice(i).map((c) => c.path));
      break;
    }
    emit(blockText);
    emit('');
    vended.push(path);
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

  // ── the session record + endpoints, on the store like everything ──
  const base = `_sessions.${sessionId}`;
  seq.insert({ path: `${base}.createdAt`, value: now });
  seq.insert({ path: `${base}.expiresAt`, value: expiresAt });
  seq.insert({ path: `${base}.tools`, value: vended.join(' ') });
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

  const chainReports = [...chainSessions].map((session) => ({
    session,
    ft: `_sessions.${session}.chain.${sessionId} = { tools: "${vended.join(' ')}", expiresAt: ${expiresAt} }`,
  }));

  return { sessionId, text: lines.join('\n'), tools: vended, omitted, expandTokens, expiresAt, chainReports };
}

let vendCounter = 0;

export type ContinueResult =
  | { ok: true; applied: number; errors: string[] }
  | { ok: false; reason: 'unknown-session' | 'expired' | 'stale-frame'; detail?: string };

function sessionExpiry(seq: Sequence, sessionId: string): number | undefined {
  const v = seq.get(`_sessions.${sessionId}.expiresAt`);
  return typeof v === 'number' ? v : undefined;
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
