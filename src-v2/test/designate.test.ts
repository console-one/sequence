// designate.test.ts — the designation fold + the election's turn-taking.
// Spec of "done": deterministic order from ledger data alone; lapsed
// leases excluded (no lease = included — the convention is opt-in);
// slots space by failoverMs and EXPIRE INTO ACT (the election acts at
// or past its slot); the claim fold stays the adjudicator (already-
// claimed outranks designation); malformed rules are loud.

import { designate, DEFAULT_FAILOVER_MS } from '../designate';
import { electCommitment } from '../elect';
import type { ElectObservations } from '../elect';

const MIN = 60_000;
const OCC = Date.UTC(2026, 6, 7, 8, 0, 0);

describe('designate: the fold', () => {
  const rows = [
    { member: 'tp-alpha', validUntil: OCC + 60 * MIN },
    { member: 'tp-beta', validUntil: OCC + 60 * MIN },
    { member: 'tp-gamma' }, // no lease — included (opt-in convention)
  ];

  test('declaration order: fold order is the rank; slots space by failoverMs', () => {
    const d = designate({ order: 'declaration', failoverMs: 30_000 }, rows, OCC);
    expect(d.order).toEqual(['tp-alpha', 'tp-beta', 'tp-gamma']);
    expect(d.slots['tp-alpha']).toBe(OCC);
    expect(d.slots['tp-beta']).toBe(OCC + 30_000);
    expect(d.slots['tp-gamma']).toBe(OCC + 60_000);
  });

  test('member-hash order: deterministic, rotates across occurrences', () => {
    const a = designate({ order: 'member-hash' }, rows, OCC);
    const b = designate({ order: 'member-hash' }, rows, OCC);
    expect(a.order).toEqual(b.order); // same inputs → same answer, any machine
    // A later occurrence WITHIN the leases: same members, possibly a new
    // rotation (a lease-boundary occurrence would correctly exclude them).
    const c = designate({ order: 'member-hash' }, rows, OCC + 30 * MIN);
    expect(new Set(c.order)).toEqual(new Set(a.order));
  });

  test('a lapsed lease excludes the claim from this occurrence', () => {
    const d = designate(
      { order: 'declaration' },
      [{ member: 'tp-alpha', validUntil: OCC - 1 }, { member: 'tp-beta', validUntil: OCC + MIN }],
      OCC,
    );
    expect(d.order).toEqual(['tp-beta']);
  });

  test('duplicate members keep their earliest standing position; empty rows → empty designation', () => {
    const d = designate(
      { order: 'declaration' },
      [{ member: 'tp-alpha' }, { member: 'tp-alpha', validUntil: OCC + MIN }],
      OCC,
    );
    expect(d.order).toEqual(['tp-alpha']);
    expect(designate({ order: 'declaration' }, [], OCC)).toEqual({ order: [], slots: {} });
  });

  test('default failover is 30s; malformed rules throw named', () => {
    const d = designate({ order: 'declaration' }, rows, OCC);
    expect(d.slots['tp-beta']).toBe(OCC + DEFAULT_FAILOVER_MS);
    expect(() => designate({ order: 'fifo' as never }, rows, OCC)).toThrow(/rule\.order/);
    expect(() =>
      designate({ order: 'declaration', failoverMs: 0 }, rows, OCC),
    ).toThrow(/failoverMs/);
  });
});

describe('electCommitment: turn-taking (awaiting-designation)', () => {
  const NOW = OCC + 1_000; // owed
  const candidate = {
    key: `daily-report@${OCC}`,
    owedAt: OCC,
    nextOccurrence: OCC + 3_600_000,
  };
  const obs = (over: Partial<ElectObservations> = {}): ElectObservations => ({
    now: NOW,
    eligible: true,
    budgetAdmits: true,
    alreadyClaimed: false,
    ...over,
  });

  test('before my slot: WAIT to exactly the slot', () => {
    const e = electCommitment(candidate, obs({ designatedAt: NOW + 29_000 }));
    expect(e).toEqual({
      action: 'wait',
      epoch: NOW + 29_000,
      reason: 'awaiting-designation',
    });
  });

  test('at/past my slot, still unclaimed: ACT (the slot expires into act — no starvation)', () => {
    expect(electCommitment(candidate, obs({ designatedAt: NOW })).action).toBe('act');
    expect(electCommitment(candidate, obs({ designatedAt: NOW - 5_000 })).action).toBe('act');
  });

  test('rank 0 (slot = owedAt ≤ now) behaves exactly like today', () => {
    const e = electCommitment(candidate, obs({ designatedAt: OCC }));
    expect(e.action).toBe('act');
    expect(e.reason).toBe('owed-eligible-budget-admits');
  });

  test('already-claimed outranks designation (the fold adjudicated; stand down)', () => {
    const e = electCommitment(
      candidate,
      obs({ alreadyClaimed: true, designatedAt: NOW + 29_000 }),
    );
    expect(e.reason).toBe('already-claimed');
  });

  test('the observation horizon still bounds the designation wait', () => {
    const e = electCommitment(
      candidate,
      obs({ designatedAt: NOW + 29_000, observationHorizon: NOW + 10_000 }),
    );
    expect(e).toEqual({
      action: 'wait',
      epoch: NOW + 10_000,
      reason: 'awaiting-designation',
    });
  });
});
