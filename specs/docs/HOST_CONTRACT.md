# The Host Contract

**The kernel is an evaluation semantics, not a runtime.** It owns what
an expression means, what a type admits, what a budget selects, and
what a rule permits. It deliberately externalizes four things — time,
identity, durability, and distance — and every one of them is an
obligation the embedding host must discharge. Until now those
obligations were discoverable only by reading source comments or by
incident. This document declares them.

The shape to hold in mind: the kernel is a transition system —

```
(state, write, author, time) → (state', effects, wake-requests)
```

`author` and `time` are the two indexicals of the act of writing: they
are properties of *who is asserting* and *when*, not facts derivable
from any content. The kernel evaluates rules that reference them
uniformly with every other constraint — but it cannot *bind* them.
The host binds them. That is the contract.

## 1 · Time

**The kernel computes with time; the host owns the clock.**

What the kernel provides:

- Every write carries a `time` — settable by the caller (`InsertInput.time`
  on v2, `BlockOpts.time` on v1), defaulting to the injected clock.
  Explicit time is honored at the outermost write of a cascade; nested
  writes reuse the frozen cascade time so `_rt` is consistent within
  one fixpoint.
- Every v1 mount result carries `nextWake` — the earliest instant at
  which suspended work could progress. `schedule.at` records deadlines
  as pending facts. Elections return act-or-wait decisions with wake
  epochs.

What a correct host MUST do:

- **Pass time, don't let the kernel sample it**, wherever the instant
  matters: replay MUST carry each entry's original `time`
  (`MountEntry.time` — `loadEnv` passes it through), and cross-kernel
  receipt MUST carry the sender's authored instant (`Outgoing.sentAt` →
  `InsertInput.time`). A store that re-stamps history at boot has
  silently falsified every decay curve, lease, and liveness fact it
  holds.
- **Fire the wakes.** `nextWake`, `schedule.at` deadlines, and election
  epochs are outputs; nothing in this package sets a timer. The host
  MUST provide a durable timer service, and after downtime MUST run
  catch-up: re-enter the kernel so overdue gates fire.
- There is **no shared clock between kernels**. Never compare a peer's
  timestamps with local ones for ordering; they are two clocks.

## 2 · Identity

**The kernel evaluates authorization; the host establishes identity.**

What the kernel provides: `author` on every write — the principal the
admission rules (`$author` laws, writer-authority) judge against — and
read-masking per requester. HMAC session tokens exist in the stdlib as
machinery, not as an identity system.

What a correct host MUST do:

- Treat `author` as a **trusted input**: bind it to an authenticated
  principal *before* the write enters the kernel. The kernel does not
  and cannot verify it — an unauthenticated `author` makes every
  admission law theater.
- Own key custody, principal lifecycle, roles, and membership. None of
  that belongs in this package.

## 3 · Durability

**The kernel replays; the host persists.**

What the kernel provides: deterministic reconstruction from an entry
log (`loadEnv`), post-write observer hooks (`onBlockApplied`) for
write-ahead persistence, storage adapters (`IStorage`), and
snapshot/restore (entries format).

What a correct host MUST do:

- Persist every applied block **before** acknowledging it to anything
  external, recording `Block.time` into the persisted entry so replay
  is time-faithful (§1).
- Replay in original order at boot. The projection is derived state;
  the entry log is the truth.
- Note what is NOT tested in this package: a full crash → reboot →
  restore round trip. Hosts should test their own.

## 4 · Distance

**Between sovereigns, ship contracts. Within one sovereign, ship log.**

The line: raw state transfer (`installCrossSequence` /
`receiveFromPeer`) is for **one owner syncing its own processes** —
browser ↔ desktop ↔ scheduler tiers of the same identity, single
write-head per path. Between *different* owners there is no shared
objective state to sync: coordination is a **compiled contract
surface** (`vend` / `electFrame`) — tools with validity windows on the
issuer's clock, a renewal endpoint, delegation provenance — and the
peer invokes what it was vended.

What a correct host MUST do when using same-owner forwarding:

- Provide the transport, and know its guarantees: delivery is
  **at-most-once** with no outbox. The wire record's `seq` is a
  per-store monotonic counter — the host SHOULD watch for holes; a
  skipped number is a lost message.
- Respect single-hop: the echo-break is also a relay-break. Multi-hop
  topologies re-forward at the application layer, deliberately.
- Never point same-owner forwarding across an ownership boundary. A
  received fact lands as an ordinary local fact; sending it across
  sovereigns forges first-person knowledge.

What a host building cross-sovereign protocols SHOULD know: envelopes,
issuer-side monitoring of outstanding vended surfaces, and renewal
policies are **application-layer programs written against this
kernel's rule/commitment primitives** — the way network protocols are
written against a kernel's syscalls, not into the kernel. The
primitives (observation rules, watchers, commitments with deadlines,
reliability posteriors) are sufficient; this package intentionally does
not ship the protocol.

## The one-line summary

The kernel judges; the host situates. Who spoke, when, on what
storage, across which wire — those are the host's to answer, and this
document is the checklist for answering them correctly.
