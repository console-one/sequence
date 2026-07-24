# Community Enforcement

Rules exist. The question is what happens when they are violated. In a centralized system, enforcement is straightforward -- a single authority validates every action before it takes effect. In a distributed community, participants act independently and may violate rules before the violation can be detected. Enforcement must operate in two modes: preventive (blocking actions that would violate locally-checkable constraints before they take effect) and corrective (detecting violations that only become visible after concurrent actions merge).

The critical property: enforcement must never be silent. Every blocked action, every detected violation, every corrective measure must be visible and auditable. Participants must be able to see what rules exist, understand why an action was blocked, and inspect the history of enforcement decisions.

## The Constraint Type

A constraint declares a rule with a threshold, a scope, and a priority. The same constraint structure can be parameterized for different contexts:

```ft
Constraint = {
  name: string,
  threshold: number,
  scope: string,
  priority: number.integer >= 0,
  active: boolean
}
```

```ft
storageLimit = Constraint
storageLimit << {
  name: "storage-limit",
  threshold: 100,
  scope: "community-A",
  priority: 1,
  active: true
}
```

The constraint is readable by any participant. `threshold` is the numeric limit. `scope` determines which participants and resources are subject to the rule. `priority` resolves conflicts when two constraints disagree.

## Parameterized Constraints

The same constraint structure applies with different thresholds in different contexts:

```ft
storageLimitPaid = Constraint
storageLimitPaid << {
  name: "storage-limit",
  threshold: 1000,
  scope: "community-B",
  priority: 1,
  active: true
}
```

Community A has a 100-unit limit. Community B has a 1000-unit limit. Same rule structure, different parameters. No code duplication, no separate constraint types.

## Preventive Enforcement

When a constraint can be checked locally before an action takes effect, preventive enforcement blocks violations. A participant at 95 units attempting to add 10 would exceed the 100-unit limit:

```ft
UsageRecord = {
  participantId: string,
  currentUsage: number >= 0,
  attemptedAdd: number >= 0
}
```

```ft
usage1 = UsageRecord
usage1 << { participantId: "member-A", currentUsage: 95, attemptedAdd: 10 }
```

The action is blocked because `currentUsage + attemptedAdd` (105) exceeds `threshold` (100). The block is immediate -- the action never takes effect. The participant sees why: the constraint, the current usage, the attempted addition, and the threshold are all visible.

## Corrective Enforcement (Post-Merge)

Some violations only become visible after merge. Two participants each adding 40 units to a community with 30 already used produces a merged total of 110, exceeding the 100-unit limit -- even though each individual action was locally valid:

```ft
violation1 = {
  constraint: ref(storageLimit),
  actualTotal: number,
  violatingParticipants: string,
  detectedAt: number.integer >= 0
}
```

```ft
violation1 << {
  constraint: ref(storageLimit),
  actualTotal: 110,
  violatingParticipants: "member-A,member-B",
  detectedAt: 1000
}
```

The violation is detected after merge and surfaced as a visible record. It identifies the constraint, the actual total, and the participants involved. A resolution process is triggered -- the system does not silently accept the violation.

## Audit Trail

Every enforcement action is recorded:

```ft
AuditEntry = {
  timestamp: number.integer >= 0,
  actor: string,
  action: string,
  constraint: string,
  decision: "blocked" | "allowed" | "violation-detected",
  reason: string
}
```

```ft
audit1 = AuditEntry
audit1 << {
  timestamp: 1000,
  actor: "member-A",
  action: "add-10-units",
  constraint: "storage-limit",
  decision: "blocked",
  reason: "Would exceed 100-unit limit (current: 95, attempted: 10)"
}
```

The audit trail is queryable. Administrators can see what was enforced, when, and why. Participants can see why their actions were blocked. No enforcement decision is hidden.

## Constraint Priority

When two constraints conflict -- one says "allow" and one says "block" -- priority determines which prevails:

```ft
minPerMember = Constraint
minPerMember << {
  name: "min-per-member",
  threshold: 10,
  scope: "community-A",
  priority: 2,
  active: true
}
```

If the "min per member" constraint (priority 2) says a new member must get 10 units, but the "storage limit" constraint (priority 1) says the total would exceed the cap, the higher-priority constraint wins. The new member gets their allocation, and the over-limit state is logged as a known trade-off.

## Capabilities

Enforcement operations -- constraint evaluation, violation detection, and audit logging -- are provided by the rule engine:

```ft
cap Constraint.active
cap Constraint.threshold
cap UsageRecord.currentUsage
cap AuditEntry.decision
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Constraint is readable and inspectable | `storageLimit` with name, threshold, scope, priority |
| Merged state violation detected | `violation1` with `actualTotal: 110` exceeding threshold 100 |
| Violation surfaces visibly | Violation record identifies rule, total, and participants |
| Preventive enforcement blocks locally | Action blocked when `currentUsage + attemptedAdd > threshold` |
| Post-merge violation triggers resolution | Violation created after merge detects combined exceeds limit |
| Audit trail records enforcement decisions | `AuditEntry` with timestamp, actor, constraint, decision, reason |
| Parameterized constraints | Same structure, threshold 100 for community A, 1000 for community B |
| Priority resolves conflicting constraints | Higher priority constraint prevails when two disagree |
