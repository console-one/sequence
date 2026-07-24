# Historicals

## Original Notes

This would just be certain utilities that we use to perform Excel-like aggregations or querying on historical streams of data. Let's say we have some accounting data, which is like historical bank statements. It's clear that, when we set up the server, the process normally, we only write facts to history once we have crossed the real-time threshold. Those are facts about the server at history, so we can continue to have all of the facts about external to the partition's history somewhere in belief space. Those would also be types with timestamps, but I don't know how we would even necessarily apply the time index or the real-time index. I guess it would be an assumed real-time value for the aggregations of historical events, just like we have for concreteness of a particular type at a particular time where we don't know its full value. Maybe we just use the same thing to display it, to describe portions of historical space-time outside of the partition that we don't know about. We can only make assumptions, and then we just use whatever tools we established to build those function interpolations for those periods. We can just extend them in the future for those same partitions and the planning scenario, and then use those to build discrete event simulation inputs for scenarios where plan space converges down to real time.

These historicals would also be used for system logs and facts about the system, because all of our logs for different processes are being written to some historical database. Building our indexing layer over different log streams that are appropriately snapshotted should enable us to compute metrics, or, over the last month, find all the instructions I gave to an agent that looked like this. We would just be able to merge the proofs, the proof streams, with events where message equals whatever my username is, and merge those by time, which is pretty easy on a host that gets spun up or even locally. Then paginate through that merged query and grep each page or whatever.

Historical data is an append-only, temporally ordered stream of facts. The core challenge is supporting point-in-time queries (what was the balance in January?), range aggregations (average balance over Q1), and cross-stream merges (join agent logs with user commands by timestamp) -- all through a single query interface that works identically for business data and system logs. Unknown historical periods are gaps with uncertainty, not missing data.

Facts are only written to history once the real-time threshold has been crossed. Everything before now is confirmed past; everything after is forecast. This boundary matters because history is authoritative and append-only, while forecasts are provisional and replaceable.

## The Historical Entry Type

Each historical entry is a timestamped fact with a source label and typed content. The timestamp determines its position in the stream:

```ft
HistoricalEntry = {
  timestamp: number,
  source: string,
  label: string,
  content: string | number
}

HistoricalStream = {
  entries: ref(HistoricalEntry),
  source: string
}
```

An entry is a fact recorded at a point in time. The stream is the ordered collection. Source identifies where the data came from (a bank account, an agent process, a sensor). Content is the recorded value.

## Point-in-Time Queries

Querying a specific historical point returns the value recorded at that timestamp. The query is a read against the stream filtered by time:

```ft
balances = HistoricalStream
balances << { source: "checking-account" }

-- January balance
balances.entries.jan = HistoricalEntry
balances.entries.jan << { timestamp: 1, source: "checking-account", content: 50000 }

-- February balance
balances.entries.feb = HistoricalEntry
balances.entries.feb << { timestamp: 2, source: "checking-account", content: 47500 }

-- March balance
balances.entries.mar = HistoricalEntry
balances.entries.mar << { timestamp: 3, source: "checking-account", content: 52000 }
```

Querying for the January balance reads the entry at timestamp 1 and returns 50000. Each entry is independently addressable by its timestamp.

## Gaps in Historical Data

When no data exists for a historical period, the query returns a gap with concreteness less than 1.0. This is not an error -- it is honest uncertainty about what happened during that period:

```ft
-- April: no data recorded
balances.entries.apr = HistoricalEntry
balances.entries.apr << { timestamp: 4, source: "checking-account", content: [[ unknown balance ]] }
```

The gap has a schema (it is a number, it is a balance) but no concrete value. Interpolation policies can fill it with estimates, but the concreteness reflects that it is an estimate, not a fact. The same mechanism used for forecast uncertainty applies to historical uncertainty.

## Range Aggregations

Aggregation over a range computes derived metrics from multiple entries. The aggregation is a derived value that references the entries in the range:

```ft
AggregationResult = {
  method: "average" | "sum" | "count",
  rangeStart: number,
  rangeEnd: number,
  result: number
}

q1Average = AggregationResult
q1Average << { method: "average", rangeStart: 1, rangeEnd: 3 }
q1Average << { result: ref(balances.entries) }
```

The actual computation (summing entries and dividing by count) is a behavioral predicate that cannot be expressed directly in ft syntax. The ft block captures the structure: the aggregation references the entries, has a method and range, and produces a result. The result re-resolves whenever the referenced entries change.

## Unified Query Interface for Logs and Business Data

System logs use the same HistoricalEntry type and the same query mechanisms as business data. There is no separate log query system:

```ft
agentLogs = HistoricalStream
agentLogs << { source: "agent-01" }

agentLogs.entries.msg1 = HistoricalEntry
agentLogs.entries.msg1 << { timestamp: 100, source: "agent-01", label: "user", content: "analyze Q1 data" }

agentLogs.entries.msg2 = HistoricalEntry
agentLogs.entries.msg2 << { timestamp: 101, source: "agent-01", label: "agent", content: "running query..." }
```

Filtering for messages from a specific user is a read with a condition on the label field. The same stream merge and pagination capabilities apply.

## Stream Merging by Timestamp

Multiple streams can be merged into a single time-ordered view. Each stream contributes entries; the merge interleaves them by timestamp:

```ft
MergedView = {
  sources: ref(HistoricalStream),
  ordering: "timestamp"
}

merged = MergedView
merged << { sources: ref(agentLogs) }
```

The merged view is a derived type -- it references multiple streams and produces an interleaved sequence. Entries with identical timestamps maintain deterministic ordering (by source ID). The merge does not copy entries; it is a view over the source streams.

## Compaction and Archival

Old entries are compactable to manage storage. Compaction collapses entries older than a threshold into a summary while preserving the current materialized state:

```ft
CompactionPolicy = {
  threshold: number,
  retainCurrent: boolean
}

balances << { compaction: CompactionPolicy }
balances.compaction << { threshold: 100, retainCurrent: true }
```

After compaction, entries older than the threshold are archived. The current projection is unchanged -- the latest values are still directly readable. Archived entries are accessible via cold storage but may load slower. Compaction is a storage optimization, not data deletion.

## Pagination

Large query results are iterable in bounded pages:

```ft
PageRequest = {
  pageSize: number.integer >= 1,
  offset: number.integer >= 0
}
```

Ordering is preserved across page boundaries. The user browses pages rather than loading entire histories into memory.

## Real-Time Threshold

Facts are only written to history once their timestamp has crossed the real-time boundary. Future-timestamped values go to forecast space, not history:

```ft
-- This entry's timestamp is in the past: written to history
balances.entries.mar << { timestamp: 3, content: 52000 }

-- This entry's timestamp is in the future: belongs in forecast space, not history
-- balances.entries.jun would be a forecast, not a historical fact
```

The real-time threshold is the boundary between confirmed past and speculative future. History is authoritative; forecasts are provisional.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Point-in-time query returns recorded value | `balances.entries.jan << { timestamp: 1, content: 50000 }` |
| Range aggregation computes derived metric | `q1Average << { result: ref(balances.entries) }` with method "average" |
| Missing historical period is a gap, not error | `content: [[ unknown balance ]]` with concreteness < 1.0 |
| Logs queryable with same interface as business data | `agentLogs` uses same `HistoricalStream` and `HistoricalEntry` types |
| Multiple streams mergeable by timestamp | `MergedView << { sources: ref(agentLogs) }` with timestamp ordering |
| Compaction preserves current state | `CompactionPolicy << { retainCurrent: true }` |
| Pagination for large result sets | `PageRequest` with pageSize and offset |
