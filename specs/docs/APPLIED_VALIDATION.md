# Applied DSL Validation — Against Actual Requirements

Each section takes an actual requirements/ file and expresses its
acceptance criteria as `ft` blocks. If the criteria can't be expressed,
the DSL is insufficient.

---

## 1. Claude Code Agent (agent/claudecode.md)

```ft
-- R1, R2: Connection type with mode and config
ClaudeConnection = {
  mode: "local" | "remote",
  config: { workdir?: string /^[/]/, endpoint?: string, model: string },
  status: "connected" | "disconnected" | "errored",
  history: [{ role: "user" | "assistant", content: string, toolCalls?: number }]
}

-- R3: Send prompt capability
ClaudeConnection << {
  send: (prompt: string) -> { response: string, toolCalls: number
    | history HAS { role: "user", content: prompt }  @[T_out..)
    | history HAS { role: "assistant", content: response }  @[T_out..)
  }
}

-- R4: Status reflects process liveness (AC5, AC6)
ClaudeConnection << {
  status = "connected" while processAlive EXISTS
    onBreak status = "disconnected"
}

-- R6: Sends to disconnected instance suspend (AC8, AC9)
ClaudeConnection << {
  send: (prompt) -> { response
    | send suspends when status != "connected"
    | send resumes when status = "connected"
  }
}

-- R5: History is ordered (AC7)
ClaudeConnection << {
  history: [{ role, content }
    | forall i : 0..length(history)-1 . history[i].T_out <= history[i+1].T_out
  ]
}

-- R7: Multiple independent connections (AC10)
-- Just instantiate two: each is its own Sequence path
agents.a = ClaudeConnection
agents.a << { config: { workdir: "/project-a", model: "opus" } }
agents.b = ClaudeConnection
agents.b << { config: { workdir: "/project-b", model: "sonnet" } }

-- R8: Addressable by other processes (AC11)
cap agents.a.send
cap agents.b.send
```

**Can it express all AC?**
- AC1 (local connection): ✓ `agents.a << { config: { workdir: "/x", model: "opus" }, mode: "local" }`
- AC2 (remote connection): ✓ same with `mode: "remote", config: { endpoint: "..." }`
- AC3 (config readable): ✓ config is a typed path, `get('agents.a.config')` returns it
- AC4 (structured response): ✓ `send` returns `{ response, toolCalls }`
- AC5 (status auto-updates on death): ✓ `while processAlive EXISTS onBreak status = "disconnected"`
- AC6 (status recovers on reconnect): ✓ mount `processAlive` → while-condition holds again → but wait, the old block was invalidated. Need a NEW mount of status="connected".

**BREAK**: AC6 — reconnection. When `processAlive` reappears, the invalidated `status = "connected"` block doesn't automatically re-apply. Someone must mount `status = "connected"` again. This is correct behavior (reconnection is an explicit action, not automatic), but the AC says "status changes back to connected." The process loop handles this — when it detects the process is alive again, it mounts the status. Not a DSL gap — it's a fact that gets mounted externally.

- AC7 (ordered history): ✓ `forall i . history[i].T_out <= history[i+1].T_out`
- AC8 (suspended on disconnect): ✓ `send suspends when status != "connected"` — but this syntax is informal. Formally: `send`'s `when` clause gates on status.

**BREAK**: `send suspends when status != "connected"` — the DSL has `when` as an entry gate on mounts, but `send` is a function call, not a mount. The suspension semantics is: when the caller invokes `send` and the system resolves it as a PendingInvocation, the caller checks if status = connected before actually executing. This is a WHERE clause on the capability, not on a mount.

**Fix needed?** No — the caller's process loop handles this. The capability is registered (`cap send`), and the caller checks `status` before invoking. Or: `send`'s function type could include a precondition:

```ft
ClaudeConnection << {
  send: (prompt: string) -> { response: string }
    when status = "connected"
}
```

`when` on a function type means: this capability is only invocable when the condition holds. If not, the invocation suspends. This IS expressible — `when` as a modifier on a function definition, compiling to a where clause on the capability's mount.

- AC9 (resume on reconnect): ✓ suspended send resumes when status becomes "connected" (standard resume behavior)
- AC10 (independent connections): ✓ separate paths
- AC11 (inter-process): ✓ `cap agents.a.send` makes it callable

