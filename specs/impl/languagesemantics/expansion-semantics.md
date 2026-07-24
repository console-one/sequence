# Expansion Semantics -- How `[[ ]]` Tokens Work

Expansion tokens are the DSL's mechanism for saying "there is more here." When the system renders state for a reader (an LLM, a terminal user, a UI pane), it cannot show everything. Paths that score below the rendering budget are replaced with `[[ token : signature ]]` markers. These markers are not lossy summaries -- they are live handles. A reader who sees `[[ evicted.config : 4 paths, 0 gaps, score=0.82 ]]` can request expansion of that token, and the system will re-render that subtree at full depth.

The key insight is round-trippability. The format a human writes is the format the system renders is the format the LLM reads. A human can write `[[ expand: budget tracking ]]` as a deliberate stub. The system can emit `[[ 1.2.3 : string ]]` as a compressed subtree. The LLM can respond with `[[ expand: need more context ]]` for parts it cannot resolve. All three are the same syntax, parsed the same way, mounted the same way.

## Token Format

An expansion token is delimited by `[[ ]]`. It contains either a bare description or a label-description pair separated by `:`. The label makes the token addressable -- something the reader can reference when requesting expansion:

```ft
-- Unlabeled: a stub the author knows is incomplete
x = [[ description of what goes here ]]

-- Labeled: addressable for targeted expansion
y = [[ config : application configuration block ]]
```

Both forms compile to obligations -- schemas without values. The labeled form additionally registers the label so the system can route expansion requests to the right path.

When the system's `hoist()` function renders state, it produces labeled tokens for any subtree it compresses. The label follows a hierarchical numbering scheme (e.g., `1.2.3`), and the description is the type signature of the compressed content:

```ft
-- System-generated expansion token for a compressed subtree
tasks = [[ 1.1.1 : { status: string, input: string } ]]

-- System-generated token with gap count metadata
inventory = [[ 1.1.2 : 3 paths, 1 gaps, score=0.82 ]]
```

## Requesting Expansion

Expansion is a read operation. The reader references a token's label or path and the system re-renders that subtree at full depth. In the generator channel, this happens naturally: the reader's response mentions the path, the system detects the interaction, and the next yield includes the expanded content.

The `hoist()` function takes an `expanded` set -- paths that override the depth limit. A token that was compressed at depth 2 can be selectively expanded while its siblings remain compressed:

```ft
-- At depth 2, tasks is compressed:
tasks = [[ 1.1.1 : { status: string, input: string } ]]

-- Reader requests expansion of tasks.
-- Next render with expanded = { "tasks" }:
tasks.t1.status = "running"
tasks.t1.input = "analyze quarterly data"
tasks.t2 = [[ 1.1.2 : { status: string, input: string } ]]
```

Expansion is additive. Marking a path for expansion never compresses something that was previously visible. The `expanded` set only grows during a session.

## Mounting Expanded Content Back

When the LLM or human fills in an expansion token, the response is parsed as regular ft syntax and mounted into the Sequence. The filled token becomes concrete state. The stub token was an obligation; the fill is the resolution:

```ft
-- Original stub in the spec
Budget = [[ expand: budget tracking with per-transaction limits ]]

-- LLM fills it in its response
Budget = {
  balance: number >= 0,
  limit: number >= 0,
  lastTx: string
}
```

The mount of `Budget` replaces the obligation with a concrete schema. If the LLM's response itself contains stubs, those become new obligations:

```ft
-- LLM partially fills the stub
Budget = {
  balance: number >= 0,
  limit: number >= 0,
  audit: [[ expand: audit trail for budget changes ]]
}
```

Now `Budget` has structure but `Budget.audit` is still a gap. The cycle continues: hoist renders it, another reader fills it, mount applies it.

## Tokens and the Hoist/Render System

The render pipeline is: cluster, score, rank, budget, hoist. Expansion tokens appear at the budget step. Clusters that score below the budget cutoff are emitted as tokens instead of full content. The token carries enough metadata (path count, gap count, score) for the reader to decide whether to request expansion:

```ft
-- Above budget: rendered in full
worker.status = "alive"
worker.heartbeat = 1712345678

-- Below budget: compressed to expansion token
config = [[ evicted.config : 4 paths, 0 gaps, score=0.82 ]]
metrics = [[ evicted.metrics : 12 paths, 2 gaps, score=0.31 ]]
```

Gaps inside compressed clusters are still surfaced separately. A token that hides a gap still reports that gap in the gaps section of the render output. The reader always knows what is unresolved, even if the surrounding context is compressed.

## Depth Limit and Expansion Threshold

The `maxDepth` parameter in the reader config determines how deep the renderer expands before compressing. At depth 1, only top-level keys show their values; everything deeper becomes a token. At depth 3, three levels of nesting are visible:

```ft
-- depth = 1: top-level only
tasks = [[ 1.1.1 : 6 paths, 0 gaps ]]
config = { model: "claude-3" }

-- depth = 3: three levels visible
tasks.t1.status = "running"
tasks.t1.input = "analyze data"
tasks.t2.status = "pending"
config.model = "claude-3"
config.maxTokens = 4000
```

The `maxItems` parameter caps the total number of paths in the output. Even if depth would show everything, the budget limit compresses low-scoring clusters. The combination of depth and budget means the reader gets a window sized to their attention, with handles to pull more.

## The Round-Trip

The full cycle shows why the format matters. One format serves four roles: human authoring, compiler input, rendered output, and LLM response:

```ft
-- 1. Human writes a spec with stubs
Shop = {
  pay: (ref: string) -> { ok: true } when status = "created",
  ship: [[ expand: shipping with tracking ]]
}

-- 2. Compiler mounts it. pay is concrete. ship is an obligation.

-- 3. Hoist renders for the LLM prompt.
--    pay appears as a function type. ship appears as an expansion token.

-- 4. LLM responds, filling the stub:
ship = (tracking: string) -> { ok: true } when status = "paid"

-- 5. Compiler mounts the response. ship is now concrete.
-- 6. Next hoist shows both pay and ship as function types.
```

The expansion token format is what makes this cycle work without translation layers. The LLM reads the same syntax it writes. The human reads the same syntax the system renders.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Expansion tokens are valid ft syntax | `[[ label : description ]]` parses, compiles to obligation |
| Labeled tokens are addressable for targeted expansion | `expanded` set in `hoist()` overrides depth limit per path |
| Expansion is additive -- never hides previously visible content | Adding to `expanded` set only reveals more, never less |
| Filled tokens mount as concrete state | `Budget = { balance: number >= 0 }` replaces the obligation |
| Partially filled responses create new obligations | LLM response with `[[ expand: ... ]]` becomes a new gap |
| Gaps in compressed clusters are still surfaced | Render output reports gaps regardless of compression |
| Depth limit controls token generation threshold | `maxDepth` parameter determines where compression starts |
| Budget limit compresses low-scoring clusters to tokens | `maxItems` cap converts below-cutoff clusters to `[[ ]]` tokens |
| Round-trip: write = hoist = prompt = compile | Same `[[ ]]` format used by human, renderer, LLM, and parser |
