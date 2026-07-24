# FT Axioms — Validated Implementation Map

## Status: 102 tests, 0 compile errors, 7 files, ~2900 lines

---

## Layer 1: Data

**A1. One data form: the Block.**
Blocks contain TellEntries. Entries are `{ op, path, value }`. Blocks have `where`, `while`, `status`. Status is IMMUTABLE — set once at creation.
- `statement.ts:Block`, `statement.ts:TellEntry`

**A2. The Sequence is the sole authority.**
State (projection) is derived from the block sequence. Projection is a cache.
- `sequence.ts:Sequence`, `sequence.ts:Projection`

**A3. Append-only. Blocks are immutable.**
Blocks are only appended. Status never changes. Invalidation = new block with `{ op: 'invalidate' }`. Resume = new applied block (original stays suspended, tracked via `resumedBlocks` set).
- `sequence.ts:tell()` — creates immutable blocks
- `sequence.ts:checkWhileClauses()` — appends invalidation blocks
- `sequence.ts:tryResumeSuspended()` — creates new applied blocks

**A3'. Tell takes a block. Blocks are atomic.**
`tell(entries[], opts)` evaluates all entries against head at block start. Any failure → entire block suspended. Cascade fires once after the block.
- `sequence.ts:tell()` — block evaluation loop
- Tests: `process.test.ts` "tell — block-based (atomic)" suite (6 tests)

**A4. Constraints are data, not predicates.**
Every constraint is `{ op: string, args: readonly unknown[] }`. Serializable. No opaque functions.
- `type.ts:Constraint`

**A5. Types are serializable constraint sets.**
`{ kind, constraints, meta }`. No live functions in types. Capabilities referenced by string ID.
- `type.ts:Type`
- Note: cap statements store live functions in value field. Identity is a statement; implementation is environment.

## Layer 2: Operations

**A6. Mount is the single operation.**
`mount()` is the only public operation. It appends a block AND returns the projected state. Cascade, resume, invalidation, conjunction propagation are internal consequences. tell/hoist/get collapse into mount.
- `sequence.ts:mount()` — the only public mutating method
- `sequence.ts:append()` — sugar for `mount` with single entry
- `sequence.ts:tell()` — deprecated alias for `mount()`

**A7. Where = entry gate. While = lifetime gate.**
Where: checked at block creation. Unsatisfied → block suspended.
While: checked after every mount. Broken → invalidation block appended.
Where clauses will be derived from the dimensional diff between the mounted block and the head (future: April 3, 2026 derivation).
- `sequence.ts:mount()` (where check)
- `sequence.ts:checkWhileClauses()` (while check)

**A8. Suspension = gap, not rejection.**
Suspended blocks stay in the sequence. Later mounts may close their gaps (backward inference via `tryResumeSuspended`).
- `sequence.ts:tryResumeSuspended()`
- `sequence.ts:suspended()` — returns non-resumed suspended blocks

## Layer 3: Derivation

**A9. State is projection.**
Current state = reduce(active blocks). Projection is a cache of values, schemas, capabilities, policies, depIndex.
- `sequence.ts:Projection`
- `sequence.ts:applyEntry()` — maintains projection incrementally

**A10. Cascade = forward propagation.**
Value changes → derived dependents recompute via depIndex.
- `sequence.ts:cascade()`

**A11. Resume = backward inference.**
Value changes → suspended blocks whose gaps reference that value are re-evaluated.
- `sequence.ts:tryResumeSuspended()`

## Layer 4: Structure

**A12. Mount = block.**
A mount is a block of entries — multiple path changes, atomic, gated by where, bounded by while. The block IS the proof step.
- `sequence.ts:mount(entries[], opts)` — the mount operation

**A13. Process = generator over Sequence.**
The process is a generator that yields [view, gaps] and receives blocks. The Sequence is the state the generator operates on. Mount in both directions.
- `sequence.ts:Sequence` — the state
- Process generator — yields view/gaps, receives blocks (future: April 3, 2026 derivation)

**A14. Everything is (address, value).**
MountEntry is `{ op, path, value }` — an operation at an address with a value.
- `statement.ts:MountEntry`

## Layer 5: Intelligence

**A15. Probability = type concreteness position.**
`concreteness(type)` maps types to [0,1]. Literal=1, never=0, any=0, partial=(0,1).
- `compose.ts:concreteness()`
- Tests: `compose.test.ts` "concreteness" suite (6 tests)

**A16. Compose IS probability update.**
`compose(A, B)` = lattice meet. Result's concreteness reflects merged probability.
- `compose.ts:compose()`
- Tests: `compose.test.ts` "compose — lattice meet" suite (27 tests)

**A17. Preserves = backward inference channel.**
`preserves('*')` or `preserves(inPath, outPath)` on function types. `backwardInfer(fn, required)` derives input from output.
- `type.ts:preserves()`
- `compose.ts:backwardInfer()`
- `builder.ts:FT.fn({ preserves: '*' })`
- Tests: `compose.test.ts` "backwardInfer" suite (7 tests)

**A18. Three-way conjunction flow.**
Conjunction graph maintained persistently as `conjRefIndex`. Indexed when blocks are created (where/while clauses). Priorities computed from `importance × P(sibling refs)`.
- `sequence.ts:conjRefIndex` — persistent ref → conjunction index
- `sequence.ts:indexConjunction()` — adds to index on block creation
- `sequence.ts:buildConjunctions()` — lazy full rebuild
- `sequence.ts:computePriority()` — priority = max(importance × P(others))
- `sequence.ts:gaps()` — returns obligations in priority order
- Tests: `conjunction.test.ts` (7 tests)

**A19. O(delta) reactivity.**
`propagateConjunctionDelta(changedPath)` runs inside tell's cascade. Only touches conjunctions referencing the changed path. Updates probability cache and sibling priorities.
- `sequence.ts:propagateConjunctionDelta()` — O(affected conjunctions)
- `sequence.ts:conjProbCache` — probability cache for delta detection
- `sequence.ts:priorityCache` — cached priorities updated incrementally

## Additional: Expressions

**Dependent output types with uncertainty.**
Function types can declare `computable(outputPath, expr)` where expr is arithmetic over input properties with ± bounds.
- `type.ts:Expr`, `type.ts:computable()`, `type.ts:add/mul/call/pm`
- `compose.ts:evaluateExpr()`, `compose.ts:exprConcreteness()`
- Tests: `compose.test.ts` "evaluateExpr" + "exprConcreteness" suites (14 tests)

---

## File Map

```
ft/
  statement.ts   —   88 lines   A1, A3, A12, A14
  type.ts        —  377 lines   A4, A5, A17, Expr
  compose.ts     —  720 lines   A15, A16, A17, Expr eval, check (A7)
  sequence.ts    —  ~780 lines  A2, A3, A3', A6-A13, A18, A19
  builder.ts     —  478 lines   Ergonomics (FT.*)
  hoist.ts       —  477 lines   Presentation (projection → text)
  impl/mount.ts  —   62 lines   Consumer pattern
```

## Test Map

```
test/
  process.test.ts      — 26 tests  (blocks, where/while, cascade, compact, hoist)
  compose.test.ts      — 54 tests  (lattice meet, backward inference, concreteness, exprs)
  conjunction.test.ts  —  7 tests  (priority, resume, derived conjunctions)
  search.test.ts       —  8 tests  (obligations, gaps, backward planning)
  scheduler.test.ts    —  7 tests  (gap fill loop, capabilities)
```
