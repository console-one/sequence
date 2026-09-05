/**
 * trajectory tests — the forecast trajectory and expiry derived from it.
 * Laws: (1) the trend is an EW slope of the posterior mean per hour;
 * (2) a flat or thin trend never bounds expiry (the ceiling stands);
 * (3) a drifting trend bounds expiry at δ/|slope|, clipped to
 * [now + 1 min, ceiling]; (4) withinTolerance is absolute for
 * reliability and relative for latency.
 */
import { Sequence } from '../sequence';
import { updateTrend, expiryFromTrajectory, withinTolerance, EXPIRY_MIN_MS } from '../trajectory';
import { FT } from '../../src/builder';
import { observeToolCall } from '../vend';

const H = 3_600_000;

describe('trajectory', () => {
  test('updateTrend: the slope is the EW average of instantaneous slopes per hour', () => {
    const clock = { t: 0 };
    const s = new Sequence(() => clock.t);
    updateTrend(s, 'x.t', 0.9, clock.t);
    clock.t += H; updateTrend(s, 'x.t', 0.8, clock.t);          // inst −0.1/h; first slope = inst
    let tr = s.getCell('x.t')?.value as { slopePerHour: number; samples: number };
    expect(tr.samples).toBe(2); expect(tr.slopePerHour).toBeCloseTo(-0.1, 6);
    clock.t += H; updateTrend(s, 'x.t', 0.6, clock.t);          // inst −0.2/h; EW: −0.1 + 0.3·(−0.2+0.1) = −0.13
    tr = s.getCell('x.t')?.value as { slopePerHour: number; samples: number };
    expect(tr.samples).toBe(3); expect(tr.slopePerHour).toBeCloseTo(-0.13, 4);
  });

  test('no trend, too few samples, or a flat slope → the ceiling stands', () => {
    const s = new Sequence(() => 1_000_000);
    const now = 1_000_000, ceiling = now + H;
    expect(expiryFromTrajectory(s, ['a'], { now, ceilingMs: ceiling })).toEqual({ basis: 'ceiling', expiresAt: ceiling, tolerance: 0.1 });
    updateTrend(s, 'a._prior.reliabilityTrend', 0.9, now); updateTrend(s, 'a._prior.reliabilityTrend', 0.7, now + H);
    expect(expiryFromTrajectory(s, ['a'], { now, ceilingMs: ceiling }).basis).toBe('ceiling'); // 2 samples < 3
    updateTrend(s, 'b._prior.reliabilityTrend', 0.9, now); updateTrend(s, 'b._prior.reliabilityTrend', 0.9, now + H); updateTrend(s, 'b._prior.reliabilityTrend', 0.9, now + 2 * H);
    expect(expiryFromTrajectory(s, ['b'], { now, ceilingMs: ceiling }).basis).toBe('ceiling'); // flat
  });

  test('a drifting reliability bounds the expiry at δ/|slope|, clipped', () => {
    const s = new Sequence(() => 0);
    const t0 = 0;
    // mean falls 0.1 per hour, three samples → slope ≈ −0.1/h; δ = 0.1 → 1 hour from the last observation
    updateTrend(s, 'a._prior.reliabilityTrend', 0.9, t0);
    updateTrend(s, 'a._prior.reliabilityTrend', 0.8, t0 + H);
    updateTrend(s, 'a._prior.reliabilityTrend', 0.7, t0 + 2 * H);
    const now = t0 + 2 * H;
    const r = expiryFromTrajectory(s, ['a'], { now, ceilingMs: now + 10 * H, tolerance: 0.1 });
    expect(r.basis).toBe('trajectory');
    if (r.basis === 'trajectory') {
      expect(r.boundBy).toBe('a');
      expect(r.expiresAt).toBeCloseTo(now + H, -3);
    }
    // a tighter tolerance → sooner; the floor is one minute
    const tight = expiryFromTrajectory(s, ['a'], { now, ceilingMs: now + 10 * H, tolerance: 0.0000001 });
    expect(tight.expiresAt).toBe(now + EXPIRY_MIN_MS);
    // a ceiling below the derived bound → the ceiling
    expect(expiryFromTrajectory(s, ['a'], { now, ceilingMs: now + 1_800_000, tolerance: 0.1 }).basis).toBe('ceiling');
  });

  test('observeToolCall writes both trends; a failing tool shortens a vended expiry end to end', () => {
    const clock = { t: 0 };
    const s = new Sequence(() => clock.t);
    s.insert({ path: 'fs.read', type: FT.fn({ input: FT.object({ p: FT.string() }), description: 'read', impl: 'fs.read' }) });
    // ten successes over ten hours, then failures every hour: the mean drifts down
    for (let i = 0; i < 10; i++) { clock.t += H; observeToolCall(s, 'fs.read', 20, true); }
    for (let i = 0; i < 5; i++) { clock.t += H; observeToolCall(s, 'fs.read', 20, false); }
    const rt = s.getCell('fs.read._prior.reliabilityTrend')?.value as { slopePerHour: number; samples: number };
    const lt = s.getCell('fs.read._prior.latencyTrend')?.value as { samples: number };
    expect(rt.samples).toBe(15); expect(rt.slopePerHour).toBeLessThan(0); expect(lt.samples).toBe(15);
    const now = clock.t;
    const r = expiryFromTrajectory(s, ['fs.read'], { now, ceilingMs: now + 24 * H, tolerance: 0.1 });
    expect(r.basis).toBe('trajectory');
    expect(r.expiresAt).toBeGreaterThan(now + EXPIRY_MIN_MS - 1);
    expect(r.expiresAt).toBeLessThan(now + 24 * H);
  });

  test('withinTolerance: absolute for reliability, relative for latency', () => {
    expect(withinTolerance(0.9, 0.85, 0.1)).toBe(true);
    expect(withinTolerance(0.9, 0.75, 0.1)).toBe(false);
    expect(withinTolerance(200, 215, 0.1, true)).toBe(true);
    expect(withinTolerance(200, 250, 0.1, true)).toBe(false);
  });
});
