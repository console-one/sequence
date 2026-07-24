# Interpolations -- Contingent Patches on State

## Original Notes

We can take two events:

(ASSUME/RUN Y)
  FROM START OF PATTERN-LIKE-OBSERVATION1 UPTO END OF PATTERN-LIKE-OBSERVATION2
  UNLESS (EVENT-OBSERVATION) OR (PATTERN-LIKE-OBSERVATION3 PREMPTS PATTERN-LIKE-OBSERVATION1)

THAT BASICALLY MOUNTS A CONTIGENT PATCH ON THE STATE IN A WHERE BLOCK FOR THE INVERSION OF THE CLAUSE

---

Interpolations are speculative state -- values mounted conditionally that self-invalidate when their assumptions break. The system often cannot wait for complete information before proceeding. It assumes intermediate values ("the user is probably a standard user") and acts on them, while maintaining the ability to cleanly retract when reality diverges.

An assumption has three phases: suspended (waiting for activation), active (the assumed value is in force and marked as provisional), and invalidated (the assumption broke and the path reverts to a gap). The UNLESS clause defines the inversion boundary -- the exact conditions under which the assumption dies. Any single UNLESS condition breaking is sufficient to kill the assumption.

The critical distinction is between normal termination (UPTO -- the real value arrived, the assumption served its purpose) and exceptional termination (UNLESS -- the assumption was wrong). These have completely different downstream consequences: normal termination is quiet and expected; exceptional termination is urgent and requires attention.

## The Assumption Type

An assumption is a value at a path with an activation condition, a set of liveness conditions (UPTO + UNLESS clauses), and a provisional marker:

```ft
Assumption = {
  value: string,
  status: "suspended" | "active" | "invalidated",
  provisional: true,
  invalidationCause: string | null
}
```

The `provisional` field is always `true` for an assumption -- it is what distinguishes assumed values from concrete values. The `invalidationCause` records which specific condition broke when the assumption dies.

## Activation and Liveness

An assumption activates when its FROM condition is met. Before activation, its value is not in the projected state:

```ft
assumption = Assumption
assumption << { value = "standard", status = "suspended" }
assumption << { status = "active" when fetchStarted EXISTS }
```

Before `fetchStarted`, the assumption is suspended. After `fetchStarted`, the value "standard" appears in projection, marked as provisional.

The assumption terminates when any of its liveness conditions break. The UPTO condition is the normal termination path. UNLESS conditions are exceptional termination paths:

```ft
assumption << { status = "invalidated" when fetchCompleted EXISTS }
assumption << { status = "invalidated" when authFailed EXISTS }
assumption << { status = "invalidated" when adminDetected EXISTS }
```

Any single condition appearing is sufficient to invalidate. The `invalidationCause` records which one fired first.

## Cause-Attributed Invalidation

When an assumption invalidates, the signal includes the cause. This is not decorative -- downstream processes behave differently based on whether the assumption ended normally (UPTO) or exceptionally (UNLESS):

```ft
invalidationSignal = {
  path: string,
  cause: string,
  wasException: boolean
}
```

If `fetchCompleted` fires, `cause = "fetchCompleted"` and `wasException = false`. The real value arrived; the assumption is no longer needed. If `authFailed` fires, `cause = "authFailed"` and `wasException = true`. The assumption was wrong; the reopened gap is urgent.

## Gap Reopening with Priority

After invalidation, the path the assumption occupied reverts to a gap. The gap's priority depends on the cause:

Normal termination (UPTO) reopens a gap at standard priority -- the real value is expected to arrive through the normal flow. Exceptional termination (UNLESS) reopens a gap at elevated priority -- the system's assumption was wrong and correction is urgent:

```ft
reopenedGap = {
  path: string,
  priority: number 0..1,
  elevatedDueToException: boolean
}
```

An UNLESS-invalidated gap has higher priority than a gap that was never assumed. The system surfaces recovery capabilities (retry, fallback, escalation) alongside the elevated gap.

## Provisional Marking

While active, assumed values are tagged as provisional. This tag is visible to any consumer:

```ft
provisionalValue = {
  value: string,
  provisional: true
}

concreteValue = {
  value: string,
  provisional: false
}
```

Processes reading an assumed value can see it is provisional and adjust their confidence accordingly. The tag does not require manual checking -- it is part of the value's type. A value is either provisional or concrete, and the distinction is always available.

## Nested Assumptions

Assumptions compose with other temporal patterns. An assumption inside a BEFORE block terminates when the outer block terminates:

```ft
outerAction = {
  status: "active" | "terminated"
}
outerAction << { status = "active" while timeout != true }

innerAssumption = Assumption
innerAssumption << { value = "large", status = "active" when startSignal EXISTS }
innerAssumption << { status = "invalidated" when outerAction.status = "terminated" }
```

When `timeout` fires, the outer action terminates, and the inner assumption invalidates with it. Both produce signals. Nesting depth is not limited.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Assumption activates on FROM condition | `status = "active" when fetchStarted EXISTS` |
| UPTO terminates normally | `status = "invalidated" when fetchCompleted EXISTS` |
| UNLESS terminates exceptionally | `status = "invalidated" when authFailed EXISTS` |
| Any single condition breaks assumption | Each condition independently sets "invalidated" |
| Cause attribution on invalidation | `invalidationSignal` with `cause` and `wasException` |
| Path reverts to gap after invalidation | `reopenedGap` surfaces at appropriate priority |
| Provisional marking distinguishes assumed from concrete | `provisional: true` always present on assumptions |
| Nested scoping: outer terminates inner | Inner liveness conditioned on `outerAction.status` |
| UNLESS gaps get elevated priority | `reopenedGap.elevatedDueToException` for urgent correction |
