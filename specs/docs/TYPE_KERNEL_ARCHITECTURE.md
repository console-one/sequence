# Type Kernel Architecture

## Status

Normative. This document defines the minimal type architecture from which the process model, client model, and view model derive.

---

## 1. One Primitive: The Block

A **block** is a constraint set. Its merge behavior is determined by its kind.

```
Block = { kind: Kind, constraints: Constraint[] }

merge(self: Block, patch: Block) → {
  self: Block,                // updated state (unchanged on rejection)
  out: Patch[],               // patches to propagate (lifted constraints, responses)
  status: 'ok' | 'gap' | 'reject',
  gaps?: Gap[],               // if 'gap': what's still needed
}
```

Every type, process, view, and request is a block. `merge` is the only operation a kind defines internally. The caller (`tell`) handles ordering, scope augmentation, transactional commit, and routing of `out` patches.

A process is NOT a block with a custom merge override. A process is a block whose constraints include function-type refs that require capabilities (scope bindings) to resolve. The "richer" merge behavior comes from richer constraints, not from overriding the merge function.

---

## 2. Two Modes: Primitive and Block

The type system has two fundamental modes:

- **Primitives**: string, number, boolean, null, symbol. Values. No identity, no history, no merge chain. Validated at assignment. You don't tell to a string — you replace it or you don't.
- **Blocks**: object, array, process. Indexed. Addressable. Have a head (current state of a reduction chain). Accept tells. Accumulate merge history. Like a row in a database, an instance in memory, a branch in git.

`FT.object({ name: FT.string() })` as a type = shape contract (no head).
`FT.block(FT.object({ name: FT.string() }))` = addressable instance with that shape, accepting tells.

A block exists where there's temporal evolution — collections that grow, processes that run, documents that get annotated. A block is the thing you'd put a git branch on. A class is a block whose refs include constructor inputs. Installation = mounting a class block. Processes are mounted blocks with where clauses on their lifetime.

Everything is either a value (primitive) or an address (block). No third category.

---

## 3. Constraints Are Statements

A constraint is: an operation over arguments.

```
Constraint = { op: string, args: unknown[] }
```

Arguments are either concrete values or refs (unresolved symbols). A constraint with all concrete args is evaluable. A constraint with refs is pending.

Refs are not a separate type. A ref is any argument that names a symbol not yet bound to a concrete value in the current scope.

---

## 3. Kinds of Blocks

### 3.1 Value Types

`FT.string()`, `FT.number()`, `FT.boolean()`, `FT.null()`

These are blocks whose constraints define guards on assignment. Their merge is: check the incoming value against the guards. Accept or reject.

They install no operations. They are pure predicates.

### 3.2 Object Type

`FT.object({ name: FT.string(), 'age?': FT.number() })`

A block whose constraints define:
- Property guards (key → type)
- Optionality and defaults
- Merge policy per property (compose, replace, source-wins)

Merge is: for each property in the patch, delegate to that property's type block merge. Reject unknown keys unless `additional` allows. Apply defaults for missing optional properties.

Installs operations: `set(key, value)`, `delete(key)` (if optional).

### 3.3 Array Type

`FT.array(FT.number(), { min: 1 })`

A block whose constraints define:
- Element type guard
- Length bounds
- Uniqueness, ordering, accumulation rules

Merge is: validate element against element type. Enforce length/uniqueness. Position-relative refs (previous, next) resolve within the array context.

Installs operations: `push(value)`, `splice(index, count, ...values)`.

### 3.4 Function Type

`FT.fn(inputType, outputType)`

A block whose constraints define:
- Input type (guard on invocation)
- Output type (contract on result)

Merge is: resolve input args against input type. If concrete, execute. Produce output. The function IS a legal state transition — it defines one way a partition can change.

The implementation (actual JS function) lives ONLY at the process level. The function type in the data layer is the ref: `{ op: 'via', args: ['functionId', inputConstraints, outputConstraints] }`.

