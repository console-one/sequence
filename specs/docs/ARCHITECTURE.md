# Architecture: Sequence as Universal Temporal Orchestrator

## The Core Realization

The Sequence is not a data structure. It is the universal processor. Every environment — browser, Electron, Lambda, CLI, LLM, database, filesystem — mounts itself onto a Sequence by registering capabilities. Interaction between all layers happens through one protocol: ft text with expansion tokens.

```
Environment mounts capabilities onto Sequence
  → Sequence tracks obligations, gaps, concreteness
  → Sequence emits ft text (hoists) with expansion tokens targeted per receiver
  → Receiver fills tokens, sends ft text back
  → Sequence mounts the response
  → Repeat until fully concrete
```

There is no separate chat service, tool service, connector service, agent service, or IPC layer. There are Sequences and channels between them. Every service is a set of capabilities mounted onto a Sequence. Every interaction is ft text flowing through a channel.

---

## Environments Mount Themselves

Each environment registers what it can do. The Sequence doesn't know what an "LLM" or a "filesystem" is. It knows: there are capabilities at paths, with typed input/output, and it can request their invocation via expansion tokens.

```ft
-- Browser environment mounts itself
browser.capabilities << {
  render: (html: string) -> { displayed: true },
  userInput: (prompt: string) -> { response: string },
  localStorage: (key: string) -> { value: string }
}
cap browser.capabilities.render
cap browser.capabilities.userInput
cap browser.capabilities.localStorage

-- Lambda environment mounts itself
lambda.capabilities << {
  compute: (fn: string, input: _) -> { output: _ },
  timeout: number = 300000
}
cap lambda.capabilities.compute

-- LLM environment mounts itself
llm.capabilities << {
  complete: (prompt: string, system?: string) -> { text: string, tokens: number }
}
cap llm.capabilities.complete

-- Filesystem environment mounts itself
fs.capabilities << {
  read: (path: string /^[/]/) -> { content: string },
  write: (path: string /^[/]/, content: string) -> { ok: true }
}
cap fs.capabilities.read
cap fs.capabilities.write
```

Each environment is just capabilities at paths. The Sequence doesn't care where they run — local process, remote Lambda, cloud API. It cares about the types: what input they need, what output they produce, how long they take (~distribution), and what behavioral commitments they make (refinement predicates).

---

## Channels

A channel connects two Sequences (or a Sequence and an external system). The channel:
1. Receives ft text from the sender
2. Parses it
3. Mounts it into the receiver's Sequence
4. Hoists the receiver's response as ft text
5. Sends it back

```
Sequence A                    Channel                    Sequence B
    │                            │                            │
    ├── emit ft text ──────────► │                            │
    │                            ├── parse + mount ─────────► │
    │                            │                            ├── process
    │                            │ ◄── hoist ft text ─────── │
    │ ◄── parse + mount ──────── │                            │
    │                            │                            │
```

The channel is thin. It's just parse + mount in each direction. The Sequences do all the work. The ft text is the only thing that crosses the boundary.

---

## What Each Layer Becomes

### Chat = ft channel between user and agent Sequence

The user types a message. The chat UI wraps it as ft text and sends it to the agent Sequence. The agent Sequence mounts it, processes (cascade, search, capability invocation), and hoists a response as ft text with expansion tokens. The chat UI renders the ft text — concrete values as text, expansion tokens as interactive elements (buttons, input fields, approval prompts).

```ft
-- User sends:
user.message = "Summarize the Q4 report"

-- Agent Sequence responds:
-- @source: agent, step 1
-- @capabilities: fs.read, llm.complete
agent.response = "I'll summarize the Q4 report. First I need to read it."
[[ agent.action : reading /reports/q4.md — confirm? ]]
```

The `[[ agent.action ]]` expansion token becomes a button in the UI: "Confirm: read /reports/q4.md". The user clicks it. The UI sends ft text back: `agent.action = "confirmed"`. The cycle continues.

### Tools = capabilities mounted on the Sequence

A tool isn't a separate service. It's capabilities at paths. When the Sequence needs something (backward inference identifies a gap that a capability can fill), it emits an expansion token. The environment that registered the capability fills it.

```ft
-- Sequence determines it needs file content
[[ fs.result : read /reports/q4.md ]]

-- Filesystem environment fills it
fs.result = { content: "Q4 revenue was...", size: 2048 }
```

### IPC = ft channel between Electron main and renderer

The headBridge is a channel. Main Sequence hoists state as ft text. Renderer parses and projects. User actions in the renderer emit ft text back. Main Sequence mounts them.

### Agent Loop = capability invocation cycle

The agent runner is not special code. It's a loop:
1. Hoist the current state as ft text with expansion tokens
2. Send to the LLM
3. Parse the LLM's ft response
4. Mount it
5. If new expansion tokens → repeat

### Persistence = ft text on disk

Save: hoist the Sequence's projection as ft text, write to file.
Load: read file, parse ft text, mount into a new Sequence.

### Distributed = ft channels between Sequences on different machines

Orchestrator Sequence hoists a task as ft text with expansion tokens. Sends to worker Sequence via network channel. Worker mounts, processes, hoists response. Sends back. Orchestrator mounts the result.

---

## The Protocol

Every interaction follows one pattern:

