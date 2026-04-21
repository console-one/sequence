# Relational Database Management System Integration

## Original Notes

I included this here because so many businesses currently are running using relational database management systems like PostgreSQL, SQLite, a variant of all of the above, and everything under the sun. If we don't have a good way to encapsulate in our API model the structure or the call latency and capabilities of a relational database management system for any agent to interact with or to be used as any tool set that integrates with the broader framework, I think we might be extremely hamstrung on the capability for our tool set to expand beyond this.

My question is: how do we, given a user's particular database (whether it be PostgreSQL, SQLite, and what that user knows about it), define a coherent contract-like model for its various APIs or form the basis for when the user is installing the tools to say, "Okay, I'm installing our DBMS," and then we give them a bunch of forms that an agent can look at and use to build that model?

---

## Problem Context

- **Actor(s)**: Agents executing queries and mutations; users installing/configuring their database connections; the database engine (PostgreSQL, SQLite, MySQL, etc.); other processes with concurrent access to the same database.
- **Domain**: Relational database access -- typed CRUD operations over tables with schema-derived validation, engine-agnostic interfaces, and pre-execution constraint checking.
- **Core Tension**: Databases are the backbone of business systems and the most dangerous thing to give an agent access to. The system must derive typed operations from the database's own schema metadata, validate all inputs BEFORE any SQL is generated, and do this generically across engines. The installation flow ("I'm installing my DBMS") must bridge the gap between what the user knows about their database and what the system needs to construct typed operations.

## Requirements

**R1**: The installation flow SHALL derive typed row schemas automatically from the database's SQL column metadata (column names, types, nullability, constraints).
- *Rationale*: The user's original notes ask "how do we, given a user's particular database, define a coherent contract-like model for its various APIs." Manual schema definition does not scale. The system must read the database's own metadata and produce typed schemas from it.
- *Verifiable by*: Given a table `employees` with columns `{id INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL, department VARCHAR(100), salary DECIMAL NOT NULL CHECK (salary >= 0)}`, the system produces a typed row schema equivalent to `{id: integer, name: string(1..255), department?: string(1..100), salary: number >= 0}`.

**R2**: Every insert and update operation SHALL validate input data against the derived row schema BEFORE any SQL is generated or executed.
- *Rationale*: Type mismatches must surface as validation errors, not database runtime errors. A write of -100 to a salary column constrained to `>= 0` is caught by pre-validation, not by a PostgreSQL CHECK constraint failure.
- *Verifiable by*: Attempting to insert `{salary: -100}` into the employees table is rejected with a validation error ("salary must be >= 0") and no SQL is ever sent to the database.

**R3**: The database interface SHALL provide four operations: query (with optional filter, ordering, and limit), insert, update (by primary key with partial row), and delete (by primary key).
- *Rationale*: CRUD covers the fundamental operations every agent needs. Filtering, ordering, and limiting are query modifiers that map directly to SQL clauses.
- *Verifiable by*: Each of the four operations is callable with the appropriate parameters and returns the expected result type.

**R4**: Query filters SHALL be constrained to valid column names from the row schema. Filtering on a nonexistent column SHALL be rejected as a type error before any SQL is generated.
- *Rationale*: An agent filtering on `nonexistent_column` would produce a SQL error. Catching this at the type level gives a clear error message and prevents unnecessary database round-trips.
- *Verifiable by*: Querying employees with filter `{nonexistent: "value"}` is rejected before SQL generation with an error identifying the invalid column name.

**R5**: The interface SHALL be engine-agnostic -- the same typed operations work against PostgreSQL, SQLite, MySQL, and other SQL databases without modification to the agent's logic.
- *Rationale*: The user's original notes list "PostgreSQL, SQLite, a variant of all of the above, and everything under the sun." Agent logic should not change when the backend database changes.
- *Verifiable by*: The same query/insert/update/delete operations work against at least two different database engines without modification.

**R6**: Each table SHALL be an independent instance with its own row schema. Operations on one table SHALL NOT affect another table.
- *Rationale*: A database has many tables with different schemas. The system must handle each independently to avoid cross-table interference.
- *Verifiable by*: Inserting into the `employees` table does not affect query results on the `departments` table.

