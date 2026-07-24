# Excel Spreadsheet Integration

A spreadsheet is a grid of typed cells where values propagate through formula dependencies. The agent sees two layers: the current state (cell values) and the dependency structure (which cells derive from which). Changing one cell can cascade through formulas and update dozens of others. The system must expose both layers so the agent can reason about consequences before acting.

The hard part is formula cascade. When the agent writes to A1 and A3 is `=A1+A2`, the write's behavioral contract must express that A3 will update. This is a quantified predicate over the dependency graph -- every cell derived from A1 will recompute. The parser cannot express `forall` quantifiers yet, so cascade behavior is described in prose alongside the structural types.

## The Spreadsheet Type

A spreadsheet has three operations scoped by sheet name. Read returns a cell's value, type, and optional formula. Write takes a value and returns success. List returns all cells in a sheet with their metadata:

Cell values can be strings, numbers, booleans, or null. This union (`CellValue = string | number | boolean | null`) captures every primitive a spreadsheet cell can hold, but the parser does not yet support unions of primitive type names, so it is expressed here in prose.

```ft
Spreadsheet = {
  readCell: (sheet: string, cell: string) -> { cellType: string, formula?: string },
  writeCell: (sheet: string, cell: string) -> { ok: true },
  listCells: (sheet: string) -> { cellRef: string, cellType: string, hasValue: boolean, formula?: string }
}
```

The `readCell` return also includes a `value` field whose type is `CellValue`. Similarly, `writeCell` accepts a `value` parameter of the same union type. These are expressed as a separate type because the parser does not yet support inline unions inside object field positions.

The `cell` parameter is a cell reference like `"A1"` or `"B3"`. The `sheet` parameter scopes all operations -- two sheets with different schemas coexist without interference.

## Cell Schema and Gap Detection

Each cell has a declared type. A cell with a type but no value is a gap -- incomplete data the agent can inspect and fill. The schema is not a separate structure; it is the type itself. When a cell is declared as `number` but has no value, its absence surfaces in the gap listing:

```ft
sheet1 = {
  A1: number,
  A2: number,
  B1: string,
  B2: string
}

sheet1 << { A1: 100, A2: 250, B1: "Revenue" }
```

After this mount, B2 has a type (`string`) but no value. It appears as a gap. The agent sees: "B2 needs a string value." The other three cells are concrete -- they have both type and value.

## Formula Cells and Cascade

A formula cell's value is derived from other cells. This is not a separate mechanism -- it is a refinement predicate on the cell's value:

```ft
sheet1 << { A3: number }
```

The behavioral identity for formulas is: when A3's formula is `=A1+A2` and A1 changes, A3's value recomputes to match the formula applied to the new inputs. In prose:

- **Formula consistency**: After `writeCell("sheet1", "A1", 150)` returns, `readCell("sheet1", "A3").value` equals `eval("A1+A2", {A1: 150, A2: 250})` = 400. This holds for every cell in the dependency graph of A1, not just direct dependents.
- **Cascade completeness**: The recomputation is atomic -- after the write returns, ALL derived cells reflect the new state. There is no intermediate state where A1 is updated but A3 is not.

## Write Validation

Writes are validated against cell type constraints before execution. A cell typed as `number >= 0` rejects negative values at the type level, before any mutation occurs:

```ft
salaryCell = number >= 0
```

Writing -100 to this cell is a type violation. The system rejects it and surfaces a constraint violation message ("salary must be >= 0"). The spreadsheet engine never sees the bad value.

## Change Tracking

When external changes occur (another user edits the spreadsheet, a data feed updates), the agent needs to see the delta -- not just "something changed" but specifically which cells changed and which derived cells were affected.

Change tracking is inherent in the mount model. Each mount produces a diff. If A1 changes externally from 100 to 150, and A3 recomputes from 350 to 400, the delta contains both `A1` (direct change) and `A3` (derived change). The agent queries "what changed since my last observation" and gets both.

## Capabilities

The read and write operations are registered as capabilities so backward inference can discover them:

```ft
tool Spreadsheet.readCell
tool Spreadsheet.writeCell
tool Spreadsheet.listCells
```

When the agent needs a cell's value, the system traces backward to `readCell`. When a cell has a gap, the system identifies `writeCell` as the operation that can fill it.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Cells have inspectable types and values | `readCell` return type, `listCells` metadata |
| Formula cells recompute on dependency change | Prose: formula consistency identity (cascade) |
| Read and write have typed schemas | `Spreadsheet` type definition |
| Empty typed cells surface as gaps | `sheet1` mount with B2 having type but no value |
| External changes produce visible deltas | Prose: mount model produces diffs including derived cells |
| Multi-sheet support | `sheet: string` parameter scopes all operations |
| Pre-validation rejects type violations | `salaryCell = number >= 0` rejects invalid writes |
