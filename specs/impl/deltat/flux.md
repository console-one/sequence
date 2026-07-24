# Flux -- Expected Type Shift Over Delta T

## Original Notes

### FLUX

- Is the shift we expect for some type's API constract, or internal implementation IF computed over delta T

- For example, you can maitain a rolling time-wise sum by:

Modelling a blocks memory as:

// how the f*** do we use type semantics to model tail eviction !?!?!?

[
  ${PATCH}
  sum = ${'./prev'} + diff(${./push}, ${'self WHERE REALTIME === '})['computepath']
]

^---- THIS SYNTAX (GETTING IT CORRECT, IS SUPER IMPORTANT AND TOTALLY DONE HORRIBLY CURRENTLY)

---

Flux is how types shift when the same path receives multiple values over time. The system is append-only, but the user needs accumulation (adding to previous values) and eviction (removing old contributions after a time window). These are not mutations -- they are new statements that reference previous state.

The core mechanism is `prev`. A path's value can reference its own previous value: `sum = prev + delta`. This is not a transition policy or a special accumulation mode. It is a regular assignment where the right-hand side references the path's prior state. The append-only log grows: each new statement is a new entry that happens to compute from the previous one.

Time-windowed contributions are values that self-invalidate after a duration. They are modeled as `while` conditions on time: the value lives only while the clock is within the window. When the window closes, the `while` breaks, the value disappears, and anything derived from it recomputes. Eviction produces an explicit signal -- values do not silently vanish.

## Accumulation via Prev

A rolling sum is a path whose value is always "previous value plus the new delta." Each new contribution adds to what was there before:

```ft
RollingMetric = {
  total: number >= 0,
  lastDelta: number,
  updateCount: number.integer >= 0
}
```

When a new value arrives, the total accumulates:

```ft
metric = RollingMetric
metric << { total = 0, updateCount = 0 }

-- Each new contribution adds to the total
metric << { total = prev.total + 5, lastDelta = 5, updateCount = prev.updateCount + 1 }
metric << { total = prev.total + 3, lastDelta = 3, updateCount = prev.updateCount + 1 }
metric << { total = prev.total + 12, lastDelta = 12, updateCount = prev.updateCount + 1 }
```

After three contributions: `total = 20`, `updateCount = 3`, `lastDelta = 12`. Each statement is a new entry in the append-only log. Nothing is mutated. The `prev` reference reads the value as it was before this statement was applied.

Subtraction works the same way: `total = prev.total + (-7)`. The system does not care whether the delta is positive or negative -- it is just arithmetic on `prev`.

## Delta Computation

The difference between current and previous values is always available through `prev`:

```ft
sensor = {
  temperature: number,
  delta: number
}

sensor << { temperature = 75, delta = 75 - prev.temperature }
```

After updating temperature from 72 to 75, `delta = 3`. This is not a special "diff" operation -- it is regular arithmetic referencing `prev`.

## Time-Windowed Contributions

A value that expires after a duration is modeled as a `while` condition on time. The value exists only while the current time is within the window:

```ft
WindowedEntry = {
  value: number,
  contributedAt: number >= 0,
  windowDuration: number >= 0
}
```

The liveness condition is a predicate on the clock. When the window closes, the `while` breaks and the value is removed from projection. This is the same `while` mechanism used in event patterns -- no special eviction subsystem.

Eviction is never silent. When a windowed entry expires, the break produces a signal (consistent with the event pattern principle that all terminations are visible):

```ft
windowedEntry1 = WindowedEntry
windowedEntry1 << { value = 10, contributedAt = 100, windowDuration = 60 }
```

The entry is live from `contributedAt` (100) through `contributedAt + windowDuration` (160). After time 160, the entry's value is removed from any derived computation that references it.

## Windowed Aggregation

A rolling windowed sum is a derived value over the set of active windowed entries. When an entry expires, the sum automatically recomputes:

```ft
WindowedSum = {
  activeCount: number.integer >= 0,
  total: number
}
```

The sum is derived -- not manually maintained. When three entries are active with values 10, 20, 30, the total is 60. When the oldest expires (value 10), the total becomes 50 automatically. The `activeCount` drops from 3 to 2. No manual refresh is needed.

In the append-only log, eviction is recorded as an invalidation entry -- the original contribution still exists in the log, but a new entry marks it as expired. Nothing is deleted. The log only grows. Compaction (collapsing expired entries) is a separate concern handled by the general state management layer, not by the flux mechanism itself.

## Observable Metric State

The full state of a rolling metric is queryable: current aggregate, number of active contributions, and per-entry time remaining:

```ft
MetricState = {
  aggregate: number,
  activeEntries: number.integer >= 0,
  oldestExpiry: number >= 0,
  newestExpiry: number >= 0
}

tool metric.total
tool metric.updateCount
```

The user sees not just the final number but how it is composed. They can inspect individual entries, see their remaining windows, and understand why the aggregate changes.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Additive accumulation: 5 + 3 + 12 = 20 | `total = prev.total + delta` pattern across three contributions |
| Multiplicative accumulation | Same pattern: `total = prev.total * factor` |
| Time-windowed eviction with signal | `WindowedEntry` with `while` on time; break produces signal |
| Derived sum recomputes on eviction | `WindowedSum` automatically adjusts when entries expire |
| Previous value reference for delta | `delta = current - prev.temperature` via `prev` |
| Append-only: no mutation | Each contribution is a new log entry; eviction is an invalidation record |
| Observable metric state | `MetricState` exposes aggregate, count, and expiry information |
