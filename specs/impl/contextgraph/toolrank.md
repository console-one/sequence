# Tool Rank

## Original Notes

We can obtain some notion of a tool rank based off of looking at all the times a particular tool was shown on a client interface. Either as a button that could be pressed and expanded, or as a tool with particular type input specifications that were not materialized concretely by the next user action or the next optimizer action, because we're using the sort of compression frame-based model. Any time that we're showing what we have in some UI to a user, we're showing a set of services or APIs or something that is not going to be necessarily static to the next user that comes with a request to show gaps. It's actually a good thing.

We could consider that every time we show a particular tool in a particular case, or even a particular narrative to a particular agent, we are running some hypothesis test about how useful that information is going to be as compared to other elective information that could have been shown to guide the user action. If we're showing a particular tool, if for a hundred times we've shown a certain tool as opposed to compressed it, and a hundred times it was never picked, or a hundred times we've shown it ten times it was selected ten times, its description was looked at then it wasn't used, we have an understanding about the preferences the user has towards that tool presentation.

But that wouldn't even tell us the full picture, because we would be computing the shortest path to completion for a proposed given future state by showing that tool under the assumption that it might be only selected in low-probability cases. Knowing that if it is selected, it usually leads to pretty quick, short paths to good experience outcomes. That would be a sort of monitoring gap for system administration as a side note. That would be one thing that contributes to tool rank.

The other thing would be when a tool is called with some input and some workflow, and then that input, that output of that tool, is used, let's say, to describe a gap. How often is that output used for gap description, or put around gap description into a frame, or loaded into a scheduler? The scheduler, technically, or the processor central server, is actually also doing gap description. How often is the decompressed state of that portion of the data space actually lending itself to getting used for decisions that aren't regretted, which I guess is our optimization function?

There are a few ways that we could do this. For agents, we could look at the agent output over time and get another agent to review the changes in the frames and evaluate how much a particular portion of the narrative was instrumental or was getting the focus or attention that led to the positive outcome versus the ones that were distracting from it. For whatever state was shown there, we follow the references of how that state came to be backwards through the tool log to inform our prioritization of conjugates, options being presented to describe how to resolve gaps.

Same thing goes for like links in like a narrative let's just say how often is that or even or even labels that are used to shoot like fast track indexing of a particular data structure like how often was that indexed let's say hit and is it worth keeping that that data in memory and doing that proactive indexing you know n times in order to only get x calls to the index. I'm pretty sure we have the capability to do all of that math and so I do think there is a way to do coherent like optimization of decisions over paths. Because everything is connected in a way that should enable us to like look at attribution with the exception of after gaps are shown what is picked. And that's preference based. And that's what we're sort of like you might have to do some agent analysis or human analysis to operate around like human RHLF or whatever. But I do think the entire structure is highly conducive to it. The only question is what data structure we actually use to determine the prioritization of particular items whenever we are running these types of compression. So whenever we're sorting things and determining how to fill out or hoist, I guess that's when all of the preferences really come into play. That is just like a big meat over the lattice. So, I don't know if you know of any formalization there, but or like ways in hierarchical reinforcement learning that this is typically done, but I'm assuming I'm not the first person to like obtain this problem and just figuring out what type of like actual data structure should at least I be using to represent the inference that let's say we apply. At that step would be very useful to me. Thank you.

## Overview

Every time the system presents a tool to a user or agent, it is running an implicit hypothesis test: will this tool be useful here? Tool rank is the system's learned answer to that question, updated continuously from three signals -- selection rate (how often the tool is picked when shown), downstream attribution (how often the tool's output drives later decisions), and counterfactual value (when it is picked, how good are the outcomes?).

The naive approach -- rank by selection rate -- fails. A tool selected 60% of the time but whose output is never used downstream is less valuable than one selected 5% of the time but which, when selected, produces short paths to good outcomes. Rank must be a composite of all three signals.

The user's deeper question is about the data structure for representing this prioritization: how to score, sort, and compress tools at the moment when the system is deciding what to show. This is the meet over the lattice -- the point where all preference signals combine to determine context allocation.

## The Tool Usage Record

Each tool accumulates counters for presentation, selection, and downstream attribution:

```ft
ToolUsage = {
  toolId: string,
  displays: number.integer >= 0,
  selections: number.integer >= 0,
  attributions: number.integer >= 0
}
```

`displays` increments every time the tool is shown (expanded or compressed). `selections` increments when the user or agent picks it. `attributions` increments when the tool's output is used in a downstream operation -- gap description, scheduling, or any decision that is not subsequently undone.

These counters update incrementally. Each event updates only the affected tool's record, not all tool ranks.

## The Rank Score

Rank is a composite of selection rate, attribution rate, and outcome quality. It is bounded between 0 and 100:

```ft
ToolRank = {
  toolId: string,
  selectionRate: number 0..100,
  attributionRate: number 0..100,
  outcomeQuality: number 0..100,
  rank: number 0..100,
  context: string
}
```

`selectionRate` is `selections / displays`. `attributionRate` is `attributions / selections` (how often selection leads to downstream use). `outcomeQuality` measures how often attributed uses lead to non-regretted decisions.

`context` scopes the rank -- different users, task types, or agents maintain separate rank profiles. A tool highly ranked for one user may be irrelevant for another.

The composite formula is not hardcoded in the type. The three rates are the inputs; the weighting is policy. What matters structurally is that rank is never just selection rate.

## Counterfactual Value

A tool with low selection rate but high outcome quality per selection must not be suppressed. This is the counterfactual signal -- the tool is rarely needed but highly valuable when it is:

```ft
-- Tool A: 5% selection rate, 90% outcome quality
-- Tool B: 30% selection rate, 20% outcome quality
-- Tool A ranks higher despite lower selection rate
```

The rank formula must weight outcome quality heavily enough that high-counterfactual tools survive. Pure selection-rate ranking would bury them. This is the exploration-exploitation tradeoff: the system must occasionally present low-selection tools to keep learning about their counterfactual value.

## Expand/Compress Decision

Rank drives the context allocation decision. Given a budget for how many tools can be expanded, the highest-ranked tools are expanded and the rest compressed:

```ft
ToolPresentation = {
  budget: number.integer >= 0,
  mode: "expanded" | "compressed"
}
```

Tools are ordered by rank, highest first. The top N (up to budget) are expanded. The rest are compressed but never hidden -- a compressed tool is always one action away from expansion. This preserves the ability to rediscover low-ranked tools.

## Backward Attribution

Tracing from a positive outcome backward through the tool invocation log identifies which tools contributed. Each contributing tool's attribution counter increases:

```ft
tool ToolUsage.displays
tool ToolUsage.selections
tool ToolUsage.attributions
tool ToolRank.rank
```

Backward attribution walks the reference graph: outcome -> state that produced it -> tool that produced that state -> earlier tools in the chain. Every tool on the causal path receives attribution credit. This is the same graph structure used by backlinks, applied to tool invocation history.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Displays and selections tracked | `ToolUsage` with `displays` and `selections` counters |
| Downstream attribution tracked | `attributions` counter incremented on downstream use |
| Composite rank, not just selection rate | `ToolRank` combines selectionRate, attributionRate, outcomeQuality |
| Higher-ranked tools expanded first | Top N by rank expanded within budget |
| Tools ordered by rank | Descending rank order in presentation |
| Counterfactual value preserved | Low selection + high outcome quality = higher rank |
| Backward attribution identifies contributors | Causal path walk from outcome to contributing tools |
| Incremental rank updates | Each event updates only affected tool's counters |
| Per-context rank profiles | `context: string` scopes rank to user/task/agent |
