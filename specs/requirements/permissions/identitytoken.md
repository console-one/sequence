# Identity Token

Every process in the system has an identity -- a structured value at a well-known path within its own scope. Identity is not hidden metadata; it is ordinary data, readable and inspectable through the same mechanisms as everything else. Operations can be gated on identity using the same condition mechanism used for all other preconditions. No separate permission API, no ACL subsystem.

The design choice is that identity-gated operations suspend (not error) when the condition is unmet. If the identity later changes to match -- a role promotion, for instance -- the suspended operation automatically resumes. This gives the system the property that pending work flows forward as permissions are granted, without manual retry.

## Problem Context

- **Actor(s)**: Processes with assigned identities (agents, users, services), administrators who grant/change roles, and operations that require specific identity conditions.
- **Domain**: Identity management and role-based operation gating in a multi-process system.
- **Core Tension**: Identity must gate operations without introducing a separate permission subsystem, and unmet conditions must not fail permanently -- they should resolve automatically when the identity changes to satisfy them.

## Requirements

**R1**: Each process SHALL have an identity represented as a structured value at a well-known path within its scope.
- *Rationale*: A predictable location for identity enables uniform gating without special-case lookup.
- *Verifiable by*: Reading the well-known identity path returns the process's structured identity value.

**R2**: The identity value SHALL conform to a declared schema (at minimum: identifier, role, and optional organization). Writes that violate the schema SHALL be rejected.
- *Rationale*: Schema enforcement prevents malformed identities from entering the system.
- *Verifiable by*: A write with a valid identity succeeds; a write with a non-conforming value (e.g., numeric ID when string is required) is rejected.

**R3**: Identity SHALL be readable and writable through the same data access mechanisms used for all other values -- no special identity API.
- *Rationale*: Uniform access reduces API surface and ensures identity is not privileged infrastructure.
- *Verifiable by*: Standard read and write operations work on the identity path.

**R4**: Operations SHALL be gatable on identity conditions using the same condition mechanism as all other preconditions.
- *Rationale*: No separate ACL or permission system; identity checks are just data conditions.
- *Verifiable by*: An operation conditioned on `role = "admin"` proceeds when the identity has role admin, and does not proceed otherwise.

**R5**: An operation whose identity condition is unmet SHALL suspend (not error), and SHALL automatically resume when the identity changes to satisfy the condition.
- *Rationale*: Suspension with auto-resume means pending work flows forward as permissions are granted, without manual retry.
- *Verifiable by*: An admin-gated operation suspends when identity is analyst; after identity changes to admin, the operation resumes without manual intervention.

**R6**: Identity conditions SHALL compose with non-identity conditions using the same mechanism -- no special syntax for combining identity with other preconditions.
- *Rationale*: Uniform composition keeps the condition system simple and predictable.
- *Verifiable by*: An operation gated on both identity role and an approval status requires both conditions to hold.

**R7**: Each execution partition (forked process) SHALL have an independent identity scope. A child process SHALL NOT automatically inherit the parent's identity.
- *Rationale*: Forked processes may represent different agents or roles; automatic inheritance would leak privileges.
- *Verifiable by*: Two partitions with different identities are independently evaluated -- an admin-gated operation succeeds in the admin partition and suspends in the analyst partition.

## Acceptance Criteria

**AC1** [R1, R2, R3]: Given the identity schema, when a conforming identity value is written to the well-known path, then it succeeds and is readable via standard data read.

**AC2** [R2]: Given the identity schema requires a string identifier, when a numeric identifier is written, then the write is rejected with a schema violation.

**AC3** [R4, R5]: Given an operation gated on `role = "admin"` and a process with `role = "analyst"`, when the operation is attempted, then it suspends; when the identity is updated to `role = "admin"`, then the operation automatically resumes.

**AC4** [R6]: Given an operation gated on both `role = "admin"` and `approval.status = "approved"`, when only the role condition is met, then the operation remains suspended until both conditions hold.

**AC5** [R7]: Given two forked partitions with identities `role = "admin"` and `role = "analyst"` respectively, when an admin-gated operation is attempted in each, then it succeeds in the admin partition and suspends in the analyst partition.

**AC6** [R3]: Given a process with a set identity, when reading the identity path using standard data access, then the full structured identity value is returned.

## Open Questions

(None -- identity as ordinary data, suspension semantics, and per-partition scoping are fully resolved.)
