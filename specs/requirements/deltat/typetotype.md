# Type To Type -- Type Transformations Through Function Chains

## Original Notes

A value passing through a pipeline of capabilities evolves in type at each step. Step 1 produces `{data: any, source: string}`. Step 2 requires `{data: object}` and produces `{data: object, parsed: true}`. At each junction, the system computes the narrowed type -- the intersection of the prior step's output and the next step's input constraint. If the intersection is empty, the pipeline is broken at that junction.

This is type-level reasoning. It happens at declaration time, before any step executes. The scheduler can predict the full pipeline's type trajectory, measure concreteness at each step, and run backward inference (given the final desired type, what must the first step receive?). During execution, each step's status is independently tracked: completed, ready, or waiting.

The hard part is backward inference through steps that preserve properties. If step 2 passes all fields through unchanged, then a requirement on step 3's output is also a requirement on step 2's input. The system must propagate requirements backward through preservation without loss.

---

## Problem Context

- **Actor(s)**: Pipeline authors (who compose multi-step capability chains), the scheduler (which predicts type trajectories and validates compatibility), backward inference (which derives input requirements from output requirements).
- **Domain**: Static type-level analysis of multi-step data transformation pipelines -- validating compatibility at each junction, predicting the type trajectory before execution, and deriving input requirements from output requirements.
- **Core Tension**: Each step in a pipeline transforms types. The system must validate that adjacent steps are compatible (output of step N is a valid input for step N+1) at declaration time, before any step runs. Additionally, backward inference must trace requirements through steps that may preserve, transform, or drop fields -- and property-preserving steps must propagate requirements without loss.

## Requirements

**R1**: The system SHALL validate pipeline compatibility at declaration time by computing the type intersection at each junction (output of step N intersected with input constraint of step N+1).
- *Rationale*: Catching type mismatches before execution prevents wasted work and provides clear error messages.
- *Verifiable by*: A pipeline where step 1 outputs `{data: string}` and step 2 requires `{data: number}` is flagged as incompatible at declaration time, before any step executes.

**R2**: If the type intersection at any junction is empty (incompatible types), the system SHALL flag the pipeline as invalid and identify the specific junction and the mismatched types.
- *Rationale*: "Pipeline is broken" is not helpful. The error must pinpoint where and why.
- *Verifiable by*: The error message identifies the junction (e.g., "between step 1 and step 2") and the conflicting types (e.g., "step 1 outputs string, step 2 requires number for field 'data'").

**R3**: The system SHALL compute a concreteness score (0 to 1) at each junction in the pipeline, representing how resolved the type is after that step.
- *Rationale*: The concreteness trajectory is a progress metric that lets the scheduler and operator understand how much each step contributes to type resolution.
- *Verifiable by*: A 3-step pipeline shows increasing concreteness at each junction (e.g., 0.1, 0.4, 0.9).

**R4**: Concreteness SHALL be monotonically non-decreasing through the pipeline. Each step SHALL make the type at least as concrete as it was before.
- *Rationale*: A pipeline step that makes the type less concrete (more ambiguous) is either erroneous or improperly typed.
- *Verifiable by*: For every adjacent pair of junctions (i, i+1), concreteness(i+1) >= concreteness(i).

**R5**: The system SHALL support backward inference: given a desired output type at the end of the pipeline, derive the required input type at the beginning.
- *Rationale*: The user often knows what they want at the end ("I need a validated User object") and needs the system to tell them what must go in at the start.
- *Verifiable by*: Given a 3-step pipeline and a final output requirement of `{user: {name: string}}`, backward inference produces the required input type for step 1.

**R6**: Backward inference through a property-preserving step (one that passes fields through unchanged) SHALL propagate requirements without loss.
- *Rationale*: If step 2 preserves all fields and step 3 requires field "name", then step 2's input must also have field "name". Losing this requirement during backward propagation produces incorrect results.
- *Verifiable by*: A requirement for field "name" at step 3, traced backward through a property-preserving step 2, appears as a requirement for field "name" at step 2's input.

**R7**: If backward inference produces an unsatisfiable requirement at any step (e.g., the final requirement asks for a field no step produces), the system SHALL surface this as an explicit unsatisfiable-requirement error.
- *Rationale*: Silent failure during backward inference wastes debugging time.
- *Verifiable by*: When the final output requires a field that no step in the pipeline produces, the system reports which field is unsatisfiable and at which step the requirement cannot be met.

**R8**: During execution, each step's status SHALL be independently tracked as one of: waiting (input not yet available), ready (input available, not yet executed), or completed (executed, output known).
- *Rationale*: Fine-grained status tracking enables the scheduler to parallelize independent steps and the operator to see pipeline progress.
- *Verifiable by*: After step 1 completes, step 1 shows "completed", step 2 shows "ready", and step 3 shows "waiting".

**R9**: When a step completes and its actual output type is narrower than the predicted type, the concreteness at subsequent junctions SHALL be updated to reflect the actual type.
- *Rationale*: Predictions are conservative. Actual execution can only make things more concrete. Updating downstream predictions improves scheduling accuracy.
- *Verifiable by*: If step 1 was predicted to produce concreteness 0.1 but actually produces 0.25, subsequent junction concreteness scores are updated upward.

**R10**: The concreteness trajectory SHALL distinguish predicted values (computed at declaration time) from actual values (computed during execution). Actual values SHALL always be >= predicted values.
- *Rationale*: Operators need to see both the prediction and the reality, and know that predictions are a lower bound.
- *Verifiable by*: Querying the trajectory returns both predicted and actual concreteness per junction, with actual >= predicted wherever actual is available.

## Acceptance Criteria

**AC1** [R1, R2]: Given a pipeline where step 1 outputs `{data: string}` and step 2 requires `{data: number}`, when the pipeline is declared, then it is flagged as invalid with the specific junction and type mismatch identified.

**AC2** [R3, R4]: Given a valid 3-step pipeline, when the concreteness trajectory is computed, then it shows monotonically non-decreasing values (e.g., [0.1, 0.4, 0.9]).

**AC3** [R5, R6]: Given a 3-step pipeline where step 2 is property-preserving, when backward inference is run with a final requirement of `{user: {name: string}}`, then the requirement for "name" appears in step 1's required input.

**AC4** [R7]: Given a pipeline where no step produces field "email", when backward inference requires `{email: string}` at the output, then the system reports "email" as unsatisfiable.

**AC5** [R8]: Given a 3-step pipeline where step 1 has just completed, when querying step statuses, then step 1 = "completed", step 2 = "ready", step 3 = "waiting".

**AC6** [R9, R10]: Given step 1 predicted to produce concreteness 0.1 but actually producing 0.25, when querying the trajectory, then step 1 shows predicted = 0.1, actual = 0.25, and downstream predicted concreteness values are updated.

## Open Questions

1. How does the system handle steps that conditionally produce different output types (e.g., step 2 might output type A or type B depending on runtime data)? Is this modeled as a probabilistic union (per the timelinetotype spec) or as separate pipeline branches?
2. Should backward inference consider the cost of satisfying requirements (e.g., "providing field X requires an expensive lookup") or only feasibility?
3. How are cycles handled if a pipeline step's output feeds back into an earlier step's input? Is this prohibited, or supported with fixed-point semantics?
