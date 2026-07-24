# App Layer Semantics -- What an Environment Definition Looks Like

The Environment interface is how the Sequence connects to the outside world. A Sequence handles state, laws, compression, and gap detection. But it needs a clock, persistence, and capability implementations from somewhere. The Environment provides exactly four things: `clock()` for time, `loadSnapshot()` for restoring prior state, `saveSnapshot()` for persisting current state, and `mountCapabilities()` for registering external implementations. Nothing else crosses the boundary.

The boot sequence is mechanical: create a Sequence, load a snapshot if one exists, mount capabilities, and return a generator channel. The channel IS the process loop -- every `yield` is a re-hoist of the current state (scored, ranked, budgeted), and every `resume` is an incoming ft block parsed and mounted. The loop runs until the generator is closed.

## The Environment Interface

The Environment is a four-method contract. Each method maps to one concern:

```ft
Environment = {
  clock: () -> { time: number },
  loadSnapshot: () -> { entries: string | null },
  saveSnapshot: (projection: string, seq: number >= 0) -> { ok: true },
  mountCapabilities: (mount: string) -> { ok: true }
}
```

`clock()` returns the current time. The Sequence stores this at `_rt` on every mount, enabling temporal conditions (`while _rt < deadline`). Different environments provide different clocks: `Date.now()` for production, a manual counter for tests, a simulated clock for replay.

`loadSnapshot()` returns the previously saved state as mount entries, or null for a fresh start. The Sequence replays these entries to restore its projection to the saved state.

`saveSnapshot()` persists the current projection and sequence number. The kernel calls this periodically (every 100 mounts by default). The snapshot is the recovery point.

`mountCapabilities()` receives the Sequence's `mount` function and uses it to register schemas and capability markers for external tools. This is where file system access, LLM calls, database connections, and other external capabilities enter the Sequence.

## The Boot Sequence

Boot creates a Sequence, loads prior state, mounts capabilities, and returns the channel. The reader configuration is also mounted as Sequence state so it persists and is narrowable:

```ft
-- Boot: create Sequence with the environment's clock
-- seq = new Sequence(env.clock)

-- Load snapshot if available
-- snapshot = env.loadSnapshot()
-- if snapshot: mount each entry into seq

-- Mount capabilities from the environment
-- env.mountCapabilities(seq.mount)

-- Mount reader config as Sequence state
_reader.maxItems = 50
_reader.maxDepth = 3
_reader.weights = { actionability: 0.25, cascadeImpact: 0.25, urgency: 0.20, coherence: 0.15, learnedBoost: 0.15 }
```

After boot, the Sequence has: restored state (from snapshot), capability schemas and markers (from environment), and reader configuration (from boot parameters). The channel generator starts.

## The Process Loop -- Yield and Resume

The generator channel is a `while(true)` loop with two phases: yield (hoist) and resume (parse + mount). The yield sends the current state view to the reader. The resume receives the reader's response and applies it:

```ft
-- The channel loop:
-- 1. RENDER: score → rank → budget → hoist
--    Output: ft text with expansion tokens for evicted clusters

-- 2. YIELD: send the rendered text to the reader (LLM, terminal, UI)
--    The yield IS the scheduler output

-- 3. RESUME: receive incoming ft text from the reader
--    Parse the text into AST, walk it to produce mount entries

-- 4. MOUNT: apply the parsed entries to the Sequence
--    cascade → enforce → rescore → evict/promote

-- 5. SNAPSHOT: periodically save (every 100 mounts)

-- 6. GOTO 1
```

The generator pattern means the Sequence never runs on its own. It always waits for input. The environment drives the loop by calling `.next(input)` on the generator. Between yields, the Sequence is inert.

## Capability Registration

Capabilities are registered during `mountCapabilities`. The environment provides schemas and `cap` markers for each external tool. The schema defines the contract (input/output types). The cap marker tells the Sequence that an implementation exists:

```ft
-- Environment mounts file system capabilities:
fs.read = (path: string) -> { content: string, size: number >= 0 }
fs.write = (path: string, content: string) -> { ok: true }
tool fs.read
tool fs.write

-- Environment mounts LLM capability:
llm.complete = (prompt: string) -> { text: string }
tool llm.complete
```

When the Sequence encounters a gap that a registered capability can resolve, it produces a `PendingInvocation` in the mount result. The environment executes the invocation and mounts the result back:

```ft
-- Sequence detects gap at "report.content" (needs string)
-- Backward inference finds llm.complete can produce string
-- MountResult.pendingInvocations = [{ capId: "llm.complete", args: [...] }]
-- Environment executes the LLM call
-- Environment mounts the result: report.content = "The quarterly..."
```

## Environment and Sequence Relationship

The Sequence owns all state logic: schemas, values, gaps, suspension, resumption, compression, scoring. The Environment owns all external interactions: time, persistence, and capability implementations. The boundary is clean:

```ft
-- What the Sequence does:
-- mount(), get(), typeAt(), keys(), getAt(), getPrevious()
-- fireLaws(), rescoreWorkingSet(), compact()
-- gaps(), concreteness(), backwardInfer()

-- What the Environment does:
-- clock(), loadSnapshot(), saveSnapshot(), mountCapabilities()
-- Execute PendingInvocations from MountResult
-- Drive the generator loop via .next(input)
```

The Sequence never calls external services directly. It declares what it needs (gaps, pending invocations) and the Environment fulfills those needs by mounting results. This separation means the same Sequence logic works in any environment -- Node.js, browser, test harness, CLI.

## Learned Priors -- Updating from Interaction

The generator channel tracks what the reader interacted with. If the incoming ft text references paths from a cluster that was shown, that cluster's learned prior gets a success update. Clusters that were shown but not interacted with get a weaker failure signal. These priors feed back into the scoring weights for the next render cycle:

```ft
-- Reader config includes learned priors:
_reader.weights.learnedBoost = 0.15

-- After each interaction:
-- Paths mentioned in incoming text → alpha += 1 (success)
-- Paths shown but not mentioned → beta += 0.1 (weak failure)
-- The posterior P = alpha / (alpha + beta) boosts future scores
```

This is how the system learns which clusters the reader cares about. Over multiple interactions, clusters the reader consistently ignores drift toward compression. Clusters the reader consistently engages with stay in the rendering window.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Environment provides exactly four methods | `clock`, `loadSnapshot`, `saveSnapshot`, `mountCapabilities` |
| Boot loads snapshot and restores state | Snapshot entries replayed into fresh Sequence |
| Boot mounts capabilities from environment | `env.mountCapabilities(seq.mount)` registers schemas and cap markers |
| Generator channel yields rendered state | `yield lastRender.text` sends scored/budgeted ft text |
| Generator channel receives and mounts input | Incoming text parsed, walked, mounted into Sequence |
| Periodic snapshot persistence | `saveSnapshot` called every 100 mounts |
| Pending invocations cross the Environment boundary | `MountResult.pendingInvocations` lists capability calls for Environment to execute |
| Learned priors update from reader interaction | Success/failure signals adjust cluster scoring weights over time |
| Same Sequence works in any environment | Sequence never calls external services; Environment fulfills all external needs |
