# Trace

Given a closed obligation, the trace is the ordered subsequence of proof steps that contributed to closing it. It answers "how was this fulfilled?" with a chronological account: what was required (schema declaration), what was provided (value bindings), and how it was produced (capability usage). Invalidated steps are excluded -- the trace is the active proof chain, not the full history.

The tension is between completeness and compaction. The underlying data is append-only and may be compacted -- old entries archived, intermediate steps collapsed. The trace must work across this boundary: detailed when data is available, preserving at minimum the closure fact when data is compacted. Traces are never stored as first-class values; they are derived on demand from the existing log.

## The Trace Entry

Each entry in a trace corresponds to a proof step -- a state change that contributed to closing an obligation. Entries carry metadata for audit: sequence number, timestamp, and flags for conditional/temporal gating:

```ft
TraceEntry = {
  sequenceNumber: number.integer >= 0,
  path: string,
  operation: "declaration" | "binding" | "capability",
  timestamp: number,
  conditionallyGated: boolean,
  temporallyBounded: boolean,
  valid: boolean
}
```

The `operation` field distinguishes the three types of evidence: schema declarations (what was required), value bindings (what was provided), and capability usages (how values were produced). The `valid` field marks whether this step is still active -- invalidated steps have `valid = false` and are excluded from the default trace view.

## Trace Computation

The trace is a projection over the statement log, filtered to entries relevant to a specific obligation path:

```ft
computeTrace = (input: { obligationPath: string, log: ref(statementLog) }) -> { entries: ref(TraceEntry), status: "open" | "closed" }
```

This is the write-read relationship between the statement log and the trace projection -- behavioral predicate enforcement on observation (does the projected trace accurately reflect the log?) updates reliability priors for the trace computation itself.

Behavioral predicate (prose): the trace includes ALL non-invalidated entries that contributed to the obligation at `obligationPath`, including entries at sub-paths (e.g., "report.sources" contributes to the trace for "report"). Entries are returned in sequence number order, respecting causality. No contributing step is omitted unless it was invalidated. The trace is computed on demand, not pre-stored -- the log IS the source of truth.

## Invalidation Filtering

When a step is invalidated (its condition broke, or it was superseded by a later write), it is excluded from the default trace:

```ft
TraceEntry << { valid: false when conditionPredicate != true }
```

Behavioral predicate (prose): invalidated entries are excluded from the default trace view. The auditor sees only the active proof chain. If the invalidated step was the sole provider of a required property, the obligation reopens and the trace reflects the open status. Full history (including invalidated steps) is available on explicit request but is not the default.

## Dependency Chain

Complex obligations involve derived values. The dependency chain is a directed acyclic graph showing which values fed into which:

```ft
DependencyEdge = {
  fromPath: string,
  toPath: string,
  viaCapability: string
}

dependencyChain = (input: { obligationPath: string }) -> { edges: ref(DependencyEdge), circular: boolean }
```

The chain shows provenance: "report" depends on "sources" and "content"; "sources" was produced by the search capability. If the graph contains cycles (path A depends on path B depends on path A), the `circular` flag is set and the cycle is reported. Circular dependencies indicate a logical error in the proof chain.

## Compaction Resilience

When intermediate steps are compacted, the trace degrades gracefully. The closure fact (which step closed the obligation) always survives:

```ft
CompactedTrace = {
  closureStep: ref(TraceEntry),
  detailedEntries: ref(TraceEntry),
  compactedRange: { fromStep: number.integer >= 0, toStep: number.integer >= 0 }
}
```

Behavioral predicate (prose): after compaction, the `closureStep` is always available -- it is the minimum surviving artifact. `detailedEntries` contains whatever non-compacted steps remain. `compactedRange` identifies the range of steps that were archived. The system can confirm that the obligation was closed and identify the closure step, even if all intermediate steps are lost. This is the compaction contract: detail is traded for storage, but the closure fact is never lost.

## Audit Trail Rendering

The trace is rendered into human-readable text for auditors:

```ft
renderAudit = (input: { trace: ref(CompactedTrace), obligationPath: string }) -> { text: string }
```

Behavioral predicate (prose): the rendered audit trail shows: the obligation path, status (OPEN/CLOSED), total proof step count, and per-step details (sequence number, operation type, path, timestamp, gating flags). Compacted ranges are noted as "steps N-M: archived." Conditional and temporal flags are surfaced so the auditor can see which parts of the proof are contingent on ongoing conditions.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Ordered sequence of proof steps | `computeTrace` returning entries in sequence order |
| Schema, value, and capability entries all present | `TraceEntry.operation`: "declaration", "binding", "capability" |
| Invalidated steps excluded | `valid: false when conditionPredicate != true` filtering |
| Dependency chain as DAG | `dependencyChain` returning edges with circular detection |
| Circular dependency detection | `circular: boolean` flag on dependency chain |
| Human-readable audit trail | `renderAudit` producing text with status, count, per-step details |
| Closure fact survives compaction | `CompactedTrace.closureStep` always present |
| Metadata on each entry | `TraceEntry` with sequenceNumber, timestamp, conditionallyGated, temporallyBounded |
