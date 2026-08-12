import {
  type Type, constraintOf, returns, impl,
} from '../../src/type';
import {
  type Sequence,
  type EmitterCtx,
  type Rule,
  type BlockTemplate,
} from '../sequence';
import { resolveImpl } from './shared';

// ═══════════════════════════════════════════════════════════════════════
// COMMITMENT — every fn-typed invocation elects a write-lease record.
//
// Canonical fields at _commitments.{id}:
//   typeRef, holder, head, control, status, latencyMs, violateReason?
//
// Rule phase: observation (fires after compose produces an invocation
// delta, emits record + .input + .result/.error + status).
// ═══════════════════════════════════════════════════════════════════════

export const COMMITMENT_PREFIX = '_commitments';

/**
 * Extract a deadline from an fn type's temporal constraint if present.
 * Supported shapes:
 *   temporal('lt', '_rt', <number>)  — absolute deadline timestamp
 *   temporal('lt', '_rt', { add: ['_rt', <ms>] }) — relative to now
 *
 * MVP: these are the two common shapes. Richer expressions go through
 * a future stdlib expression evaluator.
 */
function extractDeadline(t: Type | undefined, nowMs: number): number | undefined {
  if (!t) return undefined;
  const temporal = constraintOf(t, 'temporal');
  if (!temporal) return undefined;
  const [dir, lhs, bound] = temporal.args;
  if (dir !== 'lt' || lhs !== '_rt') return undefined;
  if (typeof bound === 'number') return bound;
  if (bound && typeof bound === 'object' && 'add' in (bound as any)) {
    const terms = (bound as { add: unknown[] }).add;
    let sum = 0;
    for (const term of terms) {
      if (term === '_rt') sum += nowMs;
      else if (typeof term === 'number') sum += term;
    }
    return sum;
  }
  return undefined;
}

export function electCommitment(ctx: EmitterCtx): BlockTemplate[] {
  const { cell, delta, seq } = ctx;
  const id = `c_${seq.nextSequence()}`;
  const recordPath = `${COMMITMENT_PREFIX}.${id}`;
  const input = delta.next;
  const holder = cell.path;
  const head = `${cell.path}.result`;

  const out: BlockTemplate[] = [
    { path: `${recordPath}.typeRef`, value: holder },
    { path: `${recordPath}.holder`, value: holder },
    { path: `${recordPath}.head`, value: head },
    { path: `${recordPath}.control`, value: `${recordPath}.control` },
    { path: `${cell.path}.input`, value: input },
    // Per-commitment input record — durable across concurrent invocations
    // and the data that reliabilityUpdate uses to compute input sub-type
    // for conditional-posterior update. Without this, a second invocation
    // at the same fn cell would overwrite `.input` before the first's
    // fulfillment cascade can classify it.
    { path: `${recordPath}.input`, value: input },
  ];

  // Deadline watch: if the fn type declares a temporal upper bound on
  // _rt, mount (a) the absolute deadline field on the record and (b) a
  // where-gated block that will fire when the clock crosses it, flipping
  // status pending → violated. The gate AND-checks that status is still
  // pending, so a commitment that fulfilled before the deadline is
  // unaffected.
  const deadline = extractDeadline(cell.type, seq.now());
  if (deadline !== undefined) {
    out.push({ path: `${recordPath}.deadline`, value: deadline });
    out.push({
      path: `${recordPath}.violateReason`,
      value: 'deadline_exceeded',
      where: [
        { op: 'gt', args: ['_rt', deadline] },
        { op: 'eq', args: [`${recordPath}.status`, 'pending'] },
      ],
    });
    out.push({
      path: `${recordPath}.status`,
      value: 'violated',
      where: [
        { op: 'gt', args: ['_rt', deadline] },
        { op: 'eq', args: [`${recordPath}.status`, 'pending'] },
      ],
    });
  }

  // Resolve and run impl. Direct path lookup + impl() constraint.
  const impl = resolveImpl(cell, seq);
  if (typeof impl !== 'function') {
    // External holder case: record pending, wait for someone to fulfill
    // the head path out-of-band (e.g. remote agent, Lambda, user).
    out.push({ path: `${recordPath}.status`, value: 'pending' });
    return out;
  }

  const start = seq.now();
  let output: unknown;
  try {
    output = impl(input);
  } catch (e: unknown) {
    // Synchronous throw → violated in the same cascade.
    const reason = (e as { message?: string })?.message ?? String(e);
    out.push({ path: `${recordPath}.violateReason`, value: reason });
    out.push({ path: `${recordPath}.latencyMs`, value: seq.now() - start });
    out.push({ path: `${recordPath}.status`, value: 'violated' });
    return out;
  }

  // Async impl: result is a thenable. Emit the pending record NOW; the
  // cascade returns immediately. When the promise settles, do the
  // fulfillment / violation inserts via the public seq.insert API — that
  // flows through admission, compose, reliability rules, everything —
  // exactly as if the mount came from any caller. The Promise itself is
  // tracked so tests (and callers that need determinism) can await its
  // settlement via flushPending(seq).
  if (output !== null && typeof (output as { then?: unknown })?.then === 'function') {
    out.push({ path: `${recordPath}.status`, value: 'pending' });
    trackPending(seq, settleAsync(seq, output as Promise<unknown>, recordPath, head, start));
    return out;
  }

  // Synchronous success.
  if (output !== undefined) {
    out.push({ path: head, value: output });
  }
  out.push({ path: `${recordPath}.latencyMs`, value: seq.now() - start });
  out.push({ path: `${recordPath}.status`, value: 'fulfilled' });
  return out;
}