**R7**: After a successful `insert(table, row)`, a subsequent `query(table, row)` SHALL return at least one matching result, provided no intervening delete of that row has occurred.
- *Rationale*: This is the insert-query behavioral identity. An inserted row must be queryable.
- *Verifiable by*: Insert a row, then query for it -- the result set contains the inserted row.

**R8**: After a successful `update(table, pk, changes)`, a subsequent `query(table, {pk})` SHALL return a row reflecting the changed values, provided no intervening update or delete has occurred.
- *Rationale*: This is the update-query behavioral identity. Updated fields must be reflected in subsequent reads.
- *Verifiable by*: Update an employee's salary to 90000, then query by primary key -- the result has salary 90000.

**R9**: After a successful `delete(table, pk)`, a subsequent `query(table, {pk})` SHALL return zero results, provided no intervening insert with the same primary key has occurred.
- *Rationale*: This is the delete-query behavioral identity. A deleted row must not appear in query results.
- *Verifiable by*: Delete a row by primary key, then query for it -- the result set is empty.

**R10**: The system SHALL support discovery of database operations so agents can find them when they need data. When an agent requires data matching a table's row schema, the system should identify the appropriate query operation.
- *Rationale*: Agents should not need hardcoded knowledge of which databases are available. When an agent needs employee records, the system identifies `employeeDB.query` as the means to obtain them.
- *Verifiable by*: When an agent requires data matching `{id: integer, name: string, salary: number}`, the system identifies the employees table query as a matching operation.

**R11**: The system SHALL track the reliability of behavioral identities (R7, R8, R9) over time, accounting for concurrent access by other processes that may break them.
- *Rationale*: On a shared database, other processes may insert, update, or delete rows between an agent's operations. The system must degrade confidence in identities rather than assuming they hold unconditionally.
- *Verifiable by*: After an external process deletes a row that the agent just inserted, the system's confidence in the insert-query identity for that table decreases.

## Acceptance Criteria

**AC1** [R1]: Given a PostgreSQL table `employees(id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, department VARCHAR(100), salary DECIMAL NOT NULL CHECK (salary >= 0))`, when the system reads its metadata, then it produces a typed schema with `id: integer, name: string(1..255), department?: string(1..100), salary: number >= 0`.

**AC2** [R2]: Given the employees schema with `salary: number >= 0`, when inserting `{name: "Alice", salary: -100}`, then the operation is rejected with "salary must be >= 0" and no SQL is sent to the database.

**AC3** [R4]: Given the employees schema with columns `{id, name, department, salary}`, when querying with filter `{nonexistent: "value"}`, then the query is rejected with a type error before SQL generation.

**AC4** [R5]: Given the same employees schema, when executing `query("employees", {department: "Engineering"})` against PostgreSQL and then against SQLite, then both return matching rows without modification to the query parameters.

**AC5** [R7]: Given `insert("employees", {name: "Bob", salary: 80000})` succeeds, when `query("employees", {name: "Bob"})` is called, then the result contains the inserted row.

**AC6** [R8]: Given employee with pk=1, when `update("employees", 1, {salary: 90000})` succeeds and then `query("employees", {id: 1})` is called, then the result has `salary: 90000`.

**AC7** [R9]: Given employee with pk=1, when `delete("employees", 1)` succeeds and then `query("employees", {id: 1})` is called, then the result set is empty.

**AC8** [R6]: Given `employeeDB` and `departmentDB` as separate table instances, when inserting into `employeeDB`, then `departmentDB` queries return unchanged results.

## Open Questions

1. **Installation UX**: The original notes describe "we give them a bunch of forms that an agent can look at and use to build that model." What does the installation form look like? Is it a step-by-step wizard, a single configuration file, or an interactive conversation with the agent?
2. **Schema evolution**: What happens when the database schema changes (column added, type changed) after installation? Does the system re-derive the row schema, or does it flag a mismatch?
3. **Transaction boundaries**: Do multiple operations (e.g., insert + update) execute within a single transaction? If so, what are the rollback semantics when pre-validation passes but the database rejects the operation (e.g., unique constraint violation)?
4. **Concurrent access confidence**: How quickly should the system degrade confidence in behavioral identities on a heavily shared database? What is the initial prior and how does it update?
