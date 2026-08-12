import {
  type Type,
} from '../../src/type';
import {
  type Sequence,
} from '../sequence';

// ═══════════════════════════════════════════════════════════════════════
// CROSS-SEQUENCE FORWARDING — same-owner log shipping between a
// sovereign's own processes.
//
// SCOPE — read this before reaching for it. This mechanism moves raw
// state, and raw state transfer is only sound when ONE owner is the
// write-head and the receiving side is another process of the same
// sovereign (Browser↔User↔Scheduler tiers of one identity). For
// coordination BETWEEN sovereigns, do not ship state: vend a compiled
// contract surface (vend/electFrame — tools with validity windows, a
// renewal endpoint, delegation provenance) and let the peer call it.
// There is no assumption of a shared objective state between kernels;
// a fact received here lands as an ordinary local fact, so sending it
// across an ownership boundary silently forges first-person knowledge.
//
// Mechanics: each Sequence node is tagged with a self-identity mounted
// at `_self.identity`. A forwarding rule observes local changes and
// calls an outgoing handler to serialize them to peers. The handler is
// user-supplied (WebSocket send, IPC postMessage, direct method call
// in tests) — the kernel never touches transport. When a peer's
// message arrives, the caller re-enters the substrate via seq.insert
// with the origin's identity tagged; the local forwarding rule sees
// the external identity and does NOT forward further, breaking the
// echo cycle. Consequence: forwarding is single-hop — the echo-break
// is also a relay-break, and multi-hop topologies must re-forward at
// the application layer.
//
// The wire record carries `seq` (a per-store monotonic outbound
// counter — receivers detect gaps: a skipped number is a lost
// message) and `sentAt` (the block's authored instant on the
// SENDER's clock; there is no shared clock, and the receiver keeps
// the fact's original instant via InsertInput.time). Retractions
// forward as op:'invalidate' so un-saying travels too.
// ═══════════════════════════════════════════════════════════════════════

export type Outgoing = {
  path: string;
  value?: unknown;
  type?: Type;
  /** Original author of the local block — preserved across the wire so
   *  the receiving side's writer-authority admission rule can match the
   *  sender's identity. */
  author?: string;
  /** Per-store monotonic outbound counter. A receiver observing a gap
   *  in a peer's seq has lost a message (delivery is at-most-once). */
  seq: number;
  /** The forwarded block's authored instant, on the SENDER's clock. */
  sentAt: number;
  /** 'invalidate' when the forwarded delta was a retraction. */
  op?: 'narrow' | 'invalidate';
};

export type ForwardHandler = (delta: Outgoing) => void;

const forwardHandlers = new WeakMap<Sequence, ForwardHandler>();

const forwardScopes = new WeakMap<Sequence, string[] | undefined>();

/** Per-store outbound wire counter (see Outgoing.seq). */
const forwardSeq = new WeakMap<Sequence, number>();

/**
 * Install cross-sequence forwarding.
 *
 * When `scopes` is omitted, every non-`_*` local delta is forwarded.
 * When provided, only deltas whose path matches any of the listed
 * glob prefixes (e.g. `['org.*', 'shared.config.*']`) are forwarded —
 * private partitions stay local.
 */
export function installCrossSequence(
  seq: Sequence,
  selfIdentity: string,
  onOutgoing: ForwardHandler,
  scopes?: string[],
): void {
  seq.insert({ path: '_self.identity', value: selfIdentity });
  forwardHandlers.set(seq, onOutgoing);
  if (scopes) forwardScopes.set(seq, scopes);

  seq.emitters.set('cross_sequence.forward', (ctx) => {
    // Forward only LOCAL-origin deltas. External-origin deltas (tagged
    // with some other identity via block.coord.identity) came from a
    // peer — re-sending would echo forever.
    const origin = ctx.block.coord.identity;
    const self = ctx.seq.get('_self.identity') as string;
    if (origin !== undefined && origin !== self) return [];

    // Skip substrate-internal cells (prefixed with `_`).
    if (ctx.cell.path.startsWith('_')) return [];

    // Forward value / type deltas AND retractions — un-saying must
    // travel, or a peer's copy outlives the owner's withdrawal
    // forever. Invocation/access deltas stay local.
    if (ctx.delta.kind !== 'value' && ctx.delta.kind !== 'type'
      && ctx.delta.kind !== 'retraction') return [];

    // Scope filter: if scopes configured, require a prefix match.
    const sc = forwardScopes.get(ctx.seq);
    if (sc && sc.length > 0) {
      const matches = sc.some(g => {
        const prefix = g.replace(/\.\*$/, '');
        return ctx.cell.path === prefix || ctx.cell.path.startsWith(prefix + '.');
      });
      if (!matches) return [];
    }

    const handler = forwardHandlers.get(ctx.seq);
    if (!handler) return [];
    // Preserve block.author across the wire — required for the
    // remote side's writer-authority admission rule to match the
    // sender's identity. Without this every forwarded write would
    // arrive author-less and any session-scoped admission law
    // would reject it.
    const nextSeq = (forwardSeq.get(ctx.seq) ?? 0) + 1;
    forwardSeq.set(ctx.seq, nextSeq);
    handler({
      path: ctx.delta.path,
      ...(ctx.delta.kind === 'value' ? { value: ctx.delta.next } : {}),
      ...(ctx.delta.kind === 'type' ? { type: ctx.delta.next as Type } : {}),
      ...(ctx.delta.kind === 'retraction' ? { op: 'invalidate' as const } : {}),
      ...(ctx.block.author !== undefined ? { author: ctx.block.author } : {}),
      seq: nextSeq,
      sentAt: ctx.block.time,
    });
    return [];
  });

  seq.insert({
    path: '_rules.cross_sequence_forward',
    rules: [{
      id: `cross_sequence_forward_${selfIdentity}`,
      phase: 'observation',
      scope: '',
      emit: 'cross_sequence.forward',
    }],
  });
}

/**
 * Handle an incoming delta from a peer. Tags it with the origin's
 * identity so the local forwarding rule knows not to echo. Pure
 * convenience over seq.insert.
 */
export function receiveFromPeer(
  seq: Sequence,
  peerIdentity: string,
  delta: Outgoing,
): void {
  seq.insert({
    path: delta.path,
    value: delta.value,
    type: delta.type,
    identity: peerIdentity,
    // Retractions arrive as op:'invalidate' — un-saying travels.
    ...(delta.op !== undefined ? { op: delta.op } : {}),
    // Keep the fact's authored instant (sender's clock) instead of
    // re-stamping with the receiver's clock: there is no shared time,
    // and time-conditioned state (decay, leases) must reason from
    // when the OWNER said it, not when the wire delivered it.
    ...(delta.sentAt !== undefined ? { time: delta.sentAt } : {}),
    // Forward the original author so the receiving side's
    // writer-authority law can match it against the holder. The
    // peerIdentity (transport-level) is separate from the original
    // author (application-level) — admission care about the latter.
    ...(delta.author !== undefined ? { author: delta.author } : {}),
  });
}

