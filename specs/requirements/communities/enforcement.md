# Community Enforcement

## Problem Context

- **Actor(s)**: Community participants (acting independently), administrators (defining constraints), the enforcement system (evaluating and recording decisions).
- **Domain**: Constraint enforcement in distributed communities. Participants act independently and may violate rules before violations can be detected. Enforcement must operate in two modes: preventive (blocking locally-checkable violations before they take effect) and corrective (detecting violations that only become visible after concurrent actions merge).
- **Core Tension**: In a centralized system, every action is validated before it takes effect. In a distributed community, participants act concurrently -- two participants may each perform individually-valid actions that together violate a constraint. Enforcement must handle both the easy case (local checks) and the hard case (post-merge detection), and every enforcement decision must be visible and auditable.

## Requirements

**R1**: A constraint SHALL be a declarative, inspectable record with a name, threshold, scope, priority, and active/inactive status.
- *Rationale*: Constraints must be readable by any participant. If a participant cannot inspect the rules, they cannot understand why their action was blocked.
- *Verifiable by*: Any participant can query a constraint and see its name, threshold, scope, priority, and whether it is active.

**R2**: Constraints SHALL be parameterizable -- the same constraint structure SHALL be usable with different thresholds in different scopes.
- *Rationale*: A storage limit of 100 units for a free community and 1000 units for a paid community is the same rule with different parameters. Separate constraint types for each would be redundant.
- *Verifiable by*: The same constraint type is instantiated with threshold 100 for scope A and threshold 1000 for scope B, and each enforces its own threshold independently.

**R3**: The system SHALL support preventive enforcement -- when a constraint violation can be detected locally before an action takes effect, the action SHALL be blocked before execution.
- *Rationale*: If a participant at 95 units of usage attempts to add 10 (exceeding a 100-unit limit), the violation is locally detectable and should be blocked immediately rather than allowed and corrected later.
- *Verifiable by*: A participant at 95 units attempts to add 10 with a 100-unit limit. The action is blocked. The participant receives an explanation identifying the constraint, current usage, attempted addition, and threshold.

**R4**: The system SHALL support corrective enforcement -- when concurrent actions individually pass local checks but their merged result violates a constraint, the violation SHALL be detected after merge and surfaced as a visible record.
- *Rationale*: Two participants each adding 40 units to a community with 30 already used produces a merged total of 110, exceeding a 100-unit limit. Neither action was individually invalid, but the combined result is. This violation can only be detected after merge.
- *Verifiable by*: Two concurrent additions that individually pass local checks but together exceed the limit produce a violation record after merge, identifying the constraint, actual total, and involved participants.

**R5**: Every enforcement decision -- whether a block, an allowance, or a detected violation -- SHALL be recorded in an auditable log with timestamp, actor, action, constraint, decision, and reason.
- *Rationale*: Enforcement must never be silent. Administrators need to review enforcement history. Participants need to understand why their actions were blocked.
- *Verifiable by*: After any enforcement decision, the audit log contains an entry with all required fields. The log is queryable by constraint, actor, decision type, and time range.

**R6**: When two constraints conflict (one allows an action, another blocks it), the constraint with higher priority SHALL prevail. When two constraints conflict at the same priority, the system SHALL require explicit resolution rather than silently choosing one.
- *Rationale*: A "minimum allocation per member" rule (priority 2) may override a "total cap" rule (priority 1) by design. But same-priority conflicts are ambiguous and must not be auto-resolved, as either outcome could be wrong.
- *Verifiable by*: A higher-priority constraint overrides a lower-priority one. Two same-priority conflicting constraints produce an explicit conflict requiring administrator resolution.

**R7**: Detected post-merge violations SHALL trigger a resolution process -- the system SHALL NOT silently accept a constraint violation.
- *Rationale*: A violation left unaddressed undermines the constraint system. Even if the resolution is "log and accept as a known trade-off", it must be an explicit decision.
- *Verifiable by*: After a post-merge violation is detected, a resolution record is created. The violation is not simply absorbed into the state without acknowledgment.

## Data Model

```ft
Constraint = {
  name: string,
  threshold: number,
  scope: string,
  priority: number.integer >= 0,
  active: boolean
}

AuditEntry = {
  timestamp: number.integer >= 0,
  actor: string,
  action: string,
  constraint: string,
  decision: "blocked" | "allowed" | "violation-detected",
  reason: string
}
```

## Acceptance Criteria

**AC1** [R1]: Given constraint "storage-limit" with threshold 100, scope "community-A", priority 1, active true, when any participant queries it, then all fields are visible.

**AC2** [R2]: Given "storage-limit" instantiated with threshold 100 for community-A and threshold 1000 for community-B, when a participant in community-A attempts to exceed 100, then it is blocked, while a participant in community-B at 500 is allowed.

**AC3** [R3]: Given a participant at 95 units of usage with a 100-unit limit, when they attempt to add 10 units, then the action is blocked with a message identifying the constraint, current usage (95), attempted addition (10), and threshold (100).

**AC4** [R4]: Given a community at 30 units with a 100-unit limit, when participant A adds 40 and participant B concurrently adds 40 (each individually valid), then after merge the system detects a violation (total 110 > limit 100) and produces a violation record identifying both participants.

**AC5** [R5]: Given the block in AC3, when the audit log is queried, then it contains an entry with timestamp, actor "member-A", action "add-10-units", constraint "storage-limit", decision "blocked", and a human-readable reason.

**AC6** [R6]: Given constraint "min-per-member" at priority 2 requiring 10 units per new member and constraint "storage-limit" at priority 1 capping total usage, when adding a new member would exceed the total cap, then the higher-priority "min-per-member" prevails and the over-limit state is logged.

**AC7** [R6]: Given two constraints at priority 1 that disagree on whether an action is allowed, when the action is attempted, then the system surfaces a conflict requiring administrator resolution rather than silently choosing one.

**AC8** [R7]: Given a post-merge violation detected in AC4, then a resolution process is initiated and the violation is not silently accepted.

## Open Questions

- What resolution strategies should be available for post-merge violations? Options: rollback last action, proportional reduction, administrator manual resolution.
- Should constraints support expiration (e.g., a temporary elevated limit during a promotion period)?
- How should constraint changes propagate to participants who have already cached the old constraint values?
