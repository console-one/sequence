# Implementation Ambiguities — Resolved

All nine ambiguities identified during the session, with decisions.

---

## 1. Object narrowing → RESOLVED: Transactional compose at parent

`<<` composes at the parent level. If compose produces `never`, the entire narrow is rejected — no partial application. Concrete sub-values bind at sub-paths within the same transaction. Implemented in walker.ts.

## 2. Block scoping → RESOLVED: Syntactic expansion to derived refs

Blocks are not forks. They flatten syntactically. `x = { import a from './path'; local = transform(a); export local }` expands to `x = derived(transform, './path')` — x's type is the return type of transform applied to the referenced value. If the ref isn't available, x is an obligation with that derived type. Implemented in walker.ts.

## 3. Prev resolution → RESOLVED: Mount-time via getPrevious

Each statement in a patch sees prior state as immutable. `prev` resolves to `getPrevious(path)` at mount time. The patch maintains its own internal stack. Prior state is read-only; the mount writes the full diff to the next state.

## 4. Diff retention → RESOLVED: Receiver's behavioral type contracts

Not a seq number. The receiver's gap API contracts carry behavioral type information about their retention policy. If the receiver's function type says "I retain values for T+N unless ping condition breaks," the sender computes the diff window from that type. The receiver forwards when retention rules are compromised (e.g., "all void if no ping in last T-K"). This is an implied behavior of the ft-type value system, not a protocol field.

## 5. Per-receiver gap filtering → RESOLVED: Same as #4

The receiver's exposed gaps carry their own behavioral types. The sender reads those types to determine what to send and what the receiver already has. Hoisting applies the same inference.

## 6. Comment storage → RESOLVED: Values without pkey

Comments are string values in blocks without pkeys. All data is blocks of at least values, sometimes pkey+values. Comments are the values-without-pkey case. No special comment field needed — this is why pkey was deliberately not required in the statement model.

## 7. Token stability → RESOLVED: Scope-qualifying initial statements

Every hoisted sequence is qualified by initial statements that establish scope: sender address, image/version, protocol contract. The receiver knows how to interpret subsequent statements because the sender knows the receiver implements a known function protocol (discovered at registration). Tokens are scoped by this initial contract.

## 8. Predicate compilation → RESOLVED: Implemented

Refinement predicates (`| lhs = rhs @[from..until) ~survival(...)`) now compile to identity + temporal + distribution constraints on the base type. `forall` quantifiers compile to `forall` constraints. Implemented in walker.ts `toType()` refined case.

## 9. Import resolution → RESOLVED: Derived ref expansion

Imports flatten to refs. `import a from './path'` → `ref('./path')`. `export transform(a)` → `derived(transform, './path')`. The block's type is the return type of the transform with its input from the referenced path. Build-order determines which refs are available when.
