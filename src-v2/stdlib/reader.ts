import { type Type } from '../../src/type';
import {
  type Sequence,
} from '../sequence';
import { IDENT_RE, renderType } from './shared';

// ═══════════════════════════════════════════════════════════════════════
// READER CONTRACTS — structured read surface.
//
// Every read by an external consumer (UI, LLM, external API) goes
// through a reader: type-state at `_readers.{name}.{source,depth,...}`
// that defines WHAT to project and HOW. hoistForReader(seq, name)
// walks the declared source glob, bounded by depth, emitting cell
// values / schemas / gaps as ft-shaped text.
//
// Gaps render as `[[ path : <structural sig> ]]` expansion tokens.
// Values render as `path = <literal>`. Schemas with no value render
// as labeled gaps.
//
// This is the generic projection primitive. The semantic-kernel
// document prompt — identity/lease/values/tools/tasks sections —
// composes from multiple readers emitted in order plus fixed-text
// preambles. That composition belongs to a higher-layer render
// module, not here.
// ═══════════════════════════════════════════════════════════════════════

export type ReaderConfig = {
  source: string;      // path glob (`tools.*`, `_commitments.*`, or bare path)
  depth?: number;      // max depth below source prefix (default 3)
  /** Wire 3: posterior-driven materialization budget (char count).
   *  When set, ranks cells by access posterior × size and materializes
   *  the top until budget is exhausted; remainder emits compressed
   *  tokens with posterior annotations. `depth` becomes advisory. */
  budget?: number;
  /** Wire 3: forwards to access events + posterior lookup buckets. */
  contextClass?: string;
};

export type HoistResult = {
  text: string;
  paths: string[];
  gaps: Array<{ path: string; type?: Type }>;
};

export function installReader(seq: Sequence, name: string, config: ReaderConfig): void {
  const base = `_readers.${name}`;
  seq.insert({ path: `${base}.source`, value: config.source });
  if (config.depth !== undefined) seq.insert({ path: `${base}.depth`, value: config.depth });
  if (config.budget !== undefined) seq.insert({ path: `${base}.budget`, value: config.budget });
  if (config.contextClass !== undefined) seq.insert({ path: `${base}.contextClass`, value: config.contextClass });
}


// ═══════════════════════════════════════════════════════════════════════
// ACCESS POSTERIOR (Wire 3 companion) — opt-in per-cell access counters
// updated by a phase:'access' rule at _access.{path}.{hits,misses}.
// Reads at paths starting with '_' are skipped to prevent feedback loops.
// When not installed, accessScore() returns a uniform prior — budget
// hoist falls back to DFS order without re-ranking.
// ═══════════════════════════════════════════════════════════════════════

export function installAccessPosterior(seq: Sequence): void {
  seq.emitters.set('access.posterior_update', (ctx) => {
    const p = ctx.delta.path;
    if (!p || p.startsWith('_')) return [];
    const counter = ctx.delta.accessKind === 'hit' ? 'hits' : 'misses';
    const key = `_access.${p}.${counter}`;
    const cur = (seq.get(key) as number | undefined) ?? 0;
    return [{ path: key, value: cur + 1 }];
  });
  seq.insert({
    path: '_rules.access_posterior',
    rules: [{
      id: 'access_posterior',
      phase: 'access',
      scope: '',
      emit: 'access.posterior_update',
    }],
  });
}

/** Posterior-predictive mean P(access | path) under Beta(1,1). Monotone
 *  in total accesses; falls back to 0.5 (uniform) when no evidence. */
export function accessScore(seq: Sequence, path: string): number {
  const hits = (seq.get(`_access.${path}.hits`) as number | undefined) ?? 0;
  const misses = (seq.get(`_access.${path}.misses`) as number | undefined) ?? 0;
  const total = hits + misses;
  if (total === 0) return 0.5;
  // Access-count as a relevance signal: more total accesses → higher posterior
  // weight, regardless of hit/miss ratio. Both hits and misses are evidence
  // "this cell was asked about." Normalize asymptotically to 1.
  return 1 - 1 / (total + 2);
}

