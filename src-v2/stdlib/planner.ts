import {
  type Type, constraintOf, param, returns, impl,
} from '../../src/type';
import {
  covers, check,
} from '../../src/compose';
import {
  type Sequence,
} from '../sequence';
import { flushPending } from './commitments';
import { subtypeKey, resolveSubtype } from './reliability';

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
export function holderReliability(seq: Sequence, holderPath: string, inputValue?: unknown): number {
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

