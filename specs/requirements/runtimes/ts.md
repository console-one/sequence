# TypeScript Runtime

## Original Notes

TypeScript is the authoring language. The FT system's types should be expressible in TypeScript's type system at compile time, not just validated at runtime. When someone writes a capability, the compiler catches type mismatches in their constraint declarations before anything runs. The type system does double duty: compile-time check and source of truth for runtime constraint schemas. The TS types and FT types must stay in sync -- ideally by deriving one from the other, never maintaining two parallel systems.

The tension: TypeScript's type system is structural and erased at runtime. The FT system needs type information at runtime for constraint validation, gap detection, and concreteness scoring. A single source of truth must serve both compile-time checking and runtime validation.

## Problem Context

- **Actor(s)**: Developers authoring capabilities and type declarations; TypeScript compiler; IDE tooling; runtime validation layer.
- **Domain**: Ensuring compile-time type safety for a system that also requires runtime type information, using TypeScript as the authoring language.
- **Core Tension**: TypeScript's types are erased at runtime, but the system needs type information at runtime for validation, gap detection, and scoring. A single source of truth must serve both worlds without maintaining parallel type declarations.

## Requirements

**R1**: Type declarations SHALL have a single source of truth that drives both compile-time TypeScript types and runtime type validation.
- *Rationale*: Parallel type systems inevitably drift, causing bugs that surface only at runtime.
- *Verifiable by*: Change a type declaration in one place -- both compile-time type checking and runtime validation reflect the change without modifying a second file.

**R2**: Store read operations SHALL return a type-safe result based on the path's declared type (e.g., a string-typed path returns `string | Gap`, not `unknown`).
- *Rationale*: Untyped reads defeat the purpose of using TypeScript; they force unsafe casts throughout the codebase.
- *Verifiable by*: Reading a string-typed path produces a result typed as `string | Gap` in the IDE tooltip and the compiler.

**R3**: Store write operations SHALL be validated at compile time -- writing a value of the wrong type to a typed path SHALL be a compile error.
- *Rationale*: Catching type mismatches at compile time is cheaper and faster than catching them at runtime.
- *Verifiable by*: Attempting to write a number to a string-typed path produces a TypeScript compiler error.

**R4**: Capability signatures SHALL be expressible as TypeScript function types, with argument and return types checked at call sites.
- *Rationale*: Capabilities are the primary extension point; type-safe signatures prevent integration errors.
- *Verifiable by*: Calling a capability with wrong argument types produces a compiler error at the call site.

**R5**: Missing values (gaps) SHALL be a distinct type in the union, separate from null and undefined, requiring explicit narrowing before use.
- *Rationale*: Gaps are not absence (null) or uninitialized (undefined) -- they are a specific semantic state that must be handled.
- *Verifiable by*: A function returning `T | Gap` -- attempting to use the result as `T` without narrowing produces a compiler error.

**R6**: Type declarations SHALL support parameterization (generics) so that collection and container types can be reused with different element types.
- *Rationale*: Without generics, every collection type requires a custom declaration, leading to duplication.
- *Verifiable by*: A generic "ordered collection of T" instantiated with T=string produces compile-time string-typed element access.

**R7**: Builder expressions SHALL infer types without requiring explicit annotations.
- *Rationale*: Verbose annotations slow authoring and add maintenance burden; inference keeps declarations concise.
- *Verifiable by*: A builder expression like `object({ name: string(), age: number() })` infers the full type without annotations, visible in IDE tooltips.

**R8**: Structural type contradictions (e.g., assigning a string to a number path) SHALL be detected at compile time. Value-level contradictions (e.g., min > max) SHALL be detected at runtime.
- *Rationale*: TypeScript's type system can express structural relationships but not arbitrary value constraints; each level should catch what it can.
- *Verifiable by*: A structural mismatch produces a compile error; a value contradiction (min=10, max=5) produces a runtime error.

## Acceptance Criteria

**AC1** [R1]: Given a single type declaration, when it is changed, then both compile-time type checking and runtime validation reflect the change without modifying any other file.

**AC2** [R2, R3]: Given a string-typed path, when read, then the return type is `string | Gap`; when a number is written to it, then the compiler emits a type error.

**AC3** [R4]: Given a capability with signature `(input: string) => number`, when called with a number argument, then the compiler emits a type error.

**AC4** [R5]: Given a function returning `T | Gap`, when the result is used as `T` without narrowing, then the compiler emits a type error.

**AC5** [R6]: Given a generic collection type parameterized with string, when an element is accessed, then its compile-time type is string.

**AC6** [R7]: Given a builder expression `object({ name: string(), age: number() })`, when hovered in the IDE, then the inferred type shows `{ name: string; age: number }` without explicit annotations.

**AC7** [R8]: Given a structural type mismatch, when compiled, then it fails. Given a value contradiction (min > max), when executed at runtime, then it produces a validation error.

## FT System Demands

- **Required Primitives**: Single-source type derivation (compile-time + runtime from one declaration). Distinct Gap type in the type union. Generic/parameterized type declarations.
- **Required Operations**: Path-typed store reads and writes. Type-safe capability signatures.
- **Gaps**: TypeScript cannot express all value-level constraints (e.g., "field A < field B"); the boundary between compile-time and runtime checking must be clearly documented.

## Open Questions

- Should the single source of truth be an FT declaration that generates TypeScript types, or TypeScript types that generate runtime schemas, or a third representation that generates both?
- How should conditional types be handled (e.g., "if field A is present, then field B is required")?
