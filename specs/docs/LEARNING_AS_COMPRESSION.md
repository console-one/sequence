# Learning as Compression — the substrate's posterior-update primitive

Status: architectural commitment, 2026-04-21. Foundational. The
read-side dual to COMMITMENTS.md.

COMMITMENTS.md describes what the substrate IS doing on the write
side — electing typed write-leases at cascade fixed point. This
document describes what the substrate IS doing on the observational
side — compressing the block log into learned type refinements,
which in turn drive commitment distributions, admission laws, and
contract policy. The two documents describe one cascade in two
complementary projections.

## The insight

An append-only log that does not promote observed regularities into
type refinements is not a substrate — it is a journal. Every
capability the substrate hosts emits an indefinite stream of
(input, output, latency) observations into its sequence's block
log. If those observations are retained as raw evidence and never
factored into rules, the log grows linearly forever and the
substrate has no mechanism by which to get better at predicting
what any of its capabilities will do next.

Prediction IS compression (Solomonoff / Kolmogorov / MDL). The
shortest program that reproduces an observation sequence is also
the best model of the next observation — any lossless compressor
of the log must, in the limit, have internalized its generating
distribution. The converse is also true: a system that predicts
well has compressed well. The two objectives cannot be separated.

Therefore: the substrate's learning loop and its compression
obligation are the same loop. Mounting a subtype refinement is a
compression step — it pays its own statement cost in exchange for
shrinking the description length of every future observation that
the subtype explains. The block log is simultaneously the dataset,
the model, and the loss function; the act of mounting a refinement
is the gradient step. No external training system exists because
none is needed.

## The primitive

A **conditional distribution** attached to a commitment:

| Component | Meaning |
|---|---|
| `over` | The dimensions being modeled — time, outputShape, outputValue, or any declared projection of the commitment's head. Each dimension carries its own conjugate posterior. |
| `conditional_on` | The partition — a set of input subtypes whose union covers the commitment's input type. Subtypes may be declared statically or promoted from observation. |
| `posterior` | Per-subtype conjugate posterior over each `over` dimension. Updated conjugately on each fulfillment, membership-weighted by the input's concreteness against each subtype. |
| `refinementPolicy` | MDL / Bayes-factor threshold at which a proposed subtype is admissible as a new refinement. Prevents lattice bloat from noise. |
| `provenance` | The set of block IDs whose fulfillments contributed to the current posterior. Makes the posterior auditable and replayable; makes decay explicit. |

Posteriors live as type-state at a known prefix
(`_commitments.{id}.distribution.posterior.{subtype}.{dimension}`)
so they are ordinary state — enumerated, queried, federated, and
replayed the same way any state is.

## Cascade fixed point = posterior election

The cascade runs until no internal narrowing produces a mutation.
At fixed point, two terminal actions are available:

1. **Commitment election** (write side, COMMITMENTS.md) — identify
   new typed slots the substrate has decided to delegate.
2. **Posterior update and refinement promotion** (this document) —
   for every commitment whose head concretized this turn, update
   the membership-weighted conjugate posterior across every `over`
   dimension; evaluate proposed refinements against the MDL
   threshold; mount any that cross.

```
mount(...)
  → applyEntry
    → runIndexConstraints (fixpoint over rules and admissions)
      → settle internal state
    → elect commitments     (write-side terminal)
    → update posteriors     (read-side terminal — this document)
      → for each fulfilled commitment:
          compute input subtype membership
          for each (over, subtype) pair:
            conjugate-update posterior by membership weight
            mount the updated posterior at the canonical path
      → evaluate proposed refinements
        → if DL(log | null) - DL(log | S) > DL(S): mount subtype S
  → return MountResult
```

Posterior mounts are ordinary mounts. They flow through admission,
while-clause checking, conjunction propagation, and cascade like
any other state change. There is no side channel.

## The block log IS the dataset AND the model

A capability's sequence carries the entire history of that
capability's invocations as ordinary blocks. The fulfillment of a
commitment head is a block in the log; the input that elicited it
is the mounted commitment record. The pair (input at election,
output at fulfillment) is structurally present — not as derived
telemetry but as the log's own content.

