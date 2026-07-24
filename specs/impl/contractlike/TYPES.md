# Contractlike — Behavioral Type Definitions

Completeness check: can the refinement type DSL express the behavioral contracts
for all four contractlike verticals? Each type is self-contained. Composition via `&`
adds behavioral laws to structural interfaces.

---

## FileSystem

```ft
type FileSystem = {
  read: (p: string /^\//, encoding?: string) 
      -> { content: string, size: number >= 0, mtime: number 
           | size = byteLength(content) }
      ~lognormal(mu=4.6, sigma=1.2),

  write: (p: string /^\//, content: string, createDirs?: boolean) 
       -> { ok: true, bytesWritten: number >= 0 
            | bytesWritten = byteLength(content)
            | read(p).content = content          @[T_out..next_write(p).T_out)  ~survival(exp, 0.001)
            | list(parent(p)) HAS basename(p)    @[T_out..delete(p).T_out) }
       ~lognormal(mu=5.0, sigma=1.5),

  list: (p: string /^\//, pattern?: string, recursive?: boolean) 
      -> [{ name: string, path: string, isDir: boolean, size: number >= 0 }]
      ~lognormal(mu=5.5, sigma=1.0)
}
```

**Expressiveness check**:
- R1 (read returns content+size+mtime): ✓ structural return type
- R2 (write returns ok+bytesWritten): ✓ structural return type
- R3 (list returns array of entries): ✓ structural return type
- R4 (absolute paths): ✓ `string /^\//` pattern constraint
- R5 (optional params): ✓ `encoding?: string`, `createDirs?: boolean`
- R6 (backward inference for missing content): ✓ falls out from `read`'s output type matching a gap
- R7 (auditable history): needs `Auditable` composition (see below)
- Write-read identity: ✓ `| read(p).content = content @[T_out..next_write(p).T_out)`
- Write-list consistency: ✓ `| list(parent(p)) HAS basename(p) @[T_out..delete(p).T_out)`
- Size-content identity: ✓ `| size = byteLength(content)` (atemporal)

---

## Spreadsheet (Excel)

```ft
type Spreadsheet<CellRef, Value> = {
  readCell: (sheet: string, cell: CellRef) 
          -> { value: Value, type: string, formula?: string }
          ~fixed(50),

  writeCell: (sheet: string, cell: CellRef, value: Value) 
           -> { ok: true 
                | readCell(sheet, cell).value = value   @[T_out..next_writeCell(sheet, cell).T_out)
                | forall c: derived_from(cell) . readCell(sheet, c).value = eval(c.formula)  @[T_out..) }
           ~fixed(100),

  listCells: (sheet: string) 
           -> [{ ref: CellRef, type: string, hasValue: boolean, formula?: string }]
}

type FormulaConsistency = {
  writeCell: (sheet, cell, value) -> { ok: true
    | forall c: derived_from(cell) .
        readCell(sheet, c).value = eval(c.formula, {cell: value})  @[T_out..)
  }
}

type CellValidation = {
  writeCell: (sheet, cell, value) -> { ok: true 
    | value SATISFIES schema(sheet, cell) }
}

export Spreadsheet & FormulaConsistency & CellValidation
```

**Expressiveness check**:
- R1 (typed cells): ✓ `readCell` returns `{ value: Value, type: string }`
- R2 (formula cells with cascade): ✓ `| forall c: derived_from(cell) . readCell(sheet, c).value = eval(c.formula)` — **NEW**: requires `forall` quantifier over derived dependencies. The DSL needs `forall x: predicate . assertion` syntax.
- R3 (typed read/write ops): ✓ function signatures
- R4 (gaps for empty cells): ✓ cells with schema but no value are obligations
- R5 (change notification): ✓ `PathChange[]` on MountResult tracks all mutations including cascades
- R6 (multi-sheet): ✓ `sheet: string` parameter scopes operations
- R7 (pre-validation): ✓ `| value SATISFIES schema(sheet, cell)` — write rejected if value doesn't match cell type

**Tension found**: R2 (formula cascade) requires `forall c: derived_from(cell)` — quantification over a dependency graph. This is expressible but needs:
1. `forall` quantifier in predicates
2. `derived_from(cell)` as a dependency query
3. `eval(formula, bindings)` as a computation reference

These are extensions to the predicate language. `forall` is the key one — the DSL currently only has per-call predicates, not quantified predicates over sets.

---

## LLM Provider

