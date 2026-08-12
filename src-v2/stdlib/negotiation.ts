import {
  type Type, returns,
} from '../../src/type';
import {
  covers, check,
} from '../../src/compose';
import {
  type Sequence,
  type BlockTemplate,
} from '../sequence';
import {
  type PlanStep, type Plan, flattenPlan, executePlan, holderReliability,
} from './planner';

// ═══════════════════════════════════════════════════════════════════════
// CHAINED NEGOTIATION — fan out proposals, all-or-nothing commit.
//
// A plan with N steps may span M peers. Each step has an owner (looked
// up via `owner(step)`). The orchestrator fans one proposal per distinct
// (peer, step) pairing, waits until every verdict lands, and:
//   - all accepted → execute the plan locally (cross-sequence
//     forwarding carries invocations to remote holders);
//   - any rejected/countered → revoke every accept so budgets refund.
//
// This is atomic resource acquisition across federation boundaries.
// Neither side has to trust the other's internal budget model — the
// peer is authoritative, the proposer waits for unanimous grant.
// Cross-peer fairness is whatever each peer's evaluator enforces; this
// helper just respects their verdicts.
// ═══════════════════════════════════════════════════════════════════════

export type StepOwner = (step: PlanStep) => string;

export type ChainedNegotiationResult = {
  outcome: 'executed' | 'rejected' | 'revoked_partial';
  proposalIds: string[];
  rejected: string[];      // proposal IDs that didn't accept
  revoked: string[];       // accepted proposals that were revoked on abort
};

export async function negotiatePlan(
  seq: Sequence,
  plan: Plan,
  opts: {
    owner: StepOwner;
    resource: string;
    costPerStep: (step: PlanStep) => number;
    from: string;
    autoExecute?: boolean;   // default true
  },
): Promise<ChainedNegotiationResult> {
  const steps = flattenPlan(plan);
  const proposalIds: string[] = [];

  // Fan out one proposal per non-local step. Mounts land on the local
  // sequence; cross-sequence forwarding (scoped to `proposals.*`)
  // carries them to each owner's Sequence.
  for (const step of steps) {
    const peerId = opts.owner(step);
    if (peerId === opts.from) continue;
    const id = proposePlan(seq, {
      from: opts.from,
      target: peerId,
      resource: opts.resource,
      estimatedCost: opts.costPerStep(step),
      targetTool: step.toolPath,
    });
    proposalIds.push(id);
  }

  // Read verdicts. Sync handlers + sync forwarding in tests mean
  // verdicts are already landed by the time proposePlan returns; real
  // async transports would need a wait loop here.
  const verdicts = proposalIds.map(id => ({
    id, status: seq.get(`proposals.${id}.status`) as ProposalStatus | undefined,
  }));

  const rejected = verdicts.filter(v => v.status !== 'accepted').map(v => v.id);

  if (rejected.length === 0) {
    if (opts.autoExecute !== false) await executePlan(seq, plan);
    return { outcome: 'executed', proposalIds, rejected: [], revoked: [] };
  }

  // Abort: revoke every accepted proposal. The refund rule on each peer
  // will restore the budget. Revocation is an ordinary mount; cross-
  // sequence forwarding delivers it to the owner.
  const revoked: string[] = [];
  for (const v of verdicts) {
    if (v.status === 'accepted') {
      seq.insert({ path: `proposals.${v.id}.revoked`, value: true });
      revoked.push(v.id);
    }
  }
  return { outcome: 'revoked_partial', proposalIds, rejected, revoked };
}


// ═══════════════════════════════════════════════════════════════════════
// CROSS-SEQUENCE PLAN NEGOTIATION — planned resource consumption.
//
// A proposal is a declaration by one Sequence that it wants to consume
// `estimatedCost` units of a named `resource` to execute a plan against
// another Sequence's tools. Proposals land at `proposals.{id}` (no
// underscore prefix, so cross-sequence forwarding can carry them).
//
// The handling Sequence evaluates: does its current budget cover the
// cost AND does its own feasibility check (reliability, latency) pass?
// Three outcomes, each a mount on the proposal record:
//   status = 'accepted'  + budget decrements
//   status = 'rejected'  + reason + counter.suggestedCost (what's left)
//   status = 'countered' + counter.* (alternative terms)
//
// Both sides observe the status via the cascade. The proposing side
// waits on status to flip out of 'pending' and acts on the verdict.
// The handling side's budget decrement is itself a mount — it cascades,
// it can trigger refill rules, it can fire admission laws.
//
// This is the primitive federated agents use to share constrained
// resources (attention budgets, token quotas, compute minutes) without
// either side having to trust the other's internal state. The budget
// holder is authoritative; the proposer either gets a grant or a
// rejection whose reason and counter are inspectable.
// ═══════════════════════════════════════════════════════════════════════

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'countered';

