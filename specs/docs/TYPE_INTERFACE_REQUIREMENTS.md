# Type Interface Requirements

## Status

Normative. These are verbatim edge cases from the design session. Each must be expressible in the type builder API and enforceable by the block store's merge.

## Important Notes on Notation

**`ref()` is shorthand, not the final construction model.** Throughout this document, `ref()` is used as convenient notation to describe relationships between type positions. The actual implementation may replace `ref()` with a different pattern if it proves suboptimal. `ref()` should be treated as illustrative of the *relationship being expressed*, not as a commitment to a specific API.

**Flat type construction is deliberate.** The examples use flat `FT.*` construction syntax to avoid prematurely conflating:
1. The layered state of FT composition (building the type / guard structure)
2. The layered state of concreteness processing within a store block (runtime resolution)

These are distinct concerns. The type construction layer describes *what the schema is*. The block concreteness layer describes *how concrete each position currently is*. If the implementation requires lifting embedded `ref()` tokens to a statement-like definition model (i.e., a block that builds the type), that is acceptable — the flat syntax here is for clarity of intent, not a constraint on implementation form.

---

## 1. Segmented Strings with Character Budgets

Strings broken into named segments, each with size constraints, content sources, mutation policies, and write affordances.

```
[[...Report[]].upto(4000, 'characters'), ref('addressformore')]

[segment(lit('Some string value'))
 .segment(max(300, 'characters'), pattern('AB.'))
 .segment(lit("some next string value"), writeable(ref('writer-affordance'))
 .segment(lit('current value'), source('some-document', ref({ linestart: 100, lineend: 400 }))
 .segment(lit(), lock('//:processabcdef'))]

[segment(BalancedJson)]

[segment(ref('compress', ref('../tools'), min(ref('config?.toolCharacters?.max'), subtract(ref('b'), ref('../maxCharacters')))))
 .segment(lit("some other text"))
 .segment(ref('b'))]
```

Each segment has: content (literal, ref, or gap), size budget, mutation policy, source reference, optional lock.

---

## 2. Segment Mutation Policies

Named segments with per-segment write permissions gated by where clauses.

```
FT.string()
  .segment(name('segment1'), mutations(enable('push', 'pop')))
  .segment(name('segment2'), mutations(enable(any)
    .where(ref('permissions', ref('author')), 'has', 'editor')))
```

Mutations on a segment are gated by where clauses that check caller permissions against the authoring context.

---

## 3. Object Index Types (pk/sk)

DynamoDB-style indexed collections with primary key derivation and sort key comparator.

```
Index<ObjectType> = (pkeypath, skeycomparator) =>
  (obj, state) => state.set({
    pkey: lookup(obj, pkeypath),
    skey: skeycomparator(state, object),
    data: obj
  })
```

Must be expressible in one line. Used constantly.

---

## 4. Object Key-Range Partitioning

Different constraints per key range — database sharding expressed as type structure.

```
object({
  /a...kqe/: [constrainthere, skeys: range(0, 300)],
  /kqf...w/: [constrainthere, skeys: range(300, 1000)],
  /wa...z+/: [constrainthere, skeys: range(1000, '+')]
})
```

Key-range partitions with different sort key ranges and constraint sets per partition.

---

## 5. Relational Constraints Across Fields

Derivation relationships between fields enforced by the type.

```
object<A extends UsernameType, B extends DisplayNameType,
  { truncate(UsernameType, 10) = DisplayNameType }>(
  {
    user: { info: { username: UsernameType } },
    displayname: DisplayNameType
  },
  ...any
)
```

The type enforces: `displayname = truncate(username, 10)`. Violating the relationship is a type error.

---

## 6. Descriptions as Segments

Field descriptions are not flat strings — they are segmented with expandable refs.

```
object([
  { a: string },
  description("a", string
    .segment("This string in this context is used for xyz")
    .segment(ref('expandable details')))
])
```

Descriptions use the same segment model as content. Expandable sections are refs.

---

## 7. Visibility Constraints

Field visibility gated by client capabilities or locks.

```
object([
  { a: string, b: string },
  visibility('a', clientHas(ABCLOCK))
])
```

A field exists in the type but is only visible to clients with the required capability/lock. This also covers fork-mode scoping (platform vs session) — visibility is the general mechanism.

---

