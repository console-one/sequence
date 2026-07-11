/**
 * select.ts — standalone selection under prices (R8/R5; the attention
 * market's evaluator).
 *
 * ONE EXPORT: selectUnderPrices(candidates, capacities, opts?) — given a
 * flat set of candidates (each with a value and a multi-dimensional cost)
 * and declared capacities (budgets per cost dimension), elect the subset
 * to admit and RETURN THE DUAL PRICES alongside it. The duals are the
 * point, not a by-product: they are the readable "what attention costs
 * right now" facts the product surfaces and stores (MAP-ATTENTION-MARKET:
 * capacities declared, prices DERIVED, estimators measured).
 *
 * PROVENANCE (recovered, not rebuilt): the selection core is extracted
 * from the archived @console-one/compile package's selector — vendored
 * copy last at observatory-app `e045e23^:src/core/cli/vendor/compile.ts`
 * (deleted when seam-5 migrated its GREEDY semantics into view.ts's
 * planView; the beam/Lagrangian strategies stayed archived "until
 * measured prices exist to feed them"). This module is that recorded
 * re-adoption trigger firing (observatory TECH-DEBT #6) — the attention
 * market is the first consumer that needs the prices themselves.
 *
 * WHAT CHANGED IN THE RE-CUT (document graph → flat market):
 *   - compile selected one candidate per SITE of a document graph, with
 *     per-section budgets, inline/hoisted cost attribution, and ref
 *     propagation. The attention binding is flat: each candidate is
 *     independently in or out, all bidding against ONE set of shared
 *     capacities. Per-(section,dim) λ collapses to per-dimension λ;
 *     "pick best candidate at a site under linear pricing" becomes
 *     "admit iff value − Σ λ·cost > 0" (the exclude option is the
 *     implicit zero-value, zero-cost sibling).
 *   - candidates with value ≤ 0 are never admitted — a bid must claim
 *     positive value to buy capacity (estimators earn/lose that claim's
 *     weight elsewhere, via d; this evaluator prices, it does not judge).
 *   - value/costs are plain finite numbers at this layer; curve →
 *     expectation happens in the CONSUMER before the call (the same
 *     boundary evaluate.ts draws for its state argument).
 *
 * CORRECTIONS TO THE ORIGINAL (verified by the test suite, not assumed):
 *   1. Non-finite capacities: the original's subgradient normalization
 *      (`step·(used − cap)/max(1,|cap|)`) is NaN when cap = Infinity.
 *      Unconstrained dimensions now never enter λ (their price is
 *      identically 0) and never violate.
 *   2. Primal repair gains a DROP phase and keeps the SWAP phase: the
 *      original repair only upgraded in place, so an infeasible final
 *      iterate could be returned infeasible. Flat selection always has
 *      a feasible point (∅ when capacities ≥ 0), so repair first sheds
 *      lowest-density admits until feasible, then greedily re-admits,
 *      then local-polishes with add + 1-for-1 swap moves — necessary,
 *      not cosmetic: relaxed iterates are density-threshold sets by
 *      construction, so optima that trade a dense bid for a valuable
 *      one are reachable only by explicit exchange (regression-pinned
 *      by the knapsack tests). `feasible: false` therefore only ever
 *      reports a malformed market.
 *   3. Subgradient with a constant step is not monotone (the original
 *      said so); the best-feasible-iterate tracking is kept, and the
 *      fixed-point early exit now also stops on λ oscillating between
 *      two states (period-2 cycle), which the flat binding makes common
 *      when identical candidates share one price — the block-flip case
 *      the original's repair comment records.
 *
 * The block-flip failure mode (kept verbatim in spirit from the original
 * comment): a feasible Lagrangian iterate is often a uniform "all-in /
 * all-out" selection because every candidate sees the same dual prices
 * and flips together. Repair walks the selection and greedily admits
 * individual candidates in value-density order while capacity holds.
 *
 * FAIL-LOUD (the evaluate.ts/elect.ts idiom): duplicate ids, non-finite
 * values/costs, negative costs, and negative capacities throw named
 * errors. A silent bad market would set silent bad prices.
 */

// ─── The vocabulary ──────────────────────────────────────────────────────

