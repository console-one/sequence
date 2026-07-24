# Processor Preferences

When a task needs doing, something must decide who does it. Traditional systems use affinity rules, priority scores, and routing tables -- all of which go stale and require separate maintenance. The alternative: preference IS the type signature. A process declares what it can do as a typed function (input -> output). Matching a task to a process is type composition -- can the process's output satisfy the task's requirement? Preference ranking is concreteness -- a process that produces exactly `{summary, wordCount}` is a better match for a summary requirement than one that produces generic text.

There is no preference configuration. There is no dispatcher. There is only type composition and concreteness comparison.

## The Capability Type

A process declares its capability as a function type. The input type says what it needs; the output type says what it produces:

```ft
Capability = {
  name: string,
  process: string,
  handler: (input: ref(capInput)) -> { output: ref(capOutput) }
}
```

The function signature IS the preference. A summarizer that takes `{text, format}` and produces `{summary, wordCount}` is declaring exactly what tasks it can serve. No separate preference config, no affinity rules.

## Registering Capabilities

Each process registers its capabilities by writing them into the shared state:

```ft
summarizer = Capability
summarizer << {
  name: "summarize",
  process: "proc-1",
  handler: (input: ref(capInput)) -> { output: ref(capOutput) }
}
```

```ft
translator = Capability
translator << {
  name: "translate",
  process: "proc-2",
  handler: (input: ref(capInput)) -> { output: ref(capOutput) }
}
```

Both capabilities are now visible. The system can search them by output type compatibility.

## Matching by Output Type

When a task has an output requirement, the system finds capabilities whose output type composes with that requirement. Composition is structural -- the capability's output must be a subtype of (or equal to) the requirement:

```ft
taskRequirement = {
  summary: string,
  wordCount: number
}
```

The summarizer's output `{summary, wordCount}` composes with this requirement. The translator's output does not -- it produces translated text, not summaries. The translator scores zero and is excluded from results.

## Preference as Concreteness

When multiple capabilities match, they are ranked by specificity. A capability whose output exactly matches the requirement ranks higher than one whose output is a supertype (more general). Concreteness comparison is structural: more fields satisfied, narrower types, fewer gaps in the match all increase the rank.

This ranking emerges from type comparison. No priority scores, no weighted routing rules. The most specific match wins.

## Auto-Assignment

When exactly one capability matches a task's requirement, the assignment is automatic. No dispatcher decision needed -- there is only one candidate:

```ft
cap Capability.handler
```

The task is schedulable to the sole matching capability without external coordination. When multiple capabilities match, the system surfaces the ranked list as a gap requiring selection.

## Backward Inference

Knowing a capability exists is not enough. The system must also determine whether the capability can execute right now -- whether its required input is currently available:

```ft
summarizer << {
  handler: (input: ref(capInput)) -> { output: ref(capOutput) }
}
```

Backward inference checks the capability's input requirement against available state. If `{text, format}` is required and only `{text}` is available, then `format` surfaces as a gap. The capability is matched but not yet executable -- it needs more input.

## Capability Chains

When no single capability satisfies a requirement, the system can discover multi-step chains. If the requirement needs translated summaries and no single capability produces that, but a translator produces translated text and a summarizer takes text and produces summaries, the chain is discoverable through type composition: translator's output composes with summarizer's input, and summarizer's output satisfies the requirement.

Chain discovery is bounded -- the system searches to a configurable depth to avoid combinatorial explosion.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Capability has typed input/output | `Capability` type with function handler |
| Search finds matching capabilities | Output type composition against `taskRequirement` |
| Ranking by specificity | Concreteness comparison of output type match |
| Auto-assignment for single match | `cap Capability.handler` -- sole match is schedulable |
| Backward inference of input availability | Input requirement checked against available state; gaps surfaced |
| Missing input surfaces as gap | `format` reported as gap when only `text` is available |
| Incompatible capability excluded | Translator scores zero against summary requirement |
| Multi-step chains discoverable | Translator output composes with summarizer input |
