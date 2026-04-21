# Community Rules

## Problem Context

- **Actor(s)**: Community administrators (defining rules), participants (subject to rules), the rule engine (evaluating rules deterministically).
- **Domain**: Declarative governance for distributed communities. Rules cover permissions (who may do what), quotas (resource usage limits), approvals (multi-party sign-off), and temporal access (time-windowed permissions). Rules must be evaluable independently by any participant, composable when multiple rules apply, and versioned so that rule changes do not retroactively invalidate past actions.
- **Core Tension**: Governance in a distributed system cannot rely on a single authority making every decision in real time. Rules must be declarative enough that any participant can evaluate them locally and arrive at the same conclusion. But rules interact -- a permission rule may allow an action that a quota rule blocks -- and these interactions must be resolved deterministically.

## Requirements

**R1**: A rule SHALL be a declarative record with a type, scope, version, active/inactive status, and human-readable description.
- *Rationale*: Rules must be inspectable by participants and administrators. A rule that cannot be read cannot be understood or challenged.
- *Verifiable by*: Any participant can query a rule and see its type, scope, version, status, and description.

**R2**: The system SHALL support permission rules that control which actions a scoped set of participants may perform on which resources. The default policy SHALL be deny -- actions not explicitly permitted are blocked.
- *Rationale*: Permission rules are the foundation of access control. Default-deny ensures that missing rules do not accidentally grant access.
- *Verifiable by*: A participant with role "editor" is permitted to write to "documents" by a matching rule. A participant with role "viewer" (not covered by any write-permission rule) is blocked.

**R3**: The system SHALL support quota rules that limit how much of a resource a participant or group may consume. Usage SHALL be tracked incrementally, and actions that would exceed the limit SHALL be blocked.
- *Rationale*: Resource limits prevent abuse and ensure fair usage. Incremental tracking ensures every consumption event is counted.
- *Verifiable by*: A quota of 100 API calls allows the 100th call and blocks the 101st.

**R4**: The system SHALL support approval rules that require a specified number of approvals from designated approvers before an action takes effect. The action SHALL remain pending until the approval threshold is met.
- *Rationale*: Sensitive actions (e.g., deleting a database) should require multi-party sign-off. The pending state prevents premature execution.
- *Verifiable by*: An action requiring 2 approvals from a pool of 3 designated approvers remains pending after 1 approval and becomes approved after 2.

**R5**: The system SHALL support temporal rules that are active only during a specified time window. Outside the window, the rule is inactive and does not apply.
- *Rationale*: Some permissions are time-bounded (contractor access during business hours, promotional pricing during a campaign). Temporal rules express this without manual toggling.
- *Verifiable by*: A temporal rule with window [09:00, 17:00) permits access at 16:59 and denies access at 17:01.

**R6**: Rules SHALL be versioned. When a rule is updated, the version SHALL increment. Past actions SHALL be evaluated against the rule version that was active when the action occurred -- rule changes SHALL NOT retroactively invalidate past actions.
- *Rationale*: A file uploaded under a 50MB limit (rule v1) should not be flagged when the limit changes to 20MB (rule v2). Retroactive invalidation is unjust and operationally disruptive.
- *Verifiable by*: An action valid under rule v1 remains recorded as valid after the rule is updated to v2 with stricter criteria.

**R7**: When multiple rules apply to the same action, they SHALL compose deterministically. Rules at different priorities SHALL resolve with higher priority prevailing. Rules at the same priority SHALL compose conjunctively -- all must allow the action for it to proceed.
- *Rationale*: A permission rule allowing an action and a quota rule blocking it must produce a deterministic outcome. Conjunctive composition (all must allow) is the safe default -- any single blocking rule is sufficient to deny.
- *Verifiable by*: A permission rule allows an action but a higher-priority quota rule blocks it: the action is blocked. Two same-priority rules both allow: the action proceeds. Two same-priority rules where one blocks: the action is blocked.

