# DSL Semantic Validation

Can the `=`/`<<` refinement type DSL express real cross-module contracts?
Each section attempts to define a real vertical's behavioral contract.
Where it breaks, the break is noted.

---

## 1. FileSystem (contractlike/fs) — baseline

```ft
-- Structural interface
FileSystem = {
  read:  (p: string /^[/]/, encoding?: string) -> { content: string, size: number >= 0, mtime: number },
  write: (p: string /^[/]/, content: string) -> { ok: boolean, bytesWritten: number >= 0 },
  list:  (p: string /^[/]/, pattern?: string) -> [{ name: string, path: string, isDir: boolean, size: number }]
}

-- Behavioral narrowing
FileSystem << {
  read: (p) -> { content, size | size = byteLength(content) },
  write: (p, content) -> { ok: true
    | read(p).content = content  @[T_out..next_write(p).T_out)  ~survival(exp, 0.001)
    | list(parent(p)) HAS basename(p)  @[T_out..delete(p).T_out)
  }
}

-- Execution time models
FileSystem << { read: (_) -> _ ~lognormal(mu=4.6, sigma=1.2) }
FileSystem << { write: (_) -> _ ~lognormal(mu=5.0, sigma=1.5) }

-- Register capabilities (impl is external)
cap FileSystem.read
cap FileSystem.write
cap FileSystem.list
```

**Status**: Clean. `=` sets the structural type, `<<` adds behavioral predicates and timing. `cap` registers external implementations.

---

## 2. LLM Provider (contractlike/llm) — parameterized types

```ft
-- Base interface all providers must satisfy
LLM = {
  complete: (prompt: string, systemPrompt?: string, maxTokens?: number >= 0, temperature?: number 0..2)
          -> { text: string, inputTokens: number >= 0, outputTokens: number >= 0, model: string }
}

-- Cost model as a narrowing with computable predicates
CostModel = {
  complete: (prompt) -> { inputTokens, outputTokens
    | cost(inputTokens, outputTokens) = inputTokens * inputCostPerM / 1e6 + outputTokens * outputCostPerM / 1e6
  }
}

-- Token limit as a narrowing
TokenLimited = {
  complete: (prompt) -> { inputTokens, outputTokens
    | inputTokens + outputTokens <= tokenLimit
  }
}

-- Concrete providers: compose base + models with specific params
Claude = LLM & CostModel & TokenLimited
Claude << { inputCostPerM = 3.0, outputCostPerM = 15.0, tokenLimit = 200000 }
Claude << { complete: (_) -> _ ~lognormal(mu=7.0, sigma=0.5) }
cap Claude.complete

LocalLlama = LLM & CostModel & TokenLimited
LocalLlama << { inputCostPerM = 0, outputCostPerM = 0, tokenLimit = 32000 }
LocalLlama << { complete: (_) -> _ ~lognormal(mu=9.0, sigma=1.0) }
cap LocalLlama.complete
```

**Status**: Works structurally. But `inputCostPerM` in the CostModel predicate references a VALUE that isn't in the function's input or output — it's a PARAMETER of the type. The DSL needs a way to reference type-level parameters in predicates.

**BREAK 1**: `inputCostPerM` is not a function input, output, or bound variable. It's a constant associated with the provider instance. The predicate `cost(...) = inputTokens * inputCostPerM / 1e6` references it, but the DSL has no way to declare or scope instance-level constants.

**Possible fix**: Instance constants are just paths in the Sequence. `Claude.inputCostPerM = 3.0` is a mount. The predicate references it as a path:
```ft
Claude << { inputCostPerM = 3.0, outputCostPerM = 15.0 }
-- Now the predicate | cost(...) = inputTokens * Claude.inputCostPerM / 1e6
-- references Claude.inputCostPerM which IS a value in the projection
```

This works if predicates can reference arbitrary projection paths, not just function IO. **Is this already the case?** Yes — ValueExpr includes `{ kind: 'path', segments: [...] }` which resolves against the projection. So this works without DSL changes. The "instance constant" is just a bound value at a path.

**Revised status**: Clean — instance parameters are just values at paths.

---

## 3. Agent using FileSystem + LLM (cross-module binding)

```ft
-- The agent's workspace: composes capabilities from multiple sources
Agent = {
  fs: FileSystem,
  llm: LLM,
  prompt: string,
  output: string
}

-- The agent's behavioral contract:
-- "read a file, send it to the LLM with a prompt, write the result back"
Agent << {
  run: (task: { inputPath: string /^[/]/, outputPath: string /^[/]/, prompt: string })
     -> { ok: true
          | fs.read(task.inputPath).content = $fileContent
          | llm.complete(task.prompt + $fileContent).text = $response
          | fs.write(task.outputPath, $response).ok = true
          | fs.read(task.outputPath).content = $response  @[T_out..next_write(task.outputPath).T_out)
        }
}

cap Agent.run
```

