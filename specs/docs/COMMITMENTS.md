# Commitments — the substrate's write-side primitive

Status: architectural commitment, 2026-04-21. Foundational. Supersedes
the fragmented orchestration paths (fn-kind dispatch, session rules,
req/proc partitions, tool-call lifecycle) with a single named primitive.

This document is the right starting point for understanding what the
substrate IS doing when a sequence runs. The other specs describe the
read-side view (narrowing toward concreteness, projection over the
block log, cascade as scheduler); this one describes the write-side
dual.

## The insight

Sequences narrow toward concreteness. That is the read-side view —
data flowing inward, types becoming values, gaps closing. It accounts
for what state the substrate maintains and how it's projected.

Every sequence update at fixed point produces exactly one kind of
outward action: **the election of new commitments to external things**.
After internal narrowings settle, the only outstanding work the sequence
has is what it has decided to delegate. Internal state is concrete;
outward state is in-flight.

This makes the cascade's terminal output a single artifact — the set
of new commitments elected this turn — and makes commitment the
substrate's primary write-side primitive.

## The primitive

A **commitment** is a typed write-lease:

| Component | Meaning |
|---|---|
| `typeRef` | The slot's shape — a path to the type-kind value the commitment binds against. May be concrete enough to invoke now; may be narrowable. |
| `holder` | The author with write-authority. `producedBy(holder)` admission attests every write to the head. |
| `deadline` | When the commitment must fulfill. After deadline without concrete final write → violation, slot reverts to open lease. |
| `distribution` | Expected latency prior. Updates Bayesian-conjugately on each fulfillment / violation, surfacing as the holder's reliability. The scalar form documented here is the 1-D degenerate case of the conditional distribution generalized in LEARNING_AS_COMPRESSION.md — same field, same update rule, projected over `time` with a single trivial subtype. |
| `contingencies` | Paths whose concreteness gate this commitment. The holder's promise is conditional on these inputs becoming concrete. |
| `head` | The path the holder writes to. Reads of the head show whatever state the holder has produced so far (heartbeats, partial results, final value). |
| `control` | Cancellation channel. The delegating sequence writes here to revoke; the holder observes and stops updating. |
| `status` | `pending` / `fulfilled` / `violated` / `revoked`. Tracked at the head; transitions are observable cascade events. |

Commitments live as type-state at a known prefix (`_commitments.{id}`)
so they can be enumerated, queried, inspected, audited.

## Cascade fixed point = commitment election

The cascade runs until no internal narrowing produces a mutation
(`runIndexConstraints` fixpoint). At fixed point, the substrate's only
work is to identify what new commitments need to be elected — what the
sequence has decided to delegate to external parties to make further
progress.

```
mount(...)
  → applyEntry
    → runIndexConstraints (fixpoint over rules and admissions)
      → settle internal state
    → elect commitments (what's now waiting on external work)
      → mount commitment records at _commitments.{id}.*
      → grant write-leases via producedBy(holder)
  → return MountResult
```

A turn that elects no new commitments has fully completed its work —
no externalities to wait on, every gap closed by internal narrowing.
A turn that elects N commitments has N new outward dependencies the
substrate is now tracking.

## Open commitments are the substrate's outstanding work

The set of open commitments at any moment is the durable record of
work the substrate has elected to but has not settled. The records
ARE the state — not a mirror of it, not an observability plane
alongside it. One source of truth, queried as ordinary type-state:

- `seq.keys('_commitments')` returns every outstanding commitment's ID.
- `seq.get('_commitments.{id}.head')` returns the current state of
  whatever the holder has written — heartbeat-fresh, partial result,
  or not-yet-anything.
- `seq.get('_commitments.{id}.holder')` returns who has the write-lease.
- `seq.get('_commitments.{id}.deadline')` returns when the lease must
  fulfill.
- `seq.get('_commitments.{id}.contingencies')` returns the paths the
  commitment is waiting on.

This structure LOOSELY RESEMBLES a traditional process's call stack
— parent commitment waiting on child commitments to fulfill, a tree
of in-flight work visible from above. The resemblance is a reading
aid, not an equivalence. Unlike a call stack:

- Commitments are **durable** — they persist across process
  restarts, live in the block log, survive federation.
- Commitments are **DAG-shaped**, not strictly nested — a commitment
  can be contingent on multiple siblings, and a sibling can
  contribute to multiple parents.
- Commitments are **not LIFO** — fulfillment order is independent
  of election order.
- Commitments **outlive fulfillment** — terminal records stay as
  audit trail, not popped.
- Commitments are **substrate-wide**, not process-local — federation
  crosses them naturally.

