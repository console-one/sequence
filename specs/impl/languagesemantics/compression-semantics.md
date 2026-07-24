# Compression Semantics -- What Gets Shown When State Is Compressed

When the Sequence holds more state than a reader can absorb, the render pipeline decides what to show and what to compress. Compression replaces a subtree's values with an expansion token that carries the subtree's type signature. The values are evicted from the rendering window, not from the Sequence -- they are always recoverable on demand. This is distinct from compaction, which collapses old log entries permanently. Compression is about the working set (what the reader sees right now). Compaction is about history (how many log entries the Sequence retains).

The hard part is deciding what to evict. The answer is scoring: every path gets a composite score from signals (gap proximity, dependency betweenness, concreteness, temporal urgency, learned priors). Paths below the budget cutoff are evicted. Schemas and behavioral predicates survive eviction -- only values are removed from the rendering window. The evicted subtree becomes an expansion token that preserves its type signature, so the reader knows what was there and can request it back.

## The Compressed Representation

When a cluster scores below the rendering budget, its content is replaced by an expansion token. The token contains the cluster's ID, its path count, its gap count, and its score. This gives the reader enough information to decide whether expansion is worthwhile:

```ft
-- Full rendering (above budget):
worker.status = "alive"
worker.heartbeat = 1712345678
worker.task = "job-42"

-- Compressed rendering (below budget):
worker = [[ evicted.worker : 3 paths, 0 gaps, score=0.45 ]]
```

The token's description is the type signature of the evicted content. If the cluster has a schema, that schema appears. If it has concrete values, the description summarizes the structure. The reader sees "there is a worker with 3 paths and no gaps" without seeing the actual values.

## Eviction Scoring -- The `rescoreWorkingSet` Pattern

After every mount, the Sequence rescores all paths against the rendering budget. The budget is set by `_reader.maxItems` in the Sequence's own state. Scoring uses multiple signals combined with configurable weights:

```ft
-- Reader configuration (mounted as Sequence state)
_reader.maxItems = 50
_reader.maxDepth = 3
_reader.weights = {
  actionability: 0.25,
  cascadeImpact: 0.25,
  urgency: 0.20,
  coherence: 0.15,
  learnedBoost: 0.15
}
```

The scoring algorithm walks backward from the top gaps. Paths on a gap resolution path (needed as inputs to capabilities that would resolve a gap) score highest. Paths with high dependency betweenness (many things depend on them, or they depend on many things) score next. Paths with low concreteness and no connections score lowest and are evicted first.

```ft
-- Scoring signals for a path:
-- onGapPath: +2 if this path is needed to resolve a top-10 gap
-- concreteness: [0,1] from the Sequence's concreteness function
-- betweenness: 1 + forward deps + reverse deps
-- score = (onGapPath ? 2 : 0) + concreteness * betweenness
```

Paths are sorted by score descending. The top `maxItems` paths survive. Everything below the cutoff is evicted and replaced with expansion tokens in the next render.

## What Survives Compression

Eviction removes values from the rendering window. It does not remove schemas, capability registrations, or behavioral predicates. These structural declarations survive because they constrain what the reader can do -- they define the interface, not the current state:

```ft
-- Before eviction:
config.model = "claude-3"
config.maxTokens = 4000
cap config.apply

-- After eviction (config cluster below budget):
config = [[ evicted.config : { model: string, maxTokens: number }, 1 cap ]]
-- The schema { model: string, maxTokens: number } survives in the token's signature.
-- The capability registration survives and is still discoverable.
-- The VALUES "claude-3" and 4000 are not shown, but are recoverable via expansion.
```

Gaps also survive compression. If a compressed cluster contains an unresolved obligation, that gap appears in the render output's gap section regardless of whether its parent cluster was evicted. The reader always sees what needs to be done, even if they cannot see the surrounding context without expanding.

## Restoring Compressed State on Demand

Compressed state is restored by adding the evicted cluster's paths to the `expanded` set and re-rendering. The values were never removed from the Sequence -- only from the rendering window. Expansion simply re-includes them:

```ft
-- Compressed:
metrics = [[ evicted.metrics : 12 paths, 2 gaps, score=0.31 ]]

-- Reader requests expansion. Next render includes metrics paths:
metrics.requestCount = 1547
metrics.errorRate = 0.03
metrics.p99Latency = 230
metrics.throughput = [[ expand: throughput tracking details ]]
-- The two gaps (one was throughput, the other elsewhere) are now visible in context.
```

The MountResult from every mount reports `evicted` and `promoted` arrays. Evicted paths were pushed out of the working set. Promoted paths were pulled back in (because a mount changed their score -- e.g., a new gap made them relevant):

```ft
-- Mount result after writing a new gap that references metrics:
-- evicted: ["oldCluster.path1", "oldCluster.path2"]
-- promoted: ["metrics.errorRate", "metrics.p99Latency"]
-- The metrics paths were promoted because the new gap needs them.
```

## Compaction vs Compression

These are separate concerns that operate on different dimensions:

**Compression** operates on the working set -- the reader's current view. It is reversible. Evicted values are still in the Sequence and can be expanded on demand. Compression happens every render cycle via `rescoreWorkingSet`.

**Compaction** operates on history -- the append-only block log. It is permanent. Old blocks before the compaction boundary are collapsed into snapshots. Compaction happens periodically via `compact(beforeSeq)`:

```ft
-- Compaction: collapse old log entries
-- Before: 500 blocks in the log
-- compact(400): blocks 0-399 collapsed to per-path snapshots
-- After: ~50 snapshot entries + 100 recent blocks

-- Compression: evict from rendering window
-- Before: 200 paths visible
-- After rescore with maxItems=50: 50 paths shown, 150 as expansion tokens
-- All 200 paths still exist in the Sequence
```

Compaction respects policies: `preserve` paths are never compacted (audit trails). Numeric policies keep every Nth block (historical sampling). Suspended blocks survive compaction because they may resume later. These are structural rules about log retention, not rendering decisions.

Compression respects scores: high-scoring paths stay visible, low-scoring paths become tokens. There is no "preserve" for compression -- the score is the only criterion. But schemas always survive in the token's type signature, ensuring the reader knows the shape of what was evicted.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Evicted clusters become expansion tokens with type signatures | `worker = [[ evicted.worker : 3 paths, 0 gaps, score=0.45 ]]` |
| Scoring uses gap proximity, betweenness, concreteness | `score = (onGapPath ? 2 : 0) + concreteness * betweenness` pattern |
| Schemas survive eviction in the token description | Token carries `{ model: string, maxTokens: number }` after values evicted |
| Gaps surface regardless of compression | Unresolved obligations appear in gaps section even when parent is evicted |
| Compressed state is recoverable via expansion | Adding paths to `expanded` set re-renders them at full depth |
| MountResult reports evicted and promoted paths | `evicted` and `promoted` arrays track working set changes per mount |
| Compaction is permanent; compression is reversible | `compact()` collapses log entries; `rescoreWorkingSet` only hides from rendering |
| Budget is configurable via Sequence state | `_reader.maxItems` and `_reader.weights` mounted as narrowable state |
