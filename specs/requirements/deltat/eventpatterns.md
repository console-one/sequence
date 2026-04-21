# Semantic Event Patterns for APIs

## Original Notes

We use the following english terms to define < <= => > terms with respect to temporal (sequenced) when conditionals:

- Action BEFORE Observation = [
  (WHILE _cancel = undefined || _cancel === false) {
    MOUNT SOME ACTION
    _mount_time =  REAL_TIME
    ('WHERE B IS TRUE AND REAL_TIME >= _mount_time') _cancel = true
  }
]

...Finish Making the above logical statements for the below statments

- \<Action\> UPTO \<B\>
- \<Action\> FROM \<B\>
- \<Action\> AFTER \<B\>

We require the capacity to specify type rules with respect to interval relations of two patterns in a sequence:

- Ends Before Starts - (PREDICTS)
- Ends Upto Starts - (YIELDS)
- Starts Before Starts - ....
- Starts Upto Starts - ....
... and all the combinations of the above...

---

## Problem Context

- **Actor(s)**: Process authors (who declare temporal relationships between actions and observations), the scheduler (which enforces activation and liveness conditions), downstream consumers (who react to termination signals).
- **Domain**: Temporal coordination of actions relative to observations -- expressing when actions activate, how long they remain active, and how multi-step processes relate to each other in time.
- **Core Tension**: The system needs a small set of composable temporal primitives that can express both simple patterns (do X until Y) and complex interval relations (A ends before B starts) without special-casing. Termination must always be explicit and observable, never silent.

## Requirements

**R1**: The system SHALL provide four temporal primitives: BEFORE, UPTO, FROM, and AFTER. All other temporal patterns SHALL be expressible as compositions of these four.
- *Rationale*: A minimal primitive set avoids combinatorial special-casing while remaining expressive enough for interval algebra.
- *Verifiable by*: PREDICTS, YIELDS, OVERLAPS, and MEETS can each be expressed using only the four primitives applied to start/end events.

**R2**: Each temporal primitive SHALL have two independent aspects: an activation condition (when can the action start?) and a liveness condition (when does the action remain active?).
- *Rationale*: Activation and liveness are orthogonal concerns. BEFORE has no activation gate but has a liveness gate. FROM has an activation gate but no liveness bound. Their combinations cover the full space.
- *Verifiable by*: Each primitive's behavior can be described solely in terms of its activation condition (present or absent) and its liveness condition (present or absent).

**R3**: BEFORE SHALL activate an action immediately and terminate it when observation B occurs.
- *Rationale*: "Do X before Y" means X starts now and stops when Y happens.
- *Verifiable by*: An action declared with BEFORE is immediately active. When observation B is recorded, the action terminates.

**R4**: UPTO SHALL activate an action only if observation B has not yet occurred, and terminate it if B occurs later.
- *Rationale*: "Do X up to Y" means X can only start if Y hasn't happened yet. If Y already exists, X never starts.
- *Verifiable by*: If B already exists at declaration time, the action never activates. If B does not yet exist, the action activates and later terminates when B arrives.

**R5**: FROM SHALL suspend an action until observation B occurs, then activate it indefinitely.
- *Rationale*: "Do X from Y" means X waits for Y and then runs with no end condition.
- *Verifiable by*: Before B exists, the action is visibly suspended. After B occurs, the action is active and remains so.

**R6**: AFTER SHALL behave like FROM but with strict temporal ordering: the action SHALL activate only after B has been recorded in a prior logical step, not at the same instant B appears.
- *Rationale*: Some processes require that B is fully settled before the next action begins. Same-instant activation risks operating on partially-committed state.
- *Verifiable by*: When B is recorded at step N, a FROM-activated action can fire at step N but an AFTER-activated action fires no earlier than step N+1.

**R7**: When a liveness condition breaks, the system SHALL produce an explicit termination signal identifying which condition broke.
- *Rationale*: Downstream processes need to distinguish why an action ended (expected event arrived vs. preemption vs. timeout). Silent disappearance makes this impossible.
- *Verifiable by*: After an action terminates, a termination record exists containing the action identifier and the specific condition that caused termination.

**R8**: An action whose activation condition is not yet met SHALL be visibly suspended, not omitted.
- *Rationale*: Pending actions are part of system state. Hiding them prevents operators from understanding what the system is waiting for.
- *Verifiable by*: A FROM action waiting for its trigger is queryable and reports its status as "suspended" along with the unmet condition.

**R9**: Two temporal patterns SHALL compose into interval relations. Specifically:
- A ends before B starts = PREDICTS (using AFTER semantics on A's completion event)
- A ends at-or-before B starts = YIELDS (using FROM semantics on A's completion event)
- *Rationale*: The original notes list PREDICTS and YIELDS as first-class interval relations. These must emerge from primitive composition, not be hardcoded.
- *Verifiable by*: A PREDICTS B is equivalent to B being activated AFTER A's completion event. A YIELDS B is equivalent to B being activated FROM A's output event.

**R10**: Interval relations SHALL compose transitively: if A PREDICTS B and B YIELDS C, then C activates from B's output, which only exists after A completes.
- *Rationale*: Multi-step pipelines must work without explicit end-to-end sequencing.
- *Verifiable by*: In a three-stage pipeline declared with only pairwise relations, stages execute in order.

**R11**: Temporal operators SHALL support nesting: an action governed by one operator MAY itself be the action within another operator. When the outer operator terminates, all inner actions SHALL terminate with it.
- *Rationale*: Scoped lifecycle management prevents orphaned actions.
- *Verifiable by*: An inner action whose liveness depends on the outer action's status terminates when the outer action terminates, and both produce termination signals.

**R12**: Nesting depth SHALL NOT be artificially limited.
- *Rationale*: Real processes have arbitrary nesting (a retry loop inside a timeout inside a session).
- *Verifiable by*: A 5-level nested temporal structure behaves correctly, with termination cascading from any level.

## Acceptance Criteria

**AC1** [R3]: Given an action A declared with BEFORE(B), when B is recorded, then A terminates and a termination signal is produced with cause = B.

**AC2** [R4]: Given observation B already exists, when an action A is declared with UPTO(B), then A never activates and its status is reported accordingly.

**AC3** [R4]: Given B does not exist, when action A is declared with UPTO(B) and B later arrives, then A was active in the interim and terminates on B's arrival.

**AC4** [R5]: Given action A declared with FROM(B), when B does not yet exist, then A is queryable with status "suspended". When B arrives, A becomes active.

**AC5** [R6]: Given action A declared with AFTER(B), when B is recorded at step N, then A is not active at step N and is active at step N+1 or later.

**AC6** [R7]: Given action A terminates due to condition C breaking, when the termination signal is inspected, then it contains A's identifier and C as the cause.

**AC7** [R9, R10]: Given a pipeline where A PREDICTS B and B YIELDS C, when A completes, then B starts (at the next step), and when B produces output, then C starts.

**AC8** [R11]: Given outer action O with liveness condition L, and inner action I whose liveness depends on O being active, when L breaks, then both O and I terminate and both produce termination signals.

## Open Questions

1. How are all 13 Allen's interval algebra relations mapped to compositions of the four primitives? The spec covers PREDICTS and YIELDS but leaves OVERLAPS, MEETS, DURING, STARTS, FINISHES, and their inverses as an exercise.
2. What happens when an AFTER action's trigger B is recorded and then retracted (if retraction were supported)? Does the action that already activated need to be unwound?
