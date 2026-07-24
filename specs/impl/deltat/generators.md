# Temporal Generators

## Original Notes

Basically cron expressions.

They should be used like:

FOR EACH (X FROM | AFTER Y) UPTO (OTHER_CLAIM) { // BLOCK }
OR
FOR EACH (X FROM | AFTER Y) { // BLOCK }

The difference between the two being the cancel claim.

---

Generators are recurring temporal patterns -- cron-like schedules expressed through the same temporal operators (FROM, AFTER, UPTO) used for one-shot event patterns. There is no dedicated cron subsystem. A generator is a liveness-guarded binding that re-fires on clock ticks.

The two forms from the user's notes map directly: bounded generators have an UPTO cancel claim and stop when it appears; unbounded generators run indefinitely. Activation uses FROM (fire at the same instant the trigger occurs) or AFTER (fire strictly after the trigger, not at the same instant). Each firing is independent -- one firing's failure does not prevent subsequent firings.

The hard part is the clock source. The system is event-driven (things happen when state changes), but generators need to fire even when nothing else is happening. This implies a background tick source that advances independently of user activity. The generator pattern treats these ticks as observations that trigger the next firing.

## The Generator Type

A generator has a status, a firing interval, and observable metadata. The status lifecycle mirrors temporal operators: suspended (waiting for activation), active (firing), stopped (cancelled):

```ft
Generator = {
  interval: number >= 0,
  status: "suspended" | "active" | "stopped",
  runCount: number.integer >= 0,
  lastRun: number >= 0
}
```

`runCount` only increases -- it never resets unless the generator is re-declared. `lastRun` is the timestamp of the most recent firing. `status` is derived from the activation and liveness conditions, not set directly.

## Activation Modes

A generator activated with FROM fires at the same logical step its trigger occurs. A generator activated with AFTER fires only at the next interval after the trigger:

```ft
generatorFrom = Generator
generatorFrom << { interval = 30, status = "suspended" }
generatorFrom << { status = "active" when systemReady EXISTS }

generatorAfter = Generator
generatorAfter << { interval = 30, status = "suspended" }
generatorAfter << { status = "active" when systemReady EXISTS }
```

The structural types are identical. The difference between FROM and AFTER is a scheduling constraint: FROM permits the first firing at the same step `systemReady` appears; AFTER requires at least one interval to pass after `systemReady` before the first firing. This is the same strict-after distinction from event patterns, enforced by the scheduler.

## Termination Modes

An unbounded generator has no cancel claim. It fires at every interval indefinitely:

```ft
unboundedGen = Generator
unboundedGen << { interval = 10, status = "active" when trigger EXISTS }
```

A bounded generator terminates when its cancel claim appears. Termination produces an explicit signal and prevents all future firings:

```ft
boundedGen = Generator
boundedGen << { interval = 10, status = "active" when trigger EXISTS }
boundedGen << { status = "stopped" when shutdownRequested EXISTS }
```

When `shutdownRequested` appears, status becomes "stopped". No further firings occur. The "stopped" signal is readable by other processes. A stopped generator cannot re-activate without being explicitly re-declared.

## Independent Firings

Each firing is an independent execution. If firing N fails, firing N+1 still executes. The generator tracks all firings regardless of success or failure:

```ft
-- After each firing, metadata updates via prev
boundedGen << { runCount = prev.runCount + 1, lastRun = _rt }
```

The `runCount` accumulates through `prev` -- the same mechanism used in flux.md for rolling sums. Errors from individual firings are recorded but do not halt the generator.

## Composing with Other Patterns

A generator can be the action inside another temporal operator. This enables patterns like "run this every 10 seconds, but only while the server is healthy":

```ft
healthGatedGen = Generator
healthGatedGen << { interval = 10, status = "active" when trigger EXISTS }
healthGatedGen << { status = "stopped" while serverHealth = "healthy" }
```

When `serverHealth` changes away from "healthy", the `while` breaks and the generator stops. This is the same nesting mechanism from event patterns -- no special composition logic for generators.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Fixed-interval firing | `Generator.interval` controls firing frequency |
| FROM activation: fires at same step | FROM semantics on activation `when` gate |
| AFTER activation: fires after next interval | AFTER semantics (scheduler-enforced strict ordering) |
| Bounded: stops on cancel claim | `status = "stopped" when shutdownRequested EXISTS` |
| Unbounded: runs indefinitely | No cancel claim; generator keeps firing |
| Independent firings: failure doesn't halt | `runCount = prev.runCount + 1` regardless of success/failure |
| Observable metadata | `runCount`, `lastRun`, `status` queryable at any time |
| No re-activation after cancellation | "stopped" is terminal; requires re-declaration |
