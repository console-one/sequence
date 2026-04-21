# Supported ft Syntax (what the parser handles)

When writing ft blocks in impl/ files, use ONLY this syntax. The validation test
(`validate-impl.test.ts`) will catch anything that doesn't parse.

## Statements
```ft
x = expr                              -- assign (overwrite)
x << expr                             -- narrow (compose)
delete x                              -- remove
cap path                              -- register capability
cap path when cond                    -- conditional capability
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

## NOT YET SUPPORTED (parser will reject these)
- `[ ]` block syntax with `key = value` entries (use `{ }` instead)
- Complex predicate expressions like `| size = byteLength(content)`
- Refinement predicates with `@[T_out..)` temporal scope
- `forall` in predicates
- `~distribution()` on functions
- Parenthesized arithmetic in predicates

These will be added. For now, express behavioral predicates in prose comments
and structural types in ft blocks.
