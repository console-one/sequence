import {
  type Constraint, impl,
} from '../../src/type';
import {
  type Sequence,
  type EmitterCtx,
  type BlockTemplate,
} from '../sequence';

// ═══════════════════════════════════════════════════════════════════════
// RELIABILITY — Bayesian-conjugate prior at _holders.{holder}.reliability.
//
// Observation rule on status transitions at _commitments.*.status:
//   'fulfilled' → α += 1
//   'violated'  → β += 1
//
// Default prior Beta(1, 1) uniform. Posterior-predictive mean α/(α+β) is
// queryable as ordinary substrate state.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sub-type discriminator for an input value. Coarse structural signature
 * to start — the whole point of the conditional-posterior pattern is
 * that this discriminator's granularity grows under observation via the
 * refinement-promotion rule (MDL-gated, future work). Every invocation
 * contributes to the conditional posterior at its current sub-type key.
 */
export function subtypeKey(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undef';
  const t = typeof v;
  if (t === 'boolean' || t === 'number' || t === 'string') return t;
  if (Array.isArray(v)) return 'arr';
  if (t === 'object') {
    const keys = Object.keys(v as object).sort().join(',');
    return `obj:${keys}`;
  }
  return 'unknown';
}

// ─── Candidate refiners ─────────────────────────────────────────────
//
// A refiner is a discriminator function that splits a parent sub-type
// into finer keys. Registered as type-state at
// `_holders.{holder}.refiners.{name}` plus an impl-registered function.
//
// All observations update BOTH the parent sub-type bucket AND the
// refined bucket (while `active` is still false). When the activation
// rule observes enough divergence + evidence across child buckets, it
// flips `active = true`. From that point, `holderReliability` uses the
// refined posterior, and the plan ranker discriminates by the finer
// key. The refiner's existence pre-activation is what lets the system
// observe "would this split be discriminating?" without committing to
// the split before the evidence is in.

type RefinerSpec = {
  parentKey: string;
  discriminator: string;   // impl id
  minEvidence: number;     // per child bucket before activation is admissible
  minDivergence: number;   // minimal reliability gap between any two buckets
  useMDL: boolean;         // if true, refinementPromote uses mdlGain instead
                           // of the divergence heuristic
  active?: boolean;
};

function getRefiners(seq: Sequence, holder: string): Array<{ name: string; spec: RefinerSpec }> {
  const base = `_holders.${holder}.refiners`;
  const names = seq.childSegments(base);
  const out: Array<{ name: string; spec: RefinerSpec }> = [];
  for (const name of names) {
    const spec: RefinerSpec = {
      parentKey: seq.get(`${base}.${name}.parentKey`) as string,
      discriminator: seq.get(`${base}.${name}.discriminator`) as string,
      minEvidence: (seq.get(`${base}.${name}.minEvidence`) as number) ?? 3,
      minDivergence: (seq.get(`${base}.${name}.minDivergence`) as number) ?? 0.3,
      useMDL: (seq.get(`${base}.${name}.useMDL`) as boolean) ?? false,
      active: (seq.get(`${base}.${name}.active`) as boolean) ?? false,
    };
    if (!spec.parentKey || !spec.discriminator) continue;
    out.push({ name, spec });
  }
  return out;
}

/**
 * Compute the refined sub-type key for an input. If any registered
 * refiner matches the coarse key and runs successfully, append its
 * discriminator's output. Used at BOTH write time (to pick which
 * refined bucket to record evidence against) and at read time (to pick
 * which bucket to read from, IF active).
 */
export function resolveSubtype(
  seq: Sequence,
  holder: string,
  value: unknown,
  requireActive: boolean,
): string {
  const coarse = subtypeKey(value);
  for (const r of getRefiners(seq, holder)) {
    if (r.spec.parentKey !== coarse) continue;
    if (requireActive && !r.spec.active) continue;
    const fn = seq.impls.get(r.spec.discriminator);
    if (typeof fn !== 'function') continue;
    let refined: unknown;
    try { refined = fn(value); } catch { continue; }
    if (typeof refined === 'string') return `${coarse}/${refined}`;
  }
  return coarse;
}

