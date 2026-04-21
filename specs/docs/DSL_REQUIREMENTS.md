# Behavioral Type DSL — Requirements

## What It Is

A statement language that compiles to mount operations on a Sequence. OOP surface notation — types are classes, `<<` is the constructor, predicates are method contracts, `prev` is `this`, `&` is composition. The value isn't in the notation (which is deliberately familiar). The value is in what the Sequence provides on top of it: suspension/resumption, backward inference, capability search, temporal scoping, probabilistic reliability, and build-time contract validation.

Types and values are the same continuum. A value is a maximally concrete type. Everything reduces. What reduces fully is a value. What can't reduce yet is an obligation.

---

## Two Operators

| Operator | Meaning |
|----------|---------|
| `=` | Overwrite (replace whatever was there) |
| `<<` | Narrow (compose with what's there; rejected if incompatible) |

Both work at top level and inside blocks. No other data operators.

---

## Blocks

A block is a scoped computation. It forks, mounts statements, reduces, and exports:

```ft
x = {
  import a from './some-path'
  local = { name: string, role: "admin" }
  a << local
  export a
}
```

- `import name from 'path'` — brings a path from parent scope into the block
- `=` and `<<` — mount statements within the block scope
- `export expr` — the block's result, assigned to the left side

Blocks reduce as far as they can. Fully resolved = a value. Partially resolved = an obligation with gaps. This is contingent derivation — not a special case, just mount semantics.

```ft
-- Direct composition (one line)
x = a & somevalue

-- Same thing as a block
x = {
  import a from './path'
  somevalue = { blah: string }
  export a & somevalue
}
```

---

## Prev and Self-Reference

Inside any assignment or block, `prev` refers to the projection snapshot at T_in — the state BEFORE this mount applies. This enables state transitions:

```ft
counter = prev + 1                          -- increment
budget = prev.budget - cost                 -- decrement by computed amount
```

In a composed type's method predicate, `prev` is the ENTIRE composed object's pre-mount state:

```ft
Shop = Order & Inventory & Budget
Shop << {
  pay: (ref: string) -> { ok: true
    | status = "paid"
    | count = prev.count - quantity          -- cross-class: Inventory
    | budget = prev.budget - paymentFee      -- cross-class: Budget
  } when status = "created"
}
```

`prev.count`, `prev.budget`, `prev.status` all reference the consistent snapshot at function invocation time. Cross-class transitions are just predicates that reference `prev` paths belonging to other composed types.

There are no transition policies. No special `{ transition: "add" }`. Every transition — same-path or cross-class — is a refinement predicate using `prev`.

---

## Types (= Classes)

A type with underdefined terms IS a class. `<<` is the constructor. Narrowing provides concreteness. `where` gates instantiation.

```ft
-- Class: underdefined (schemas, no values)
Worker = {
  heartbeat: number,
  livenessWindow: number,
  alive: boolean | alive = (prev.heartbeat > _rt - prev.livenessWindow),
  task: string while alive = true onBreak events.taskExpired = true
}

-- Instantiation: narrow with concrete values
worker1 = Worker
worker1 << { livenessWindow: 5000 }
worker1 << { heartbeat: _rt }
worker1 << { task: "job-42" }
```

Derived predicates ARE methods — they recompute on cascade when inputs change. `alive` recomputes every time `heartbeat` or `livenessWindow` changes.

---

## Expressions

### Primitives
```ft
string                          number
string /^[a-z]+$/               number >= 0
string /^[/]/, 1..4096          number 0..100
boolean                         number.integer >= 0
null
```

### Literals
```ft
"hello"    42    true    null
```

### Objects (inline concrete values)
```ft
{ name: "alice", age: 30, role: "admin" }
```

`{ }` is for small inline object LITERALS — fully concrete values. Not for type definitions.

### Blocks (the universal container)
```ft
[
  read = (p: string /^\//) -> { content: string, size: number >= 0 }
  write = (p: string /^\//, content: string) -> { ok: true }
  "Engine-agnostic: works with local fs, S3, SFTP"
  ref("./auditable")
]
```

`[ ]` is the block — ordered entries, pkey optional, mixed content. Each entry is either:
- `key = value` — named entry (pkey'd)
- `"string"` — documentation (value without pkey)
- `ref("path")` — reference to another block
- `-- comment` — narrative context

This IS the Sequence's own entry format. A type definition IS a block. The structure is universal. What drives REDUCTION depends on where the block is mounted:
- Mounted at root level → full Sequence reduction (cascade, suspension, conjunction)
- Used as a type expression → structural only (no active reduction until mounted)
- Hoisted as output → rendered as-is with `[[ ]]` for gaps

### Typed arrays (element-constrained blocks)
```ft
[string]               -- block where every entry's value is a string
[string, 1..100]       -- with length bounds
```

### Functions
```ft
(path: string /^[/]/) -> { content: string, size: number >= 0 }
```

### Unions and Intersections
```ft
string | number                 -- union
A & B                           -- intersection (compose, lattice meet)
```

### References
```ft
ref(path)                       -- live reference (reading follows the source)
snapshot(path)                  -- copy of current value
name                            -- resolves in scope (block-local, then parent)
```

### Expansion Tokens (stubs / gaps)
```ft
[[ description ]]               -- untyped gap: obligation with any type
[[ label : description ]]       -- labeled gap: addressable for targeted expansion
```

Expansion tokens are deliberate stubs. They compile to obligations — schemas without values. The system can request expansion by sending the surrounding context to an LLM or human, asking them to fill in the token's location.

This is the SAME format as hoist output. When the system renders state for a prompt, compressed sections appear as `[[ label : expand ]]`. When the LLM responds with `ft` blocks, it can include the same tokens for parts it can't resolve. The format is round-trippable:

```
human writes ft block (with stubs)
  → compiler mounts (stubs become obligations)
  → hoist renders for prompt (obligations become expansion tokens)
  → LLM reads prompt, fills some tokens, stubs others
  → compiler mounts LLM output (filled = values, stubbed = obligations)
  → repeat until fully concrete
```

A valid `ft` block can be a skeleton with stubs on the non-critical path:

```ft
Shop = Order & Inventory & Budget

Order = {
  status: "created" | "paid" | "shipped",
  pay: (ref: string) -> { ok: true | status = "paid" } when status = "created",
  ship: [[ expand: ship transition with tracking number ]]
}

Inventory = { count: number >= 0 }
Budget = [[ expand: budget tracking with per-transaction limits ]]

Shop << {
  pay: (ref) -> { ok: true | count = prev.count - quantity }
}
```

This compiles. `Order.ship` and `Budget` are gaps. The critical path (`Order.pay` with the cross-class inventory transition) is fully specified and validates at build. The stubs are obligations that can be filled incrementally.

---

## Refinement Predicates

`|` after a structural type. Declares what MUST BE TRUE — not how to compute it.

```ft
{ content: string, size: number | size = byteLength(content) }
```

### Atemporal (hold always)
```ft
| size = byteLength(content)
| path MATCHES /^[/]/
| status IN { "active", "pending" }
```

### Temporal (hold over an interval, scoped to function IO boundaries)
```ft
| read(p).content = body  @[T_out..next_write(p).T_out)
```

`fn.T_in` — when input was received. `fn.T_out` — when output was produced. No other temporal phases.

### Probabilistic
```ft
| read(p).content = body  @[T_out..next_write(p).T_out)  ~survival(exp, 0.001)
```

### Cross-class (using prev)
```ft
| count = prev.count - quantity
| budget = prev.budget - cost
```

### Operators
```ft
=  !=  <  <=  >  >=  MATCHES /re/  HAS element  IN { v1, v2 }  SATISFIES Type
```

### Quantifiers
```ft
forall c : derived_from(cell) . readCell(c).value = eval(c.formula)
```

---

## Modifiers

Applied to any `=` or `<<` statement:

```ft
x = "ready" when auth EXISTS               -- entry gate: suspends if false, resumes when true
x = "alive" while heartbeat.fresh          -- lifetime gate: invalidates when false
x = "held" while pid EXISTS                -- with break handler:
  onBreak events.released = true
x = config by "admin"                      -- provenance
delete x                                   -- remove value
```

### On capabilities
```ft
cap Worker.heartbeat                        -- mark capability exists (impl is external)
cap send when status = "connected"         -- capability with precondition
```

---

## Composition

`&` composes types. Refinement predicates conjoin. This IS the class composition mechanism — no inheritance hierarchy, no diamond problem, no method resolution order. Lattice meet is deterministic, commutative, associative.

```ft
FileSystem = BaseFS & WriteReadIdentity & SizeIdentity & Auditable
Shop = Order & Inventory & Budget
Agent = FileSystem & LLM & Workflow
```

When composing, `<<` on the composed type narrows function predicates. If the narrowing references a property that doesn't exist in the composed type, it's rejected (compose produces never).

```ft
-- Auditable only narrows types that HAVE read/write
FileSystem << Auditable   -- works: FileSystem has read and write
LLM << Auditable          -- rejected: LLM has complete, not read/write
```

---

## Full Example

```ft
-- FileSystem as a block: ordered entries, interleaved docs
FileSystem = [
  read = (p: string /^[/]/, encoding?: string) 
       -> { content: string, size: number >= 0, mtime: number 
            | size = byteLength(content) }
       ~lognormal(mu=4.6, sigma=1.2)

  write = (p: string /^[/]/, content: string, createDirs?: boolean) 
        -> { ok: true, bytesWritten: number >= 0 
             | bytesWritten = byteLength(content)
             | read(p).content = content  @[T_out..next_write(p).T_out)  ~survival(exp, 0.001)
             | list(parent(p)) HAS basename(p)  @[T_out..delete(p).T_out) }
        ~lognormal(mu=5.0, sigma=1.5)

  "Engine-agnostic: works with local fs, S3, SFTP"

  list = (p: string /^[/]/, pattern?: string, recursive?: boolean) 
       -> [{ name: string, path: string, isDir: boolean, size: number >= 0 }]
       ~lognormal(mu=5.5, sigma=1.0)

  ref("./auditable")
]

-- Order as a block
Order = [
  status = "created" | "paid" | "shipped"
  quantity = number >= 0
  pay = (ref: string) -> { ok: true | status = "paid" } when status = "created"
  ship = () -> { ok: true | status = "shipped" } when status = "paid"
]

Inventory = [ count = number >= 0 ]

-- Composition with cross-class transitions
Shop = Order & Inventory
Shop << [
  pay = (ref: string) -> { ok: true
    | count = prev.count - quantity
  }
]

-- Workflow as a block with import/export
ReportAgent = [
  import fs from './contractlike/fs'
  import llm from './contractlike/llm'

  generate = (topic: string) -> { ok: true, path: string
    | let content = fs.read("/data/" + topic).content
    | let report = llm.complete("Summarize: " + content).text
    | fs.write("/reports/" + topic + ".md", report).ok = true
    | path = "/reports/" + topic + ".md"
  }

  "Reads input data, generates summary via LLM, writes report"

  cap generate
  export generate
]

-- Instantiation with concrete values
worker1 = Worker
worker1 << { livenessWindow: 5000, heartbeat: _rt, task: "job-42" }

order1 = Order & Inventory
order1 << { status: "created", quantity: 3, count: 100 }
```

---

## Interleaving with Markdown

`ft` blocks live inside markdown narratives. The document is the spec. Multiple blocks in the same document share scope.

````markdown
# Heartbeating

Workers publish timestamps. Liveness is a predicate on stored data.

```ft
Worker = {
  heartbeat: number,
  livenessWindow: number,
  alive: boolean | alive = (prev.heartbeat > _rt - prev.livenessWindow)
}
```

Tasks live only as long as the worker is alive:

```ft
Worker << {
  task: string while alive = true
    onBreak events.taskExpired = true
}
```

When the heartbeat expires, the task invalidates and resurfaces as an obligation.
````

---

## What the Sequence Provides Over Plain OOP

The DSL surface IS OOP. The Sequence runtime is not:

| OOP | Sequence |
|-----|----------|
| Method fails → throw | Where clause fails → **suspend**, resume when satisfied |
| No discovery | Gap → **search** capabilities → match → schedule |
| Mutable state | **Append-only** log, projection is derived |
| Method = procedure | Predicate = **contract** (any impl that satisfies it works) |
| No temporal semantics | `@[T_out..T_until)` **scoping** with `~survival` probability |
| No backward inference | `backwardInfer(fn, output)` → **derives** input requirements |
| Inheritance (fragile) | `&` **lattice meet** (deterministic, commutative, associative) |
| Tests validate at runtime | `compose(spec, impl)` **validates at build** |

---

## Comments Are Narrative State

Comments (`--`) are NOT stripped. They are preserved in the AST as first-class statements. Comments are the narrative context of the type claims — the descriptive half of the two-way channel.

```ft
-- This module manages worker liveness via heartbeat timestamps.
-- The orchestrator monitors [[ expand: reassignment policy details ]].
Worker = {
  heartbeat: number,
  alive: boolean | alive = (prev.heartbeat > _rt - prev.livenessWindow)
}
```

Comments can contain `[[ ]]` expansion tokens — stubs in the NARRATIVE, not just in the types. The LLM can expand them with more description, not just more type definitions. The channel carries both.

When hoist() emits state, it emits the qualifying metadata AS comments:
```ft
-- @source: block 42, author "admin"
-- @valid: while session EXISTS
-- @expand(Worker.task): cap available
Worker = { ... }
```

These comments flow through the round-trip intact. Human writes them. Hoist generates them. LLM reads them. Parser preserves them. The narrative and the types travel together.

---

## Round-Trip: Write = Hoist = Prompt = Compile

The DSL format is isomorphic with hoist output. What a human writes is what the system renders is what an LLM reads is what the compiler accepts:

```
ft block (human writes)
  → compile → mount → Sequence state
                          ↓
                      hoist()
                          ↓
                    ft block text (same format, with [[ ]] for gaps)
                          ↓
                    LLM reads, fills stubs, returns ft block
                          ↓
                    compile → mount → Sequence state (more concrete)
                          ↓
                        ...repeat until fully concrete
```

`hoist()` MUST emit valid `ft` syntax. Concrete values appear as literals. Schemas without values appear as type annotations. Gaps appear as `[[ label : description ]]` expansion tokens. The LLM responds in the same format — filling some tokens, stubbing others.

This means there is ONE format for: requirements documents, prompts, LLM responses, and compiled specifications. No translation between layers.

---

## Compilation

The parser produces `(seq: Sequence) => MountResult[]`.

| Surface | Compiles to |
|---------|------------|
| `x = expr` | `seq.mount('schema' or 'bind', 'x', compile(expr))` |
| `x << expr` | `compose(seq.typeAt('x'), compile(expr))` then mount |
| `x = { import; stmts; export }` | Fork Sequence, mount inner, bind export to x |
| `prev` | `seq.getPrevious(path)` or projection snapshot at T_in |
| `delete x` | `seq.mount('delete', 'x')` |
| `cap path` | `seq.mount('cap', 'path', true)` |
| `... when cond` | `{ where: [compile(cond)] }` |
| `... while cond` | `{ while: [compile(cond)] }` |
| `... by "author"` | `{ author: 'author' }` |
| `A & B` | `compose(A, B)` |
| `A \| B` | `FT.or(A, B)` |
| `ref(path)` | `FT.ref(path)` |
| `\| pred @[from..until) ~dist` | `identity(...)` + `temporal(...)` + `distribution(...)` constraints |
| `forall x : set . P` | Quantified constraint |
