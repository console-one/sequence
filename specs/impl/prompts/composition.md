# Prompt Composition

## Original Notes

Prompt composition model is interesting because a prompt can be written with a very general format, like take the example:

export " 
  This is a story lens system prompt.

  The users request is: ${string}

  Thanks.
"

Now, I know that this would never be implemented in practice, but let's assume for a second that that is the actual template of the function of the prompt. That can be converted into an array of three segment types:
1. Segment one is concrete with the initial text.
2. Segment two is just a general string.
3. Segment three is another piece of text.

Now we can make it such that, whenever we create an agent, we can give that agent a default prompt. We can then just say, when you are hoisted or an instance of you is created via the class that hoists you into the total system to run as part of the logic of the lattice, that's going to be your prompt. I want string to now actually extend this other type of string:


type promptinputextension = "
  The time is ${REAL_TIME}

  Your history of changes is : ${compress(./history[-1:-infinity]', string).maxLen(.maxlength ?? any)}

  Your tools are: ${./tools}
  
  Last user message is: ${string}
"

export " 
  This is a story lens system prompt.

  The users request is: ${string & promptinputextension}

  Thanks.
"

Now the mounting requirements of using this prompt would be wildly different, but I still would technically be building off of a pre-existing blueprint. We could have a screen that's showing the first system prompt and then looks like a narrative. Maybe there's a little, in some notion UI, that shows some markdown document, a little pill which is input string one in the first case. The user clicks it and they fork this document, and then they click on that string and they're like, "Yo, I'm gonna make this more specific." They're just layering another set of type constraints there, just totally legal and coherent, but within that layering they're going to start adding requirements which imply new hoisted constraints.

The changes that they're going to make are not going to be to all of the consumers of the original blueprint. Everything that they add that is not concrete or is not an outcome of something that is path-provided becomes something that now needs to be overridden on whatever tool call is invoking this. If that's not overridden, then whenever this prompt then gets mounted, it is going to be like a user gap to fill it out, which is good, actually, to fill out the missing component or whatever. However we render that gap might be contingent on circumstances, but we should have a good UI for assembling these prompts and identifying what's non-concrete and being able to add specificity in areas where it's not yet already constrained.

---

A prompt is not a flat string. It is a typed template -- an ordered sequence of segments where some are concrete (literal text) and some are open (typed gaps waiting for values). This decomposition lets users fork a template and add specificity to the open slots without touching the base template or affecting other consumers. Every non-concrete constraint added during customization becomes a new obligation that must be resolved at runtime.

The hard part is that refinement must be monotonic (you can only tighten types, never widen), fork isolation must be absolute (customizations never leak back), and the system must track completeness live -- how much of the template has literal values versus how much is still open. The UI renders this as a readable document with interactive pills for the open slots.

## The Prompt Template

A prompt template is a sequence of segments. Each segment is either concrete (has a literal value) or open (has a type but no value). Open segments are typed gaps -- they appear in the gap list and must be filled before the prompt is ready to send.

```ft
PromptSegment = {
  name: string,
  kind: "concrete" | "open",
  content?: string,
  type: string,
  budget?: number
}
```

A segment has a name for identification, a kind that says whether it has content, optional content for concrete segments, a declared type, and an optional token budget constraining how much content can fill it.

```ft
PromptTemplate = {
  segments: ref(PromptSegment),
  concreteness: number 0..100
}
```

The template holds references to its segments and tracks its own concreteness -- the ratio of concrete to total segments, expressed as a percentage.

## Segmented Decomposition

A prompt string like "Text ${string} Text" decomposes into three segments: two concrete, one open. The open segment appears as a gap.

```ft
baseTemplate = PromptTemplate
baseTemplate << {
  segments.prefix = PromptSegment
  segments.prefix << { name: "prefix", kind: "concrete", content: "This is a story lens system prompt.\n\nThe users request is: ", type: "string" }
  segments.input = PromptSegment
  segments.input << { name: "input", kind: "open", type: "string" }
  segments.suffix = PromptSegment
  segments.suffix << { name: "suffix", kind: "concrete", content: "\n\nThanks.", type: "string" }
}
```

The template has two concrete segments (prefix and suffix) and one open segment (input). Querying gaps on this template returns the input segment.

## Fork and Refinement

A user can fork the base template and add specificity to an open slot. The fork is independent -- changes do not affect the base or other consumers. Refinement replaces an open slot with sub-segments, each with their own type and budget.

```ft
userFork = PromptTemplate
userFork << {
  segments.prefix = ref(baseTemplate.segments.prefix)
  segments.suffix = ref(baseTemplate.segments.suffix)
}
```

The fork inherits the concrete segments from the base. The user then refines the open input slot into four sub-segments:

```ft
userFork << {
  segments.input_time = PromptSegment
  segments.input_time << { name: "time", kind: "open", type: "string", budget: 50 }
  segments.input_history = PromptSegment
  segments.input_history << { name: "history", kind: "open", type: "string", budget: 2000 }
  segments.input_tools = PromptSegment
  segments.input_tools << { name: "tools", kind: "open", type: "string", budget: 1500 }
  segments.input_message = PromptSegment
  segments.input_message << { name: "message", kind: "open", type: "string", budget: 500 }
}
```

The original single gap (input: string) is now four gaps, each with a budget. The base template still shows one gap. Other consumers of the base see the original.

## Concreteness Tracking

Concreteness is derived from the segment states. When segments are filled, concreteness increases.

```ft
-- concreteness = count(segments where kind = "concrete") / count(segments) * 100
-- A template with 3 concrete and 2 open segments reports 60%
-- A fully concrete template reports 100% and is ready to send
```

Concreteness is live -- it updates as segments are filled or refined. The ratio is computed from the current segment states, not stored independently.

## Runtime Gap Surfacing

When a prompt with unfilled gaps is mounted at runtime, those gaps surface as user-facing blockers. The user is prompted to fill them, with the type and constraints shown.

```ft
tool PromptTemplate.segments
tool PromptSegment.content
```

The segment list is a capability (inspectable), and each segment's content is a capability (fillable). Filling a segment's content changes its kind from open to concrete and updates the template's concreteness.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Three-segment decomposition | `baseTemplate` with prefix, input, suffix segments |
| Open segments appear as gaps | `segments.input` has `kind: "open"` with no content |
| Refinement into sub-segments | `userFork` replaces input with time, history, tools, message |
| Fork isolation | `userFork` is independent; `baseTemplate` unchanged |
| Concreteness tracking | Derived ratio of concrete to total segments |
| Budget per segment | Each refined segment has a `budget` value |
| Runtime gap surfacing | `cap PromptSegment.content` -- unfilled gaps are actionable |
