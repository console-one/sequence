import {
  check,
  cdf, survival, conjugateUpdate, posteriorPredictive, evidenceDecay, type DistParams,
} from '../../src/compose';
import {
  type Sequence,
} from '../sequence';

// ═══════════════════════════════════════════════════════════════════════
// TIME-CONDITIONED CONCRETENESS / TYPE-SURVIVAL DECAY
// (ported from v1 sequence.ts::concretenessDistribution)
//
// Productivity at a path is the joint probability of three independent
// factors at lookahead time t:
//   completion(t)   — P(value resolves by t), driven by the type's
//                     distribution('time', family, params) constraint
//                     OR alreadyRealized=1 if the cell already has a
//                     value satisfying its schema.
//   typeSurvival(t) — P(claim still holds at t), driven by the nearest
//                     `decay(family, params|fn)` constraint walked up
//                     the path's ancestor chain. Absent any decay
//                     constraint, survival is 1 (no information ageing).
//   provenance(t)   — P(producer still authoritative at t). Stub
//                     (returns 1) until producer-decay chain walking
//                     lands as its own emitter.
//
// `concretenessDistribution(seq, path)` returns the three factor
// callables plus their pointwise product as `cdf(t)`. Time-survival
// uses `survival(family, dt, params)` from compose.ts for the named
// distribution families ('exponential', 'weibull', 'lognormal',
// 'fixed'); the `'fn'` family lets a type carry an arbitrary
// (dt) => number directly.
//
// `decay()` constraint constructor is in `../src/type` and shared
// with v1; v2 reads the same constraint shape.
// ═══════════════════════════════════════════════════════════════════════

export interface ConcretenessDistribution {
  cdf: (t: number) => number;
  factors: {
    completion: (t: number) => number;
    typeSurvival: (t: number) => number;
    provenance: (t: number) => number;
  };
}

interface DecayInfo {
  family: string;
  params?: DistParams;
  fn?: (dt: number) => number;
  rootTime: number;
}

/**
 * Walk path segments from leaf to root looking for the nearest type
 * carrying a `decay(...)` constraint. Returns the parsed decay info and
 * the rootTime — the earliest block.time at the ancestor cell. If the
 * ancestor cell has no recorded blocks (intermediate path), use now().
 */
function findDecayInfo(seq: Sequence, path: string): DecayInfo | undefined {
  const parts = path ? path.split('.') : [];
  for (let i = parts.length; i >= 1; i--) {
    const ancestorPath = parts.slice(0, i).join('.');
    const schema = seq.typeAt(ancestorPath);
    if (!schema) continue;
    const decayC = schema.constraints.find(c => c.op === 'decay');
    if (!decayC) continue;
    const family = decayC.args[0] as string;
    const cell = seq.getCell(ancestorPath);
    const rootTime = cell?.blocks[0]?.time ?? seq.now();
    if (family === 'fn') {
      return {
        family,
        fn: decayC.args[1] as (dt: number) => number,
        rootTime,
      };
    }
    return {
      family,
      params: decayC.args[1] as DistParams,
      rootTime,
    };
  }
  return undefined;
}

/**
 * Compute the time-conditioned concreteness distribution for a path.
 * The three factors compose multiplicatively at any lookahead time t.
 */
export function concretenessDistribution(
  seq: Sequence,
  path: string,
): ConcretenessDistribution {
  const now = seq.now();
  const value = seq.get(path);
  const schema = seq.typeAt(path);
  const alreadyRealized =
    value !== undefined && (!schema || check(schema, value, path).ok);

  // Factor 1 — Completion.
  let timeFamily: string | undefined;
  let timeParams: DistParams | undefined;
  if (schema) {
    const timeDist = schema.constraints.find(
      c => c.op === 'distribution' && c.args[0] === 'time',
    );
    if (timeDist) {
      timeFamily = timeDist.args[1] as string;
      timeParams = timeDist.args[2] as DistParams;
    }
  }

  const completionAt = (t: number): number => {
    if (alreadyRealized) return 1;
    if (timeFamily && timeParams) {
      return cdf(timeFamily, Math.max(0, t - now), timeParams);
    }
    return 0;
  };

  // Factor 2 — Type-survival.
  const decayInfo = findDecayInfo(seq, path);

  const typeSurvivalAt = (t: number): number => {
    if (!decayInfo) return 1;
    const dt = Math.max(0, t - decayInfo.rootTime);
    if (decayInfo.family === 'fn') {
      return typeof decayInfo.fn === 'function' ? decayInfo.fn(dt) : 1;
    }
    return survival(decayInfo.family, dt, decayInfo.params as DistParams);
  };

  // Factor 3 — Provenance (stub).
  const provenanceAt = (_t: number): number => 1;

  return {
    cdf: (t: number) => completionAt(t) * typeSurvivalAt(t) * provenanceAt(t),
    factors: {
      completion: completionAt,
      typeSurvival: typeSurvivalAt,
      provenance: provenanceAt,
    },
  };
}

// Re-exports of the math primitives so v2 consumers don't have to dip
// into `../src/compose` directly. These are the building blocks used by
// concretenessDistribution and by future emitters that update beliefs
// (behavioral predicates, refinement, reliability sub-bucketing).
export { cdf, survival, posteriorPredictive, conjugateUpdate, evidenceDecay };
export type { DistParams };