/** One bid: admit me (value) at this multi-dimensional cost. */
export interface SelectCandidate {
  /** Stable id — the consumer keys admissions by this. */
  id: string;
  /** The claimed value of admitting this candidate. Bids with value ≤ 0
   *  are never admitted. Curve-valued estimates reduce to an expectation
   *  BEFORE this call. */
  value: number;
  /** Cost per capacity dimension, e.g. `{interrupts: 1, tokens: 140}`.
   *  Dimensions absent from `capacities` are unconstrained (free). */
  costs: Record<string, number>;
}

/** Declared budgets per dimension. `Infinity` = declared-unbounded (its
 *  dual price is identically 0). Dimensions no candidate charges are
 *  slack by definition. */
export type SelectCapacities = Record<string, number>;

export interface SelectOptions {
  /** Default 'lagrangian' — the only strategy that derives prices.
   *  'greedy'/'beam' are cheap baselines: they select but their duals
   *  are all-zero (they never price anything). */
  strategy?: 'lagrangian' | 'greedy' | 'beam';
  /** Subgradient iterations. Default 30 (the original's default). */
  iterations?: number;
  /** Subgradient step size. Default 0.5 (the original's default). */
  stepSize?: number;
  /** Beam width for strategy 'beam'. Default 8. */
  beamWidth?: number;
}

export interface SelectResult {
  /** Admitted candidate ids, in input order. */
  selected: string[];
  /** The dual price per CONSTRAINED capacity dimension — what one unit
   *  of that capacity is worth under current competition. 0 = slack
   *  (admitting one more marginal bid costs nothing); rising duals ARE
   *  saturation. Unconstrained (Infinity) dimensions report 0. */
  duals: Record<string, number>;
  /** True iff the returned selection respects every capacity. For valid
   *  inputs this is always true (∅ is feasible); false only ever
   *  accompanies a market that could not be repaired. */
  feasible: boolean;
  /** Subgradient iterations actually run (0 for greedy/beam). */
  iterations: number;
}

// ─── Validation (fail-loud) ──────────────────────────────────────────────

function validate(candidates: SelectCandidate[], capacities: SelectCapacities): void {
  const seen = new Set<string>();
  for (const c of candidates) {
    if (typeof c.id !== 'string' || c.id.length === 0) {
      throw new Error(`selectUnderPrices: candidate with missing id`);
    }
    if (seen.has(c.id)) {
      throw new Error(`selectUnderPrices: duplicate candidate id '${c.id}'`);
    }
    seen.add(c.id);
    if (typeof c.value !== 'number' || !Number.isFinite(c.value)) {
      throw new Error(`selectUnderPrices: candidate '${c.id}' has non-finite value`);
    }
    for (const [dim, v] of Object.entries(c.costs)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(
          `selectUnderPrices: candidate '${c.id}' cost '${dim}' must be a finite number ≥ 0`,
        );
      }
    }
  }
  for (const [dim, cap] of Object.entries(capacities)) {
    if (typeof cap !== 'number' || Number.isNaN(cap) || cap < 0) {
      throw new Error(
        `selectUnderPrices: capacity '${dim}' must be a number ≥ 0 (Infinity = unbounded)`,
      );
    }
  }
}

// ─── Shared cost accounting ──────────────────────────────────────────────

/** Dimensions that actually constrain: declared, finite. */
function constrainedDims(capacities: SelectCapacities): string[] {
  return Object.keys(capacities).filter((d) => Number.isFinite(capacities[d]));
}

function usedByDim(
  candidates: SelectCandidate[],
  admitted: ReadonlySet<string>,
  dims: string[],
): Record<string, number> {
  const used: Record<string, number> = {};
  for (const d of dims) used[d] = 0;
  for (const c of candidates) {
    if (!admitted.has(c.id)) continue;
    for (const d of dims) used[d] += c.costs[d] ?? 0;
  }
  return used;
}

function violates(
  used: Record<string, number>,
  capacities: SelectCapacities,
  dims: string[],
): boolean {
  for (const d of dims) {
    if (used[d] > capacities[d]) return true;
  }
  return false;
}

