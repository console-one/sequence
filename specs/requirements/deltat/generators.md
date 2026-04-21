# Temporal Generators

## Original Notes

Basically cron expressions.

They should be used like:

FOR EACH (X FROM | AFTER Y) UPTO (OTHER_CLAIM) { // BLOCK }
OR
FOR EACH (X FROM | AFTER Y) { // BLOCK }

The difference between the two being the cancel claim.

---

## Problem Context

- **Actor(s)**: Process authors (who define recurring schedules), the scheduler (which fires generators at intervals), the clock source (which provides ticks independent of user activity).
- **Domain**: Recurring temporal execution -- cron-like schedules that fire actions at fixed intervals, with control over activation, cancellation, and composition with other temporal patterns.
- **Core Tension**: The system is event-driven (things happen when state changes), but generators must fire even when nothing else is happening. This requires a background clock source. Additionally, individual firing failures must not halt the entire schedule.

## Requirements

**R1**: The system SHALL support fixed-interval recurring execution (generators), analogous to cron expressions.
- *Rationale*: Many real-world processes require periodic execution (polling, health checks, metric collection) independent of external events.
- *Verifiable by*: A generator configured with a 10-second interval fires its action approximately every 10 seconds.

**R2**: A generator SHALL have one of two forms: bounded (with a cancel condition that stops the generator) or unbounded (runs indefinitely).
- *Rationale*: The original notes define exactly these two forms: `FOR EACH ... UPTO (cancel)` and `FOR EACH ...` without a cancel.
- *Verifiable by*: A bounded generator stops when its cancel condition is met. An unbounded generator continues until explicitly re-declared or the system shuts down.

**R3**: A generator SHALL support two activation modes: FROM (fires at the same logical step its trigger occurs) and AFTER (fires only after the trigger, not at the same instant).
- *Rationale*: The original notes specify `FROM | AFTER` as the activation choice. These have the same semantics as in event patterns.
- *Verifiable by*: A FROM-activated generator fires at the step its trigger appears. An AFTER-activated generator fires at the next interval after the trigger.

**R4**: A generator's status SHALL have three states: suspended (waiting for activation trigger), active (firing at intervals), and stopped (cancelled or terminated).
- *Rationale*: Status must be queryable at any time for monitoring and debugging.
- *Verifiable by*: Before the trigger, status is "suspended". After the trigger and before cancellation, status is "active". After cancellation, status is "stopped".

**R5**: Generator status SHALL be derived from the activation and cancellation conditions, not set directly.
- *Rationale*: Status is an observable consequence of conditions being met, not an independently mutable field.
- *Verifiable by*: Setting the activation condition to met causes status to transition to "active" without any direct status assignment.

**R6**: Each firing SHALL be independent: failure of one firing SHALL NOT prevent subsequent firings.
- *Rationale*: A generator polling a health endpoint must continue even if one check times out.
- *Verifiable by*: After firing N fails (throws an error, times out, etc.), firing N+1 still executes at the next interval.

**R7**: A generator SHALL track observable metadata: run count (monotonically increasing) and the timestamp of the most recent firing.
- *Rationale*: Operators need to verify that generators are running and to audit their execution history.
- *Verifiable by*: After 5 firings, run count = 5 and last-run timestamp is approximately the time of the 5th firing.

**R8**: When a bounded generator's cancel condition is met, the generator SHALL stop permanently. It SHALL NOT re-activate without being explicitly re-declared.
- *Rationale*: A cancelled generator is done. Accidental re-activation would violate the user's intent.
- *Verifiable by*: After a cancel condition fires, no further firings occur even if the cancel condition later becomes unmet.

**R9**: When a generator stops (via cancellation or system shutdown), it SHALL produce an explicit termination signal.
- *Rationale*: Consistent with the event patterns requirement that termination is never silent.
- *Verifiable by*: After a bounded generator's cancel condition fires, a termination signal is produced and is queryable by other processes.

**R10**: A generator SHALL be composable with other temporal patterns: a generator's liveness MAY be conditioned on an external state.
- *Rationale*: Patterns like "run this every 10 seconds, but only while the server is healthy" combine generators with liveness conditions.
- *Verifiable by*: A generator with a health-check liveness condition stops firing when the health state becomes unhealthy and does not resume.

**R11**: A background clock source SHALL advance independently of user activity, enabling generators to fire during periods of no external events.
- *Rationale*: An event-driven system with no background tick cannot fire generators during idle periods.
- *Verifiable by*: With no user activity for 60 seconds, a 10-second-interval generator has fired approximately 6 times.

## Acceptance Criteria

**AC1** [R1, R2]: Given an unbounded generator with a 10-second interval activated by trigger T, when T occurs and 35 seconds elapse, then the generator has fired approximately 3 times and is still active.

**AC2** [R2, R8]: Given a bounded generator with cancel condition C, when C is met after 5 firings, then exactly 5 firings occurred, the generator's status is "stopped", and no further firings occur.

**AC3** [R3]: Given two generators activated by the same trigger T at step N -- one with FROM semantics and one with AFTER semantics -- when T occurs, then the FROM generator's first firing is at step N and the AFTER generator's first firing is at the next interval after step N.

**AC4** [R6]: Given a generator whose 3rd firing fails with an error, when the 4th interval arrives, then the 4th firing executes normally and run count = 4.

**AC5** [R7]: Given a generator that has fired 10 times, when querying its metadata, then run count = 10 and last-run timestamp is approximately the time of the 10th firing.

**AC6** [R9, R10]: Given a generator whose liveness is conditioned on server health = "healthy", when health changes to "unhealthy", then the generator stops, a termination signal is produced, and no further firings occur.

## Open Questions

1. What is the minimum supported interval? Is there a floor below which the system refuses to create a generator (to prevent resource exhaustion)?
2. How does the background clock source interact with system pause/resume or sleep states? Do generators "catch up" on missed firings or skip them?
3. Should a generator support variable intervals (e.g., exponential backoff) or only fixed intervals?
