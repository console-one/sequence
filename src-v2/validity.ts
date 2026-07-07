/**
 * validity.ts — the time horizon of a serialized constraint (DSL: claims
 * carry expiry; observers bound their next decision by it).
 *
 * timeHorizon answers ONE question about a law: what is the latest
 * instant it can still hold with respect to the `$now` binding? The
 * recognized family is CLOSED (the seam-4 discipline — widening it ad
 * hoc is how a second evaluator sneaks in):
 *
 *   lte($now, T) | lt($now, T)   → T   (the canonical valid-until form)
 *   and_clause([...])            → min of members' horizons (all must hold)
 *
 * Anything else → null: "no time bound recognized" — callers treat null
 * as unbounded and change no behavior. The evaluator itself is untouched:
 * this is a READ of the vocabulary, not a new judgment path.
 */

export interface ConstraintShape {
  op?: string;
  args?: unknown[];
}

/** The latest instant `c` can still hold w.r.t. $now, or null when the
 *  constraint carries no recognized time bound. Pure; total. */
export function timeHorizon(c: ConstraintShape | undefined): number | null {
  if (!c || typeof c.op !== 'string' || !Array.isArray(c.args)) return null;
  if ((c.op === 'lte' || c.op === 'lt') && c.args[0] === '$now') {
    const bound = c.args[1];
    return typeof bound === 'number' && Number.isFinite(bound) ? bound : null;
  }
  if (c.op === 'and_clause') {
    let min: number | null = null;
    for (const member of c.args) {
      const h = timeHorizon(member as ConstraintShape);
      if (h !== null && (min === null || h < min)) min = h;
    }
    return min;
  }
  return null;
}