This collapses three things that are typically separate in a
machine-learning stack:

- **Dataset** — the blocks themselves. No export, no ETL.
- **Model** — the conjugate posteriors at
  `_commitments.{id}.distribution.posterior.*`. State in the log.
- **Training pipeline** — a cascade rule that fires on fulfillment
  and mounts the posterior update. No separate training job.

Federation of learned structure falls out for free. A subtype
refinement learned on sequence A federates via the same block-log
mechanism as any other state. Learning propagates the way state
does; the substrate does not distinguish.

## Symmetry across learning kinds

The primitive makes several kinds of learning structurally
identical:

- **Latency priors vs. output-shape priors** — different `over`
  dimensions, one conjugate-update rule per dimension. The
  substrate doesn't distinguish "learning how long this takes"
  from "learning what shape this returns."
- **Holder reliability** — the marginal of the conditional
  posterior across outputs, integrated over input subtypes.
  Falls out as a projection; does not need its own primitive.
- **Model-free and model-based prediction** — continuous. When no
  subtype structure is declared, the posterior degenerates to a
  single marginal and the commitment behaves as today's scalar
  `distribution` field. When subtypes are declared or promoted,
  prediction sharpens without any behavioral cliff.
- **Local and federated learning** — structurally identical; a
  subtype learned on one sequence is a mount that federates like
  any other.

## What this collapses

The substrate today has several parallel learning-shaped code
paths — or, more often, the lack of them. Under this primitive
they become type conventions over one posterior record:

| Today | Under conditional distributions |
|---|---|
| Scalar latency prior on commitments (`distribution` as 1-D Gamma) | Marginal over `time` of the conditional posterior. |
| Holder reliability as a standalone scalar at `_holders.{id}.reliability` | Marginal of the conditional posterior across outputs; no standalone field needed. |
| Caller-side hardcoded expectations of response shape | Marginal over `outputShape` of the conditional posterior; declared once at the commitment, learned thereafter. |
| External CART / decision-tree training | Refinement-promotion cascade rule over the block log. |
| Separate model artifacts and training pipelines | Posterior state on `_commitments.{id}.distribution.posterior.*`; mounts are the updates. |
| Hardcoded admission predicates in laws | Posterior-read predicates — `law.check` references the posterior, admits only if the observation lies above a posterior-predictive threshold. |
| Drift compensation via manual retraining | `decay()` on the posterior — same primitive as type-survival decay, applied to the posterior's effective sample size. |

## Laws carry the posteriors as policy

Laws today (`laws.ts`) are pre-mount admission predicates whose
`check` field is a serializable `Constraint`. The extension
required is modest: `check` must be able to read posterior state
via path and test observations against posterior-predictive
quantiles.

Once it can:

```
law({
  admission: true,
  check: posteriorAdmit(
    '_commitments.{id}.distribution.posterior.{subtype}.outputShape',
    { quantile: 0.99 }
  ),
  reason: 'output shape lies outside learned posterior for this input subtype'
})
```

A law now says "reject writes to the head that fall outside the
99th-percentile posterior-predictive for the input's subtype."
Admission is posterior-conditioned; the posterior is learned; the
learning is compression. Contract policy and enforcement become
live against accumulated evidence instead of static predicates.

This is what it means for laws and commitments, together, to
capture probability distributions over time and output structure:

- **Commitment** — per-instance write-lease carrying the
  instantiated conditional posterior predictive.
- **Law** — the shape-space invariant, parameterized by the
  posterior, admitting or rejecting observations.
- **Subtype declaration** — the compression unit; mounting one is
  the act of committing a learned regularity to the log.

Three factors, one substrate.

## The refinement-promotion rule

A proposed subtype S is admissible as a new refinement iff it pays
its own description-length cost against the current log:

```
admit S   iff   DL(log | null) - DL(log | S) > DL(S)
```

Equivalently, the Bayes factor `P(log | S) / P(log | null)` must
exceed a configured threshold. This is classical AIC / BIC / MDL
model comparison restated. It is the substrate's learning-rate
analog: a refinement is mounted only when observation gain exceeds
statement cost, and nowhere else.

The rule itself is a standard admission law, gating the mount of
new subtype declarations. Laws gating the mount of laws — self-
referential in the expected way, unproblematic because laws are
data.

