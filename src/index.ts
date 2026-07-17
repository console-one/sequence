// Kernel
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
  cdf, cdfInverse, posteriorPredictive, conjugateUpdate,
  planFeasibility,
} from './compose';
export type { Gap, Follow, CheckResult, DependencyModel, StepDistribution, PlanFeasibilityTrace, CdfInverseResult } from './compose';

// Statements
export type { MountEntry, Block, BlockOpts } from './statement';

// Builder (FT.* convenience API)
export { FT } from './builder';

// Hoist (emit)
export { hoist, hoistForReader, hoistCatalog } from './hoist';
export type { CatalogOptions } from './hoist';

// DSL pipeline
export { receive } from './dsl/walker';
export type { ImportResolver } from './dsl/walker';

// Environment
export { loadEnv } from './env';
export type { EnvOpts } from './env';

// Render pipeline
export { renderForReader } from './runtime/render';
export type { ReaderConfig, RenderResult, ScoredCluster, Cluster } from './runtime/render';

// Rotation — lock-holder moves a range to a destination with a
// transparent redirect. The compression/federation/retention
// primitive, applied recursively at any tier.
export { rotate } from './rotation';
export type { RotateOpts, RotateResult } from './rotation';

// Commitments — the substrate's write-side primitive. Cascade fixed
// point's terminal action elects commitments to external work; open
// commitments at `_commitments.*` ARE the substrate's call stack.
// See specs/docs/COMMITMENTS.md.
export {
  COMMITMENT_PREFIX,
  commitmentRecordSchema, installCommitmentSchema,
  electCommitment, fulfillCommitment, revokeCommitment, violateCommitment,
  readCommitment, commitments, openCommitments,
  installCommitmentsReader,
} from './commitments';
export type { CommitmentStatus, ElectCommitmentOpts, CommitmentHandle, CommitmentRecord } from './commitments';