function totalValue(candidates: SelectCandidate[], admitted: ReadonlySet<string>): number {
  let v = 0;
  for (const c of candidates) if (admitted.has(c.id)) v += c.value;
  return v;
}

/** Summed cost over CONSTRAINED dims (density denominator). Zero-cost
 *  bids have infinite density — always admitted first. */
function constrainedCost(c: SelectCandidate, dims: string[]): number {
  let s = 0;
  for (const d of dims) s += c.costs[d] ?? 0;
  return s;
}

// ─── Greedy (baseline; prices nothing) ───────────────────────────────────

// Greedy: admit in value order while capacity holds. Single-pass,
// deterministic, no backtracking — the original's greedy, flat.
function selectGreedySet(
  candidates: SelectCandidate[],
  capacities: SelectCapacities,
  dims: string[],
): Set<string> {
  const admitted = new Set<string>();
  const order = [...candidates]
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  for (const c of order) {
    admitted.add(c.id);
    const used = usedByDim(candidates, admitted, dims);
    if (violates(used, capacities, dims)) admitted.delete(c.id);
  }
  return admitted;
}

// ─── Beam (baseline; prices nothing) ─────────────────────────────────────

// Beam search: maintain top-K partial selections, expanding one candidate
// at a time (in/out branches), pruning budget violations; the beam keeps
// the K highest-value successors. Order of expansion is deterministic
// (input order), which makes states' values comparable at every step —
// the original's invariant, kept.
function selectBeamSet(
  candidates: SelectCandidate[],
  capacities: SelectCapacities,
  dims: string[],
  beamWidth: number,
): Set<string> {
  type State = { admitted: Set<string>; used: Record<string, number>; value: number };
  const K = Math.max(1, beamWidth);
  let beam: State[] = [
    { admitted: new Set(), used: usedByDim(candidates, new Set(), dims), value: 0 },
  ];

  for (const c of candidates) {
    const expanded: State[] = [];
    for (const state of beam) {
      // exclude branch — always feasible.
      expanded.push(state);
      // include branch — prune violations; never admit value ≤ 0.
      if (c.value <= 0) continue;
      const used = { ...state.used };
      for (const d of dims) used[d] += c.costs[d] ?? 0;
      if (violates(used, capacities, dims)) continue;
      const admitted = new Set(state.admitted);
      admitted.add(c.id);
      expanded.push({ admitted, used, value: state.value + c.value });
    }
    expanded.sort((a, b) => b.value - a.value);
    beam = expanded.slice(0, K);
  }

  return beam[0]!.admitted;
}

// ─── Lagrangian (the strategy that derives prices) ───────────────────────

// Admit iff value − Σ λ[dim]·cost[dim] > 0 — "pick best candidate at a
// site under linear pricing (Lagrangian dual)", flat: the exclude option
// is the implicit zero-value, zero-cost sibling, so the tie at exactly 0
// excludes (capacity is never spent for nothing).
function relaxedAdmit(
  candidates: SelectCandidate[],
  lambda: Record<string, number>,
  dims: string[],
): Set<string> {
  const admitted = new Set<string>();
  for (const c of candidates) {
    if (c.value <= 0) continue;
    let penalty = 0;
    for (const d of dims) penalty += (lambda[d] ?? 0) * (c.costs[d] ?? 0);
    if (c.value - penalty > 0) admitted.add(c.id);
  }
  return admitted;
}

