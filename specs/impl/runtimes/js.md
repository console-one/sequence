# JavaScript Runtime

JavaScript is the portability floor. Everything compiles to it, everything runs on it. The FT constraint store must be implementable in pure JS with no native modules, no WASM, nothing beyond the language spec. Every other runtime (Node, browser, Electron) is JS plus extras, so this defines what the core can assume: single-threaded event loop, cooperative scheduling, dynamic typing, garbage collection.

The tension is that JS is single-threaded with cooperative scheduling and dynamically typed, but the FT system needs deterministic ordering, bounded memory, and typed state. The runtime bridges these semantic gaps at the language level.

## Pure JS Constraint Store

All core operations are implementable in ECMAScript 2020+ without platform-specific APIs:

```ft
JSRuntime = {
  ecmaVersion: "es2020",
  platformAPIs: false,
  nativeModules: false,
  wasmRequired: false
}
```

The same core module executes identically in Node, Chrome, Firefox, Safari, and Deno.

## Single-Threaded Execution

Operations execute within JS's cooperative scheduling model. No operation depends on parallel execution. Results are deterministic when run sequentially:

```ft
ExecutionModel = {
  threading: "single",
  scheduling: "cooperative",
  deterministic: boolean
}
```

Two operations submitted in sequence are guaranteed to observe each other's effects. No race conditions, no reordering.

## Boundary Type Validation

Types are validated at operation boundaries (on tell, on read), not continuously. This keeps validation cost bounded:

```ft
TypeValidation = {
  boundary: "tell" | "read",
  errorType: string,
  errorPath: string
}
```

A type error in an argument to a store operation is caught at the call boundary with a clear message, not as a downstream runtime exception.

## Immutable Representations

Constraint representations use immutable data structures. No operation mutates its arguments:

```ft
ImmutabilityContract = {
  inputsMutated: false,
  structuralSharing: boolean
}
```

After any operation, the inputs are unchanged. Immutability prevents spooky-action-at-a-distance from shared references and enables structural sharing for memory efficiency.

## Event Loop Budget

Individual operations are bounded to avoid blocking the event loop. A configurable threshold (default: 50ms) prevents starvation:

```ft
LoopBudget = {
  maxBlockMs: number,
  chunkingEnabled: boolean
}
```

```ft
LoopBudget << { maxBlockMs: 50, chunkingEnabled: true }
```

A composition of 100,000 constraints either completes within the budget or yields control via chunking and resumes. Large reductions use cooperative scheduling -- each chunk individually respects the threshold.

## Gaps as First-Class Values

Gaps are values, not exceptions or null returns. A read of an unsatisfied constraint returns a gap object with structured metadata:

```ft
Gap = {
  path: string,
  constraint: string,
  reason: string
}
```

Using exceptions for normal control flow is an anti-pattern in JS. Gaps are normal in the FT system (partial state is expected), so they are data.

## JSON Serialization

The entire store state round-trips through JSON without information loss:

```ft
SerializationContract = {
  format: "json",
  lossless: boolean,
  circularHandling: "reject" | "ref"
}
```

A store serialized to JSON and deserialized into a new instance produces identical reads for all paths. Special values (undefined, functions) are excluded from serialization with warnings.

## Structural Sharing for Fork

Fork operations use structural sharing to minimize memory allocation. Forking a store with 10,000 entries and modifying 10 allocates memory proportional to 10, not 10,000:

```ft
ForkEfficiency = {
  strategy: "structural-sharing",
  overheadProportionalTo: "delta"
}
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Runs in any JS environment | `JSRuntime` with no platform APIs |
| Sequential consistency | `ExecutionModel` with single thread, deterministic |
| Type errors caught at boundary | `TypeValidation` at tell/read boundary |
| Immutable operations | `ImmutabilityContract.inputsMutated = false` |
| Event loop not blocked | `LoopBudget` with chunking |
| Gaps are values, not exceptions | `Gap` object with path, constraint, reason |
| Full JSON round-trip | `SerializationContract` lossless |
| Fork is O(delta) memory | `ForkEfficiency` proportional to delta |
