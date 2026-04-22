# Capability Installation — the substrate's install-side primitive

Status: architectural commitment, 2026-04-21. Foundational. The
third face of one cascade, alongside COMMITMENTS.md (write-side)
and LEARNING_AS_COMPRESSION.md (learning-side).

COMMITMENTS.md describes what the substrate does when it elects new
work. LEARNING_AS_COMPRESSION.md describes what the substrate does
when it observes fulfillments. This document describes what the
substrate does when it acquires a new capability in the first place.

## The insight

Today, installing a capability is an incomplete triple — path, type
signature, impl — with contract wiring, telemetry, and learning all
expected to be bolted on afterward, per-capability, by hand. Most
never are. The result: the substrate hosts capabilities it cannot
enforce, cannot audit, and cannot learn from, because the artifact
that would express those obligations was never made part of the
install.

Installation is not the act of registering an endpoint. It is the
act of committing to host a capability under a contract, with a
learning surface that captures every invocation and an impl that
satisfies the contract's write-authority. If any of those is
absent, the substrate has not installed a capability — it has
adopted an unmanaged hole in its own type state.

The fix is to make installation a single atomic act that binds all
four pieces at once. The blueprint is not "path + type + impl with
options" — it is a **quadruple** in which no component is optional.

## The primitive

A capability is a mounted **quadruple**:

| Component | Meaning |
|---|---|
| `type` | Input/output signature at the capability's path. Determines the shape of commitments elicited against it. Serializable; no live functions (A5). |
| `contract` | Prerequisites the environment must satisfy for the install to complete, plus admission laws evaluated against every invocation. Laws are serializable constraint sets (A4); they MAY read posterior state to become evidence-conditioned. |
| `impl` | The holder resolution for commitments elicited against the path. Resolved from the environment's impl registry by ID at install time; the blueprint carries the ID, not the live function. |
| `distribution` | The conditional posterior surface from LEARNING_AS_COMPRESSION.md — `over` dimensions, declared subtypes, initial priors, refinement policy. Present at install even if empty; the presence of the field is what makes invocations learnable. |

Install mounts all four atomically as one block. The block is
suspended by where-clauses on unmet prerequisites; it applies, and
the capability exists, only when prerequisites are concrete.

An install block that mounts a subset is rejected. There is no
"install now, add contract later"; there is no "install now, add
distribution later." The quadruple is the unit.

## Install as cascade entry

```
install(blueprint)
  → create block with entries:
      schema   at path                      = blueprint.type
      law      at path                      = blueprint.contract.laws[*]
      cap      at path                      = implId(blueprint.impl)
      schema   at path + '.distribution'    = blueprint.distribution
    where:
      blueprint.contract.prerequisites all concrete
  → mount(block)
    → where-check suspends if prerequisites missing
    → applies atomically when concrete
    → cascade fires once, propagating:
        - the type's ancestors become aware of the new slot shape
        - the impl registration makes the path electable
        - the distribution surface becomes observable
```

No out-of-band registration, no install script, no separate "wire
up telemetry" step. One block; the cascade does the rest.

Invocation thereafter:

1. A path in the caller's ft text expands into an entry against
   the capability's path.
2. The substrate elects a commitment (COMMITMENTS.md) with the
   capability's registered impl as holder.
3. The holder writes the head.
4. On concrete final state, the fulfillment cascade terminal
   updates the distribution's posterior (LEARNING_AS_COMPRESSION.md).
5. Admission laws on the capability may read the posterior and
   reject writes that fall outside the learned predictive quantile.

Every invocation is a commitment; every fulfillment updates the
posterior; every admission can be evidence-conditioned. None of
these is instrumented at the capability; all of them fall out of
the quadruple being mounted correctly at install time.

## Symmetry across blueprint kinds

The existing blueprint taxonomy — HTTP endpoint sets, runtime
classes, document-based definitions, tool adapters — converges on
one install shape:

| Blueprint kind | `type` | `contract.prerequisites` | `impl` | `distribution` |
|---|---|---|---|---|
| HTTP endpoint set | Declared request / response shapes | Auth secrets (API keys, OAuth tokens); base URL; rate-limit budget | HTTP client bound to the endpoint | Latency + response-shape posterior |
| Runtime class | Method signatures on the class | Runtime version, native deps | Live class reference (resolved at install) | Per-method latency + output posterior |
| Document-based | Schema declared in the document | Document validity; referenced capabilities available | Deterministic interpreter over the document | Interpretation time + output posterior |
| Tool adapter | Adapter's declared surface | Wrapped tool present in env | Adapter binding | Adapter-call latency + output posterior |

No kind needs a special install path. The shape is the same; the
fields populate differently.

## What this collapses

The substrate today has several ad-hoc install shapes and
afterthoughts. Under the quadruple they become one:

| Today | Under the quadruple |
|---|---|
| `cap` entry registers impl; type mounted separately; contract enforced by scattered `law` mounts elsewhere (if at all) | One install block; type, laws, and impl mount atomically with where-clauses on prerequisites. |
| Telemetry / observation retained per-capability via bespoke wrappers around the impl | `distribution` mount is the observation surface; fulfillment cascade terminal updates it uniformly. No impl wrapping. |
| Secrets wired to capabilities by reference from capability-specific code | `contract.prerequisites: ['state.secrets.openai.key']` gates the install. Secrets are ordinary state; the law references them by path. |
| "Install this capability and don't forget to set up logging" as documentation | No reminder needed. Absent `distribution` = no install. |
| Uninstall as a separate `cap.delete` convention | Uninstall is a block that invalidates the install block and its children. The block log records both. |
| Version reconciliation (env-installs R8) as a session-load chore | The install block carries its blueprint version; reconciliation is a mount-level operation against the recorded version. |

## Implementation contract

What the kernel must provide (load-bearing):

1. **Install block schema** — the substrate recognises a blueprint
   as a canonical `{ path, type, contract, impl, distribution,
   version }` record. An install block contains the mounts derived
   from this record; a block that mounts a subset of the derivations
   is rejected.
2. **Atomicity** — install is one `mount(entries[], opts)` call
   (A6, A12). Partial success is not possible; where-clause
   failure suspends the whole block (A3', A7).
3. **Prerequisite gating via where-clauses** — the install block's
   where-clause references prerequisite paths from
   `contract.prerequisites`. Unmet prerequisites suspend; they
   resume via tryResumeSuspended (A11) when prerequisites
   concretize.
4. **Impl resolution at install time** — the environment's impl
   registry resolves the blueprint's impl ID to a live function
   during block application. The ID goes in the block (A4 / A5
   serialisability); the live function is environment-bound.
5. **Cap mount conventions for distribution** — the `distribution`
   field mounts at `path + '.distribution'` as a type-state
   convention LEARNING_AS_COMPRESSION.md recognises. No new
   primitive.
6. **Reject-incomplete admission law** — a built-in substrate law
   that rejects any `cap` mount not accompanied by type +
   contract + distribution at the same path, same block. Makes
   the quadruple structurally unforgeable.

What the kernel does NOT need to know:

- Blueprint kinds (HTTP, runtime class, document, tool adapter).
  Each kind is an install-helper convention that produces a
  quadruple; the kernel sees only the quadruple.
- Impl implementation language, runtime, transport. Resolved to a
  holder (code-level or external per COMMITMENTS.md symmetry).
- Secret storage mechanics. `contract.prerequisites` references
  paths; how those paths become concrete (OS keychain, HSM,
  per-session prompt) is environment-policy.

## Migration plan

Incremental, gated by passing the existing 645 + 269 test baseline
at each step.

### Phase 1 — blueprint schema and builder

1. Add the canonical blueprint record type in `type.ts`:
   `Blueprint = { path, type, contract, impl, distribution,
   version }`. Export.
2. Add `FT.cap({ path, type, contract, impl, distribution })`
   builder in `builder.ts` that accepts the quadruple and returns
   an install block ready for `mount()`. The builder constructs
   entries + where-clauses from the blueprint; callers hand
   mount() the result.
3. Write coverage tests: build a blueprint, install it, enumerate
   the resulting mounts, verify atomicity under prerequisite
   absence.

### Phase 2 — the reject-incomplete admission law

4. Install a substrate-level admission law that gates `cap` mounts:
   a `cap` at path P without a matching `schema`, `law` (at least
   one), and `distribution` schema at the same path in the same
   block is rejected with a specific reason referencing the
   missing field(s).
5. Migrate existing cap mount call sites to the blueprint form.
   Where contract is genuinely absent, mount an explicit
   `contract: { laws: [] }` — the presence of the empty list is a
   deliberate declaration, not an omission.
6. Where `distribution` is absent, mount the trivial scalar form
   (`{ over: ['time'], conditional_on: [], posterior: {},
   refinementPolicy: { mdlThreshold: Infinity } }`). Infinity
   threshold means no refinement promotion until the blueprint
   opts in; posterior over time is the 1-D degenerate marginal
   from LEARNING_AS_COMPRESSION.md.

### Phase 3 — blueprint-kind helpers

7. Add install helpers for each blueprint kind:
   `FT.httpCapability`, `FT.runtimeClass`, `FT.documentCap`,
   `FT.toolAdapter`. Each produces a quadruple.
8. Migrate `env-installs.md`, `class-installs.md`, and
   `skill-installs.md` to require the quadruple in the blueprint
   schema. Extend requirements (R4, R5, R6) to explicitly name
   contract and distribution as part of the typed blueprint.

### Phase 4 — invocation lifecycle unification

9. Invocation of an installed capability goes through the
   commitment election path from COMMITMENTS.md. Remove any
   remaining special-cased capability-invocation code paths.
10. On fulfillment, the cascade terminal runs posterior updates
    per LEARNING_AS_COMPRESSION.md Phase 2. By this phase, the
    three documents have reached one implementation.

### Phase 5 — uninstall and versioning

11. Uninstall: a block that appends `invalidate` entries against
    the install block's path prefix. Active commitments at the
    path receive revocation via control channel; dependents
    surface the path as unavailable (matches env-installs R7).
12. Versioning: the install block carries `version`. Reinstall at
    a higher version creates a new install block; the blueprint
    carries a `posteriorPolicy` governing whether prior
    observations under the old version continue to inform the
    new version's posterior or are decayed / discarded.

## Risks

- **Over-specification burden on tiny capabilities**. Forcing
  contract + distribution on a one-line capability feels heavy.
  Mitigation: defaults. Empty laws and trivial scalar
  distribution are legal and take one line to express. The
  burden is "declare the fields" (two tokens), not "design full
  contracts."

- **Secret-in-blueprint temptation**. Blueprints are data and
  federable. A developer tempted to put an API key in
  `contract.prerequisites` defeats the point. The prerequisite
  must reference a path where the secret lives (`state.secrets.*`)
  and never the secret itself. Document explicitly; enforce via
  a built-in law rejecting blueprint mounts with secret-shaped
  literal values.

- **Impl resolution failure after install**. The impl ID in the
  blueprint may fail to resolve in a new environment (session
  loaded into a different env version; federation to a node
  without the impl). The install block becomes applicable but
  holderless. Surface this as a distinct gap state: "installed,
  holder unresolved"; admission and elections behave
  accordingly.

- **Distribution reset on impl version change**. When
  `blueprint.version` changes alongside a semantically different
  impl, the accumulated posterior under v1 may be misleading for
  v2. `posteriorPolicy` declares behavior: `carry` (continue
  updating the same posterior), `decay` (apply an impl-change
  decay multiplier to effective sample size), or `reset` (start
  fresh). Default `decay`.

- **Uninstall leaving orphan posteriors**. After uninstall, the
  posterior state persists at `_commitments.*.distribution.*`
  under the invalidated path. That is a feature (historical
  audit), not a bug. Dedicated readers surface them as
  archived; they do not gate new installs.

- **Quadruple as Procrustean bed for genuinely exotic
  capabilities**. Some capabilities may not fit cleanly — e.g. a
  capability whose impl is the substrate itself (meta-install).
  The quadruple admits this: `impl` can be `implId('substrate')`
  resolving to the substrate's own mount operation; `contract`
  and `distribution` still apply. Test this at migration time;
  flag exceptions as requiring kernel-level specialisation rather
  than quadruple bypass.

- **Reject-incomplete law in legacy code migration**. Phase 2's
  admission law will reject pre-migration `cap` mounts that lack
  the quadruple. Migration order matters: install the law AFTER
  the call-site migration, not before. Tests during migration
  must run with the law disabled; enable it as the final step
  once all call sites are converted.

## Relationship to other architectural commitments

- **COMMITMENTS.md (landed)** — this document's `impl` field
  names the holder candidate; invocations of installed
  capabilities elect commitments with that holder. The install
  IS the registration of a holder candidate for a typed slot.

- **LEARNING_AS_COMPRESSION.md (landed via this document's
  dependency chain)** — this document's `distribution` field IS
  the conditional posterior surface. Installation mounts the
  initial priors and refinement policy; fulfillment cascade
  terminals update them.

- **AXIOMS A4 / A5 (landed)** — constraints and types are
  serializable data. The blueprint is data; impls are resolved
  at install time from the environment. This preserves the
  sequence's "no live functions in the log" invariant.

- **AXIOMS A6 / A12 (landed)** — mount is the single operation;
  mount takes a block; blocks are atomic. The quadruple mounts
  as one block.

- **AXIOMS A3' / A7 (landed)** — where-clauses suspend blocks
  whose preconditions aren't met. Prerequisites are where-clauses
  on the install block; missing secrets or unresolved impls
  suspend the install until they concretize.

- **env-installs.md / class-installs.md / skill-installs.md
  (extending)** — the blueprint shape documented across these
  requirements converges on the quadruple. This document names
  the convergence; Phase 3 of the migration plan extends each
  requirement spec explicitly.

- **Narrative-is-tool unification (landed)** — a narrative is a
  type with gaps; a capability is a type with an impl. Installing
  a capability is filling certain gaps in the narrative of
  "substrate ability" with a holder. The quadruple makes the
  narrative explicit.

## Reading order for someone arriving at the substrate

1. **AXIOMS.md** — the load-bearing invariants.
2. **ARCHITECTURE.md** — how the pieces fit.
3. **COMMITMENTS.md** — what the substrate does on the write side.
4. **LEARNING_AS_COMPRESSION.md** — what the substrate does on the
   observational side.
5. **This document** — what the substrate does on the install side.
6. **KERNEL_REQUIREMENTS.md** — the contract the kernel implements.
7. **DSL_REQUIREMENTS.md** — how it surfaces in ft text.

Three documents, three terminal projections of one cascade:
election of new write-leases, compression of the observations
that fulfilled the old ones, and acquisition of the capabilities
that produce both. The quadruple is the install-side dual of the
commitment (write-side) and the posterior (learning-side). One
substrate, one log, one loop — three entry points into the same
machine.
