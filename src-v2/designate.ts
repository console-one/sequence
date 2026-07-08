/**
 * designate.ts — allocation as declared space law (the designation fold).
 *
 * The space's declared allocation rule + the claim rows rendered onto its
 * own spine deterministically order WHO takes an owed occurrence and WHEN
 * each member's turn arrives. Every member folds the same answer from the
 * same ledger — authority lives in the RULE (data), never in a process;
 * "issuing the invocation" is each member observing its own slot. The
 * first-claim fold remains the adjudicator for true simultaneity; slots
 * always expire into act, so starvation is impossible by construction.
 *
 * Standalone pure evaluator (the evaluate/elect/planProcedure/planView
 * pattern): plain rows in (the HOST extracts them from the space's folded
 * references, in fold order — replay-deterministic everywhere), no I/O,
 * no address semantics. The v0 vocabulary is CLOSED: two identity-neutral
 * order keys; track-weighted order is the named follow-on, gated on
 * signed attribution (rules over forgeable rival evidence invite
 * poisoning).
 */

export interface AllocationRule {
  /** 'declaration' — fold order (earliest standing claim leads).
   *  'member-hash' — stable per-occurrence hash (rotating fairness). */
  order: 'declaration' | 'member-hash';
  /** Slot spacing (ms). Default 30s: ≫ claim-propagation latency,
   *  ≪ any real cadence. */
  failoverMs?: number;
}

export interface ClaimRow {
  /** The member holding the claim (the space row's referrer). */
  member: string;
  /** The claim's lease horizon, when it carries one. A lease that does
   *  not cover the occurrence excludes the row; no lease = included
   *  (the lease convention is opt-in — legacy claims still count). */
  validUntil?: number;
}

export interface Designation {
  /** Members in turn order (rank 0 acts first, at the occurrence). */
  order: string[];
  /** Each member's slot: occurrence + rank × failoverMs. */
  slots: Record<string, number>;
}

export const DEFAULT_FAILOVER_MS = 30_000;

/** FNV-1a 32-bit — a stable, dependency-free tiebreak key. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Order the standing claims for one occurrence. Pure; total; loud on
 *  malformed rules. Empty output = no designation (callers behave as
 *  if no rule were declared). */
export function designate(
  rule: AllocationRule,
  rows: ClaimRow[],
  occurrence: number,
): Designation {
  if (rule.order !== 'declaration' && rule.order !== 'member-hash') {
    throw new Error(
      `designate: rule.order must be 'declaration' | 'member-hash', got '${String(
        (rule as { order?: unknown }).order,
      )}'`,
    );
  }
  const failoverMs = rule.failoverMs ?? DEFAULT_FAILOVER_MS;
  if (!Number.isFinite(failoverMs) || failoverMs <= 0) {
    throw new Error(`designate: rule.failoverMs must be > 0 when present`);
  }
  if (!Number.isFinite(occurrence)) {
    throw new Error(`designate: occurrence must be a finite epoch ms`);
  }
  // A member may render several claims; the earliest standing row wins
  // its position (dedupe preserves first appearance).
  const seen = new Set<string>();
  const standing: string[] = [];
  for (const row of rows) {
    if (!row || typeof row.member !== 'string' || !row.member) continue;
    if (row.validUntil !== undefined && row.validUntil <= occurrence) continue;
    if (seen.has(row.member)) continue;
    seen.add(row.member);
    standing.push(row.member);
  }
  const order =
    rule.order === 'declaration'
      ? standing
      : [...standing].sort(
          (a, b) =>
            fnv1a(`${a}|${occurrence}`) - fnv1a(`${b}|${occurrence}`) ||
            (a < b ? -1 : 1),
        );
  const slots: Record<string, number> = {};
  order.forEach((m, rank) => {
    slots[m] = occurrence + rank * failoverMs;
  });
  return { order, slots };
}