/**
 * Register a candidate refiner. The refiner's buckets accumulate
 * evidence from now on; activation is automatic when the gating function
 * passes (see `refinementPromote`). Two gates are supported:
 *
 *   useMDL: false (default) — heuristic. Activate when the max-min
 *     posterior-mean divergence across child buckets meets `minDivergence`
 *     and every observed bucket has at least `minEvidence` observations.
 *
 *   useMDL: true — principled. Activate when the BIC-form MDL gain of
 *     the split model over the parent (single-bucket) model exceeds 0,
 *     subject to the same `minEvidence` floor. The gain function is
 *     `mdlGain(parent, children)` exported below.
 */
export function registerRefiner(
  seq: Sequence,
  holder: string,
  name: string,
  config: {
    parentKey: string;
    discriminator: string;
    minEvidence?: number;
    minDivergence?: number;
    useMDL?: boolean;
  },
): void {
  const base = `_holders.${holder}.refiners.${name}`;
  seq.insert({ path: `${base}.parentKey`, value: config.parentKey });
  seq.insert({ path: `${base}.discriminator`, value: config.discriminator });
  seq.insert({ path: `${base}.minEvidence`, value: config.minEvidence ?? 3 });
  seq.insert({ path: `${base}.minDivergence`, value: config.minDivergence ?? 0.3 });
  seq.insert({ path: `${base}.useMDL`, value: !!config.useMDL });
  seq.insert({ path: `${base}.active`, value: false });
}

/**
 * MDL gain for a candidate split: BIC-style comparison of the
 * single-distribution parent model against the per-child split model.
 *
 *   gain = (LL_split − LL_parent) − 0.5 · (k_split − 1) · ln(n)
 *
 * LL is computed with the empirical (prior-smoothed) posterior mean
 * `α / (α+β)` per bucket. `k_split` is the number of child buckets,
 * `n` is the total observations across all children.
 *
 * Activate the split iff `mdlGain > 0`. Returns -Infinity for
 * degenerate inputs (no observations, or empirical p in {0,1} that
 * collapses log-likelihood).
 */
export function mdlGain(
  children: { alpha: number; beta: number }[],
): number {
  if (children.length < 2) return -Infinity;

  const succ = children.map(c => Math.max(0, c.alpha - 1));
  const fail = children.map(c => Math.max(0, c.beta - 1));
  const n = succ.reduce((s, x, i) => s + x + fail[i], 0);
  if (n <= 0) return -Infinity;

  const llBernoulli = (s: number, f: number, p: number): number => {
    if (s === 0 && f === 0) return 0;
    if (p <= 0 || p >= 1) return -Infinity;
    return s * Math.log(p) + f * Math.log(1 - p);
  };

  // Parent: pool all observations into one Beta. p_hat from posterior
  // mean using flat (1,1) prior.
  const totalSucc = succ.reduce((s, x) => s + x, 0);
  const totalFail = fail.reduce((s, x) => s + x, 0);
  const pParent = (totalSucc + 1) / (totalSucc + totalFail + 2);
  const llParent = llBernoulli(totalSucc, totalFail, pParent);

  // Split: per-child posterior mean.
  let llSplit = 0;
  for (let i = 0; i < children.length; i++) {
    const a = children[i].alpha;
    const b = children[i].beta;
    const p = a / (a + b);
    const term = llBernoulli(succ[i], fail[i], p);
    if (!Number.isFinite(term)) return -Infinity;
    llSplit += term;
  }

  // BIC penalty for k_split − 1 extra params (k_parent = 1).
  const penalty = 0.5 * (children.length - 1) * Math.log(n);

  return (llSplit - llParent) - penalty;
}

/**
 * Fulfillment / violation updates THREE posteriors:
 *   - aggregate at `_holders.{holder}.reliability.{α,β}` (marginal)
 *   - coarse conditional at `_holders.{holder}.subtype.{coarse}.reliability.{α,β}`
 *   - refined conditional at `_holders.{holder}.subtype.{coarse/refined}.reliability.{α,β}`
 *     (one per registered refiner whose parentKey matches, regardless of
 *     activation — the whole point is observing the split's gain before
 *     committing to it)
 *
 * Sub-type keys are computed from the durable per-commitment input at
 * `_commitments.{id}.input`.
 */
