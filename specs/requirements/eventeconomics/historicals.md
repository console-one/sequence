# Historicals

## Original Notes

This would just be certain utilities that we use to perform Excel-like aggregations or querying on historical streams of data. Let's say we have some accounting data, which is like historical bank statements. It's clear that, when we set up the server, the process normally, we only write facts to history once we have crossed the real-time threshold. Those are facts about the server at history, so we can continue to have all of the facts about external to the partition's history somewhere in belief space. Those would also be types with timestamps, but I don't know how we would even necessarily apply the time index or the real-time index. I guess it would be an assumed real-time value for the aggregations of historical events, just like we have for concreteness of a particular type at a particular time where we don't know its full value. Maybe we just use the same thing to display it, to describe portions of historical space-time outside of the partition that we don't know about. We can only make assumptions, and then we just use whatever tools we established to build those function interpolations for those periods. We can just extend them in the future for those same partitions and the planning scenario, and then use those to build discrete event simulation inputs for scenarios where plan space converges down to real time.

These historicals would also be used for system logs and facts about the system, because all of our logs for different processes are being written to some historical database. Building our indexing layer over different log streams that are appropriately snapshotted should enable us to compute metrics, or, over the last month, find all the instructions I gave to an agent that looked like this. We would just be able to merge the proofs, the proof streams, with events where message equals whatever my username is, and merge those by time, which is pretty easy on a host that gets spun up or even locally. Then paginate through that merged query and grep each page or whatever.

Historical data is an append-only, temporally ordered stream of facts. The core challenge is supporting point-in-time queries (what was the balance in January?), range aggregations (average balance over Q1), and cross-stream merges (join agent logs with user commands by timestamp) -- all through a single query interface that works identically for business data and system logs. Unknown historical periods are gaps with uncertainty, not missing data.

Facts are only written to history once the real-time threshold has been crossed. Everything before now is confirmed past; everything after is forecast. This boundary matters because history is authoritative and append-only, while forecasts are provisional and replaceable.

## Problem Context

- **Actor(s)**: Users querying business data (e.g., bank statements, accounting records); operators querying system logs; the ingestion pipeline that writes facts to history.
- **Domain**: Temporal data management -- append-only streams of timestamped facts that support point-in-time lookup, range aggregation, cross-stream merging, and pagination.
- **Core Tension**: A single query interface must serve both business data and system logs, handle unknown historical periods as uncertainty rather than errors, and enforce the real-time threshold that separates authoritative history from provisional forecasts.

## Requirements

**R1**: Historical entries SHALL be append-only, timestamped, and temporally ordered within their stream.
- *Rationale*: Append-only semantics guarantee that confirmed facts are never silently mutated, which is essential for auditability and trust.
- *Verifiable by*: Once an entry is written, it cannot be modified or deleted through normal operations; entries are retrievable in timestamp order.

**R2**: The system SHALL support point-in-time queries that return the recorded value at a specific timestamp.
- *Rationale*: Users need to answer questions like "what was the balance in January?" without scanning the entire history.
- *Verifiable by*: Querying a stream at timestamp T returns the entry recorded at T (or indicates no entry exists at T).

**R3**: The system SHALL support range aggregations (sum, average, count, min, max) over entries within a specified time range.
- *Rationale*: Business analysis requires summarizing data across periods (e.g., average balance over Q1, total revenue for the year).
- *Verifiable by*: A range aggregation query over timestamps 1-3 with method "average" returns the mean of the values at those timestamps.

**R4**: When no data exists for a queried historical period, the system SHALL return an explicit uncertainty marker rather than an error or null.
- *Rationale*: Absence of data is not the same as "the value was zero" or "the query failed." Unknown periods should be honest about their uncertainty so downstream consumers (interpolation, forecasting) can treat them accordingly.
- *Verifiable by*: Querying a timestamp with no recorded entry returns an uncertainty indicator that includes the expected schema (e.g., "this should be a number, but we do not know which").