**All 11 AC expressible.** One syntactic extension: `when` on function types (preconditions on capability invocation).

---

## 2. Heartbeating (distributedsched/heartbeating.md)

```ft
-- R1, R2: Worker with heartbeat and configurable window
Worker = {
  heartbeat: number,      -- timestamp of last heartbeat
  livenessWindow: number  -- ms (configurable per R2)
}

-- R3: Liveness is a derived predicate on stored timestamps (R6: no polling)
Worker << {
  alive: boolean
    | alive = (heartbeat > _rt - livenessWindow)
}

-- R4: Tasks conditioned on liveness auto-invalidate
Worker << {
  task: string while alive = true
    onBreak events.taskExpired = true
}

-- R5: Invalidated tasks surface for reassignment
-- (automatic — invalidated task becomes an obligation again)

-- R7: Heartbeat arrival resets window (AC8)
-- (automatic — each mount of heartbeat updates the timestamp, alive re-evaluates)

-- Concrete instance
worker1 = Worker
worker1 << { livenessWindow = 5000 }
worker1 << { heartbeat = _rt }          -- current time
worker1 << { task = "process-job-42" }  -- assigned while alive
```

**Can it express all AC?**
- AC1 (heartbeat stored): ✓ `worker1 << { heartbeat = _rt }`
- AC2 (window configurable): ✓ `worker1 << { livenessWindow = 5000 }`
- AC3 (alive within window): ✓ `alive = (heartbeat > _rt - livenessWindow)` — 3s ago with 5s window → alive
- AC4 (dead outside window): ✓ same predicate — 6s ago with 5s window → not alive
- AC5 (task invalidated on death): ✓ `task: string while alive = true onBreak events.taskExpired = true`
- AC6 (task reappears for reassignment): ✓ invalidated task's schema still exists → obligations() surfaces it
- AC7 (no polling): ✓ liveness is a derived predicate on stored values, evaluated during mount
- AC8 (heartbeat resets): ✓ each `worker1 << { heartbeat = _rt }` is a new mount that updates the timestamp

**All 8 AC expressible.** No DSL extensions needed. The `while alive = true` pattern is the entire heartbeat system.

---

## 3. FSM (watchers/fsm.md)

```ft
-- R1: State constrained to valid set
Order = {
  status: "created" | "paid" | "shipped" | "delivered",
  paymentRef?: string,
  shippedAt?: number,
  deliveredAt?: number
}

-- R2: Transitions gated on current state
Order << {
  pay: (ref: string) -> { ok: true
    | status = "paid"
    | paymentRef = ref
  } when status = "created",

  ship: () -> { ok: true
    | status = "shipped"
    | shippedAt = _rt
  } when status = "paid",

  deliver: () -> { ok: true
    | status = "delivered"
    | deliveredAt = _rt
  } when status = "shipped"
}

-- R4: Invalid transition suspends (not rejects)
-- (automatic — `when status = "created"` suspends if status != "created")

-- R9: Atomic multi-field update
-- (automatic — transitions are mount blocks with multiple entries, atomic)

-- Concrete instance
order1 = Order
order1 << { status = "created" }

cap Order.pay
cap Order.ship
cap Order.deliver
```

**Can it express all AC?**
- AC1 (invalid state rejected): ✓ `status: "created" | "paid" | "shipped" | "delivered"` — literal union, "invalid_state" fails compose
- AC2 (pay from created succeeds): ✓ `pay when status = "created"` passes, status → "paid"
- AC3 (pay from paid suspends): ✓ `pay when status = "created"` — status is "paid" so `when` fails → suspends
- AC4 (pay without ref fails): ✓ `pay: (ref: string)` — ref is required. No ref → can't invoke. But wait — the gap should be surfaced. The function type requires `ref: string`, so if not provided it's a gap on the capability's input.
- AC5 (available transitions + gaps): ✓ check which `when` clauses pass for current status → those are available. Their required inputs are gaps.
- AC6 (after pay, ship available): ✓ status is now "paid", so `ship when status = "paid"` passes. `pay when status = "created"` fails (suspended).
- AC7 (shipped, awaiting delivery): ✓ `deliver when status = "shipped"` is available
- AC8 (independent orders): ✓ `orders.a = Order`, `orders.b = Order` — separate paths
- AC9 (atomic update): ✓ `pay` returns `{ status = "paid", paymentRef = ref }` — single mount block

