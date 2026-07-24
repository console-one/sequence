# System Monitoring

Monitoring should not be a separate infrastructure bolted alongside the system it watches. Alert conditions are type constraints on observable state. A threshold violation is a gap -- the system expected a value within bounds and got one outside. Alerts are visible obligations in the system's own state, not messages fired into an external channel.

There are no separate monitoring rules. There is only typed state and conditions on that state.

## The Health Condition

A health condition is a typed constraint on a metric. It declares a threshold and the metric it watches:

```ft
HealthCondition = {
  metric: string,
  threshold: number,
  direction: "below" | "above",
  currentValue: number,
  healthy: boolean
}
```

When a metric violates its condition, `healthy` becomes false. This is not a callback -- it is a predicate on the relationship between `currentValue` and `threshold`.

An instance:

```ft
responseTimeCheck = HealthCondition
responseTimeCheck << {
  metric: "response_time_ms",
  threshold: 500,
  direction: "below"
}
```

-- Health evaluation (prose): healthy = true when currentValue is below threshold (for direction "below") or above threshold (for direction "above"). This re-evaluates whenever currentValue changes. When healthy becomes false, a gap surfaces -- the constraint is violated and the violation is visible in obligations.

## Metric Updates

Metrics arrive as value mounts. Each update re-evaluates the health condition:

```ft
responseTimeCheck << { currentValue: 200 }
```

The check is healthy (200 < 500). A later update:

```ft
responseTimeCheck << { currentValue: 650 }
```

Now the check is unhealthy (650 > 500). The violation surfaces as a gap.

## Hysteresis

Simple threshold alerts flap when values oscillate near the boundary. Hysteresis uses separate activation and deactivation thresholds:

```ft
HysteresisAlert = {
  metric: string,
  activateAt: number,
  deactivateAt: number,
  currentValue: number,
  alertActive: boolean
}
```

```ft
cpuAlert = HysteresisAlert
cpuAlert << {
  metric: "cpu_percent",
  activateAt: 80,
  deactivateAt: 60
}
```

-- Hysteresis behavior (prose): alertActive becomes true when currentValue crosses activateAt (e.g., goes above 80). Once active, it remains active until currentValue crosses deactivateAt (e.g., drops below 60). Values between 60 and 80 do not change the alert state. This prevents flapping when the value oscillates near a single threshold.

The lifecycle:

```ft
cpuAlert << { currentValue: 50 }
-- alertActive remains false (below activateAt)
```

```ft
cpuAlert << { currentValue: 85 }
-- alertActive becomes true (crossed activateAt)
```

```ft
cpuAlert << { currentValue: 70 }
-- alertActive stays true (above deactivateAt, hysteresis holds)
```

```ft
cpuAlert << { currentValue: 55 }
-- alertActive becomes false (crossed deactivateAt)
```

## Composite Conditions

Multiple conditions compose via conjunction. A composite alert fires only when all its constituent conditions are true:

```ft
compositeAlert = {
  cpuCondition: boolean,
  memoryCondition: boolean,
  firing: boolean
}
```

```ft
compositeAlert << { cpuCondition: true, memoryCondition: false, firing: false }
```

-- Composite evaluation (prose): firing = true only when cpuCondition AND memoryCondition are both true. When either clears, firing becomes false. This extends to any number of conditions. The conjunction is a derived predicate, not a separate check loop.

When both conditions are met:

```ft
compositeAlert << { cpuCondition: true, memoryCondition: true, firing: true }
```

## Alert History

Activations and clearances are recorded with timestamps for audit:

```ft
AlertEvent = {
  alertId: string,
  eventType: "activated" | "cleared",
  timestamp: number
}
```

```ft
alertHistory = {
  event1: AlertEvent,
  event2: AlertEvent
}
```

```ft
alertHistory << {
  event1: { alertId: "cpuAlert", eventType: "activated", timestamp: 1000 },
  event2: { alertId: "cpuAlert", eventType: "cleared", timestamp: 5000 }
}
```

The history is append-only. Each activation and clearance produces a new entry. Past incidents are reviewable with timestamps.

## Runtime Rule Management

Alert rules are addable and removable at runtime. Adding a new rule begins monitoring immediately against current state:

```ft
diskAlert = HysteresisAlert
diskAlert << {
  metric: "disk_usage_percent",
  activateAt: 90,
  deactivateAt: 75
}
```

If the current disk usage is already above 90%, the alert fires immediately upon creation. Removing the rule (deleting the alert instance) stops monitoring -- no stale alerts persist.

```ft
delete diskAlert
```

## Derived Metrics

Raw metrics sometimes need transformation before thresholds apply. A derived metric computes a value from raw observations:

```ft
DerivedMetric = {
  sourceMetric: string,
  computation: string,
  currentValue: number
}
```

```ft
requestRate = DerivedMetric
requestRate << {
  sourceMetric: "request_count",
  computation: "delta_per_interval"
}
```

-- Derived metric recomputation (prose): When the source metric changes, the derived metric recomputes automatically. For "delta_per_interval", the derived value is the difference between the current and previous source readings. Thresholds on derived metrics work identically to thresholds on raw metrics.

```ft
requestRate << { currentValue: 50 }
```

A health condition can reference the derived metric:

```ft
rateCheck = HealthCondition
rateCheck << {
  metric: "request_rate",
  threshold: 100,
  direction: "below"
}
```

## Monitoring State Inspection

All monitoring state is inspectable. A query returns every active rule and its current evaluation:

```ft
monitoringState = {
  responseTimeCheck: HealthCondition,
  cpuAlert: HysteresisAlert,
  rateCheck: HealthCondition
}
```

Each entry carries its current healthy/alertActive status. The user can see which conditions are healthy, which are in violation, and which alerts are firing -- all from the same state surface.

## Capabilities

The externally-provided operations: updating metric values and managing alert rules:

```ft
tool HealthCondition.currentValue
tool HysteresisAlert.currentValue
tool DerivedMetric.currentValue
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Health condition readable with threshold and metric (AC1) | `responseTimeCheck << { metric: "response_time_ms", threshold: 500, direction: "below" }` |
| Violation surfaces as gap (AC2) | healthy becomes false when currentValue exceeds threshold; gap appears |
| Hysteresis: activate/hold/clear cycle (AC3) | HysteresisAlert with activateAt: 80, deactivateAt: 60; four-step lifecycle |
| Composite alert fires only when all conditions met (AC4) | compositeAlert.firing = cpuCondition AND memoryCondition |
| Alert history records activations and clearances (AC5) | AlertEvent entries with alertId, eventType, timestamp |
| Runtime rule addition begins monitoring immediately (AC6) | `diskAlert = HysteresisAlert` with immediate evaluation against current state |
| Derived metric recomputes on source change (AC7) | DerivedMetric with delta_per_interval; threshold on derived value |
| All rules and statuses inspectable (AC8) | monitoringState contains all active rules with current evaluation |
