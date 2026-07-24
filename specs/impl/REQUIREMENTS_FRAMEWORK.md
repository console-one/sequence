# Requirements Framework for FT Use Cases

## Purpose

Each file in `impl/` captures a **use case** of the FT system. These files exist to answer:

1. **What does this feature need to do?** (Requirements)
2. **How do we know it works?** (Acceptance Criteria + Test Cases)
3. **What does this demand from the FT system?** (System Implications)

They do NOT answer "how is it implemented." Implementation comes later, informed by requirements.

---

## File Structure

Every `impl/*.md` file MUST follow this structure:

### § Problem Context

**Preserve the original user notes verbatim.** These are the raw problem statement — the "why" and "what" in the user's own words. Do not clean them up, rewrite them, or add to them. They are the requirement source.

Below the user notes, add a brief structured summary:

- **Actor(s)**: Who/what interacts? (user, agent, orchestrator, external system)
- **Domain**: What real-world problem space? (scheduling, document editing, API orchestration, etc.)
- **Core Tension**: What makes this hard? What constraint or trade-off defines the problem?

### § Requirements

Numbered requirements using RFC 2119 language (SHALL, SHOULD, MAY, MUST NOT).

Each requirement:

```
**R<N>**: <Subject> SHALL/SHOULD/MAY <behavior>.
- *Rationale*: Why this matters.
- *Verifiable by*: What observable outcome proves this holds.
```

Requirements MUST be:
- **Implementation-agnostic**: No API names, no data structure choices, no code
- **Testable**: Each has a clear pass/fail criterion
- **Atomic**: One requirement = one behavior
- **Traceable**: Maps to specific user notes or design principles

Categories:
- **Functional**: What the feature does
- **Behavioral**: What invariants hold during operation
- **Temporal**: What ordering or timing properties exist
- **Boundary**: What happens at limits, failures, edge cases
- **Compositional**: How this feature interacts with others

### § Acceptance Criteria

Given/When/Then scenarios that validate requirements. Each criterion references one or more R<N>.

```
**AC<N>** [R1, R3]: Given <precondition>, when <action>, then <observable outcome>.
```

### § Test Scenarios

Concrete test cases derived from acceptance criteria. These describe WHAT to test, not HOW (no implementation). Each has:

```
**T<N>** [AC<N>]:
- Setup: <initial state description>
- Action: <what happens>
- Expected: <what must be true after>
- Edge cases: <boundary conditions to also verify>
```

### § User Experience

What the user sees and feels. Not a rendered output spec — a description of the experience:
- What information is visible?
- What actions are available?
- What feedback do they get?
- What does "done" look like?
- What does "stuck" look like?

### § FT System Demands

What this use case **requires** from the FT type system and runtime. This is the feedback loop — use cases drive system design, not the other way around.

Structure:
- **Required Primitives**: What data/constraint types are needed?
- **Required Operations**: What must be composable/computable?
- **Required Properties**: What guarantees must the runtime provide?
- **Gaps**: What can the current FT system NOT express that this use case needs?
- **Tensions**: Where does this use case push against other use cases' needs?

### § Anti-Requirements

What this feature MUST NOT become. Complexity boundaries. Scope limits.

```
**AR<N>**: This feature MUST NOT <thing to avoid>.
- *Why*: What goes wrong if this boundary is crossed.
```

### § Open Questions

Unresolved design decisions that need input before implementation can begin. Each tagged with what would resolve it.

---

## Quality Criteria for Requirements

A good requirement:
- Can be read by someone who has never seen the codebase
- Has exactly one interpretation
- Can be verified by a test
- Does not prescribe implementation
- Traces back to a real user need or system constraint

A bad requirement:
- References specific APIs, classes, or methods
- Says "the system should work correctly" (untestable)
- Combines multiple behaviors in one statement
- Assumes implementation decisions already made
- Cannot be traced to why anyone cares

---

## How Requirements Feed Back to FT Design

The impl/ files are not just feature specs — they are **probes into the FT system's expressiveness**. Each use case that the FT system cannot cleanly express reveals a design gap.

The feedback loop:
1. Write requirements for a use case
2. Ask: "Can the FT system's axioms express all of these?"
3. If yes: the use case validates the axiom set
4. If no: the gap becomes a candidate axiom extension or a signal that the axiom set is incomplete
5. If the gap appears across multiple use cases: it's a foundational missing piece

This feedback is captured in **§ FT System Demands** and aggregated across files to inform AXIOMS.md, KERNEL_REQUIREMENTS.md, and TYPE_INTERFACE_REQUIREMENTS.md.

---

## Relationship to Existing Docs

| Document | Role | Direction |
|----------|------|-----------|
| `docs/AXIOMS.md` | Defines what IS true about the FT system | Top-down |
| `docs/KERNEL_REQUIREMENTS.md` | Defines implementation constraints | Top-down |
| `impl/*.md` | Defines what MUST BE true for each use case | Bottom-up |
| `docs/TYPE_INTERFACE_REQUIREMENTS.md` | Edge cases from design | Bidirectional |

The impl/ files are the **bottom-up pressure** that validates or challenges the top-down axioms.
