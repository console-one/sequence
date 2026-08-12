/**
 * stdlib.ts (v2) — feature rules mounted on a principled kernel.
 *
 * Every capability this module provides — commitment election, Bayesian
 * reliability tracking, posteriorAdmit admission, indexSpec self-
 * instantiating classes — is installed as:
 *   (a) one or more runtime-registered emitter functions, and
 *   (b) one or more declarative Rule values mounted at scope.
 *
 * The kernel is touched NOWHERE by this file. Each feature can be
 * toggled off by omitting its install() call. Features compose — order
 * of install doesn't matter.
 *
 * The discipline this file holds: when a new feature is proposed, the
 * first question is "can it be a rule?" The answer is almost always
 * yes, and this file demonstrates it.
 *
 * The features themselves now live under ./stdlib/, one concern module
 * per file (partition model, concreteness decay, behavioral predicates,
 * auto-wire, working-set rescore, commitments, backward inference,
 * reader contracts, cross-sequence forwarding, prompt rendering,
 * reliability, indexSpec, install wiring, negotiation, tool install,
 * blueprint, auth/session, node storage install, prior-snapshot
 * recovery). This file is a pure barrel: it re-exports the same public
 * surface this file always had, unchanged, so every existing
 * `from './stdlib'` import keeps working.
 */

export {
  type Partition,
  PARTITION_PERSISTENCE,
  PARTITION_AUTHORITY,
  partitionOfType,
  partitionOf,
  installPartitionDirection,
} from './stdlib/partition';
export {
  type ConcretenessDistribution,
  concretenessDistribution,
  cdf,
  survival,
  posteriorPredictive,
  conjugateUpdate,
  evidenceDecay,
  type DistParams,
} from './stdlib/concreteness';
export { installBehavioralPredicates } from './stdlib/behavioral';
export { installAutoWire } from './stdlib/auto-wire';
export { installWorkingSetRescore } from './stdlib/working-set';
export { COMMITMENT_PREFIX, flushPending, advanceClock } from './stdlib/commitments';
export {
  type PlanStep,
  type PlanGap,
  type Plan,
  search,
  searchCandidates,
  flattenPlan,
  type DependencyModel,
  type Feasibility,
  feasibility,
  executePlan,
} from './stdlib/planner';
export {
  type ReaderConfig,
  type HoistResult,
  installReader,
  installAccessPosterior,
  accessScore,
  hoistForReader,
} from './stdlib/reader';
export {
  type Outgoing,
  type ForwardHandler,
  installCrossSequence,
  receiveFromPeer,
} from './stdlib/federation';
export {
  type DocSection,
  type DocResult,
  renderDocument,
  type HoistingFormatter,
  buildHoistingFormatter,
  extractFnClaims,
  installAgentPrompt,
} from './stdlib/render';
export {
  subtypeKey,
  registerRefiner,
  mdlGain,
  installRefinement,
  posteriorAdmit,
  limit,
  meterAt,
} from './stdlib/reliability';
export {
  installCommitment,
  installReliability,
  installPosteriorAdmit,
  installLimit,
  installMeterAt,
  installIndexSpec,
  installStdLib,
} from './stdlib/install';
export {
  type StepOwner,
  type ChainedNegotiationResult,
  negotiatePlan,
  type ProposalStatus,
  type ProposalInput,
  proposePlan,
  type ProposalDecision,
  type ProposalEvaluator,
  budgetedEvaluator,
  installRefundRule,
  installProposalHandler,
} from './stdlib/negotiation';
export { installTool } from './stdlib/tool';
export {
  type BlueprintGapSpec,
  installBlueprint,
  type GapEntry,
  installBlueprintGapsReader,
  installKit,
  installBlueprintOutput,
} from './stdlib/blueprint';
export {
  installWriterAuthority,
  type SessionLifecycleConfig,
  installSessionLifecycle,
  installHolderRelease,
  type SessionToken,
  type AuthValidationResult,
  mintSessionToken,
  validateSessionToken,
  generateTokenSecret,
  type AuthCapsConfig,
  installAuthCaps,
  stampSessionToken,
} from './stdlib/auth-session';
export { installNodeStorage } from './stdlib/storage-install';
export {
  type SnapshotEntry,
  type PriorSnapshot,
  captureSnapshot,
  restoreSnapshot,
} from './stdlib/snapshot';
