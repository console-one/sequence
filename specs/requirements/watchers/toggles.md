# Toggles

## Original Notes

From conversation audit: `once(ref('./aboveValueThreshold')).until(ref('./belowValueThreshold')) { alarm = raise() } then { delete alarm }`

---

## Problem Context

- **Actor(s)**: A monitored value (oscillates around thresholds), an alarm (activates/deactivates based on the value), consumers (observe alarm state)
- **Domain**: Hysteresis-based threshold monitoring -- preventing flapping (rapid activate/deactivate cycles) when a value oscillates around a single threshold by using separate activation and deactivation thresholds
- **Core Tension**: A single threshold causes flapping when values oscillate near it. Hysteresis (a dead band between activation and deactivation thresholds) solves this but introduces complexity: the alarm's behavior depends on both its current state and the relationship between value and two thresholds. Additionally, the toggle must be one-shot (consumed after deactivation) to prevent surprise re-triggers.

## Requirements

**R1**: A toggle SHALL have separate activation and deactivation thresholds, where the deactivation threshold is less than the activation threshold.
- *Rationale*: The gap between thresholds is the hysteresis band that prevents flapping.
- *Verifiable by*: Configuring a toggle with activateAt=100 and deactivateAt=50 and confirming both are stored.

**R2**: When the monitored value crosses the activation threshold (from below to at-or-above), the alarm SHALL activate.
- *Rationale*: Activation is triggered by the "rising edge" -- crossing the upper threshold.
- *Verifiable by*: Setting value from 30 to 120 (above activateAt=100) and confirming the alarm activates.

**R3**: When the monitored value is below the activation threshold, the alarm SHALL NOT activate.
- *Rationale*: Values below the activation threshold must not trigger the alarm.
- *Verifiable by*: Setting value to 80 (below activateAt=100) and confirming no alarm.

**R4**: Once active, the alarm SHALL remain active as long as the monitored value stays at or above the deactivation threshold, even if it drops below the activation threshold.
- *Rationale*: This is the hysteresis behavior. The dead band between deactivateAt and activateAt is the no-flap zone.
- *Verifiable by*: Alarm active at value 120, value drops to 75 (below activateAt=100 but above deactivateAt=50), alarm remains active.

**R5**: The alarm SHALL deactivate when the monitored value drops below the deactivation threshold.
- *Rationale*: Deactivation requires crossing the lower threshold, not just dropping below the upper one.
- *Verifiable by*: Value drops to 40 (below deactivateAt=50) and alarm deactivates.

**R6**: Upon deactivation, the system SHALL produce a cleared signal confirming the alarm is no longer active.
- *Rationale*: Consumers need explicit confirmation that the alarm state has changed.
- *Verifiable by*: After deactivation, a cleared signal is observable.

**R7**: After deactivation, the toggle SHALL be consumed (one-shot). The monitored value crossing the activation threshold again SHALL NOT re-activate the alarm.
- *Rationale*: One-shot behavior prevents surprise re-triggers. Re-arming must be an explicit action.
- *Verifiable by*: After deactivation, value rises to 130 (above activateAt=100) and the alarm does NOT activate.

**R8**: Re-arming the toggle SHALL require a new explicit declaration.
- *Rationale*: Intentional re-arming prevents accidental or unexpected alarm cycles.
- *Verifiable by*: After consumption, creating a new toggle and confirming it can activate normally.

**R9**: A toggle SHALL support multi-condition activation where the alarm requires ALL conditions to be simultaneously true (conjunction).
- *Rationale*: Real-world alarms often depend on multiple inputs (e.g., temperature AND pressure).
- *Verifiable by*: A toggle requiring temperature >= 200 AND pressure >= 500; alarm does not activate when only one condition is met.

**R10**: For a multi-condition toggle, deactivation SHALL occur when ANY one of the conditions fails.
- *Rationale*: If any condition leaves the safe range, the alarm should clear.
- *Verifiable by*: Both conditions met, alarm active; pressure drops below threshold; alarm deactivates even though temperature is still above its threshold.

**R11**: The value SHALL be allowed to oscillate within the hysteresis band (between deactivation and activation thresholds) without causing any alarm state change.
- *Rationale*: This is the core anti-flapping guarantee.
- *Verifiable by*: Alarm active, value oscillates between 60 and 90 (within band of 50-100), alarm state does not change.

## Acceptance Criteria

**AC1** [R3]: Given a toggle with activateAt=100 and deactivateAt=50, when value is set to 30, then no alarm is active.

**AC2** [R2]: Given the same toggle, when value changes to 120, then the alarm activates.

**AC3** [R4, R11]: Given an active alarm, when value drops to 75 (within hysteresis band), then the alarm remains active.

**AC4** [R5, R6]: Given an active alarm, when value drops to 40 (below deactivateAt=50), then the alarm deactivates and a cleared signal is produced.

**AC5** [R11]: Given an active alarm, when value oscillates between 60 and 90, then the alarm state does not change.

**AC6** [R7]: Given a consumed toggle (after deactivation), when value rises to 130, then the alarm does NOT re-activate.

**AC7** [R9]: Given a multi-condition toggle requiring temperature >= 200 AND pressure >= 500, when temperature=210 and pressure=400, then no alarm activates. When pressure rises to 550 (both conditions met), then the alarm activates.

**AC8** [R10]: Given an active multi-condition alarm, when pressure drops below 500 (one condition fails), then the alarm deactivates even though temperature remains above 200.

## Open Questions

- Should there be a recurring (non-one-shot) toggle variant, or must all toggles be explicitly re-armed?
- Can thresholds be derived/dynamic values, or must they be fixed at declaration time?
- For multi-condition toggles, should deactivation thresholds be independently configurable per condition?
