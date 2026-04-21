# JavaScript Runtime

## Original Notes

JavaScript is the portability floor. Everything compiles to it, everything runs on it. The FT constraint store must be implementable in pure JS with no native modules, no WASM, nothing beyond the language spec. Every other runtime (Node, browser, Electron) is JS plus extras, so this defines what the core can assume: single-threaded event loop, cooperative scheduling, dynamic typing, garbage collection.

The tension is that JS is single-threaded with cooperative scheduling and dynamically typed, but the FT system needs deterministic ordering, bounded memory, and typed state. The runtime bridges these semantic gaps at the language level.

## Problem Context

- **Actor(s)**: Any JavaScript host environment (Node, browser, Deno, Bun, embedded); application code consuming the core library.
- **Domain**: Defining the portable core that runs in every JS environment -- the minimum viable runtime with no platform-specific dependencies.
- **Core Tension**: JS is single-threaded, dynamically typed, and garbage-collected, but the system needs deterministic ordering, bounded memory, and typed state validation.

## Requirements

**R1**: All core operations SHALL be implementable in ECMAScript 2020+ without platform-specific APIs, native modules, or WebAssembly.
- *Rationale*: This is the portability floor; every other runtime (Node, browser, Electron, Deno) is JS plus extras.
- *Verifiable by*: The core module executes identically in Node, Chrome, Firefox, Safari, and Deno with no polyfills.

**R2**: Operations executed sequentially SHALL produce deterministic results, with each operation guaranteed to observe the effects of all prior operations.
- *Rationale*: Single-threaded execution eliminates race conditions, but the system must explicitly guarantee sequential consistency.
- *Verifiable by*: Two operations submitted in sequence always observe each other's effects; repeated runs produce identical state.

**R3**: Type validation SHALL occur at operation boundaries (write and read) with clear, descriptive error messages.
- *Rationale*: Validating only at boundaries keeps cost bounded while catching errors before they propagate.
- *Verifiable by*: Writing a number to a string-typed path produces a type error at the write call site, not a downstream runtime exception.

**R4**: No operation SHALL mutate its input arguments.
- *Rationale*: Immutability prevents shared-reference bugs and enables structural sharing for memory efficiency.
- *Verifiable by*: After any operation, deep-equality comparison of inputs before and after confirms no mutation.

**R5**: No individual operation SHALL block the event loop for more than a configurable threshold (default: 50ms).
- *Rationale*: Blocking the event loop starves timers, I/O callbacks, and rendering in environments that share it.
- *Verifiable by*: A composition of 100,000 items either completes within 50ms or yields control and resumes via chunking.

**R6**: Missing values SHALL be represented as structured data (with path, expected type, and reason), not as exceptions, null, or undefined.
- *Rationale*: Missing data is a normal state (partial resolution is expected), not an exceptional condition. Using exceptions for normal control flow is an anti-pattern.
- *Verifiable by*: Reading an unsatisfied path returns a structured object with path, type constraint, and reason fields -- not null, undefined, or a thrown exception.

**R7**: The entire store state SHALL round-trip through JSON serialization without information loss.
- *Rationale*: JSON is the universal interchange format; lossless serialization enables persistence, transfer, and debugging.
- *Verifiable by*: Serialize state to JSON, deserialize into a new instance -- all reads produce identical results.

**R8**: Special values that cannot be represented in JSON (undefined, functions) SHALL be excluded from serialization with warnings, not silently dropped.
- *Rationale*: Silent data loss during serialization causes hard-to-diagnose bugs.
- *Verifiable by*: Serializing state containing a function produces a warning identifying the non-serializable value.

**R9**: Fork operations SHALL use structural sharing, with memory allocation proportional to the delta, not the total state size.
- *Rationale*: Forking a large state for speculative exploration must not double memory usage.
- *Verifiable by*: Forking a store with 10,000 entries and modifying 10 allocates memory proportional to 10, not 10,000.

## Acceptance Criteria

**AC1** [R1]: Given the core module, when loaded in Node, Chrome, Firefox, Safari, and Deno, then all operations produce identical results with no platform-specific code paths.

**AC2** [R2]: Given two sequential write operations, when the second reads the path written by the first, then the first write's effect is always visible.

**AC3** [R3]: Given a write of a number to a string-typed path, when the write is attempted, then a type error is raised at the write boundary with a message identifying the path and expected type.

**AC4** [R4]: Given any operation, when its inputs are compared before and after, then they are deeply equal (no mutation).

**AC5** [R5]: Given a composition of 100,000 items, when executed, then either it completes within 50ms or it yields and resumes without blocking the event loop beyond 50ms per chunk.

**AC6** [R6]: Given a read of a path with a declared type but no value, when the read returns, then the result is a structured object (not null, undefined, or a thrown exception) containing path, constraint, and reason.

**AC7** [R7, R8]: Given state containing normal values and one function value, when serialized to JSON, then normal values round-trip losslessly and the function produces a warning.

**AC8** [R9]: Given a fork of a 10,000-entry store with 10 modifications, when memory is measured, then the overhead is proportional to 10, not 10,000.

## FT System Demands

- **Required Primitives**: Structured missing-value representation. Immutable operation semantics. Cooperative chunking for large computations.
- **Required Operations**: Lossless JSON serialization. Structural-sharing fork.
- **Gaps**: None -- these are foundational constraints that any implementation must satisfy.

## Open Questions

- Should the event loop budget threshold be configurable at runtime or only at initialization?
- What is the minimum ECMAScript version -- can it be lowered to ES2017 for broader compatibility, or is ES2020 the floor?