Call a set of open commitments an "outstanding work set" or just the
commitments. Don't call it a call stack; don't name identifiers after
call stacks. The analogy is explanatory, not structural.

## Symmetry across delegation kinds — in-process and external are isomorphic

A function call inside the same JS heap and a tool call to a remote
service look IDENTICAL through the commitment primitive. The only
differences are:

- **Latency** — in-process: ≈ 0; remote: network + provider.
- **Holder type** — in-process: a JS function; remote: another
  process / agent / user.
- **Update cadence** — in-process: synchronous head update; remote:
  heartbeat + final write.

Everything else is the same: typed slot, write-lease, deadline,
contingencies, control channel, fulfillment / violation semantics.
The substrate doesn't distinguish — it sees commitments at various
deadlines with various reliability priors, all updating their heads.

This is the load-bearing claim of the commitment primitive: **code-
level computation is the degenerate fast case of the same operation
that orchestrates remote work**. The record of in-flight work at a
single process and the record spanning a federation are the same
artifact, queried the same way, against the same substrate — not
separate observability surfaces that happen to line up.

## What this collapses

The substrate today has four parallel orchestration code paths.
Under commitments, they become type conventions over one primitive:

| Today | Under commitments |
|---|---|
| `applyEntry`'s `kind:'fn'` branch (dispatch via `implRegistry`, write `.input`/`.result`/`.error`, stash `pendingToolCompletion`) | A commitment with low-latency holder; head writes are the impl's return; `.input`/`.result` become caller-declared derived fields, not kernel slots. |
| `phase-rules.ts` (promotion, claiming, fulfill, expire — req partition lifecycle) | Promotion = commitment election. Claiming = lease grant to a holder. Fulfill = head reaches concrete final state. Expire = deadline pass without fulfillment. |
| `session-rules.ts` (active/idle/expired/holderRelease) | Session ownership IS a commitment with heartbeat-based liveness, no fixed deadline. Disconnect = revocation via control. |
| `agent-rules.ts` (task lifecycle: ready/active/done) | Each task is a commitment with the agent as holder, task description as typeRef, completion as deadline. |
| Tool-side `responsePolicy` / `distribution` declarations | Become commitment attestations the holder signs when accepting the lease, not declarations on the shape. |

After migration, the kernel knows about commitments and cascade.
Sessions, tasks, tool calls, and contract obligations are all
type-state conventions on top — like everything else in the
substrate's user-space layer.

## Implementation contract

What the kernel must provide (load-bearing):

1. **Commitment record schema** at `_commitments.{id}.*` with the
   eight fields above as a recognized type-state convention.
