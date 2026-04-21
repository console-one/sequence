# Action Overrides

Hierarchical systems need defaults that apply broadly without every node opting in. But specific nodes need exceptions. The resolution question -- most-specific wins vs. merge vs. something else -- determines whether the system is predictable. This blueprint uses walk-up semantics: start at the target path, walk up through ancestors, and the first override found governs. No merging across levels. The override is just a declaration at a more specific path, using exactly the same write operation as the original.

The key constraint is that overrides are atomic. A child override replaces the parent's behavior entirely, it does not inherit individual fields from it. This makes the system trivial to debug: query the effective behavior for a path and you get one answer traceable to one declaration.

## Problem Context

- **Actor(s)**: System administrators, component authors, and downstream consumers of hierarchical configuration.
- **Domain**: Hierarchical behavior configuration in tree-structured namespaces (metrics, policies, settings).
- **Core Tension**: Broad defaults must apply everywhere by default, but specific nodes need exceptions -- without the override mechanism creating unpredictable emergent behavior from cross-level merging.

## Requirements

**R1**: The system SHALL support declaring default behaviors at ancestor paths that automatically govern all descendant paths.
- *Rationale*: Avoids requiring every node to explicitly opt in to common behaviors.
- *Verifiable by*: A descendant path with no local declaration exhibits the ancestor's declared behavior.

**R2**: The system SHALL allow any descendant path to override the inherited behavior by declaring its own behavior at that path.
- *Rationale*: Specific nodes need exceptions to the inherited default.
- *Verifiable by*: A descendant with a local declaration exhibits its own behavior, not the ancestor's.

**R3**: Override declarations SHALL use the same mechanism as original declarations -- no separate override syntax or API.
- *Rationale*: A single mechanism reduces conceptual overhead and ensures overrides are first-class.
- *Verifiable by*: The syntax/operation used to set an override is identical to the syntax/operation used to set the original.

**R4**: When resolving the effective behavior for a path, the system SHALL walk from the target path upward through ancestors and return the first declared behavior found (walk-up resolution).
- *Rationale*: Deterministic, predictable resolution that is easy to trace.
- *Verifiable by*: Given a known hierarchy of declarations, querying the effective behavior at any path returns the nearest ancestor's declaration.

**R5**: When a child override exists, it SHALL replace the parent's behavior entirely -- no cross-level merging of individual fields.
- *Rationale*: Merging across levels creates emergent behavior that is difficult to debug and reason about.
- *Verifiable by*: A child override contains only its own declared fields; no fields from the parent appear in the effective behavior.

**R6**: The system SHALL support querying both the raw (locally declared) behavior and the effective (walk-up resolved) behavior for any path.
- *Rationale*: Debugging requires distinguishing what was declared here from what was inherited.
- *Verifiable by*: A path with no local declaration returns empty for raw but returns the inherited behavior for effective.

**R7**: Walk-up resolution SHALL be deterministic -- identical declarations always produce identical effective behavior.
- *Rationale*: Predictability is a core invariant; non-deterministic resolution would break debugging and trust.
- *Verifiable by*: Repeated queries against unchanged declarations return the same result.

## Acceptance Criteria

**AC1** [R1]: Given a behavior declared at path `metrics`, when a descendant `metrics.cpu` has no local declaration, then reads of effective behavior at `metrics.cpu` return the `metrics` declaration.

**AC2** [R2, R3]: Given a default overwrite behavior at `metrics` and a different behavior declared at `metrics.memory`, when reading the effective behavior at `metrics.memory`, then the local declaration governs -- not the ancestor's.

**AC3** [R4]: Given declarations at `metrics` and `metrics.disk`, when resolving behavior for `metrics.disk.partition.0.read`, then walk-up finds `metrics.disk` first and stops -- the `metrics` declaration is never reached.

**AC4** [R5]: Given a parent declaration at `parent` with fields A and B, and a child override at `parent.child` with only field C, when reading effective behavior at `parent.child`, then only field C is present -- fields A and B are not inherited.

**AC5** [R6]: Given a declaration at `metrics` and no declaration at `metrics.cpu`, when inspecting `metrics.cpu` raw behavior, then nothing is returned; when inspecting effective behavior, then the `metrics` declaration is returned.

**AC6** [R4]: Given a deeply nested path `a.b.c.d.e` with declarations at `a` and `a.b.c`, when resolving behavior for `a.b.c.d.e`, then the declaration at `a.b.c` governs (nearest ancestor wins).

## Open Questions

(None -- walk-up semantics, atomic overrides, and no cross-level merging are fully resolved.)