### 3.5 Process Block

```
FT.block({
  state: template(operations),
  merge(self, patch) { ... }
})
```

A block with custom merge. This is the only thing that distinguishes a process from a passive type. The merge function is the reduction loop:

1. Timestamp the patch (bind to real time T)
2. Resolve refs in patch against self state
3. For refs that resolve → produce concrete values
4. For refs that don't → check capabilities for function chains
5. For function chains found → build plan (speculative execution sequence)
6. For nothing found → report gaps
7. Apply resolved patches to self state
8. Respond: mounted / rejected / gaps

The process block is itself a type from the outside. Other blocks interact with it through its merge. It appears in parent scopes as a type with an API surface derived from its current gap set and installed operations.

### 3.6 Or / And

`FT.or(FT.string(), FT.number())` — constraint set where one branch must satisfy.
`FT.and(typeA, typeB)` — constraint set where all must satisfy.

Merge is: try each branch (or) / compose all branches (and). For `or`, resolution means picking a branch — which eliminates the others (mutual exclusivity).

---

## 4. Mount Is Patch, Served by Merge

**Mount** is not a separate operation. Mount is what happens when a scope patches itself with a type request:

```
scope.tell(patch(path, type, args))
  → type.merge(scope_state_at_path, args)
  → response: { state, lock_id, where_clauses }
  → scope merges response at path
```

The scope asks for an instance. The type's merge decides whether to accommodate. The response includes:
- **state**: the initial instance state
- **lock_id**: proof of resource allocation (from the type/class)
- **where_clauses**: persistent constraints on the instance's lifetime

The instance exists at that path BECAUSE it holds the lock. The where clauses persist as ongoing guards. If any where clause breaks (resource exhausted, T expired, scope died), the instance is invalidated, and downstream constraints cascade.

---

## 5. Where Clauses

A **where clause** is a constraint attached to a tell that persists beyond the tell itself.

```
state.tell(
  value,
  where(clause('realtime', 'lt', deadline)),
  where(clause('memory', 'lt', limit)),
  where(clause('scope.alive', 'eq', true))
)
```

Where clauses:
- Guard the initial mount (reject if not satisfiable now)
- Persist as ongoing constraints (invalidate if broken later)
- Propagate upward when the block is mounted into a parent (the parent inherits the constraint)
- Propagate downward when the block mounts children (children inherit the constraint)

When a where clause breaks:
- The tell that carried it is invalidated at the real-time of breakage
- All downstream state built on that tell is invalidated
- Locks held under that where clause are released
- Pending mounts whose where clauses now satisfy can proceed

---

## 6. Process Model as Type Evolution

A process is a block that evolves over time by receiving patches (tells) and applying them through its merge function.

**Self** is the process's current constraint set — the accumulated result of all successful merges.

**Will** is the portion of self whose where clauses have unsatisfied T-predicates. It's state that self holds as "not yet actual." When T advances past the predicate, will becomes actual.

**Plan** is will organized as a dependency chain: which mounts execute in which order when their T-predicates satisfy.

The process cycle:
1. Receive tell (patch from environment, with T = now)
2. Merge: resolve patch against self
3. Some will may now satisfy (T advanced)
4. Cascade: resolved patches may enable further mounts
5. Stable state: project new self
6. Compute next wake-up from earliest unsatisfied T-predicate
7. Report changes to environment (re-tell to parent/views)

---

## 7. Tells (Requests) as Type Patches

Every external request is a patch to the process's type:

- **User clicks button** → `tell(path, value)` — patch at path with concrete value
- **LLM tool call** → `tell(path, value, where(...))` — patch with constraints
- **API response** → `tell(path, data)` — patch at path with received data
- **Timer fires** → `tell('T', newTime)` — patch real-time, enabling where clauses

