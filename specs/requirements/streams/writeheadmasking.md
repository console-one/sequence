# Write-Head Masking

## Original Notes

Write control gates who can modify which paths based on the writer's identity. Unlike read masking (which hides data), write masking prevents unauthorized state changes. The critical difference from traditional access control: an unauthorized write suspends rather than being rejected. The write remains as a pending intention that activates if the writer's identity later satisfies the condition. This preserves intent and enables automatic resumption on role change.

There is no separate permission-grant API. Write permissions are conditions on operations, using the same mechanism as all other preconditions.

## Problem Context

- **Actor(s)**: Writers with varying roles/identities; the authorization enforcement layer; pending (suspended) writes awaiting authorization.
- **Domain**: Write access control where unauthorized writes are not rejected but suspended, preserving the writer's intent and automatically resuming when authorization conditions are met.
- **Core Tension**: Traditional access control rejects unauthorized writes, forcing resubmission. Suspending writes instead preserves intent and enables automatic resumption, but introduces complexity around suspended state management and concurrent condition evaluation.

## Requirements

**R1**: Write operations SHALL support identity-based conditions specifying which writer roles are authorized to modify a given path.
- *Rationale*: Different paths have different sensitivity levels; not every writer should be able to modify every path.
- *Verifiable by*: A write to `config.secret` with condition `role = "admin"` is defined -- it applies only when the writer's role is "admin".

**R2**: An unauthorized write (where the writer's identity does not satisfy the condition) SHALL suspend rather than be rejected.
- *Rationale*: Suspension preserves the writer's intent and enables automatic resumption without resubmission.
- *Verifiable by*: A writer with role "reader" submits a write with an admin condition -- the write is recorded as suspended, not rejected or discarded.

**R3**: A suspended write SHALL automatically resume and apply when the writer's identity later satisfies the condition.
- *Rationale*: Role changes (e.g., promotion to admin) should automatically activate previously suspended writes without manual resubmission.
- *Verifiable by*: A suspended write from a "reader" identity activates automatically when that identity changes to "admin" -- no resubmission is needed.

**R4**: Identity conditions SHALL compose with business-rule conditions, requiring ALL conditions to hold simultaneously for the write to apply.
- *Rationale*: Real-world authorization often involves both identity (who you are) and context (what state the system is in).
- *Verifiable by*: A write requiring both `role = "admin"` and `approval.status = "approved"` -- it suspends when either condition is unsatisfied and applies only when both hold simultaneously.

**R5**: If any composed condition breaks after the write has been applied, the write SHALL re-suspend and its effects SHALL be removed from observable state.
- *Rationale*: Authorization is continuous, not one-time; a role demotion should revoke the effects of writes that required the elevated role.
- *Verifiable by*: A write applied under admin role -- when the identity is demoted to "reader", the write's effects are removed from observable state.

**R6**: Capability registrations SHALL be subject to the same identity-based conditions as data writes.
- *Rationale*: Registering a capability is a form of write; it should not bypass access control.
- *Verifiable by*: A capability registration with condition `role = "engineer"` suspends for a non-engineer and activates when the identity becomes "engineer".

**R7**: Write permissions SHALL support revocable lifetime conditions -- when the lifetime condition breaks, the write's effects are automatically removed.
- *Rationale*: Temporary permissions (e.g., during a maintenance window) must clean up automatically without manual intervention.
- *Verifiable by*: A write with a lifetime condition on `permissions.canWrite` -- when `permissions.canWrite` is removed, the write's effects disappear from observable state.

**R8**: Write permissions SHALL use the same condition format as all other preconditions in the system.
- *Rationale*: A separate permission-grant API adds complexity; using the same mechanism keeps the system uniform.
- *Verifiable by*: The syntax for a write permission condition is identical to the syntax for any other precondition.

## Acceptance Criteria

**AC1** [R1, R2]: Given a write to `config.secret` with condition `role = "admin"`, when submitted by a writer with role "reader", then the write is suspended (not rejected).

**AC2** [R3]: Given a suspended write from a "reader" identity, when the identity changes to "admin", then the write automatically applies without resubmission.

**AC3** [R4]: Given a write requiring `role = "admin"` AND `approval.status = "approved"`, when the writer is admin but approval is pending, then the write suspends. When approval changes to "approved" (and writer is still admin), then the write applies.

**AC4** [R5]: Given a write applied under the "admin" role, when the identity is demoted to "reader", then the write re-suspends and its effects are removed from observable state.

**AC5** [R6]: Given a capability registration with condition `role = "engineer"`, when submitted by a non-engineer, then the registration suspends. When the identity becomes "engineer", then the capability becomes available.

**AC6** [R7]: Given a write with lifetime condition on `permissions.canWrite`, when `permissions.canWrite` is removed, then the write's effects automatically disappear from observable state.

**AC7** [R8]: Given a write permission condition, when its syntax is compared to other system preconditions, then they use the same format.

## FT System Demands

- **Required Primitives**: Identity-scoped write conditions. Suspension and automatic resumption of writes. Revocable lifetime conditions with automatic cleanup.
- **Required Operations**: Compound condition evaluation (identity AND business-rule). Continuous condition monitoring with re-suspension on break.
- **Gaps**: The system must handle concurrent suspended writes to the same path -- what happens when two suspended writes both become authorized simultaneously?

## Open Questions

- Is there a limit to how many suspended writes can accumulate for a given path?
- Should suspended writes have a TTL (time-to-live) after which they are discarded?
- How should the audit trail represent a write that was applied, then re-suspended, then applied again?
- When multiple suspended writes to the same path become authorized simultaneously, what is the conflict resolution order?
