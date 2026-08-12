import {
  conjugateUpdate,
} from '../../src/compose';
import {
  type Sequence,
  type BlockTemplate,
} from '../sequence';

// ═══════════════════════════════════════════════════════════════════════
// BEHAVIORAL PREDICATES — Bayesian update on identity/equation observation
// (ported from v1 sequence.ts::enforceBehavioral)
//
// A type carrying `identity(outPath, inPath)` claims the values at those
// paths must be equal. A type carrying `equation(lhs, rhs, opts?)` claims
// the values at lhs and rhs must be equal (with optional temporal bounds
// — the bounds are read but only the predicate equality is enforced
// here; richer expression evaluation can land later).
//
// `installBehavioralPredicates(seq)` mounts a global observation rule.
// On every value change anywhere outside `_*` paths, the rule walks the
// cell tree looking for schemas whose identity/equation constraints
// reference the changed path. For each match it reads both ends, checks
// equality, and conjugate-updates a beta prior at
//   `${schemaPath}._prior.reliability`
// with `success` if the predicate holds and `failure` if not.
//
// Cycle safety: the emitter checks `block.cause?.ruleId` and skips its
// own induced writes (the prior cells), so updating a prior never
// triggers further predicate enforcement. Same-frame `seen` de-dup in
// the kernel prevents the same prior path being touched twice in one
// cascade.
//
// Cost: O(N_cells) walk per observed value change. Acceptable for MVP;
// a registry-driven optimization (mount-time index of predicate-bearing
// schemas keyed by observed paths) is a follow-up port.
// ═══════════════════════════════════════════════════════════════════════

/** Recursive cell walker built on the public `childSegments` API. */
export function walkPaths(
  seq: Sequence,
  prefix: string,
  visit: (path: string) => void,
): void {
  for (const child of seq.childSegments(prefix)) {
    const path = prefix ? `${prefix}.${child}` : child;
    visit(path);
    walkPaths(seq, path, visit);
  }
}

/** Conjugate-update a beta prior at the given path; return the
 *  BlockTemplate that writes the new params back. */
function priorUpdateTemplate(
  seq: Sequence,
  schemaPath: string,
  holds: boolean,
): BlockTemplate {
  const priorPath = `${schemaPath}._prior.reliability`;
  const current = seq.get(priorPath) as Record<string, number> | undefined;
  const prior = current ?? { alpha: 1, beta: 1 };
  const updated = conjugateUpdate('beta', prior, holds ? 'success' : 'failure');
  return { path: priorPath, value: updated };
}

export function installBehavioralPredicates(seq: Sequence): void {
  const ruleId = '_behavioral_predicates';

  seq.emitters.set(ruleId, (ctx) => {
    // Skip the rule's own induced prior writes — prevents feedback loop.
    if (ctx.block.cause?.ruleId === ruleId) return [];
    // Only react to value-shape deltas. Schema mounts and access events
    // don't move beliefs.
    if (ctx.delta.kind !== 'value') return [];

    const changedPath = ctx.cell.path;
    if (!changedPath || changedPath.startsWith('_')) return [];

    const out: BlockTemplate[] = [];
    walkPaths(seq, '', (schemaPath) => {
      if (schemaPath.startsWith('_')) return;
      const schema = seq.typeAt(schemaPath);
      if (!schema?.constraints) return;

      for (const c of schema.constraints) {
        if (c.op === 'identity') {
          const [outPath, inPath] = c.args as [string, string];
          if (outPath !== changedPath && inPath !== changedPath) continue;
          const outVal = seq.get(outPath);
          const inVal = seq.get(inPath);
          if (outVal === undefined || inVal === undefined) continue;
          const holds = Object.is(outVal, inVal);
          out.push(priorUpdateTemplate(seq, schemaPath, holds));
        } else if (c.op === 'equation') {
          const [lhs, rhs] = c.args as [string, string, ...unknown[]];
          if (lhs !== changedPath && rhs !== changedPath) continue;
          const lhsVal = seq.get(lhs);
          const rhsVal = seq.get(rhs);
          if (lhsVal === undefined || rhsVal === undefined) continue;
          const holds = Object.is(lhsVal, rhsVal);
          out.push(priorUpdateTemplate(seq, schemaPath, holds));
        }
      }
    });

    return out;
  });

  seq.insert({
    path: `_rules.${ruleId}`,
    rules: [{
      id: ruleId,
      phase: 'observation',
      scope: '',
      emit: ruleId,
    }],
  });
}

