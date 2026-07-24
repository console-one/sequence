# Auditability

Every state mutation produces an immutable record. The audit trail is not a separate system bolted onto the side -- it IS the primary data log. Records are append-only: once created, never modified. Invalidation of a record creates a new record referencing the original; the original persists unchanged. This gives auditors a complete, tamper-proof chain of events.

The tension is unbounded growth. A long-running system accumulates records forever. Compaction collapses old records into summary snapshots, but must preserve the projection invariant: all current values are identical before and after compaction. The recent audit window remains individually queryable.

## The Audit Record Type

Each mutation produces a record with a monotonically increasing sequence number, a timestamp from an injectable clock, the operation performed, the path affected, and the value:

```ft
AuditRecord = {
  seq: number.integer >= 0,
  timestamp: number,
  op: "write" | "delete" | "invalidate",
  path: string,
  value: string
}
```

```ft
AuditClock = {
  now: (unit: string) -> { timestamp: number }
}
```

The clock is injectable -- tests provide a deterministic mock, production uses wall-clock time. Every record's timestamp comes from this clock, never from the system clock directly.

## Appending Records

Writing state appends a record. The sequence number is monotonically assigned. No record is ever mutated after creation:

```ft
auditLog = ref(AuditRecord)
auditLog << { seq: 0, timestamp: 1000, op: "write", path: "config.model", value: "gpt-4" }
auditLog << { seq: 1, timestamp: 1001, op: "write", path: "config.temperature", value: "0.7" }
auditLog << { seq: 2, timestamp: 1002, op: "write", path: "output.draft", value: "Hello" }
```

Three writes, three records, monotonically increasing sequence numbers and timestamps.

## Invalidation as a New Record

Invalidating a record does not mutate it. Instead, a new record is appended that references the original by sequence number. The original record remains in the log unchanged:

```ft
auditLog << { seq: 3, timestamp: 1010, op: "invalidate", path: "config.temperature", value: "seq:1" }
```

Record 1 still exists with its original content. Record 3 is the invalidation event, itself an auditable entry. When querying "active records since checkpoint," invalidated records are automatically excluded from results.

## Checkpoint Queries and Path Filtering

Consumers query the log by checkpoint ("what changed since sequence N?") and optionally filter by path prefix:

```ft
AuditQuery = {
  since: number.integer >= 0,
  prefix: string
}
```

```ft
cap AuditQuery.since
cap AuditQuery.prefix
```

Querying "since 2" returns only records with `seq >= 2`. Filtering by prefix `config.` returns only records whose path starts with `config.`. Invalidated records are excluded from active queries automatically.

## Compaction

Compaction collapses records before a sequence boundary into a summary snapshot. Records at or after the boundary remain individually accessible. The critical invariant: reading any path before and after compaction returns the same value.

```ft
CompactionBoundary = {
  atSeq: number.integer >= 0,
  summaryRef: ref(AuditRecord)
}
```

After compaction at sequence 5, records 0-4 are collapsed into the summary. Records 5 onward remain intact. The summary preserves the net effect of all pre-boundary records so that current values are unchanged.

Compaction is a storage optimization, not a state change. If compaction altered observable values, it would be a bug.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Three writes produce three records with monotonic seq/timestamps | `auditLog << { seq: 0..2 }` pattern |
| Query "since position 2" returns only records 2+ | `AuditQuery.since` capability |
| Invalidated record excluded from active query; invalidation record exists | Invalidation appends new record; active query filters |
| Path prefix filtering returns matching records only | `AuditQuery.prefix` capability |
| Compaction preserves observable state; old records collapsed | `CompactionBoundary` with summaryRef; projection invariant |
| Mock clock controls timestamps | `AuditClock.now` injectable; records use its output |
