// Kernel
/** @deprecated v1 engine — new work targets `@console-one/sequence/v2`.
 *  The root export flips to v2 at 0.4.0; `./v1` keeps this surface for
 *  one minor after. Migration stages: specs/docs/DELETION_LEDGER.md. */
export { Sequence, partitionOf, partitionOfType } from './sequence';
export type { Projection, MountResult, PendingInvocation, Partition } from './sequence';

// Type system
export {
  createType, literal, property, element, arrayLength,
  constraintOf, constraintsOf, literalValue, properties,
  isAny, isNever, ANY,
  eq, neq, gt, gte, lt, lte, exists, notExists,
  or, and, not, regex, between, oneOf, contains, satisfies, countGte,
  bindFrom, indexSpec, law,
  add, mul, call, pm, computable,
  key, responsePolicy, min, max, distribution, preserves, param, returns, endpoint, auth,
  producedBy, partition, decay, cdfGte, concreteAt,
  version,
  template,
  ref, derived, impl,
} from './type';
export type { Type, Constraint, Expr } from './type';

// Composition / lattice
export {
  compose, covers, check, backwardInfer, selectFirstBranch,
  typeSpecificity, evaluateExpr, exprConcreteness,
  cdf, survival, cdfInverse, posteriorPredictive, conjugateUpdate, evidenceDecay,
  planFeasibility,
} from './compose';
export type { Gap, Follow, CheckResult, DependencyModel, StepDistribution, PlanFeasibilityTrace, CdfInverseResult } from './compose';

// Statements
/** @deprecated v1 engine persistence surface — v2 hosts use
 *  snapshot/restore + `IStorage` (specs/docs/DELETION_LEDGER.md). */
export type { MountEntry, Block, BlockOpts } from './statement';

// Builder (FT.* convenience API)
export { FT } from './builder';

// Hoist (emit)
export { hoist, hoistForReader, hoistCatalog, hoistCatalogSections } from './hoist';
export type { CatalogOptions } from './hoist';

// DSL pipeline
/** @deprecated mounts into the v1 engine — v2's write side is
 *  `receiveDocument`/`receiveCalls`. The full-grammar v2 walk is the
 *  S6 load-bearing gap in specs/docs/DELETION_LEDGER.md; the ft
 *  parser itself (`@console-one/sequence/dsl`) is shared and stays. */
export { receive } from './dsl/walker';
export type { ImportResolver } from './dsl/walker';

// Environment
/** @deprecated v1 boot — a v2 boot call is the S6 gap tracked in
 *  specs/docs/DELETION_LEDGER.md. */
export { loadEnv } from './env';
export type { EnvOpts } from './env';

// Render pipeline
/** @deprecated v1 pipeline — v2's `hoistForReader`/`electFrame`
 *  are the successors (parity check tracked as S6). */
export { renderForReader } from './runtime/render';
export type { ReaderConfig, RenderResult, ScoredCluster, Cluster } from './runtime/render';

// Vending — tool compilation for clients: render the mounted tool
// surface as an ft document under constraints, with doc transclusion
// and a session contract (specs/docs/TOOL_COMPILATION_VENDING.md).
/** @deprecated v1 vend — `@console-one/sequence/v2` owns vending
 *  (`vend`/`revend`/`electFrame`); this module dies at S8
 *  (specs/docs/DELETION_LEDGER.md). */
export { vend, continueSession } from './vend';
export type { VendRequest, VendResult, ContinueResult } from './vend';

// Rotation — lock-holder moves a range to a destination with a
// transparent redirect. The compression/federation/retention
// primitive, applied recursively at any tier.
/** @deprecated v1-only — no v2 equivalent yet; port-or-waive is an
 *  S6 decision in specs/docs/DELETION_LEDGER.md. */
export { rotate } from './rotation';
export type { RotateOpts, RotateResult } from './rotation';

// Commitments — the substrate's write-side primitive. Cascade fixed
// point's terminal action elects commitments to external work; open
// commitments at `_commitments.*` ARE the substrate's call stack.
// See specs/docs/COMMITMENTS.md.
/** @deprecated v1 commitments — v2's `installCommitment` (stdlib) owns
 *  the concept; note v2 exports a DIFFERENT `electCommitment` (a pure
 *  act-or-wait decision). specs/docs/DELETION_LEDGER.md. */
export {
  COMMITMENT_PREFIX,
  commitmentRecordSchema, installCommitmentSchema,
  electCommitment, fulfillCommitment, revokeCommitment, violateCommitment,
  readCommitment, commitments, openCommitments,
  installCommitmentsReader,
} from './commitments';
export type { CommitmentStatus, ElectCommitmentOpts, CommitmentHandle, CommitmentRecord } from './commitments';