```
1. Sender emits ft text
     - Concrete values (what IS known)
     - Comments (narrative context)
     - Expansion tokens (what the sender NEEDS)

2. Receiver parses and mounts
     - Concrete values update state
     - Expansion tokens become obligations

3. Receiver processes
     - Cascade (derived values recompute)
     - Search (backward inference finds capabilities for gaps)
     - Capability invocation (or delegation to sub-channels)

4. Receiver emits ft text response
     - Results (what was computed/filled)
     - New expansion tokens (what the receiver needs from the sender)
     - Comments (qualifying context)

5. Repeat until both sides are fully concrete (no expansion tokens remain)
```

The expansion tokens are the continuation. They carry the backward-inferred obligations, filtered by the receiver's registered capabilities. Each receiver only sees tokens for gaps it can fill.

---

## What the Sequence Provides

The Sequence is the universal temporal orchestrator because it handles:

| Concern | How |
|---------|-----|
| State | Append-only block log with derived projection |
| Obligations | Schemas without values → gaps() |
| Discovery | Capability matching via compose(gap_type, capability_output) |
| Scheduling | Concreteness priority × conjunction flow × temporal constraints |
| Coordination | Suspension (when gates), invalidation (while gates), resumption (cascade) |
| Time | fn.T_in / fn.T_out boundaries, ~distribution for execution time |
| Probability | Survival functions over temporal intervals |
| Validation | compose(spec, impl) at mount time |
| Audit | Every block carries author, timestamp, entries (append-only) |
| Communication | ft text in, ft text out — one protocol for all layers |

Environments don't implement these. They mount capabilities and interact through ft text. The Sequence handles everything else.

---

## Hoist as View: Diff, Gaps, and Downstream Context

Hoist is not "serialize the whole Sequence." It is a receiver-specific VIEW:

### Diff Against Prior State

The receiver declares retention: "I have state up to block seq N." The hoister diffs against that and emits only changes since N. Full hoist uses `=` (overwrite). Diff hoist uses `<<` (delta). A fresh receiver gets `=`. A receiver with prior state gets `<<`.

```ft
-- Full hoist (fresh receiver):
config.host = "localhost"
config.port = 5432

-- Diff hoist (receiver has state through block 42):
config.port << 8080
-- host unchanged — not emitted
```

### Gaps Are the API Surface

The view's gaps are filtered by the receiver's capabilities — only gaps this receiver CAN fill. Each gap carries downstream context from backward inference:

```ft
[[ config.port : number 1..65535 ]]
-- enables: connect(host, port) -> { connected: true }
-- unblocks: 3 downstream operations (query, insert, healthcheck)
-- priority: 0.92
```

The expansion token + qualifying comments form a complete targeted prompt. The receiver sees: the gap, the type constraint, what filling it enables, and how important it is. This is prompt engineering driven by the Sequence's conjunction tracking and backward inference.

### The View Is Shaped Per Receiver

```
gapsFor(receiverCapabilities) → [
  { path, type, priority, enables: [downstream paths], unblocks: count }
]
```

An LLM receiver sees gaps it can fill with text generation. A filesystem receiver sees gaps it can fill by reading files. A human sees gaps they can fill by providing configuration. Same Sequence, different views, different expansion tokens.

### Hoist = Backward Inference Made Visible

The qualifying comments on each gap are not manually written. They are DERIVED from the Sequence's state:
- `depIndex` → what depends on this gap
- `conjIndex` → which conjunctions this gap participates in
- `search()` → what plan steps filling this gap unblocks
- `gaps().priority` → how important this gap is relative to others
- `backwardInfer()` → what input the receiver needs to provide

The Sequence's intelligence (conjunction tracking, gap priority, capability matching, search) materializes AS the hoist output.

---

## The Generator IS the Channel

The foundational model — `yield [view, gaps], receive blocks` — IS the channel adapter:

```typescript
function* channel(seq: Sequence): Generator<string, void, string> {
  let view = hoist(seq).text;
  while (true) {
    const incoming = yield view;    // emit ft text, receive ft text
    receive(incoming, seq);         // mount the response
    view = hoist(seq).text;         // re-hoist
  }
}
```

yield = emit (hoist). resume = receive (parse + mount). Lazy read = hoist only runs when someone pulls. Every process loop is this pattern with a different input source:

```typescript
// Agent: LLM fills expansion tokens
const agent = channel(seq);
let prompt = agent.next().value;
while (hasGaps(prompt)) {
  const response = await llm(prompt);
  prompt = agent.next(response).value;
}

// CLI: user fills expansion tokens
const cli = channel(seq);
let display = cli.next().value;
while (true) {
  console.log(display);
  const input = await readline();
  display = cli.next(input).value;
}

// IPC: two generators connected by transport
const main = channel(mainSeq);
const renderer = channel(rendererSeq);
```

The Sequence doesn't change. The generator wraps mount + hoist as yield + resume.

---

## What Doesn't Change

The Sequence code (sequence.ts) is already built. 223 tests pass. The capabilities are:
- mount() — the single write operation
- get() / typeAt() — reads
- gaps() / obligations() — what's missing
- search() — backward inference through capability graph
- concreteness() / feasibility() — probability assessment
- compact() — history management
- projection — the current state (serializable)

Nothing needs to change in the kernel. Environments mount capabilities via the existing `cap` operation. The ft format is the view layer (parse on input, hoist on output). Channels are just parse + mount in each direction.
