/**
 * commitments.ts — The substrate's write-side primitive (Phase 1).
 *
 * A commitment is a typed write-lease: a record at `_commitments.{id}`
 * naming a holder who has accepted write-authority on a typed slot
 * with time-wise promises and input contingencies. Open commitments
 * (status = 'pending') are the substrate's call stack, queryable
 * as ordinary type-state.
 *
 * See specs/docs/COMMITMENTS.md for the full architectural commitment.
 *
 * This file is Phase 1: schema convention + helpers + observation.
 * No behavior change — fn-kind dispatch / session rules / phase rules
 * still run as before. Phase 2 retires fn-kind into a commitment with
 * deadline ≈ 0 and an in-process holder; Phase 3 collapses session /
 * req / proc into commitment conventions; Phase 4 surfaces the call
 * stack as a stdlib reader contract.
 */

import type { Sequence } from './sequence';
import type { Type } from './type';
import { createType, property, producedBy } from './type';
import { FT } from './builder';

// ═══════════════════════════════════════════════════════════════════════
// CONVENTION — the commitment record's path prefix and schema shape
// ═══════════════════════════════════════════════════════════════════════

/** The path prefix under which all commitment records live. The set
 *  of paths matching `${COMMITMENT_PREFIX}.*` is the substrate's open
 *  call stack at any moment. */
export const COMMITMENT_PREFIX = '_commitments';

/** Status values a commitment can hold. Transitions:
 *    elect → pending
 *    pending → fulfilled  (head reaches concrete final state)
 *    pending → violated   (deadline passes without concrete final write)
 *    pending → revoked    (delegator writes 'cancel' to control)
 *  Terminal statuses (fulfilled / violated / revoked) do not transition. */
export type CommitmentStatus = 'pending' | 'fulfilled' | 'violated' | 'revoked';

/**
 * The eight fields of a commitment record, exactly as documented in
 * specs/docs/COMMITMENTS.md.
 *
 * | Field         | Meaning                                             |
 * |---------------|-----------------------------------------------------|
 * | typeRef       | Path to the type-kind value defining slot's shape   |
 * | holder        | Path to the author with write-authority             |
 * | deadline      | When commitment must fulfill (ms timestamp)         |
 * | distribution  | Latency prior shape (Bayesian-conjugate updated)    |
 * | contingencies | Paths whose concreteness gate this commitment       |
 * | head          | Path the holder writes to                           |
 * | control       | Cancellation channel (delegator writes 'cancel')    |
 * | status        | pending / fulfilled / violated / revoked            |
 */
export function commitmentRecordSchema(): Type {
  return createType('object', [
    property('typeRef',       FT.string(), false),
    property('holder',        FT.string(), true),
    property('deadline',      FT.number(), true),
    property('distribution',  createType('object', []), true),
    property('contingencies', createType('array', []), true),
    property('head',          FT.string(), false),
    property('control',       FT.string(), true),
    property('status',        createType('string', [
      // status is constrained to the four enum values via a union
      // of literal-typed constraints. compose narrows to one of these.
    ]), false),
  ]);
}

/**
 * Install the commitment record schema on a fresh Sequence. Callers
 * invoke this once at boot before electing any commitments. The
 * schema mounts at `_commitments.*` (glob), so every record at
 * `_commitments.{id}` inherits the shape.
 *
 * Idempotent — re-mounting the same schema is a no-op (Map.set
 * with identical content).
 */
export function installCommitmentSchema(seq: Sequence): void {
  seq.mount('schema', `${COMMITMENT_PREFIX}.*`, commitmentRecordSchema());
}

// ═══════════════════════════════════════════════════════════════════════
// ELECTION — mount a new commitment record
// ═══════════════════════════════════════════════════════════════════════

let _nextCommitmentId = 1;

/** Generate a fresh commitment ID. Process-local counter; for cross-
 *  process determinism, callers can supply explicit ids via opts.id. */
function nextId(): string {
  return `c_${Date.now()}_${_nextCommitmentId++}`;
}

