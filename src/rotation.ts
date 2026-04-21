/**
 * rotation.ts — Generic data rotation: lock holder moves a range
 * to a colder destination, leaving a transparent redirect at the
 * source. The compression/federation/retention primitive applied
 * recursively at any tier.
 *
 * Hot → warm → cold → frozen → ... — all the same operation, no
 * special cases. Lock-on-range (writer-authority) entails
 * lock-on-storage-policy (the redirect schema mount) — verified by
 * the kernel admission gate landed in the prior commit. So the
 * author doing the rotation must hold the source range; if they
 * don't, every mount in this operation rejects via the existing
 * admission law on the source schema.
 *
 * Read-side resolution after rotation is transparent: queries to
 * the source path walk the ref alias to the destination — same
 * mechanism install-via-ref uses. Pruning the source value frees
 * memory while preserving access through the redirect.
 *
 * The same function rotates session→archive on a server, archive→
 * cold on the same process, OR moves blocks across a federation
 * (destination = `_peers.{otherSeq}.path`) — peer transports route
 * the cap dispatch the same way local resolution does.
 */

import type { Sequence } from './sequence';
import type { Type } from './type';
import { createType } from './type';

export type RotateOpts = {
  /** Source path or glob root. A leaf path moves that single value;
   *  a prefix moves every leaf under it. */
  source: string;
  /** Destination base path. The source's tail is appended to this:
   *  source `tasks.alpha`, destination `_cold.tasks.alpha` moves
   *  values at `tasks.alpha.{body, status, ...}` to
   *  `_cold.tasks.alpha.{body, status, ...}`. */
  destination: string;
  /** Identity authoring the rotation. Must satisfy the
   *  writer-authority admission law on the source range — the kernel
   *  enforces this on every mount this function emits. */
  author: string;
  /** Delete source values after the redirect mount. Default true:
   *  the whole point is to free memory at the source, with reads
   *  routing through the ref to the destination. Set false for
   *  "shadow" rotation where source values stay live. */
  prune?: boolean;
  /** Bound recursion when walking the source subtree. Default 10. */
  maxDepth?: number;
};

export type RotateResult = {
  ok: boolean;
  movedPaths: { source: string; destination: string }[];
  rejectedPaths: { path: string; reason: string }[];
};

/**
 * Walk leaves under a source root and rotate each one.
 *
 * The operation per leaf is three coordinated mounts plus an
 * optional delete:
 *
 *   1. value at destination          (preserves the data)
 *   2. ref schema at source          (reads now route through ref)
 *   3. delete source value           (frees memory; ref-walk supplies)
 *
 * If any single mount fails admission (author doesn't hold the
 * lock), that path is recorded in `rejectedPaths` and the operation
 * continues with the remaining paths. Caller decides what to do
 * with partial results — typically: roll back the partial moves or
 * accept the partial state (admission failures usually mean a
 * configuration bug, not a data integrity concern).
 */
export function rotate(seq: Sequence, opts: RotateOpts): RotateResult {
  const prune = opts.prune ?? true;
  const maxDepth = opts.maxDepth ?? 10;
  const movedPaths: { source: string; destination: string }[] = [];
  const rejectedPaths: { path: string; reason: string }[] = [];

  // Collect source leaves first so the iteration is stable across the
  // mounts we're about to do (which themselves modify the projection).
  const leaves: string[] = [];
  collectLeaves(seq, opts.source, maxDepth, leaves);

  for (const sourceLeaf of leaves) {
    const value = seq.get(sourceLeaf);
    if (value === undefined) continue;

    const tail = sourceLeaf === opts.source
      ? ''
      : sourceLeaf.slice(opts.source.length + 1);
    const destLeaf = tail ? `${opts.destination}.${tail}` : opts.destination;

    // 1. Mount value at destination. If admission rejects (e.g., the
    //    destination is in a partition the author doesn't hold), skip
    //    this leaf — the source remains untouched.
    const destMount = seq.mount('bind', destLeaf, value, { author: opts.author });
    if (!destMount.ok) {
      rejectedPaths.push({
        path: destLeaf,
        reason: rejectReason(destMount, 'destination mount rejected'),
      });
      continue;
    }

    // 2. Mount ref schema at source so reads route through. The
    //    admission gate on schema mounts (kernel fix in prior commit)
    //    means only the source-range lock holder can do this.
    const refType: Type = createType('any', [{ op: 'ref', args: [destLeaf] }]);
    const refMount = seq.mount('schema', sourceLeaf, refType, { author: opts.author });
    if (!refMount.ok) {
      rejectedPaths.push({
        path: sourceLeaf,
        reason: rejectReason(refMount, 'redirect schema rejected — author does not hold source lock'),
      });
      continue;
    }

    // 3. Optional prune: delete source value so memory is reclaimed.
    //    Reads at sourceLeaf now resolve via the ref schema to destLeaf.
    if (prune) {
      const del = seq.mount('delete', sourceLeaf, undefined, { author: opts.author });
      if (!del.ok) {
        rejectedPaths.push({
          path: sourceLeaf,
          reason: rejectReason(del, 'source delete rejected'),
        });
        continue;
      }
    }

    movedPaths.push({ source: sourceLeaf, destination: destLeaf });
  }

  return {
    ok: rejectedPaths.length === 0,
    movedPaths,
    rejectedPaths,
  };
}

function rejectReason(result: { gaps?: { reason?: string }[] }, fallback: string): string {
  return result.gaps?.[0]?.reason ?? fallback;
}

function collectLeaves(seq: Sequence, root: string, maxDepth: number, out: string[]): void {
  const rootValue = seq.get(root);
  if (rootValue !== undefined) out.push(root);
  walk(root, 0);
  function walk(prefix: string, depth: number): void {
    if (depth >= maxDepth) return;
    for (const child of seq.keys(prefix)) {
      const path = `${prefix}.${child}`;
      if (seq.get(path) !== undefined) out.push(path);
      walk(path, depth + 1);
    }
  }
}