```ft
type LLM = {
  complete: (prompt: string, systemPrompt?: string, maxOutputTokens?: number >= 0, temperature?: number 0..2) 
          -> { text: string, inputTokens: number >= 0, outputTokens: number >= 0, model: string 
               | inputTokens + outputTokens <= tokenLimit
               | cost(inputTokens, outputTokens) <= budget }
          ~lognormal(mu=outputTokens * msPerToken, sigma=0.5)
}

type CostModel<InputCostPerM, OutputCostPerM> = {
  complete: (prompt, systemPrompt?, maxOutputTokens?, temperature?) 
          -> { text, inputTokens, outputTokens
               | cost = inputTokens * InputCostPerM / 1e6 + outputTokens * OutputCostPerM / 1e6 }
}

type TokenLimited<Limit> = {
  complete: (prompt) -> { inputTokens, outputTokens 
    | inputTokens + outputTokens <= Limit }
}

type LatencyModel<MsPerToken> = {
  complete: (prompt) -> { outputTokens 
    | T_out - T_in <= outputTokens * MsPerToken * 1.5 }
    ~lognormal(mu=log(outputTokens * MsPerToken), sigma=0.3)
}

type ActualTracking = {
  complete: (prompt) -> { inputTokens: actual, outputTokens: actual, text
    | history.last(complete).estimatedCost != nil  @[T_out..)
    | history.last(complete).actualCost = cost(actual.inputTokens, actual.outputTokens)  @[T_out..) }
}

-- Concrete providers compose the structural interface with their specific models:

type Claude = LLM & CostModel<3.0, 15.0> & TokenLimited<200000> & LatencyModel<20> & ActualTracking
type GPT4   = LLM & CostModel<2.5, 10.0> & TokenLimited<128000> & LatencyModel<15> & ActualTracking
type LocalLlama = LLM & CostModel<0, 0> & TokenLimited<32000> & LatencyModel<80> & ActualTracking
```

**Expressiveness check**:
- R1 (uniform interface): ✓ `LLM` type defines the structural contract
- R2 (computable cost): ✓ `CostModel<InputCostPerM, OutputCostPerM>` with `| cost = ...` predicate
- R3 (token limit): ✓ `TokenLimited<Limit>` with `| inputTokens + outputTokens <= Limit`
- R4 (latency estimation): ✓ `LatencyModel<MsPerToken>` with temporal constraint on `T_out - T_in`
- R5 (automatic selection): ✓ compose all candidates, filter by constraint satisfaction, rank by cost — this is `search()` over composed types
- R6 (concurrent providers): ✓ each provider is an independent type; all registered simultaneously
- R7 (actual tracking): ✓ `ActualTracking` records post-call values alongside estimates
- R8 (backward inference): ✓ `backwardInfer(LLM.complete, { text: string })` discovers the capability
- R9 (structural recognition): ✓ anything whose type composes with `LLM` without producing `never` IS an LLM

**Tension found**: R4 latency depends on `outputTokens` which is UNKNOWN before the call. The `~lognormal` distribution handles this — it's a distribution over duration, not a point estimate. But the predicate `| T_out - T_in <= outputTokens * MsPerToken * 1.5` references `outputTokens` which is in the OUTPUT, creating a circular reference in the pre-call constraint. This needs `maxOutputTokens` (from input) as the estimator, not `outputTokens` (from output).

**Fix**: The latency predicate should reference the INPUT estimate:
```ft
  complete: (prompt, systemPrompt?, maxOutputTokens?) -> { outputTokens 
    | T_out - T_in <= maxOutputTokens * MsPerToken * 1.5 }
```

---

## RDBMS