**All 9 AC expressible.** The FSM is entirely `when` gates on capabilities. No extensions needed.

---

## 4. Live Editing (narrativemodel/liveediting.md)

```ft
-- R1, R2, R6: Append-only document with editor identity
Document = {
  body: string,
  version: number.integer >= 0
}

-- R3, R5: Stale-state detection via version gating
Document << {
  edit: (content: string, expectedVersion: number) -> { ok: true
    | body = content
    | version = expectedVersion + 1
  } when version = expectedVersion by author
}

-- R4: Suspended edits can read current state and resubmit
-- (automatic — suspended edit stays in log, editor reads current version, resubmits)

-- R7: Diff via previous value
-- (automatic — getPrevious('doc.body') returns prior value)

-- R8: Historical read
-- (automatic — getAt('doc.body', seq) returns value at that point)

-- Concrete instance
doc = Document
doc << { body = "", version = 0 }
```

**Can it express all AC?**
- AC1 (two editors, ordered, attributed): ✓ `edit(...) by "alice"`, `edit(...) by "bob"` — author on each mount, ordered by block seq
- AC2 (stale edit suspends): ✓ `edit when version = expectedVersion` — if version advanced, the when fails → suspends
- AC3 (resubmit against current version): ✓ editor reads `doc.version`, calls edit with new expectedVersion
- AC4 (full log): ✓ append-only blocks, all retrievable
- AC5 (diff): ✓ `getPrevious('doc.body')` returns prior value
- AC6 (historical read): ✓ `getAt('doc.body', 3)` returns value at block 3

**All 6 AC expressible.** Optimistic concurrency via `when version = expectedVersion` is clean.

---

## 5. Tool Injection (prompts/toolinjection.md)

```ft
-- R1: Gap-fill tools generated from current gaps
ToolSet = {
  gapTools: [{ name: string, inputSchema: _, targetPath: string }
    | forall g : gaps() . gapTools HAS { name: "fill_" + g.path, inputSchema: g.type, targetPath: g.path }
  ],

  -- R2: Persistent capability tools
  capTools: [{ name: string, inputSchema: _ }
    | forall c : capabilities() . capTools HAS { name: c.id, inputSchema: c.inputType }
  ],

  -- R3: Expansion tools from compressed refs
  expandTools: [{ name: string, validRefs: [string] }],

  -- R9: Combined tool set
  tools: _ | tools = union(gapTools, capTools, expandTools)
}

-- R4: Scoped per turn (tools regenerated each render)
-- Each render is a new mount that overwrites the tool set
ToolSet = generateTools(currentState)  -- overwrite, not narrow

-- R6: Tool calls map to state updates
ToolSet << {
  execute: (toolName: string, input: _) -> { ok: true
    | let tool = tools.find(t => t.name = toolName)
    | if tool.targetPath then targetPath << input   -- gap-fill: narrow the target path
  }
}

-- R7: Gap-fill schemas match gap type constraints
-- (automatic — gapTools[i].inputSchema = gaps()[i].type)

-- R8: Expand tool restricted to current refs
-- (automatic — expandTools.validRefs is the set from this render only)
```

**Can it express all AC?**
- AC1 (3 gap-fill tools): ✓ `forall g : gaps() . gapTools HAS { name: "fill_" + g.path, inputSchema: g.type }`
- AC2 (persistent capability): ✓ `forall c : capabilities() . capTools HAS { name: c.id }`
- AC3 (expand tool with valid refs): ✓ `expandTools.validRefs` constrained to current render's refs
- AC4 (filled gap disappears next turn): ✓ `ToolSet = generateTools(currentState)` regenerates on each render
- AC5 (reject unknown tool): ✓ `tools.find(t => t.name = toolName)` — if not found, no execution
- AC6 (fill maps to bind): ✓ `targetPath << input` — narrow the gap with the provided value
- AC7 (cap tool executes): ✓ capability invocation → PendingInvocation → result mounted
- AC8 (total tool count): ✓ `tools = union(gapTools, capTools, expandTools)`
- AC9 (multi-tool response): ✓ each tool call is an independent mount

