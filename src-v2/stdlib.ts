/**
 * stdlib.ts (v2) — feature rules mounted on a principled kernel.
 *
 * Every capability this module provides — commitment election, Bayesian
 * reliability tracking, posteriorAdmit admission, indexSpec self-
 * instantiating classes — is installed as:
 *   (a) one or more runtime-registered emitter functions, and
 *   (b) one or more declarative Rule values mounted at scope.
 *
 * The kernel is touched NOWHERE by this file. Each feature can be
 * toggled off by omitting its install() call. Features compose — order
 * of install doesn't matter.
 *
 * The discipline this file holds: when a new feature is proposed, the
 * first question is "can it be a rule?" The answer is almost always
 * yes, and this file demonstrates it.
 */

import { type Constraint, type Type, constraintOf } from '../src/type';
import { covers, check } from '../src/compose';
import {
  type Sequence,
  type EmitterCtx,
  type Rule,
  type BlockTemplate,
} from './sequence';

// ═══════════════════════════════════════════════════════════════════════
// COMMITMENT — every fn-typed invocation elects a write-lease record.
//
// Canonical fields at _commitments.{id}:
//   typeRef, holder, head, control, status, latencyMs, violateReason?
//
// Rule phase: observation (fires after compose produces an invocation
// delta, emits record + .input + .result/.error + status).
// ═══════════════════════════════════════════════════════════════════════

export const COMMITMENT_PREFIX = '_commitments';

/**
 * Extract a deadline from an fn type's temporal constraint if present.
 * Supported shapes:
 *   temporal('lt', '_rt', <number>)  — absolute deadline timestamp
 *   temporal('lt', '_rt', { add: ['_rt', <ms>] }) — relative to now
 *
 * MVP: these are the two common shapes. Richer expressions go through
 * a future stdlib expression evaluator.
 */
function extractDeadline(t: Type | undefined, nowMs: number): number | undefined {
  if (!t) return undefined;
  const temporal = constraintOf(t, 'temporal');
  if (!temporal) return undefined;
  const [dir, lhs, bound] = temporal.args;
  if (dir !== 'lt' || lhs !== '_rt') return undefined;
  if (typeof bound === 'number') return bound;
  if (bound && typeof bound === 'object' && 'add' in (bound as any)) {
    const terms = (bound as { add: unknown[] }).add;
    let sum = 0;
    for (const term of terms) {
      if (term === '_rt') sum += nowMs;
      else if (typeof term === 'number') sum += term;
    }
    return sum;
  }
  return undefined;
}

function electCommitment(ctx: EmitterCtx): BlockTemplate[] {
  const { cell, delta, seq } = ctx;
  const id = `c_${seq.nextSequence()}`;
  const recordPath = `${COMMITMENT_PREFIX}.${id}`;
  const input = delta.next;
  const holder = cell.path;
  const head = `${cell.path}.result`;

  const out: BlockTemplate[] = [
    { path: `${recordPath}.typeRef`, value: holder },
    { path: `${recordPath}.holder`, value: holder },
    { path: `${recordPath}.head`, value: head },
    { path: `${recordPath}.control`, value: `${recordPath}.control` },
    { path: `${cell.path}.input`, value: input },
    // Per-commitment input record — durable across concurrent invocations
    // and the data that reliabilityUpdate uses to compute input sub-type
    // for conditional-posterior update. Without this, a second invocation
    // at the same fn cell would overwrite `.input` before the first's
    // fulfillment cascade can classify it.
    { path: `${recordPath}.input`, value: input },
  ];

  // Deadline watch: if the fn type declares a temporal upper bound on
  // _rt, mount (a) the absolute deadline field on the record and (b) a
  // where-gated block that will fire when the clock crosses it, flipping
  // status pending → violated. The gate AND-checks that status is still
  // pending, so a commitment that fulfilled before the deadline is
  // unaffected.
  const deadline = extractDeadline(cell.type, seq.now());
  if (deadline !== undefined) {
    out.push({ path: `${recordPath}.deadline`, value: deadline });
    out.push({
      path: `${recordPath}.violateReason`,
      value: 'deadline_exceeded',
      where: [
        { op: 'gt', args: ['_rt', deadline] },
        { op: 'eq', args: [`${recordPath}.status`, 'pending'] },
      ],
    });
    out.push({
      path: `${recordPath}.status`,
      value: 'violated',
      where: [
        { op: 'gt', args: ['_rt', deadline] },
        { op: 'eq', args: [`${recordPath}.status`, 'pending'] },
      ],
    });
  }

  // Resolve and run impl. Direct path lookup + impl() constraint.
  const impl = resolveImpl(cell, seq);
  if (typeof impl !== 'function') {
    // External holder case: record pending, wait for someone to fulfill
    // the head path out-of-band (e.g. remote agent, Lambda, user).
    out.push({ path: `${recordPath}.status`, value: 'pending' });
    return out;
  }

  const start = seq.now();
  let output: unknown;
  try {
    output = impl(input);
  } catch (e: unknown) {
    // Synchronous throw → violated in the same cascade.
    const reason = (e as { message?: string })?.message ?? String(e);
    out.push({ path: `${recordPath}.violateReason`, value: reason });
    out.push({ path: `${recordPath}.latencyMs`, value: seq.now() - start });
    out.push({ path: `${recordPath}.status`, value: 'violated' });
    return out;
  }

  // Async impl: result is a thenable. Emit the pending record NOW; the
  // cascade returns immediately. When the promise settles, do the
  // fulfillment / violation inserts via the public seq.insert API — that
  // flows through admission, compose, reliability rules, everything —
  // exactly as if the mount came from any caller. The Promise itself is
  // tracked so tests (and callers that need determinism) can await its
  // settlement via flushPending(seq).
  if (output !== null && typeof (output as { then?: unknown })?.then === 'function') {
    out.push({ path: `${recordPath}.status`, value: 'pending' });
    trackPending(seq, settleAsync(seq, output as Promise<unknown>, recordPath, head, start));
    return out;
  }

  // Synchronous success.
  if (output !== undefined) {
    out.push({ path: head, value: output });
  }
  out.push({ path: `${recordPath}.latencyMs`, value: seq.now() - start });
  out.push({ path: `${recordPath}.status`, value: 'fulfilled' });
  return out;
}