export interface ElectCommitmentOpts {
  /** Optional explicit ID. When omitted, a process-local counter
   *  generates one. Use explicit IDs for federation / cross-process
   *  determinism. */
  id?: string;
  /** Path to the type-kind value defining the slot's shape. */
  typeRef: string;
  /** Path to the author with write-authority on the head. When set,
   *  electCommitment installs a `producedBy(holder)` admission law
   *  on the head path so non-holders can't write. */
  holder?: string;
  /** When the commitment must fulfill (ms timestamp). When the clock
   *  crosses this without a concrete final write at the head, status
   *  transitions pending → violated. */
  deadline?: number;
  /** Latency prior shape (e.g. `{ kind: 'lognormal', mu, sigma }`).
   *  Updated Bayesian-conjugately on fulfill / violate transitions. */
  distribution?: Record<string, unknown>;
  /** Paths whose concreteness gate the commitment's start. The
   *  holder's promise is conditional on these inputs becoming
   *  concrete. */
  contingencies?: string[];
  /** Path the holder writes to. Defaults to the commitment record
   *  itself plus a `.head` suffix; callers usually override to a
   *  product-meaningful path (e.g. `tasks.{id}.outcome`). */
  head?: string;
  /** Cancellation channel path. Defaults to `_commitments.{id}.control`. */
  control?: string;
}

export interface CommitmentHandle {
  /** The commitment record ID. */
  id: string;
  /** Path of the commitment record (i.e. `${COMMITMENT_PREFIX}.{id}`). */
  recordPath: string;
  /** Path the holder writes to (`opts.head` or the default). */
  head: string;
  /** Path the delegator writes to for cancellation. */
  control: string;
}

/**
 * Elect a new commitment. Mounts a record at `_commitments.{id}.*`
 * with status='pending' and the supplied fields. Returns a handle
 * the caller can use to read the head, write the control channel,
 * or query status.
 *
 * If `opts.holder` is set, also installs a `producedBy(holder)`
 * admission law on the head path so writes from non-holder authors
 * are rejected at admission. This is the write-lease enforcement.
 */
export function electCommitment(seq: Sequence, opts: ElectCommitmentOpts): CommitmentHandle {
  const id = opts.id ?? nextId();
  const recordPath = `${COMMITMENT_PREFIX}.${id}`;
  const head = opts.head ?? `${recordPath}.head`;
  const control = opts.control ?? `${recordPath}.control`;

  // Mount the record fields. Each is a separate bind so the cascade
  // sees them as distinct mutations and any indexSpec class watching
  // _commitments.* can fire per-field if needed.
  seq.mount('bind', `${recordPath}.typeRef`, opts.typeRef);
  if (opts.holder !== undefined)        seq.mount('bind', `${recordPath}.holder`, opts.holder);
  if (opts.deadline !== undefined)      seq.mount('bind', `${recordPath}.deadline`, opts.deadline);
  if (opts.distribution !== undefined)  seq.mount('bind', `${recordPath}.distribution`, opts.distribution);
  if (opts.contingencies !== undefined) seq.mount('bind', `${recordPath}.contingencies`, opts.contingencies);
  seq.mount('bind', `${recordPath}.head`, head);
  seq.mount('bind', `${recordPath}.control`, control);
  seq.mount('bind', `${recordPath}.status`, 'pending');

  // Install write-lease enforcement. Only the holder can write the
  // head. Other authors get rejected at admission with a clear reason.
  if (opts.holder) {
    const existingSchema = seq.typeAt(head);
    const existingConstraints = existingSchema?.constraints ?? [];
    seq.mount('schema', head, createType(
      existingSchema?.kind ?? 'any',
      [...existingConstraints, producedBy(opts.holder)]
    ));
  }

  return { id, recordPath, head, control };
}

// ═══════════════════════════════════════════════════════════════════════
// STATUS TRANSITIONS — fulfill / revoke
// ═══════════════════════════════════════════════════════════════════════

/**
 * Mark a commitment fulfilled. Writes status='fulfilled' to the
 * record. The cascade picks up; downstream rules that depend on
 * the head's concrete final value fire.
 *
 * Callers supply the final value to write to the head. The substrate
 * does not enforce that the head matches typeRef on fulfillment —
 * that's a holder-side discipline (the holder is the author who
 * accepted the lease and its promises).
 */
export function fulfillCommitment(seq: Sequence, id: string, finalValue?: unknown): void {
  const recordPath = `${COMMITMENT_PREFIX}.${id}`;
  if (finalValue !== undefined) {
    const head = seq.get(`${recordPath}.head`) as string | undefined;
    if (head) seq.mount('bind', head, finalValue);
  }
  seq.mount('bind', `${recordPath}.status`, 'fulfilled');
}

/**
 * Revoke a commitment. The delegator writes 'cancel' to the control
 * channel; the holder observes via the cascade and stops updating.
 * Status transitions pending → revoked.
 *
 * Reason is optional but recommended for audit. Lands at the
 * record's `.revokeReason` field.
 */