```ft
type RDBMS<TableName, Row> = {
  query: (table: TableName, filter?: { [key: keyof Row]?: Row[key] }, order?: keyof Row, limit?: number >= 0) 
       -> [Row]
       ~lognormal(mu=5.0, sigma=1.0),

  insert: (table: TableName, row: Row) 
        -> { ok: true, id?: number 
             | query(table, row).length > 0  @[T_out..delete(table, row.pk).T_out)  ~survival(exp, 0.0001) }
        ~lognormal(mu=5.5, sigma=1.5),

  update: (table: TableName, pk: Row[pkField], changes: Partial<Row>) 
        -> { ok: true, affected: number >= 0 
             | forall k in keys(changes) . query(table, {pk: pk})[0][k] = changes[k]  @[T_out..next_update(table, pk).T_out) }
        ~lognormal(mu=5.5, sigma=1.5),

  delete: (table: TableName, pk: Row[pkField]) 
        -> { ok: true 
             | query(table, {pk: pk}).length = 0  @[T_out..next_insert(table, {pk: pk}).T_out) }
        ~lognormal(mu=5.0, sigma=1.0)
}

type PreValidation = {
  insert: (table, row) -> { ok: true | row SATISFIES schema(table) },
  update: (table, pk, changes) -> { ok: true | changes SATISFIES Partial<schema(table)> }
}

type EngineAgnostic<Engine> = {
  query:  (table, filter?, order?, limit?) -> [Row] | Engine IN {"postgresql", "sqlite", "mysql"},
  insert: (table, row) -> { ok: true } | Engine IN {"postgresql", "sqlite", "mysql"}
}

-- Concrete instantiation from table metadata:

type EmployeeRow = { id: number.integer, name: string 1..255, department?: string 1..100, salary: number >= 0 }
type EmployeeDB = RDBMS<"employees", EmployeeRow> & PreValidation
```

**Expressiveness check**:
- R1 (installation flow derives ops): ✓ `RDBMS<TableName, Row>` parameterized by table metadata
- R2 (typed row schema): ✓ `EmployeeRow` is a standard object type with constraints
- R3 (typed query with filters): ✓ `filter?: { [key: keyof Row]?: Row[key] }` — **NEW**: requires `keyof` and indexed access types. The DSL needs structural type operators.
- R4 (typed insert with validation): ✓ `| row SATISFIES schema(table)` pre-validation
- R5 (pre-validation before SQL): ✓ `PreValidation` composition
- R6 (schema derivation from metadata): ✓ `EmployeeRow` derived from SQL column metadata (parser does this)
- R7 (engine-agnostic): ✓ `EngineAgnostic` constrains which engines are supported
- R8 (backward inference): ✓ `backwardInfer(query, [EmployeeRow])` discovers the query operation
- R9 (multi-table): ✓ each table is a separate `RDBMS<Name, Row>` instantiation
- Insert-query identity: ✓ `| query(table, row).length > 0 @[T_out..delete.T_out)`
- Update-query identity: ✓ `| forall k in keys(changes) . query(...)[0][k] = changes[k] @[...]`
- Delete-query identity: ✓ `| query(table, {pk}).length = 0 @[T_out..next_insert.T_out)`

**Tension found**: `keyof Row` and `Row[key]` are TypeScript-level type operators, not value predicates. The DSL needs to decide: are structural type operators part of the surface syntax, or are they resolved during generic binding? If `Row` is `EmployeeRow`, then `keyof Row` = `"id" | "name" | "department" | "salary"` — this is computable at parse time when generics bind.

---

## Reusable Behavioral Types (cross-cutting)

```ft
type Auditable = {
  read:  (args) -> { _ | history.exists(read, args)  @[T_out..) },
  write: (args) -> { _ | history.exists(write, args) @[T_out..) }
}

type WriteReadIdentity<Path, Body, Reader, Writer> = {
  Writer: (p: Path, b: Body) -> { ok: true 
    | Reader(p).content = b  @[T_out..next Writer(p).T_out)  ~survival(exp, 0.001) }
}
```

These compose with any of the four verticals:
- `FileSystem & Auditable`
- `Spreadsheet & Auditable`
- `RDBMS<T,R> & Auditable`

---

## DSL Extensions Required

The four verticals surface these needs beyond the current DSL spec:

| Need | Where | Example |
|------|-------|---------|
| `forall` quantifier | Spreadsheet (formula cascade), RDBMS (update) | `forall c: derived_from(cell) . readCell(c) = eval(c.formula)` |
| `keyof` / indexed access | RDBMS (filter keys) | `filter?: { [key: keyof Row]?: Row[key] }` |
| Dependency graph query | Spreadsheet | `derived_from(cell)` — transitive dependents |
| Computation reference | Spreadsheet | `eval(formula, bindings)` — call a named function in a predicate |
| Partial type | RDBMS (update changes) | `Partial<Row>` — all fields optional |
| Conditional `ok: true` | All four | Return type branches: `{ ok: true | ... } \| { ok: false, error: string }` — but we said no errors in output... |

The `forall` quantifier is the biggest one — it appears in both Spreadsheet and RDBMS. Without it, cascade predicates and multi-field update identities can't be expressed.
