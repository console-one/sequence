# @console-one/sequence

If you build anything agent-shaped — a harness, a tool router, a job
queue that people and LLMs share — you keep needing answers ordinary
type systems refuse to give: *how complete is this record, exactly?*
*how long will this call take?* *can this plan make its deadline, at
what confidence?* *who may write this, and what happens to a write that
arrives early?* *under a 500-token budget, what is worth showing this
reader?*

sequence answers all of them with one mechanism: an append-only log of
typed facts (`mount` is the only write), a derived projection, and a
type lattice where **a value is a maximally concrete type**. Schemas,
values, laws, cost curves, and reader budgets are all the same substance
on the same log — so validation, progress, scheduling, access control
and rendering stop being separate subsystems. There is a text form, the
**ft language**, that round-trips with the store.

**Start with [the tutorial](doc/index.md)** — five short parts, one
running example each, and every ft block in it is executed by this
repository's test suite, so the pages cannot drift from the kernel.

## Install

```bash
npm install @console-one/sequence
```

## Sixty seconds of it

```ts
import { Sequence, receive } from '@console-one/sequence';

const seq = new Sequence();
receive('deploy = { service: string, region: "us-east-1" | "eu-west-1", replicas: number }', seq);

seq.concreteness('deploy');                    // 0.159 — declared, far from done
receive('deploy.region = "ap-south-2"', seq);  // ok: false — "matches none of 2 branches"
receive('deploy.service = "checkout"', seq);
receive('deploy.replicas = 3', seq);
receive('deploy.region = "eu-west-1"', seq);
seq.concreteness('deploy');                    // 1 — the record's value IS its type now
```

The store measured the distance between "declared" and "done", refused
the illegal write with a reason, and knew the moment the record became
actionable — none of which was written as application code.

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
