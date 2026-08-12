import {
  type Type,
} from '../../src/type';
import {
  type Sequence,
} from '../sequence';

// ═══════════════════════════════════════════════════════════════════════
// PRIOR-SNAPSHOT RECOVERY (ported from v1 commit f8acf5f).
//
// External state supplied at boot, replayed on top of an empty (or
// bootstrap-mounted) Sequence. THE primitive for permanent-agent
// handoff: agent worker A serializes its Sequence state to entries,
// drops out, agent worker B boots, calls `restoreSnapshot(seq, ...)`
// with those entries, and continues from where A left off.
//
// v1 had three shapes:
//   { kind: 'entries' } — full-fidelity MountEntry[] replay
//   { kind: 'ft' }      — human-readable ft text (DSL-parsed)
//   { kind: 'ftPath' }  — file path to ft text
//
// This v2 port lands the `entries` shape only — that's what Lambda
// cold-start + hot-standby use. ft / ftPath shapes need a v2 DSL
// adapter (v1's walker calls `seq.mount(op, path, value)`; v2 uses
// `seq.insert({...})`). Tracked as a separate port item; unblocks
// the operator-driven seed flow but not the permanent-agent path.
//
// Boot order recommendation (matching v1):
//   1. Install your stdlib classes / bootstrap state
//   2. Call restoreSnapshot to overlay external state
//   3. Open up to clients
//
// External state wins over local — caller explicitly asked for it.
// ═══════════════════════════════════════════════════════════════════════

export interface SnapshotEntry {
  path: string;
  value?: unknown;
  type?: Type;
  author?: string;
  identity?: string;
  op?: 'narrow' | 'invalidate';
}

export type PriorSnapshot =
  | { kind: 'entries'; entries: SnapshotEntry[] };

/**
 * Capture the current state of a Sequence as a SnapshotEntry[]. Each
 * cell with a value OR a type contributes one or two entries. Use as
 * the inverse of restoreSnapshot — capture on shutdown, restore on
 * cold-start.
 *
 * Internal substrate paths (those starting with `_`) are included by
 * default — they carry stdlib state (commitments, posteriors, blueprint
 * registries, prompt sections). Pass `{ skipInternal: true }` to omit
 * them, in which case the restorer must re-install the same stdlib
 * functions before replay so the substrate is shaped correctly.
 */
export function captureSnapshot(
  seq: Sequence,
  opts: { skipInternal?: boolean } = {},
): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  for (const cell of seq.cells()) {
    if (!cell.path) continue;  // root cell
    if (opts.skipInternal && cell.path.startsWith('_')) continue;
    // Recover author from the most recent applied block on this cell.
    // cell.blocks is append-only; the latest applied block owns the
    // current value/type. Without preserving author, restoring under
    // a writer-authority scope on a fresh Sequence would be rejected
    // because the holder gets re-stamped with no recorded owner.
    const lastApplied = [...cell.blocks].reverse().find(b => b.status === 'applied');
    const author = lastApplied?.author;
    const authorPart = author !== undefined ? { author } : {};
    if (cell.type !== undefined) {
      entries.push({ path: cell.path, type: cell.type, ...authorPart });
    }
    if (cell.value !== undefined) {
      entries.push({ path: cell.path, value: cell.value, ...authorPart });
    }
  }
  return entries;
}

/**
 * Restore a Sequence from a snapshot. Each entry → seq.insert({...}).
 * Returns { replayed } = number of entries successfully applied.
 *
 * NOTE: admission rules WILL fire on each insert. If your snapshot
 * carries cells under a writer-authority scope (e.g. sessions.*),
 * the entries need their `author` field set to a value the rule
 * admits — typically the original author baked into capture. The
 * rule's cause-bypass (cause.ruleId present → bypass) does NOT
 * apply here because these are direct inserts, not cascade-emitted.
 *
 * If admission rejects an entry, it suspends; the entry is counted
 * as `suspended` and continues — the restore is best-effort. Use
 * `{ failOnSuspended: true }` to throw on the first rejection.
 */
export function restoreSnapshot(
  seq: Sequence,
  snapshot: PriorSnapshot,
  opts: { failOnSuspended?: boolean } = {},
): { replayed: number; suspended: number } {
  if (snapshot.kind !== 'entries') {
    throw new Error(`restoreSnapshot: unsupported kind '${(snapshot as any).kind}' — only 'entries' supported in v2 port (ft/ftPath need DSL adapter)`);
  }
  let replayed = 0;
  let suspended = 0;
  for (const entry of snapshot.entries) {
    const result = seq.insert(entry);
    if (result.suspended) {
      suspended++;
      if (opts.failOnSuspended) {
        throw new Error(`restoreSnapshot: insert suspended at path '${entry.path}'`);
      }
    } else {
      replayed++;
    }
  }
  return { replayed, suspended };
}