**Status**: Works conceptually — the agent's `run` function references `fs.read`, `llm.complete`, and `fs.write` as sub-capabilities in its predicates. The behavioral chain (read → process → write → verify) is expressed as a sequence of predicates on the return type.

**BREAK 2**: The predicates reference intermediate values (`$fileContent`, `$response`) that are NOT function inputs or outputs — they're intermediate results of the execution chain. The DSL has `$variable` binding from trigger patterns, but these aren't trigger-bound — they're computation-bound.

**Possible fix**: Allow `let` bindings within predicates:
```ft
Agent << {
  run: (task) -> { ok: true
    | let $content = fs.read(task.inputPath).content
    | let $response = llm.complete(task.prompt + $content).text
    | fs.write(task.outputPath, $response).ok = true
    | fs.read(task.outputPath).content = $response  @[run.T_out..next_write(task.outputPath).T_out)
  }
}
```

`let` binds an intermediate value within the predicate scope. It's sugar for nested function application — each `let` is a step in the computation chain.

**BREAK 2 resolution**: Add `let $var = expr` as a predicate form. This is NOT a mount — it's a predicate-scoped binding that names intermediate values for use in subsequent predicates.

---

## 4. Prompt Composition using FileSystem context

```ft
-- A prompt template with segments
SystemPrompt = {
  system: string = "You are a helpful assistant.",
  context: string,
  tools: string,
  userMessage: string
}

-- Narrow with behavioral: context comes from filesystem
SystemPrompt << {
  context: string
    | context = fs.read("./context.md").content  @[T_out..)  ~survival(exp, 0.01)
}

-- Narrow with budget constraints
SystemPrompt << {
  system: string 0..500,
  context: string 0..4000,
  tools: string 0..2000,
  userMessage: string 0..1000
}

-- Concreteness: prompt is ready when all segments have values
-- This is automatic — segments without values are gaps
```

**Status**: Clean. Prompt segments are just object properties. Budget constraints are length bounds. The behavioral predicate (`context comes from filesystem`) references an external capability. Concreteness falls out from gaps().

---

## 5. Cross-cutting policy: Auditability

```ft
-- Auditability applies to ANY type with read/write functions
Auditable = {
  read:  (args) -> { _ | history.exists(read, args)  @[T_out..) },
  write: (args) -> { _ | history.exists(write, args) @[T_out..) }
}

-- Apply to everything:
FileSystem << Auditable
Agent << Auditable
```

**Status**: Clean. `Auditable` is a behavioral type. `<<` composes it with any type that has `read`/`write` functions. The predicates accumulate.

**But** — what if the target doesn't have `read`/`write`? `compose(Agent, Auditable)` where Agent has `run` but not `read`/`write` — what happens?

**BREAK 3**: Composing a behavioral type with a target that lacks the referenced functions. `compose(A, B)` where B has a property `read` that A doesn't have — in the current model, compose adds the property (it's like intersection of object types). So Agent would GAIN `read` and `write` stubs with the auditable predicate. That's wrong — Auditable should only CONSTRAIN existing functions, not add new ones.

**Possible fix**: Two interpretations of `&`:
1. **Strict intersection**: only properties in BOTH types survive. Properties in only one side are dropped.
2. **Additive intersection**: all properties survive. This is what compose currently does.

For cross-cutting policies, we want #1 — Auditable should constrain functions that EXIST, not add functions that don't. But the current `compose()` does #2.

**BREAK 3 resolution**: This is a real semantic gap. Options:
- Add a `constrain` operator distinct from `&` that only narrows existing properties
- Make `<<` check that the RHS only references properties that exist in the LHS
- Add a `where` clause on composition: `FileSystem << Auditable where read EXISTS`

The simplest: `<<` already means "narrow" — it should fail if the RHS references properties the LHS doesn't have. `FileSystem << Auditable` works because FileSystem has `read` and `write`. `Agent << Auditable` fails because Agent doesn't have `read`/`write` at the top level (it has `Agent.fs.read`).

This is correct behavior — `<<` should reject incompatible narrowing. The fix is: make sure compose in the `<<` context checks for property existence.

---

## 6. Rate-limited LLM with budget policy

```ft
-- Budget policy: cross-cutting constraint on cost
BudgetPolicy = {
  complete: (prompt) -> { inputTokens, outputTokens
    | history.sum(complete, cost) + cost(inputTokens, outputTokens) <= budget
  }
}

-- Budget is a value, not a type parameter
session.budget = 1.00  -- $1.00 for this session

-- Apply budget to a specific provider
Claude << BudgetPolicy

-- The predicate references:
-- 1. history.sum(complete, cost) — aggregate of past costs (historical query)
-- 2. cost(inputTokens, outputTokens) — current call cost (computable)
-- 3. session.budget — a value at a projection path

-- This is EXACTLY the policy builder pattern:
--   .when(complete(...))
--   .set(history.sum + current_cost)
--   .toLessThan(budget)
--   .per(session)
```