// Primal repair: a feasible Lagrangian iterate is often a uniform
// "all-in / all-out" selection because every candidate sees the same
// dual prices and flips together. Repair (1) sheds lowest-density
// admits until feasible — the DROP phase the original lacked — then
// (2) greedily re-admits individual candidates in value-density order
// as long as capacity holds.
function primalRepair(
  candidates: SelectCandidate[],
  initial: ReadonlySet<string>,
  capacities: SelectCapacities,
  dims: string[],
): Set<string> {
  const admitted = new Set(initial);

  // (1) shed until feasible: lowest value-per-constrained-cost first.
  let used = usedByDim(candidates, admitted, dims);
  if (violates(used, capacities, dims)) {
    const byDensityAsc = [...candidates]
      .filter((c) => admitted.has(c.id))
      .sort((a, b) => {
        const da = a.value / Math.max(constrainedCost(a, dims), 1e-12);
        const db = b.value / Math.max(constrainedCost(b, dims), 1e-12);
        return da - db || a.id.localeCompare(b.id);
      });
    for (const c of byDensityAsc) {
      if (!violates(used, capacities, dims)) break;
      admitted.delete(c.id);
      used = usedByDim(candidates, admitted, dims);
    }
  }

  // (2) greedy upgrade: highest density first, admit while feasible.
  const byDensityDesc = [...candidates]
    .filter((c) => c.value > 0 && !admitted.has(c.id))
    .sort((a, b) => {
      const da = a.value / Math.max(constrainedCost(a, dims), 1e-12);
      const db = b.value / Math.max(constrainedCost(b, dims), 1e-12);
      return db - da || a.id.localeCompare(b.id);
    });
  for (const c of byDensityDesc) {
    admitted.add(c.id);
    used = usedByDim(candidates, admitted, dims);
    if (violates(used, capacities, dims)) {
      admitted.delete(c.id);
      used = usedByDim(candidates, admitted, dims);
    }
  }

  // (3) local polish — the flat analog of the original's swap phase
  // ("greedily upgrades individual sites to higher-fidelity candidates
  // as long as budget holds"). Relaxed iterates are density-threshold
  // sets by construction, so optima that exchange a dense bid for a
  // valuable one are reachable ONLY by explicit 1-for-1 swaps. Moves:
  // best feasible ADD, else best feasible value-improving SWAP. Bounded
  // like the original (guard = 4n) in case value ties cycle.
  const positive = candidates.filter((x) => x.value > 0);
  let guard = positive.length * 4;
  let improved = true;
  while (improved && guard-- > 0) {
    improved = false;

    // Best feasible add.
    let bestAdd: SelectCandidate | null = null;
    for (const cand of positive) {
      if (admitted.has(cand.id)) continue;
      admitted.add(cand.id);
      const trial = usedByDim(candidates, admitted, dims);
      admitted.delete(cand.id);
      if (violates(trial, capacities, dims)) continue;
      if (!bestAdd || cand.value > bestAdd.value ||
          (cand.value === bestAdd.value && cand.id.localeCompare(bestAdd.id) < 0)) {
        bestAdd = cand;
      }
    }
    if (bestAdd) {
      admitted.add(bestAdd.id);
      used = usedByDim(candidates, admitted, dims);
      improved = true;
      continue;
    }

    // Best feasible value-improving 1-for-1 swap.
    let bestSwap: { out: string; in: SelectCandidate; gain: number } | null = null;
    for (const outCand of positive) {
      if (!admitted.has(outCand.id)) continue;
      for (const inCand of positive) {
        if (admitted.has(inCand.id)) continue;
        const gain = inCand.value - outCand.value;
        if (gain <= 0) continue;
        admitted.delete(outCand.id);
        admitted.add(inCand.id);
        const trial = usedByDim(candidates, admitted, dims);
        admitted.delete(inCand.id);
        admitted.add(outCand.id);
        if (violates(trial, capacities, dims)) continue;
        if (!bestSwap || gain > bestSwap.gain) bestSwap = { out: outCand.id, in: inCand, gain };
      }
    }
    if (bestSwap) {
      admitted.delete(bestSwap.out);
      admitted.add(bestSwap.in.id);
      used = usedByDim(candidates, admitted, dims);
      improved = true;
    }
  }

  return admitted;
}

function lambdaKey(lambda: Record<string, number>, dims: string[]): string {
  return dims.map((d) => `${d}:${lambda[d].toFixed(9)}`).join('|');
}

