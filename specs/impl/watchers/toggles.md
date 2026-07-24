# Toggles

## Original Notes

From conversation audit: `once(ref('./aboveValueThreshold')).until(ref('./belowValueThreshold')) { alarm = raise() } then { delete alarm }`

---

A value oscillates around a single threshold. The alarm fires, clears, fires, clears -- flapping. Hysteresis solves this: activate at one threshold, deactivate at a different (lower) one. The value can wander inside the band without triggering state changes.

Traditional implementations track toggle state with a separate state machine per monitored value. That duplicates the constraint system. The right answer: activation is a conditional write, the lifetime is a sustained condition (`while`), and deactivation is the condition breaking with a follow-up action (`onBreak`). One declarative rule. No state machine.

The toggle is also one-shot. After it activates and then deactivates, it is consumed. Re-arming requires a new declaration. This prevents surprise re-triggers.

## The Toggle Type

A toggle has activation and deactivation thresholds, the monitored value, and the resulting state:

```ft
Toggle = {
  activateAt: number,
  deactivateAt: number,
  value: number,
  alarm: boolean,
  cleared: boolean
}
```

The activation condition is `value >= activateAt`. The deactivation condition is `value < deactivateAt`. These are separate thresholds -- that is the hysteresis. The toggle activates when the activation condition transitions from false to true (the "once" semantic), and remains active while `value >= deactivateAt`.

## Activation

The toggle starts inactive. When the monitored value crosses the activation threshold, the alarm binds:

```ft
toggle = Toggle
toggle << { activateAt: 100, deactivateAt: 50, value: 30 }

-- value below activation: no alarm
-- value crosses activation threshold
toggle << { value: 120 }
toggle << { alarm: true when toggle.value >= 100 }
```

The `when toggle.value >= 100` gate passes at value 120. The alarm is bound.

## Hysteresis Band

Once active, the alarm persists even when the value drops below the activation threshold, as long as it stays above the deactivation threshold:

```ft
-- value drops into hysteresis band (50-100)
toggle << { value: 75 }
-- alarm remains true: 75 >= deactivateAt (50)
```

No flapping. The value can oscillate between 50 and 100 without the alarm toggling.

## Deactivation

When the value drops below the deactivation threshold, the alarm clears and a signal is produced:

```ft
toggle << { value: 40 }
-- 40 < deactivateAt (50): alarm deactivates
delete toggle.alarm
toggle << { cleared: true }
```

The alarm is removed and a cleared signal confirms deactivation. The behavioral rule for this -- alarm is sustained `while value >= deactivateAt`, with `onBreak` removing the alarm and setting cleared -- is expressed in prose because the parser does not support onBreak syntax. The ft blocks show the resulting state transitions.

## One-Shot Consumption

After deactivation, the toggle is consumed. The value crossing the activation threshold again does NOT re-trigger:

```ft
-- value rises again past activation
toggle << { value: 130 }
-- original toggle does NOT re-activate: it is consumed
-- to re-arm, declare a new toggle
```

Re-arming is explicit. A new toggle declaration is required.

## Multi-Condition Toggles

Activation can require multiple conditions (conjunction). Deactivation occurs when any condition fails:

```ft
MultiToggle = {
  temperature: number,
  pressure: number,
  alarm: boolean,
  cleared: boolean
}

multiToggle = MultiToggle
multiToggle << { temperature: 210, pressure: 400 }
-- no alarm: pressure < 500

multiToggle << { pressure: 550 }
multiToggle << { alarm: true when multiToggle.temperature >= 200 }
-- alarm activates: both conditions now met (temp >= 200 AND pressure >= 500)
```

The conjunction -- alarm requires BOTH temperature >= 200 AND pressure >= 500 -- is a behavioral predicate. In ft, we express the individual gates; the conjunction logic is: the alarm binds only when all activation conditions are simultaneously true, and deactivates when any lifetime condition fails.

## Capabilities

The monitored value is externally provided:

```ft
cap toggle.value
cap multiToggle.temperature
cap multiToggle.pressure
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| No activation below threshold | `value: 30` -- below activateAt (100), no alarm |
| Activates on crossing threshold | `value: 120` with `when toggle.value >= 100` |
| Stays active in hysteresis band | `value: 75` -- above deactivateAt (50), alarm persists |
| Deactivates below deactivation threshold | `value: 40` -- below 50, alarm removed, cleared set |
| No flapping in band | Value oscillates 50-100 without alarm change |
| One-shot: no re-activation after consumed | `value: 130` after deactivation does not re-trigger |
| Multi-condition conjunction | Both temperature >= 200 AND pressure >= 500 required |
| Deactivation on any condition failure | Pressure drops below 500 kills the alarm |