export function hoistForReader(seq: Sequence, name: string): HoistResult {
  const base = `_readers.${name}`;
  const source = seq.get(`${base}.source`) as string | undefined;
  if (!source) return { text: '', paths: [], gaps: [] };

  const budget = seq.get(`${base}.budget`) as number | undefined;
  // contextClass is stored by installReader and consulted by consumer-side
  // tools (renderDocument, agent-loop) when they call seq.get() after this
  // hoist — it keys their access observations by context. Hoist itself
  // uses seq.getCell() (no access event), so it doesn't consume the class
  // directly.
  const depth = (seq.get(`${base}.depth`) as number | undefined) ?? 3;

  const prefix = source.replace(/\.\*$/, '');
  const prefixSegs = prefix ? prefix.split('.').length : 0;

  const candidates = seq.cells()
    .map(c => c.path)
    .filter(p => {
      if (!p) return false;
      if (!prefix) return true;
      return p === prefix || p.startsWith(prefix + '.');
    })
    .sort();

  if (budget === undefined) {
    // Legacy depth mode (preserved for all existing readers).
    const lines: string[] = [];
    const paths: string[] = [];
    const gaps: Array<{ path: string; type?: Type }> = [];
    for (const path of candidates) {
      const rel = path.split('.').length - prefixSegs;
      if (rel > depth) continue;
      const cell = seq.getCell(path);
      if (!cell) continue;
      paths.push(path);
      if (cell.value !== undefined) {
        lines.push(`${path} = ${renderValue(cell.value)}`);
      } else if (cell.type) {
        gaps.push({ path, type: cell.type });
        lines.push(`[[ ${path} : ${renderType(cell.type)} ]]`);
      }
    }
    return { text: lines.join('\n'), paths, gaps };
  }

  // Budget × posterior mode.
  //
  // Rank candidate paths by access posterior (descending). Materialize in
  // rank order while budget remains; when the next candidate would exceed
  // budget, emit a compressed token carrying the posterior score. Output
  // iterates candidates in path-alphabetical order for stable reading,
  // but the materialize/compress DECISION is posterior-driven.
  //
  // Compressed tokens carry whatever sketch is available: the declared
  // type if any, else the inferred type from the value. Cells with
  // neither declared type nor value are the empty-container case and
  // emit nothing.
  const ranked = candidates
    .map(p => ({ path: p, score: accessScore(seq, p) }))
    .sort((a, b) => b.score - a.score);

  const materialized = new Set<string>();
  const scoreMap = new Map<string, number>();
  for (const { path, score } of ranked) scoreMap.set(path, score);

  let remaining = budget;
  for (const { path } of ranked) {
    const cell = seq.getCell(path);
    if (!cell) continue;
    if (cell.value === undefined && !cell.type) continue;
    const line = cell.value !== undefined
      ? `${path} = ${renderValue(cell.value)}`
      : `[[ ${path} : ${renderType(cell.type!)} | p=${(scoreMap.get(path) ?? 0.5).toFixed(2)} ]]`;
    const cost = line.length + 1;
    if (cost <= remaining) {
      materialized.add(path);
      remaining -= cost;
    }
  }

  const lines: string[] = [];
  const paths: string[] = [];
  const gaps: Array<{ path: string; type?: Type }> = [];
  for (const path of candidates) {
    const cell = seq.getCell(path);
    if (!cell) continue;
    if (cell.value === undefined && !cell.type) continue;
    paths.push(path);
    const score = scoreMap.get(path) ?? 0.5;
    if (materialized.has(path)) {
      if (cell.value !== undefined) {
        lines.push(`${path} = ${renderValue(cell.value)}`);
      } else {
        gaps.push({ path, type: cell.type });
        lines.push(`[[ ${path} : ${renderType(cell.type!)} | p=${score.toFixed(2)} ]]`);
      }
    } else {
      // Compressed sketch: declared type OR inferred from value.
      const sketch = cell.type ?? inferSketchType(cell.value);
      gaps.push({ path, type: sketch });
      lines.push(`[[ ${path} : ${renderType(sketch)} | p=${score.toFixed(2)} ]]`);
    }
  }
  return { text: lines.join('\n'), paths, gaps };
}

/** Minimum-information type sketch for a value. Used when budget-hoist
 *  emits a compressed token for a valued cell that didn't fit inline. */
function inferSketchType(v: unknown): Type {
  if (v === null) return { kind: 'null', constraints: [] };
  if (typeof v === 'string') return { kind: 'string', constraints: [] };
  if (typeof v === 'number') return { kind: 'number', constraints: [] };
  if (typeof v === 'boolean') return { kind: 'boolean', constraints: [] };
  if (Array.isArray(v)) return { kind: 'array', constraints: [] };
  if (typeof v === 'object') return { kind: 'object', constraints: [] };
  return { kind: 'any', constraints: [] };
}

/** Render a value as ft-syntax text. Scalars inline; arrays as
 *  `[a, b, c]`; objects as `{ key: val, key: val }` with unquoted
 *  identifier keys (keys that aren't valid idents get quoted).
 *  Output must tokenize cleanly — see tests/stdlib.test.ts under
 *  'hoist emits valid ft text'. */
function renderValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return `[${v.map(renderValue).join(', ')}]`;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v).map(([k, vv]) => {
      const key = IDENT_RE.test(k) ? k : JSON.stringify(k);
      return `${key}: ${renderValue(vv)}`;
    });
    return entries.length ? `{ ${entries.join(', ')} }` : '{}';
  }
  return String(v);
}
