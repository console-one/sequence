// vend.ts — tool compilation for clients: the kernel renders its mounted
// capability surface as an ft DOCUMENT a client (an LLM, another kernel,
// a person) can act on, under explicit constraints, with documentation
// transcluded by rule and a session contract for continuance.
//
// The design is specs/docs/TOOL_COMPILATION_VENDING.md (Andrew,
// 2026-07-24; lineage April 2026). This module COMPOSES existing
// machinery — the catalog renderer, type meta, expansion tokens, the
// receive() round-trip — and adds only the composition rules:
//
//   · selection      — query + maxTools over the mounted fn surface
//   · doc association — type meta carries doc refs:
//        meta.doc        = path of an inline doc for this tool/field
//        meta.docPrelude = path of a shared prelude document
//        meta.docGroup   = path PREFIX whose children are variants
//                          (short/medium/long); vend elects ONE by budget
//   · prelude transclusion — a prelude referenced by ≥1 vended tools
//     renders ONCE, at the top
//   · budget         — maxTokens (≈ chars/4); overflow becomes an
//     expansion token, never a silent cut
//   · the session    — `_sessions.<id>` is mounted with a structured
//     expiry; the vended text declares the continue endpoint; ft issued
//     back through continueSession() is refused after expiry.
//
// Docs are ordinary mounted string values (canonically under `_docs.*`,
// but any path works). Everything vend consumes is data in the store.

import { type Sequence } from './sequence';
import { type Type, constraintOf, properties } from './type';
import { renderTypeFt } from './hoist';
import { receive } from './dsl/walker';
import type { MountResult } from './sequence';

export type VendRequest = {
  /** Session id; omitted → derived from the kernel clock. */
  session?: string;
  /** Case-insensitive match over tool path + description + doc labels. */
  query?: string;
  maxTools?: number;
  /** Approximate token budget for the emitted document (chars/4). */
  maxTokens?: number;
  /** Session validity in ms (default 1 hour). */
  ttlMs?: number;
};

export type VendResult = {
  sessionId: string;
  /** The ft definition-set document. */
  text: string;
  /** Paths of the vended tools. */
  tools: string[];
  /** Tools that matched but did not fit the budget/maxTools. */
  omitted: string[];
  expandTokens: string[];
  expiresAt: number;
};

type DocMeta = { doc?: string; docPrelude?: string; docGroup?: string };

const approxTokens = (s: string): number => Math.ceil(s.length / 4);

function docMetaOf(type: Type | undefined): DocMeta {
  const m = (type?.meta ?? {}) as DocMeta & Record<string, unknown>;
  return {
    doc: typeof m.doc === 'string' ? m.doc : undefined,
    docPrelude: typeof m.docPrelude === 'string' ? m.docPrelude : undefined,
    docGroup: typeof m.docGroup === 'string' ? m.docGroup : undefined,
  };
}

/** Deep doc refs: walk the fn's param/returns object properties for
 *  field types that carry doc meta. One level of nesting per walk step,
 *  bounded — API shapes, not arbitrary trees. */
function deepDocRefs(fnType: Type): Array<{ field: string; meta: DocMeta }> {
  const out: Array<{ field: string; meta: DocMeta }> = [];
  const visit = (t: Type | undefined, prefix: string, depth: number): void => {
    if (!t || depth > 4) return;
    for (const p of properties(t)) {
      const field = prefix ? `${prefix}.${p.key}` : p.key;
      const meta = docMetaOf(p.type);
      if (meta.doc || meta.docPrelude || meta.docGroup) out.push({ field, meta });
      visit(p.type, field, depth + 1);
    }
  };
  const param = constraintOf(fnType, 'param')?.args[0] as Type | undefined;
  const returns = constraintOf(fnType, 'returns')?.args[0] as Type | undefined;
  visit(param, 'input', 0);
  visit(returns, 'output', 0);
  return out;
}

