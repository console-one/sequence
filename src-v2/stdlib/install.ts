import {
  type Constraint, returns, indexSpec,
} from '../../src/type';
import {
  type Sequence,
} from '../sequence';
import { installPartitionDirection } from './partition';
import { electCommitment } from './commitments';
import { reliabilityUpdate, installRefinement } from './reliability';
import { indexSpecDriver } from './index-spec';

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

/**
 * Install the `limit` guard — admission predicate over a numeric meter
 * cell. This is the substrate-native replacement for guardrail's
 * `LimitBuilder.toLessThan(N).per(...)` pattern: the meter is just a
 * cell at a known path, increments are delta-applied via `<<`, and the
 * limit guard reads that cell at write time.
 *
 *   Constraint shape: `{ op: 'limit', args: [meterPath, limit, delta?] }`
 *   - meterPath: cell path holding the running counter (number; default 0)
 *   - limit: max value allowed AFTER admitting this delta (strict <)
 *   - delta: contribution of this admission (default 1)
 *
 *   Admits when `(current ?? 0) + delta < limit`.
 *
 * Partition keys are encoded into the path by the caller — e.g.
 * `_meters.calls.${user}.${windowStartMs}`. The substrate doesn't need a
 * separate partition concept because cell paths are already
 * tree-structured. Per-window resets aren't needed: a fresh path per
 * window means stale partitions just stop being read.
 *
 * This guard is the building block; admission lifecycles (commit on
 * success, refund on reject, +/- delta pairs for in-flight singletons)
 * compose by writing to the meter with `<<` deltas at the right
 * lifecycle points.
 */
export function installLimit(seq: Sequence): void {
  seq.guards.set('limit', (c, s) => {
    const meterPath = c.args[0] as string;
    const max = c.args[1] as number;
    const delta = (c.args[2] as number) ?? 1;
    const current = (s.get(meterPath) as number) ?? 0;
    return current + delta <= max;
  });
}

/**
 * Install the `meter` guard — read-only inspection of a numeric meter
 * with no admission semantics. Useful for posteriors and observability
 * surfaces that need the current value without re-deriving it.
 *
 *   Constraint shape: `{ op: 'meterAt', args: [meterPath] }`
 *   - meterPath: cell path holding the running counter
 *
 *   Always returns true (no admission impact); side effect is the read.
 *
 * Mostly here so a sequence consumer can declare "this rule cares about
 * the meter at X" in a way the substrate's depend-on graph picks up
 * without needing a custom op.
 */
export function installMeterAt(seq: Sequence): void {
  seq.guards.set('meterAt', () => true);
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
  installPartitionDirection(seq);
  installCommitment(seq);
  installReliability(seq);
  installPosteriorAdmit(seq);
  installLimit(seq);
  installMeterAt(seq);
  installIndexSpec(seq);
  installRefinement(seq);
}