export function reliabilityUpdate(ctx: EmitterCtx): BlockTemplate[] {
  const { cell, delta, seq } = ctx;
  if (delta.kind !== 'value') return [];
  const m = cell.path.match(/^_commitments\.([^.]+)\.status$/);
  if (!m) return [];

  const id = m[1];
  const holder = seq.get(`_commitments.${id}.holder`) as string | undefined;
  if (!holder) return [];

  const input = seq.get(`_commitments.${id}.input`);
  const coarse = subtypeKey(input);

  // Collect refined sub-type suffixes for ALL registered refiners whose
  // parentKey matches. Bucket writes happen under
  // `_holders.{holder}.subtype.{suffix}.{reliability,latency}.*`.
  const suffixes = [coarse];
  for (const r of getRefiners(seq, holder)) {
    if (r.spec.parentKey !== coarse) continue;
    const fn = seq.impls.get(r.spec.discriminator);
    if (typeof fn !== 'function') continue;
    let refined: unknown;
    try { refined = fn(input); } catch { continue; }
    if (typeof refined !== 'string') continue;
    suffixes.push(`${coarse}/${refined}`);
  }

  const out: BlockTemplate[] = [];
  const aggBase = `_holders.${holder}.reliability`;

  if (delta.next === 'fulfilled') {
    const aggA = (seq.get(`${aggBase}.alpha`) as number) ?? 1;
    out.push({ path: `${aggBase}.alpha`, value: aggA + 1 });
    for (const sfx of suffixes) {
      const b = `_holders.${holder}.subtype.${sfx}.reliability`;
      const v = (seq.get(`${b}.alpha`) as number) ?? 1;
      out.push({ path: `${b}.alpha`, value: v + 1 });
    }
    // Latency posterior: running mean over fulfillment durations.
    // Welford's online algorithm tracks mean and M2 (sum of squared
    // deviations) so variance is retrievable without storing the full
    // observation history. Update aggregate + every suffix.
    const lat = seq.get(`_commitments.${id}.latencyMs`);
    if (typeof lat === 'number') {
      updateRunningMean(out, seq, `_holders.${holder}.latency`, lat);
      for (const sfx of suffixes) {
        updateRunningMean(out, seq, `_holders.${holder}.subtype.${sfx}.latency`, lat);
      }
    }
  } else if (delta.next === 'violated') {
    const aggB = (seq.get(`${aggBase}.beta`) as number) ?? 1;
    out.push({ path: `${aggBase}.beta`, value: aggB + 1 });
    for (const sfx of suffixes) {
      const b = `_holders.${holder}.subtype.${sfx}.reliability`;
      const v = (seq.get(`${b}.beta`) as number) ?? 1;
      out.push({ path: `${b}.beta`, value: v + 1 });
    }
    // Violations contribute no latency observation (no successful
    // duration to learn from).
  }
  return out;
}

/**
 * Welford's online update for (count, mean, M2). Emits mount templates
 * for the three fields at `{base}.{count,mean,m2}`. Variance is
 * computed on read as `m2 / (count - 1)` (sample variance).
 */
function updateRunningMean(
  out: BlockTemplate[],
  seq: Sequence,
  base: string,
  observation: number,
): void {
  const count = ((seq.get(`${base}.count`) as number) ?? 0) + 1;
  const prevMean = (seq.get(`${base}.mean`) as number) ?? 0;
  const delta = observation - prevMean;
  const newMean = prevMean + delta / count;
  const prevM2 = (seq.get(`${base}.m2`) as number) ?? 0;
  const newM2 = prevM2 + delta * (observation - newMean);
  out.push({ path: `${base}.count`, value: count });
  out.push({ path: `${base}.mean`, value: newMean });
  out.push({ path: `${base}.m2`, value: newM2 });
}

/**
 * Refinement-promotion rule. On every commitment status transition,
 * scan the holder's candidate (non-active) refiners. For each, evaluate
 * the activation gate against the child buckets' current posteriors.
 *
 * Two gates supported (per refiner spec; see `registerRefiner`):
 *   useMDL=false → divergence heuristic: activate when the max-min
 *     posterior-mean gap across children meets `minDivergence` and every
 *     observed child has ≥ `minEvidence` observations.
 *   useMDL=true  → MDL gain: activate when `mdlGain(children) > 0`,
 *     still subject to the `minEvidence` floor.
 *
 * Activation is a single mount at `_holders.{holder}.refiners.{name}.active = true`.
 * From that mount forward, `resolveSubtype(requireActive=true)` picks
 * the refined key, and readers see the finer posterior.
 */
