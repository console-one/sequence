/**
 * laws.ts — Constraint dispatch at event-hook firing points.
 *
 * A `law(spec)` constraint on a schema is evaluated when an event
 * fires whose trigger matches the law's declared `trigger`. The kernel
 * has event hooks; each hook calls `collectLaws(seq, targetPath,
 * trigger)` and evaluates the returned laws' `check` predicates via
 * `seq.evalWithBindings`.
 *
 * Triggers defined today:
 *   'admission' — pre-mount (spec.admission === true). Fail rejects
 *                 the block atomically. Bindings: $author, $path,
 *                 $time, $instancePath, $value.
 *   'read'      — at seq.get(path, {under: commitmentPath}). Fail
 *                 masks the return (undefined — indistinguishable
 *                 from non-existent).
 *                 Bindings: $commitment (path to the commitment
 *                 record — field access via $commitment.author etc.),
 *                 $path, $time, $instancePath.
 *
 * Reader identity is NOT a free-floating string. A read happens
 * *under* a commitment — the substrate's write-side primitive for
 * outstanding work (`_commitments.{id}.*`). The commitment carries
 * author, purpose, granted authority, parent delegation. Read laws
 * evaluate against the commitment's substrate-stored fields.
 * Kernel-internal reads (no commitment) bypass read laws — same
 * discipline as admission's systemInternal flag.
 *
 * Future triggers (same pattern):
 *   'cap_completion' — after fn-invocation result lands. Bindings
 *                      $result, $latency_ms, $input, $call_seq.
 *   'write_observe'  — after a write successfully lands. Bindings
 *                      $path, $author, $value, $time.
 *
 * All triggers use the same path-covering collection (glob schema
 * covers specific target) and the same `evalWithBindings` evaluator.
 * `collectAdmissionLaws` and `runAdmissionLaws` stay as back-compat
 * wrappers that call the generalized functions with
 * `trigger: 'admission'`.
 */

import { constraintsOf, type Constraint } from './type';
import type { Sequence } from './sequence';

export type LawSpec = {
  /** What event fires this law. Defaults to 'admission' when
   *  `admission: true` is set (back-compat). Otherwise required. */
  trigger?: string;
  /** Pre-mount admission shorthand. Equivalent to trigger: 'admission'. */
  admission?: boolean;
  /** Boolean predicate evaluated with event-specific bindings.
   *  Returning false rejects (admission) or masks (read). */
  check?: Constraint;
  /** Human-readable rejection/mask reason. */
  reason?: string;
};

export type LawHit = {
  schemaPath: string;
  lawIdx: number;
  spec: LawSpec;
  /** schemaPath with `*` segments substituted from the target path.
   *  For `sessions.*` hitting `sessions.alice.holder`, this is
   *  `sessions.alice`. Checks reference it via `$instancePath`. */
  instancePath: string;
};

/** Back-compat alias. */
export type AdmissionSpec = LawSpec;
/** Back-compat alias. */
export type AdmissionHit = LawHit;

/** Match schemaPath against targetPath, substituting `*` segments.
 *  Returns the instance prefix, or null if the paths don't align. */
function resolveInstancePath(schemaPath: string, targetPath: string): string | null {
  const sParts = schemaPath.split('.');
  const fParts = targetPath.split('.');
  if (fParts.length < sParts.length) return null;
  for (let i = 0; i < sParts.length; i++) {
    const s = sParts[i];
    const f = fParts[i];
    if (s === '*') continue;
    if (s !== f) return null;
  }
  return fParts.slice(0, sParts.length).join('.');
}

/** Normalize the effective trigger for a spec. `admission: true` is
 *  equivalent to `trigger: 'admission'`. Explicit `trigger` wins. */
function effectiveTrigger(spec: LawSpec): string | undefined {
  if (spec.trigger) return spec.trigger;
  if (spec.admission) return 'admission';
  return undefined;
}

/**
 * Walk every schema whose path pattern covers `targetPath` and
 * collect the laws whose effective trigger matches `trigger`. Same
 * path-covering mechanism for every trigger — admission, read,
 * cap_completion, etc. Glob schemas at ancestor paths reach specific
 * targets via the `*`-substitution in `resolveInstancePath`.
 */
