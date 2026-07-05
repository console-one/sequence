// @console-one/sequence/v2 — feature-rule kernel + stdlib.
//
// The v2 substrate: kernel = traverse + admission + compose + propagate;
// every feature (commitments, reliability, working-set rescore, posterior
// admission, refinement promotion, cross-sequence federation, planner) is
// an installable rule + emitter pair. Call `install*` at boot before any
// inserts.
//
// Imported as: `import { Sequence, installCommitment } from '@console-one/sequence/v2'`.
//
// Co-exists with v1 (`@console-one/sequence`, the legacy `Sequence` class
// + `mount` API) for as long as v1 consumers (sequenceutils etc.) need it.
// The two share the type vocabulary in `../src/type` and the math in
// `../src/compose`; only the kernel is different.

// ─── Kernel ─────────────────────────────────────────────────────────────
export { Sequence } from './sequence';
export type {
  Coordinate, Block, Cell, Delta, Rule, EmitterCtx, Emitter,
  BlockTemplate, GuardOp, Frame, Axis,
  InsertInput, InsertResult,
} from './sequence';

// ─── Standalone constraint evaluation ───────────────────────────────────
// Evaluate a serialized Constraint ({op, args} — the laws vocabulary)
// against a plain state object + $var bindings, WITHOUT constructing a
// Sequence. Relations delegate to the shared `check` machinery. The
// entry point for consumers (e.g. topic-dao write conditions) that hold
// folded state as a plain object.
export { evaluateConstraint } from './evaluate';

// ─── Standalone commitment election (S-B2 POSMDP / R8) ──────────────────
// The decide-when election an actor runs at a decision epoch: one owed
// occurrence + plain observations → {act|wait, next-decision epoch,
// deadline}. WAIT is first-class (the actor's self-scheduled wake). v0 =
// the trivial policy; the planner (searchCandidates/feasibility) replaces
// the internals without moving the seam. Distinct from the v1 root's
// electCommitment (the write-lease API): this one decides, writes nothing.
export { electCommitment } from './elect';
export type {
  CommitmentCandidate, ElectObservations, Election, ElectReason,
} from './elect';

// ─── Stdlib installers ──────────────────────────────────────────────────
// Each install* function mounts its rule(s) + registers its emitter(s) /
// guard op(s) on the sequence. Idempotent; safe to call once at boot.
export {
  installPartitionDirection,
  installBehavioralPredicates,
  installAutoWire,
  installWorkingSetRescore,
  installCommitment,
  installReliability,
  installPosteriorAdmit,
  installLimit,
  installMeterAt,
  installIndexSpec,
  installRefinement,
  installAccessPosterior,
  installCrossSequence,
  installReader,
  /** Convenience: install partition + commitment + reliability +
   *  posteriorAdmit + indexSpec + refinement in one call. Does NOT
   *  install autoWire / workingSetRescore / behavioralPredicates /
   *  accessPosterior / crossSequence / reader — those are opt-in. */
  installStdLib,
} from './stdlib';

// ─── Stdlib — async lifecycle + clock ───────────────────────────────────
export {
  flushPending,
  advanceClock,
} from './stdlib';

// ─── Stdlib — backward-inference planner + plan execution ───────────────
export {
  search,
  searchCandidates,
  flattenPlan,
  feasibility,
  executePlan,
} from './stdlib';
export type {
  Plan, PlanStep, PlanGap,
  Feasibility,
  DependencyModel,
} from './stdlib';

// ─── Stdlib — concreteness distribution + access scoring ────────────────
export {
  concretenessDistribution,
  accessScore,
} from './stdlib';
export type {
  ConcretenessDistribution,
} from './stdlib';

// ─── Stdlib — admission constraint constructors ─────────────────────────
export {
  posteriorAdmit,
  limit,
  meterAt,
} from './stdlib';

// ─── Stdlib — cross-sequence federation ─────────────────────────────────
export {
  receiveFromPeer,
} from './stdlib';
export type {
  Outgoing, ForwardHandler,
} from './stdlib';

// ─── Stdlib — reader contracts + hoist + render ─────────────────────────
export {
  hoistForReader,
  renderDocument,
  buildHoistingFormatter,
} from './stdlib';
export type {
  ReaderConfig,
  HoistResult,
  DocSection, DocResult,
  HoistingFormatter,
} from './stdlib';

// ─── Stdlib — type/refinement helpers ───────────────────────────────────
export {
  extractFnClaims,
  subtypeKey,
  registerRefiner,
  mdlGain,
} from './stdlib';

// ─── Stdlib — snapshot + restore (durable handoff) ──────────────────────
export {
  captureSnapshot,
  restoreSnapshot,
} from './stdlib';
export type {
  PriorSnapshot,
  SnapshotEntry,
} from './stdlib';

// ─── Stdlib — chained negotiation (federated planning) ──────────────────
export {
  negotiatePlan,
  proposePlan,
} from './stdlib';
export type {
  StepOwner,
  ChainedNegotiationResult,
  ProposalStatus, ProposalInput, ProposalDecision, ProposalEvaluator,
} from './stdlib';

// ─── Stdlib — partition model ───────────────────────────────────────────
export {
  partitionOf,
  partitionOfType,
  PARTITION_PERSISTENCE,
  PARTITION_AUTHORITY,
} from './stdlib';
export type {
  Partition,
} from './stdlib';

// ─── Stdlib — path conventions ──────────────────────────────────────────
export {
  COMMITMENT_PREFIX,
} from './stdlib';

// ─── Stdlib — distribution math (re-exported by stdlib from src/compose) ─
export {
  cdf,
  survival,
  posteriorPredictive,
  conjugateUpdate,
} from './stdlib';
export type {
  DistParams,
} from './stdlib';

// ───────────────────────────────────────────────────────────────────────
// SHARED TYPE + COMPOSE PRIMITIVES
//
// These live in the v1 src/ tree but are SHARED with v2 (v2 stdlib imports
// them from '../src/type' and '../src/compose'). Re-exporting from this
// module gives v2 consumers a single coherent import surface.
// ───────────────────────────────────────────────────────────────────────

// Type vocabulary
export {
  createType, literal, property, element, arrayLength,
  constraintOf, constraintsOf, literalValue, properties,
  isAny, isNever, ANY,
  eq, neq, gt, gte, lt, lte, exists, notExists,
  or, and, not, regex, between, oneOf, contains, satisfies, countGte,
  bindFrom, indexSpec, law,
  add, mul, call, pm, computable,
  key, responsePolicy, min, max, distribution, preserves, param, returns,
  endpoint, auth,
  producedBy, partition, decay, cdfGte, concreteAt,
  version, template, ref, derived, impl,
} from '../src/type';
export type { Type, Constraint, Expr } from '../src/type';

// FT builder (convenience API for type construction)
export { FT } from '../src/builder';

// Composition / lattice / backward inference / plan feasibility
export {
  compose, covers, check, backwardInfer, selectFirstBranch,
  typeSpecificity, evaluateExpr, exprConcreteness,
  planFeasibility,
} from '../src/compose';
// `cdf` / `survival` / `posteriorPredictive` / `conjugateUpdate` are
// re-exported above (via stdlib) — same symbols, single source of truth.
export type {
  Gap, Follow, CheckResult,
  StepDistribution, PlanFeasibilityTrace,
} from '../src/compose';
// Compose's DependencyModel is broader than stdlib's (4 values vs 2).
// Alias to avoid collision; consumers rarely need the compose-side enum.
export type { DependencyModel as ComposeDependencyModel } from '../src/compose';
