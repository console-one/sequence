# TypeScript Runtime

TypeScript is the authoring language. The FT system's types should be expressible in TypeScript's type system at compile time, not just validated at runtime. When someone writes a capability, the compiler catches type mismatches in their constraint declarations before anything runs. The type system does double duty: compile-time check and source of truth for runtime constraint schemas. The TS types and FT types must stay in sync -- ideally by deriving one from the other, never maintaining two parallel systems.

The tension: TypeScript's type system is structural and erased at runtime. The FT system needs type information at runtime for constraint validation, gap detection, and concreteness scoring. A single source of truth must serve both compile-time checking and runtime validation.

## Single-Source Type Derivation

Constraint types declared in the FT system have corresponding TypeScript types checked at compile time, derived from a single source:

```ft
TypeDerivation = {
  source: "single",
  compileTimeCheck: boolean,
  runtimeCheck: boolean,
  parallelDeclarations: false
}
```

Changing a constraint declaration in one place changes both the compile-time type and the runtime type. No second file needs updating. This eliminates the entire class of bugs caused by parallel type systems drifting.

## Path-Typed Store Operations

Store operations are generic over their path types, providing type-safe access:

```ft
StoreOps = {
  readReturnType: "pathType | Gap",
  writeValidation: "compile-time",
  genericOverPath: boolean
}
```

Reading a path declared as string returns `string | Gap` at compile time, not `unknown`. Attempting to write a number to a string-typed path is a compile error.

## Typed Capability Signatures

Capability signatures are expressed as TypeScript function types checkable at call sites:

```ft
CapabilitySignature = {
  inputType: string,
  outputType: string,
  compileChecked: boolean
}
```

When a tool calls a capability with wrong argument types, the compiler emits a type error. The type information flows from the FT constraint declaration to the TypeScript signature automatically.

## Gaps as Distinct Types

Gaps are typed values in the type union, not null or undefined:

```ft
GapType = {
  distinctFromNull: boolean,
  distinctFromUndefined: boolean,
  requiresNarrowing: boolean
}
```

A function that returns a gap returns a distinct type that the caller must handle. Attempting to use the result as a string without narrowing is a compile error. This forces gap handling at every call site.

## Generic Constraints

Constraint types can be parameterized over other types:

```ft
GenericConstraint = {
  parameterized: boolean,
  elementType: string,
  reusable: boolean
}
```

A generic "ordered collection of T" constraint, when instantiated with T=string, produces compile-time string-typed element access. Without generics, every collection type requires a custom constraint declaration.

## Type Inference from Builders

Builder expressions infer types without explicit annotations:

```ft
TypeInference = {
  builderDriven: boolean,
  explicitAnnotationsRequired: false,
  ideTooltipAccurate: boolean
}
```

A builder expression like `object({ name: string(), age: number() })` infers the full type `{ name: string; count: number }` without annotations. Hovering in the IDE shows the expanded type.

## Compile-Time Contradiction Detection

The type system prevents contradictory constraints where detectable:

```ft
ContradictionCheck = {
  detectableAtCompile: boolean,
  valueLevel: "runtime-only",
  typeLevel: "compile-time"
}
```

TypeScript's type system cannot express all constraint relationships (e.g., "min < max" is value-level). But structural contradictions (assigning a string to a number path) are caught at compile time. Value-level contradictions remain runtime checks.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Compile-time type mismatches caught | `TypeDerivation.compileTimeCheck` |
| Single source, no parallel declarations | `TypeDerivation.parallelDeclarations = false` |
| Path-typed reads return correct type | `StoreOps.readReturnType = "pathType or Gap"` |
| Capability call-site checking | `CapabilitySignature.compileChecked` |
| Gaps force narrowing | `GapType.requiresNarrowing` |
| Generic constraints parameterized | `GenericConstraint.parameterized` |
| Builder inference without annotations | `TypeInference.explicitAnnotationsRequired = false` |
| Structural contradictions detected | `ContradictionCheck.detectableAtCompile` |