## 8. Environment-Conditional Defaults

Value depends on mounting environment, with fallback defaults.

```
object([{
  a: string.ref(
    where('/', 'is', 'browserenv')
      .then('./../c')
      .else('"Default value of A"')
  )
}])
```

The value of `a` is a ref that resolves differently depending on what environment the type is mounted in. Browser gets one value, server gets the default.

---

## 9. Function Types with Full IO Constraints

Function types must express: typed params with cross-param constraints, implementation (concrete function or ref), output with identity constraints back to inputs, temporal constraints on execution.

```
FT.function({
  input: { a: FT.number.lt(20), b: any, c: ...FT.array(FT.string) },
  impl: runnableInMemoryFunction,
  output: block<OutputType
    & a === OutputType['somefield']
    & (REALTIME > ref('./input'))>
})

FT.function({
  input: SomeWellFormedType,
  impl: someOtherPipe(somePipe(ref('./input/[0]'), ref('unresolved'))),
  output: GenericType  // not specific because pipeline is not well defined
})
```

Functions with identity constraints: `f1(f([a, b]), c) => { a: { id: string, c: any } } && where ( ./a === f.input[0].id && ./c === f1.input[1].id )`

**NOTE:** `.literal(actualFunction).callable()` should NOT exist. Function types are: `FT.function({ input?, output?, impl: LITERAL_OR_REF })`. The impl is either a concrete function or a ref to one. No separate callable constraint.

The mount boundary automatically wraps every function call with:
1. `input._t = T` (bound at call time)
2. `output._t = T` (bound at return time)
3. Identity trace: which output positions derived from which input positions
4. Duration: `output._t - input._t`

Function IO as env deltas: `env@before → env@after`, not `A → B`.

---

## 10. Number Types with Transition Modes and Interpolation

Numbers are accumulators with time-dependent interpolation. Patches to numbers may be additive, not replacement.

```
{ a: 10 } with PATCH { 'a': 5 } leads to { a: 15 }  // additive
PUSH 5 to { a: 10 } leads to { 'a': 5 }              // replacement

// Time interpolation
'a': {
  position: number.ref(
    ref('interpolate',
      mul(ref('./velocity'),
        ref('REAL_TIME') - ref('./-1/REAL_TIME')
      )
    )
  )
}
```

When reading an interpolated number, the value is computed: `stored + interpolation(T - lastUpdateTime)`. Constraints like `lt(10)` apply to the interpolated value. The type determines how to READ, not just what to validate on write.

---

## 11. Lock Allocation and Multi-Dimensional Constraint Evaluation

From the Observables framework requirements. The type system must support:

### R1: Declarative input collection with suspension
A computation declaring N inputs suspends until all resolve. Expressed as a statement with N refs, each a gap until resolved.

### R2: Order independence
Producers and consumers must not depend on attachment order. State is queryable, not event-based.

### R3: Short-circuit evaluation
`compose(item, predicate)` returns never on mismatch (fail-fast AND) or non-never on match (succeed-fast OR).

### R4: Multi-dimensional metric partitioning
Metrics partitioned by arbitrary dimensions, partition key derived from paths within the value. Object index constraint with `by` accepting refs/calls.

### R5: Two-phase commit
Fork, evaluate constraints in fork, merge only if all pass. Exactly `stage() → execCommit()`.

### R6: Structured gaps on failure
Constraint failure produces a gap carrying the FieldType of what would satisfy it — not just "denied."

### R7: Cross-constraint propagation
Narrowing a value at path A automatically propagates to constraints referencing A.

### R8: Persistent constraint graph
Policies are type-level statements. The workspace IS the persistent constraint graph.

### R9: Classification via type composition
Route requests by composing with candidate types. Label constraint with match FieldType.

---

## 12. Class-to-Block Compilation (Dependency Injection)

JS classes must compile to blocks where:
- Constructor type = block's where_input (unresolved refs = deps needed to mount)
- Service type = block's method types (function types with IO FieldTypes)
- Methods = capabilities with impls at process level
- Definition plane = concreteness map (which methods are ready vs blocked)
- Installation = mounting: resolve constructor refs against scope
- Type-gated execution: methods only callable when deps are satisfied

