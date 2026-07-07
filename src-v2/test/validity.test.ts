// validity.test.ts — timeHorizon (the closed valid-until family) + the
// election's observation-horizon clamp (expiry-as-deviation). Spec of
// "done": the recognized family is CLOSED (unknown shapes → null, never
// a guess); a FUTURE horizon bounds every epoch the election returns; a
// past/absent horizon changes nothing.

import { timeHorizon } from '../validity';
import { electCommitment } from '../elect';
import type { CommitmentCandidate, ElectObservations } from '../elect';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 6, 7, 12, 0, 0);

describe('timeHorizon: the closed valid-until family', () => {
  test('lte($now, T) and lt($now, T) → T', () => {
    expect(timeHorizon({ op: 'lte', args: ['$now', NOW + HOUR] })).toBe(NOW + HOUR);
    expect(timeHorizon({ op: 'lt', args: ['$now', NOW + 2 * HOUR] })).toBe(NOW + 2 * HOUR);
  });

  test('and_clause → min of members; unrecognized members ignored', () => {
    expect(
      timeHorizon({
        op: 'and_clause',
        args: [
          { op: 'lte', args: ['$now', NOW + 3 * HOUR] },
          { op: 'eq', args: ['metadata.phase', 'ready'] },
          { op: 'lte', args: ['$now', NOW + HOUR] },
        ],
      }),
    ).toBe(NOW + HOUR);
  });

  test('unknown shapes → null (closed family, never a guess)', () => {
    expect(timeHorizon(undefined)).toBeNull();
    expect(timeHorizon({ op: 'gte', args: ['$now', NOW] })).toBeNull();
    expect(timeHorizon({ op: 'lte', args: ['metadata.count', 5] })).toBeNull();
    expect(timeHorizon({ op: 'lte', args: ['$now', 'midnight'] })).toBeNull();
    expect(timeHorizon({ op: 'or_clause', args: [{ op: 'lte', args: ['$now', NOW] }] })).toBeNull();
  });
});

describe('electCommitment: the observation-horizon clamp', () => {
  function candidate(over: Partial<CommitmentCandidate> = {}): CommitmentCandidate {
    return {
      key: `daily-report@${NOW - HOUR}`,
      owedAt: NOW - HOUR,
      nextOccurrence: NOW + HOUR,
      ...over,
    };
  }
  function obs(over: Partial<ElectObservations> = {}): ElectObservations {
    return { now: NOW, eligible: true, budgetAdmits: true, alreadyClaimed: false, ...over };
  }

  test('a future horizon bounds the WAIT epoch (re-derive when claims can lapse)', () => {
    const e = electCommitment(candidate(), obs({ alreadyClaimed: true, observationHorizon: NOW + 10 * 60_000 }));
    expect(e).toEqual({ action: 'wait', epoch: NOW + 10 * 60_000, reason: 'already-claimed' });
  });

  test('a future horizon bounds the ACT epoch too (the next decision, not the act)', () => {
    const e = electCommitment(candidate(), obs({ observationHorizon: NOW + 10 * 60_000 }));
    expect(e.action).toBe('act');
    expect(e.epoch).toBe(NOW + 10 * 60_000);
  });

  test('a horizon LATER than the natural epoch changes nothing', () => {
    const e = electCommitment(candidate(), obs({ alreadyClaimed: true, observationHorizon: NOW + 5 * HOUR }));
    expect(e.epoch).toBe(NOW + HOUR); // the natural nextOccurrence
  });

  test('a horizon at or before now is ignored (observations were just derived)', () => {
    const e1 = electCommitment(candidate(), obs({ alreadyClaimed: true, observationHorizon: NOW }));
    expect(e1.epoch).toBe(NOW + HOUR);
    const e2 = electCommitment(candidate(), obs({ alreadyClaimed: true, observationHorizon: NOW - HOUR }));
    expect(e2.epoch).toBe(NOW + HOUR);
  });

  test('not-due wait clamps to the horizon when claims expire before dueness', () => {
    const e = electCommitment(
      candidate({ owedAt: NOW + 2 * HOUR, nextOccurrence: NOW + 3 * HOUR }),
      obs({ observationHorizon: NOW + HOUR }),
    );
    expect(e).toEqual({ action: 'wait', epoch: NOW + HOUR, reason: 'not-due' });
  });
});
