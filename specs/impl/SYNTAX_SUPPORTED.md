# Supported ft Syntax (what the parser handles)

When writing ft blocks in impl/ files, use ONLY this syntax. The validation test
(`validate-impl.test.ts`) will catch anything that doesn't parse.

## Statements
```ft
x = expr                              -- assign (overwrite)
x << expr                             -- narrow (compose)
delete x                              -- remove
tool path                              -- register capability
tool path when cond                    -- conditional capability
policy path: { key: "value" }         -- policy mount
import name from "./path"             -- import
export expr                           -- export (in blocks)
-- comment text                       -- narrative comment (preserved)
```

## Types (right side of = or <<)
```ft
string                                -- primitives
string /^pattern$/                    -- pattern-constrained
string /^pattern$/, 1..255            -- pattern + length
number                                -- number
number >= 0                           -- bounded
number 0..100                         -- range
number.integer >= 0                   -- integer
boolean
null
"literal"                             -- string literal
42                                    -- number literal
true / false                          -- boolean literal
```

## Objects (use { } with key: type pairs)
```ft
{ name: string, age?: number }
{ host: "localhost", port: 5432 }     -- concrete values
```

## Functions
```ft
(path: string) -> { content: string, size: number }
```

## Unions and Intersections
```ft
"active" | "inactive"                 -- union
A & B                                 -- intersection
```

## Modifiers
```ft
x = "ready" when auth EXISTS          -- when: entry gate
x = "alive" while heartbeat EXISTS    -- while: lifetime gate
x = config by "admin"                 -- by: provenance
```

## Conditions (in when/while)
```ft
path EXISTS                           -- value exists
path = "value"                        -- equality
path != "value"                       -- inequality
path < 100                            -- comparison
path MATCHES /pattern/                -- regex
```

## Blocks (use { } with = statements inside)
```ft
x = {
  import a from "./path"
  b = number
  export a & b
}
```

## Expansion tokens
```ft
x = [[ label : description ]]        -- gap/stub
x = [[ description ]]                -- unlabeled gap
```

## Prev
```ft
x = prev                             -- whole previous value
x = prev.count                       -- specific field
```

## Ref
```ft
x = ref(y)                           -- live reference
```

## STATUS 2026-07-24 (verified against the live parser+walker, replaces the list below)

Landed since April (each enforced, covered by src/test/dsl-clauses.test.ts):
- Refinement predicates with builtins: `| size = byteLength(content)`
- Temporal (Δt) interval scope on predicates: `| ok = prev.ok @[T_out..T_out)`
- Reliability suffix: `~survival(exp, 0.001)` (positional form maps exp → exponential) and `~lognormal(mu=…, sigma=…)` on functions
- `| path MATCHES /re/` (was a token-kind bug: keyword vs IDENT — could never parse)
- `| path IN { "a", "b" }` set literals (compile to a literal union the checker enforces)
- `| path >= n` / `| path <= n` (compile to min/max on the property type)
- `when path = "value"` equality gates at statement level (suspend → auto-promote)
- `while … onBreak …` lifetime gates · `by` provenance · `&` composition
- The quantifier layer as text: `index <anchor> { over v in set.* where <cond> <body> }` — ∀/∈ with `{var}` tuple interpolation
- Call-result paths on predicate LHS: `| read(p).content = content @[T_out..next_write(p).T_out) ~survival(exp, 0.001)` — THE write/read identity clause, spec verbatim (identity + temporal equation constraints bind)
- Refinements after literal-typed properties (union-vs-predicate disambiguated by bounded lookahead; literal unions unbroken)
- Property-level gates: `task: string while alive = true onBreak events.taskExpired = true` and `<< { status: "approved" when currentApprovals = 2 }` — LOWERED to statement gates (one semantics); gate conditions resolve lexically against the parent object's declared siblings
- `forall c : set . <comparison>` parses in refinement position (set = ident or call; NOTE: stored as a constraint for the runtime layer — NOT enforced at admission yet)
- The recovered spec corpus itself: `cap` → `tool` applied (completing the 5ef53e9 rename); PARSE_LEDGER 98 → 14 (2026-07-24; the 14 survivors are design-gated: derived predicates with computed exprs, reader-scoped conditions, converter meta-shapes)

## STILL NOT SUPPORTED (the honest gap list — see PARSE_LEDGER.json for the 98 spec files these block)
- `[ ]` ordered-block syntax with `key = value` entries, docs strings, and `ref("path")` rows
- Derived predicates with parenthesized comparison exprs: `alive: boolean | alive = (prev.heartbeat > _rt - prev.livenessWindow)` (needs expression-valued equations + cascade recompute — design work, not a parse patch)
- `forall` ADMISSION enforcement (parses; constraint stored, not checked at bind time)
- Strict `>` `<` and `!=` in refinements (only exact-semantics >= / <= are mapped; strict bounds need a checker decision)
- `HAS` / `SATISFIES` predicate semantics (parse, but no verified constraint mapping)
- Negative number literals (`-1` does not tokenize as a literal)
- `cap` (renamed: use `tool`)

Progress is a RATCHET: `src/test/validate-impl.test.ts` fails if a ledgered
spec file starts parsing, until it is struck from PARSE_LEDGER.json.

