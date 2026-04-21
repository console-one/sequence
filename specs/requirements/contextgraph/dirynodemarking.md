# Dirty Node Marking

## Original Notes

Dirty nodes are just nodes that have an option for an input to...

When do we actually do dirty node propagation? That's a really good question.

How do we differentiate between these inputs, especially if constructors are automatically mounted for these inputs for this constructor update or get rebound when they update, versus these ones are always assigned? I wonder if it's the difference between, no, because we're always holding references...

Again, I think this is a difference between, when we do the assignment, whether we are assigning the value that was calculated in that patch or the reference to state under which that patch was computed. It's whether we're doing a read to obtain state or a write to obtain state. I don't know where we zero those two concepts out.

## Problem Context

- **Actor(s)**: Any process that mutates state (writer), computed nodes that derive values from other state (dependents), readers who expect fresh values.
- **Domain**: Incremental recomputation in a dependency graph. When an input changes, downstream computed values become stale and must be recomputed -- automatically, without the caller doing anything.
- **Core Tension**: There are two kinds of dependencies, and the original notes identify this as the key unresolved question. A *reference dependency* means "my value IS that value" -- resolution is re-reading. A *computed dependency* means "my value is DERIVED FROM that value via a function" -- resolution requires re-executing the function. Both propagate staleness, but they resolve differently. The system must handle both transparently.

## Requirements

**R1**: The system SHALL automatically mark dependent nodes as stale when any of their input dependencies change, without requiring an explicit "mark dirty" call from the writer.
- *Rationale*: Manual propagation is error-prone and burdensome. Writers should only need to write; the system handles propagation.
- *Verifiable by*: Writing to node A, which has a dependent node B, causes B to be marked stale without any additional call.

**R2**: The system SHALL distinguish between reference dependencies and computed dependencies.
- *Rationale*: This is the core question from the original notes. A reference dependency resolves by re-reading the source value (no function invocation). A computed dependency resolves by re-executing a registered computation function. Conflating them either wastes compute (re-running functions for simple references) or produces stale values (re-reading when recomputation is needed).
- *Verifiable by*: A reference dependency resolves by returning the current value of its source. A computed dependency resolves by invoking its registered function with current inputs.

**R3**: Staleness SHALL propagate transitively through dependency chains, and resolution SHALL proceed in topological order (upstream before downstream).
- *Rationale*: If C depends on B and B depends on A, changing A must mark both B and C stale. B must resolve before C so that C sees B's fresh value, not a stale intermediate.
- *Verifiable by*: In a chain A -> B -> C, changing A causes B to resolve first, then C resolves using B's fresh value. C never sees a stale B.

**R4**: If recomputing a node produces the same value as before, its downstream dependents SHALL NOT be marked stale (short-circuit on value equality).
- *Rationale*: Prevents cascade explosions in large graphs. If the output is unchanged, downstream nodes are unaffected.
- *Verifiable by*: Node B depends on A. A changes, B recomputes but produces the same value. Node C (dependent on B) is NOT marked stale and is NOT recomputed.

**R5**: A computed dependency whose computation function is not yet registered SHALL be marked as unresolvable, and this status SHALL be visible to the system (not a silent failure).
- *Rationale*: The system must surface incomplete dependency graphs so they can be addressed, not silently return stale or undefined values.
- *Verifiable by*: A computed node without a registered function is reported as unresolvable. When the function is later registered, the node resolves and produces a value.

**R6**: Propagation SHALL be triggered automatically on every state mutation. There SHALL NOT be a separate "propagate now" call.
- *Rationale*: A separate propagation step means reads between the write and the propagation return stale values. The system should guarantee that after a write completes, all dependents are either fresh or actively resolving.
- *Verifiable by*: After writing to node A, the next read of any dependent of A returns the fresh (recomputed) value without any intervening call.

## Acceptance Criteria

**AC1** [R1]: Given node B depending on node A, when A is written to, then B is automatically marked stale without any explicit propagation call.

**AC2** [R2]: Given a reference dependency B -> A, when A's value changes to "new-value", then B's resolved value is "new-value" (re-read, no function invocation).

**AC3** [R2]: Given a computed dependency C with function `wordCount(B)`, when B's value changes, then C re-executes `wordCount` with B's new value.

**AC4** [R3]: Given chain A -> B -> C (both computed), when A changes, then B recomputes before C, and C's input is B's fresh value.

**AC5** [R4]: Given B depending on A, when A changes and B recomputes to the same value as before, then C (dependent on B) is NOT recomputed.

**AC6** [R5]: Given a computed node with no registered function, when the system evaluates it, then it reports the node as unresolvable. When the function is later registered, then the node resolves to a value.

**AC7** [R6]: Given A with dependent B, when A is written to and B is immediately read, then B returns its recomputed value.

## Open Questions

- **Lazy vs. eager**: Should propagation happen eagerly on write (all dependents resolved immediately) or lazily on read (dependents marked stale but resolved only when accessed)?
- **Cycle detection**: What happens if a dependency cycle is introduced? Should it be rejected at registration time or detected at propagation time?
- **Multi-input nodes**: If a computed node depends on A and B, and both change simultaneously, should the function execute once (batched) or twice (once per input change)?
