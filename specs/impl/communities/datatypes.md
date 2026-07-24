# Community Data Types

Multiple participants edit shared data concurrently without real-time coordination. When their edits converge, the system merges them into a single consistent state. The merge must be deterministic (same inputs, same output), commutative (order does not matter), and associative (grouping does not matter). These three properties guarantee eventual consistency -- every participant who has seen the same set of operations arrives at the same state, regardless of the order they received them.

The building blocks are counters, sets, registers, and maps. Each has a well-defined merge function. Counters add. Sets union (with a configurable policy for concurrent add-and-remove). Registers keep the latest write (or surface conflicts). Maps merge per-key, recursively applying each value's merge semantics. These compose -- a map of counters, a set of registers -- and the merge is always structural, never ad-hoc.

## Counter

A counter tracks a numeric value that multiple participants can independently increment or decrement. The merge function is addition -- participant A's delta plus participant B's delta equals the merged result:

```ft
Counter = {
  value: number,
  delta: number
}
```

```ft
counterA = Counter
counterA << { value: 0, delta: 0 }

-- Participant A increments by 3
counterA << { value: prev + 3, delta: 3 }
```

```ft
counterB = Counter
counterB << { value: 0, delta: 0 }

-- Participant B increments by 5
counterB << { value: prev + 5, delta: 5 }
```

After merge, the counter value is 8 (3 + 5). Each participant's delta is tracked independently. The merge sums the deltas, not the absolute values -- this prevents the "last writer wins" problem where one increment would overwrite the other.

Decrements work the same way: `value: prev - 2` with `delta: -2`. After merge with an increment of 5, the result is +3.

## Merge-Aware Set

A set supports add and remove operations with a configurable conflict policy for the case where one participant adds an element while another concurrently removes it:

```ft
MergeSet = {
  elements: ref(setElements),
  policy: "add-wins" | "remove-wins"
}
```

```ft
setA = MergeSet
setA << { policy: "add-wins" }
```

With "add-wins", concurrent add and remove of the same element results in the element being present after merge. With "remove-wins", it is absent. The policy is declared at creation time, not at merge time -- the choice is structural, not situational.

Adding and removing elements:

```ft
-- Participant A adds "foo"
setA << { elements: ref(setElements) }

-- Participant B removes "foo" concurrently
-- With add-wins policy: "foo" is present after merge
-- With remove-wins policy: "foo" is absent after merge
```

Idempotency: adding "foo" twice produces the same set as adding it once. Merging the same edit set twice produces the same state as merging it once. Duplicate network delivery cannot corrupt the set.

## Register

A register holds a single value. Concurrent writes are inherently conflicting -- two participants writing different values to the same register must be resolved by policy:

```ft
Register = {
  value: ref(registerValue),
  timestamp: number.integer >= 0,
  writer: string,
  policy: "last-writer-wins" | "multi-value"
}
```

```ft
reg1 = Register
reg1 << { policy: "last-writer-wins" }

-- Participant A writes "hello" at T=5
reg1 << { value: ref(registerValue), timestamp: 5, writer: "participant-A" }

-- Participant B writes "world" at T=7
reg1 << { value: ref(registerValue), timestamp: 7, writer: "participant-B" }
```

With "last-writer-wins", the register contains participant B's value after merge (higher timestamp). With "multi-value", both values are retained and surfaced as a conflict requiring manual resolution. The policy determines whether the system auto-resolves or surfaces the conflict.

## Map

A map is the composition point. Each key's value is itself a merge-aware type -- a counter, a set, a register, or another map. The merge function applies per-key, recursively:

```ft
MergeMap = {
  entries: ref(mapEntries),
  keyMerge: ref(mergeStrategy)
}
```

```ft
map1 = MergeMap
map1 << { entries: ref(mapEntries) }
```

When participant A sets `map["hits"]` to +3 and participant B sets `map["hits"]` to +2, the merged value of `map["hits"]` is 5 (counter merge). When A sets `map["errors"]` to +1 and B sets `map["ok"]` to +5, the merged map contains all three keys: `{hits: 5, errors: 1, ok: 5}`. Different keys are independent; same-key values merge according to the value type's semantics.

## Merge Properties

All merge-aware types satisfy three properties that guarantee convergence. Commutativity: merging A then B produces the same result as merging B then A, so message arrival order does not matter. Associativity: merging (A, B) then C produces the same result as merging A then (B, C), so batching does not matter. Idempotency: merging the same edit twice produces the same result as merging it once, so duplicate delivery does not corrupt state.

These properties are structural -- they hold for any sequence of operations, any arrival order, any grouping. Two participants who have seen the same set of operations always converge to the same state.

## Capabilities

The data type operations -- counter increments, set mutations, register writes, and map updates -- are provided by participant processes:

```ft
cap Counter.value
cap Counter.delta
cap MergeSet.elements
cap MergeSet.policy
cap Register.value
cap Register.timestamp
cap MergeMap.entries
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Counter merges additively | `value: prev + 3` and `prev + 5` merge to 8 |
| Commutativity: order does not matter | Merge A-then-B equals B-then-A for all types |
| Idempotency: duplicates are harmless | Same edit merged twice equals merged once |
| Counter supports decrement | `value: prev - 2` with delta -2; merges with increment correctly |
| Set add-wins policy | Concurrent add + remove: element present after merge |
| Set remove-wins policy | Concurrent add + remove: element absent after merge |
| Register last-writer-wins | Higher timestamp value survives merge |
| Map merges per-key recursively | Same-key values use value type's merge; different keys coexist |
| Deterministic convergence | Same operations in any order produce identical final state |