export function collectLaws(
  seq: Sequence,
  targetPath: string,
  trigger: string,
): LawHit[] {
  const hits: LawHit[] = [];
  for (const [schemaPath, schema] of seq.iterateTypes()) {
    const laws = constraintsOf(schema, 'law');
    if (laws.length === 0) continue;
    const instancePath = resolveInstancePath(schemaPath, targetPath);
    if (instancePath === null) continue;
    let lawIdx = -1;
    for (let j = 0; j < schema.constraints.length; j++) {
      const c = schema.constraints[j];
      if (c.op !== 'law') continue;
      lawIdx++;
      const spec = c.args[0] as LawSpec;
      if (!spec?.check) continue;
      if (effectiveTrigger(spec) !== trigger) continue;
      hits.push({ schemaPath, lawIdx, spec, instancePath });
    }
  }
  return hits;
}

/** Back-compat: admission-only collector. */
export function collectAdmissionLaws(seq: Sequence, targetPath: string): LawHit[] {
  return collectLaws(seq, targetPath, 'admission');
}

export type AdmissionResult =
  | { ok: true }
  | { ok: false; reason: string; schemaPath: string; entryPath: string; constraint: unknown };

export function runAdmissionLaws(
  seq: Sequence,
  entries: Array<{ op: string; path: string; value?: unknown }>,
  author: string | undefined,
  time: number,
  systemInternal?: boolean,
): AdmissionResult {
  if (systemInternal) return { ok: true };
  for (const entry of entries) {
    if (entry.op !== 'bind' && entry.op !== 'delete' && entry.op !== 'schema') continue;
    const hits = collectLaws(seq, entry.path, 'admission');
    if (hits.length === 0) continue;
    for (const hit of hits) {
      const check = hit.spec.check;
      if (!check) continue;
      const bindings = {
        author: author ?? '',
        path: entry.path,
        time,
        instancePath: hit.instancePath,
        value: entry.value,
      };
      if (!seq.evalWithBindings(check, bindings)) {
        return {
          ok: false,
          reason: hit.spec.reason ?? `admission rejected by law at ${hit.schemaPath}`,
          schemaPath: hit.schemaPath,
          entryPath: entry.path,
          constraint: { op: 'law', args: [{ admission: true, reason: hit.spec.reason }] },
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Evaluate read-triggered laws at `targetPath` under the given
 * commitment. Returns { ok: true } when every applicable law's check
 * passes. Returns { ok: false, ... } when any check fails — the
 * caller (seq.get) masks the read by returning undefined.
 *
 * Bindings exposed to the check constraint:
 *   $commitment   — path to the commitment record. Field access via
 *                   `$commitment.author`, `$commitment.grants.read`,
 *                   etc. resolves to values stored under that
 *                   commitment's subtree.
 *   $path         — targetPath
 *   $time         — current sequence clock
 *   $instancePath — schemaPath with `*` segments filled from $path
 *
 * A commitment path of undefined means kernel-internal read — the
 * caller (seq.get without {under}) doesn't invoke this function at
 * all. Reads that carry a commitment path but point at a commitment
 * that doesn't exist are evaluated as written (the path-field
 * lookups return undefined, so identity comparisons fail — safe
 * default).
 */
export type ReadResult =
  | { ok: true }
  | { ok: false; reason: string; schemaPath: string };

export function runReadLaws(
  seq: Sequence,
  targetPath: string,
  commitmentPath: string,
  time: number,
): ReadResult {
  const hits = collectLaws(seq, targetPath, 'read');
  if (hits.length === 0) return { ok: true };
  for (const hit of hits) {
    const check = hit.spec.check;
    if (!check) continue;
    const bindings = {
      commitment: commitmentPath,
      path: targetPath,
      time,
      instancePath: hit.instancePath,
    };
    if (!seq.evalWithBindings(check, bindings)) {
      return {
        ok: false,
        reason: hit.spec.reason ?? `read rejected by law at ${hit.schemaPath}`,
        schemaPath: hit.schemaPath,
      };
    }
  }
  return { ok: true };
}
