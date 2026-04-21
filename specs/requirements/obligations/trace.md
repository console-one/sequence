# Trace

## Original Notes

Given a closed obligation, the trace is the ordered subsequence of proof steps that contributed to closing it. It answers "how was this fulfilled?" with a chronological account: what was required (schema declaration), what was provided (value bindings), and how it was produced (capability usage). Invalidated steps are excluded -- the trace is the active proof chain, not the full history.

The tension is between completeness and compaction. The underlying data is append-only and may be compacted -- old entries archived, intermediate steps collapsed. The trace must work across this boundary: detailed when data is available, preserving at minimum the closure fact when data is compacted. Traces are never stored as first-class values; they are derived on demand from the existing log.

## Problem Context

- **Actor(s)**: Auditors (reviewing how an obligation was fulfilled), the system (computing traces on demand from the log), administrators (managing compaction that affects trace detail).
- **Domain**: Obligation audit and provenance, where the system must explain how each obligation was fulfilled through an ordered chain of evidence, resilient to log compaction.
- **Core Tension**: Traces must be detailed when full history is available but degrade gracefully when intermediate steps are compacted, always preserving at minimum the closure fact. Traces are computed on demand (not pre-stored), so the log is the sole source of truth.

## Requirements

**R1**: The system SHALL compute a trace for any obligation on demand, returning an ordered sequence of proof steps that contributed to closing it.
- *Rationale*: On-demand computation avoids storing redundant data; the log is the single source of truth.
- *Verifiable by*: Requesting a trace for a closed obligation returns an ordered list of contributing steps.

**R2**: Each trace entry SHALL include a sequence number, the affected path, the operation type (schema declaration, value binding, or capability usage), a timestamp, and validity status.
- *Rationale*: This metadata is the minimum required for meaningful audit.
- *Verifiable by*: Every entry in a trace contains all five fields with accurate values.

**R3**: Trace entries SHALL be returned in sequence number order, respecting causality.
- *Rationale*: Chronological ordering reflects the actual sequence of events that led to closure.
- *Verifiable by*: The sequence numbers in a trace are strictly increasing.

**R4**: Invalidated steps (superseded writes, broken conditions) SHALL be excluded from the default trace view.
- *Rationale*: The default trace shows the active proof chain; including invalidated steps would misrepresent the current state of the proof.
- *Verifiable by*: A step that was later invalidated does not appear in the default trace.

**R5**: If an invalidated step was the sole provider of a required property, the obligation SHALL show as open and the trace SHALL reflect that status.
- *Rationale*: An obligation with a broken proof chain is no longer fulfilled.
- *Verifiable by*: After invalidation of a sole-provider step, the trace shows status "open" and the obligation reappears.

**R6**: Full history (including invalidated steps) SHALL be available on explicit request.
- *Rationale*: Some audit scenarios require seeing the complete history, including false starts and superseded values.
- *Verifiable by*: Requesting full history returns all steps, including those marked invalid.

**R7**: The system SHALL compute a dependency chain (directed acyclic graph) showing which values fed into which for complex obligations.
- *Rationale*: Multi-step obligations involve derived values; the dependency chain shows provenance.
- *Verifiable by*: For an obligation depending on A -> B -> C, the chain shows both edges and the capabilities involved.

**R8**: Circular dependencies in the dependency chain SHALL be detected and reported.
- *Rationale*: Cycles indicate logical errors in the proof chain; they must be surfaced, not silently ignored.
- *Verifiable by*: A chain with a cycle sets a circular flag and reports the cycle path.

**R9**: The closure fact (which step closed the obligation) SHALL survive log compaction; after compaction, the system SHALL still be able to confirm that an obligation was closed and identify the closure step.
- *Rationale*: Compaction trades detail for storage, but the most critical audit fact (was it closed, and by what) must never be lost.
- *Verifiable by*: After compaction of intermediate steps, the closure step is still retrievable and the trace reports the compacted range.

**R10**: Compacted ranges SHALL be identified in the trace so auditors know which portions of the proof history have reduced detail.
- *Rationale*: Auditors must know when they are seeing compressed history vs. full-fidelity history.
- *Verifiable by*: The trace includes a compacted range indicator (e.g., "steps N-M: archived") when applicable.

**R11**: The trace SHALL be renderable into human-readable text showing the obligation path, status, proof step count, and per-step details.
- *Rationale*: Auditors consume traces as readable reports, not raw data structures.
- *Verifiable by*: The rendered output includes the obligation path, OPEN/CLOSED status, total step count, and per-step details (sequence number, operation type, path, timestamp, gating flags).

## Acceptance Criteria

**AC1** [R1, R2, R3]: Given a closed obligation with 3 contributing proof steps, when the trace is requested, then it returns 3 entries in sequence order, each with sequence number, path, operation type, timestamp, and validity.

**AC2** [R4, R5]: Given a trace with a step that was later invalidated, when the default trace is requested, then the invalidated step is excluded; if it was the sole provider, the obligation shows as open.

**AC3** [R6]: Given a trace with invalidated steps, when full history is explicitly requested, then all steps (including invalid ones) are returned.

**AC4** [R7, R8]: Given an obligation depending on a chain A -> B -> C, when the dependency chain is computed, then it shows edges A->B and B->C; if a cycle exists, the circular flag is set.

**AC5** [R9, R10]: Given a closed obligation whose intermediate steps have been compacted, when the trace is requested, then the closure step is present, the compacted range is identified, and the system confirms the obligation was closed.

**AC6** [R11]: Given a trace, when rendered to text, then the output includes the obligation path, status, step count, and per-step audit details including any conditional/temporal gating flags.

## Open Questions

- Should traces include a reference to the specific capability version that produced each binding step?
- When compaction removes intermediate steps, should the trace include a summary of what was lost (e.g., "3 binding steps archived") or just the range?
