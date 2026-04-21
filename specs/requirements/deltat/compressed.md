# Compressed -- Dimensionality Management of Probability Functions

## Original Notes

Given that some of these functions that we use to estimate concreteness would have higher and higher fidelity considerations of different conjunctions over different materialized subtypes between T and all of its different potential meets to the function input. We definitely do not want to be showing the entire, let's say, all of those combinations for every function and computing over them in memory for every operation or step of our interpreter. That would be crazy.

We need to figure out a general policy for electing to increase the dimensionality of these probability functions in our server, based off of maybe how close our attention is onto that particular function. We also need to figure out how to train these probability interpreter policy election functions at increasing depth over time, spending more energy doing it depending on what we end up finding to be consistent bottlenecks or not.

---

## Problem Context

- **Actor(s)**: The scheduler (which consumes prioritized resolution targets), the interpreter (which must remain performant), the system over time (which learns from historical patterns).
- **Domain**: Computational budget management for probability estimation -- deciding where to spend fidelity and where to compress.
- **Core Tension**: Full-fidelity probability computation over all input combinations is exponentially expensive (combinatorial in the number of unresolved paths). But naive compression hides important scheduling information. The system needs to expand detail only where it matters and compress everything else.

## Requirements

**R1**: The system SHALL maintain a priority score (0 to 1) for each unresolved path, summarizing how much resolving that path would matter for scheduling.
- *Rationale*: The scheduler needs a ranked list of resolution targets, not a full probability matrix over all combinations.
- *Verifiable by*: Every unresolved path has a queryable priority score between 0 and 1.

**R2**: Priority scores SHALL be derived from dependency participation: a path that appears in many near-complete dependency groups SHALL score higher than one in no groups or only low-completion groups.
- *Rationale*: Resolving a path that would complete a dependency group has high scheduling value; resolving an isolated path has low value.
- *Verifiable by*: A path that would complete 3 out of 3 remaining items in a dependency group scores higher than a path that participates in no dependency groups.

**R3**: When a path's value changes, the system SHALL update only the dependency groups that reference that path (O(delta) update), not recompute all groups.
- *Rationale*: Full recomputation at every step is not feasible at scale.
- *Verifiable by*: After a path change, only the dependency groups containing that path are recomputed. Groups not referencing the changed path are untouched.

**R4**: The system SHALL maintain a reverse index mapping each path to the set of dependency groups it participates in.
- *Rationale*: O(delta) updates require knowing which groups to update without scanning all groups.
- *Verifiable by*: Given a path, the system returns the list of dependency groups referencing it without iterating over all groups.

**R5**: Priority changes below a configurable threshold SHALL be suppressed -- no downstream recomputation SHALL occur for insignificant shifts.
- *Rationale*: Small probability changes cascading through the system waste computation without changing scheduling decisions.
- *Verifiable by*: A dependency group whose completion probability changes by less than the threshold does not trigger priority updates on its member paths.

**R6**: Resolving a path within a dependency group SHALL monotonically increase (never decrease) the priority of the remaining unresolved paths in that group.
- *Rationale*: As more items in a group are resolved, the remaining items become more valuable to resolve (they are closer to completing the group).
- *Verifiable by*: After resolving one path in a 3-path dependency group, the priority of the remaining 2 paths is >= their prior priority.

**R7**: The system SHALL use variable detail expansion based on priority: high-priority paths SHALL show full detail (sub-paths, types, resolution options); low-priority paths SHALL show only their priority score.
- *Rationale*: Rendering and computing full detail for thousands of paths is wasteful. Attention should focus where it matters.
- *Verifiable by*: A path with priority > the expansion threshold shows sub-path detail. A path with priority < the compression threshold shows only its score.

**R8**: Expansion depth SHALL adjust dynamically as priorities shift.
- *Rationale*: A path that was low-priority may become high-priority when a related path resolves. Static expansion would miss this.
- *Verifiable by*: After a priority change pushes a path above the expansion threshold, subsequent queries show full detail for that path.

**R9**: The system SHALL present unresolved paths to the scheduler sorted by descending priority score.
- *Rationale*: The scheduler's primary question is "what should I resolve next?" A sorted list answers this directly.
- *Verifiable by*: The list returned to the scheduler is in descending priority order.

**R10**: The system SHALL learn baseline priorities across sessions: paths that are consistently high-priority SHALL accumulate higher baseline priority over time.
- *Rationale*: Known bottlenecks should be pre-prioritized so the system allocates attention to them earlier.
- *Verifiable by*: A path that was high-priority in 5 consecutive sessions starts with a higher baseline priority in session 6 than a path seen for the first time.

**R11**: Learned baseline priorities SHALL be subject to exponential decay, so stale history does not dominate current evidence.
- *Rationale*: A path that was critical last week but irrelevant now should not permanently consume attention.
- *Verifiable by*: A path with high historical priority but no recent relevance decays toward the neutral baseline over time.

**R12**: Current-session evidence SHALL always override historical baselines.
- *Rationale*: If a historically low-priority path suddenly becomes critical, the system must respond to current conditions, not history.
- *Verifiable by*: A path with low historical baseline but high current dependency participation scores high in the current session.

## Acceptance Criteria

**AC1** [R1, R2]: Given 100 unresolved paths, 3 of which participate in near-complete dependency groups and 97 of which are isolated, when querying priorities, then the 3 near-complete paths score significantly higher.

**AC2** [R3, R4]: Given a path P that participates in dependency groups G1 and G2 (but not G3 through G50), when P is resolved, then only G1 and G2 are recomputed.

**AC3** [R5]: Given a change threshold of 0.01, when a dependency group's completion probability changes by 0.005, then no downstream priority updates occur.

**AC4** [R6]: Given a 3-path dependency group {A, B, C} with priorities [0.3, 0.3, 0.3], when A is resolved, then B and C have priorities >= 0.3.

**AC5** [R7, R8]: Given a path with priority 0.1 (below the expansion threshold of 0.5), when its priority rises to 0.7 due to related resolutions, then subsequent detail queries show full sub-path information.

**AC6** [R9]: Given paths with priorities [0.9, 0.2, 0.7, 0.5], when the scheduler requests the resolution order, then paths are returned in order [0.9, 0.7, 0.5, 0.2].

**AC7** [R10, R11, R12]: Given path X with historical baseline 0.8 from prior sessions but no current-session dependency participation, when querying priority after several sessions of non-use, then X's priority has decayed below 0.8 toward neutral.

## Open Questions

1. What is the right default for the change suppression threshold? Too high suppresses meaningful updates; too low wastes computation.
2. How should the expansion threshold relate to the number of unresolved paths? A fixed threshold may show too many or too few paths depending on system load.
3. What exponential decay rate is appropriate for historical baselines? This likely needs to be tunable per deployment.
