# Excelify

## Original Notes

- SOME UTILITY TO BUILD A BLOCK OF RELATIONS EQUIVALENT TO A SHEET
- DOESN'T NECESSARY NEED TO WORK FULLY - I JUST NEED TO SEE HOW WE CAN (HOW IT WOULD BE MODELLED)

A spreadsheet is a dependency graph disguised as a grid. Each cell is either a literal value or a formula that references other cells. The hard part is not the grid layout -- it is the automatic, dependency-ordered recalculation that fires whenever any input changes. A formula referencing another formula's output creates chains of derivation that must resolve in topological order, and when inputs are missing (gaps), the downstream formulas should degrade gracefully rather than error.

This models spreadsheet-like relational computation within the system's data framework. It is not a general-purpose spreadsheet application -- the goal is demonstrating how dependency-driven recalculation maps to the type system.

## Problem Context

- **Actor(s)**: End users who define and interact with tabular data; the computation engine that resolves formulas.
- **Domain**: Spreadsheet-like relational computation -- named cells with literal values or formulas referencing other cells, organized in a grid-like structure.
- **Core Tension**: Dependency-ordered recalculation must be automatic and correct (no stale values, no circular deadlocks), while gracefully degrading when inputs are missing rather than failing with errors.

## Requirements

**R1**: The system SHALL allow users to define named cells, each holding either a literal value or a formula that references other cells.
- *Rationale*: The fundamental unit of spreadsheet computation is the cell, which is either user-entered data or a derivation from other cells.
- *Verifiable by*: A cell can be created with a literal value, and separately a cell can be created whose value is defined as a function of other cells.

**R2**: Column schemas SHALL constrain the data type of all cells in a column, rejecting writes that violate the constraint.
- *Rationale*: Type constraints prevent invalid data entry (e.g., text in a numeric column) and preserve downstream computation integrity.
- *Verifiable by*: Writing a string to a numeric-typed column produces a validation error; writing a number succeeds.

**R3**: When any input cell's value changes, all formula cells that depend on it (directly or transitively) SHALL automatically recompute their values without manual intervention.
- *Rationale*: Automatic recalculation is the defining behavior of a spreadsheet. Stale values would make the system unreliable for any decision-making.
- *Verifiable by*: Changing an input cell and immediately reading a dependent formula cell returns the updated result.

**R4**: Recalculation SHALL resolve dependencies in topological order such that no formula evaluates before its inputs are current.
- *Rationale*: Out-of-order evaluation would produce transiently incorrect results, even if they eventually converge.
- *Verifiable by*: In a chain A -> B -> C, updating A causes B to recompute before C, and C's result reflects B's updated value.

**R5**: When a formula references a cell with no value, the formula SHALL produce a partial result indicating which inputs are known and which are missing, rather than raising an error.
- *Rationale*: Graceful degradation lets the user see what is computable and what is blocked, enabling incremental data entry.
- *Verifiable by*: A formula referencing one populated cell and one empty cell reports that it has partial information rather than failing.

**R6**: The dependency graph SHALL be inspectable -- a user can query which cells a given formula depends on and which cells depend on a given input.
- *Rationale*: For debugging and understanding, users need to trace how values flow through the sheet.
- *Verifiable by*: Querying dependencies of a formula cell returns the set of cells it references; querying dependents of an input cell returns all formula cells affected by it.

**R7**: Aggregate cells (e.g., totals, averages) SHALL support chained derivation, where one aggregate references another aggregate's output.
- *Rationale*: Summary rows often depend on other summary rows (e.g., a grand total that sums sub-totals). The system must handle arbitrary derivation depth.
- *Verifiable by*: A total-of-totals cell correctly recomputes when an underlying data cell changes, propagating through intermediate aggregates.

## Acceptance Criteria

**AC1** [R1]: Given a sheet with columns A-D, when the user writes a literal value "Widget Co" to cell A1 and a formula `B1 + C1` to cell D1, then A1 returns "Widget Co" and D1 returns the sum of B1 and C1.

**AC2** [R2]: Given column B is constrained to numeric values, when the user writes the string "hello" to B1, then a type mismatch error is reported.

**AC3** [R3]: Given D1 = B1 + C1 with B1 = 15000 and C1 = 22000, when B1 is updated to 18000, then D1 automatically returns 40000 without any manual trigger.

**AC4** [R4]: Given TotalD depends on TotalB which depends on B1, when B1 changes, then TotalB reflects the new B1 before TotalD evaluates, and TotalD's result is consistent with the updated TotalB.

**AC5** [R5]: Given D1 = B1 + C1 with B1 = 15000 and C1 having no value, then D1 reports a partial result (B1 is known, C1 is missing) rather than an error.

**AC6** [R6]: Given D1 = B1 + C1, when the user queries D1's dependencies, then {B1, C1} is returned; when the user queries B1's dependents, then {D1} (and any other referencing cells) is returned.

**AC7** [R7]: Given TotalB = sum(B1, B2) and TotalD = TotalB + TotalC, when B1 changes, then TotalB recomputes, which causes TotalD to recompute, and the final TotalD value is correct.

## Open Questions

- What is the maximum supported depth of chained derivation before performance degrades unacceptably?
- Should circular references be detected at definition time (preventing them) or at evaluation time (breaking them with an error)?
- Does the system need to support non-numeric formulas (e.g., string concatenation, conditional logic), or is the scope limited to numeric computation?