From ServicePrototype pattern:
```
ServicePrototype.create(ctor)
  proto['[constructorType]'] = types.object({ db: StorageType, llmKey: FT.string() })
  proto['[serviceType]'] = types.object({ getTasks: FT.fn(Input, Output), ... })
  proto.methodName = proto._method(async (_this, input) => { ... })
```

Must compile to a block schema where constructor type becomes mount guard and methods become typed capabilities. NOTE that the above pattern is likely not at all end state optimal, it only applies in principal. 

---

## 13. Prompt Template as Typed Block

The prompt is a block of named segments. Each segment has content, size budget, mutation policy, and expansion capability.

```
FT.segments([
  { name: 'goal', content: ref('agent.goal'), mutations: none },
  { name: 'tools', content: ref('compress', ref('tools'), budget(300)), mutations: ['expand', 'compress'] },
  { name: 'state', content: ref('partition.state'), mutations: none },
  { name: 'scratchpad', content: ref('agent.notes'), mutations: any },
  { name: 'response', content: gap(FT.string()), mutations: ['tell'] },
])
```

The LLM writes to the response segment. The agent expands/compresses the tools segment. Goal and state are read-only refs. The prompt IS a typed block.

---

## 14. Select/Query Patterns

Must support these selection patterns on the block store:

```
select 'a' : 5 (/a)
select 'b' : ["smuggled", 1,2,3,4] (/b)
select '*' : { a: 5, b: ["smuggled", 1,2,3,4] }
select '*/**/number' : 5 (/a)
select '*/**/number/**/*' : { 5 (/a), 1 (/b:1), 2 (/b:2), 3 (/b:3), 4 (/b:4) }
select '..' where { index < self.index } : ['experimental', { a: 5, b: ["smuggled", 1,2,3,4] }]
```

Wildcards, recursive descent, type predicates, relative addressing, index-based filtering.

---

## 15. Where Clause Structure

Two clause types, both derivable from the typed assignment:

- **where**: gate on entry. Checked once at mount time. If false, mount doesn't happen. Consumed after mount succeeds.
- **while**: persistent lifetime constraint. Checked continuously. If it becomes false after mounting, the mounted state is invalidated and downstream cascades.

Both can appear on a single tell:
```
tell(path, value, {
  where: clause(...),   // can this mount?
  while: clause(...),   // can this stay mounted?
})
```

Derived from the typed assignment:
- **where** (was where_input): preconditions on context, derived from value's refs and the mounting environment
- **while** + **where** (was where_output): postconditions — some are one-time validation (where), some are ongoing (while)

```
statement = {
  IF (getValidUser.duration < 200 seconds) {
    nextuser: concrete<ValidUser> = getValidUser
  }
}
```

where_input derived from `getValidUser`'s IO type. where_output derived from `concrete<ValidUser>` annotation.

Three outcomes: all clauses true → commit. Some false but planner finds path → pending. All remaining ambiguous with no path → reject.

---

## 16. Process Lock as Type Constraint

The lock on a partition is part of its type, not external metadata.

```
planned_expiry = max(lockholder_process.pings[-1] + PING_TIMEOUT)
where(realtime < planned_expiry)
ALL CALLS TO THIS TYPE ARE FED THROUGH process/1231234r234f
```

The lock holder, ping history, timeout, and expiry are constraints on the partition's type. The where clause on realtime vs planned_expiry governs all access. Lock breakage = where clause failure = cascade invalidation.

---

## 17. Composition Operators

### A & B — Overlay
Overlay B onto A on intersect, keep union of both. Unless B is a patch, in which case B just changes A at specified positions.

### A ∩ B — Narrow
Select and merge an overlay of constraints from one type to another. Intersection of constraint surfaces.

### default(inputData, defaults) — Patch If Missing
```
default(inputData, FT.block({
  val: FT.string("please insert any data here"),
  stepLimit: FT.number(10)
}, descriptions(
  ['val', "The default value of val, since it was non-concrete on the input data"],
  ['stepLimit', "Default to 10 steps unless otherwise specified"]
)))
```

Default inherits all specified behavioral constraints and only merges each individual entry if a corresponding item at that level of specificity does not exist and it coherently extends. Same as a patch IF null.

---

## 18. Stateful Toggle / Reactive Where Clauses

Where clauses that act as toggles — fire on transition, hold until counter-transition.

The problem: a simple where clause is fire-and-forget. It checks once. But we need quasi-toggles: "when value crosses above 20, create alarm. When it drops back below 20, delete alarm."