2. **Cascade's terminal action** in `runIndexConstraints`: after the
   fixpoint settles, identify newly-elected commitments (criterion:
   any path that became a class-typed gap with a holder candidate
   AND wasn't a commitment before) and mount records.
3. **Write-lease enforcement** via `producedBy(holder)` admission
   law on the head path. Anyone other than the holder writing to
   the head is rejected.
4. **Control-channel observation** by holders — a cascade rule that
   when `_commitments.{id}.control = 'cancel'` lands, the holder
   sees it via the cascade and stops updating.
5. **Deadline machinery** via the suspended-block primitive — a
   commitment is a block suspended on `where: gt('_rt', deadline)`;
   when the clock crosses, the suspension fires the violation
   transition.
6. **Reliability prior updates** — on fulfillment, the holder's
   prior at `_holders.{holder}.reliability` updates Bayesian-
   conjugately positive. On violation, negative. Continuous
   reliability tracking for free.

What the kernel does NOT need to know:

- Specific commitment kinds (session, task, tool call, obligation).
  Those are type conventions on the shape of typeRef.
- Holder kinds (in-process, scheduled, external, agent, user).
  All look the same — the substrate sees only writes to the head.
- Heartbeat conventions, partial-result formats, per-domain
  semantics. Those live at the schema level.

## Migration plan

Incremental, gated by passing the existing 633 + 269 test baseline
at each step.

### Phase 1 — naming and convention

1. Add `commitment` builder to `type.ts` that produces a record
   schema with the eight fields. Export.
2. Add `_commitments.*` path convention. Document the prefix as
   the canonical root for the substrate's commitment records.
3. Write coverage tests in the kernel: enumerate, query, audit
   commitment records on a sequence with manually-mounted
   commitments. No behavior change yet.

### Phase 2 — fn-kind retires into commitment

4. Replace `applyEntry`'s `kind:'fn'` branch with: mount a
   commitment with deadline ≈ 0 and an in-process holder. The
   holder is the current `implRegistry` lookup. The head is the
   path itself. Synchronous fulfillment writes the head's
   concrete value. Asynchronous: heartbeat updates allowed,
   final write closes the commitment.
5. Migrate `MountResult.toolCompletion` to be a thin wrapper that
   watches the commitment's status field and resolves on
   `fulfilled` / rejects on `violated` / `revoked`. Keep the API
   surface; reframe the implementation. Document explicitly that
   the promise may never resolve for never-ending commitments.
6. Delete `pendingToolCompletion` from `Sequence`. Delete the
   `.input` / `.result` / `.error` mounts as kernel-implicit;
   they become commitment-typeref-declared fields if the caller
   wants them.

### Phase 3 — session, claim, obligation collapse

7. Migrate `phase-rules.ts` to declare commitments instead of
   walking the req partition imperatively. The promotion class
   becomes "commitment election when state.X.status changes to
   pending"; claiming becomes "lease grant"; fulfill becomes
   "head reaches concrete state matching subject's required value";
   expire becomes the suspended-block deadline.
8. Migrate `session-rules.ts` similarly. Session = commitment with
   no fixed deadline, heartbeat-based liveness via the holder's
   ongoing writes to the head.
9. Migrate `agent-rules.ts`. Each task = commitment with agent as
   holder.
10. Drop the `req` and `proc` partitions as semantic categories.
    They become path-prefix conventions for "obligation
    commitments" and "process commitments" respectively, but the
    kernel knows nothing about them — they're commitments like
    anything else.

### Phase 4 — observability

11. Add a `_readers.commitments.*` reader contract that projects
    all commitment records as a hierarchical document — root
    commitments at the top, contingency-graph children nested
    below. Same render machinery as any other reader.
12. Document the convention: any product debugger / observability
    UI reads `commitments` for the substrate's outstanding work.

## Risks

- **Backward-inference coverage for arbitrary class-shaped derivations**.
  Commitments with non-trivial typeRefs may have head fields whose
  concretization triggers cascades the current backwardInfer doesn't
  fully cover. Audit needed.

- **Performance**. Commitment election at every fixed point adds
  one more pass beyond the current `runIndexConstraints` fixpoint.
  Profile the hot path before landing phase 2; in the worst case,
  amortize via dirty-tracking on commitment-relevant paths only.

- **Snapshot/replay determinism**. Commitment records carry holder
  identities and deadline timestamps. Snapshot must capture both
  faithfully so a replayed sequence sees the same outstanding work
  set. The block-log structure already preserves this; verify the
  convention doesn't introduce non-determinism.

- **Cancellation cascading**. Cancelling a parent commitment should
  propagate to its children (any commitments contingent on the
  parent's head). Need an explicit propagation rule, not an
  emergent one.

- **Reliability double-counting**. If a commitment is re-elected
  after revocation, the holder's prior shouldn't double-update.
  The prior-update rule should fire once per terminal status, not
  per status transition.

## Relationship to other architectural commitments

- **Compose-lineage `resolveImpl` (landed)** — a prerequisite. Without
  it, commitment holders that share an impl through narrowing
  couldn't be resolved. Now they can.

- **enforceContract retirement (landed)** — the precedent. Removed
  a kernel specialisation in favor of user-space type compositions.
  Same pattern at larger scale here.

- **Narrative-is-tool unification (landed)** — the intellectual
  predecessor. A narrative with holes IS a type with gaps IS the
  shape a commitment binds against. This document is the formal
  expression of that equivalence on the write side.

- **`'cap'` MountEntry op wire-format rename (deferred)** — after
  commitment migration, the `cap` op itself may not be needed.
  A "registered capability" is a holder candidate; declaring one
  is mounting a holder eligibility, not a separate entry shape.

- **Sequence Nodes / FIVE-Sequence coherence test** — commitments
  cross sequences naturally. A federated commitment has a holder
  on a different sequence; the head still reads the same way.
  The unification across the five tiers (Browser → User Session →
  Org Scheduler → User Session → Browser) is one connected set of
  outstanding commitments, queryable end-to-end.

## Reading order for someone arriving at the substrate

1. **AXIOMS.md** — the load-bearing invariants.
2. **ARCHITECTURE.md** — how the pieces fit.
3. **This document** — what the substrate is doing, write-side.
4. **KERNEL_REQUIREMENTS.md** — the contract the kernel implements.
5. **DSL_REQUIREMENTS.md** — how it surfaces in ft text.

The narrowing-toward-concreteness view (read-side) is documented
across the other specs; the observational / learning-side dual is
LEARNING_AS_COMPRESSION.md. Together with this document they
describe one cascade in two complementary terminal projections:
election of new write-leases, and compression of the observations
that fulfilled the old ones.