/**
 * Drive an async impl's Promise to a terminal commitment status. The
 * work happens OUTSIDE the original cascade — each settlement step
 * enters the substrate via a fresh `seq.insert`, so admission rules,
 * reliability updates, and any other observation rules fire the same
 * way they would for a sync invocation.
 *
 * Returns a Promise that flushPending can await to join all outstanding
 * async commitments at a sync boundary.
 */
async function settleAsync(
  seq: Sequence,
  p: Promise<unknown>,
  recordPath: string,
  head: string,
  start: number,
): Promise<void> {
  try {
    const resolved = await p;
    if (resolved !== undefined) seq.insert({ path: head, value: resolved });
    seq.insert({ path: `${recordPath}.latencyMs`, value: seq.now() - start });
    seq.insert({ path: `${recordPath}.status`, value: 'fulfilled' });
  } catch (e: unknown) {
    const reason = (e as { message?: string })?.message ?? String(e);
    seq.insert({ path: `${recordPath}.violateReason`, value: reason });
    seq.insert({ path: `${recordPath}.latencyMs`, value: seq.now() - start });
    seq.insert({ path: `${recordPath}.status`, value: 'violated' });
  }
}


// ═══════════════════════════════════════════════════════════════════════
// PENDING-PROMISE TRACKER — lets tests + sync-boundary callers await
// all in-flight async commitments. Kept in a module-level WeakMap so
// the kernel stays unaware. Not persistent; pending promises are
// runtime-only state (consistent with impls being runtime-only).
// ═══════════════════════════════════════════════════════════════════════

const pendingBySeq = new WeakMap<Sequence, Set<Promise<void>>>();

function trackPending(seq: Sequence, p: Promise<void>): void {
  let set = pendingBySeq.get(seq);
  if (!set) { set = new Set(); pendingBySeq.set(seq, set); }
  set.add(p);
  p.finally(() => set!.delete(p));
}

/**
 * Await every async commitment currently in flight on this Sequence.
 * Loops until the pending set is empty — a settling promise may trigger
 * downstream work that itself spawns further async commitments, so one
 * Promise.all is not enough. Terminates because each iteration
 * strictly drains the set.
 */
export async function flushPending(seq: Sequence): Promise<void> {
  while (true) {
    const set = pendingBySeq.get(seq);
    if (!set || set.size === 0) return;
    await Promise.all([...set]);
  }
}


// ═══════════════════════════════════════════════════════════════════════
// CLOCK ADVANCE — helper for deadline-driven violation tests. Mounts
// `_rt = t` so temporal-gated blocks watching `_rt` re-evaluate. In
// production, the host environment mounts `_rt` updates on a tick; this
// helper is for deterministic tests.
// ═══════════════════════════════════════════════════════════════════════

export function advanceClock(seq: Sequence, t: number): void {
  seq.insert({ path: '_rt', value: t });
}

