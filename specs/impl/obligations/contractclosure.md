# Contract Closure

An obligation exists when a schema is declared at a path but no value satisfies it. Closure is the act of providing a value that passes the type-check against that schema. The successful write IS the proof step -- there is no separate "close" operation. The tension is that closure is not always permanent: conditional closures can reopen when their predicates break, and capabilities with preserved properties impose a stronger identity conservation check on top of basic type satisfaction.

The hard part is the boundary between strict and permissive. Too strict and valid outputs are rejected. Too loose and invalid outputs pollute the state. The type-check at closure time is the single enforcement point for the entire obligation contract.

## The Obligation Type

An obligation is a schema at a path with no satisfying value. It has a concreteness score that starts low and approaches 1.0 on closure. The schema declares what is required; the value (when provided) is what satisfies it:

```ft
Obligation = {
  path: string,
  schema: ref(schemaDefinition),
  value: [[ obligation : unsatisfied until value is provided ]],
  concreteness: number 0..1,
  proofStep: [[ proof : assigned on successful closure ]],
  status: "open" | "closed" | "reopened"
}
```

An open obligation surfaces in the obligations list. Closure is the transition from having a gap at `value` to having a concrete value that passes the schema check.

## Type-Checked Write

When a value arrives, the system validates it against the schema. Success closes the obligation and records a proof step. Failure leaves everything unchanged and produces a violation report:

```ft
closureAttempt = (input: { path: string, value: ref(candidateValue) }) -> { result: "accepted" | "rejected" }

-- On acceptance: obligation closes, proof step recorded
obligation << { value: ref(candidateValue) }
obligation << { concreteness: prev }
obligation << { status: "closed" }
obligation << { proofStep: ref(proofRecord) }
```

The concreteness updates via `prev` -- each successful write moves the value closer to 1.0 based on the proportion of the schema now satisfied. The proof step references an immutable, sequenced record that can be audited.

Behavioral predicate (not expressible in ft): the value MUST pass the full type-check against the schema. If any property violates the schema constraints (wrong type, out of range, missing required field), the entire write is rejected atomically. Partial schema satisfaction through sub-path writes is handled by the feedback loop (see feedback.md), not by relaxing the type-check.

## Conditional Closure

Some values are valid only while a predicate holds. When the predicate breaks, the obligation reopens:

```ft
obligation << { value: ref(conditionalValue) while apiKey EXISTS }
obligation << { status: "closed" while apiKey EXISTS }
```

When `apiKey` is removed, the `while` condition breaks. The value is invalidated, status reverts, and the obligation resurfaces in the obligations list. The schema still exists at the path, so it reappears as open work.

Behavioral predicate (prose): reopening is automatic -- no manual intervention. The system monitors the condition predicate and invalidates the binding when the condition breaks. Whether the previously satisfying value is retained as "stale" or fully removed is a policy decision at the workspace level.

## Identity Conservation

For capabilities that declare preserved properties, closure performs a stronger check: the output's preserved properties must trace back to the input. This is the write-read identity relationship -- behavioral predicate enforcement on observation updates reliability priors.

```ft
conservationCheck = (input: { inputData: ref(capabilityInput), outputData: ref(capabilityOutput), preservedKeys: ref(preservedPropertyList) }) -> { valid: boolean }
```

Behavioral predicate (prose): for each key in `preservedKeys`, the value at that key in `outputData` must equal the value at that key in `inputData`. Mismatch is reported as an identity conservation violation, distinct from a type error. This is a stronger contract than type satisfaction alone -- it asserts that the capability did not corrupt the data it was supposed to preserve.

## Proof Recording

Each successful closure produces a proof step with a sequence number. Proof steps are immutable and form an audit trail:

```ft
proofRecord = {
  sequenceNumber: number.integer >= 0,
  path: string,
  timestamp: number,
  conditionallyGated: boolean
}
```

The proof trail survives compaction -- even if intermediate blocks are archived, the closure fact (which step closed which obligation) is preserved.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Schema without value creates obligation | `Obligation` with `value` as expansion token (gap) |
| Valid value closes obligation | `obligation << { value: ref(candidateValue) }` + status to "closed" |
| Invalid value leaves obligation open | Behavioral predicate: atomic rejection on type-check failure |
| Proof step recorded on closure | `proofRecord` with sequenceNumber, timestamp |
| Conditional closure reopens on predicate break | `while apiKey EXISTS` on value and status |
| Identity conservation checked for preserved properties | `conservationCheck` verifying preserved keys match |
| Concreteness approaches 1.0 on closure | `concreteness: prev` updated toward 1.0 |
