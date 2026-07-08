/**
 * elect.ts (v2) — standalone commitment election over plain observations.
 *
 * ONE EXPORT: electCommitment(candidate, observations) — the decide-when
 * election an actor runs at a decision epoch: given one owed occurrence
 * of work (the candidate commitment) and what the actor observes (the
 * shared spine's claim state, its own eligibility and budget posture,
 * the clock), elect `act` or `wait` — and, semi-Markov, elect the TIME
 * OF THE NEXT DECISION as part of the answer. WAIT is first-class: its
 * `epoch` is the wake the actor schedules for itself.
 *
 * WHY THIS EXISTS (S-B2 POSMDP; THE-CALCULUS R8): when-to-act is the
 * primary operation of any actor. The first S-B2 build baked the
 * election into a who-grabs-a-window race and never touched this
 * package — the named regression. This module is the seam where the
 * policy LIVES IN SEQUENCE: v0 is the trivial policy (act iff owed ∧
 * unclaimed ∧ eligible ∧ budget-admits), and the planner upgrade (v0b:
 * expected-information-per-cost over searchCandidates/feasibility,
 * specs/docs/COMMITMENTS.md) replaces these internals WITHOUT moving
 * the seam — consumers keep calling electCommitment.
 *
 * WHAT IS REUSED (never reimplemented): the dueness relation — "the
 * occurrence is at or before now" — is `number ∧ max(now)` conformance
 * delegated to `check` from ../src/compose, the same delegation
 * evaluate.ts and product code (constraint-relation.ts's reachedMin)
 * already proved. NOTHING is imported from the v1 engine.
 *
 * WHAT THIS MODULE OWNS (the decision table, not relation semantics):
 * the CLOSED, ORDERED reason set. Checks run in a fixed order so the
 * elected reason is deterministic and auditable:
 *   1 not-due          → wait until the occurrence itself becomes due
 *   2 already-claimed  → another sovereign actor acted; wait to next
 *   3 ineligible       → no valid rendered contract; wait to next
 *   4 budget-blocked   → prices don't admit acting now; wait to next
 *   5 (else) act       → deadline = now + terms.withinMs (the
 *                        commitment deadline); next decision at the
 *                        next occurrence.
 *
 * NAME COLLISION, DELIBERATE: the v1 root package exports an
 * electCommitment that WRITES a commitment record into a live v1
 * Sequence (src/commitments.ts — the write-lease API). THIS
 * electCommitment is the v2 standalone *election* — it decides, it
 * writes nothing. The consumer appends the claim (the conflict marker)
 * itself iff the election is `act`.
 *
 * FAIL-LOUD: malformed candidates/observations throw named errors —
 * a wait election whose epoch is not in the caller's future would spin
 * the actor's wake loop, so it is a contract breach here, never a
 * silent verdict.
 */

import { createType, max } from '../src/type';
import { check } from '../src/compose';

/** One owed occurrence of declared work, as the actor observed it —
 *  plain data (topic-dao's OwedOccurrence maps onto this 1:1). */
export interface CommitmentCandidate {
  /** Identity of the owed occurrence (the claim's dedup key). */
  key: string;
  /** The cadence time this occurrence is due for (epoch ms). */
  owedAt: number;
  /** The occurrence after this one — the natural WAIT epoch. */
  nextOccurrence: number;
  /** The declared lease terms: acting commits to done-within. */
  terms?: { withinMs: number };
}

/** What the actor observes at this decision epoch. Partial by nature:
 *  the spine (others' claims), its own contract validity, its own
 *  budget posture. All derived by the HOST at read — nothing here is
 *  stored decision state. */
export interface ElectObservations {
  now: number;
  /** A live rendered contract makes this actor eligible (derived). */
  eligible: boolean;
  /** Do prices admit acting now (v0: the host's boolean; v0b: priced). */
  budgetAdmits: boolean;
  /** The actor's OWN SLOT from the space's designation fold (allocation
   *  as declared space law): before it, the election waits to exactly
   *  that instant (reason 'awaiting-designation'); at/after it, an
   *  unclaimed owed occurrence is acted on — every slot expires into
   *  act, so designation shapes WHEN, never whether. Absent = no rule
   *  declared = the classic race at owedAt. */
  designatedAt?: number;
  /** The instant these observations STOP BEING VALID — e.g. the soonest
   *  valid-until among the rendered claims eligibility derived from
   *  (timeHorizon over their validity terms). A known future expiry IS
   *  a decision epoch: every returned epoch is clamped to ≤ this bound
   *  (when it is in the future), so the actor re-derives no later than
   *  the moment its observed world can change out from under it.
   *  Absent/past horizons change nothing. */
  observationHorizon?: number;
  /** A winning claim already covers this occurrence on the spine. */
  alreadyClaimed: boolean;
}