```
aboveThreshold = clause(ref('./-1/val'), lt, 20) && clause(ref('./val'), gt, 20)
belowThreshold = clause(ref('./-1/val'), gt, 20) && clause(ref('./val'), lte, 20)

once(ref('./aboveThreshold')).until(ref('./belowThreshold')) {
  alarm: BigAlarm = raise()
} then {
  delete alarm
}
```

`once(condition).until(counterCondition)` is a toggle mount: the block inside mounts when the condition first becomes true, and unmounts (with cleanup in `then`) when the counter-condition becomes true. The mount persists between the two transitions — it's not re-evaluated every tick.

This needs a clear semantic: is this a where clause that installs a gate and a counter-gate? Is it a block whose own where clause is the condition, with an anti-where clause that triggers teardown? Should these be pushed to a merge controller layer, or is the toggle primitive fundamental enough to be in the type system?

---

## 19. Block Schemas with Cardinality Constraints (Kit Forms)

Block schemas that drive form generation. Each entry has a name, type, cardinality, reason/description, and optional default.

```
types.block([
  types.assignment('model', ModelProviderRef, { reason: 'Model', description: '...', default: 'OpenAI Default' }),
  types.assignment('toolset', ToolsetRef, { min: 0, max: 10 }),
  types.zeroToMany(AnnotationType),
  types.assignment('steps', types.number(attrs(types.num.range(1, 1000))), { default: 10 }),
  types.zeroToOne(OptionalConfigType),
  types.oneToMany(RequiredInputType),
  types.exactly(3, SomeFixedType),
])
```

Block schemas decompose into `BlockSchemaEntry[]` for rendering kit forms. Each entry has: key, type, typeSerialized, required, reason, min, max, default.

---

## 20. Hoisted Type Rendering for CLI/Prompt

Tool signatures hoisted with deduplication for context efficiency. This is the single front end for both LLM prompts and CLI tool display.

```
// Complex types get hoisted to named definitions
type TaskInput = { board: string, filters?: object }
type TaskOutput = { id: string, status: string, ... }

// Tools reference the hoisted names
searchTasks: (input: TaskInput) → TaskOutput[]
createTask: (input: TaskInput) → TaskOutput
```

Hoister renders types/tools to the CLI/prompt surface. CLI input (user or LLM) parses back as extensions injected into the runtime. Symmetric: types out, assignments in.

---

## 21. Behavioral Constraint Election on Compose

When two types compose and both carry the same behavioral constraint, election rules determine the winner.

```
// Override priority: open (0) < sealed (1) < final (2)
// Equal priority: deterministic via lexicographic JSON sort (commutativity)

// Multi-instance constraints (can have multiple): label, call, temporal
// Singleton constraints (elect winner): merge, persist, visibility, mount
```

Compose is commutative: `compose(a, b) === compose(b, a)`.

---

## 22. Agent Prompt Context as Typed Block

The agent's prompt context is a strongly-typed block.

```
promptContextType = FT.object({
  narratives: FT.array(FT.string()),
  protocol: FT.string(),
  triggeringMessage: FT.string(),
  stepLimit: FT.number(),
  step: FT.number(),
  executionHistory: FT.array(FT.any()),
})
```

Typed bindings ensure the agent's context carries all required fields. Missing fields = gap = agent can't proceed until context is complete.

---

## 23. Partition History Storage and Versioning

Every record is indexed by a sequence number and a real-time timestamp at the partition at that time. When the content tail watermark advances, history behind it is pushed to a store that does incremental state snapshotting and event storage.

Indexing scheme:
```
/partitionID/(version=number | (timestamp (<|>=) number))
```

Supports:
- Single time-point lookup: "state of partition X at version N" or "at timestamp T"
- Relational navigation across time and version ranges
- Event cubes for aggregate queries across time ranges
- Incremental snapshots: snapshot + forward-applied diffs to rehydrate any version

When a partition is pulled (rehydrated from cold storage), the range indexing and event cube navigation become available locally. Until then, the bloom filter + remote ref handle key existence checks without full rehydration.

---

## 24. Error Handling = Gap Handling with Covers

Function errors are not exceptions — they are gaps. A thrown error at a position creates a gap with the error type. Resolution uses the same machinery as any other gap:

