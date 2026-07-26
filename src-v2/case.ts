/**
 * case.ts (v2) — the read-side walk ENGINE, parameterized by DECLARED
 * walk specifications ("concerns").
 *
 * THE ELECTED FRAME, stage 1 (docs: observatory-app MAP-ELECTED-FRAME):
 * the pipeline is cells → case → election → commitment, in four
 * pre-existing substrate words. This module is CASE — the search +
 * input. It poses the question, it never judges:
 *
 *   · A concern is a walk specification, declared as FACTS under
 *     `_concerns.<name>.*` — roots, which lattice axes to follow
 *     (structural/temporal/ref — the edges already exist on
 *     Cell.in/out), filters, horizon. Specs are data; adding a product
 *     surface = declaring a concern, never writing walker code.
 *   · ONE walk engine, parameterized by spec. The write-side traverse
 *     is the precedent (meaning-from-traversal-context); `cells()` and
 *     vend's old selection walk are its degenerate read cases.
 *   · The walk's yield is cells WITH assigned meaning: the collected
 *     traversal context (access posterior, time bound/distance, depth,
 *     arrival axis, root) IS the meaning the value expression consumes.
 *     The same usage cell is "an action that happened" under a
 *     provenance walk and just a cell under a structural walk — kinds
 *     never branch anything downstream.
 *
 * MEMBERSHIP (what the walk yields, all declared, no kind switches):
 *   · a cell must be COMMITTABLE as a receivable statement: it has a
 *     value, or it is an fn-typed definition. Type-only non-fn cells
 *     are claim slots awaiting an external actor — not vendable yet.
 *   · expiry is enforced at the offering (V13): a cell whose type
 *     carries a time bound entirely in the past is never yielded.
 *   · `_`-prefixed segments below a root are excluded unless the spec
 *     declares `underscore`. A root may itself be an `_` scope
 *     (`_usage`, `_commitments`) — the filter applies BELOW the root.
 *
 * VALUE WEIGHTS LIVE ON THE CONCERN as data (`value.base/access/
 * preference/temporal`): they are the concern's declared preferencing
 * posture, consumed by elect-frame's ONE value expression. A concern
 * that zeroes a weight has declared "don't collect that meaning" —
 * weights subsume a separate collect-list (one mechanism, not two).
 *
 * Reads go through getCell (never get()): the elector's own
 * instrumental reads are not client attention and must not move access
 * posteriors — the hoistForReader precedent, and the same law as
 * "one real observation must never count twice."
 */

import { Sequence, type Cell, type Axis } from './sequence';
import { type Type } from '../src/type';
import { timeHorizon } from './validity';
import { accessScore } from './stdlib';

export type ConcernValueWeights = {
  /** Constant claim every member makes (default 0). */
  base: number;
  /** Weight on the access posterior (default 1). */
  access: number;
  /** Weight on declared `_preferences.<client>.weights.*` (default 1). */
  preference: number;
  /** Weight on temporal proximity within `horizon` (default 1). */
  temporal: number;
};

export type ConcernSpec = {
  /** Path prefixes the walk starts from ('' = the whole surface). */
  roots: string[];
  /** Lattice axes the walk follows (default ['structural']). */
  axes: Axis[];
  /** Yield only cells whose type kind matches (e.g. 'fn'). */
  typeKind?: string;
  /** Include `_`-prefixed segments below the roots (default false). */
  underscore: boolean;
  /** Temporal window (ms ahead of now) that scales proximity value. */
  horizon?: number;
  /** Membership requires a time bound within [now, now+horizon]. */
  withinHorizon: boolean;
  value: ConcernValueWeights;
};

/** Call-time input of the case (the search's runtime half). */
export type CaseInput = {
  /** Case-insensitive match over cell path + `._description` text. */
  query?: string;
};

/** One yielded cell WITH its assigned meaning — the traversal context
 *  collected en route. This is what the value expression consumes. */
export type CaseYield = {
  path: string;
  type?: Type;
  value?: unknown;
  /** Access posterior at this cell (0.5 = no evidence). */
  posterior: number;
  /** Latest instant the cell's type still holds, or null (unbounded). */
  timeBound: number | null;
  /** Steps from the root that reached this cell. */
  depth: number;
  /** Axis of first arrival. */
  axis: Axis;
  /** The root this cell was reached from. */
  root: string;
};

const CONCERNS = '_concerns';

/** Declare a concern as facts. Partial input; defaults are filled at
 *  READ time (readConcern), so the stored facts stay minimal and a
 *  later author can still narrow them. */
export function declareConcern(
  seq: Sequence,
  name: string,
  spec: Partial<Omit<ConcernSpec, 'value'>> & { value?: Partial<ConcernValueWeights> } = {},
): void {
  const base = `${CONCERNS}.${name}`;
  seq.insert({ path: `${base}.roots`, value: (spec.roots ?? ['']).join(' ') });
  if (spec.axes !== undefined) seq.insert({ path: `${base}.axes`, value: spec.axes.join(' ') });
  if (spec.typeKind !== undefined) seq.insert({ path: `${base}.filter.typeKind`, value: spec.typeKind });
  if (spec.underscore !== undefined) seq.insert({ path: `${base}.filter.underscore`, value: spec.underscore });
  if (spec.withinHorizon !== undefined) seq.insert({ path: `${base}.filter.withinHorizon`, value: spec.withinHorizon });
  if (spec.horizon !== undefined) seq.insert({ path: `${base}.horizon`, value: spec.horizon });
  for (const k of ['base', 'access', 'preference', 'temporal'] as const) {
    const v = spec.value?.[k];
    if (v !== undefined) seq.insert({ path: `${base}.value.${k}`, value: v });
  }
}

