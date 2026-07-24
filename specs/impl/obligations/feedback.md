# Feedback

Partial output is not failure -- it is progress. When a capability produces output that satisfies some properties of an obligation but not all, the system accepts what was provided, narrows the remaining obligation, reprioritizes the gaps, and selects the next capability to execute. This is the feedback loop: produce -> narrow -> reprioritize -> select -> produce again, until the obligation is fully closed or no further progress is possible.

The hard problem is efficiency. Each partial result changes the priority landscape -- resolving "sources" may unblock "content" which may unblock "summary." But recomputing all priorities from scratch on every partial result is prohibitive. Priority updates must propagate only through the affected parts of the conjunction graph (delta propagation), and concreteness must monotonically increase with each valid step.

## The Feedback State

The feedback loop operates on an obligation with sub-properties. Each property can be independently satisfied. The loop tracks what remains and how concrete the obligation has become:

```ft
FeedbackState = {
  obligationPath: string,
  totalProperties: number.integer >= 0,
  satisfiedProperties: ref(satisfiedSet),
  remainingProperties: ref(remainingSet),
  concreteness: number 0..1,
  status: "iterating" | "closed" | "blocked"
}
```

Concreteness starts near 0 and increases with each valid partial result. It never decreases from a valid step -- this is the monotonicity invariant.

## Partial Result Acceptance

When a capability produces partial output, the system determines exactly which properties were satisfied and narrows the remaining obligation:

```ft
partialResult = (input: { path: string, output: ref(partialOutput) }) -> { accepted: ref(acceptedProperties), remaining: ref(remainingProperties) }

-- After accepting partial output
feedbackState << { satisfiedProperties: prev }
feedbackState << { remainingProperties: prev }
feedbackState << { concreteness: prev }
```

Each `prev` reference captures self-referential state update -- satisfied properties grow, remaining properties shrink, concreteness increases. The system reports exactly which properties were accepted and which remain, not just "something is still missing."

Behavioral predicate (prose): concreteness after step N+1 MUST be greater than or equal to concreteness after step N for every valid partial result. This is the monotonicity invariant. A valid partial result adds information; it never removes it. Redundant partial results (providing a property already satisfied) leave concreteness unchanged.

## Priority Repropagation

Resolving one property changes the priority of related properties through the conjunction graph. If "sources" is resolved, "content" (which depends on sources) becomes higher priority because its prerequisites are now met:

```ft
priorityUpdate = (input: { resolvedProperty: string, conjunctionGraph: ref(graphState) }) -> { updatedPriorities: ref(affectedGaps) }
```

Behavioral predicate (prose): priority updates propagate ONLY through the affected portion of the conjunction graph (delta propagation). Given N total gaps in the system and K gaps in the same conjunction as the resolved property, the update is O(K), not O(N). Unrelated obligations retain their previous priorities unchanged. This is the efficiency constraint that makes the feedback loop viable at scale.

## Capability Selection

After priorities update, the system selects the next capability based on the highest-priority remaining gap:

```ft
nextCapability = (input: { remainingGaps: ref(prioritizedGaps), availableCapabilities: ref(capabilityRegistry) }) -> { selected: ref(capabilityToExecute) }
```

This is the write-read relationship between priority computation and capability dispatch -- behavioral predicate enforcement on observation (did the selected capability actually produce useful output?) updates reliability priors for that capability.

## Backward Inference

Before executing the selected capability, the system determines what inputs it needs and whether those inputs are available:

```ft
backwardInference = (input: { capability: ref(selectedCapability), availableState: ref(currentState) }) -> { satisfied: ref(availableInputs), unsatisfied: ref(missingInputs) }
```

If required inputs are missing, they become sub-goals. The feedback loop recurses: to get "summary" we need "content"; to get "content" we need "sources." Each level of backward inference adds a sub-goal, and the loop resolves them bottom-up.

Behavioral predicate (prose): backward inference chains have a depth limit. Deep chains (5+ levels) delay visible progress and may not converge. The system imposes a maximum depth and falls back to surfacing the unresolved sub-goal to the user or LLM when the limit is reached.

## Loop Termination

The feedback loop terminates on one of two conditions: full closure or blockage:

```ft
feedbackState << { status: "closed" when remainingProperties = null }
feedbackState << { status: "blocked" when remainingProperties EXISTS }
```

Behavioral predicate (prose): "closed" means all required properties are satisfied and concreteness is approximately 1.0. "blocked" means no available capability can produce any of the remaining properties -- the loop has exhausted its options. Blocked status includes a report of exactly which gaps are unresolvable and why, so the user can manually provide the missing pieces or install new capabilities. The loop MUST NOT run indefinitely; termination is guaranteed by the convergence of concreteness (monotonically increasing toward a bounded target) and the finite set of available capabilities.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Partial output accepted, obligation narrowed | `partialResult` function + `prev` updates on satisfied/remaining |
| Priorities repropagated via conjunction graph | `priorityUpdate` with delta propagation behavioral predicate |
| Delta propagation, not full recomputation | Behavioral predicate: O(K) affected gaps, not O(N) total |
| Concreteness monotonically increases | `concreteness: prev` with monotonicity invariant |
| Next capability selected by priority | `nextCapability` reading from `prioritizedGaps` |
| Backward inference identifies missing inputs | `backwardInference` returning satisfied/unsatisfied split |
| Loop terminates on closure | `status: "closed" when remainingProperties = null` |
| Loop terminates on blockage | `status: "blocked" when remainingProperties EXISTS` with no matching capability |