```
function throws
  → position becomes gap with error type
  → check enrolled covers for this gap type at this partition
  → cover exists → try it (same as planner finding alternate capability path)
  → cover succeeds → gap filled, merge continues
  → cover fails → escalate to next cover or parent process
  → all covers exhausted → reject merge, discard fork
```

Covers are enrolled per-partition as capabilities: "if gap of type TimeoutError at path X, try capability Y before rejecting." Covers are just capabilities with a where clause matching the error type. No special error handling system — errors are gaps, covers are capabilities, escalation is lifting, rejection is dead path. Same pipeline.

---

## 25. Hoisting and Frame Mounting Are the Same Operation

Mounting data onto a hoisted frame (the rendered prompt/CLI view) uses the same mechanism as mounting type considerations into the process's root function map. The hoister decides what to expand vs compress based on the probability that a sub-type will need to be pulled to memory. Low-odds subtypes stay compressed with expansion tokens.

The hoisted frame IS the process's working set. What's expanded is what the process (or LLM, or user) can operate on directly. What's compressed is behind expansion refs. Mounting more data into the frame = expanding compressed sections. The bet about what to expand is the same optimization at both levels.

---

## 26. DeltaT Tracing on ALL Function Executions

ALL ref reductions via function executions MUST be traced with at minimum timestamps on entry and exit. This is non-negotiable.

- Outer impl of a function type: trace entry_t, exit_t, duration
- Inner pipeline steps of a function: trace entry_t, exit_t, duration per step
- This applies to every function loaded in the system, including bootstrap/infrastructure functions

This data is what the planner uses for execution time estimation. Without it, backward chaining has no duration model and cannot plan.

---

## 27. ALL Bootstrap Functions Wrapped with FT.function

Every base function loaded to bootstrap an environment/process MUST be wrapped with `FT.function({ input, output, impl, description })`.

- `description` is required on FT.function — it feeds into hoisted tool rendering
- The wrapper provides: type checking on input/output, deltaT tracing, identity tracing, serializable schema
- No bare JS functions in the store. Everything is typed.

---

## 28. FieldTypes Are Serializable (Except Impls)

All FieldTypes must be serializable for everything EXCEPT function implementations. This is the basis for host allocation — you serialize the schema, send it to a host, and the host binds its own impls.

- Type schemas: serializable (kind, constraints, refs, descriptions, everything)
- Function impls: NOT serializable (live at the process level only)
- A function type without a concrete impl is a gap — it describes what's needed but can't execute

---

## 29. Gapped Refs Become Tools

All refs which exist on type load that are gapped and blocking concreteness are converted into tools. The tool's input type signature is the union of the ref's paths within the hoisted process frame, followed by whatever arguments the ref requires.

All concrete, expandable refs are hoisted with unique term IDs and an expansion syntax, along with whatever arguments the receiver stipulates are viable to de-page a segment of hidden context in the frame.

ALL of these tokens can be followed by their specified arguments wherever they are claimed to need them.

Example of the hoisted frame with tools, expandable refs, and usage:

```
scratchpad: object { } = { }

value = [
  "Here", "Are", "Some", "Elements",
  ...[[ 1.2.3.1 : ({ count: number ||= 10 }) => [string] & { size = 10 } ]]
]

AnotherTool = {
  --2.3.2 AnotherToolDescription:
  Here is a big long description I am sure some people may want to truncate
  But its not truncatable unless you use the truncation option on the expand tool
  someUselessAPI = () => any
}

then,
  next = (expand "1.2.3.1"="+" "2.3.2"="-") ;
  next.scratchpad.first-note = "Some note I will leave myself and maybe amend later";
  export next;
```

Key mechanics:
- `[[ 1.2.3.1 : signature ]]` = expandable compressed ref with unique ID and type signature showing what expansion returns
- `--2.3.2 Description` = named section with ID, expandable/compressible
- `expand "1.2.3.1"="+" "2.3.2"="-"` = expand one section (+), compress another (-), in one operation
- `||= 10` = default argument value (patchIfMissing)
- The response writes to scratchpad (mutation), exports the new state
- The frame after `expand` has different content at those IDs — the process re-renders with the new expansion state

Function field types with intermediates that don't concretely map input to output are the gap generators. Those gaps become the tools shown in the frame. The tool's signature IS the gap's type.
