# Index Generation

## Original Notes

This is the top. We can do indexes pretty easily. We can just create, generally, some DynamoDB-style index, or add an entry to an index for label kinds. The structure of those entries is a set of predicates that are used to evaluate whether a given patch at a given location satisfies some substate to be satisfied, the notion that some subspace satisfies some interface.

If we're patching some, because all changes are a deep patch to a potentially big tree, we have the question: if any patch occurs within this subtree and its leaves look like a, b, and c, then it is necessarily a model type insertion. We update the index of all of the model types in the codebase to include a pointer to that branch whereby that type interface implementation was obtained.

We can do it in some way where we can add the behavioral property within a particular type to add particular sub-paths of that general type. Add resolution tests to see if it matches a more concrete subtype. This would actually be an optimization for information in our conjunction-based function pipeline, because it would be under the identity assertion that you are adding that indexing function if that element was of the type where the indexing function would be useful in reducing time to look up and times over later on. If true, actually I can see it all kind of making sense. The question is, how do we learn the structures or even prioritize the subtypes that would be meaningful and choose where to mount them via some policy?

## Problem Context

- **Actor(s)**: Processes that query the state tree by structural shape ("find all subtrees that look like a Model"), processes that mutate the tree (triggering index updates), a policy system that decides which indexes are worth maintaining.
- **Domain**: Secondary indexing over a hierarchical state tree. In a large tree, finding all subtrees matching a structural pattern requires either full scans or maintained indexes. This is the maintained-index approach.
- **Core Tension**: Building indexes is easy. Deciding which indexes to build is hard. Every index has a maintenance cost on every mutation that touches its predicate. The system must support dynamic index creation while providing the data for policy-driven decisions about which indexes justify their cost.

## Requirements

**R1**: The system SHALL support defining structural predicates that describe a subtree shape by specifying required fields and their types.
- *Rationale*: Type is determined by shape (structural typing), not by a declared name. A predicate like "has fields name (string) and provider (string)" matches any subtree with those fields.
- *Verifiable by*: A predicate requiring fields {name: string, provider: string} matches a subtree with {name: "gpt4", provider: "openai", maxTokens: 128000} (extra fields allowed) and does not match {name: "gpt4"} (missing required field).

**R2**: For each active predicate, the system SHALL maintain a secondary index containing the set of all paths whose subtrees currently satisfy the predicate.
- *Rationale*: This turns O(n) scans into O(1) lookups for structural queries.
- *Verifiable by*: After defining a predicate and evaluating the tree, querying the index returns all matching paths.

**R3**: Index maintenance SHALL be incremental: when a mutation occurs at path X, only predicates whose required fields overlap with the mutation SHALL be re-evaluated, and only for the affected path.
- *Rationale*: Re-evaluating all predicates against the full tree on every mutation is prohibitively expensive. Cost must be proportional to affected indexes, not total indexes or tree size.
- *Verifiable by*: A mutation adding field "provider" to path X triggers re-evaluation only for predicates that include "provider" in their required fields. Predicates involving only other fields are untouched.

**R4**: When a mutation causes a subtree to newly satisfy a predicate, the path SHALL be added to the index. When a mutation causes a subtree to stop satisfying a predicate, the path SHALL be removed.
- *Rationale*: The index must be consistent with the current state of the tree at all times.
- *Verifiable by*: Adding a required field to a subtree causes its path to appear in the matching index. Removing a required field causes the path to disappear.

**R5**: A predicate SHALL be refinable by a subtype predicate that adds additional constraints. The subtype query SHALL filter the parent index rather than scanning the full tree.
- *Rationale*: If a broad index has 50 matches and the subtype adds one constraint, checking 50 entries is far cheaper than scanning the full tree. Subtype relationships between predicates enable hierarchical narrowing.
- *Verifiable by*: A subtype predicate applied to a parent index of 50 entries examines only those 50 entries, not the full tree.

**R6**: Predicates and their indexes SHALL be creatable at any time (not only at system startup). When a predicate is created against an existing tree, the index SHALL be populated immediately by evaluating all current subtrees.
- *Rationale*: The system learns what patterns are useful over time. Requiring all indexes to be defined at startup is impractical.
- *Verifiable by*: Creating a new predicate against a tree with 1,000 nodes immediately produces an index of all matching paths.

**R7**: The system SHALL track how often each index is queried, providing utilization data for policy-driven decisions about which indexes to retain or deactivate.
- *Rationale*: The original notes ask "how do we prioritize the subtypes that would be meaningful?" Query frequency is the primary signal for whether an index justifies its maintenance cost.
- *Verifiable by*: After 10 queries against index A and 0 queries against index B, the utilization data reflects these counts.

**R8**: Inactive predicates SHALL stop updating their index but SHALL retain their data for reactivation without a full rebuild.
- *Rationale*: Deactivation saves maintenance cost. Retaining data avoids expensive rebuilds if the index is reactivated.
- *Verifiable by*: After deactivating a predicate, mutations to matching subtrees do not update the index. After reactivating, the index reflects the state at deactivation time (not current state -- a catch-up pass is needed, but the retained data avoids a full rebuild).

## Acceptance Criteria

**AC1** [R1, R2]: Given a predicate requiring fields {name: string, provider: string} and a tree containing 3 subtrees with those fields, when the index is queried, then it returns exactly 3 paths.

**AC2** [R3]: Given 10 active predicates and a mutation that adds field "maxTokens" to one subtree, when the mutation is processed, then only predicates requiring "maxTokens" are re-evaluated.

**AC3** [R4]: Given a subtree at path X that has fields {name, provider}, when field "provider" is removed, then path X is removed from any index whose predicate requires "provider."

**AC4** [R5]: Given a broad index with 50 matching paths and a subtype predicate adding one constraint, when the subtype query runs, then it evaluates only the 50 entries in the parent index.

**AC5** [R6]: Given an existing tree with 500 nodes, when a new predicate is created, then the resulting index contains all currently matching paths immediately (not on next mutation).

**AC6** [R7]: Given index A queried 15 times and index B queried 0 times, when utilization data is retrieved, then A reports 15 queries and B reports 0.

**AC7** [R8]: Given a deactivated predicate, when a mutation adds a matching subtree, then the index is NOT updated. After reactivation and a catch-up pass, the index includes the new subtree.

## Open Questions

- **Index creation policy**: Should the system automatically create indexes based on observed query patterns, or only when explicitly requested?
- **Predicate complexity**: Are predicates limited to field presence and type, or can they include value constraints (e.g., "maxTokens > 100000")?
- **Cost model**: What is the overhead budget per index per mutation? Is there a hard limit on how many active indexes are allowed?
