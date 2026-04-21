# System Monitoring

## Problem Context

- **Actor(s)**: A system producing metrics, alert rules defining thresholds and conditions, and operators who need to see current health status and alert history.
- **Domain**: Runtime health monitoring -- detecting threshold violations, managing alert lifecycle, and providing observability into system health.
- **Core Tension**: Simple threshold alerts flap when metrics oscillate near boundaries. Composite conditions (multiple metrics must be bad simultaneously) add complexity. Alert rules need to be added, removed, and inspected at runtime. And all of this must be transparent -- the operator should be able to see every active rule and its current evaluation at any time.

## Requirements

**R1**: A health condition SHALL define a threshold, a comparison direction (above or below), and a reference to the metric it monitors.
- *Rationale*: These are the minimum attributes needed to evaluate a single-metric health check.
- *Verifiable by*: A health condition can be created with a metric reference, threshold, and direction, and it evaluates correctly against metric values.

**R2**: A health condition SHALL re-evaluate automatically whenever its monitored metric changes.
- *Rationale*: Manual re-evaluation would miss violations between checks.
- *Verifiable by*: Updating a metric value immediately changes the health condition's evaluation result.

**R3**: When a health condition is violated (metric crosses the threshold in the wrong direction), the violation SHALL surface as an observable event.
- *Rationale*: Violations are the primary signal that something needs attention.
- *Verifiable by*: A metric crossing a threshold causes the health condition to report unhealthy status, visible in the system's state.

**R4**: Hysteresis alerts SHALL use separate activation and deactivation thresholds to prevent flapping.
- *Rationale*: A single threshold causes rapid on/off cycling when a metric oscillates near the boundary.
- *Verifiable by*: An alert with activateAt=80 and deactivateAt=60 activates when the metric reaches 85, stays active at 70, and deactivates only when the metric drops to 55.

**R5**: A composite alert SHALL fire only when all of its constituent conditions are simultaneously true.
- *Rationale*: Some problems are only real when multiple metrics are bad at once (e.g., high CPU AND high memory).
- *Verifiable by*: A composite of CPU and memory conditions fires only when both are violated, not when only one is.

**R6**: When any constituent condition of a composite alert clears, the composite alert SHALL stop firing.
- *Rationale*: If one of the contributing problems resolves, the composite condition no longer holds.
- *Verifiable by*: A firing composite alert stops firing when one of its conditions returns to healthy.

**R7**: Alert activations and clearances SHALL be recorded with timestamps in an append-only history.
- *Rationale*: Post-incident analysis requires knowing when alerts activated and cleared.
- *Verifiable by*: After an alert activates and later clears, the history contains two entries with the activation and clearance timestamps.

**R8**: Alert rules SHALL be addable at runtime, with immediate evaluation against current metric values.
- *Rationale*: Operators need to add monitoring without restarting the system. A new rule should detect pre-existing violations.
- *Verifiable by*: Adding a rule whose threshold is already violated causes the alert to fire immediately.

**R9**: Alert rules SHALL be removable at runtime, with no stale alerts persisting after removal.
- *Rationale*: Removed rules should not leave phantom alerts.
- *Verifiable by*: After removing a rule, its alert is no longer firing and does not appear in the active alerts.

**R10**: Derived metrics SHALL be supported -- metrics computed from raw observations (e.g., rate of change, delta per interval).
- *Rationale*: Many meaningful health conditions are based on transformed metrics, not raw values.
- *Verifiable by*: A derived metric configured as "delta per interval" of a raw counter produces the difference between consecutive readings.

**R11**: Thresholds on derived metrics SHALL work identically to thresholds on raw metrics.
- *Rationale*: The health condition system should not distinguish between raw and derived sources.
- *Verifiable by*: A health condition on a derived metric fires when the derived value crosses the threshold.

**R12**: All monitoring rules, their current evaluation status, and their configuration SHALL be inspectable at any time.
- *Rationale*: Operators need a dashboard view of what is being monitored and what the current status is.
- *Verifiable by*: Querying the monitoring state returns every active rule with its current healthy/firing status.

## Acceptance Criteria

**AC1** [R1, R2]: Given a health condition on "response_time_ms" with threshold 500 and direction "below", when the metric is updated to 200, then the condition reports healthy. When updated to 650, then it reports unhealthy.

**AC2** [R3]: Given a health condition that transitions from healthy to unhealthy, when the violation occurs, then an observable event surfaces.

**AC3** [R4]: Given a hysteresis alert with activateAt=80 and deactivateAt=60, when the metric sequence is [50, 85, 70, 55], then the alert is [inactive, active, active, inactive].

**AC4** [R5, R6]: Given a composite alert of CPU and memory conditions, when CPU is violated but memory is healthy, then the composite does not fire. When both are violated, then it fires. When CPU clears, then it stops.

**AC5** [R7]: Given an alert that activates at t=1000 and clears at t=5000, then the history contains entries for both events with their timestamps.

**AC6** [R8]: Given current disk usage of 95%, when a new rule with activateAt=90 is added, then the alert fires immediately.

**AC7** [R9]: Given an active alert on "diskAlert", when the rule is removed, then "diskAlert" no longer appears in active alerts.

**AC8** [R10, R11]: Given a raw counter that increases by 50, when a derived "delta_per_interval" metric is computed, then its value is 50. When a health condition on this derived metric has threshold 100 and direction "below", then the condition is healthy.

**AC9** [R12]: Given three active monitoring rules, when the monitoring state is queried, then all three rules appear with their current evaluation status.
