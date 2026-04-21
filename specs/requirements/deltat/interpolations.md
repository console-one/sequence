# Interpolations -- Contingent Patches on State

## Original Notes

We can take two events:

(ASSUME/RUN Y)
  FROM START OF PATTERN-LIKE-OBSERVATION1 UPTO END OF PATTERN-LIKE-OBSERVATION2
  UNLESS (EVENT-OBSERVATION) OR (PATTERN-LIKE-OBSERVATION3 PREMPTS PATTERN-LIKE-OBSERVATION1)

THAT BASICALLY MOUNTS A CONTIGENT PATCH ON THE STATE IN A WHERE BLOCK FOR THE INVERSION OF THE CLAUSE

---

## Problem Context

- **Actor(s)**: The system (which cannot always wait for complete information), processes consuming assumed values (which need to know the value is provisional), and the invalidation system (which must cleanly retract broken assumptions).
- **Domain**: Speculative state management -- acting on provisional values when complete information is unavailable, while maintaining the ability to retract cleanly when assumptions prove wrong.
- **Core Tension**: Waiting for full information stalls the system. Acting on incomplete information risks acting on wrong data. The system needs a disciplined mechanism for provisional values that makes the speculation visible, tracks its conditions, and handles both expected completion (the real value arrived) and exceptional invalidation (the assumption was wrong) with different urgency.

## Requirements

**R1**: The system SHALL support assumptions: provisional values that are conditionally active and self-invalidate when their conditions break.
- *Rationale*: Many processes cannot block waiting for information that may take seconds or minutes. A provisional value lets the system proceed while marking the speculation.
- *Verifiable by*: A value can be declared as an assumption with activation and invalidation conditions. While active, it is usable. When a condition breaks, it disappears.

**R2**: An assumption SHALL have three lifecycle phases: suspended (waiting for activation), active (the provisional value is in force), and invalidated (the assumption has been retracted).
- *Rationale*: The lifecycle must be explicit and queryable so consumers know whether they are working with provisional, concrete, or no data.
- *Verifiable by*: An assumption transitions from suspended to active when its activation condition is met, and from active to invalidated when any invalidation condition fires.

**R3**: While active, an assumed value SHALL be visibly tagged as provisional. The provisional tag SHALL be part of the value's metadata, not require manual checking.
- *Rationale*: Consumers reading an assumed value must be able to distinguish it from a concrete value without extra API calls.
- *Verifiable by*: Reading an active assumption returns both the value and a provisional flag = true.

**R4**: An assumption SHALL distinguish between normal termination and exceptional termination:
- Normal termination (the expected real value arrived, replacing the assumption).
- Exceptional termination (the assumption was contradicted by evidence).
- *Rationale*: Normal termination means things went as expected; exceptional termination means the system was wrong and downstream corrections may be urgent.
- *Verifiable by*: Two different invalidation events produce termination signals with different cause attributions and different urgency flags.

**R5**: When any single invalidation condition fires, the assumption SHALL be immediately invalidated. Multiple conditions SHALL be disjunctive (any one is sufficient).
- *Rationale*: The original notes use "UNLESS A OR B" -- any contraindication kills the assumption.
- *Verifiable by*: An assumption with three invalidation conditions terminates when any one of the three fires, regardless of the other two.

**R6**: When an assumption invalidates, the system SHALL produce a cause-attributed signal identifying which specific condition triggered the invalidation and whether it was normal or exceptional.
- *Rationale*: Downstream processes behave differently depending on why the assumption broke.
- *Verifiable by*: The invalidation signal contains the trigger identity and a boolean indicating normal vs. exceptional.

**R7**: After invalidation, the path the assumption occupied SHALL revert to an unresolved state (a gap).
- *Rationale*: The provisional value is gone; the path is again unknown and needs resolution.
- *Verifiable by*: After invalidation, querying the path returns no value, and the path appears in the set of unresolved items.

**R8**: An exceptionally-invalidated path SHALL be prioritized higher than a path that was never assumed.
- *Rationale*: The system acted on wrong data. Correcting it is more urgent than resolving a path that was always unknown.
- *Verifiable by*: After exceptional invalidation, the reopened gap's priority is higher than the priority of a gap that has never had an assumption.

**R9**: After exceptional invalidation, the system SHOULD surface recovery options (retry, fallback, escalation) alongside the elevated-priority gap.
- *Rationale*: Flagging the problem without offering remediation leaves the operator without a path forward.
- *Verifiable by*: When an assumption is exceptionally invalidated, the gap includes suggested recovery actions.

**R10**: Assumptions SHALL compose with other temporal patterns: an assumption inside a scoped temporal action SHALL invalidate when the outer action terminates.
- *Rationale*: Assumptions must respect their enclosing lifecycle scope.
- *Verifiable by*: An assumption whose enclosing action terminates is invalidated, producing an invalidation signal attributed to the outer action's termination.

**R11**: Nesting depth for assumptions within temporal scopes SHALL NOT be artificially limited.
- *Rationale*: Real processes have arbitrary nesting.
- *Verifiable by*: A 3-level nested structure (action > action > assumption) cascades termination correctly from any level.

## Acceptance Criteria

**AC1** [R1, R2]: Given an assumption A with activation condition "fetchStarted", when fetchStarted occurs, then A transitions from suspended to active and its provisional value is visible.

**AC2** [R3]: Given an active assumption with value "standard", when a consumer reads the path, then it receives ("standard", provisional = true).

**AC3** [R4, R6]: Given an assumption with normal termination condition "fetchCompleted" and exceptional condition "authFailed", when fetchCompleted fires, then the signal has cause = "fetchCompleted" and wasException = false.

**AC4** [R4, R6]: Given the same assumption, when authFailed fires instead, then the signal has cause = "authFailed" and wasException = true.

**AC5** [R5]: Given an assumption with three UNLESS conditions (A, B, C), when only B fires, then the assumption is invalidated with cause = B.

**AC6** [R7, R8]: Given an exceptionally invalidated assumption at path P, when querying unresolved items, then P appears with higher priority than path Q that was never assumed.

**AC7** [R10]: Given an assumption inside a temporal action that terminates due to timeout, when the timeout fires, then both the action and the assumption terminate, with the assumption's invalidation attributed to the outer action's termination.

## Open Questions

1. What happens when a path has both a concrete value and an active assumption? Does the concrete value take precedence, effectively making the assumption redundant?
2. Can an assumption be replaced by another assumption (re-assumed with different conditions) without going through an explicit invalidation step?
3. How long does the elevated priority from exceptional invalidation last? Does it decay, or does it stay elevated until the path is resolved?
