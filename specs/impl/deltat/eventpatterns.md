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

Temporal event patterns are how actions relate to observations in time. The system needs four primitive operators -- BEFORE, UPTO, FROM, AFTER -- that compose into interval relations (PREDICTS, YIELDS, OVERLAPS, MEETS) without special-casing.

Each operator has two independent aspects: an activation condition (when can the action start?) and a liveness condition (when does the action stay alive?). BEFORE has no activation gate but has a liveness gate (while B absent). FROM has an activation gate (wait for B) but no liveness bound. UPTO has both. AFTER is like FROM but enforces strict ordering -- the action starts only after B has been present in a prior logical step, not at the same instant.

Termination is never silent. When a liveness condition breaks, the system produces a termination signal. Suspension is never invisible. An action whose activation condition is not met is visibly suspended, not omitted.

## The Temporal Operator Type

A temporal operator binds an activation condition and a liveness condition. Both are optional -- their presence or absence distinguishes the four primitives:

```ft
TemporalOp = {
  action: string,
  status: "suspended" | "active" | "terminated"
}
```

The `status` field is derived from the activation and liveness conditions, not set directly. "Suspended" means the activation condition is not yet met. "Active" means activation is met and liveness holds. "Terminated" means liveness broke.

## The Four Primitives

BEFORE: the action is active immediately and terminates when B occurs. There is no activation gate -- the action starts as soon as it is declared. Liveness is conditioned on B being absent:

```ft
beforeAction = TemporalOp
beforeAction << { action = "processRequest" }
beforeAction << { status = "active" while observationB != true }
```

When `observationB` becomes true, the `while` condition breaks and the action terminates. The action's schema remains (its obligation resurfaces if needed), but its value is removed.

UPTO: like BEFORE, but with an additional activation gate. The action can only start if B has not yet occurred. If B already exists when the action is declared, it never activates:

```ft
uptoAction = TemporalOp
uptoAction << { action = "acceptConnections" when observationB != true }
uptoAction << { status = "active" while observationB != true }
```

The `when` gate prevents activation if B already exists. The `while` gate terminates if B appears later. Both conditions reference the same observation but serve different roles.

FROM: the action is suspended until B occurs, then activates and remains active indefinitely:

```ft
fromAction = TemporalOp
fromAction << { action = "processData" when observationB EXISTS }
fromAction << { status = "suspended" when observationB != true }
fromAction << { status = "active" when observationB EXISTS }
```

Before B fires, the action is suspended and queryable (it shows "awaiting observationB"). After B fires, the action activates and stays active with no liveness bound.

AFTER: like FROM but with strict temporal ordering. The action activates only after B has been present in a prior logical step, not at the same instant B appears. This is expressed as a behavioral constraint that the parser cannot handle directly: the activation gate checks that B existed in a previous step, not the current one. In the ft blocks, we model this as a `when` gate on B existing, with the understanding that the strict-after semantics (not same-instant) are enforced by the scheduler at runtime.

```ft
afterAction = TemporalOp
afterAction << { action = "validateData" when observationB EXISTS }
afterAction << { status = "active" when observationB EXISTS }
```

The difference between FROM and AFTER is not visible in the type structure -- it is a scheduling constraint. FROM permits activation at the same logical step B appears. AFTER requires at least one intervening step. Both use the same `when` gate; the temporal strictness is an interpreter-level enforcement.

## Termination Signals

When a liveness condition breaks, the system produces an explicit termination signal. The terminated action does not silently disappear:

```ft
terminationSignal = {
  action: string,
  cause: string,
  terminated: true
}
```

The `cause` field identifies which condition broke. This is critical for downstream processes that need to distinguish normal termination (the expected event arrived) from exceptional termination (something preempted the action).

## Interval Relations by Composition

Two temporal patterns compose into interval relations. PREDICTS means A's completion gates B's activation (A ends strictly before B starts). YIELDS means A's output gates B's activation (A ends at or before B starts). These are not new primitives -- they are compositions of FROM/AFTER applied to completion events:

```ft
-- A PREDICTS B: B activates strictly after A completes
predictedAction = TemporalOp
predictedAction << { action = "parse" when fetchCompleted EXISTS }

-- A YIELDS B: B activates at or after A completes
yieldedAction = TemporalOp
yieldedAction << { action = "transform" when parseOutput EXISTS }
```

PREDICTS uses AFTER semantics (strict ordering). YIELDS uses FROM semantics (at-or-after). OVERLAPS and MEETS are further compositions where A's start and end relate to B's start and end through the same four primitives.

Transitive composition works naturally: if A PREDICTS B and B YIELDS C, then C activates from B's output, which only exists after A completes. The three-stage pipeline executes in order without explicit sequencing.

## Nested Temporal Scoping

Temporal operators compose by nesting. An action governed by one operator can itself be the action in another operator. When the outer operator terminates, the inner action terminates with it:

```ft
outerAction = TemporalOp
outerAction << { action = "outerProcess" while cancelSignal != true }

innerAction = TemporalOp
innerAction << { action = "innerProcess" when startSignal EXISTS }
innerAction << { status = "active" while outerAction.status = "active" }
```

The inner action's liveness is conditioned on the outer action being active. When the outer terminates (cancelSignal fires), the inner terminates as well. Both produce termination signals. Nesting depth is not limited.

## What This Validates

| AC | Expressed by |
|----|-------------|
| BEFORE: active until B, then terminates | `beforeAction` with `while observationB != true` |
| UPTO: never activates if B already exists | `uptoAction` with `when observationB != true` gate |
| FROM: suspended until B, then active indefinitely | `fromAction` with `when observationB EXISTS` activation |
| AFTER: strict ordering, not same-instant | Behavioral constraint on scheduler; `when` gate plus strict-after enforcement |
| Termination produces explicit signal | `terminationSignal` with cause attribution |
| PREDICTS/YIELDS as compositions | `predictedAction`/`yieldedAction` using FROM/AFTER on completion events |
| Transitive pipeline composition | A PREDICTS B, B YIELDS C chains through completion events |
| Suspended actions are visible | `status = "suspended"` is queryable with unmet condition |
| Nested scoping: outer terminates inner | `innerAction` liveness conditioned on `outerAction.status` |