/** Resolve a doc reference to text. A ref with CHILDREN is a label
 *  group: elect the largest variant that fits `budgetTokens`, falling
 *  back to the smallest. Returns null when nothing is mounted there. */
function resolveDoc(
  seq: Sequence,
  ref: string,
  budgetTokens: number,
): { text: string; variant: string | null } | null {
  const direct = seq.get(ref);
  if (typeof direct === 'string') return { text: direct, variant: null };
  const variants: Array<{ key: string; text: string }> = [];
  for (const key of seq.keys(ref)) {
    const v = seq.get(`${ref}.${key}`);
    if (typeof v === 'string') variants.push({ key, text: v });
  }
  if (variants.length === 0) return null;
  variants.sort((a, b) => b.text.length - a.text.length); // largest first
  const fitting = variants.find((v) => approxTokens(v.text) <= budgetTokens);
  const chosen = fitting ?? variants[variants.length - 1];
  return { text: chosen.text, variant: chosen.key };
}

const asCommentBlock = (text: string, indent = ''): string =>
  text
    .trim()
    .split('\n')
    .map((l) => `${indent}-- ${l}`.trimEnd())
    .join('\n');

/** Render the kernel's tool surface as an ft document for a client,
 *  under constraints, and open a session for continuance. */
export function vend(seq: Sequence, req: VendRequest = {}): VendResult {
  const now = seq.realtime;
  const ttl = req.ttlMs ?? 3_600_000;
  const expiresAt = now + ttl;
  const sessionId = req.session ?? `s${now.toString(36)}${(vendCounter++).toString(36)}`;
  const budget = req.maxTokens ?? Infinity;
  const expandTokens: string[] = [];

  // ── selection ────────────────────────────────────────────────────
  const candidates: Array<{ path: string; type: Type }> = [];
  const walkPaths = (prefix: string): void => {
    for (const key of seq.keys(prefix || undefined)) {
      if (key.startsWith('_')) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const t = seq.rawTypeAt(path);
      if (t?.kind === 'fn') candidates.push({ path, type: t });
      walkPaths(path);
    }
  };
  walkPaths('');
  candidates.sort((a, b) => a.path.localeCompare(b.path));

  const q = req.query?.toLowerCase();
  const matches = q
    ? candidates.filter(({ path, type }) => {
        if (path.toLowerCase().includes(q)) return true;
        const desc = (type.meta as { description?: string } | undefined)?.description;
        if (desc?.toLowerCase().includes(q)) return true;
        const dm = docMetaOf(type);
        return [dm.doc, dm.docPrelude, dm.docGroup].some((r) => r?.toLowerCase().includes(q));
      })
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

  emit(`-- vended by sequence · session ${sessionId}`);
  emit(`-- valid while _rt < ${expiresAt} (about ${Math.round(ttl / 60000)} minutes)`);
  emit('');

  // Preludes: dedupe across every selected tool (and their deep fields),
  // render ONCE each, before any definitions.
  const preludeRefs: string[] = [];
  const seenPrelude = new Set<string>();
  for (const { type } of capped) {
    const refs = [docMetaOf(type).docPrelude, ...deepDocRefs(type).map((d) => d.meta.docPrelude)];
    for (const r of refs) {
      if (r && !seenPrelude.has(r)) {
        seenPrelude.add(r);
        preludeRefs.push(r);
      }
    }
  }
  for (const ref of preludeRefs) {
    // Elect against HALF the remaining budget: a prelude that ate the
    // whole window would starve the definitions it exists to introduce.
    const doc = resolveDoc(seq, ref, (budget - spent) / 2);
    if (!doc) continue;
    emit(`-- prelude: ${ref}${doc.variant ? ` [${doc.variant}]` : ''}`);
    emit(asCommentBlock(doc.text));
    emit('');
  }

  // Tool definitions. Each: `tool <path> <signature>` + description +
  // inline or expansion-linked docs (tool-level, then deep fields).
  const vended: string[] = [];
  for (let i = 0; i < capped.length; i++) {
    const { path, type } = capped[i];
    // RECEIVABLE ft, not a display form — hoist output is valid input
    // (the round-trip law). `path = (params) -> returns` then `tool path`.
    const paramT = constraintOf(type, 'param')?.args[0] as Type | undefined;
    const returnsT = constraintOf(type, 'returns')?.args[0] as Type | undefined;
    const params = paramT
      ? renderTypeFt(paramT).replace(/\s+/g, ' ').replace(/^\{\s*/, '(').replace(/\s*\}$/, ')')
      : '()';
    const returns = returnsT ? renderTypeFt(returnsT).replace(/\s+/g, ' ') : '{ ok: true }';
    const desc = (type.meta as { description?: string } | undefined)?.description;
    const header = `${path} = ${params} -> ${returns}${desc ? `  -- ${desc}` : ''}\ntool ${path}`;

    // Budget check BEFORE emitting the tool: overflow is reported, not
    // silently cut mid-definition.
    if (spent + approxTokens(header) > budget) {
      omitted.push(...capped.slice(i).map((c) => c.path));
      break;
    }
    emit(header);
    vended.push(path);

    const dm = docMetaOf(type);
    if (dm.doc || dm.docGroup) {
      const ref = dm.docGroup ?? dm.doc!;
      const doc = resolveDoc(seq, ref, Math.max(0, (budget - spent) / 2));
      if (doc && spent + approxTokens(doc.text) <= budget) {
        emit(asCommentBlock(doc.text, '  ') + (doc.variant ? `\n  -- [variant: ${doc.variant}]` : ''));
      } else {
        const token = `[[doc:${ref} : expand for the full documentation]]`;
        expandTokens.push(token);
        emit(`  -- ${token}`);
      }
    }
    for (const d of deepDocRefs(type)) {
      const ref = d.meta.docGroup ?? d.meta.doc;
      if (!ref) continue;
      const token = `[[doc:${ref} : docs for ${path} ${d.field}]]`;
      expandTokens.push(token);
      emit(`  -- ${d.field}: ${token}`);
    }
    emit('');
  }

  if (omitted.length > 0) {
    const token = `[[more : ${omitted.length} more matching tool(s) — narrow the query or raise the budget]]`;
    expandTokens.push(token);
    emit(`-- ${token}`);
    emit('');
  }

  // The continuance contract: every definition above is, in effect, an
  // input constant for calls at THIS endpoint, until expiry.
  emit(`_sessions.${sessionId}.continue = (ft: string) -> { ok: boolean }  -- issue ft back to this kernel (install, narrow, call) — refused after expiry`);
  emit(`tool _sessions.${sessionId}.continue`);

  // ── the session record, on the store like everything else ────────
  seq.mount('bind', `_sessions.${sessionId}`, {
    createdAt: now,
    expiresAt,
    tools: vended.join(' '),
  });
  receive(`tool _sessions.${sessionId}.continue`, seq);

  return { sessionId, text: lines.join('\n'), tools: vended, omitted, expandTokens, expiresAt };
}

let vendCounter = 0;

export type ContinueResult =
  | { ok: true; mounts: MountResult[] }
  | { ok: false; reason: 'unknown-session' | 'expired' };

/** The continue endpoint's kernel half: ft issued against a session is
 *  applied only while the session is live. Hosts bind this to whatever
 *  transport they run (HTTP, MCP, stdio) — the contract is the data. */
export function continueSession(seq: Sequence, sessionId: string, ft: string): ContinueResult {
  const rec = seq.get(`_sessions.${sessionId}`) as { expiresAt?: number } | undefined;
  if (!rec || typeof rec.expiresAt !== 'number') return { ok: false, reason: 'unknown-session' };
  if (seq.realtime > rec.expiresAt) return { ok: false, reason: 'expired' };
  const r = receive(ft, seq);
  return { ok: true, mounts: r.mounts ?? [] };
}
