# Tool Compilation & Vending — the kernel's client-facing surface

**Captured 2026-07-24 from Andrew's directive (verbatim requirements,
restructured; the design lineage is April 2026 — see the source ledger
at the bottom. This is the composition target the clause layer, the
reader machinery, and the doc/label vocabulary exist FOR.)**

## The pipeline, as specified

1. **Boot**: sequence boots in code as a *tool-compilation kernel*;
   default tools are installed to run it.
2. **Connectors in the language**: custom connectors are set up in ft —
   not compiled code.
3. **Documents with links** are stored and associated with tool
   definitions OR with the type definitions of fields DEEP inside the
   tools' APIs.
4. **The create command**: a standard CLI create command (with CLI
   metadata) is issued to the kernel carrying:
   - a communication format,
   - optionally a query,
   - a set of constraints (max tools, token length, …).
5. **The response** is a set of API definitions in the FT type language:
   - probability distributions for the time intervals the API is valid,
   - validity length of the CLI itself,
   - validity of particular API call patterns,
   - link-embedded expansion terms,
   - inline labelled documentation sections,
   - **a tool endpoint to extend/continue the session** — every other
     vended FT definition is effectively a constant/CLI command that is
     input to a call at THAT endpoint — until its structured expiry.
6. **Prelude transclusion**: if two tools carry documentation whose
   metadata embeds the same reference-document link configured as
   `prelude transclusion`, the rendered definition set contains that
   document ONCE, as a prelude, transcluded.
7. **Label-group election**: if the link is a reference to a label or a
   query over a label group (e.g. short / medium / long description),
   exactly ONE document is rendered — the most context-suitable under
   the budget.
8. **The loop**: an LLM can issue FT back to update the kernel, install
   new things, or simply interact with what was returned.

## Requirement → existing machinery (verified in source, 2026-07-24)

| Req | Status | Where |
|---|---|---|
| R1 boot contract, default tools | EXISTS | `specs/docs/KERNEL_BOOT.md` (Environment: clock, snapshots, mountCapabilities, generator loop "pull hoisted ft / push responses"); `loadEnv` |
| R2 connectors in the language | EXISTS | tool/fn-defs-as-data; endpoint()/auth() executed by the kernel; production receipt: the office Codex connector is pure manifest data |
| R3 docs linked to tools / deep field types | **v0 SHIPPED** (meta doc/docPrelude/docGroup, deep-field walk) | type `meta.description` per field; block doc-rows (`"engine-agnostic"`), `ref("path")` rows; `template` constraint ("narrative IS tool IS derived", ft@910bb06); MISSING: doc artifacts as first-class values + a doc-link vocabulary on constraints (labels, prelude flag) |
| R4 create(format, query, constraints) | **v0 SHIPPED** (`vend()`, src/vend.ts) | readers ARE this, as data: `_readers.<n>.{source, mode, filter, limit, depth, render, sink}` (`hoistForReader`); `renderForReader` budget election; `hoistCatalog`; MISSING: the tool-catalog composition (select by query over labels/types) and a `vend` verb binding it |
| R5 validity distributions on definitions | **UNLOCKED 2026-07-24** | the clause layer in text: `~survival(exp, r)` reliability, `@[T_out..next_write(p).T_out)` Δt intervals, `while`-gated lifetime, `when`-gated entry — vended definitions can now CARRY their expiry/validity as ft |
| R5b expansion terms | EXISTS | `[[ label : description ]]` round-trippable expansion tokens; hoist emits them; receive accepts them |
| R5c continue endpoint + structured expiry | **v0 SHIPPED** (`continueSession`; frame-snapshot validation still open) | `specs/impl/prompts/toolpersistence.md` (frame snapshots: tokenMap + gaps + tools + costs frozen at prompt-generation; tool calls validated against the SNAPSHOT, not current state; the `expand` tool with per-token costs); office's retained-contract machinery is the production cousin |
| R6 prelude transclusion | **v0 SHIPPED** (dedupe + render-once in vend) | kernel comment (sequence.ts): "templates, derivations, transclusions all flow through the same [machinery]"; dedupe-shared-ref-render-once is a NEW render rule |
| R7 label-group election | **v0 SHIPPED** (largest variant fitting half the remaining budget) | label backlinks (ft@614f4cb) + `index` layer + renderForReader budget scoring; the election rule (pick short/medium/long by remaining budget) is new |
| R8 LLM issues ft back | EXISTS | `receive()` round-trip; "proven LLM-via-ft-text loop" (ft@39faee7); office eval env is the production receipt |
| Prompt-as-segments composition | SPEC'D | `specs/impl/prompts/composition.md` (segment templates; `${compress(./history…).maxLen(…)}`, `${./tools}`) — one of the 14 ledgered grammar gaps (PromptSegment shapes) |

## Build order (each slice lands on existing machinery)

1. **Doc vocabulary** — doc artifacts as mounted values; `doc(ref)` /
   label / `prelude` metadata attachable to tool defs AND to field
   types deep in fn input/output shapes (meta rides types already —
   this is vocabulary, not kernel surgery).
2. **The vend pipeline** — `vend(reader)`: select tools (query over
   labels/types), compose the definition set via hoistCatalog +
   renderForReader budget election; label-group election; prelude
   transclusion (collect prelude refs across selected tools, dedupe,
   render once at top); emit with expansion tokens.
3. **The session contract** — mount a frame snapshot per vend
   (toolpersistence.md shape); vend includes `continue`/`expand` tool
   endpoints; definitions carry `while`/`~survival` expiry from R5.
   Calls validate against the snapshot.

## Source ledger (the surviving articulation)

- `specs/impl/prompts/toolpersistence.md` — Andrew's dictated original
  (expand tool, unique letters, expansion costs, frame snapshots,
  backward-inference flow, deadlines).
- `specs/impl/prompts/composition.md` — Andrew's dictated original
  (segment templates, budgeted history/tool transclusion into prompts).
- `specs/docs/KERNEL_BOOT.md` — the environment/boot contract.
- ft@910bb06 "template constraint — narrative IS tool IS derived",
  ft@37a049a "Reader: first-class mounted observation contract",
  ft@39faee7 "proven LLM-via-ft-text loop", ft@614f4cb "label backlinks".
- The essay (System Attention): "vending interactable cli's to all
  external interfaces … while itself being composite consumer of its
  own consumed sources."
