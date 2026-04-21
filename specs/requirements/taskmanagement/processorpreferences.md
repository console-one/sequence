# Processor Preferences

## Problem Context

- **Actor(s)**: Processes (declare capabilities as typed functions), Tasks (have typed output requirements), a matching system (connects tasks to capable processes)
- **Domain**: Work routing -- matching tasks to processors based on structural type compatibility rather than explicit configuration, affinity rules, or priority scores
- **Core Tension**: Preference must not be a separate configuration that goes stale. It must be derived from what a process can actually produce versus what a task actually needs. When multiple processors match, ranking must be by specificity, not by manual weighting.

## Requirements

**R1**: A process SHALL declare its capability as a typed function with explicit input and output types.
- *Rationale*: The function signature is the single source of truth for what a process can do. No separate preference config.
- *Verifiable by*: Registering a process with a typed function signature and confirming the input/output types are queryable.

**R2**: The system SHALL find all capabilities whose output type is structurally compatible with a task's output requirement.
- *Rationale*: Matching is structural subtyping -- a capability matches if its output satisfies (is a subtype of or equal to) the requirement.
- *Verifiable by*: A task requiring `{summary, wordCount}` matches a capability producing `{summary, wordCount}` but not one producing `{translatedText}`.

**R3**: When multiple capabilities match a task's requirement, the system SHALL rank them by specificity of the output type match.
- *Rationale*: A more specific match (more fields satisfied, narrower types, fewer unmatched fields) is a better match. No manual priority scores.
- *Verifiable by*: A capability producing exactly `{summary, wordCount}` ranks above one producing a supertype like `{summary, text}` for a requirement of `{summary, wordCount}`.

**R4**: An incompatible capability (output type does not satisfy the requirement) SHALL be excluded from match results entirely.
- *Rationale*: Irrelevant capabilities must not pollute the candidate list.
- *Verifiable by*: A translator capability is not returned when matching against a summary requirement.

**R5**: When exactly one capability matches a task's requirement, assignment SHALL be automatic with no external coordination.
- *Rationale*: Single-match cases need no human or dispatcher intervention.
- *Verifiable by*: A task with one matching capability is assigned to that capability without manual action.

**R6**: When multiple capabilities match, the system SHALL surface the ranked candidate list for selection rather than assigning arbitrarily.
- *Rationale*: Ambiguous routing should be explicit, not silently resolved by an arbitrary tiebreaker.
- *Verifiable by*: Two matching capabilities result in a ranked list being surfaced rather than one being auto-assigned.

**R7**: The system SHALL determine whether a matched capability can execute immediately by checking whether its required input is currently available.
- *Rationale*: A match means the capability could do the work; executability means it can do it right now.
- *Verifiable by*: A capability requiring `{text, format}` when only `{text}` is available is reported as matched but not yet executable, with `format` identified as missing.

**R8**: Missing input fields for a matched capability SHALL be surfaced as identifiable missing items.
- *Rationale*: The system must tell the user or upstream process exactly what is needed to unblock execution.
- *Verifiable by*: The missing field name(s) are reported when a capability is matched but not executable.

**R9**: When no single capability satisfies a requirement, the system SHALL discover multi-step chains where one capability's output feeds another's input to satisfy the requirement.
- *Rationale*: Composite workflows emerge from capability composition without manual pipeline definition.
- *Verifiable by*: A requirement for "translated summary" is satisfied by chaining a translator (text -> translatedText) and a summarizer (text -> summary) when neither alone suffices.

**R10**: Chain discovery SHALL be bounded to a configurable maximum depth.
- *Rationale*: Unbounded search risks combinatorial explosion.
- *Verifiable by*: Setting chain depth to 2 and confirming that 3-step chains are not explored.

## Acceptance Criteria

**AC1** [R1]: Given a process registering a capability with input type `{text, format}` and output type `{summary, wordCount}`, when the capability is queried, then the input and output types are returned.

**AC2** [R2]: Given a task requiring output `{summary, wordCount}`, when searching for matching capabilities, then a summarizer producing `{summary, wordCount}` is returned and a translator producing `{translatedText}` is not.

**AC3** [R3]: Given two capabilities matching a task -- one producing exactly `{summary, wordCount}` and one producing `{summary, wordCount, metadata}` -- when ranked, then the exact match ranks higher.

**AC4** [R4]: Given a task requiring `{summary, wordCount}`, when a translator producing `{translatedText}` is evaluated, then it is excluded with a zero compatibility score.

**AC5** [R5]: Given a task with exactly one matching capability, when the match is resolved, then the task is assigned to that capability automatically.

**AC6** [R7, R8]: Given a matched capability requiring input `{text, format}` and current state containing only `{text}`, when executability is checked, then the capability is reported as not yet executable with `format` identified as missing.

**AC7** [R9]: Given a requirement for translated summaries, and a translator (text -> translatedText) plus a summarizer (translatedText -> summary), when chain discovery runs, then the two-step chain is found.

**AC8** [R10]: Given chain depth configured to 2, when a requirement would need a 3-step chain, then no chain is discovered.

## Open Questions

- How are capability registrations updated or revoked when a process goes offline?
- What happens when a capability's input type changes after tasks have already been matched to it?
- Should chain discovery prefer shorter chains over longer ones, or should specificity still dominate ranking?