/** Read a declared concern spec, defaults applied. Null when the
 *  concern was never declared (roots is the required fact). */
export function readConcern(seq: Sequence, name: string): ConcernSpec | null {
  const base = `${CONCERNS}.${name}`;
  const read = (p: string): unknown => seq.getCell(`${base}.${p}`)?.value;
  const roots = read('roots');
  if (typeof roots !== 'string') return null;
  const num = (p: string): number | undefined => {
    const v = read(p);
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const axesRaw = read('axes');
  return {
    roots: roots === '' ? [''] : roots.split(' '),
    axes: typeof axesRaw === 'string' && axesRaw !== ''
      ? (axesRaw.split(' ') as Axis[])
      : ['structural'],
    typeKind: typeof read('filter.typeKind') === 'string'
      ? (read('filter.typeKind') as string)
      : undefined,
    underscore: read('filter.underscore') === true,
    withinHorizon: read('filter.withinHorizon') === true,
    horizon: num('horizon'),
    value: {
      base: num('value.base') ?? 0,
      access: num('value.access') ?? 1,
      preference: num('value.preference') ?? 1,
      temporal: num('value.temporal') ?? 1,
    },
  };
}

/** Min time horizon across a type's constraints, or null (unbounded). */
export function cellTimeBound(type: Type | undefined): number | null {
  if (!type) return null;
  let min: number | null = null;
  for (const c of type.constraints ?? []) {
    const h = timeHorizon(c);
    if (h !== null && (min === null || h < min)) min = h;
  }
  return min;
}

/**
 * THE walk engine. Walks from the spec's roots along its declared
 * axes, applies its declared filters plus the call-time input, and
 * yields cells with their assigned meaning, sorted by path.
 *
 * Fail-loud on an undeclared concern (the elect.ts idiom): a silent
 * empty yield would elect a silent empty frame.
 */
export function caseWalk(seq: Sequence, concern: string, input: CaseInput = {}): CaseYield[] {
  const spec = readConcern(seq, concern);
  if (!spec) {
    throw new Error(`caseWalk: concern '${concern}' is not declared (no ${CONCERNS}.${concern}.roots fact)`);
  }
  const now = seq.now();
  const q = input.query?.toLowerCase();

  const seen = new Set<string>();
  const queue: Array<{ cell: Cell; depth: number; axis: Axis; root: string }> = [];
  const push = (cell: Cell, depth: number, axis: Axis, root: string): void => {
    if (seen.has(cell.path)) return;
    seen.add(cell.path);
    queue.push({ cell, depth, axis, root });
  };
  for (const root of spec.roots) {
    const rc = seq.getCell(root);
    if (rc) push(rc, 0, 'structural', root);
  }

  const descOf = (path: string): string | undefined => {
    const d = seq.getCell(`${path}._description`)?.value;
    return typeof d === 'string' ? d : undefined;
  };
  const underscored = (path: string, root: string): boolean => {
    const below = root === '' ? path : path.slice(root.length + 1);
    return below.split('.').some((s) => s.startsWith('_'));
  };

  const out: CaseYield[] = [];
  while (queue.length > 0) {
    const { cell, depth, axis, root } = queue.shift()!;

    // ── membership: declared filters + call input, never a kind switch ──
    const t = cell.type;
    const bound = cellTimeBound(t);
    const committable = cell.value !== undefined || t?.kind === 'fn';
    const alive = bound === null || bound >= now; // expiry enforced at the offering (V13)
    const kindOk = spec.typeKind === undefined || t?.kind === spec.typeKind;
    const horizonOk = !spec.withinHorizon
      || (bound !== null && bound >= now && bound <= now + (spec.horizon ?? Infinity));
    const queryOk = !q
      || cell.path.toLowerCase().includes(q)
      || (descOf(cell.path)?.toLowerCase().includes(q) ?? false);
    if (committable && alive && kindOk && horizonOk && queryOk && cell.path !== '') {
      out.push({
        path: cell.path,
        type: t,
        value: cell.value,
        posterior: accessScore(seq, cell.path),
        timeBound: bound,
        depth,
        axis,
        root,
      });
    }

    // ── frontier along the declared axes ──────────────────────────────
    if (spec.axes.includes('structural')) {
      for (const [seg, child] of cell.children) {
        if (!spec.underscore && seg.startsWith('_')) continue;
        push(child, depth + 1, 'structural', root);
      }
    }
    for (const ax of ['temporal', 'ref'] as Axis[]) {
      if (!spec.axes.includes(ax)) continue;
      for (const target of cell.out[ax] ?? []) {
        const tc = seq.getCell(target);
        if (!tc) continue;
        if (!spec.underscore && underscored(target, root)) continue;
        push(tc, depth + 1, ax, root);
      }
    }
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
