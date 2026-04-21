# [Title]

## Original Notes

[Verbatim user notes. Never edit, rewrite, or remove these.]

## Problem Context

- **Actor(s)**: Who/what interacts? (user, agent, orchestrator, external system)
- **Domain**: What real-world problem space?
- **Core Tension**: What makes this hard? What constraint or trade-off defines the problem?

## Requirements

**R1**: <Subject> SHALL/SHOULD/MAY <behavior>.
- *Rationale*: Why this matters.
- *Verifiable by*: What observable outcome proves this holds.

**R2**: ...

Requirements MUST be implementation-agnostic, testable, atomic, and traceable to the original notes.

## Acceptance Criteria

**AC1** [R1, R3]: Given <precondition>, when <action>, then <observable outcome>.

**AC2** [R2]: ...

## FT System Demands

What this use case requires from the FT type system and runtime. Optional ft blocks here where they genuinely model the domain:

```ft
-- Only include ft blocks that model the actual domain,
-- not blocks that demonstrate framework features
```

- **Required Primitives**: What data/constraint types are needed?
- **Required Operations**: What must be composable/computable?
- **Gaps**: What can the current FT system NOT express that this use case needs?

## Open Questions

Unresolved design decisions that need input before implementation.
