# Relational Database Management System Integration

## Original Notes

I included this here because so many businesses currently are running using relational database management systems like PostgreSQL, SQLite, a variant of all of the above, and everything under the sun. If we don't have a good way to encapsulate in our API model the structure or the call latency and capabilities of a relational database management system for any agent to interact with or to be used as any tool set that integrates with the broader framework, I think we might be extremely hamstrung on the capability for our tool set to expand beyond this.

My question is: how do we, given a user's particular database (whether it be PostgreSQL, SQLite, and what that user knows about it), define a coherent contract-like model for its various APIs or form the basis for when the user is installing the tools to say, "Okay, I'm installing our DBMS," and then we give them a bunch of forms that an agent can look at and use to build that model?

---

Databases are the backbone of business systems, and the most dangerous thing to give an agent access to. The system must derive typed operations from the database's own schema, validate data before execution, and do this generically across PostgreSQL, SQLite, MySQL, and everything else. The installation flow -- "I'm installing my DBMS" -- must bridge the gap between the user's knowledge of their database and the system's need for typed schemas.

The key property: no SQL is generated or executed until inputs pass schema validation. Type mismatches surface as gaps, not runtime errors. A write of -100 to a salary column with a minimum of 0 is caught by the type system, not by the database engine.

## The Row Schema

Each table is represented as a typed row schema. Column names map to typed fields with constraints derived from SQL metadata. This is the contract -- an agent that knows the shape of every row can validate its own data before attempting an operation:

```ft
EmployeeRow = {
  id: number,
  name: string,
  department?: string,
  salary: number >= 0
}
```

Required fields (`id`, `name`, `salary`) must be present in every insert. Optional fields (`department?`) can be omitted. Constraints like `>= 0` on salary are enforced at the type level. The row schema is derived automatically from SQL column metadata -- the user does not manually write it.

## The RDBMS Type

The database interface has four operations: query, insert, update, delete. Each operates on a specific table and its row schema:

```ft
RDBMS = {
  query: (table: string, order?: string, limit?: number >= 0) -> { id: number, name: string, department?: string, salary: number >= 0 },
  insert: (table: string) -> { ok: true, id?: number },
  update: (table: string, pk: number) -> { ok: true, affected: number >= 0 },
  remove: (table: string, pk: number) -> { ok: true }
}
```

The `query` operation also accepts an optional filter whose keys are constrained to valid column names from the row schema. A filter on a nonexistent column is a type error -- rejected before any SQL is generated. The `insert` operation accepts a row matching the table's row schema. The `update` operation accepts a partial row (all fields optional) containing only the columns to change. The `remove` operation (called "delete" in SQL) uses a different name to avoid conflict with the reserved keyword.

## Behavioral Identities

The structural types define operation shapes. The behavioral contract defines what operations mean relative to each other. These cannot be expressed in the parser's current syntax:

- **Insert-query identity**: After `insert("employees", row)` returns, `query("employees", row)` returns at least one matching result. This holds until the row is deleted.
- **Update-query identity**: After `update("employees", pk, {salary: 90000})` returns, `query("employees", {id: pk})[0].salary = 90000`. This holds until the next update to the same row.
- **Remove-query identity**: After `remove("employees", pk)` returns, `query("employees", {id: pk})` returns zero results. This holds until a new row with the same primary key is inserted.
- **Pre-validation**: Every insert and update is validated against the row schema BEFORE any SQL is generated. `insert("employees", {salary: -100})` is rejected with "salary must be >= 0" before any database interaction occurs.

These identities are enforced through predicate observation. When a value changes at a path governed by an identity -- for example, a `query` after an `insert` on the same table -- the Sequence checks whether the observation matches the commitment. If `query("employees", row)` returns the row that `insert` just committed, the reliability prior's alpha increments, strengthening confidence. If the row is missing -- because another process deleted it, or a trigger modified it -- beta increments, degrading confidence. The posterior predictive `P(next observation matches) = alpha / (alpha + beta)` feeds into feasibility and concreteness computations, so databases with unreliable identity guarantees (shared, heavily concurrent) naturally receive lower priority during gap resolution.

## Table Installation

A concrete database is instantiated by providing connection information and selecting tables. The system reads SQL metadata and derives row schemas automatically:

```ft
employeeDB = RDBMS
employeeDB << { table: "employees" }
```

The `table` narrowing binds this instance to a specific table. The row schema is derived from the table's SQL column metadata: `{name: "salary", type: "decimal", nullable: false}` becomes `salary: number >= 0` (required, non-negative). The user provides connection details and selects tables; the system does the rest.

Multiple tables are independent instances:

```ft
departmentDB = RDBMS
departmentDB << { table: "departments" }
```

Operations on `employeeDB` do not affect `departmentDB` and vice versa. Each has its own row schema derived from its own table metadata.

## Capabilities and Backward Inference

Operations are registered as capabilities so the system can discover them when the agent needs data:

```ft
tool employeeDB.query
tool employeeDB.insert
tool employeeDB.update
tool employeeDB.remove
```

When the agent declares it needs employee data (an array of rows matching `EmployeeRow`), backward inference traces to `employeeDB.query`. The filter conditions surface as optional gaps -- the agent sees: "query the employees table, optionally filter by department, salary range, etc."

## Engine Agnosticism

The typed interface is the same regardless of database backend. The same agent logic -- query with filters, insert with validation -- works against PostgreSQL, SQLite, or MySQL without modification. Engine-specific SQL generation happens behind the typed interface. The agent never sees raw SQL.

This is expressible as a constraint on the RDBMS type: it must work with any supported engine. The interface does not change; only the SQL generation layer beneath it adapts.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Installation derives typed operations from metadata | `employeeDB = RDBMS` + `<< { table: "employees" }` instantiation |
| Row schema has typed fields with constraints | `EmployeeRow` with types, optionality, and `>= 0` |
| Query with valid filters returns matching rows | `query` return type matching `EmployeeRow` |
| Query with invalid filter field rejected | Filter type constrains keys to row schema fields |
| Insert with valid row succeeds | `insert` takes `row: EmployeeRow`, returns `{ ok: true }` |
| Insert with constraint violation rejected pre-SQL | Prose: pre-validation identity, salary >= 0 |
| Engine-agnostic interface | Same `RDBMS` type works across PostgreSQL, SQLite, MySQL |
| Backward inference discovers query for data needs | `cap employeeDB.query` registration + structural matching |
| Multiple tables operate independently | Separate `employeeDB` and `departmentDB` instances |