// Lagrangian relaxation: dualize the capacity constraints. Per candidate,
// admit iff (value − λ·cost) > 0. Compute realized usage, update λ via
// subgradient (raise prices on over-bound dimensions, relax on slack —
// clamped at 0; step normalized by cap so dimensions with very different
// magnitudes converge at similar rates). Iterate. Track the best feasible
// selection seen — convergence is subgradient, not monotone, so we always
// return the best feasible iterate (repaired), falling back to the final
// iterate if no feasible one was found within the iteration budget.
function selectLagrangianSet(
  candidates: SelectCandidate[],
  capacities: SelectCapacities,
  dims: string[],
  iterations: number,
  stepSize: number,
): { admitted: Set<string>; duals: Record<string, number>; iterations: number } {
  const lambda: Record<string, number> = {};
  for (const d of dims) lambda[d] = 0;

  let bestFeasible: Set<string> | null = null;
  let bestValue = -Infinity;
  let bestLambda: Record<string, number> = { ...lambda };
  let last: Set<string> = relaxedAdmit(candidates, lambda, dims);
  let ran = 0;

  const seenLambdas = new Set<string>([lambdaKey(lambda, dims)]);

  for (let iter = 0; iter < iterations; iter++) {
    ran = iter + 1;
    const admitted = relaxedAdmit(candidates, lambda, dims);
    last = admitted;
    const used = usedByDim(candidates, admitted, dims);

    if (!violates(used, capacities, dims)) {
      const v = totalValue(candidates, admitted);
      if (v > bestValue) {
        bestValue = v;
        bestFeasible = new Set(admitted);
        bestLambda = { ...lambda };
      }
    }

    // Subgradient update on λ. Each over-bound dimension raises its dual
    // price; slack lowers it (clamped at 0).
    let anyChange = false;
    for (const d of dims) {
      const subgradient = used[d] - capacities[d]; // > 0 when over-bound
      const norm = Math.max(1, Math.abs(capacities[d]));
      const updated = Math.max(0, lambda[d] + (stepSize * subgradient) / norm);
      if (updated !== lambda[d]) {
        lambda[d] = updated;
        anyChange = true;
      }
    }

    if (!anyChange) break; // fixed point

    // Period-detection: constant-step subgradient commonly enters a
    // 2-cycle in the flat binding (identical candidates flip together).
    // Re-visiting any λ means the trajectory repeats — stop; the
    // best-feasible tracker already holds the answer.
    const key = lambdaKey(lambda, dims);
    if (seenLambdas.has(key)) break;
    seenLambdas.add(key);
  }

  // The duals reported are the prices at the iterate we RETURN — the
  // best feasible one when it exists (its λ is the price vector that
  // produced it), else the final λ.
  const chosen = bestFeasible ?? last;
  const duals = bestFeasible ? bestLambda : { ...lambda };
  return { admitted: chosen, duals, iterations: ran };
}

// ─── The one export ──────────────────────────────────────────────────────

export function selectUnderPrices(
  candidates: SelectCandidate[],
  capacities: SelectCapacities,
  opts: SelectOptions = {},
): SelectResult {
  validate(candidates, capacities);
  const dims = constrainedDims(capacities);
  const strategy = opts.strategy ?? 'lagrangian';

  // Duals report every DECLARED dimension (unbounded ones at 0) so the
  // consumer can store one price fact per declared capacity.
  const zeroDuals = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const d of Object.keys(capacities)) out[d] = 0;
    return out;
  };

  const finish = (
    admittedSet: Set<string>,
    duals: Record<string, number>,
    iterations: number,
  ): SelectResult => {
    const used = usedByDim(candidates, admittedSet, dims);
    return {
      selected: candidates.filter((c) => admittedSet.has(c.id)).map((c) => c.id),
      duals,
      feasible: !violates(used, capacities, dims),
      iterations,
    };
  };

  if (strategy === 'greedy') {
    return finish(selectGreedySet(candidates, capacities, dims), zeroDuals(), 0);
  }
  if (strategy === 'beam') {
    return finish(
      selectBeamSet(candidates, capacities, dims, opts.beamWidth ?? 8),
      zeroDuals(),
      0,
    );
  }

  const iterations = Math.max(1, opts.iterations ?? 30);
  const stepSize = opts.stepSize ?? 0.5;
  const lag = selectLagrangianSet(candidates, capacities, dims, iterations, stepSize);
  const repaired = primalRepair(candidates, lag.admitted, capacities, dims);

  const duals = zeroDuals();
  for (const d of dims) duals[d] = lag.duals[d] ?? 0;
  return finish(repaired, duals, lag.iterations);
}
