/**
 * trajectory.ts — the FORECAST TRAJECTORY of a capability's type surface,
 * and expiry derived from it (the office design's §14 item 13: "session
 * expiry and contingent guarantees must be DERIVED from the trajectory of
 * the capability's type surface, not stamped as constants").
 *
 * The posteriors (`_prior.reliability` as beta, `_prior.latency` as gamma)
 * are point-in-time sufficient statistics with no time index. This module
 * adds the one missing derivative: on every observation the host records
 * a TREND sibling — the posterior mean, when it was observed, and an
 * exponentially weighted slope of that mean per hour. O(1) per update;
 * a fact like any other, replayed with the log.
 *
 * Expiry from the trajectory: a surfaced contract promised a mean m₀ at
 * t₀ within a tolerance δ. The forecast leaves the bound when |slope| · Δt
 * exceeds δ, so the derived expiry is t₀ + δ / |slope|, clipped to
 * [minMs, ceilingMs]. With no trend, too few samples, or a flat slope the
 * ceiling (the stamped ttl) stands — the constant becomes the CEILING,
 * never the answer.
 */

import type { Sequence } from './sequence';

export type Trend = {
  /** Posterior mean at the last observation. */
  mean: number;
  /** Clock time of the last observation (ms). */
  at: number;
  /** Exponentially weighted slope of the mean, per hour. */
  slopePerHour: number;
  /** Observations folded into this trend. */
  samples: number;
};

/** Weight of the newest instantaneous slope in the EW average. */
export const TREND_ALPHA = 0.3;
/** Default tolerance on a surfaced mean (reliability is in [0,1]; latency trends use a relative δ). */
export const TOLERANCE_DEFAULT = 0.1;
/** Floor on a derived expiry: never shorter than a minute. */
export const EXPIRY_MIN_MS = 60_000;
/** Trends with fewer samples than this do not bound an expiry. */
export const TREND_MIN_SAMPLES = 3;

const HOUR_MS = 3_600_000;

/** Fold one observation of a posterior mean into the trend at `path`. */
export function updateTrend(seq: Sequence, path: string, mean: number, now: number): Trend {
  const prev = seq.getCell(path)?.value as Trend | undefined;
  let slope = 0;
  let samples = 1;
  if (prev && typeof prev.at === 'number' && typeof prev.mean === 'number') {
    const dtH = (now - prev.at) / HOUR_MS;
    samples = (prev.samples ?? 1) + 1;
    if (dtH > 0) {
      const inst = (mean - prev.mean) / dtH;
      const prevSlope = typeof prev.slopePerHour === 'number' ? prev.slopePerHour : 0;
      slope = prev.samples && prev.samples > 1 ? prevSlope + TREND_ALPHA * (inst - prevSlope) : inst;
    } else {
      slope = typeof prev.slopePerHour === 'number' ? prev.slopePerHour : 0;
    }
  }
  const next: Trend = { mean, at: now, slopePerHour: Number(slope.toPrecision(4)), samples };
  seq.insert({ path, value: next });
  return next;
}

export type ExpiryBasis =
  | { basis: 'trajectory'; expiresAt: number; boundBy: string; slopePerHour: number; tolerance: number }
  | { basis: 'ceiling'; expiresAt: number; tolerance: number };

/** The expiry a set of surfaced tools can honestly be promised: the
 *  earliest moment any of their trajectories leaves its tolerance,
 *  clipped to [now + EXPIRY_MIN_MS, ceilingMs]. */
export function expiryFromTrajectory(
  seq: Sequence,
  tools: readonly string[],
  opts: { now: number; ceilingMs: number; tolerance?: number },
): ExpiryBasis {
  const tolerance = opts.tolerance ?? TOLERANCE_DEFAULT;
  let best: { expiresAt: number; boundBy: string; slopePerHour: number } | null = null;
  for (const tool of tools) {
    for (const [suffix, relative] of [['reliabilityTrend', false], ['latencyTrend', true]] as const) {
      const t = seq.getCell(`${tool}._prior.${suffix}`)?.value as Trend | undefined;
      if (!t || (t.samples ?? 0) < TREND_MIN_SAMPLES) continue;
      const slope = Math.abs(t.slopePerHour);
      if (!(slope > 0)) continue;
      // latency: δ is relative to the surfaced mean; reliability: absolute in [0,1]
      const bound = relative ? tolerance * Math.max(t.mean, 1e-9) : tolerance;
      const horizonMs = (bound / slope) * HOUR_MS;
      const candidate = Math.max(opts.now + EXPIRY_MIN_MS, Math.min(opts.ceilingMs, t.at + horizonMs));
      if (!best || candidate < best.expiresAt) best = { expiresAt: candidate, boundBy: tool, slopePerHour: t.slopePerHour };
    }
  }
  if (!best || best.expiresAt >= opts.ceilingMs) return { basis: 'ceiling', expiresAt: opts.ceilingMs, tolerance };
  return { basis: 'trajectory', ...best, tolerance };
}

/** Does a new posterior mean still inhabit what was surfaced? */
export function withinTolerance(surfacedMean: number, newMean: number, tolerance: number, relative = false): boolean {
  const bound = relative ? tolerance * Math.max(Math.abs(surfacedMean), 1e-9) : tolerance;
  return Math.abs(newMean - surfacedMean) <= bound;
}