**Status**: This is the policy builder from the user's prior system, expressed in the refinement DSL. It works — the predicate `history.sum(...) + cost(...) <= budget` references historical aggregates, computed values, and projection paths. All are valid ValueExpr types.

**BREAK 4**: `history.sum(complete, cost)` — this aggregates a COMPUTED property (`cost`) over historical `complete` calls. The `cost` function is defined in the CostModel type. Can the predicate reference a DERIVED property of historical calls?

This requires: when a complete call finishes, the system computes `cost(inputTokens, outputTokens)` and stores it alongside the call record. Then `history.sum` aggregates it.

The predicate is asserting: "the sum of all past costs plus this call's cost must be under budget." This is the PREDICTIVE evaluation — "will this call push us over?" Not "are we currently over?"

**Is this expressible?** The `history.sum(fn, property)` query needs to:
1. Find all blocks where `fn` was called
2. For each, compute `property` from the stored return values
3. Sum them

This is a HISTORICAL AGGREGATE with a COMPUTED selector — exactly what the user's prior system did with Translations/Submetrics. The DSL has `history.sum(fn, filter)` in the ValueExpr, but the "sum of a computed property" isn't explicitly in the AST.

**Possible fix**: Extend `history` queries to support computed selectors:
```ft
history.sum(complete, { select: cost(_.inputTokens, _.outputTokens) })
```

Where `_` references the matched historical record's fields. This is a selector over historical records.

**BREAK 4 resolution**: The history query needs a selector/projection argument, not just an aggregation over raw values. Add `{ select: expr }` to history queries.

---

## 7. Mixed module: Agent workflow definition

```ft
-- A complete workflow: agent reads config, selects LLM, generates report, writes output

-- Establish available capabilities
config = { model: "claude", maxBudget: 1.00, inputDir: "/data", outputDir: "/reports" }
fs = FileSystem
llm = Claude

-- The workflow type
ReportWorkflow = {
  generate: (topic: string) -> { ok: true, reportPath: string /^[/]/
    -- Read input data
    | let $files = fs.list(config.inputDir)
    | let $contents = forall f : $files . fs.read(f.path).content
    -- Build prompt
    | let $prompt = "Generate a report on " + topic + " using:\n" + join($contents, "\n")
    -- Generate via LLM (budget-checked)
    | let $report = llm.complete($prompt).text
    -- Write output
    | let $path = config.outputDir + "/" + topic + ".md"
    | fs.write($path, $report).ok = true
    | reportPath = $path
    -- Behavioral: the report is readable after this returns
    | fs.read($path).content = $report  @[T_out..next_write($path).T_out)
  }
}

-- Apply cross-cutting policies
ReportWorkflow << Auditable
llm << BudgetPolicy

-- Register
cap ReportWorkflow.generate
```

**Status**: This is a full workflow defined in the DSL. It mixes:
- Concrete values (`config = { ... }`)
- Type references (`fs = FileSystem`)
- Behavioral predicates (the `generate` function's refinement chain)
- Cross-cutting policy application (`<< Auditable`, `<< BudgetPolicy`)
- Capability registration (`cap`)
- Intermediate `let` bindings within predicates
- `forall` quantification over file lists
- Temporal commitments (`@[T_out..)`)

**BREAK 5**: `forall f : $files . fs.read(f.path).content` — this quantifies over a RUNTIME value (`$files`, which is the result of `fs.list`). The `forall` produces a COLLECTION of values. Then `join($contents, "\n")` aggregates the collection into a string. The DSL needs:
1. `forall` that produces a collection (not just asserts a predicate)
2. Collection operations (`join`, `map`, `filter`, `reduce`)

The current `forall` asserts a predicate for every element. But here it's used as a MAP — "for each file, read its content" — producing a value per element.

**BREAK 5 resolution**: Distinguish:
- `forall x : set . P(x)` — assertion (every element satisfies P)
- `map x : set . f(x)` — collection production (apply f to each, collect results)

Or: `forall` with a `let` binding IS a map:
```ft
| let $contents = [fs.read(f.path).content for f in $files]
```
Python-style list comprehension. This is more natural than `forall` for collection production.

---

## Summary of Breaks

| # | What | Where | Fix |
|---|------|-------|-----|
| 1 | Instance constants | LLM params (inputCostPerM) | Already works — constants are values at paths |
| 2 | Intermediate computation values | Agent workflow chain | Add `let $var = expr` in predicates |
| 3 | Cross-cutting on missing properties | Auditable on Agent | `<<` rejects narrowing with non-existent properties |
| 4 | Historical aggregate of computed property | Budget policy | Extend history queries with `{ select: expr }` |
| 5 | Collection production from forall | Workflow file reading | Add list comprehension `[expr for x in set]` |

Breaks 1 and 3 are already handled by existing semantics. Breaks 2, 4, 5 need DSL extensions:
- `let` bindings in predicates (naming intermediate values)
- `{ select: expr }` on history queries (computed aggregation)
- `[expr for x in set]` (list comprehension / collection production)
