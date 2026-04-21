# Environment Constants

Environment constants are safety bounds declared at broad scopes that propagate downward automatically. Unlike policy overrides (where most-specific wins entirely), constraints compose: the effective constraint at any path is the conjunction of all ancestor constraints. A child can tighten a constraint but never loosen one. If an ancestor says "max 10" and a child says "max 50", the effective constraint remains "max 10" -- the child's loosening attempt has no effect.

This is the distinction between policies and constraints. Policies use override semantics (most-specific replaces). Constraints use composition semantics (intersection of valid sets). Both propagate through the hierarchy, but they compose differently because they serve different purposes: policies express preferences, constraints express invariants.

## Problem Context

- **Actor(s)**: System administrators declaring safety bounds, team leads tightening bounds for their scope, and processes operating within those bounds.
- **Domain**: Hierarchical constraint propagation for resource limits, safety bounds, and operational invariants.
- **Core Tension**: Broad safety limits must propagate automatically without opt-in, children must be able to tighten but never loosen inherited limits, and violations must be surfaced clearly rather than silently clamped.

## Requirements

**R1**: Constraints declared at an ancestor path SHALL automatically apply to all descendant paths without explicit opt-in.
- *Rationale*: Safety bounds must be inescapable; requiring opt-in defeats the purpose of system-wide limits.
- *Verifiable by*: A newly created descendant path is subject to all ancestor constraints without any declaration at the descendant.

**R2**: The effective constraint at any path SHALL be the conjunction (intersection) of all constraints declared along the path from root to that node.
- *Rationale*: Composition via intersection ensures constraints only get tighter, never looser, as you descend.
- *Verifiable by*: Given ancestor limit <= 100000 and child limit <= 20000, effective constraint at child is <= 20000.

**R3**: A child constraint that attempts to loosen a parent constraint SHALL have no effect -- the effective constraint remains the parent's tighter bound.
- *Rationale*: Safety invariants declared at higher scopes must not be circumventable by lower scopes.
- *Verifiable by*: Given parent limit <= 10 and child limit <= 50, effective constraint at child is still <= 10.

**R4**: A write that violates the effective constraint SHALL be suspended (not silently accepted or clamped) with a reason message identifying the violated constraint and its declaring path.
- *Rationale*: Silent acceptance or clamping hides constraint violations; suspension with a reason makes debugging straightforward.
- *Verifiable by*: A write exceeding the effective limit produces a suspension with a message naming the constraint, the declaring path, and the violation.

**R5**: Each constraint SHALL specify a field, a comparison operator, and a limit value.
- *Rationale*: Constraints must be precise and machine-evaluable.
- *Verifiable by*: A constraint declaration with field, operator, and limit is accepted and enforced correctly.

**R6**: The system SHALL support inspecting both the raw constraint (declared at this exact path) and the effective constraint (composed result of all ancestors).
- *Rationale*: Debugging requires distinguishing local declarations from inherited composition.
- *Verifiable by*: Raw inspection at a child returns only the child's declaration; effective inspection returns the composed tightest bound per field.

## Acceptance Criteria

**AC1** [R1, R4]: Given a constraint `maxAgents <= 10` at `env`, when writing `env.maxAgents = 5`, then the write succeeds; when writing `env.maxAgents = 15`, then the write is suspended with a reason message.

**AC2** [R2]: Given `tokenBudget <= 100000` at `env` and `tokenBudget <= 20000` at `env.team1`, when writing `env.team1.tokenBudget = 15000`, then the write succeeds (satisfies both); when writing `env.team1.tokenBudget = 25000`, then the write is suspended (violates child's tighter bound).

**AC3** [R3]: Given `tokenBudget <= 100000` at `env` and `tokenBudget <= 200000` at `env.team1`, when evaluating the effective constraint at `env.team1`, then the effective limit is <= 100000 (child's loosening has no effect).

**AC4** [R6]: Given constraints at both `env` and `env.team1`, when inspecting raw constraint at `env.team1`, then only the child's declaration is returned; when inspecting effective constraint, then the composed tightest bound per field is returned.

**AC5** [R1]: Given a constraint at `env` and a newly created path `env.agents.pool.worker.0`, when writing a value at that path, then all ancestor constraints are enforced without any declaration at the new path.

## Open Questions

(None -- conjunction semantics, suspension on violation, and one-way tightening are fully resolved.)
