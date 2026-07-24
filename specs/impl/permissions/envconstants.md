# Environment Constants

Environment constants are safety bounds declared at broad scopes that propagate downward automatically. Unlike policy overrides (where most-specific wins entirely), constraints compose: the effective constraint at any path is the conjunction of all ancestor constraints. A child can tighten a constraint but never loosen one. If an ancestor says "max 10" and a child says "max 50", the effective constraint remains "max 10" -- the child's loosening attempt has no effect.

This is the distinction between policies and constraints. Policies use override semantics (most-specific replaces). Constraints use composition semantics (intersection of valid sets). Both propagate through the hierarchy, but they compose differently because they serve different purposes: policies express preferences, constraints express invariants.

## The Constraint Type

A constraint is a bound declared at a path. It specifies a field, an operator, and a limit value:

```ft
Constraint = {
  field: string,
  op: "<=" | ">=" | "<" | ">",
  limit: number
}
```

Constraints are structural -- they specify what values are acceptable. The system rejects (suspends) any write that would violate the effective constraint at a path.

## Declaring Constraints

Constraints are mounted at paths. Descendants automatically inherit them without any opt-in:

```ft
policy env: { field: "maxAgents", op: "<=", limit: 10 }
policy env.team1: { field: "tokenBudget", op: "<=", limit: 20000 }
```

The first line bounds `maxAgents` to at most 10 for everything under `env`. The second line separately bounds `tokenBudget` for `env.team1`. Both constraints compose at `env.team1` -- a write there must satisfy both.

## Composing Constraints (Conjunction)

The effective constraint at a path is the conjunction (intersection) of all constraints from root to that path. This means constraints can only get tighter as you descend:

```ft
policy env: { field: "tokenBudget", op: "<=", limit: 100000 }
policy env.team1: { field: "tokenBudget", op: "<=", limit: 20000 }
```

At `env.team1`, the effective constraint on `tokenBudget` is `<= 20000` (the tighter of the two). A write of 25000 to `env.team1.tokenBudget` is rejected because it violates the child's constraint. A write of 15000 succeeds because it satisfies both.

If the child had declared `<= 200000` instead, the effective constraint would still be `<= 100000` from the parent. Children cannot loosen.

## Enforcement: Suspension on Violation

Writes that violate the effective constraint are suspended, not silently accepted or clamped:

```ft
env.maxAgents = 5
-- succeeds: 5 <= 10

env.maxAgents = 15
-- suspended: 15 > 10, violates constraint at "env"
```

The suspension includes a reason: "value 15 exceeds max 10 at path env.maxAgents, constraint inherited from env." This makes debugging straightforward -- the user knows exactly which constraint was violated and where it was declared.

## Raw vs. Effective Inspection

For debugging, the system supports inspecting the raw constraint at an exact path (what was declared here, without composition) versus the effective constraint (the composed result of all ancestors):

```ft
cap Constraint.effective
cap Constraint.raw
```

`raw` at `env.team1` returns only `{ field: "tokenBudget", op: "<=", limit: 20000 }`. `effective` at `env.team1` returns the composed result of the `env` and `env.team1` constraints -- the tightest bound for each field.

## Automatic Inheritance

A newly created descendant path inherits all ancestor constraints without explicit annotation:

```ft
env.agents.a1 = "worker"
-- env.agents.a1 is automatically subject to the "env" constraint (maxAgents <= 10)
-- No declaration needed at env.agents.a1
```

This scales to arbitrary depth. A path like `env.agents.pool.worker.0` inherits every constraint declared at any ancestor along that path.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Write within constraint succeeds | `env.maxAgents = 5` passes `<= 10` |
| Write exceeding constraint is suspended | `env.maxAgents = 15` suspended with reason |
| Child tightening composes with parent | Both `<= 100000` and `<= 20000` apply; effective is `<= 20000` |
| Write satisfying both composed constraints succeeds | `15000` passes both bounds |
| Raw inspection returns only local declaration | `Constraint.raw` at child returns child-only |
| New descendant inherits ancestor constraints automatically | `env.agents.a1` subject to `env` constraint without declaration |
