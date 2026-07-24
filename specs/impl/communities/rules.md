# Community Rules

Communities need governance, but governance in a distributed system cannot rely on a single authority making every decision in real time. Rules must be declarative (defined upfront, evaluable by any participant independently), composable (multiple rules coexist with deterministic interactions), and versioned (rule changes do not retroactively invalidate past actions that were valid under the old rules).

The key types of rules are permissions (who may do what), quotas (how much of a resource someone may use), approvals (which actions require multi-party sign-off), and temporal rules (permissions that activate or expire based on time). All share the same structure: a condition, a consequence, a scope, and a version.

## The Rule Type

A rule is a declarative condition-consequence pair with scope and version tracking:

```ft
Rule = {
  name: string,
  ruleType: "permission" | "quota" | "approval" | "temporal",
  scope: string,
  version: number.integer >= 1,
  active: boolean,
  description: string
}
```

The `scope` determines who the rule applies to -- a role, a specific participant, or the entire community. The `version` tracks which iteration of the rule is in effect. When a rule is updated, the version increments and past actions are evaluated against the version that was active when they occurred.

## Permission Rules

A permission rule controls who may perform which action on which resource:

```ft
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
```

```ft
editorWrite = PermissionRule
editorWrite << {
  name: "editor-write",
  ruleType: "permission",
  scope: "role=editor",
  version: 1,
  active: true,
  action: "write",
  resource: "documents",
  allowed: true
}
```

A member with `role=editor` can write to documents. A member with `role=viewer` is not covered by this rule's scope -- the write is blocked (assuming default-deny). Permission evaluation is deterministic: given the same state and rules, any participant arrives at the same allow/deny conclusion.

## Quota Rules

A quota rule limits how much of a resource a participant may use:

```ft
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
```

```ft
apiQuota = QuotaRule
apiQuota << {
  name: "api-call-limit",
  ruleType: "quota",
  scope: "all-members",
  version: 1,
  active: true,
  resource: "api-calls",
  limit: 100,
  currentUsage: 0
}
```

Each action that consumes the resource increments usage:

```ft
apiQuota << { currentUsage: prev + 1 }
```

When `currentUsage` reaches `limit`, further actions on that resource are blocked. The 100th call succeeds. The 101st is blocked. Usage tracking via `prev + 1` ensures each consumption is counted, and the limit check is against the running total.

## Approval Rules

An approval rule requires multi-party sign-off before an action takes effect:

```ft
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
```

```ft
deleteApproval = ApprovalRule
deleteApproval << {
  name: "delete-database-approval",
  ruleType: "approval",
  scope: "role=admin",
  version: 1,
  active: true,
  requiredApprovals: 2,
  currentApprovals: 0,
  approvers: "alice,bob,carol",
  status: "pending"
}
```

Each approver's sign-off increments the approval count:

```ft
deleteApproval << { currentApprovals: prev + 1 }
```

When `currentApprovals` reaches `requiredApprovals`, the action takes effect and the status transitions:

```ft
deleteApproval << { status: "approved" when currentApprovals = 2 }
```

Until then, the action remains pending. One approval out of two required: pending. Two out of two: approved, action proceeds.

## Temporal Rules

A temporal rule is active only during a specified time window:

```ft
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

```ft
contractorAccess = TemporalRule
contractorAccess << {
  name: "contractor-access",
  ruleType: "temporal",
  scope: "role=contractor",
  version: 1,
  active: true,
  windowStart: 32400000,
  windowEnd: 61200000
}
```

The rule is active when the current time falls within `[windowStart, windowEnd)`. A contractor accessing the system at 16:59 (within the window) is allowed. At 17:01 (outside the window), the permission is inactive. Temporal evaluation is a predicate on stored values against current time -- no timer callbacks.

## Rule Versioning

When a rule changes, the version increments. Past actions are evaluated against the version that was active when they occurred:

```ft
editorWrite << { version: prev + 1, limit: 20 }
```

A file uploaded under version 1 (limit 50MB) is not retroactively flagged when version 2 (limit 20MB) takes effect. The action was valid at the time. New actions are evaluated against the current version.

## Rule Composition

Multiple rules applying to the same action produce a deterministic combined outcome. Composition is priority-based: when a permission rule allows an action but a quota rule blocks it, the quota block prevails. When two rules conflict at the same priority, the system requires explicit conflict resolution from the administrator rather than silently choosing one.

Rules within the same scope compose conjunctively by default -- all applicable rules must allow the action for it to proceed. This means any single blocking rule is sufficient to deny an action.

## Capabilities

Rule operations -- evaluation, version tracking, approval counting, and temporal checking -- are provided by the rule engine:

```ft
cap Rule.active
cap Rule.version
cap QuotaRule.currentUsage
cap ApprovalRule.currentApprovals
cap ApprovalRule.status
cap TemporalRule.active
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Declarative rule with condition and consequence | `Rule` type with ruleType, scope, version, active |
| Permission enforcement | `editorWrite` allows editors to write; viewers are blocked |
| Quota enforcement with limit | `currentUsage: prev + 1` tracked; call 101 blocked at limit 100 |
| Scoped rules apply only to matching participants | `scope: "role=editor"` does not affect viewers |
| Rule versioning preserves past validity | Version increments; old actions evaluated against old version |
| Approval workflow with threshold | `currentApprovals: prev + 1`; status "approved" when threshold met |
| Temporal rule with time window | Active within `[windowStart, windowEnd)`, inactive outside |
| Deterministic evaluation | Same state + same rules = same answer for any participant |
| Rule composition is priority-based | Quota block overrides permission allow; same-priority conflicts require resolution |
| Rules are human-readable | `description` field on Rule type |