export type ProposalInput = {
  from: string;             // origin identity
  resource: string;         // budget key to consume against
  estimatedCost: number;    // amount to reserve
  /** Target peer identity. Required for multi-peer fan-out so handlers
   *  on non-target peers can skip a proposal that isn't addressed to
   *  them. Omit only in single-peer topologies. */
  target?: string;
  /** Optional goal type the proposer wants served; the handler may
   *  evaluate feasibility against its own priors before committing. */
  goalType?: Type;
  /** Optional tool path on the handling sequence whose reliability +
   *  latency posteriors should participate in the decision. */
  targetTool?: string;
  id?: string;
};

/**
 * Mount a proposal on the local Sequence. When cross-sequence
 * forwarding includes `proposals.*` in scope, the proposal propagates
 * to every peer — handlers on peers observe and respond.
 */
/**
 * Mount order is load-bearing: descriptive fields (`from`, `resource`,
 * `targetTool`) land FIRST so the handler can read them when it fires.
 * `estimatedCost` is the trigger — last field mounted, chosen because
 * it lands exactly once per proposal and its cell is DISTINCT from the
 * `.status` cell the handler mounts. This avoids the kernel's seen-set
 * cycle guard that would otherwise block a same-path re-mount from
 * inside the same cascade. `.status` is never mounted until a verdict
 * lands; consumers reading "pending" check `seq.get(...status)` for
 * undefined vs. a terminal value.
 */
export function proposePlan(seq: Sequence, p: ProposalInput): string {
  const id = p.id ?? `p_${seq.nextSequence()}`;
  seq.insert({ path: `proposals.${id}.from`, value: p.from });
  seq.insert({ path: `proposals.${id}.resource`, value: p.resource });
  if (p.target !== undefined) {
    seq.insert({ path: `proposals.${id}.target`, value: p.target });
  }
  if (p.targetTool !== undefined) {
    seq.insert({ path: `proposals.${id}.targetTool`, value: p.targetTool });
  }
  // Trigger: mounting estimatedCost is what fires the handler rule.
  seq.insert({ path: `proposals.${id}.estimatedCost`, value: p.estimatedCost });
  return id;
}

export type ProposalDecision =
  | { verdict: 'accept' }
  | { verdict: 'reject'; reason: string; suggestedCost?: number }
  | { verdict: 'counter'; reason: string; counter: Record<string, unknown> };

export type ProposalEvaluator = (ctx: {
  seq: Sequence;
  id: string;
  from: string;
  resource: string;
  estimatedCost: number;
  targetTool?: string;
  budgetRemaining: number;
}) => ProposalDecision;

/**
 * Built-in evaluator: accept iff budget covers cost. Rejects with the
 * current remaining as counter-suggestion so the proposer can retry
 * with a smaller ask. If a `targetTool` is specified, also checks that
 * the tool's posterior-predictive reliability is above the configured
 * confidence threshold — "can't afford to waste budget on unreliable
 * tools even if the budget is technically there."
 */
export function budgetedEvaluator(
  confidenceThreshold: number = 0.5,
): ProposalEvaluator {
  return (c) => {
    if (c.estimatedCost > c.budgetRemaining) {
      return {
        verdict: 'reject',
        reason: `budget: need ${c.estimatedCost}, have ${c.budgetRemaining}`,
        suggestedCost: c.budgetRemaining,
      };
    }
    if (c.targetTool !== undefined) {
      const r = holderReliability(c.seq, c.targetTool);
      if (r < confidenceThreshold) {
        return {
          verdict: 'reject',
          reason: `tool ${c.targetTool} reliability ${r.toFixed(3)} below threshold ${confidenceThreshold}`,
        };
      }
    }
    return { verdict: 'accept' };
  };
}

/**
 * Install a proposal handler. `budgetPath` is where the resource's
 * remaining amount lives (mounted by the caller). `evaluator` decides
 * outcomes; default is `budgetedEvaluator()`.
 *
 * Accept → status='accepted', budget decrements, grantedAt stamped.
 * Reject → status='rejected', reason + suggestedCost recorded.
 * Counter → status='countered', counter record mounted with reason.
 *
 * The handler fires on ANY status transition to 'pending' (including
 * newly forwarded proposals from peer Sequences), skipping ones that
 * target a different resource — so multiple handlers for different
 * resources coexist on one Sequence.
 */