Without this rule, the cascade will promote a subtype on every
marginal information-gain wobble, the lattice grows monotonically,
and compression actively loses. With it, promotion is bounded by
the same principle that makes learning and compression equivalent
in the first place.

## Implementation contract

What the kernel must provide (load-bearing):

1. **Posterior schema** at
   `_commitments.{id}.distribution.posterior.{subtype}.{dimension}`
   as a recognized type-state convention carrying conjugate-prior
   fields (sufficient statistics, effective sample size, last-
   update block ID).
2. **Subtype-membership computation** — for an input path and a
   declared subtype, return the concreteness of the input against
   the subtype. Soft where subtypes overlap (meet is non-never);
   hard where they are lattice-disjoint. A15 handles this.
3. **Conjugate update at cascade terminal** — for every commitment
   whose head reached concrete final state this turn, compute the
   input's subtype membership and mount posterior updates
   proportional to membership for each declared `over` dimension.
   One mount per (subtype, dimension) pair.
4. **Refinement admission law** — a built-in admission law that
   gates the mount of new subtype declarations by the MDL / Bayes-
   factor threshold. The threshold is configurable per-commitment
   via `refinementPolicy`.
5. **Posterior-read predicates** in `law.check` — a
   `posteriorAdmit(path, options)` constraint family that evaluates
   observations against posterior-predictive quantiles.

What the kernel does NOT need to know:

- Specific conjugate family (Gamma, Dirichlet, Normal-Gamma,
  Beta-Binomial). These are type conventions on the posterior
  record. The `distribution('fn', directFunction)` open-taxonomy
  escape hatch (see `concreteness-distribution.test.ts`) applies:
  any deterministic update function is admissible.
- The specific MDL formulation used (crude 2-part code, normalized
  maximum likelihood, prequential coding). Policy-level; each
  commitment may declare its own.
- Train / eval split. Posteriors are live; admission runs per-
  mount; there is no offline evaluation phase.

## Migration plan

Incremental, gated by passing the existing 633 + 269 test baseline
at each step.

### Phase 1 — schema and builders

1. Extend the `distribution` field on the commitment record schema
   to carry `over[]`, `conditional_on[]`, `posterior[*][*]`, and
   `refinementPolicy`.
2. Add `posterior(family, params)` and `conditional(subtypes, ...)`
   builders in `type.ts`. Export.
3. Write coverage tests: enumerate, query, and audit posterior
   records on commitments with manually-mounted posteriors. No
   behavior change yet.

### Phase 2 — conjugate update at cascade terminal

4. Add a cascade rule that fires on commitment fulfillment
   (head reaches concrete final state): compute input subtype
   membership, mount membership-weighted conjugate updates for
   each declared `over` dimension.
5. Preserve scalar `distribution` semantics as a projected
   marginal over `time` with a single trivial subtype. All
   existing reliability and latency-prior code paths see the same
   scalar they see today; generalization is additive.

### Phase 3 — posterior-read laws

6. Extend `law.check` to support constraints that read posterior
   state via path. Implement `posteriorAdmit(path, options)`.
7. Write reference laws: "admit iff posterior-predictive quantile
   exceeds threshold"; "admit iff observation within k sigma of
   posterior mean." These become the first posterior-aware
   contract policies.

### Phase 4 — refinement promotion

8. Cascade rule: scan the block log over a commitment's
   observation history against proposed splits (information-gain
   heuristic over candidate predicates). If the MDL win crosses
   the configured threshold, mount a subtype declaration.
9. Gate the mount via the refinement-admission law installed on
   the substrate. Tune default thresholds against a reference
   workload; document the knob.

### Phase 5 — drift and decay

10. Add `decay()` on posteriors — same primitive already used for
    type-survival (see `concreteness-distribution.test.ts:81`).
    Effective sample size decays with elapsed time, preventing
    posteriors from becoming rigid against genuine distribution
    drift.
11. Document the decay convention: if a capability's generating
    distribution changes, old evidence loses weight at the
    declared rate; new evidence dominates on the decay horizon.

### Phase 6 — federation

