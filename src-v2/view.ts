/**
 * view.ts — the consumer-indexed budgeted view (DSL PROGRAM seam 5, R5).
 *
 * planView is the standalone pure evaluator (the evaluate.ts / elect.ts /
 * procedure.ts precedent): a serializable ViewSpec — sections in priority
 * order, each offering rungs richest→cheapest — plus host-gathered rung
 * COSTS and a budget → the plan (one elected rung per section, the spend,
 * and the eviction manifest naming what the reader is NOT seeing). No I/O,
 * no dao, no host imports; the host gathers evidence and materializes the
 * elected rungs.
 *
 * The expression elects and budgets; it NEVER formats. Rung contents stay
 * host-side — text in the expression vocabulary is how a second template
 * language would sneak in (the seam-4 ban, applied to rendering).
 *
 * Selection semantics are MIGRATED from @console-one/compile's greedy
 * selector (the R5 engine named by observatory TECH-DEBT #6), pinned by
 * the render-parity corpus in the first real consumer:
 *   - sections claim budget in declaration order (priority IS the order);
 *   - within a section, the first rung whose cost fits the remaining
 *     budget on every budgeted dimension is elected;
 *   - when none fits, the cheapest rung (by summed cost, first-minimal)
 *     is elected REGARDLESS and charged — a section always renders its
 *     floor; offer a zero-cost rung to make dropping legal. Once the
 *     spend exceeds the cap, every later section falls to its cheapest —
 *     deliberate, single-pass, deterministic, no backtracking.
 * The archived compile package remains the reference for the dormant
 * beam/Lagrangian strategies; they activate here when measured prices
 * (d) exist to feed them — not before.
 */

// ─── The vocabulary ──────────────────────────────────────────────────────

/** Multi-dimensional cost/budget, e.g. `{tokens: 500}`. Dimensions absent
 *  from the budget are unconstrained. */
export type ViewCost = Record<string, number>;

export interface ViewRung {
  /** Host-computed price of materializing this rung (gathered evidence —
   *  the host measures its real renderings; the evaluator never sees
   *  them). Every value must be a finite number ≥ 0. */
  cost: ViewCost;
  /** What the rung shows (e.g. an item count) — opaque to selection,
   *  echoed into the plan so consumers can describe elisions. */
  detail?: string | number;
}

export interface ViewSection {
  /** Stable id — the host keys its materializers by this. */
  id: string;
  /** Rungs ordered richest → cheapest. At least one required. */
  rungs: ViewRung[];
}

/** The serializable view expression: sections in priority order. */
export interface ViewSpec {
  sections: ViewSection[];
}

// ─── The plan ────────────────────────────────────────────────────────────

export interface ViewPick {
  sectionId: string;
  /** Index into the section's rungs — the host materializes exactly this. */
  rung: number;
  cost: ViewCost;
  /** True when the rung was the over-budget cheapest fallback (the floor
   *  election): nothing at this section fit the remaining budget. */
  overBudget: boolean;
}

/** One elided section: which richer rungs the reader is NOT getting.
 *  This is R5's priced elision made data — the substrate for "+N more"
 *  hints and future expansion verbs. */
export interface ViewEviction {
  sectionId: string;
  /** Rung indexes richer than the elected one, richest first. */
  richerRungs: number[];
  /** The elected rung's detail, when the section declared one. */
  electedDetail?: string | number;
}

export interface ViewPlan {
  /** One pick per section, in section order. */
  picks: ViewPick[];
  /** Total charged, per dimension (includes over-budget floor elections). */
  spent: ViewCost;
  /** Sections elected below their richest rung. */
  evictions: ViewEviction[];
}

// ─── Guards (fail loud, never silently pass) ─────────────────────────────

function gateCost(cost: ViewCost, where: string): void {
  for (const [dim, v] of Object.entries(cost)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(
        `planView: ${where} has a non-finite or negative cost for '${dim}' (${String(v)})`,
      );
    }
  }
}

function gateSpec(view: ViewSpec): void {
  if (!view || !Array.isArray(view.sections)) {
    throw new Error("planView: view.sections must be an array");
  }
  const seen = new Set<string>();
  for (const s of view.sections) {
    if (!s || typeof s.id !== "string" || s.id.length === 0) {
      throw new Error("planView: every section needs a non-empty string id");
    }
    if (seen.has(s.id)) {
      throw new Error(`planView: duplicate section id '${s.id}'`);
    }
    seen.add(s.id);
    if (!Array.isArray(s.rungs) || s.rungs.length === 0) {
      throw new Error(
        `planView: section '${s.id}' offers no rungs — a section must offer at least its floor`,
      );
    }
    s.rungs.forEach((r, i) => gateCost(r.cost, `section '${s.id}' rung ${i}`));
  }
}

// ─── The evaluator ───────────────────────────────────────────────────────

function fits(spent: ViewCost, cost: ViewCost, budget: ViewCost): boolean {
  for (const [dim, cap] of Object.entries(budget)) {
    if ((spent[dim] ?? 0) + (cost[dim] ?? 0) > cap) return false;
  }
  return true;
}

function charge(spent: ViewCost, cost: ViewCost): void {
  for (const [dim, v] of Object.entries(cost)) spent[dim] = (spent[dim] ?? 0) + v;
}

function totalOf(cost: ViewCost): number {
  return Object.values(cost).reduce((s, v) => s + v, 0);
}

/**
 * Elect one rung per section under the budget. Pure and deterministic:
 * the same spec + budget always yields the same plan (a rendered surface
 * is a memoized derivation — R9; re-planning unchanged inputs must be a
 * byte-identical no-op).
 */
export function planView(view: ViewSpec, budget: ViewCost): ViewPlan {
  gateSpec(view);
  gateCost(budget, "budget");

  const spent: ViewCost = {};
  const picks: ViewPick[] = [];
  const evictions: ViewEviction[] = [];

  for (const section of view.sections) {
    let rung = section.rungs.findIndex((r) => fits(spent, r.cost, budget));
    let overBudget = false;
    if (rung === -1) {
      // Nothing fits: elect the cheapest (first-minimal) regardless — the
      // floor always renders; a zero-cost rung is how a section opts into
      // being droppable.
      let min = 0;
      for (let i = 1; i < section.rungs.length; i++) {
        if (totalOf(section.rungs[i].cost) < totalOf(section.rungs[min].cost)) min = i;
      }
      rung = min;
      overBudget = true;
    }
    const chosen = section.rungs[rung];
    charge(spent, chosen.cost);
    picks.push({ sectionId: section.id, rung, cost: { ...chosen.cost }, overBudget });
    if (rung > 0) {
      evictions.push({
        sectionId: section.id,
        richerRungs: Array.from({ length: rung }, (_, i) => i),
        ...(chosen.detail !== undefined ? { electedDetail: chosen.detail } : {}),
      });
    }
  }

  return { picks, spent, evictions };
}
