// elect.test.ts — the standalone commitment election (S-B2 POSMDP / R8).
// Spec of "done": WAIT is first-class and carries the next decision
// epoch; the reason set is closed and its precedence order is fixed;
// dueness rides `check` (max is inclusive); malformed inputs and
// spin-inducing wait epochs are loud, never silent.

import { electCommitment } from '../elect';
import type { CommitmentCandidate, ElectObservations } from '../elect';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 6, 5, 12, 0, 0);

function candidate(over: Partial<CommitmentCandidate> = {}): CommitmentCandidate {
  return {
    key: `daily-report@${NOW - HOUR}`,
    owedAt: NOW - HOUR,
    nextOccurrence: NOW + HOUR,
    terms: { withinMs: 600_000 },
    ...over,
  };
}

function obs(over: Partial<ElectObservations> = {}): ElectObservations {
  return { now: NOW, eligible: true, budgetAdmits: true, alreadyClaimed: false, ...over };
}

describe('electCommitment: the decide-when election', () => {
  test('act: owed ∧ unclaimed ∧ eligible ∧ budget-admits — deadline = now + withinMs; next epoch = next occurrence', () => {
    const e = electCommitment(candidate(), obs());
    expect(e).toEqual({
      action: 'act',
      epoch: NOW + HOUR,
      deadline: NOW + 600_000,
      reason: 'owed-eligible-budget-admits',
    });
  });

  test('act without terms carries no deadline', () => {
    const e = electCommitment(candidate({ terms: undefined }), obs());
    expect(e.action).toBe('act');
    expect(e.deadline).toBeUndefined();
  });

  test('WAIT is first-class: not-due wakes AT the occurrence, not at next', () => {
    const e = electCommitment(
      candidate({ owedAt: NOW + 30_000, nextOccurrence: NOW + HOUR }),
      obs(),
    );
    expect(e).toEqual({ action: 'wait', epoch: NOW + 30_000, reason: 'not-due' });
  });

  test('dueness is inclusive (max relation): owed exactly at now acts', () => {
    const e = electCommitment(candidate({ owedAt: NOW }), obs());
    expect(e.action).toBe('act');
  });

  test('already-claimed → wait to next occurrence (the tiebreak lost before it ran)', () => {
    const e = electCommitment(candidate(), obs({ alreadyClaimed: true }));
    expect(e).toEqual({ action: 'wait', epoch: NOW + HOUR, reason: 'already-claimed' });
  });

  test('reason precedence is fixed: claimed beats ineligible beats budget-blocked', () => {
    expect(
      electCommitment(candidate(), obs({ alreadyClaimed: true, eligible: false, budgetAdmits: false })).reason,
    ).toBe('already-claimed');
    expect(
      electCommitment(candidate(), obs({ eligible: false, budgetAdmits: false })).reason,
    ).toBe('ineligible');
    expect(
      electCommitment(candidate(), obs({ budgetAdmits: false })).reason,
    ).toBe('budget-blocked');
  });

  test('deterministic: same inputs, same election', () => {
    const a = electCommitment(candidate(), obs({ budgetAdmits: false }));
    const b = electCommitment(candidate(), obs({ budgetAdmits: false }));
    expect(a).toEqual(b);
  });

  test('loud: malformed inputs are named errors, never verdicts', () => {
    expect(() => electCommitment(candidate({ key: '' }), obs())).toThrow(/candidate\.key/);
    expect(() => electCommitment(candidate({ owedAt: NaN }), obs())).toThrow(/owedAt/);
    expect(() =>
      electCommitment(candidate({ nextOccurrence: Number.POSITIVE_INFINITY }), obs()),
    ).toThrow(/nextOccurrence/);
    expect(() =>
      electCommitment(candidate({ nextOccurrence: NOW - 2 * HOUR }), obs()),
    ).toThrow(/must be after owedAt/);
    expect(() =>
      electCommitment(candidate({ terms: { withinMs: 0 } }), obs()),
    ).toThrow(/withinMs must be > 0/);
    expect(() =>
      electCommitment(candidate(), obs({ now: NaN })),
    ).toThrow(/observations\.now/);
  });

  test('loud: a wait whose epoch is not in the future would spin the wake loop — refused', () => {
    // Stale candidate: nextOccurrence already passed relative to now.
    expect(() =>
      electCommitment(
        candidate({ owedAt: NOW - 3 * HOUR, nextOccurrence: NOW - 2 * HOUR }),
        obs({ alreadyClaimed: true }),
      ),
    ).toThrow(/re-derive the owed occurrence/);
  });

  test('every wait election\'s epoch is strictly after now (the semi-Markov invariant)', () => {
    const waits = [
      electCommitment(candidate({ owedAt: NOW + 1, nextOccurrence: NOW + HOUR }), obs()),
      electCommitment(candidate(), obs({ alreadyClaimed: true })),
      electCommitment(candidate(), obs({ eligible: false })),
      electCommitment(candidate(), obs({ budgetAdmits: false })),
    ];
    for (const e of waits) {
      expect(e.action).toBe('wait');
      expect(e.epoch).toBeGreaterThan(NOW);
    }
  });
});
