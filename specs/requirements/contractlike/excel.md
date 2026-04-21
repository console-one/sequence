# Excel Spreadsheet Integration

A spreadsheet is a grid of typed cells where values propagate through formula dependencies. The agent sees two layers: the current state (cell values) and the dependency structure (which cells derive from which). Changing one cell can cascade through formulas and update dozens of others. The system must expose both layers so the agent can reason about consequences before acting.

The hard part is formula cascade. When the agent writes to A1 and A3 is `=A1+A2`, the write's behavioral contract must express that A3 will update. This is a quantified predicate over the dependency graph -- every cell derived from A1 will recompute. The parser cannot express `forall` quantifiers yet, so cascade behavior is described in prose alongside the structural types.

## Problem Context

- **Actor(s)**: Agents reading/writing cell values; external users and data feeds modifying the spreadsheet concurrently; formula evaluation engine.
- **Domain**: Spreadsheet data management -- typed cell grids with formula-based dependencies, multi-sheet scoping, and real-time cascade propagation.
- **Core Tension**: A single cell write can trigger an unbounded cascade of recomputations through the formula dependency graph. The system must guarantee cascade completeness (all derived cells update atomically) while giving agents visibility into both direct and derived changes.

## Requirements

**R1**: Each cell SHALL have an inspectable type, a current value (or absence of value), and an optional formula.
- *Rationale*: Agents need to distinguish between cells that hold literal values, cells that compute values from formulas, and cells that are declared but empty.
- *Verifiable by*: Reading any cell returns its type, its current value (or an indication of absence), and its formula if one exists.

**R2**: Cell values SHALL be one of: string, number, boolean, or null.
- *Rationale*: These four primitives cover every value a spreadsheet cell can hold. Constraining to this set enables uniform validation and serialization.
- *Verifiable by*: Attempting to write a value outside this set (e.g., an object or array) is rejected.

**R3**: Writing to a cell that is a dependency of formula cells SHALL trigger recomputation of ALL transitively dependent cells.
- *Rationale*: Partial cascade (A1 updates but A3 does not) creates inconsistent state that agents cannot reason about.
- *Verifiable by*: After writing to A1 where A3 = A1 + A2 and A5 = A3 * 2, both A3 and A5 reflect values consistent with the new A1.

**R4**: Formula cascade SHALL be atomic -- after a write returns, all derived cells reflect the new state with no observable intermediate state.
- *Rationale*: An agent observing the spreadsheet between a write and its cascade completion would see inconsistent data. Atomicity prevents this.
- *Verifiable by*: No read operation between a write and its return observes a state where the written cell has the new value but a derived cell has the old value.

**R5**: Writes SHALL be validated against cell type constraints before any mutation occurs.
- *Rationale*: A cell typed as `number >= 0` must reject -100 before the spreadsheet engine sees the value. Pre-validation prevents invalid state from ever existing.
- *Verifiable by*: Writing -100 to a cell constrained to `number >= 0` produces a constraint violation error, and the cell retains its previous value.

**R6**: All operations SHALL be scoped by sheet name, and multiple sheets SHALL coexist without interference.
- *Rationale*: A workbook contains multiple sheets with independent schemas. Operations on Sheet1 must not affect Sheet2.
- *Verifiable by*: Writing to cell A1 on Sheet1 does not alter cell A1 on Sheet2, even if both sheets have identically named cells.

**R7**: The system SHALL expose which cells have a declared type but no value (empty typed cells).
- *Rationale*: Agents need to discover what data is missing so they can fill it. A cell with a type but no value represents incomplete data.
- *Verifiable by*: After declaring cells A1:number, A2:number, B1:string, B2:string and filling only A1, A2, B1, the system reports B2 as requiring a string value.

**R8**: When cells change (whether by agent action or external modification), the system SHALL report which cells changed and which derived cells were affected.
- *Rationale*: Agents need the delta, not just the current state. "A1 changed and A3 was recomputed" is actionable; "something changed" is not.
- *Verifiable by*: After an external change to A1 from 100 to 150 where A3 = A1 + A2, the change report includes both A1 (direct change) and A3 (derived change).

**R9**: The system SHALL support discovery of spreadsheet read, write, and list operations so that agents can find them when they need cell data or need to fill missing values.
- *Rationale*: Agents should not need a hardcoded list of available operations. When an agent needs a cell's value, the system should be able to identify that `readCell` can provide it.
- *Verifiable by*: When an agent requires a numeric value and a spreadsheet cell of type `number` exists, the system identifies `readCell` as a means to obtain it.

## Acceptance Criteria

**AC1** [R1]: Given a cell A1 with type `number`, value `100`, and no formula, when reading A1, then the result includes `{value: 100, type: "number", formula: undefined}`.

**AC2** [R1]: Given a cell A3 with formula `=A1+A2`, when reading A3, then the result includes `{formula: "=A1+A2"}` and a value computed from A1 and A2's current values.

**AC3** [R3, R4]: Given A1=100, A2=200, A3=A1+A2, when writing A1=150, then after the write returns A3=350 with no intermediate state observable.

**AC4** [R5]: Given a cell `salary` typed as `number >= 0`, when writing -100, then the write is rejected with a constraint violation and the cell retains its previous value.

**AC5** [R6]: Given Sheet1.A1=100 and Sheet2.A1=500, when writing Sheet1.A1=200, then Sheet2.A1 remains 500.

**AC6** [R7]: Given cells A1:number=100, A2:number=250, B1:string="Revenue", B2:string (no value), when listing missing data, then B2 is reported as needing a string value.

**AC7** [R8]: Given A1=100, A3=A1+A2, when A1 is externally changed to 150, then the change report includes `{A1: directChange, A3: derivedChange}`.

## Open Questions

1. **Formula language**: What formula syntax is supported? Full Excel formula language, or a restricted subset? This affects the scope of the dependency graph and cascade complexity.
2. **Circular formula references**: How are circular dependencies (A1=A2, A2=A1) detected and reported? This is a hard constraint on the dependency graph.
3. **Concurrent writes to dependent cells**: If two agents write to A1 and A2 simultaneously, and A3 = A1 + A2, what is the cascade ordering? Is there a total order guarantee?
