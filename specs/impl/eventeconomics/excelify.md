# Excelify

## Original Notes

- SOME UTILITY TO BUILD A BLOCK OF RELATIONS EQUIVALENT TO A SHEET
- DOESN'T NECESSARY NEED TO WORK FULLY - I JUST NEED TO SEE HOW WE CAN (HOW IT WOULD BE MODELLED)

A spreadsheet is a dependency graph disguised as a grid. Each cell is either a literal value or a formula that references other cells. The hard part is not the grid layout -- it is the automatic, dependency-ordered recalculation that fires whenever any input changes. A formula referencing another formula's output creates chains of derivation that must resolve in topological order, and when inputs are missing (gaps), the downstream formulas should degrade gracefully rather than error.

This models spreadsheet-like relational computation within the system's data framework. It is not a general-purpose spreadsheet application -- the goal is demonstrating how dependency-driven recalculation maps to the type system.

## Cell and Sheet Structure

A sheet is a collection of named cells organized by row and column. Each cell is either a literal value or a derived value computed from other cells. Columns carry type constraints that apply to all cells in that column:

```ft
ColumnSchema = {
  name: string,
  colType: "string" | "number"
}

Cell = {
  row: number.integer >= 0,
  col: string,
  value: string | number
}

Sheet = {
  columns: ref(ColumnSchema),
  cells: ref(Cell)
}
```

A literal cell is just an assignment. A derived cell is a reference to other cells -- when those references change, the derived cell's value changes. The sheet itself is a container holding column schemas and cell references.

## Literal and Derived Cells

Literal cells hold user-provided data. Derived cells hold computed values that depend on other cells. The dependency is expressed through references:

```ft
sheet1 = Sheet

-- Row 1: Widget Co
sheet1.cells.A1 = Cell
sheet1.cells.A1 << { row: 1, col: "A", value: "Widget Co" }

sheet1.cells.B1 = Cell
sheet1.cells.B1 << { row: 1, col: "B", value: 15000 }

sheet1.cells.C1 = Cell
sheet1.cells.C1 << { row: 1, col: "C", value: 22000 }

-- Derived cell: D1 = B1 + C1
sheet1.cells.D1 = Cell
sheet1.cells.D1 << { row: 1, col: "D", value: ref(sheet1.cells.B1.value) }
```

The derived cell D1 references B1's value. When B1 changes, D1's value changes automatically because refs resolve on read. The actual addition operation (B1 + C1) is a behavioral predicate that the parser cannot express directly -- the system treats D1 as a formula whose resolution depends on its referenced inputs.

## Dependency-Ordered Recalculation

When an input cell changes, all downstream dependents recompute. This is the defining behavior -- no manual trigger, no stale values. The dependency chain is expressed through nested refs:

```ft
-- Update B1
sheet1.cells.B1 << { value: 18000 }

-- D1 references B1, so D1 re-resolves automatically
-- Total-B references B1, so Total-B re-resolves automatically
-- Total-D references Total-B, so Total-D re-resolves automatically
```

The cascade is inherent in the ref structure. Each ref is a live reference -- when the source changes, any path that reads through the ref gets the new value. There is no separate recalculation engine; the workspace's read semantics handle it.

## Summary Rows and Chained Derivation

Aggregate rows (totals, averages) are themselves derived cells that may reference other derived cells. This creates chains of derivation:

```ft
-- Total row: aggregates across rows
sheet1.cells.TotalB = Cell
sheet1.cells.TotalB << { row: 99, col: "B", value: ref(sheet1.cells.B1.value) }

sheet1.cells.TotalD = Cell
sheet1.cells.TotalD << { row: 99, col: "D", value: ref(sheet1.cells.TotalB.value) }
```

TotalD depends on TotalB, which depends on B1 and B2. Changing B1 cascades through TotalB to TotalD. The system resolves this in the correct order because refs are demand-driven -- TotalD reads TotalB, which reads B1 and B2. There is no explicit topological sort; the read path enforces the order.

## Capabilities and Column Schema

Cells are externally provided values. The user writes to cells; the system recalculates derived cells. Column schemas constrain what can be written:

```ft
cap Sheet.cells
cap Sheet.columns

-- Column B constrained to numbers
sheet1.columns.B = ColumnSchema
sheet1.columns.B << { name: "Revenue", colType: "number" }
```

Writing a string to column B when it is constrained to numbers produces a type mismatch that surfaces as a gap. The column schema acts as a guard on cell writes.

## Partial Concreteness for Missing Inputs

When a formula references a cell that has no value (a gap), the formula itself reflects partial concreteness rather than failing:

```ft
-- C1 has no value (gap)
sheet1.cells.C1 = Cell
sheet1.cells.C1 << { row: 1, col: "C", value: [[ missing input ]] }

-- D1 = B1 + C1: D1 is partially concrete
-- B1 is known, C1 is a gap, so D1 is somewhere between
```

D1's concreteness is less than 1.0 but greater than 0. It reflects that one input is known and one is not. The concreteness propagation through formula chains is a property of the ref resolution: a ref to a gap produces a gap with inherited schema.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Cell writable and readable by address | `sheet1.cells.A1 << { row: 1, col: "A", value: "Widget Co" }` |
| Formula cell computes from inputs | `D1.value = ref(B1.value)` with behavioral addition predicate |
| Column type constraints | `columns.B << { colType: "number" }` rejects mismatched writes |
| Auto-recalculation on input change | `B1 << { value: 18000 }` cascades through refs to D1, TotalB, TotalD |
| Chained derivation in summary rows | `TotalD.value = ref(TotalB.value)` which refs B1/B2 |
| Dependency graph is inspectable | Ref chain from D1 to B1/C1 is the dependency graph |
| Partial concreteness for missing inputs | Gap at C1 produces partial concreteness at D1 |
