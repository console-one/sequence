# Live Collaborative Editing

Multiple writers contribute to the same document simultaneously. Each edit is recorded in a deterministic, append-only log with editor attribution. The hard problem is conflict detection: when a writer submits an edit based on stale state (an outdated version), the edit must be suspended -- not silently applied -- so the writer can see what changed and resubmit. No last-write-wins. No silent overwrites. Every conflict is surfaced.

There are no locks. There is optimistic concurrency: write freely, but the system catches you if your assumptions about current state are wrong.

## The Edit Log

A document is an append-only log of edits. Each edit carries the editor's identity, the path being written, the new value, and the version the editor was working against:

```ft
Edit = {
  path: string,
  value: string,
  editor: string,
  baseVersion: number.integer >= 0,
  position: number.integer >= 0
}
```

The current document state is the projection of the log -- last write to each path wins. The log is never pruned or modified (compaction is a separate concern handled by compaction.md).

## Version Tracking

Each editable path has a sequential version counter, incremented with every successful edit. The version counter is the mechanism for stale-state detection:

```ft
PathVersion = {
  path: string,
  version: number.integer >= 0
}
```

```ft
bodyVersion = PathVersion
bodyVersion << { path: "body", version: 0 }
```

After each successful edit to `body`, the version increments: 0 -> 1 -> 2 -> 3. The version counter is what a writer checks before submitting -- "I am editing against version N."

## Concurrent Writes and Conflict Detection

Two editors write to the same document. Editor A writes against version 1, succeeding (version becomes 2). Editor B also writes against version 1, but version 1 is now stale:

```ft
editA = Edit
editA << { path: "body", value: "First draft by Alice", editor: "alice", baseVersion: 1 }
```

Editor A's write succeeds because `baseVersion` matches the current version. The version advances to 2.

```ft
editB = Edit
editB << { path: "body", value: "Revised by Bob", editor: "bob", baseVersion: 1 }
```

Editor B's write is based on version 1, but the current version is now 2. The write is suspended -- not applied. Editor B is working against stale state.

The suspended edit is preserved. Editor B can read the current state (Alice's version 2), reconcile, and resubmit against version 2:

```ft
editB2 = Edit
editB2 << { path: "body", value: "Revised by Bob (after Alice)", editor: "bob", baseVersion: 2 }
```

This resubmission succeeds. The version advances to 3.

## Edit Attribution

Every edit in the log carries the editor's identity. The log is the authoritative record of who changed what:

```ft
editA << { editor: "alice" }
editB2 << { editor: "bob" }
```

Reading the edit history shows each change attributed to the correct editor. This is non-negotiable -- accountability requires knowing who made each change.

## Historical Access and Diffs

The log supports historical queries -- reading the value of any path at a specific position in the log:

```ft
-- Reading body at position 3 returns the value written at position 3
-- Reading body at position 5 returns the value written at position 5
-- These are exact values, not projections
```

Diff computation is reading the current and previous values at a path. After an edit changes body from "Draft A" to "Draft B", the current value is "Draft B" and the previous value is "Draft A". The diff is the comparison between them.

## Append-Only Guarantee

The log is immutable after write. Edits are never removed, modified, or reordered. Even edits whose values are later overwritten by newer writes remain in the log. The log IS the audit trail. All 5 edits are present after 5 writes, even if only the last value is current.

## Capabilities

Edits are submitted by external writers. Version tracking and conflict detection are system-provided:

```ft
cap Edit.path
cap Edit.value
cap Edit.editor
cap Edit.baseVersion
cap PathVersion.version
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Multiple writers, deterministic ordered log | `Edit` entries with `position` and `editor`; log records both edits in order |
| Stale-state edit is suspended | `editB` with `baseVersion: 1` suspended when current version is 2 |
| Suspended writer reads current state and resubmits | `editB2` with `baseVersion: 2` succeeds after reconciliation |
| Append-only log preserves all edits | All edits remain in log, including overwritten values |
| Diff between current and previous values | Current and previous values readable for comparison |
| Historical query returns exact value at position | Reading path at specific position returns that position's value |