The request IS a constraint set being merged into the process. The request's refs resolve against the process's state. If they resolve, the merge succeeds. If not, the unresolved refs are the response's gaps — "I need more information to process this request."

Request and response are both blocks made increasingly concrete:
- Request starts as a type (shape of what's being asked)
- Refs resolve as the process works on it
- When fully concrete in the relevant partition, the request is fulfilled
- The response is told back as a patch to the requester's view

---

## 8. Views as Suspended Merges

Every process, client, or view is a **suspended merge** — a block whose merge is waiting for patches to complete.

The view block declares: "I display state from partition X, projected at fidelity Y, with injection points for user input at Z." The view's refs point to the process's state. When the process's state changes, the view's refs resolve to new values, and the view re-projects.

The view is not a subscriber. The view IS a block mounted on the process's type surface. Its where clauses say which parts of state it cares about. When those parts change, the view's merge re-runs (re-render).

The view's injection points are the tool calls / form fields / buttons. Each is a typed hole: "if you provide input of type A at this position, it will be told to the process as a patch, which will trigger a merge, which will update state, which will re-project the view."

The cycle:
1. View block mounts on process state
2. View projects: expanded state + compressed regions + injection points
3. User acts on injection point (provides input)
4. Input is told to process as a patch
5. Process merges, state evolves
6. View's refs resolve to new values
7. View re-projects
8. Repeat

---

## 9. Data Concreteness and Ref-Based Storage

A block's data is NOT uniformly "in memory" or "in a store." Different partitions of the same block are made concrete through different function pipelines, specified by refs.

```
Users = FT.array(UserType)
  // users[0..49]       — in memory (concrete, no ref)
  // users[50..10000]   — ref: { via: 'sqlite.query', args: { table: 'users' } }
  // users[*].avatar    — ref: { via: 's3.fetch', args: { bucket: 'avatars' } }
  // users[*].authToken — ref: { via: 'redis.get', args: { prefix: 'auth:' } }
```

Each partition has its own ref chain specifying how it becomes concrete. The refs are function types with input/output contracts. The process either has the capability to execute them or it doesn't.

When a process needs `users[5000].email`:
1. The block has a ref: `{ via: 'sqlite.query', args: { id: 5000 } }`
2. Process checks: do I have `sqlite.query` capability? If yes → execute → position becomes concrete.
3. If no → gap. Lifts to a process that does have it.

**Delegation is capability-based, not store-based.** There is no "store process" that owns data. There are blocks with refs, and processes with capabilities. A process with SQLite access resolves database refs. A process with S3 access resolves storage refs. A process with LLM access resolves generation refs. The SAME block may need three different processes to become fully concrete in different partitions.

Writing works the same way. A write to `users[5000].email` goes through whatever ref pipeline governs that partition. The ref specifies not just how to READ but how to WRITE — the function type's input/output contract covers both directions.

This means:
- No separate "backing store" concept. Just refs with function type pipelines.
- No "database layer." Just capabilities that processes may or may not have.
- Delegation = which process has which capabilities to resolve which refs.
- The same block can be partially in memory, partially in SQLite, partially in S3, partially unresolved — all specified by its ref structure.

---

## 10. Ephemeral vs Persistent

**Persistent constraints** survive the merge and become part of committed state. Values, type guards, where clauses.

**Ephemeral constraints** exist only during merge execution. Process ID, request ID, intermediate computation state, response callbacks. They live at the process partition, not the data partition. They are the "process mount" half of the intersection — present during execution, absent from the committed result.

The block constructor distinguishes them:
```
ephemeral(
  set('requestId', uuid()),
  set('response', responseBlock),
)
```

Ephemeral constraints are how the process tracks its own execution without polluting the data. The data partition sees only the result. The process partition held the execution context.

---

## 10. Implementation Plan

### Phase 1: Block Primitive

- Define `Constraint = { op, args }`
- Define `Block = { kind, constraints, merge? }`
- Implement default merge (structural compose) for each kind
- Builder API: `FT.string()`, `FT.number()`, `FT.object()`, `FT.array()`, `FT.fn()`, `FT.or()`, `FT.block()`
- Test: blocks compose, guards reject invalid patches, defaults apply

### Phase 2: Refs and Resolution

- Refs are arguments that name unbound symbols
- `mount(block, target)` → resolve refs against target → `MountResult { merged, gaps, lifted }`
- Gaps are the API surface / type ambiguity / injection points
- Test: refs resolve against target, unresolved refs reported as gaps, gaps describe what's needed

### Phase 3: Where Clauses

- `where(clause(a, op, b))` attaches persistent constraints to tells
- Where clauses propagate upward and downward on mount
- Where clause breakage invalidates downstream state
- Test: temporal where clauses, resource where clauses, scope-liveness where clauses, cascade on breakage

### Phase 4: Process Block and Tell

- `tell(scope, patch)` — the process boundary. Serializes access, augments patch with scope data (T, process ID), calls merge, commits on success, routes `out` patches.
- Process = block with function-type refs in its constraints that require capabilities to resolve
- Capabilities = function-type bindings in scope (not injected separately). A subscope limits which capabilities a particular merge can access.
- Plan: pending merges whose where clauses have unsatisfied T-predicates
- Test: process receives tells, refs resolve via scope bindings, plans execute when T satisfies, subscopes limit capability exposure

### Phase 5: View Projection

- `project(block, { depth, path })` → expanded + compressed + injections + gaps
- Injection points derived from gap analysis
- Compressed regions carry their expansion type
- Re-projection on state change
- Test: view projects process state, injection points match gaps, re-projects after tell

### Phase 6: Lock and Delegation

- Class blocks manage instance allocation via locks
- Lock = where clause on instance liveness
- Delegation = symbol with authority window
- Lock breakage cascades resource release
- Test: class limits instances, scope death releases lock, blocked mounts proceed after release

---

## 11. What to Keep from Existing Code

| Keep | Why |
|------|-----|
| Builder API (`types.*`) | Ergonomic surface for constructing blocks. Adapt to produce new Block shape. |
| Constraint type definitions | Structural constraints (property, values, accumulate) map to ops. |
| `compose.ts` object/array meet | Core of default merge for object and array kinds. |
| `concreteness.ts` gap analysis | Derives gaps from a block — becomes the injection point derivation. |
| `find.ts` attribute extractors | Utility for walking constraint attributes. |
| `statement.ts` types + constructors | Statement grammar for the tell surface. |
| `error.ts` | Structured errors. |
| `jsonschema.ts` | Ingestion from external schemas. |
| Wire/normalize | Serialization. |

| Remove or Subsume | Why |
|---|---|
| `workspace.ts` | Mutable FT as authority is wrong. Process block replaces it. |
| `scope.ts` | Cascade is mount-triggering-mount. Falls out of merge. |
| `workspaceInterpreter.ts` | Interpreter IS the block's merge. No separate dispatch. |
| `type.ts` Draft/Modifier/attachHelpers | Fluent mutation on data. Blocks are inert. Operations are external. |
| `type.ts` FieldTypeSpec 500+ lines | Factory methods become block builders. Compose becomes default merge. |
| `hoist.ts` / `formatter.ts` / `format.ts` | Three renderers → one `project()` function. |
| `domain.ts` | App-specific types. Move to application layer. |
| `resolution.ts` / `resolvers.ts` | Application-layer concern. Move out of type library. |
| `ref.ts` RefResolver registry | Refs resolve through mount, not a separate registry. |
| `numericProjection.ts` / `arithmeticTypes.ts` | Specialized numeric ops. Become capabilities on process, not kernel. |
| `constraint.ts` Env/TypeValue dead code | Dead code. Delete. |
| `constraint.ts` 20 behavioral constraint types | Most become where clause patterns, not constraint primitives. |

---

## 13. Planning IS Backward Chaining Through Function Type IO

When a future-T claim arrives (`tell(path, value, where(T > deadline))`), the system backward chains:

1. What function produces this output type? Search capabilities.
2. What does that function need as input? Check if concrete or gap.
3. If gap: what function produces THAT input type? Search again.
4. Repeat until all inputs are concrete (chain reaches current state) or no function bridges a gap (dead path).

The chain of functions IS the plan. Each link is a mount. Estimated execution time = historical input/output duration stats per function type.

**Resolution outcomes:**
- All paths lead to concrete inputs → pick best chain (shortest/cheapest), plan its mounts
- All paths dead (no function bridges some gap) → dead claim. Report impossibility.
- Some paths dead, but contingency action exists (e.g., "if can't execute, write failure here") → invoke contingency
- Paths exist but need escalation (human input, external API, etc.) → escalation mount

**Reactive replanning:**
- If any fact in the planned chain updates → recompute from that point forward
- If MIN_T of chain < REAL_TIME and MAX_T > REAL_TIME → run the first mount immediately
- If new facts invalidate a planned link → that link's downstream is dead → find alternate path or escalate

**Everything is event firing and mounting in the central pipeline.** There is no scheduler module. There is no planner module. There is no orchestrator. There is:
- A claim arrives with a future T
- Mount tries to resolve it
- Unresolved refs backward chain through function type IO
- The chain IS the plan
- Each link fires when its inputs become concrete
- Dead paths → dead claims or escalation
- The merge pipeline does all of this

---

## 14. Merge Protocol

Every tell pushes a block of constraints. Each constraint becomes a pending mount with where clauses. The lifecycle:

**Three outcomes:**
- All where clauses true → **commit** (merge to HEAD)
- Some clauses false but planner finds capability paths to make them true → **pending** (keep working)
- All remaining false clauses have no viable path → **reject**

**Mechanics:**
1. Constraint enters as pending. Its where clauses evaluate concurrently.
2. True clauses activate their part of the mount.
3. False clauses trigger the planner: search capabilities whose output type would satisfy the clause.
4. Planner finds a chain → mounts the chain as more pending constraints (recursive — same protocol).
5. Ambiguous clauses wait — values they depend on may be pending too.
6. Cancel condition races against load condition: `realtime > deadline && !resolved` vs `allClausesTrue`.
7. Cancel wins → pending mount dies. Load wins → pending mount commits.

**No mount boundary function. No interpreter.** Just constraints mounting constraints, where clauses evaluating concurrently, gates firing as values change, planner triggered when gates fail, recursive until commit or reject.

**Statement type:**
- Value (what we claim)
- Where_input (derived from value — preconditions on context, bubbled up from refs)
- Where_output (from type annotation — postconditions on the fork before merge)

Both where clause sets are derived, not written. The author writes typed assignments. The system extracts the clauses from the types.

**Function IO wrapping (automatic per mount boundary):**
- Stack frame forked for every function call
- `_t_input = T` bound at entry, `_t_output = T` bound at exit
- Identity trace: which outputs derived from which inputs
- Duration: `_t_output - _t_input` (recorded for planner's historical estimates)
- All automatic. Function author only declares IO type.

---

## 15. Invariant

A block is a constraint set whose merge is defined by its kind. Mount is patch, served by merge. Tell is the process boundary that serializes, augments, commits, and routes. Every process, view, and request is a block. State is the accumulated result of successful merges. Will is state whose where clauses haven't satisfied yet. Gaps are refs that haven't resolved. The API surface IS the gap set. Capabilities are scope bindings, not a separate registry. Data concreteness is per-partition, governed by refs to function-type pipelines. Planning is backward chaining through function type IO. Dead paths are dead claims. Escalation is a mount. Everything is additive, bound to real time, and the root is always mounting self onto the future. There is no scheduler, no planner, no orchestrator — only the merge pipeline.
