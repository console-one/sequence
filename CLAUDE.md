# CLAUDE.md — sequence

**Read this before touching, citing, or grepping anything in this repo.**

## WHICH ENGINE — the one fact that has caused the most confusion

This package ships **two engines and one shared vocabulary**. They are
not versions of the same file. They are different classes in different
directories, and grep results from the wrong one have repeatedly been
reported as "how sequence works."

| import | directory | what it is | use it? |
|---|---|---|---|
| `@console-one/sequence/v2` | `src-v2/` | **THE KERNEL.** One op (`insert`), one algorithm (traverse → admit → compose → propagate), features as rules (`Rule.scope`, `Rule.watching`, admission vs observation rules, `where` suspension + temporal resume, `invalidate`, fixpoint with a cycle guard). `vend`, `continueSession`, `receiveDocument`, `receiveCalls`, procedures, installers, validity horizons, `$tv` envelopes. | **Yes. New work targets this. Every consumer instantiation in observatory-app and topic-dao is v2.** |
| `@console-one/sequence` (root) | `src/` | The **deprecated v1 engine** (`mount`/`receive`): `src/sequence.ts` (~4,200 lines), `fireLaws`, `depIndex`/`globDepIndex`/`backwardIndex`, `statement.ts`, `laws.ts`, `env.ts` (`loadEnv`), v1 `vend.ts`, `commitments.ts`, `rotation.ts`. | **No.** Kept only while consumers migrate. Root engine exports carry `@deprecated`. |
| `@console-one/sequence` (root) | `src/type.ts`, `src/compose.ts`, `src/builder.ts` (FT), `src/hoist.ts`, `src/dsl/` | The **shared vocabulary** both engines import. Never "v1". | Yes — this is what a root import should be for. |

The two-engine state is a migration, not an architecture, and it ends:
the root flips to v2 at 0.4.0 and the v1 engine is deleted the minor
after. The authority for what is done, pending, and still holding the
flip open is **`specs/docs/DELETION_LEDGER.md`**. Known consumers still
on v1: `sequenceutils/src/transport/{client,sequence-node}.ts` (ledger
S4, pending).

## Rules that follow

1. **Name the engine in every sentence.** "sequence does X" is not a
   claim. "v2's propagate does X" or "v1's fireLaws does X" is.
2. **Grep `src-v2/` for kernel behaviour.** A hit in `src/sequence.ts`,
   `src/laws.ts`, `src/statement.ts` or `src/env.ts` describes the
   engine being deleted; say so if you cite it.
3. **Check the ledger's S6 gap list before assuming parity.** As of
   2026-09-04 v2 lacks: structured rejection on `insert` (a suspended
   write and a refused write are indistinguishable to the caller; the
   `Gap` surface is v1-only), the full statement-grammar walk
   (`where`/`in` scopes, `index … over`, readers, classes), a single
   `loadEnv` boot call, `renderForReader` parity (`electFrame` is the
   successor), scalar `concreteness`, doc transclusion via type meta,
   `rotate`. Execution records (`_exec.*`) exist in v1; not found in v2
   as of the same date.
4. **A runtime warning fires once when the v1 `Sequence` is
   constructed** (`SEQUENCE_V1_SILENT=1` suppresses it). If you see it
   in a consumer, that consumer is on the wrong engine or is one of the
   named S4 holdouts.

## Where the design that consumes this lives

`~/publicpackages/observatory-app/docs/MAP-SERVER-REALITY-TARGET.md`
(the office's server design; its "WHICH SEQUENCE" block mirrors this
file). When the two disagree, this file and the ledger win for what
sequence *is*; that file wins for what the office *does with it*.