function refinementPromote(ctx: EmitterCtx): BlockTemplate[] {
  const { cell, delta, seq } = ctx;
  if (delta.kind !== 'value') return [];
  const m = cell.path.match(/^_commitments\.([^.]+)\.status$/);
  if (!m) return [];
  if (delta.next !== 'fulfilled' && delta.next !== 'violated') return [];

  const id = m[1];
  const holder = seq.get(`_commitments.${id}.holder`) as string | undefined;
  if (!holder) return [];

  const out: BlockTemplate[] = [];
  for (const r of getRefiners(seq, holder)) {
    if (r.spec.active) continue;

    // Enumerate child buckets under this refiner's parentKey.
    const subtypeBase = `_holders.${holder}.subtype`;
    const childKeys = seq.childSegments(subtypeBase)
      .filter(k => k.startsWith(`${r.spec.parentKey}/`));
    if (childKeys.length < 2) continue;

    // Read each bucket's posterior. Apply the minEvidence floor first
    // — it gates both heuristic and MDL paths.
    const buckets: { alpha: number; beta: number }[] = [];
    let allMeetEvidence = true;
    for (const k of childKeys) {
      const a = (seq.get(`${subtypeBase}.${k}.reliability.alpha`) as number) ?? 1;
      const b = (seq.get(`${subtypeBase}.${k}.reliability.beta`) as number) ?? 1;
      const evidence = (a - 1) + (b - 1);
      if (evidence < r.spec.minEvidence) { allMeetEvidence = false; break; }
      buckets.push({ alpha: a, beta: b });
    }
    if (!allMeetEvidence) continue;

    let activate: boolean;
    if (r.spec.useMDL) {
      activate = mdlGain(buckets) > 0;
    } else {
      let minMean = Infinity;
      let maxMean = -Infinity;
      for (const { alpha, beta } of buckets) {
        const mean = alpha / (alpha + beta);
        if (mean < minMean) minMean = mean;
        if (mean > maxMean) maxMean = mean;
      }
      activate = (maxMean - minMean) >= r.spec.minDivergence;
    }
    if (!activate) continue;

    out.push({
      path: `_holders.${holder}.refiners.${r.name}.active`,
      value: true,
    });
  }
  return out;
}

export function installRefinement(seq: Sequence): void {
  seq.emitters.set('refinement.promote', refinementPromote);
  seq.insert({
    path: '_rules.refinement_promote',
    rules: [{
      id: 'refinement_promote',
      phase: 'observation',
      scope: '',
      when: { op: 'deltaKindIs', args: ['value'] },
      emit: 'refinement.promote',
    }],
  });
}


// ═══════════════════════════════════════════════════════════════════════
// POSTERIORADMIT — evidence-conditioned admission.
//
// Reads Beta(α, β) at `${base}.alpha` and `${base}.beta`; admits iff
// posterior mean α/(α+β) ≥ threshold. Registered as a guard op; usable
// in any admission rule's `when`.
// ═══════════════════════════════════════════════════════════════════════

export function posteriorAdmit(base: string, threshold = 0.5): Constraint {
  return { op: 'posteriorAdmit', args: [base, threshold] };
}

/**
 * Constructor for the `limit` admission predicate. Use as a `when` clause
 * on admission rules:
 *
 *   s.insert({
 *     path: '_rules.publish_quota',
 *     rules: [{
 *       id: 'publish_quota',
 *       phase: 'admission',
 *       scope: 'publish_request',
 *       when: limit('_meters.calls.alice.<window>', 50),
 *     }],
 *   });
 *
 * Admits while `(seq.get(meterPath) ?? 0) + delta < limit`. Pair with
 * `<<` writes to the meter cell at admission/completion lifecycle points
 * to compose calls / tokens / in-flight singleton / bytes / etc. — same
 * primitive at every scale.
 */
export function limit(meterPath: string, max: number, delta = 1): Constraint {
  return { op: 'limit', args: [meterPath, max, delta] };
}

/**
 * Constructor for `meterAt` — declares "this rule cares about the meter
 * at X." No admission impact; used to wire dependency-graph edges
 * cleanly when a rule's body needs the meter value but doesn't gate on it.
 */
export function meterAt(meterPath: string): Constraint {
  return { op: 'meterAt', args: [meterPath] };
}

