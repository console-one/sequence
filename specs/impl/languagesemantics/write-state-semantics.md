# Write State Semantics -- What `=` and `<<` Mean Precisely

The DSL has two write operators, three removal/gating mechanisms, and a provenance marker. That is the complete write vocabulary. `=` overwrites -- it replaces whatever was at the path. `<<` narrows -- it composes with what is already there, and is rejected if the composition produces `never`. `delete` removes a value. `when` gates entry (suspends if the condition is false, resumes when it becomes true). `while` gates lifetime (invalidates the value when the condition breaks). `by` records who wrote it. `prev` enables self-referential updates where the new value depends on the old.

The distinction between `=` and `<<` is the distinction between push and patch. `=` is push: "forget what was there, here is the new state." `<<` is patch: "compose this with the existing state, tighten the constraints." `delete` is retract: "remove this claim from the store."

## Overwrite -- `=`

Assignment replaces the value at a path. If a schema exists at the path, the new value is validated against it. If validation fails, the mount suspends -- it is not discarded, and it is not silently accepted:

```ft
name = string
name = "Alice"
-- name is "Alice"

name = "Bob"
-- name is now "Bob". "Alice" is gone.
```

For schema (type) declarations, `=` also replaces. Declaring a new schema at a path overwrites the old one:

```ft
score = number >= 0
score = 10
-- Valid: 10 satisfies number >= 0

-- Overwriting with an invalid value suspends:
-- score = -5 would suspend because -5 fails number >= 0
```

## Narrow -- `<<`

Narrowing composes the new value or type with whatever already exists at the path. The composition is a lattice meet -- the result has every constraint from both sides. If the constraints contradict (e.g., narrowing `"active"` onto `"inactive"`), the result is `never` and the mount is rejected:

```ft
Worker = {
  heartbeat: number,
  livenessWindow: number
}

-- Narrow with concrete values (instantiation)
worker1 = Worker
worker1 << { livenessWindow: 5000 }
worker1 << { heartbeat: 1712345678 }
-- worker1 now has the Worker schema plus concrete values for both fields
```

Narrowing a function type refines its predicates. The narrowed version must be compatible -- its input can be broader, its output must be narrower:

```ft
Shop = {
  status: "created" | "paid" | "shipped",
  count: number >= 0
}

Shop << {
  pay: (ref: string) -> { ok: true } when status = "created"
}
-- pay is added to Shop via narrowing. It composes with the existing type.
```

## Delete

Delete removes the value at a path. The schema remains -- so the path becomes a gap (type without value). This is how the system retracts claims without losing the structural contract:

```ft
sessionData = string
sessionData = "cached-result"

delete sessionData
-- sessionData's value is gone. The schema (string) remains.
-- sessionData now appears in gaps as "unresolved."
```

## Entry Gate -- `when`

A `when` clause suspends the write until the condition is true. The write is preserved as a suspended block in the log. When subsequent state changes make the condition true, the block automatically resumes and applies:

```ft
role = "viewer" | "admin"
role = "viewer"

debugMode = "enabled" when role = "admin"
-- debugMode suspends: role is "viewer", not "admin".
-- The suspended block exists in the log, waiting.

role << "admin"
-- Condition met. debugMode automatically resumes.
-- debugMode is now "enabled".
```

Conditions use the supported comparison syntax: `EXISTS`, `=`, `!=`, `<`, `<=`, `>`, `>=`, `MATCHES /pattern/`:

```ft
task = string when workerPool EXISTS
-- Suspends until workerPool has any value.

alert = "critical" when errorRate > 0.05
-- Suspends until errorRate exceeds threshold.
```

Multiple `when` conditions are conjunctive -- all must be true for the write to apply. If any single condition is unmet, the entire write suspends.

## Lifetime Gate -- `while`

A `while` clause keeps the value alive only as long as the condition holds. When the condition becomes false, the value is invalidated -- removed from the projection. The schema remains, creating a gap:

```ft
sessionActive = boolean
sessionActive = true

cache = "session-data" while sessionActive = true
-- cache holds "session-data" as long as sessionActive is true.

sessionActive << false
-- while condition breaks. cache is invalidated.
-- cache's value disappears. Schema remains. Gap surfaces.
```

The `onBreak` handler fires when a `while` condition breaks, producing an explicit signal rather than a silent disappearance:

```ft
task = "job-42" while workerAlive = true
-- onBreak: events.taskExpired = true
-- When workerAlive becomes false:
-- 1. task is invalidated (value removed)
-- 2. events.taskExpired is set to true (onBreak fires)
```

## Provenance -- `by`

The `by` modifier records who authored a write. This is metadata on the block, not a separate value. It flows through the log and is available for auditing:

```ft
config = { model: "claude-3", maxTokens: 4000 } by "admin"
-- The block that sets config is tagged with author "admin".
-- When hoist() renders this state, it can emit:
-- @source: author "admin"
```

## Self-Referential Updates -- `prev`

The `prev` keyword reads the path's value before the current mount. This enables accumulation, decrement, and any update that depends on prior state:

```ft
counter = number >= 0
counter = 0

counter = prev + 1
-- counter is 1 (prev was 0)

counter = prev + 1
-- counter is 2 (prev was 1)
```

`prev` works across composed types. In a composition `A & B`, a write to `A` can reference `prev.fieldFromB`:

```ft
Shop = {
  count: number >= 0,
  budget: number >= 0
}

Shop << { count = prev.count - 1, budget = prev.budget - 10 }
-- Both fields update from their previous values in a single mount.
```

There are no transition policies. Every state-dependent update is an explicit `prev` reference at the write site. The update logic is visible, not hidden behind configuration.

## Push vs Patch Summary

The two operators map to two modes of writing:

```ft
-- Push (=): new state, independent of old
status = "active"
config = { model: "claude-3" }

-- Patch (<<): compose with existing, must be compatible
worker1 << { heartbeat: 1712345678 }
Shop << { pay: (ref: string) -> { ok: true } }

-- Retract (delete): remove claim, schema survives
delete sessionData
```

`=` is "I am telling you what this is." `<<` is "I am telling you more about what this already is." `delete` is "I am retracting my previous claim." `when` is "this claim is conditional on external state." `while` is "this claim is valid only as long as this holds." These are the write concerns. There are no others.

## What This Validates

| AC | Expressed by |
|----|-------------|
| `=` replaces value at path | `name = "Bob"` overwrites `"Alice"` |
| `<<` composes with existing, rejects incompatible | `worker1 << { livenessWindow: 5000 }` narrows; contradictory narrowing produces `never` |
| `delete` removes value, preserves schema | `delete sessionData` leaves schema, creates gap |
| `when` suspends write until condition is true | `debugMode = "enabled" when role = "admin"` suspends while role is `"viewer"` |
| Suspended writes auto-resume when condition met | `role << "admin"` triggers resume of `debugMode` |
| `while` invalidates value when condition breaks | `cache` invalidated when `sessionActive` becomes `false` |
| `onBreak` fires signal on `while` invalidation | `events.taskExpired = true` fires when `workerAlive` breaks |
| `by` records provenance on the block | `config = ... by "admin"` tags the block's author |
| `prev` enables self-referential updates | `counter = prev + 1` accumulates; `prev.count` reads cross-class |
| No hidden transition policies | Every update that depends on prior state uses explicit `prev` |
