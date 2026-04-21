# Read-Head Masking

## Original Notes

Data owners classify the sensitivity of their data. Readers have varying access levels. The system enforces visibility constraints at read time -- filtering what a reader can see based on identity and the data's classification. Masking is a projection, not a transformation: the underlying data is stored regardless of visibility. Different readers see different projections of the same state.

There is no separate ACL system. Visibility constraints are metadata on schemas. There is no "access denied" response -- masked data returns nothing, indistinguishable from a non-existent path.

## Problem Context

- **Actor(s)**: Data owners (classifying sensitivity); readers with varying access levels (consuming data); the visibility enforcement layer.
- **Domain**: Access control where different readers see different projections of the same state based on identity-matched visibility constraints, with no separate ACL system.
- **Core Tension**: The system must enforce visibility at read time without a separate access control layer, and masked data must be indistinguishable from non-existent data (no "access denied" signal that leaks the existence of hidden paths).

## Requirements

**R1**: Data owners SHALL be able to attach visibility constraints to paths, specifying which reader identities can observe the value.
- *Rationale*: Sensitivity classification must be declarative and co-located with the data, not in a separate ACL file.
- *Verifiable by*: A visibility constraint is attached to `config.apiKey` specifying `role = "admin"` -- the constraint is stored as metadata on the path.

**R2**: A reader whose identity does not satisfy the visibility constraint SHALL receive no value -- indistinguishable from a non-existent path.
- *Rationale*: An "access denied" response leaks the existence of sensitive data; returning nothing prevents information leakage.
- *Verifiable by*: A non-admin reader reads `config.apiKey` -- the result is identical to reading a path that was never created (no value, no error, no indication of existence).

**R3**: A reader whose identity satisfies the visibility constraint SHALL receive the full value.
- *Rationale*: Authorized readers must have unimpeded access to the data they are permitted to see.
- *Verifiable by*: An admin reader reads `config.apiKey` -- the full value is returned.

**R4**: Key enumeration at a path prefix SHALL exclude keys whose values are masked for the current reader.
- *Rationale*: Listing children must not leak the existence of masked keys.
- *Verifiable by*: A non-admin enumerating children of `config` sees `["appName"]` only. An admin sees `["appName", "apiKey"]`.

**R5**: A visibility constraint on a parent path SHALL apply to all descendants.
- *Rationale*: Classifying an entire subtree as sensitive should not require annotating every child individually.
- *Verifiable by*: A visibility constraint on `dept.finance` (role = "manager") masks both `dept.finance.budget` and `dept.finance.headcount` for non-managers.

**R6**: Reader identity SHALL be provided at read time as part of the execution context, not stored in the data layer.
- *Rationale*: Identity is ambient to the reading process, not a stored value that could be tampered with.
- *Verifiable by*: The reader identity is set on the execution context before reads occur; it is not retrievable as a stored path in the data layer.

**R7**: Visibility constraints SHALL use the same condition format as all other preconditions in the system.
- *Rationale*: A separate ACL language adds complexity; using the same condition format keeps the system uniform.
- *Verifiable by*: The syntax for a visibility constraint is identical to the syntax for any other precondition.

## Acceptance Criteria

**AC1** [R1, R2, R3]: Given `config.apiKey` with a visibility constraint requiring `role = "admin"`, when an admin reads it, then the value is returned. When a non-admin reads it, then no value is returned (same as reading a non-existent path).

**AC2** [R4]: Given `config` containing `appName` (no constraint) and `apiKey` (admin-only), when a non-admin enumerates children of `config`, then only `["appName"]` is returned. When an admin enumerates, then `["appName", "apiKey"]` is returned.

**AC3** [R5]: Given a visibility constraint on `dept.finance` requiring `role = "manager"`, when a non-manager reads `dept.finance.budget`, then no value is returned. When a manager reads it, then the value is returned.

**AC4** [R6]: Given the system, when reader identity is inspected, then it is set on the execution context and is not stored as a data path.

**AC5** [R7]: Given a visibility constraint, when its syntax is compared to other system preconditions, then they use the same format.

## FT System Demands

- **Required Primitives**: Path-level visibility constraints referencing reader identity. Execution-context-scoped reader identity. Hierarchical constraint inheritance.
- **Required Operations**: Filtered key enumeration respecting visibility. Read-time constraint evaluation.
- **Gaps**: None identified.

## Open Questions

- When a child has a LESS restrictive constraint than its parent, does the child override the parent or does the parent always win?
- Should there be an audit log of masked read attempts (for security monitoring), even though the reader sees nothing?
- Can visibility constraints be dynamic (e.g., based on time of day or data age)?