**R5**: System logs and business data SHALL use the same entry format and be queryable through the same interface.
- *Rationale*: Maintaining separate query systems for logs vs. business data doubles the surface area and prevents cross-domain analysis (e.g., correlating agent actions with financial events).
- *Verifiable by*: An agent log entry and a bank balance entry are both queryable with the same API; a query filtered by source returns only the relevant stream.

**R6**: Multiple streams SHALL be mergeable into a single time-ordered view, interleaved by timestamp.
- *Rationale*: Users need to correlate events across streams (e.g., "show me agent instructions alongside system responses, ordered by time").
- *Verifiable by*: Merging two streams with interleaved timestamps produces a single ordered sequence containing all entries from both streams.

**R7**: Merged and single-stream query results SHALL support pagination with stable ordering across page boundaries.
- *Rationale*: Historical streams can be arbitrarily large; loading entire histories into memory is impractical.
- *Verifiable by*: Requesting page 1 (size 10) then page 2 (size 10) returns 20 distinct entries in correct temporal order with no duplicates or gaps.

**R8**: Entries with timestamps at or before the current real-time boundary SHALL be treated as authoritative history; entries with future timestamps SHALL be rejected from the historical stream.
- *Rationale*: The real-time threshold separates confirmed fact from speculation. Allowing future-timestamped entries into history would compromise the reliability guarantee.
- *Verifiable by*: Writing an entry with a past timestamp succeeds; writing an entry with a future timestamp is rejected (or routed to a forecast system).

**R9**: Old entries SHALL be compactable into summaries to manage storage, while preserving the current materialized state and allowing access to archived detail through cold storage.
- *Rationale*: Unbounded history growth is a storage problem, but users still need current values to be immediately available and old detail to be retrievable.
- *Verifiable by*: After compaction, the latest values are directly readable with no performance change; archived entries are retrievable but may have higher latency.

## Acceptance Criteria

**AC1** [R1, R2]: Given a stream "checking-account" with entries at timestamps 1 (50000), 2 (47500), 3 (52000), when querying timestamp 2, then 47500 is returned.

**AC2** [R3]: Given entries at timestamps 1 (50000), 2 (47500), 3 (52000), when computing the average over range [1, 3], then 49833.33 (or equivalent) is returned.

**AC3** [R4]: Given no entry exists at timestamp 4 in the "checking-account" stream, when querying timestamp 4, then an uncertainty marker is returned indicating the value is an unknown number (not an error, not null).

**AC4** [R5]: Given a business stream "checking-account" and a log stream "agent-01" both containing timestamped entries, when querying with source="agent-01", then only agent log entries are returned; when querying without a source filter, both are accessible.

**AC5** [R6]: Given stream A with entries at times [1, 3, 5] and stream B with entries at times [2, 4], when merged, then the result is a single sequence ordered [1, 2, 3, 4, 5] with deterministic ordering for ties.

**AC6** [R7]: Given a merged result of 50 entries, when requesting page 1 (size 20, offset 0) then page 2 (size 20, offset 20), then 40 distinct entries are returned in order with no overlap.

**AC7** [R8]: Given the current time is T=10, when writing an entry with timestamp 5, then it is accepted into history; when writing an entry with timestamp 15, then it is rejected from the historical stream.

**AC8** [R9]: Given a compaction threshold of 100, when compaction runs, then entries older than 100 are archived, the latest values are unchanged and immediately readable, and archived entries are retrievable via cold storage.

## Open Questions

- What determines merge ordering when two entries from different streams share the same timestamp? Source ID? Stream priority?
- Should range aggregations over periods that include unknown gaps report the gap as part of their result (e.g., "average of 3 known values out of 4 periods"), or silently exclude gaps?
- What is the contract for cold storage access latency after compaction -- is there an SLA, or is it best-effort?