**All 9 AC expressible.** But note:

**BREAK**: `tools.find(t => t.name = toolName)` — this is a runtime query, not a type predicate. The DSL's predicate language doesn't have `find` or lambda expressions. The `forall` quantifier asserts properties but doesn't produce values.

**Fix**: This is the same issue as Break 5 from the cross-module validation — collection operations (`find`, `filter`, `map`). The tool injection needs:
```ft
| let tool = [t for t in tools where t.name = toolName][0]
```
List comprehension + indexing. This is a runtime operation, not a static type predicate. The DSL might need to accept that some predicates reference runtime queries.

---

## 6. Incremental Resolution (streams/incrementalresolution.md)

```ft
-- R1: Schema before value = gap
profile = { name: string, email: string, bio?: string }

-- R2: Partial data accepted
profile << { name: "Alice" }
-- profile.email still missing → obligation remains

-- R3: Obligations reported
-- (automatic — obligations() returns [{path: "profile.email", type: string}])

-- R4: Dependent operations suspend on missing fields
sendWelcome = "sent" when profile.email EXISTS

-- R5: Resolution clears obligation
profile << { email: "alice@example.com" }
-- obligations() no longer includes profile (name + email present, bio optional)

-- R6: Optional fields don't count
-- (automatic — bio? is optional, its absence doesn't create an obligation)

-- R7: Derived values compute when inputs ready
fullName = string
  | fullName = parts.first + " " + parts.last
parts.first = string
parts.last = string
-- fullName has no value until both parts are mounted
parts << { first: "Alice" }
-- fullName still pending (parts.last missing)
parts << { last: "Smith" }
-- fullName auto-computes to "Alice Smith" via cascade
```

**Can it express all AC?**
- AC1 (schema with no value = obligation): ✓ `profile = { name: string, email: string }` — no values → obligations
- AC2 (partial data, still incomplete): ✓ `profile << { name: "Alice" }` — email still missing
- AC3 (dependent suspends): ✓ `sendWelcome = "sent" when profile.email EXISTS`
- AC4 (resume on fill): ✓ `profile << { email: "..." }` → email exists → sendWelcome resumes
- AC5 (resolution clears obligation): ✓ both required fields present → no longer in obligations()
- AC6 (optional doesn't block): ✓ `bio?` is optional — not an obligation

**AC7 (derived values)**: The `fullName` derived value needs to be expressed. In the DSL:
```ft
fullName = string | fullName = parts.first + " " + parts.last
```
This is a refinement predicate that defines the value as a computation. But this is a DERIVED value, which in the Sequence is `mount('schema', 'fullName', FT.derived('concat', 'parts.first', 'parts.last'))`. The DSL's `|` predicate says what the value EQUALS, but doesn't say HOW to compute it (which capability to invoke).

**Fix**: Derived values could use `=` with a computation expression:
```ft
cap concat
fullName = concat(parts.first, " ", parts.last)
```
This mounts a schema with a `derived` constraint referencing the `concat` capability. When both parts are available, cascade computes it.

**All 7 AC expressible.** Derived values need `= fn(args)` syntax mapping to `FT.derived`.

---

## Summary

| Vertical | AC Count | Expressible | Extensions Needed |
|----------|----------|-------------|-------------------|
| Claude Code Agent | 11 | 11 | `when` on function types (preconditions) |
| Heartbeating | 8 | 8 | None |
| FSM | 9 | 9 | None |
| Live Editing | 6 | 6 | None |
| Tool Injection | 9 | 9 | List comprehension for runtime queries |
| Incremental Resolution | 7 | 7 | `= fn(args)` for derived values |

**50/50 acceptance criteria expressible** across 6 verticals.

Three DSL extensions surfaced:
1. `when` on function types — preconditions on capability invocation
2. `[expr for x in set where cond]` — list comprehension for collection operations
3. `x = fn(args)` — derived values (computation reference)

All three are syntactic — they compile to existing FT primitives (where clauses, derived constraints). No new kernel concepts.
