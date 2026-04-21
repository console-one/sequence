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

## Problem Context

- **Actor(s)**: Prompt authors who create base templates, downstream users who fork and customize templates, agents that consume assembled prompts at runtime.
- **Domain**: Structured prompt templating for LLM-based systems where prompts are composed from reusable, typed segments.
- **Core Tension**: A base prompt template must be broadly reusable, but individual consumers need to add specificity to open slots without affecting other consumers. Every added constraint that introduces an unfilled slot must be tracked and surfaced at runtime.

## Requirements

**R1**: A prompt template SHALL be decomposable into an ordered sequence of segments, each classified as either concrete (has literal content) or open (has a declared type but no value).
- *Rationale*: Decomposition is the foundation for identifying what is fixed vs. what still needs to be filled.
- *Verifiable by*: A template string with interpolation points decomposes into the correct number of concrete and open segments.

**R2**: Open segments SHALL appear as unfilled slots that must be resolved before the prompt can be sent.
- *Rationale*: Sending a prompt with unresolved slots would produce malformed output.
- *Verifiable by*: Querying a template with open segments returns those segments as unfilled items.

**R3**: A user SHALL be able to fork a base template, producing an independent copy that can be customized without affecting the base or other forks.
- *Rationale*: Fork isolation ensures that one consumer's customizations never leak to another.
- *Verifiable by*: After forking and modifying a template, the base template's segments are unchanged; other consumers see the original.

**R4**: Refinement of an open slot SHALL be monotonic -- it can only add specificity (tighten the type, decompose into sub-segments), never widen the accepted range.
- *Rationale*: Monotonic refinement guarantees that a refined template is always a valid specialization of the base.
- *Verifiable by*: Attempting to widen an open slot's type beyond the base's declared type is rejected.

**R5**: Refinement of an open slot into multiple sub-segments SHALL be supported, where each sub-segment has its own type and optional token budget.
- *Rationale*: A single open "input" slot may need to become time, history, tools, and message -- each with independent constraints.
- *Verifiable by*: An open slot is replaced by N sub-segments, each with distinct names, types, and budgets.

**R6**: The system SHALL track template concreteness as a live metric -- the ratio of concrete to total segments, expressed as a percentage.
- *Rationale*: Concreteness tracking makes assembly progress visible: 100% means ready to send.
- *Verifiable by*: A template with 3 concrete and 2 open segments reports 60% concreteness; filling one open segment changes it to 75%.

**R7**: When a prompt with unfilled slots is used at runtime, those slots SHALL be surfaced to the user or calling system as actionable blockers with their types and constraints displayed.
- *Rationale*: Unfilled slots must be explicitly visible, not silently ignored.
- *Verifiable by*: Attempting to use a template with open segments surfaces each open segment with its name, type, and constraints.

**R8**: Each segment MAY have a token budget that constrains how much content can fill it.
- *Rationale*: Token budgets enable prompt authors to allocate context window space across segments.
- *Verifiable by*: A segment with a budget of 500 rejects content exceeding that budget.

## Acceptance Criteria

**AC1** [R1]: Given a prompt string `"Text ${string} Text"`, when decomposed, then three segments are produced: two concrete (the text fragments) and one open (the string slot).

**AC2** [R2]: Given a template with one open segment, when querying unfilled slots, then that segment is returned as an unfilled item.

**AC3** [R3]: Given a base template forked by a user, when the user refines an open slot in the fork, then the base template still shows the original unrefined slot.

**AC4** [R4, R5]: Given a fork of a base template, when the user refines the single open `input` slot into four sub-segments (time, history, tools, message), then the fork has four open segments with individual types and budgets; the base still has one open segment.

**AC5** [R6]: Given a template with 2 concrete and 4 open segments (concreteness 33%), when 2 open segments are filled, then concreteness updates to 67%.

**AC6** [R7]: Given a template with unfilled slots used at runtime, then each unfilled slot is surfaced as an actionable blocker showing its name, type, and constraints.

**AC7** [R8]: Given a segment with a budget of 500 tokens, when content of 600 tokens is provided, then the content is rejected or flagged as exceeding the budget.

## Open Questions

- How should the UI represent open slots in a rendered prompt document? The Original Notes suggest interactive "pills" but the precise UX is unresolved.
- When a refined sub-segment has a budget, should the sum of sub-segment budgets be constrained to equal the parent slot's budget (if any)?
