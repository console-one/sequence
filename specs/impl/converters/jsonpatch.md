# JSON Patch Converter

Patches are how the system describes changes to typed state without transmitting the full state. A patch is minimal: it carries the delta, not the whole. It references the prior state by version, targets a specific path, and applies changes in one of two modes -- overlay (merge into existing) or replace (swap out the subtree). Patches can reference the previous value at a path, support range operations, and distinguish between persistent and transient values.

The hard part: patches must be simultaneously minimal, precise, and expressive, while working universally across any typed structure. And they must cleanly separate what persists from what is ephemeral.

## The Patch Type

A patch has three required components: a reference to the prior state being patched, the path where the patch applies, and the mode (overlay or replace). The path is the deepest common ancestor of all changes -- this enables efficient routing without inspecting the contents:

```ft
PatchMode = "overlay" | "replace"

Patch = {
  prev: string,
  path: string,
  mode: PatchMode,
  changes: { key: string, value: string | number | boolean | null }
}
```

The `prev` field is a version reference (content hash or sequence number), not the full prior state. The patch is proportional to the size of the change, not the size of the structure. Changing one field in a 1000-field structure produces a patch with one entry plus metadata.

## Overlay vs Replace

Overlay merges changes into existing state, preserving unmentioned fields. Replace deletes everything at the target path and substitutes the patch contents as the entire new value. These map to natural user actions -- editing a field (overlay) vs resetting a section (replace):

```ft
overlayPatch = Patch
overlayPatch << { prev: "v1", path: "root", mode: "overlay", changes: { b: 20 } }
-- Given state {a: 1, b: 2, c: 3}, overlay produces {a: 1, b: 20, c: 3}

replacePatch = Patch
replacePatch << { prev: "v1", path: "root", mode: "replace", changes: { b: 20 } }
-- Given state {a: 1, b: 2, c: 3}, replace produces {b: 20}
```

The mode flag is per-patch. Every patch declares whether it merges or replaces. There is no default -- the intent must be explicit.

## Previous State References

A patch value can be defined in terms of the value that existed at that path before the patch. This enables incremental updates without knowing the absolute new value at construction time:

```ft
PrevRefPatch = {
  prev: string,
  path: string,
  mode: "overlay",
  changes: { key: string, value: prev }
}
```

The `prev` keyword in a change value means "the value that was at this path before this patch." Arithmetic and transformations on previous values (e.g., `prev.count + 1`) are computed during patch application -- the patch carries the expression, not the result.

Expressions referencing previous state that don't exist (the field was absent) are surfaced as errors, not silently resolved to null.

## Multi-Branch Patches

A single patch can modify values at multiple paths simultaneously. All changes apply atomically -- no intermediate state where some changes have applied and others have not is observable:

```ft
MultiBranchPatch = {
  prev: string,
  path: string,
  mode: "overlay",
  changes: { key: string, value: string | number | boolean | null }
}
```

Atomicity means an observer sees either the state before the patch or the state after the patch, never a partial application. If any individual change fails (type mismatch, invalid path), the entire patch fails -- no silent partial application.

## Persistent vs Transient Values

Patches distinguish between values that persist (become part of the durable state) and values that are transient (exist only during patch application). Transient values are used as intermediate computation but do not appear in the resulting state:

```ft
AnnotatedChange = {
  key: string,
  value: string | number | boolean | null,
  liveness: "persistent" | "transient"
}
```

A transient value declared as `temp = prev.value * 2` can be referenced by a persistent value `result = temp + 1`. After the patch applies, `result` is in the final state but `temp` is not. This keeps intermediate computation out of the durable state.

## Range Operations

Range-based deletions and modifications target all keys within a lexicographic range. This enables efficient bulk changes without enumerating every key:

```ft
RangeOp = {
  from: string,
  to: string,
  action: "delete" | "set",
  value: string | number | boolean | null
}
```

A range deletion from "b" to "d" on state `{a:1, b:2, c:3, d:4, e:5}` removes exactly keys b, c, and d, leaving `{a:1, e:5}`. Range boundaries are inclusive. The sort order is lexicographic on string keys.

## Minimal Path Prefix

Every patch declares its minimal path prefix -- the deepest common ancestor of all changes. This enables efficient routing: a process watching only `a.x` can ignore a patch with prefix `a.b` without examining its contents:

```ft
-- A patch affecting a.b.c and a.b.d has minimal path "a.b"
-- A process watching only a.x skips this patch entirely
scopedPatch = Patch
scopedPatch << { prev: "v3", path: "a.b", mode: "overlay", changes: { c: 10, d: 20 } }
```

The path is computed automatically -- it is the longest common prefix of all change paths. The system never sends patches with a path that is broader than necessary.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Patch has prev ref, path, and changes | `Patch` type with `prev`, `path`, `changes` fields |
| Overlay preserves unmentioned fields | `overlayPatch` with mode "overlay" merges into existing state |
| Replace swaps entire subtree | `replacePatch` with mode "replace" deletes and substitutes |
| Range deletion of keys b-d | `RangeOp` with `from`/`to` boundaries and "delete" action |
| Previous value reference in expressions | `PrevRefPatch` using `prev` as value reference |
| Multi-branch atomic application | `MultiBranchPatch` with multiple changes, all-or-nothing semantics |
| Transient values excluded from final state | `AnnotatedChange` with `liveness: "transient"` not persisted |
| Patch size proportional to change | One changed field produces one entry in `changes`, not full state |
| Minimal path prefix for routing | `scopedPatch` with path "a.b" as deepest common ancestor |
