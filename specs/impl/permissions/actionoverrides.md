# Action Overrides

Hierarchical systems need defaults that apply broadly without every node opting in. But specific nodes need exceptions. The resolution question -- most-specific wins vs. merge vs. something else -- determines whether the system is predictable. This blueprint uses walk-up semantics: start at the target path, walk up through ancestors, and the first override found governs. No merging across levels. The override is just a declaration at a more specific path, using exactly the same write operation as the original.

The key constraint is that overrides are atomic. A child override replaces the parent's behavior entirely, it does not inherit individual fields from it. This makes the system trivial to debug: query the effective behavior for a path and you get one answer traceable to one declaration.

## Write Behavior at Paths

Each path's write behavior is determined by the expression used at the write site. Overwrites use plain assignment. Accumulation uses `prev`:

```ft
-- Overwrite (default): new value replaces old.
metrics.cpu = 50
metrics.cpu = 75
-- metrics.cpu reads as 75

-- Accumulation via prev: new value adds to old.
metrics.memory = 100
metrics.memory = prev + 50
-- metrics.memory reads as 150
```

There is no separate policy declaration. The write expression itself says whether the update is a replacement or an accumulation.

## Declaring Defaults and Overrides

Default write patterns for a subtree are established by the expressions used at ancestor paths. Overrides at more specific paths simply use a different expression -- there is no special override syntax:

```ft
-- Default: writes under metrics just overwrite.
metrics.cpu = 50
metrics.cpu = 75
-- metrics.cpu reads as 75 (overwrite)

-- Override: metrics.memory accumulates via prev.
metrics.memory = 100
metrics.memory = prev + 50
-- metrics.memory reads as 150 (accumulated)
```

The first pattern establishes a default for everything under `metrics` (plain overwrite). The second pattern overrides that for `metrics.memory` specifically. Siblings like `metrics.cpu` still use plain overwrite.

## Walk-Up Resolution

When reading behavior for a path, the system walks up from the target path until it finds a declared pattern. The resolution is deterministic: same declarations always produce the same effective behavior.

For deeply nested paths like `metrics.disk.partition.0.read`, the walk-up checks `metrics.disk.partition.0.read`, then `metrics.disk.partition.0`, then `metrics.disk.partition`, then `metrics.disk`, then `metrics`, stopping at the first path that has a declared behavior.

## No Cross-Level Merging

When a child override exists, it is used in its entirety. Behavior from the parent is not inherited. This is a deliberate design choice -- merging across levels creates emergent behavior that is difficult to debug:

```ft
-- Parent: plain overwrite
parent.x = 10
parent.x = 20
-- parent.x reads as 20

-- Child: accumulation via prev
parent.child.y = 10
parent.child.y = prev + 5
-- parent.child.y reads as 15
```

The child's `prev`-based accumulation stands alone. It does not inherit anything from the parent's overwrite pattern. If the child needs to combine behaviors, it must express that explicitly in the write expression.

## Inspecting Effective Behavior

For debugging, the system supports two reads: raw behavior (what is declared exactly here, with no walk-up) and effective behavior (the result of walk-up resolution). A path with no direct declaration has no raw behavior but may still have effective behavior inherited from an ancestor.

```ft
tool Behavior.resolve
tool Behavior.inspect
```

`resolve` performs walk-up and returns the governing behavior. `inspect` returns only the raw declaration at the exact path, or nothing.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Default overwrite governs descendant writes | Write to `metrics.cpu` overwrites (plain `=`) |
| Child override at "metrics.memory" accumulates via `prev` | `metrics.memory = prev + 50` accumulates |
| Deep descendant with no override inherits nearest ancestor | Walk-up from `metrics.disk.read` finds `metrics` behavior |
| Nearest ancestor wins over distant ancestor | Walk-up stops at first declared behavior |
| No cross-level merge -- child behavior is self-contained | Child has only its own expression, no parent inheritance |
| Same mechanism for declaration and override | Both use write expressions (`=`, `= prev + ...`) |