**R8**: Rule evaluation SHALL be deterministic -- given the same state and the same set of active rules, any participant evaluating the rules SHALL arrive at the same allow/deny conclusion.
- *Rationale*: Non-deterministic rule evaluation means different participants disagree on what is allowed, leading to inconsistent enforcement. Determinism is a prerequisite for distributed governance.
- *Verifiable by*: Two participants with identical state and rules independently evaluate the same action and produce the same result.

**R9**: When two rules at the same priority produce conflicting outcomes (one allows, one blocks), the system SHALL require explicit conflict resolution from an administrator rather than silently choosing one.
- *Rationale*: Same-priority conflicts are ambiguous by definition. Either outcome could be wrong. Forcing explicit resolution prevents hidden policy decisions.
- *Verifiable by*: Two same-priority rules with conflicting outcomes for the same action produce a conflict record requiring administrator resolution.

## Data Model

```ft
Rule = {
  name: string,
  ruleType: "permission" | "quota" | "approval" | "temporal",
  scope: string,
  version: number.integer >= 1,
  active: boolean,
  description: string
}

PermissionRule = {
  name: string,
  ruleType: "permission",
  scope: string,
  version: number.integer >= 1,
  active: boolean,
  action: "read" | "write" | "delete",
  resource: string,
  allowed: boolean
}

QuotaRule = {
  name: string,
  ruleType: "quota",
  scope: string,
  version: number.integer >= 1,
  active: boolean,
  resource: string,
  limit: number >= 0,
  currentUsage: number >= 0
}

ApprovalRule = {
  name: string,
  ruleType: "approval",
  scope: string,
  version: number.integer >= 1,
  active: boolean,
  requiredApprovals: number.integer >= 1,
  currentApprovals: number.integer >= 0,
  approvers: string,
  status: "pending" | "approved" | "rejected"
}

TemporalRule = {
  name: string,
  ruleType: "temporal",
  scope: string,
  version: number.integer >= 1,
  active: boolean,
  windowStart: number.integer >= 0,
  windowEnd: number.integer >= 0
}
```

## Acceptance Criteria

**AC1** [R2]: Given a permission rule allowing role "editor" to write to "documents", when an editor attempts to write, then the action is allowed. When a viewer (not covered by any write rule) attempts to write, then the action is denied.

**AC2** [R3]: Given a quota rule with limit 100 for "api-calls", when the 100th call is made, then it succeeds. When the 101st call is made, then it is blocked.

**AC3** [R4]: Given an approval rule requiring 2 approvals from [alice, bob, carol] for "delete-database", when alice approves, then status is "pending". When bob approves, then status is "approved" and the action takes effect.

**AC4** [R5]: Given a temporal rule with window [09:00, 17:00) for "contractor" scope, when a contractor accesses the system at 16:59, then access is permitted. When they access at 17:01, then access is denied.

**AC5** [R6]: Given a quota rule v1 with limit 50, when an action consuming 45 units is performed under v1, and the rule is then updated to v2 with limit 20, then the v1 action remains recorded as valid.

**AC6** [R7]: Given a permission rule (priority 1) allowing a write and a quota rule (priority 2) blocking it due to exceeded limit, when the write is attempted, then the higher-priority quota rule prevails and the write is blocked.

**AC7** [R7]: Given two same-priority rules where one allows and one blocks the same action, when the action is attempted, then it is blocked (conjunctive composition).

**AC8** [R8]: Given identical state and rules, when two independent participants evaluate the same action, then both produce the same allow/deny result.

**AC9** [R9]: Given two priority-1 rules that explicitly conflict (one allows with rationale X, one blocks with rationale Y), when the action is attempted, then a conflict record is produced requiring administrator resolution.

**AC10** [R1]: Given any rule in the system, when a participant queries it, then all fields (type, scope, version, status, description) are visible.

## Open Questions

- Should rules support inheritance (a rule applying to "all-members" is inherited by sub-scopes like "role=editor")?
- How should rule conflicts be presented to administrators for resolution -- as a diff, a prioritization prompt, or a merge interface?
- Should temporal rules support recurring windows (e.g., "every weekday 9-17") or only absolute time ranges?
- What happens when an approval rule's designated approvers are modified while approvals are in flight?
