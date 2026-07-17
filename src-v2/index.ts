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
export { evaluateConstraint, atTermKey, collectAtTerms, valueAtPath } from './evaluate';

// ─── Standalone procedure planning (DSL PROGRAM seam 4) ─────────────────
// A ProcedureManifest is serializable vocabulary: typed params (sequence
// Types validated by check()), a closed derivation vocabulary, guarded
// steps. planProcedure = pure evaluator → planned facts the host runner
// executes; procedureGaps = the wizard's open-contract read;
// planProcessorConfig = the edit-side config re-derivation.
export { planProcedure, procedureGaps, planProcessorConfig } from './procedure';
export type {
  ProcedureManifest, ProcedureParam, ProcedureStep, ProcedureValue,
  TemplateValue, PlannedFact, ProcedureGap, PlanResult, StepGuard,
} from './procedure';

// ─── The budget/threshold relations (one definition, three tiers) ───────
// withinMax = `number ∧ max(limit)` conformance; reachedMin = the dual.
// Fail-closed on non-finite. Consumed by the desktop gate, the firing
// laws, and the deployed topic-service admission gate.
export { withinMax, reachedMin } from './relations';

// ─── Standalone view planning (DSL PROGRAM seam 5 / R5) ─────────────────
// A ViewSpec is serializable vocabulary: sections in priority order, each
// offering rungs richest→cheapest with host-gathered costs. planView =
// pure evaluator → one elected rung per section + spend + the eviction
// manifest (what the reader is NOT seeing). The expression elects and
// budgets; it never formats — materialization stays with the host runner.
// Selection semantics migrated from @console-one/compile's greedy selector
// (beam/Lagrangian stay archived until measured prices exist).
export { planView } from './view';

// ─── Selection under prices (R8/R5 — the attention market) ──────────────
// selectUnderPrices = the standalone Lagrangian selection evaluator,
// recovered from the archived @console-one/compile selector (observatory
// TECH-DEBT #6's recorded re-adoption trigger; MAP-ATTENTION-MARKET v1).
// Flat market: candidates bid value against declared capacities; the
// DUAL PRICES are first-class output — rising duals ARE saturation, and
// silence is nothing clearing the price. Greedy/beam ride along as
// non-pricing baselines.
export { selectUnderPrices } from './select';
export type {
  SelectCandidate, SelectCapacities, SelectOptions, SelectResult,
} from './select';
export type {
  ViewSpec, ViewSection, ViewRung, ViewCost, ViewPlan, ViewPick, ViewEviction,
} from './view';

// ─── Constraint time horizons (expiry-as-deviation) ─────────────────────
// timeHorizon reads the CLOSED valid-until family off a serialized
// constraint (lte/lt($now, T); and_clause → min). Hosts feed the soonest
// horizon among observed claims into electCommitment's observationHorizon
// so a known future expiry bounds the actor's next decision epoch.
export { timeHorizon } from './validity';
export type { ConstraintShape } from './validity';

// ─── The designation fold (allocation as declared space law) ────────────
// The space's declared rule + the claim rows on its own spine order who
// takes an owed occurrence and when each turn arrives — a pure fold every
// member computes identically; slots expire into act (starvation-proof);
// the claim fold stays the adjudicator. Hosts feed the actor's own slot
// into electCommitment as observations.designatedAt.
export { designate, DEFAULT_FAILOVER_MS } from './designate';
export type { AllocationRule, ClaimRow, Designation } from './designate';

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

// ─── Base tools + the agent loop (deletion-ledger stage 2) ──────────────
// Supersede sequenceutils' v1 registrars and agent loop: the base effect
// primitives and the LLM-operates-the-environment loop, on THE kernel.
export { registerBaseTools, registerHttp, registerFs, registerSchedule, registerFsNode, registerProc } from './tools';
export type { ToolStorage } from './tools';
export { agentTick, agentLoop } from './agent-loop';
export type { LLMCall, TurnRecord, LoopResult } from './agent-loop';

// ─── The ft write side — call execution against seq.impls ───────────────
// Stage 1 of the v1 deletion ledger: parse ft text (shared dsl parser)
// and execute the call subset asynchronously against the impls registry.
export { receiveCalls } from './receive-calls';
export type { CallOutcome, ReceiveCallsResult } from './receive-calls';

// ─── Shared hoist — ONE hoister serves both engines ─────────────────────
// hoist (state) + hoistCatalog (the capability frame: nested package
// blocks + named-type extraction) live in ../src/hoist over the Readable
// interface; v2's Sequence satisfies it via keys()/rawTypeAt().
export { hoist, hoistCatalog } from '../src/hoist';
export type { CatalogOptions, Readable } from '../src/hoist';

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
// `cdfInverse` (threshold → first-reach time, deltat R4) is not consumed
// by stdlib, so it exports straight from the shared compose module.
export { cdfInverse } from '../src/compose';
export type {
  Gap, Follow, CheckResult,
  StepDistribution, PlanFeasibilityTrace, CdfInverseResult,
} from '../src/compose';
// Compose's DependencyModel is broader than stdlib's (4 values vs 2).
// Alias to avoid collision; consumers rarely need the compose-side enum.
export type { DependencyModel as ComposeDependencyModel } from '../src/compose';