12. Verify subtype refinements and posterior updates federate via
    the existing block-log federation mechanism. Likely a test
    rather than new code — federation is agnostic to the content
    of a mount.

## Risks

- **Lattice bloat from noise**. The refinement-promotion rule is
  the mitigation. Without it, the cascade promotes subtypes on
  every marginal wobble and compression actively loses.
  Calibrate thresholds against a reference workload before
  landing Phase 4; expose the knob explicitly.

- **Conjugate family mismatch**. When the true generative process
  has bounded support, multimodality, or a shape no standard
  conjugate captures, a single closed-form family misfits. Allow
  `posterior('fn', directFunction)` as an open-taxonomy escape
  hatch, matching the precedent set by `decay('fn', ...)`.

- **Stale posteriors under drift**. Append-only logs cannot forget.
  Without decay, posteriors accumulate and become rigid against
  genuine distribution change. Phase 5 is not optional; a posterior
  without a decay policy is a liability.

- **Replay determinism**. Posterior mounts are ordinary type-state,
  so replay reproduces them. But floating-point conjugate updates
  must be deterministic in reduction order. Specify the reduction
  order as part of the update rule; do not delegate to
  non-deterministic sums.

- **Soft-membership double-counting**. When an input satisfies
  multiple non-disjoint subtypes, the naive update credits the
  observation to each subtype in full. Credit proportionally:
  `weight_k = membership_k / Σ_j membership_j`. The normalization
  must happen at update time, not at read time.

- **Cold start**. A posterior-read law with no accumulated posterior
  is ambiguous: deny all, admit all, or use the declared prior?
  Specify: admit iff the declared prior's predictive quantile is
  satisfied; fail closed only when `refinementPolicy` declares
  strict admission.

- **Promotion storms**. A burst of observations may cause
  simultaneous promotion of many nested subtypes. Limit promotions
  per cascade turn; enforce that a promoted subtype must stand for
  at least one turn before its children are candidates.

## Relationship to other architectural commitments

- **COMMITMENTS.md (landed)** — the write-side dual. The
  `distribution` field this document lifts from scalar to
  conditional is the same field COMMITMENTS.md declares; this
  document generalizes it without replacing it.

- **AXIOMS A15 / A16 (landed)** — probability = concreteness
  position; compose IS probability update. This document extends
  that reading: the substrate's lattice is not a fixed ontology
  but a structure that sharpens under observation, with
  promotion-of-refinement as the mechanism.

- **AXIOMS A17 preserves (landed)** — the backward inference
  channel. Sampling from the posterior predictive to synthesize a
  required input uses the same channel. Posterior-conditioned
  backward inference is strictly additive to the existing rule.

- **concreteness-distribution (landed)** — the three-factor time-
  indexed belief (completion × typeSurvival × provenance). This
  document adds input-subtype conditioning as an additional factor
  available to the composed cdf. Existing code continues to see a
  scalar cdf — the richer structure is a generalization.

- **Narrative-is-tool unification (landed)** — a narrative's gaps
  ARE types. This document adds that those gaps additionally carry
  posteriors learned from historical fills; a narrative sharpens
  as its capability accumulates observations.

- **Reader-side observability (deferred)** — a reader contract
  that renders a commitment's posterior, provenance, and
  refinement history is the observability surface for learning.
  Same render machinery as any other reader.

## Reading order for someone arriving at the substrate

1. **AXIOMS.md** — the load-bearing invariants.
2. **ARCHITECTURE.md** — how the pieces fit.
3. **COMMITMENTS.md** — what the substrate is doing, write-side.
4. **This document** — what the substrate is doing, learning-side.
5. **CAPABILITY_INSTALLATION.md** — what the substrate is doing,
   install-side.
6. **KERNEL_REQUIREMENTS.md** — the contract the kernel implements.
7. **DSL_REQUIREMENTS.md** — how it surfaces in ft text.

COMMITMENTS.md (write-side), this document (learning-side), and
CAPABILITY_INSTALLATION.md (install-side) together describe one
cascade in three terminal projections: election of new write-
leases, compression of the observations that fulfilled the old
ones, and acquisition of the capabilities that produce both.
One substrate, one log, one loop — three entry points into the
same machine.
