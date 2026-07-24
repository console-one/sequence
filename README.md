# @console-one/sequence

Append-only behavioral type kernel. Types and values are the same continuum — a value IS a maximally concrete type. Mount a typed fact, see what's missing (gaps), fill gaps through compose, capabilities activate. One operation (`mount`), one data structure (`Sequence`), one protocol (ft text in/out).

## Install

```bash
npm install @console-one/sequence
```

## Quick start

```ts
import { Sequence, FT } from '@console-one/sequence';

const seq = new Sequence();
seq.mount('schema', 'count', FT.number());
seq.mount('bind', 'count', 42);

seq.get('count');        // 42
seq.concreteness('count'); // 1 — value satisfies schema
```

## Runnable examples

`examples/` holds six self-asserting demos — one per core claim (continuum,
learned cost curves, temporal feasibility, backward inference, admission
laws, budgeted rendering) — plus a reproducible micro-benchmark:

```bash
npm run build
npm run examples        # all six, fail-fast; each exits non-zero if its claim breaks
node examples/bench.mjs # numbers on YOUR machine, including the honest scaling curve
```

See `examples/README.md` for the claim-by-claim table.

## Core API

- **`Sequence`** — append-only block log with derived projection. `mount()` is the only write operation.
- **`FT.*`** — builder convenience API: `FT.string()`, `FT.object({...})`, `FT.fn({...})`, `FT.segmented([...])`, etc.
- **`createType`** — lower-level type constructor with full constraint vocabulary.
- **`compose`** — lattice meet. `compose(a, b)` returns the tightest type consistent with both.
- **`backwardInfer`** — given a required output, derive the required input.
- **`hoist`** / **`hoistForReader`** — emit projection as ft text, optionally scoped to a reader contract.
- **`receive`** — parse ft text into the sequence.
- **`loadEnv`** — boot a Sequence from a clock, snapshots, entries, and capability impls.
- **`rotate`** — lock-holder moves a range to a destination with a transparent redirect. The compression/federation/retention primitive.
- **`renderForReader`** — cluster → score → rank → budget → hoist pipeline.

## Design invariants

1. Types and values are the same continuum. A value is a maximally concrete type.
2. `=` overwrites, `<<` narrows. Ordered choice on unions.
3. `prev` for all self-reference. Prior value at same path, or prior element in array.
4. Behavioral predicates are refinement types.
5. The "compiler" is the Sequence — parse → walk → mount; no separate compilation.
6. Hoist output is valid ft input. Round-trippable.
7. Mount → cascade (via backward index) → enforce admission → report changes.
8. Kernel internals are values. `_deps.*`, `_rdeps.*`, `_caps`, `_blocks.*` all readable via `get()`.
9. Application features are type state, not kernel methods. Backlinks, indexes, ranking, sharding — all expressible as classes/capabilities mounted on the Sequence.
10. Reader contracts separate kernel from renderer.

## Source layout

```
src/
├── sequence.ts     # kernel: append-only log, derived projection, cascade
├── type.ts         # FieldType + constraint vocabulary
├── compose.ts      # lattice meet, covers, backward inference, CDF, conjugate update
├── statement.ts    # Statement/Block/MountEntry primitives
├── laws.ts         # pre-mount admission laws (law({admission: true, check}))
├── builder.ts      # FT.* convenience API
├── hoist.ts        # emit projection as ft text
├── env.ts          # loadEnv — boot with clock, snapshots, impls
├── rotation.ts     # rotate(seq, {source, destination, author}) primitive
├── dsl/            # tokenize → parse → walk → mount
├── runtime/
│   └── render.ts   # cluster → score → rank → budget → hoist
└── test/           # 623 tests across 38 suites
```

## Specs

See `specs/docs/` for the full architecture and invariant documentation:

- `ARCHITECTURE.md` — overview
- `KERNEL_BOOT.md` — boot contract
- `DSL_REQUIREMENTS.md` — DSL specification
- `NARRATIVE_IS_TOOL.md` — the unification statement

## Development

```bash
npm install
npm run build       # tsc
npm test            # jest
npm run lint        # tsc --noEmit
```

### Git hooks

Hooks are tracked under `.githooks/`. Enable after cloning:

```bash
git config core.hooksPath .githooks
```

- **pre-commit**: `tsc --noEmit`
- **pre-push**: `jest`

## License

MIT
