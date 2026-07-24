# Tables as Typed Arrays of Objects

Tables are the most common data structure in business documents -- invoices, reports, inventories. A table is a typed array of row objects where each row conforms to a column schema. The system enforces column types per-row (no invalid data silently accepted), supports computed columns that update automatically when rows change, and allows sorting and filtering as read-time projections that never mutate the underlying data.

There is no manual recalculation. Derived cells -- sums, averages, totals -- recompute whenever the source rows change. Sort and filter are views, not mutations.

## The Row Schema

Each row in a table conforms to a column schema. Columns have types with constraints -- string length, numeric range, integer requirement, and required-ness:

```ft
InvoiceRow = {
  product: string 1..100,
  quantity: number.integer >= 0,
  unitPrice: number >= 0
}
```

Every column constraint is enforced at row-addition time. A row with `quantity = -2` is rejected with a violation referencing the quantity constraint. A row missing `quantity` and `unitPrice` is rejected with violations listing both missing columns.

## Adding Rows

Valid rows are appended to the table. Invalid rows are rejected with structured violations:

```ft
invoiceTable = {
  rows: InvoiceRow,
  rowCount: number.integer >= 0
}

invoiceTable << { rowCount: 0 }
```

Adding a valid row:

```ft
invoiceTable.rows << { product: "Widget A", quantity: 10, unitPrice: 5.99 }
invoiceTable << { rowCount: 1 }
```

Adding a row with a constraint violation (`quantity = -2`) is rejected. The violation report identifies the column (`quantity`) and the constraint (`>= 0`). The table is unchanged.

Adding an incomplete row (only `product` specified, missing `quantity` and `unitPrice`) is rejected. The violation report lists both missing required columns.

## Derived Cells

Derived cells are computed values that depend on the table's rows and recalculate whenever the data changes. A derived cell is defined by a named computation:

```ft
DerivedCell = {
  name: string,
  computation: string,
  value: number
}
```

```ft
invoiceTotal = DerivedCell
invoiceTotal << { name: "total", computation: "sum(quantity * unitPrice)" }
```

With 3 rows -- (Widget A, 10, 5.99), (Widget B, 3, 12.50), (Widget C, 7, 8.00) -- the total is 153.40. Adding a 4th row (Widget D, 1, 20.00) causes the total to automatically recompute to 173.40. No manual trigger.

The computation is a named function, not an ad-hoc expression. It takes the table data as input and produces the derived output. This makes derivations explicit and reusable.

## Sorting and Filtering (Read-Time Projections)

Sorting and filtering are read-time operations that produce a view without mutating the underlying data:

```ft
SortProjection = {
  column: string,
  direction: "asc" | "desc"
}

FilterProjection = {
  column: string,
  operator: string,
  value: number
}
```

Sorting by `unitPrice` descending returns rows in price-descending order, but the stored row order is unchanged. Removing the sort restores the original view.

Filtering by `quantity > 5` returns only matching rows, but the stored data still contains all rows. The filter is a transient projection -- the source array is never reordered or pruned.

## Row Addressing

Rows are individually addressable by index. Reading row at index 0 returns the first row. Reading row at index 2 returns the third row. Updating row at index 1 changes only the second row:

```ft
-- invoiceTable.rows[0] returns first row
-- invoiceTable.rows[1] returns second row
-- invoiceTable.rows[2] returns third row
```

Index addressing supports both sequential access (iterate all rows) and random access (read a specific row by position).

## Capabilities

Row addition and derived cell definitions are externally provided. Schema validation and cascade recomputation are system-provided:

```ft
tool InvoiceRow.product
tool InvoiceRow.quantity
tool InvoiceRow.unitPrice
tool DerivedCell.computation
tool DerivedCell.value
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Table with typed column schema, valid row added | `InvoiceRow` with constrained columns; valid row stored and readable |
| Row with constraint violation rejected | `quantity = -2` rejected, violation references quantity constraint |
| Row with missing required columns rejected | Missing quantity and unitPrice listed in violation report |
| Derived total recomputes on row addition | `invoiceTotal` recomputes from 153.40 to 173.40 when 4th row added |
| Derived cell uses named computation | `computation: "sum(quantity * unitPrice)"` is explicit and reusable |
| Sort is a non-destructive read-time projection | `SortProjection` reorders view; stored data unchanged |
| Filter is a non-destructive read-time projection | `FilterProjection` selects matching rows; stored data unchanged |
| Rows addressable by index | Row at index 1 returns second row's data |