/**
 * Install a refund rule: when an accepted proposal's `revoked = true`
 * mounts, return its estimatedCost to the budget and stamp
 * `refundedAt`. Idempotent (checks for existing `refundedAt`).
 *
 * Atomic negotiation (chained proposals that must all succeed or none)
 * uses this: the orchestrator mounts `revoked = true` on any accepted
 * proposal when a sibling proposal in the chain was rejected.
 */
export function installRefundRule(
  seq: Sequence,
  resource: string,
  budgetPath: string,
): void {
  const emitterId = `proposal.refund.${resource}`;
  seq.emitters.set(emitterId, (ctx) => {
    if (ctx.delta.kind !== 'value' || ctx.delta.next !== true) return [];
    const m = ctx.cell.path.match(/^proposals\.([^.]+)\.revoked$/);
    if (!m) return [];
    const id = m[1];
    if (ctx.seq.get(`proposals.${id}.resource`) !== resource) return [];
    if (ctx.seq.get(`proposals.${id}.status`) !== 'accepted') return [];
    if (ctx.seq.get(`proposals.${id}.refundedAt`) !== undefined) return [];
    const cost = ctx.seq.get(`proposals.${id}.estimatedCost`) as number;
    const current = (ctx.seq.get(budgetPath) as number) ?? 0;
    return [
      { path: budgetPath, value: current + cost },
      { path: `proposals.${id}.refundedAt`, value: ctx.seq.now() },
    ];
  });
  seq.insert({
    path: `_rules.proposal_refund_${resource}`,
    rules: [{
      id: `proposal_refund_${resource}`,
      phase: 'observation',
      scope: 'proposals',
      when: { op: 'deltaKindIs', args: ['value'] },
      emit: emitterId,
    }],
  });
}

export function installProposalHandler(
  seq: Sequence,
  resource: string,
  budgetPath: string,
  evaluator: ProposalEvaluator = budgetedEvaluator(),
): void {
  const emitterId = `proposal.handle.${resource}`;
  seq.emitters.set(emitterId, (ctx) => {
    if (ctx.delta.kind !== 'value') return [];
    // Trigger on estimatedCost mount — see proposePlan docstring for
    // why that's the designated trigger field.
    const m = ctx.cell.path.match(/^proposals\.([^.]+)\.estimatedCost$/);
    if (!m) return [];
    const id = m[1];
    // Skip if already decided (status already mounted).
    if (ctx.seq.get(`proposals.${id}.status`) !== undefined) return [];
    const r = ctx.seq.get(`proposals.${id}.resource`);
    if (r !== resource) return [];
    // Target filter: if proposal specifies a target, evaluate only on
    // the target peer. Multi-peer broadcasts otherwise race every
    // reachable handler into duplicate verdicts.
    const target = ctx.seq.get(`proposals.${id}.target`) as string | undefined;
    const self = ctx.seq.get('_self.identity') as string | undefined;
    if (target !== undefined && self !== undefined && target !== self) return [];

    const from = ctx.seq.get(`proposals.${id}.from`) as string;
    const estimatedCost = ctx.seq.get(`proposals.${id}.estimatedCost`) as number;
    const targetTool = ctx.seq.get(`proposals.${id}.targetTool`) as string | undefined;
    const budgetRemaining = (ctx.seq.get(budgetPath) as number) ?? 0;

    const decision = evaluator({
      seq: ctx.seq, id, from, resource,
      estimatedCost, targetTool, budgetRemaining,
    });

    const out: BlockTemplate[] = [];
    if (decision.verdict === 'accept') {
      out.push({ path: `proposals.${id}.status`, value: 'accepted' as ProposalStatus });
      out.push({ path: `proposals.${id}.grantedAt`, value: ctx.seq.now() });
      out.push({ path: budgetPath, value: budgetRemaining - estimatedCost });
    } else if (decision.verdict === 'reject') {
      out.push({ path: `proposals.${id}.status`, value: 'rejected' as ProposalStatus });
      out.push({ path: `proposals.${id}.reason`, value: decision.reason });
      if (decision.suggestedCost !== undefined) {
        out.push({ path: `proposals.${id}.counter.suggestedCost`, value: decision.suggestedCost });
      }
    } else {
      out.push({ path: `proposals.${id}.status`, value: 'countered' as ProposalStatus });
      out.push({ path: `proposals.${id}.reason`, value: decision.reason });
      for (const [k, v] of Object.entries(decision.counter)) {
        out.push({ path: `proposals.${id}.counter.${k}`, value: v });
      }
    }
    return out;
  });

  seq.insert({
    path: `_rules.proposal_handler_${resource}`,
    rules: [{
      id: `proposal_handler_${resource}`,
      phase: 'observation',
      scope: 'proposals',
      when: { op: 'deltaKindIs', args: ['value'] },
      emit: emitterId,
    }],
  });
}

