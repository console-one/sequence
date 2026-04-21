/**
 * laws.ts — Pre-mount admission.
 *
 * A `law({admission: true, check, reason})` constraint on a schema
 * is evaluated before any bind/delete/schema mount whose target is
 * covered by that schema. First failure rejects the block atomically.
 *
 * Bindings exposed to the check constraint via `seq.evalWithBindings`:
 *   $author       — block author ('' if unset)
 *   $path         — target path
 *   $time         — mount realtime
 *   $instancePath — schemaPath with `*` segments filled from $path
 *   $value        — entry value
 *
 * Writer-authority (sessions.* holder check), lock-on-range
 * (storage-policy schema gating), and any other pre-mount predicate
 * flow through this single evaluator.
 */

import { constraintsOf, type Constraint } from './type';
import type { Sequence } from './sequence';

type AdmissionSpec = {
  admission?: boolean;
  check?: Constraint;
  reason?: string;
};

export type AdmissionHit = {
  schemaPath: string;
  lawIdx: number;
  spec: AdmissionSpec;
  /** schemaPath with `*` segments substituted from the target path.
   *  For `sessions.*` hitting `sessions.alice.holder`, this is
   *  `sessions.alice`. Checks reference it via `$instancePath`. */
  instancePath: string;
};

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

export function collectAdmissionLaws(seq: Sequence, targetPath: string): AdmissionHit[] {
  const hits: AdmissionHit[] = [];
  for (const [schemaPath, schema] of seq.projection.schemas) {
    const laws = constraintsOf(schema, 'law');
    if (laws.length === 0) continue;
    const instancePath = resolveInstancePath(schemaPath, targetPath);
    if (instancePath === null) continue;
    let lawIdx = -1;
    for (let j = 0; j < schema.constraints.length; j++) {
      const c = schema.constraints[j];
      if (c.op !== 'law') continue;
      lawIdx++;
      const spec = c.args[0] as AdmissionSpec;
      if (!spec?.admission || !spec.check) continue;
      hits.push({ schemaPath, lawIdx, spec, instancePath });
    }
  }
  return hits;
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
    const hits = collectAdmissionLaws(seq, entry.path);
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
