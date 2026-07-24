# Index Generation

## Original Notes

This is the top. We can do indexes pretty easily. We can just create, generally, some DynamoDB-style index, or add an entry to an index for label kinds. The structure of those entries is a set of predicates that are used to evaluate whether a given patch at a given location satisfies some substate to be satisfied, the notion that some subspace satisfies some interface.

If we're patching some, because all changes are a deep patch to a potentially big tree, we have the question: if any patch occurs within this subtree and its leaves look like a, b, and c, then it is necessarily a model type insertion. We update the index of all of the model types in the codebase to include a pointer to that branch whereby that type interface implementation was obtained.

We can do it in some way where we can add the behavioral property within a particular type to add particular sub-paths of that general type. Add resolution tests to see if it matches a more concrete subtype. This would actually be an optimization for information in our conjunction-based function pipeline, because it would be under the identity assertion that you are adding that indexing function if that element was of the type where the indexing function would be useful in reducing time to look up and times over later on. If true, actually I can see it all kind of making sense. The question is, how do we learn the structures or even prioritize the subtypes that would be meaningful and choose where to mount them via some policy?

## Overview

In a large state tree, finding all subtrees that match a particular shape requires either scanning everything or maintaining an index. Index generation is the second option. A structural predicate describes what a subtree looks like -- "has fields name, provider, and maxTokens" -- and the system maintains a live set of all paths whose subtrees currently match.

The hard problem is not building indexes. It is deciding which indexes to build. Not every structural pattern deserves an index. The system must support dynamic index creation, incremental maintenance as the tree mutates, and policy-driven decisions about which patterns are worth indexing based on access frequency.

## The Structural Predicate

A predicate defines membership in a structural category by specifying what fields a subtree must have. Type is determined by shape, not by a declared name:

```ft
StructuralPredicate = {
  name: string,
  requiredFields: string,
  active: boolean
}
```

`requiredFields` describes the leaf fields and types that a subtree must have to match. `active` controls whether the index is currently maintained -- inactive predicates stop updating but retain their data for reactivation.

A predicate like "has fields name (string) and provider (string)" matches any subtree with those fields, regardless of what other fields it has. Extra fields do not prevent a match.

## The Secondary Index

Each active predicate produces an index -- a maintained set of paths whose subtrees currently satisfy the predicate:

```ft
SecondaryIndex = {
  predicate: ref(StructuralPredicate),
  matchingPaths: string,
  matchCount: number.integer >= 0,
  queryCount: number.integer >= 0
}
```

`matchingPaths` is the set of paths currently satisfying the predicate. `matchCount` tracks how many paths match. `queryCount` tracks how often this index has been queried -- this feeds the policy system for deciding which indexes to keep.

## Incremental Maintenance

When a patch occurs at path X, only indexes whose predicates could be affected by changes at X are re-evaluated. If the patch adds a `provider` field to a subtree, only predicates that include `provider` in their required fields need to check whether this path now matches:

```ft
-- Patch adds field "provider" to subtree at path "models.gpt4"
-- Only predicates requiring "provider" re-evaluate for this path
-- Other indexes unchanged
```

When a patch causes a subtree to newly satisfy a predicate, the path is added to the index. When a patch causes a subtree to stop satisfying a predicate (e.g., a required field is removed), the path is removed. The cost is proportional to affected indexes, not total indexes.

## Subtype Resolution

A broad predicate can be refined by a tighter predicate without re-scanning the whole tree. The broad index serves as the search space for the subtype query:

```ft
SubtypePredicate = {
  parent: ref(StructuralPredicate),
  additionalConstraints: string
}
```

Given a broad index of "all model types" (50 paths), applying a subtype predicate "models with maxTokens > 100000" filters the existing 50 entries rather than scanning the entire tree. The subtype relationship between predicates is structural -- a subtype predicate satisfies all constraints of its parent plus additional ones.

## Dynamic Index Creation

Predicates and their indexes can be defined at any time, not only at system startup. When a new predicate is created against an existing tree, the system evaluates all current subtrees against it and populates the index immediately:

```ft
newPredicate = StructuralPredicate
newPredicate << { name: "highCapModel", requiredFields: "name,provider,maxTokens", active: true }
-- existing subtrees matching this shape are indexed immediately
```

## Index Utilization Policy

The system tracks how often each index is queried. Indexes that are frequently queried are high-value. Indexes that are never queried are candidates for deactivation:

```ft
tool SecondaryIndex.matchingPaths
tool SecondaryIndex.queryCount
tool StructuralPredicate.active
```

The decision about which indexes to keep is policy-driven. The exact policy -- whether based on query frequency thresholds, cost-benefit analysis, or explicit configuration -- is specified externally. The system provides the data (`queryCount`) for the policy to act on.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Predicate defines structural shape | `StructuralPredicate` with `requiredFields` describing leaf shape |
| Index contains all matching paths | `matchingPaths` maintained for each active predicate |
| Incremental update on mutation | Only affected indexes re-evaluated on patch |
| Path added when newly matching | Patch adding required field causes path to enter index |
| Path removed when no longer matching | Patch removing required field causes path to leave index |
| Subtype narrows broad index | `SubtypePredicate` filters parent index, no tree scan |
| Dynamic index creation | New predicate indexes existing data immediately |
| Index utilization tracked | `queryCount` feeds policy decisions about index retention |
