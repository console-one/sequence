# Part 6: Clauses and claims

Everything so far attached types to *paths*. This part is the layer the
language was actually designed for: attaching **claims** to statements —
inline clauses that say when a write may enter, how long a fact stays
true, what must hold across a family of paths, and how much to believe a
result as time passes. In the original design notation: ∀ and ∈ for
quantified claims, Δt for temporal scope, probability bands on function
results. The text forms below are those symbols, spelled.

(The full designed grammar lives in
[`specs/docs/DSL_REQUIREMENTS.md`](../specs/docs/DSL_REQUIREMENTS.md);
the implemented-today subset and its honest gap list in
[`specs/impl/SYNTAX_SUPPORTED.md`](../specs/impl/SYNTAX_SUPPORTED.md).
Every block on this page executes in the test suite.)

## Gates: `when`, `while`, `by`

A statement can carry its own admission condition. The write is accepted,
visibly suspended, and promotes *by itself* when the state satisfies it:

```ft
pay = "go" when status = "created"
```

```
seq.get('pay')        → undefined     // suspended, not swallowed
-- later: status = "created" lands
seq.get('pay')        → "go"          // promoted, no caller involved
```

`while` is the dual — a lifetime, not an entry: the fact holds only
while the condition does, and `onBreak` names what to record when it
stops. `by` stamps provenance:

```ft
lease = "held" while pid EXISTS onBreak events.released = true
config = { mode: "safe" } by "admin"
```

Conditions speak the full predicate vocabulary — `EXISTS`, `=`, `!=`,
comparisons, and regex:

```ft
x = "go" when email MATCHES /@/
```

## Predicates: claims on a type's values

A `|` after a type states what must be true of its values — and the
store enforces it at admission, with the reason attached:

```ft
v = { email: string | email MATCHES /@/ }
a = { role: string | role IN { "admin", "member" } }
n = { retries: number | retries >= 2 }
```

```
v = { email: "no-at" }   → { ok: false, reason: "no match /@/" }
a = { role: "guest" }    → { ok: false, reason: "matches none of 2 branches" }
n = { retries: 1 }       → { ok: false, reason: "1 < min 2" }
```

## Δt and belief: temporal scope and reliability on a claim

A claim can carry *when it holds* — an interval anchored to function IO
times (`T_in`/`T_out`) — and *how much to believe it* as time passes, as
a survival curve. This is the part 3 machinery (decay, feasibility)
surfacing as inline syntax:

```ft
fs2 = { ok: boolean | ok = prev.ok @[T_out..T_out) ~survival(exp, 0.001) }
```

Read it as: this equality holds from the moment the output was produced,
with confidence decaying as an exponential with rate 0.001. The designed
full form scopes a write's effect until the next write invalidates it —
`@[T_out..next_write(p).T_out)` — the write/read identity clause. That
call-path left-hand side is the headline entry on the gap list: the
walker's identity and equation constraints are built and waiting; the
parse production isn't written yet.

## ∀ and ∈: the quantifier layer

The claim "for every session, if its heartbeat is fresh, it is alive" is
one statement. `index` introduces quantified variables over path
families (`over v in set.*` is ∀v ∈ set), `where` filters the tuples,
and the body fires per qualifying tuple with `{var}` substitution:

```ft
index _sessions.fresh {
  over user in sessions.*
  where sessions.{user}.heartbeat > _rt - 100
  sessions.{user}.status = "fresh"
}
```

```
sessions.alice.heartbeat = 950   (50ms old)  → sessions.alice.status = "fresh"
sessions.bob.heartbeat   = 800   (200ms old) → sessions.bob.status: not set
```

Multiple `over` bindings form tuple products (policy × user × subject) —
one declaration replacing an indexing service. The `_rt - 100` in the
`where` is the Δt stipulation doing real work: the claim is
time-conditioned, and the cascade re-evaluates it as the clock and the
heartbeats move.

## The honest state of this layer

The semantics for every clause above are implemented and enforced. The
*grammar* still has gaps against the April 2026 design — the recovered
design corpus itself now measures them: 98 of 113 spec files under
`specs/impl/` use syntax the parser doesn't accept yet, and
`PARSE_LEDGER.json` pins that list as a ratchet (a ledgered file that
*starts* parsing fails the suite until the progress is recorded). The
notable gaps: call-path LHS identity clauses, ordered `[ ]` blocks,
`forall` in property position, strict `>`/`<`. The list is in
[`SYNTAX_SUPPORTED.md`](../specs/impl/SYNTAX_SUPPORTED.md) — designed
vs implemented, kept distinct on purpose, so neither gets washed out by
the other again.