export type ElectReason =
  | 'owed-eligible-budget-admits'
  | 'not-due'
  | 'already-claimed'
  | 'ineligible'
  | 'budget-blocked'
  | 'awaiting-designation';

/** The election. `epoch` is ALWAYS the time of this actor's next
 *  decision — for `wait` it is the wake to schedule; for `act` it is
 *  the decision epoch after executing (the next occurrence). */
export interface Election {
  action: 'act' | 'wait';
  epoch: number;
  /** act only: the commitment deadline (now + terms.withinMs). */
  deadline?: number;
  reason: ElectReason;
}

function gateFinite(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`electCommitment: '${name}' must be a finite epoch-ms number`);
  }
  return v;
}

export function electCommitment(
  candidate: CommitmentCandidate,
  obs: ElectObservations,
): Election {
  if (!candidate || typeof candidate.key !== 'string' || !candidate.key) {
    throw new Error(`electCommitment: candidate.key (non-empty string) is required`);
  }
  const owedAt = gateFinite(candidate.owedAt, 'candidate.owedAt');
  const nextOccurrence = gateFinite(candidate.nextOccurrence, 'candidate.nextOccurrence');
  const now = gateFinite(obs.now, 'observations.now');
  if (nextOccurrence <= owedAt) {
    throw new Error(
      `electCommitment: nextOccurrence ${nextOccurrence} must be after owedAt ${owedAt}`,
    );
  }
  if (candidate.terms !== undefined) {
    const withinMs = gateFinite(candidate.terms.withinMs, 'candidate.terms.withinMs');
    if (withinMs <= 0) {
      throw new Error(`electCommitment: terms.withinMs must be > 0`);
    }
  }

  // Expiry-as-deviation: a FUTURE observation horizon bounds every
  // epoch this election returns — the actor must re-derive no later
  // than the instant its observed claims can lapse. A horizon at or
  // before now is ignored (the observations were just derived; any
  // already-lapsed claim is already reflected in them).
  const horizon =
    obs.observationHorizon !== undefined &&
    Number.isFinite(obs.observationHorizon) &&
    obs.observationHorizon > now
      ? obs.observationHorizon
      : null;
  const bound = (epoch: number): number =>
    horizon !== null && horizon < epoch ? horizon : epoch;

  // Dueness is a conformance relation, not an if-statement in disguise:
  // owedAt satisfies `number ∧ max(now)` iff the occurrence is at or
  // before now (max is inclusive — due exactly at now IS due).
  const due = check(createType('number', [max(now)]), owedAt).ok;
  if (!due) {
    // The candidate becomes due at owedAt — that IS the next decision
    // (or sooner, if the observed claims expire first).
    return { action: 'wait', epoch: bound(owedAt), reason: 'not-due' };
  }

  const waitToNext = (reason: ElectReason): Election => {
    if (nextOccurrence <= now) {
      // A wait that would wake in the past spins the actor's loop —
      // the caller derived a stale candidate; refuse loudly.
      throw new Error(
        `electCommitment: wait epoch ${nextOccurrence} is not after now ${now} — ` +
        `re-derive the owed occurrence before electing`,
      );
    }
    return { action: 'wait', epoch: bound(nextOccurrence), reason };
  };

  if (obs.alreadyClaimed) return waitToNext('already-claimed');
  if (!obs.eligible) return waitToNext('ineligible');
  if (!obs.budgetAdmits) return waitToNext('budget-blocked');
  if (
    obs.designatedAt !== undefined &&
    Number.isFinite(obs.designatedAt) &&
    obs.designatedAt > now
  ) {
    // My turn hasn't arrived: wait to exactly my slot (the designation
    // fold's answer), still bounded by the observation horizon.
    return {
      action: 'wait',
      epoch: bound(obs.designatedAt),
      reason: 'awaiting-designation',
    };
  }

  return {
    action: 'act',
    epoch: bound(nextOccurrence),
    ...(candidate.terms !== undefined
      ? { deadline: now + candidate.terms.withinMs }
      : {}),
    reason: 'owed-eligible-budget-admits',
  };
}