export function revokeCommitment(seq: Sequence, id: string, reason?: string): void {
  const recordPath = `${COMMITMENT_PREFIX}.${id}`;
  const control = seq.get(`${recordPath}.control`) as string | undefined;
  if (control) seq.mount('bind', control, 'cancel');
  if (reason !== undefined) seq.mount('bind', `${recordPath}.revokeReason`, reason);
  seq.mount('bind', `${recordPath}.status`, 'revoked');
}

/**
 * Mark a commitment violated — typically called by a deadline
 * watcher when `_rt > deadline` and status is still 'pending'.
 * Status transitions pending → violated.
 *
 * In Phase 1 this is invoked manually by callers that own deadline
 * monitoring. In a later phase, a kernel-level cascade rule on
 * suspended-block deadlines will fire it automatically.
 */
export function violateCommitment(seq: Sequence, id: string, reason?: string): void {
  const recordPath = `${COMMITMENT_PREFIX}.${id}`;
  if (reason !== undefined) seq.mount('bind', `${recordPath}.violateReason`, reason);
  seq.mount('bind', `${recordPath}.status`, 'violated');
}

// ═══════════════════════════════════════════════════════════════════════
// OBSERVATION — enumerate the call stack
// ═══════════════════════════════════════════════════════════════════════

export interface CommitmentRecord {
  id: string;
  recordPath: string;
  typeRef: string;
  holder?: string;
  deadline?: number;
  distribution?: Record<string, unknown>;
  contingencies?: string[];
  head: string;
  control: string;
  status: CommitmentStatus;
}

/** Read a single commitment record. Returns undefined if no
 *  commitment exists at the given ID. */
export function readCommitment(seq: Sequence, id: string): CommitmentRecord | undefined {
  const recordPath = `${COMMITMENT_PREFIX}.${id}`;
  const status = seq.get(`${recordPath}.status`) as CommitmentStatus | undefined;
  if (!status) return undefined;
  return {
    id,
    recordPath,
    typeRef: seq.get(`${recordPath}.typeRef`) as string,
    holder: seq.get(`${recordPath}.holder`) as string | undefined,
    deadline: seq.get(`${recordPath}.deadline`) as number | undefined,
    distribution: seq.get(`${recordPath}.distribution`) as Record<string, unknown> | undefined,
    contingencies: seq.get(`${recordPath}.contingencies`) as string[] | undefined,
    head: seq.get(`${recordPath}.head`) as string,
    control: seq.get(`${recordPath}.control`) as string,
    status,
  };
}

/** Enumerate all commitments matching a status filter. With no
 *  filter, returns every record (open + terminal). Use status='pending'
 *  for the "what's the substrate currently waiting on" query — that
 *  set IS the call stack. */
export function commitments(seq: Sequence, statusFilter?: CommitmentStatus): CommitmentRecord[] {
  const ids = seq.keys(COMMITMENT_PREFIX);
  const out: CommitmentRecord[] = [];
  for (const id of ids) {
    const record = readCommitment(seq, id);
    if (!record) continue;
    if (statusFilter && record.status !== statusFilter) continue;
    out.push(record);
  }
  return out;
}

/** Convenience: the open commitments — equivalent to commitments(seq, 'pending'). */
export function openCommitments(seq: Sequence): CommitmentRecord[] {
  return commitments(seq, 'pending');
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE 4 — callstack reader contract
// ═══════════════════════════════════════════════════════════════════════

/**
 * Install a reader contract at `_readers.callstack.*` that projects
 * `_commitments.*` as a document. Consumers (UI panels, debuggers,
 * audit dashboards) call `hoistForReader(seq, 'callstack')` and get
 * the substrate's live call stack as ft text.
 *
 * Convention: the reader is scoped to the commitment records (source
 * `_commitments.*`), stable mode (no history), depth 3 to cover the
 * record's field set (head + control + status + metadata). Callers
 * can remount with different scopes for filtered views — e.g.
 * "only open frames" by post-filtering on status='pending' at the
 * render site.
 */
export function installCallstackReader(seq: Sequence): void {
  seq.mount('bind', '_readers.callstack.source', `${COMMITMENT_PREFIX}.*`);
  seq.mount('bind', '_readers.callstack.mode',   'stable');
  seq.mount('bind', '_readers.callstack.depth',  3);
  seq.mount('bind', '_readers.callstack.render', 'callstack');
}
