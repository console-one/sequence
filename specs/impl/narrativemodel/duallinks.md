# Bidirectional References Between Documents

Documents reference each other constantly -- a proposal references a brief's budget, a brief links back to the proposal. These references must be live: when the source value changes, every derived value that depends on it recomputes automatically. The hard part is bidirectionality and cascade chains. Two documents can reference each other simultaneously, and changes can propagate transitively through multiple documents without creating infinite loops.

There is no polling, no manual refresh, no stale cache. A reference is a live binding -- read it and you get the current value of the source.

## The Reference Type

A reference is a field whose value is resolved by reading another field at a cross-document path. A derivation is a reference that applies a computation to the source value:

```ft
Reference = {
  sourcePath: string,
  sourceDocument: string
}
```

```ft
Derivation = {
  sourcePath: string,
  sourceDocument: string,
  computation: string
}
```

The `sourcePath` identifies the field in the source document. The `computation` on a derivation is a named function that transforms the source value into the derived output (formatting, arithmetic, etc.).

## The Dependency Index

Every reference and derivation is automatically registered in a dependency index -- a reverse mapping from source fields to the set of fields that depend on them. This index is what makes cascade possible:

```ft
DependencyEntry = {
  sourcePath: string,
  sourceDocument: string,
  dependentPath: string,
  dependentDocument: string
}
```

The index is built automatically when references and derivations are declared. No manual registration. When a reference is invalidated (removed), the index entry is cleaned up in the same operation.

## Establishing Cross-Document References

Two documents can reference each other. Document A holds a budget, Document B references it. Document B holds a title, Document A references it:

```ft
docA = {
  budget: number,
  linkedProposal: ref(docB.title)
}

docB = {
  title: string,
  sourceBudget: ref(docA.budget)
}
```

```ft
docA << { budget: 50000 }
docB << { title: "Proposal for Alpha" }
```

Reading `docB.sourceBudget` returns 50000. Reading `docA.linkedProposal` returns "Proposal for Alpha". Both directions resolve simultaneously -- there is no master/slave relationship.

## Derived Values and Cascade

A derivation applies a named computation to a referenced value. When the source changes, the derivation recomputes automatically:

```ft
docB << { displayBudget: ref(docA.budget) }
```

The computation (e.g., formatting 75000 as "Allocated: $75,000") is applied at read time. When `docA.budget` changes from 50000 to 75000, `docB.displayBudget` reflects the new value immediately -- no manual trigger.

Cascade chains propagate transitively. If A.budget feeds A.overhead (15% of budget), and A.overhead feeds B.totalCost (budget + overhead), then changing A.budget to 100000 causes A.overhead to become 15000 and B.totalCost to become 115000. Each link in the chain re-evaluates in dependency order.

Circular cascade is the failure mode that must never happen. The cascade engine must detect cycles and terminate. Bidirectional references (A refs B, B refs A) are legal, but a cascade triggered by A must not re-trigger A through B.

## Invalidating a Reference

Breaking a reference removes the link and clears the derived value. The dependency index is cleaned up atomically:

```ft
delete docB.sourceBudget
```

After invalidation, reading `docB.sourceBudget` returns no value. The dependency index for `docA.budget` no longer lists `docB.sourceBudget`. Downstream derivations that depended on the invalidated reference also become undefined.

## Capabilities

References and derivations are declared by the document author. The cascade engine is system-provided:

```ft
cap docA.budget
cap docB.title
cap docB.sourceBudget
cap docA.linkedProposal
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Cross-document reference resolves to current value | `ref(docA.budget)` returns 50000 when read from docB |
| Bidirectional references both resolve | `docA.linkedProposal` and `docB.sourceBudget` each return the other doc's current value |
| Derived value recomputes on source change | `ref(docA.budget)` with computation re-evaluates when budget changes from 50000 to 75000 |
| Multi-step cascade chain propagates | A.budget -> A.overhead -> B.totalCost all update transitively |
| Invalidation clears reference and index | `delete docB.sourceBudget` removes value and dependency entry |
| Derivation applies named computation | Computation transforms 75000 to "Allocated: $75,000" |
| Dependency index built automatically | Declaring a reference populates the index without additional steps |