/**
 * Drive an async impl's Promise to a terminal commitment status. The
 * work happens OUTSIDE the original cascade — each settlement step
 * enters the substrate via a fresh `seq.insert`, so admission rules,
 * reliability updates, and any other observation rules fire the same
 * way they would for a sync invocation.
 *
 * Returns a Promise that flushPending can await to join all outstanding
 * async commitments at a sync boundary.
 */
async function settleAsync(
  seq: Sequence,
  p: Promise<unknown>,
  recordPath: string,
  head: string,
  start: number,
): Promise<void> {
  try {
    const resolved = await p;
    if (resolved !== undefined) seq.insert({ path: head, value: resolved });
    seq.insert({ path: `${recordPath}.latencyMs`, value: seq.now() - start });
    seq.insert({ path: `${recordPath}.status`, value: 'fulfilled' });
  } catch (e: unknown) {
    const reason = (e as { message?: string })?.message ?? String(e);
    seq.insert({ path: `${recordPath}.violateReason`, value: reason });
    seq.insert({ path: `${recordPath}.latencyMs`, value: seq.now() - start });
    seq.insert({ path: `${recordPath}.status`, value: 'violated' });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PENDING-PROMISE TRACKER — lets tests + sync-boundary callers await
// all in-flight async commitments. Kept in a module-level WeakMap so
// the kernel stays unaware. Not persistent; pending promises are
// runtime-only state (consistent with impls being runtime-only).
// ═══════════════════════════════════════════════════════════════════════

const pendingBySeq = new WeakMap<Sequence, Set<Promise<void>>>();

function trackPending(seq: Sequence, p: Promise<void>): void {
  let set = pendingBySeq.get(seq);
  if (!set) { set = new Set(); pendingBySeq.set(seq, set); }
  set.add(p);
  p.finally(() => set!.delete(p));
}

/**
 * Await every async commitment currently in flight on this Sequence.
 * Loops until the pending set is empty — a settling promise may trigger
 * downstream work that itself spawns further async commitments, so one
 * Promise.all is not enough. Terminates because each iteration
 * strictly drains the set.
 */
export async function flushPending(seq: Sequence): Promise<void> {
  while (true) {
    const set = pendingBySeq.get(seq);
    if (!set || set.size === 0) return;
    await Promise.all([...set]);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CLOCK ADVANCE — helper for deadline-driven violation tests. Mounts
// `_rt = t` so temporal-gated blocks watching `_rt` re-evaluate. In
// production, the host environment mounts `_rt` updates on a tick; this
// helper is for deterministic tests.
// ═══════════════════════════════════════════════════════════════════════

export function advanceClock(seq: Sequence, t: number): void {
  seq.insert({ path: '_rt', value: t });
}

// ═══════════════════════════════════════════════════════════════════════
// BACKWARD INFERENCE — goal → plan → execution.
//
// Every orchestration primitive in this substrate is supposed to be
// driven by backward inference: given a goal (a type at a path), find
// a sequence of tool invocations whose composed output type is at
// least as narrow as the goal, ordered so each step's inputs are
// already available before it fires.
//
// This is branch-and-bound over plan space:
//   - enumerate fn-typed cells whose output COVERS the goal type
//   - recurse on each candidate: its input becomes a new sub-goal
//   - base case: sub-goal is already satisfied at some path
//   - rank by expected feasibility (reliability × time fit)
//   - prune plans whose cumulative feasibility < best found
//
// Returns a Plan (data). The caller chooses when to `executePlan` it —
// typically after rendering the current goal state into a semantic-
// kernel prompt and receiving back an LLM's decision, or directly for
// sync tools.
//
// Tool calls in the returned plan are MCP executions in the
// Protocol-agnostic sense: `seq.insert({path: toolPath, value: input})`
// on the local substrate, which — via commitment + async + cross-
// sequence — flows to whatever holder actually runs the impl (in-
// process, Lambda, remote agent).
// ═══════════════════════════════════════════════════════════════════════

export type PlanStep = {
  toolPath: string;
  inputSource: { kind: 'literal'; value: unknown } | { kind: 'path'; path: string } | { kind: 'sub_plan'; plan: Plan };
  inputType: Type;
  outputType: Type;
  reliability: number;
};

export type PlanGap = {
  path: string;
  type: Type;
  reason: string;
};

export type Plan = {
  goalPath: string;
  goalType: Type;
  steps: PlanStep[];
  gaps: PlanGap[];
  meetable: boolean;
  /** Posterior-predictive joint probability assuming independence.
   *  Deliberately simple; callers doing serious planning can replace
   *  with a proper plan-feasibility evaluator. */
  expectedReliability: number;
};

type ToolInfo = { path: string; fnType: Type; inputType: Type; outputType: Type };

function enumerateTools(seq: Sequence): ToolInfo[] {
  const out: ToolInfo[] = [];
  for (const c of seq.cells()) {
    if (c.type?.kind !== 'fn') continue;
    const param = constraintOf(c.type, 'param');
    const returns = constraintOf(c.type, 'returns');
    if (!param || !returns) continue;
    out.push({
      path: c.path,
      fnType: c.type,
      inputType: param.args[0] as Type,
      outputType: returns.args[0] as Type,
    });
  }
  return out;
}

/**
 * Posterior-predictive reliability for a holder. When `inputValue` is
 * supplied, look up the conditional posterior at
 * `_holders.{holder}.subtype.{key}.reliability.{α,β}`; if no evidence
 * has accumulated at that sub-type yet, fall back to the aggregate
 * marginal. When `inputValue` is absent (unknown input at plan time),
 * return the aggregate directly.
 *
 * This is the projection the planner uses to rank candidates: NOT a
 * static tool property, but a query against learned evidence at the
 * input's classified sub-type.
 */
function holderReliability(seq: Sequence, holderPath: string, inputValue?: unknown): number {
  if (inputValue !== undefined) {
    const refinedKey = resolveSubtype(seq, holderPath, inputValue, true);
    const refinedBase = `_holders.${holderPath}.subtype.${refinedKey}.reliability`;
    const rAlpha = seq.get(`${refinedBase}.alpha`) as number | undefined;
    const rBeta = seq.get(`${refinedBase}.beta`) as number | undefined;
    if (rAlpha !== undefined || rBeta !== undefined) {
      const a = rAlpha ?? 1;
      const b = rBeta ?? 1;
      return a / (a + b);
    }
    const coarse = subtypeKey(inputValue);
    const base = `_holders.${holderPath}.subtype.${coarse}.reliability`;
    const alpha = seq.get(`${base}.alpha`) as number | undefined;
    const beta = seq.get(`${base}.beta`) as number | undefined;
    if (alpha !== undefined || beta !== undefined) {
      const a = alpha ?? 1;
      const b = beta ?? 1;
      return a / (a + b);
    }
  }
  const alpha = (seq.get(`_holders.${holderPath}.reliability.alpha`) as number) ?? 1;
  const beta = (seq.get(`_holders.${holderPath}.reliability.beta`) as number) ?? 1;
  return alpha / (alpha + beta);
}

/**
 * Posterior-predictive latency for a holder at a given input's sub-type.
 * Returns the running mean (in ms) if evidence exists, else undefined
 * — caller decides what to do with an uninformed prior (use aggregate,
 * skip the step, reject the plan, etc.).
 */
function holderLatencyMean(
  seq: Sequence, holderPath: string, inputValue?: unknown,
): number | undefined {
  if (inputValue !== undefined) {
    const refinedKey = resolveSubtype(seq, holderPath, inputValue, true);
    const refinedBase = `_holders.${holderPath}.subtype.${refinedKey}.latency`;
    const rMean = seq.get(`${refinedBase}.mean`) as number | undefined;
    if (rMean !== undefined) return rMean;
    const coarse = subtypeKey(inputValue);
    const base = `_holders.${holderPath}.subtype.${coarse}.latency`;
    const cMean = seq.get(`${base}.mean`) as number | undefined;
    if (cMean !== undefined) return cMean;
  }
  return seq.get(`_holders.${holderPath}.latency.mean`) as number | undefined;
}

/**
 * Posterior-predictive latency standard deviation. Used by worst-case
 * feasibility compositions. Undefined for under-evidenced buckets.
 */
function holderLatencyStddev(
  seq: Sequence, holderPath: string, inputValue?: unknown,
): number | undefined {
  const bases: string[] = [];
  if (inputValue !== undefined) {
    const refinedKey = resolveSubtype(seq, holderPath, inputValue, true);
    bases.push(`_holders.${holderPath}.subtype.${refinedKey}.latency`);
    const coarse = subtypeKey(inputValue);
    bases.push(`_holders.${holderPath}.subtype.${coarse}.latency`);
  }
  bases.push(`_holders.${holderPath}.latency`);
  for (const b of bases) {
    const count = seq.get(`${b}.count`) as number | undefined;
    const m2 = seq.get(`${b}.m2`) as number | undefined;
    if (count !== undefined && m2 !== undefined && count > 1) {
      return Math.sqrt(m2 / (count - 1));
    }
  }
  return undefined;
}

/**
 * Find a path where the value satisfies the given type — the input
 * side of backward inference's base case. Scans existing cells for a
 * value that covers the required type. Used for matching sub-goal
 * inputs against already-available substrate state.
 */
function findSatisfyingPath(seq: Sequence, type: Type): string | undefined {
  for (const c of seq.cells()) {
    if (c.value === undefined) continue;
    // Skip substrate-private paths
    if (c.path.startsWith('_')) continue;
    // Skip tool cells themselves (fn-typed)
    if (c.type?.kind === 'fn') continue;
    const r = check(type, c.value, c.path);
    if (r.ok) return c.path;
  }
  return undefined;
}

/**
 * Backward-inference search. Returns the best plan to produce a value
 * of `goalType` at `goalPath`. Empty plan = goal already satisfied.
 * Unmeetable plan = no tool chain found within depth.
 */
export function search(
  seq: Sequence,
  goalPath: string,
  goalType: Type,
  maxDepth: number = 5,
): Plan {
  const visited = new Set<string>();
  return searchInner(seq, goalPath, goalType, maxDepth, visited);
}

/**
 * Top-K candidate search. Enumerates multiple viable plans ordered by
 * expected reliability (highest first). Lets the caller hoist choices
 * for LLM/user-participated selection — "the planner is another tool"
 * shape: instead of the greedy best, render candidates, let a smarter
 * chooser pick.
 */
export function searchCandidates(
  seq: Sequence,
  goalPath: string,
  goalType: Type,
  maxCandidates: number = 3,
  maxDepth: number = 5,
): Plan[] {
  // Base case: goal already satisfied.
  const existing = seq.get(goalPath);
  if (existing !== undefined && check(goalType, existing, goalPath).ok) {
    return [{
      goalPath, goalType, steps: [], gaps: [],
      meetable: true, expectedReliability: 1,
    }];
  }
  const tools = enumerateTools(seq);
  const candidates = tools.filter(t => covers(goalType, t.outputType));
  const plans: Plan[] = [];
  for (const cand of candidates) {
    const satisfying = findSatisfyingPath(seq, cand.inputType);
    if (satisfying) {
      const inputValue = seq.get(satisfying);
      const reliability = holderReliability(seq, cand.path, inputValue);
      plans.push({
        goalPath, goalType,
        steps: [{
          toolPath: cand.path,
          inputSource: { kind: 'path', path: satisfying },
          inputType: cand.inputType,
          outputType: cand.outputType,
          reliability,
        }],
        gaps: [], meetable: true,
        expectedReliability: reliability,
      });
      continue;
    }
    // Recurse for nested plans
    const subPlan = searchInner(seq, cand.path, cand.inputType, maxDepth - 1, new Set());
    if (!subPlan.meetable) continue;
    const stepR = holderReliability(seq, cand.path);
    const joint = stepR * subPlan.expectedReliability;
    plans.push({
      goalPath, goalType,
      steps: [{
        toolPath: cand.path,
        inputSource: { kind: 'sub_plan', plan: subPlan },
        inputType: cand.inputType,
        outputType: cand.outputType,
        reliability: stepR,
      }],
      gaps: [], meetable: true,
      expectedReliability: joint,
    });
  }
  plans.sort((a, b) => b.expectedReliability - a.expectedReliability);
  return plans.slice(0, maxCandidates);
}

function searchInner(
  seq: Sequence,
  goalPath: string,
  goalType: Type,
  maxDepth: number,
  visited: Set<string>,
): Plan {
  // Base case 1: goal already satisfied at its path.
  const existing = seq.get(goalPath);
  if (existing !== undefined && check(goalType, existing, goalPath).ok) {
    return {
      goalPath, goalType, steps: [], gaps: [],
      meetable: true, expectedReliability: 1,
    };
  }

  // Depth exhausted.
  if (maxDepth <= 0) {
    return {
      goalPath, goalType, steps: [],
      gaps: [{ path: goalPath, type: goalType, reason: 'depth limit reached' }],
      meetable: false, expectedReliability: 0,
    };
  }

  // Cycle guard: recursing on the same goal type at the same path loops.
  const key = `${goalPath}::${JSON.stringify(goalType)}`;
  if (visited.has(key)) {
    return {
      goalPath, goalType, steps: [],
      gaps: [{ path: goalPath, type: goalType, reason: 'cycle' }],
      meetable: false, expectedReliability: 0,
    };
  }
  visited.add(key);

  // Enumerate candidate tools whose output covers the goal.
  const tools = enumerateTools(seq);
  const candidates = tools.filter(t => covers(goalType, t.outputType));

  if (candidates.length === 0) {
    visited.delete(key);
    return {
      goalPath, goalType, steps: [],
      gaps: [{ path: goalPath, type: goalType, reason: 'no tool produces this type' }],
      meetable: false, expectedReliability: 0,
    };
  }

  // For each candidate, try to complete its plan.
  let best: Plan | null = null;
  for (const cand of candidates) {
    const step: PlanStep = {
      toolPath: cand.path,
      inputType: cand.inputType,
      outputType: cand.outputType,
      reliability: holderReliability(seq, cand.path),
      inputSource: { kind: 'literal', value: undefined }, // placeholder; resolved below
    };

    // Try to source the input: first look for an existing satisfying
    // path in the substrate; otherwise recurse to plan a sub-chain.
    const satisfying = findSatisfyingPath(seq, cand.inputType);
    if (satisfying) {
      // Now that we KNOW the concrete input, upgrade the step's
      // reliability from aggregate to conditional — the posterior at
      // this specific sub-type may differ materially from the holder's
      // overall reputation.
      const inputValue = seq.get(satisfying);
      step.reliability = holderReliability(seq, cand.path, inputValue);
      step.inputSource = { kind: 'path', path: satisfying };
      const plan: Plan = {
        goalPath, goalType, steps: [step],
        gaps: [], meetable: true,
        expectedReliability: step.reliability,
      };
      if (!best || plan.expectedReliability > best.expectedReliability) best = plan;
      continue;
    }

    // No existing input → recurse.
    const subPlan = searchInner(seq, cand.path, cand.inputType, maxDepth - 1, visited);
    if (!subPlan.meetable) continue;
    step.inputSource = { kind: 'sub_plan', plan: subPlan };
    const joint = step.reliability * subPlan.expectedReliability;
    const plan: Plan = {
      goalPath, goalType, steps: [step],
      gaps: [], meetable: true,
      expectedReliability: joint,
    };
    if (!best || plan.expectedReliability > best.expectedReliability) best = plan;
  }

  visited.delete(key);
  if (!best) {
    return {
      goalPath, goalType, steps: [],
      gaps: [{ path: goalPath, type: goalType, reason: 'no candidate plan completes' }],
      meetable: false, expectedReliability: 0,
    };
  }
  return best;
}

/**
 * Flatten a nested Plan into a linear sequence of tool invocations in
 * dependency order (sub-plan steps appear before the steps that depend
 * on them). Each entry tells the caller: invoke toolPath with this
 * resolved input. For `inputSource.kind === 'path'`, the caller reads
 * the value at that path. For `'sub_plan'`, the sub-plan's preceding
 * steps will have already produced the value at the sub-plan's
 * toolPath's `.result` sub-cell.
 */
export function flattenPlan(plan: Plan): PlanStep[] {
  const out: PlanStep[] = [];
  for (const step of plan.steps) {
    if (step.inputSource.kind === 'sub_plan') {
      out.push(...flattenPlan(step.inputSource.plan));
    }
    out.push(step);
  }
  return out;
}

/**
 * Execute a plan on the substrate. For each step (in flattened
 * dependency order), resolve the input and insert at the tool path.
 * `flushPending` is called after each step so an async tool's result
 * is mounted before the next step resolves its inputs.
 */
/**
 * Resolve a temporal bound against live substrate state. The bound may
 * be a literal number, a path reference (resolved via seq.get), or an
 * additive expression ({add: [...]}) mixing paths, literals, and `_rt`.
 * Returns undefined if the bound cannot be resolved to a number.
 *
 * This is the "bound is a projection over substrate state" piece: the
 * deadline isn't a static field, it's whatever the current state says
 * the budget is.
 */
function resolveBound(bound: unknown, seq: Sequence): number | undefined {
  if (typeof bound === 'number') return bound;
  if (typeof bound === 'string') {
    const v = seq.get(bound);
    return typeof v === 'number' ? v : undefined;
  }
  if (bound && typeof bound === 'object' && 'add' in (bound as any)) {
    const terms = (bound as { add: unknown[] }).add;
    let sum = 0;
    for (const term of terms) {
      if (term === '_rt') sum += seq.now();
      else if (typeof term === 'number') sum += term;
      else if (typeof term === 'string') {
        const v = seq.get(term);
        if (typeof v === 'number') sum += v;
        else return undefined;
      } else return undefined;
    }
    return sum;
  }
  return undefined;
}

export type DependencyModel = 'independent' | 'worst_case';

export type Feasibility = {
  passes: boolean;
  reliability: number;
  expectedLatencyMs?: number;
  /** Projected completion time: now() + summed per-step latency. */
  projectedCompletion?: number;
  boundResolved?: number;
  boundStatus: 'no_bound' | 'within_bound' | 'exceeded' | 'unresolved' | 'will_exceed';
  reason?: string;
};

/**
 * Projection-based feasibility evaluator. Given a plan + goal, compute:
 *   reliability  — joint product of each step's CONDITIONAL reliability,
 *                  conditioned on the step's would-be input's sub-type
 *   bound        — the goal type's temporal bound, resolved against
 *                  live state (path, literal, or additive expression)
 *   passes       — reliability ≥ confidence AND bound not already exceeded
 *
 * Neither side is static: both are projections over live substrate state
 * resolved at call time. If the evidence hasn't accumulated yet for a
 * step's sub-type, the aggregate posterior is used as fallback —
 * standard Bayesian treatment of a new cell in the contingency table.
 */
export function feasibility(
  seq: Sequence,
  plan: Plan,
  goal: { type: Type; confidence?: number; dependency?: DependencyModel } = { type: plan.goalType },
): Feasibility {
  const threshold = goal.confidence ?? 0.5;
  const dependency: DependencyModel = goal.dependency ?? 'independent';

  // Per-step reliabilities and latencies, projected against live state.
  const stepReliabilities: number[] = [];
  const stepLatencies: number[] = [];
  const stepStddevs: number[] = [];
  for (const step of flattenPlan(plan)) {
    let inputValue: unknown;
    if (step.inputSource.kind === 'literal') inputValue = step.inputSource.value;
    else if (step.inputSource.kind === 'path') inputValue = seq.get(step.inputSource.path);
    const stepR = inputValue !== undefined
      ? holderReliability(seq, step.toolPath, inputValue)
      : step.reliability;
    stepReliabilities.push(stepR);
    const lat = holderLatencyMean(seq, step.toolPath, inputValue);
    if (lat !== undefined) stepLatencies.push(lat);
    const std = holderLatencyStddev(seq, step.toolPath, inputValue);
    if (std !== undefined) stepStddevs.push(std);
  }

  // Compose under declared dependency model.
  //   independent: joint reliability = ∏ rᵢ, latency = Σ μᵢ
  //   worst_case:  joint reliability = min rᵢ, latency = Σ (μᵢ + 2σᵢ)
  //     (comonotonic upper bound — LEARNING_AS_COMPRESSION's fail-closed
  //      default when no stronger dependency model is declared.)
  let reliability: number;
  let expectedLatencyMs: number | undefined;
  if (dependency === 'independent') {
    reliability = stepReliabilities.reduce((a, b) => a * b, 1);
    if (stepLatencies.length === stepReliabilities.length) {
      expectedLatencyMs = stepLatencies.reduce((a, b) => a + b, 0);
    }
  } else {
    reliability = stepReliabilities.length ? Math.min(...stepReliabilities) : 1;
    if (stepLatencies.length === stepReliabilities.length) {
      const safetyMargin = stepStddevs.length
        ? stepStddevs.reduce((a, b) => a + b, 0) * 2
        : 0;
      expectedLatencyMs = stepLatencies.reduce((a, b) => a + b, 0) + safetyMargin;
    }
  }

  // Resolve the goal's temporal bound against live state.
  let boundStatus: Feasibility['boundStatus'] = 'no_bound';
  let boundResolved: number | undefined;
  let projectedCompletion: number | undefined;
  const temporalC = goal.type.constraints.find(c => c.op === 'temporal');
  if (temporalC) {
    const [dir, lhs, bound] = temporalC.args;
    if (dir === 'lt' && lhs === '_rt') {
      boundResolved = resolveBound(bound, seq);
      if (boundResolved === undefined) boundStatus = 'unresolved';
      else if (seq.now() >= boundResolved) boundStatus = 'exceeded';
      else if (expectedLatencyMs !== undefined) {
        projectedCompletion = seq.now() + expectedLatencyMs;
        boundStatus = projectedCompletion >= boundResolved ? 'will_exceed' : 'within_bound';
      } else {
        boundStatus = 'within_bound';
      }
    }
  }

  const passes = reliability >= threshold
    && boundStatus !== 'exceeded'
    && boundStatus !== 'will_exceed'
    && boundStatus !== 'unresolved';
  const reason = !passes
    ? (boundStatus === 'exceeded' ? 'deadline already passed'
       : boundStatus === 'will_exceed'
         ? `projected completion ${projectedCompletion} exceeds bound ${boundResolved}`
       : boundStatus === 'unresolved' ? 'bound cannot be resolved'
       : `reliability ${reliability.toFixed(3)} below threshold ${threshold}`)
    : undefined;

  return {
    passes, reliability, expectedLatencyMs, projectedCompletion,
    boundResolved, boundStatus, reason,
  };
}

export async function executePlan(seq: Sequence, plan: Plan): Promise<void> {
  const steps = flattenPlan(plan);
  for (const step of steps) {
    let input: unknown;
    if (step.inputSource.kind === 'literal') {
      input = step.inputSource.value;
    } else if (step.inputSource.kind === 'path') {
      input = seq.get(step.inputSource.path);
    } else if (step.inputSource.kind === 'sub_plan') {
      // Sub-plan's terminal step's tool produced a result at its path
      input = seq.get(`${step.inputSource.plan.steps[0].toolPath}.result`);
    }
    if (input === undefined) continue;
    seq.insert({ path: step.toolPath, value: input });
    await flushPending(seq);
  }
}

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
}

export function hoistForReader(seq: Sequence, name: string): HoistResult {
  const base = `_readers.${name}`;
  const source = seq.get(`${base}.source`) as string | undefined;
  const depth = (seq.get(`${base}.depth`) as number | undefined) ?? 3;
  if (!source) return { text: '', paths: [], gaps: [] };

  const prefix = source.replace(/\.\*$/, '');
  const lines: string[] = [];
  const paths: string[] = [];
  const gaps: Array<{ path: string; type?: Type }> = [];
  const prefixSegs = prefix ? prefix.split('.').length : 0;

  const sorted = seq.cells()
    .map(c => c.path)
    .filter(p => {
      if (!p) return false;
      if (!prefix) return true;
      return p === prefix || p.startsWith(prefix + '.');
    })
    .sort();

  for (const path of sorted) {
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

function renderValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

// ═══════════════════════════════════════════════════════════════════════
// CROSS-SEQUENCE FORWARDING — federate substrate state across peers.
//
// Each Sequence node is tagged with a self-identity mounted at
// `_self.identity`. A forwarding rule observes local changes and calls
// an outgoing handler to serialize them to peers. The handler is user-
// supplied (WebSocket send, IPC postMessage, direct method call in
// tests) — the kernel never touches transport. When a peer's message
// arrives, the caller re-enters the substrate via seq.insert with the
// origin's identity tagged; the local forwarding rule sees the
// external identity and does NOT forward further, breaking the echo
// cycle.
//
// This is the same protocol at every hop: every process is a sequence
// node, bilateral gap exchange works the same at Browser↔User,
// User↔Scheduler, Scheduler↔User — no special-case code per tier.
// ═══════════════════════════════════════════════════════════════════════

export type Outgoing = {
  path: string;
  value?: unknown;
  type?: Type;
};

export type ForwardHandler = (delta: Outgoing) => void;

const forwardHandlers = new WeakMap<Sequence, ForwardHandler>();

const forwardScopes = new WeakMap<Sequence, string[] | undefined>();

/**
 * Install cross-sequence forwarding.
 *
 * When `scopes` is omitted, every non-`_*` local delta is forwarded.
 * When provided, only deltas whose path matches any of the listed
 * glob prefixes (e.g. `['org.*', 'shared.config.*']`) are forwarded —
 * private partitions stay local.
 */
export function installCrossSequence(
  seq: Sequence,
  selfIdentity: string,
  onOutgoing: ForwardHandler,
  scopes?: string[],
): void {
  seq.insert({ path: '_self.identity', value: selfIdentity });
  forwardHandlers.set(seq, onOutgoing);
  if (scopes) forwardScopes.set(seq, scopes);

  seq.emitters.set('cross_sequence.forward', (ctx) => {
    // Forward only LOCAL-origin deltas. External-origin deltas (tagged
    // with some other identity via block.coord.identity) came from a
    // peer — re-sending would echo forever.
    const origin = ctx.block.coord.identity;
    const self = ctx.seq.get('_self.identity') as string;
    if (origin !== undefined && origin !== self) return [];

    // Skip substrate-internal cells (prefixed with `_`).
    if (ctx.cell.path.startsWith('_')) return [];

    // Only forward value / type deltas; other kinds are local concerns.
    if (ctx.delta.kind !== 'value' && ctx.delta.kind !== 'type') return [];

    // Scope filter: if scopes configured, require a prefix match.
    const sc = forwardScopes.get(ctx.seq);
    if (sc && sc.length > 0) {
      const matches = sc.some(g => {
        const prefix = g.replace(/\.\*$/, '');
        return ctx.cell.path === prefix || ctx.cell.path.startsWith(prefix + '.');
      });
      if (!matches) return [];
    }

    const handler = forwardHandlers.get(ctx.seq);
    if (!handler) return [];
    handler({
      path: ctx.delta.path,
      ...(ctx.delta.kind === 'value' ? { value: ctx.delta.next } : {}),
      ...(ctx.delta.kind === 'type' ? { type: ctx.delta.next as Type } : {}),
    });
    return [];
  });

  seq.insert({
    path: '_rules.cross_sequence_forward',
    rules: [{
      id: `cross_sequence_forward_${selfIdentity}`,
      phase: 'observation',
      scope: '',
      emit: 'cross_sequence.forward',
    }],
  });
}

/**
 * Handle an incoming delta from a peer. Tags it with the origin's
 * identity so the local forwarding rule knows not to echo. Pure
 * convenience over seq.insert.
 */
export function receiveFromPeer(
  seq: Sequence,
  peerIdentity: string,
  delta: Outgoing,
): void {
  seq.insert({
    path: delta.path,
    value: delta.value,
    type: delta.type,
    identity: peerIdentity,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// STRUCTURED PROMPT DOCUMENT — the semantic kernel render.
//
// Composes multiple readers + fixed-text preambles + computed sections
// (identity, time, pending commitments) into a single ft-shaped
// document matching the north-star AGENT_PROMPT_FRAME shape:
//
//   -- 1.0 IDENTITY
//   identity = "agent-…"
//   now = 1710000000
//
//   -- 1.1 VALUES
//   <fixed text>
//
//   -- 1.2 TOOLS
//   <reader hoist>
//
//   -- 1.3 PENDING
//   <commitments with live posterior>
//
// Sections are declarative DocSection values; the kernel composes them
// by iterating, calling hoistForReader for reader-kind sections, and
// concatenating. Sections producing gaps emit `[[ label : signature ]]`
// tokens, exactly as hoist does, so the LLM's output can target them.
// ═══════════════════════════════════════════════════════════════════════

export type DocSection =
  | { kind: 'text'; heading: string; body: string }
  | { kind: 'reader'; heading: string; reader: string }
  | { kind: 'identity'; heading: string }
  | { kind: 'commitments'; heading: string; status?: 'pending' | 'fulfilled' | 'violated' }
  | { kind: 'candidates'; heading: string; goalPath: string; goalType: Type; k?: number };

export type DocResult = {
  text: string;
  gaps: Array<{ path: string; type?: Type }>;
};

export function renderDocument(seq: Sequence, sections: DocSection[]): DocResult {
  const chunks: string[] = [];
  const gaps: Array<{ path: string; type?: Type }> = [];

  sections.forEach((s, i) => {
    const n = `${Math.floor(i / 10)}.${i % 10}`;
    const header = `-- ${n} ${s.heading}`;

    if (s.kind === 'text') {
      chunks.push(`${header}\n${s.body}`);
      return;
    }

    if (s.kind === 'reader') {
      const hr = hoistForReader(seq, s.reader);
      gaps.push(...hr.gaps);
      chunks.push(`${header}\n${hr.text || '(empty)'}`);
      return;
    }

    if (s.kind === 'identity') {
      const id = seq.get('_self.identity');
      const lines = [
        `identity = ${id !== undefined ? JSON.stringify(id) : '[[ unknown ]]'}`,
        `now = ${seq.now()}`,
      ];
      chunks.push(`${header}\n${lines.join('\n')}`);
      return;
    }

    if (s.kind === 'candidates') {
      // Hoist the top-K candidate plans for a goal, each annotated with
      // feasibility (reliability, expected latency, bound status). The
      // LLM or user reads these and picks one by mounting a choice.
      // Gaps in the candidates' chains become expansion tokens.
      const plans = searchCandidates(seq, s.goalPath, s.goalType, s.k ?? 3);
      const lines: string[] = [];
      if (plans.length === 0) {
        lines.push('(no viable plan)');
      } else {
        plans.forEach((p, idx) => {
          const f = feasibility(seq, p, { type: s.goalType });
          const summary = [
            `reliability=${f.reliability.toFixed(3)}`,
            f.expectedLatencyMs !== undefined ? `expectedMs=${Math.round(f.expectedLatencyMs)}` : undefined,
            f.boundStatus !== 'no_bound' ? `bound=${f.boundStatus}` : undefined,
          ].filter(Boolean).join(' ');
          const stepsDesc = flattenPlan(p).map(step => {
            const src = step.inputSource.kind === 'path'
              ? `path:${step.inputSource.path}`
              : step.inputSource.kind === 'literal'
              ? 'literal'
              : 'sub_plan';
            return `${step.toolPath}(${src})`;
          }).join(' → ');
          lines.push(`[[ candidate.${idx} : ${stepsDesc} | ${summary} ]]`);
        });
      }
      chunks.push(`${header}\n${lines.join('\n')}`);
      return;
    }

    if (s.kind === 'commitments') {
      const lines: string[] = [];
      for (const c of seq.cells()) {
        const m = c.path.match(/^_commitments\.([^.]+)$/);
        if (!m) continue;
        const id = m[1];
        const status = seq.get(`_commitments.${id}.status`);
        if (s.status && status !== s.status) continue;
        const holder = seq.get(`_commitments.${id}.holder`);
        const head = seq.get(`_commitments.${id}.head`);
        const latency = seq.get(`_commitments.${id}.latencyMs`);
        const deadline = seq.get(`_commitments.${id}.deadline`);
        const reliabilityBase = `_holders.${holder}.reliability`;
        const alpha = (seq.get(`${reliabilityBase}.alpha`) as number) ?? 1;
        const beta = (seq.get(`${reliabilityBase}.beta`) as number) ?? 1;
        const reliability = alpha / (alpha + beta);
        const fields = [
          `holder=${JSON.stringify(holder)}`,
          `head=${JSON.stringify(head)}`,
          `status=${JSON.stringify(status)}`,
        ];
        if (deadline !== undefined) fields.push(`deadline=${deadline}`);
        if (latency !== undefined) fields.push(`latencyMs=${latency}`);
        fields.push(`reliability=${reliability.toFixed(3)}`);
        lines.push(`${id}: ${fields.join(' ')}`);
      }
      chunks.push(`${header}\n${lines.length ? lines.join('\n') : '(none)'}`);
      return;
    }
  });

  return { text: chunks.join('\n\n'), gaps };
}

function renderType(t: Type): string {
  switch (t.kind) {
    case 'string':  return 'string';
    case 'number':  return 'number';
    case 'boolean': return 'boolean';
    case 'null':    return 'null';
    case 'any':     return 'any';
    case 'never':   return 'never';
    case 'fn':      return 'fn';
    case 'object':  return 'object';
    case 'array':   return 'array';
    default:        return String(t.kind);
  }
}

function resolveImpl(cell: { path: string; type?: Type }, seq: Sequence): Function | undefined {
  const direct = seq.impls.get(cell.path);
  if (direct) return direct;
  if (cell.type) {
    const implC = constraintOf(cell.type, 'impl');
    if (implC) {
      const id = implC.args[0] as string;
      return seq.impls.get(id);
    }
  }
  return undefined;
}

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
function resolveSubtype(
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
 * evidence from now on; activation is automatic when the divergence +
 * evidence gates pass (see `refinementPromote`).
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
  },
): void {
  const base = `_holders.${holder}.refiners.${name}`;
  seq.insert({ path: `${base}.parentKey`, value: config.parentKey });
  seq.insert({ path: `${base}.discriminator`, value: config.discriminator });
  seq.insert({ path: `${base}.minEvidence`, value: config.minEvidence ?? 3 });
  seq.insert({ path: `${base}.minDivergence`, value: config.minDivergence ?? 0.3 });
  seq.insert({ path: `${base}.active`, value: false });
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
function reliabilityUpdate(ctx: EmitterCtx): BlockTemplate[] {
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
 * scan the holder's candidate (non-active) refiners. For each, read the
 * child buckets' current posteriors; if every observed child has
 * enough evidence AND the max-min posterior-mean gap meets the
 * divergence threshold, activate the refiner.
 *
 * Activation is a single mount at `_holders.{holder}.refiners.{name}.active = true`.
 * From that mount forward, `resolveSubtype(requireActive=true)` picks
 * the refined key, and readers see the finer posterior.
 *
 * Divergence is a coarse heuristic here; a full MDL comparison (log-
 * likelihood gain vs partition description cost) is a natural
 * successor, expressible as replacing this function.
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
    if (childKeys.length < 2) continue; // need at least two child buckets

    let minMean = Infinity;
    let maxMean = -Infinity;
    let allMeetEvidence = true;
    for (const k of childKeys) {
      const a = (seq.get(`${subtypeBase}.${k}.reliability.alpha`) as number) ?? 1;
      const b = (seq.get(`${subtypeBase}.${k}.reliability.beta`) as number) ?? 1;
      const evidence = (a - 1) + (b - 1); // observations = α+β − 2 (prior)
      if (evidence < r.spec.minEvidence) { allMeetEvidence = false; break; }
      const mean = a / (a + b);
      if (mean < minMean) minMean = mean;
      if (mean > maxMean) maxMean = mean;
    }
    if (!allMeetEvidence) continue;
    if (maxMean - minMean < r.spec.minDivergence) continue;

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

// ═══════════════════════════════════════════════════════════════════════
// INDEXSPEC — tuple-product rule driver.
//
// Observation rule that fires on any cell change and re-evaluates every
// mounted index_spec class. Each class projects its binding-space tuples
// and emits body entries at interpolated paths. Idempotency via compose.
// ═══════════════════════════════════════════════════════════════════════

type IndexSpecData = {
  indexedBy?: string[];
  where?: Constraint[];
  body?: Array<{ op: string; path: string; value?: unknown }>;
};
type Tuple = Record<string, unknown>;

function indexSpecDriver(ctx: EmitterCtx): BlockTemplate[] {
  const { cell, delta, seq } = ctx;
  const induced: BlockTemplate[] = [];

  // Case A: a class schema just landed (its own type-change delta).
  //   Register glob watches + fire bodies for current tuples.
  if (delta.kind === 'type' && cell.type) {
    const spec = constraintOf(cell.type, 'index_spec');
    if (spec) {
      const specData = spec.args[0] as IndexSpecData;
      // Register glob watches on the kernel-level watcher index by
      // installing a lightweight child rule at _rules.{cellPath} so
      // future changes under bindFrom globs trigger this emitter.
      // Alternative: use explicit subscription API if added. For v2
      // initial, we rely on the global-watching `indexSpec.tick` rule.
      induced.push(...fireBodies(cell.path, specData, seq));
    }
  }

  // Case B: an ordinary cell change. Scan mounted index_spec classes;
  // for each whose binding space includes (any prefix of) this cell's
  // path, re-project tuples and emit body entries.
  //
  // Finding the classes: walk all cells once, filter by type having
  // index_spec. For MVP this is O(N) per change — acceptable. A real
  // implementation maintains a prefix-indexed registry.
  const changedPath = cell.path;
  for (const c of seq.cells()) {
    if (!c.type) continue;
    const spec = constraintOf(c.type, 'index_spec');
    if (!spec) continue;
    const specData = spec.args[0] as IndexSpecData;
    const watchPrefixes = (specData.where ?? [])
      .filter(x => x.op === 'bind_from')
      .map(x => (x.args[1] as string).replace(/\.\*$/, ''));
    const triggers = watchPrefixes.some(p =>
      p === '' || changedPath === p || changedPath.startsWith(p + '.'),
    );
    if (!triggers) continue;
    induced.push(...fireBodies(c.path, specData, seq));
  }

  return induced;
}

function fireBodies(classPath: string, spec: IndexSpecData, seq: Sequence): BlockTemplate[] {
  const tuples = projectTuples(spec, seq);
  const out: BlockTemplate[] = [];
  for (const t of tuples) {
    for (const entry of spec.body ?? []) {
      out.push({
        path: interpolate(entry.path, t),
        value: interpolateValue(entry.value, t),
      });
    }
  }
  return out;
}

function projectTuples(spec: IndexSpecData, seq: Sequence): Tuple[] {
  const where = spec.where ?? [];
  const binds = where.filter(c => c.op === 'bind_from');
  const filters = where.filter(c => c.op !== 'bind_from');
  const bases: Record<string, string> = {};

  let tuples: Tuple[] = [{}];
  for (const b of binds) {
    const [v, g] = b.args as [string, string];
    const prefix = g.replace(/\.\*$/, '');
    bases[v] = prefix;
    const segs = seq.childSegments(prefix);
    const next: Tuple[] = [];
    for (const t of tuples) for (const s of segs) next.push({ ...t, [v]: s });
    tuples = next;
  }

  for (const f of filters) {
    tuples = tuples.filter(t => evalFilter(f, t, bases, seq));
  }
  return tuples;
}

function evalFilter(
  c: Constraint, t: Tuple, bases: Record<string, string>, seq: Sequence,
): boolean {
  const resolve = (arg: unknown): unknown => {
    if (typeof arg !== 'string') return arg;
    const whole = arg.match(/^\{(\w+)\}$/);
    if (whole && whole[1] in t) return t[whole[1]];
    if (arg in t) return t[arg];
    const parts = arg.split('.');
    if (parts[0] in t && parts.length > 1) {
      const base = bases[parts[0]];
      const seg = String(t[parts[0]]);
      return seq.get(`${base}.${seg}.${parts.slice(1).join('.')}`);
    }
    return arg;
  };
  switch (c.op) {
    case 'eq':        return resolve(c.args[0]) === resolve(c.args[1]);
    case 'neq':       return resolve(c.args[0]) !== resolve(c.args[1]);
    case 'exists':    return resolve(c.args[0]) !== undefined;
    case 'notExists': return resolve(c.args[0]) === undefined;
    default:          return true;
  }
}

function interpolate(template: string, t: Tuple): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(t[k] ?? `{${k}}`));
}
function interpolateValue(template: unknown, t: Tuple): unknown {
  if (typeof template !== 'string') return template;
  const whole = template.match(/^\{(\w+)\}$/);
  if (whole && whole[1] in t) return t[whole[1]];
  return template.replace(/\{(\w+)\}/g, (_, k) => String(t[k] ?? `{${k}}`));
}

// ═══════════════════════════════════════════════════════════════════════
// INSTALL — mount the rules + register the emitters + register the
// guard ops. Call once at boot.
// ═══════════════════════════════════════════════════════════════════════

export function installCommitment(seq: Sequence): void {
  seq.emitters.set('commitment.elect', electCommitment);
  seq.insert({
    path: `_rules.commitment_elect`,
    rules: [{
      id: 'commitment_elect',
      phase: 'observation',
      scope: '',
      when: { op: 'deltaKindIs', args: ['invocation'] },
      emit: 'commitment.elect',
    }],
  });
}

export function installReliability(seq: Sequence): void {
  seq.emitters.set('reliability.update', reliabilityUpdate);
  seq.insert({
    path: `_rules.reliability_update`,
    rules: [{
      id: 'reliability_update',
      phase: 'observation',
      scope: '',
      when: { op: 'deltaKindIs', args: ['value'] },
      emit: 'reliability.update',
    }],
  });
}

export function installPosteriorAdmit(seq: Sequence): void {
  seq.guards.set('posteriorAdmit', (c, s) => {
    const base = c.args[0] as string;
    const threshold = (c.args[1] as number) ?? 0.5;
    const alpha = (s.get(`${base}.alpha`) as number) ?? 1;
    const beta = (s.get(`${base}.beta`) as number) ?? 1;
    return alpha / (alpha + beta) >= threshold;
  });
}

export function installIndexSpec(seq: Sequence): void {
  seq.emitters.set('indexSpec.tick', indexSpecDriver);
  seq.insert({
    path: `_rules.index_spec_tick`,
    rules: [{
      id: 'index_spec_tick',
      phase: 'observation',
      scope: '',
      emit: 'indexSpec.tick',
    }],
  });
}

/** Convenience: install everything. */
export function installStdLib(seq: Sequence): void {
  installCommitment(seq);
  installReliability(seq);
  installPosteriorAdmit(seq);
  installIndexSpec(seq);
  installRefinement(seq);
}
