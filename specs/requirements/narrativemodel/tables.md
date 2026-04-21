# Tables as Typed Arrays of Objects

## Original Notes

Tables are the most common data structure in business documents -- invoices, reports, inventories. A table is a typed array of row objects where each row conforms to a column schema. The system enforces column types per-row (no invalid data silently accepted), supports computed columns that update automatically when rows change, and allows sorting and filtering as read-time projections that never mutate the underlying data.

There is no manual recalculation. Derived cells -- sums, averages, totals -- recompute whenever the source rows change. Sort and filter are views, not mutations.

## Problem Context

- **Actor(s)**: Users (adding/editing rows, defining derived cells), automated processes (populating rows), consumers (reading sorted/filtered views).
- **Domain**: Tabular data in business documents (invoices, reports, inventories) with per-column schema enforcement, computed aggregations, and non-destructive sorting/filtering.
- **Core Tension**: Every row must be validated against column schemas at insertion time (not deferred to read time), derived cells must recompute automatically without manual trigger, and sort/filter must be read-time views that never mutate stored data.

## Requirements

**R1**: A table SHALL enforce a column schema on every row at row-addition time; a row violating any column constraint SHALL be rejected with a structured violation report.
- *Rationale*: Preventing invalid data at entry time avoids downstream corruption.
- *Verifiable by*: A row with a negative quantity (where the constraint requires >= 0) is rejected, and the violation report identifies the column and constraint.

**R2**: A row missing any required column SHALL be rejected with a violation report listing all missing columns.
- *Rationale*: Partial rows create ambiguity; reporting all missing columns at once lets the user fix everything in one pass.
- *Verifiable by*: A row missing two required columns produces a violation listing both.

**R3**: Valid rows SHALL be appended to the table and be individually addressable by index.
- *Rationale*: Index addressing supports both sequential iteration and random access to specific rows.
- *Verifiable by*: After adding 3 rows, reading index 0/1/2 returns the first/second/third row respectively.

**R4**: Derived cells (e.g., sum, average, total) SHALL be definable as named computations over the table's rows and SHALL recompute automatically whenever the underlying data changes.
- *Rationale*: Manual recalculation is error-prone; automatic recomputation ensures derived values are always current.
- *Verifiable by*: After adding a new row, a sum-based derived cell reflects the updated total without manual trigger.

**R5**: Sorting SHALL be a read-time projection that reorders the view without mutating the stored row order.
- *Rationale*: The stored data is the source of truth; sorting is a presentation concern.
- *Verifiable by*: Applying a sort returns rows in the specified order; removing the sort restores the original order; the stored data is unchanged throughout.

**R6**: Filtering SHALL be a read-time projection that selects matching rows without removing non-matching rows from storage.
- *Rationale*: Filters are transient views; the full dataset must remain intact.
- *Verifiable by*: Applying a filter returns only matching rows; removing the filter returns all rows; storage is unchanged throughout.

**R7**: Updating a specific row by index SHALL change only that row and trigger recomputation of any affected derived cells.
- *Rationale*: Row-level updates must be precise and must propagate to aggregations.
- *Verifiable by*: After updating row 1's quantity, only row 1 is changed and the sum-based derived cell reflects the new total.

## Acceptance Criteria

**AC1** [R1]: Given an invoice table with columns (product: string 1..100, quantity: integer >= 0, unitPrice: number >= 0), when a row with quantity = -2 is added, then it is rejected with a violation identifying the quantity constraint.

**AC2** [R2]: Given the same schema, when a row with only product specified is added, then it is rejected with violations listing both missing quantity and missing unitPrice.

**AC3** [R1, R3]: Given a valid row (Widget A, 10, 5.99), when it is added, then it is stored and readable at index 0.

**AC4** [R4]: Given 3 rows with line totals summing to 153.40, when a 4th row with line total 20.00 is added, then the derived total recomputes to 173.40.

**AC5** [R5]: Given 3 rows, when sorting by unitPrice descending, then the view returns rows in price-descending order; when the sort is removed, the original order is restored; the stored order is unchanged.

**AC6** [R6]: Given 4 rows, when filtering by quantity > 5, then only matching rows are returned; removing the filter returns all 4 rows.

**AC7** [R3]: Given 3 rows, when reading row at index 1, then the second row's data is returned.

## Open Questions

- Should derived cell computations be limited to a predefined set (sum, avg, count, etc.) or support arbitrary named functions?
- How should row deletion interact with derived cells and index addressing (re-index or leave gaps)?
