# Tool Rank

## Original Notes

We can obtain some notion of a tool rank based off of looking at all the times a particular tool was shown on a client interface. Either as a button that could be pressed and expanded, or as a tool with particular type input specifications that were not materialized concretely by the next user action or the next optimizer action, because we're using the sort of compression frame-based model. Any time that we're showing what we have in some UI to a user, we're showing a set of services or APIs or something that is not going to be necessarily static to the next user that comes with a request to show gaps. It's actually a good thing.

We could consider that every time we show a particular tool in a particular case, or even a particular narrative to a particular agent, we are running some hypothesis test about how useful that information is going to be as compared to other elective information that could have been shown to guide the user action. If we're showing a particular tool, if for a hundred times we've shown a certain tool as opposed to compressed it, and a hundred times it was never picked, or a hundred times we've shown it ten times it was selected ten times, its description was looked at then it wasn't used, we have an understanding about the preferences the user has towards that tool presentation.

But that wouldn't even tell us the full picture, because we would be computing the shortest path to completion for a proposed given future state by showing that tool under the assumption that it might be only selected in low-probability cases. Knowing that if it is selected, it usually leads to pretty quick, short paths to good experience outcomes. That would be a sort of monitoring gap for system administration as a side note. That would be one thing that contributes to tool rank.

The other thing would be when a tool is called with some input and some workflow, and then that input, that output of that tool, is used, let's say, to describe a gap. How often is that output used for gap description, or put around gap description into a frame, or loaded into a scheduler? The scheduler, technically, or the processor central server, is actually also doing gap description. How often is the decompressed state of that portion of the data space actually lending itself to getting used for decisions that aren't regretted, which I guess is our optimization function?

There are a few ways that we could do this. For agents, we could look at the agent output over time and get another agent to review the changes in the frames and evaluate how much a particular portion of the narrative was instrumental or was getting the focus or attention that led to the positive outcome versus the ones that were distracting from it. For whatever state was shown there, we follow the references of how that state came to be backwards through the tool log to inform our prioritization of conjugates, options being presented to describe how to resolve gaps.

Same thing goes for like links in like a narrative let's just say how often is that or even or even labels that are used to shoot like fast track indexing of a particular data structure like how often was that indexed let's say hit and is it worth keeping that that data in memory and doing that proactive indexing you know n times in order to only get x calls to the index. I'm pretty sure we have the capability to do all of that math and so I do think there is a way to do coherent like optimization of decisions over paths. Because everything is connected in a way that should enable us to like look at attribution with the exception of after gaps are shown what is picked. And that's preference based. And that's what we're sort of like you might have to do some agent analysis or human analysis to operate around like human RHLF or whatever. But I do think the entire structure is highly conducive to it. The only question is what data structure we actually use to determine the prioritization of particular items whenever we are running these types of compression. So whenever we're sorting things and determining how to fill out or hoist, I guess that's when all of the preferences really come into play. That is just like a big meat over the lattice. So, I don't know if you know of any formalization there, but or like ways in hierarchical reinforcement learning that this is typically done, but I'm assuming I'm not the first person to like obtain this problem and just figuring out what type of like actual data structure should at least I be using to represent the inference that let's say we apply. At that step would be very useful to me. Thank you.

## Problem Context

- **Actor(s)**: Users and agents who interact with presented tools, the presentation layer that decides which tools to show expanded vs. compressed, the ranking system that learns from interaction history.
- **Domain**: Adaptive tool prioritization. The system presents tools (APIs, actions, capabilities) to users and agents. Every presentation is an implicit hypothesis test: "will this tool be useful here?" The system must learn from outcomes to improve future presentations.
- **Core Tension**: Simple selection rate (how often a tool is picked when shown) is insufficient. A tool picked 5% of the time but whose output drives successful outcomes is more valuable than a tool picked 60% of the time whose output is never used downstream. Rank must combine selection rate, downstream attribution, and counterfactual value -- the question the original notes frame as "what data structure do we use to determine the prioritization?"

## Requirements

**R1**: The system SHALL track, per tool, how many times it has been displayed to a user or agent (display count).
- *Rationale*: Display count is the denominator for selection rate. Without it, raw selection counts are meaningless.
- *Verifiable by*: After a tool is displayed 10 times, its display count reads 10.

**R2**: The system SHALL track, per tool, how many times it has been selected by a user or agent after being displayed (selection count).
- *Rationale*: Selection count is the primary signal for user interest.
- *Verifiable by*: After a tool is displayed 10 times and selected 3 times, its selection count reads 3.

**R3**: The system SHALL track, per tool, how many times its output was used in a downstream operation (attribution count). Downstream operations include informing decisions, feeding into subsequent processing, or contributing to completed workflows.
- *Rationale*: The original notes emphasize that selection alone is insufficient -- "how often is the decompressed state of that portion of the data space actually lending itself to getting used for decisions that aren't regretted?" Attribution measures real impact.
- *Verifiable by*: A tool selected 3 times, with output used downstream 2 of those 3 times, has attribution count 2.

**R4**: Tool rank SHALL be a composite score (0-100) derived from at least three signals: selection rate, attribution rate, and outcome quality. Rank SHALL NOT be based on selection rate alone.
- *Rationale*: The original notes give the example: a tool selected 5% of the time but leading to fast, successful outcomes should rank higher than a tool selected 30% of the time whose output is rarely used. Single-signal ranking fails.
- *Verifiable by*: Given Tool A (5% selection, 90% outcome quality) and Tool B (30% selection, 20% outcome quality), Tool A has a higher rank than Tool B.

**R5**: The weighting formula for combining the three signals into a composite rank SHALL be configurable (not hardcoded).
- *Rationale*: Different deployment contexts may weight the signals differently. The system should provide the signals; the policy determines the weighting.
- *Verifiable by*: Changing the weighting configuration changes the resulting rank for the same underlying data.

**R6**: Rank SHALL be scoped per context (user, task type, agent). A tool's rank for one user or agent MAY differ from its rank for another.
- *Rationale*: User preferences vary. A tool highly ranked for a developer may be irrelevant for a designer.
- *Verifiable by*: The same tool has different rank values in different user contexts.

**R7**: The system SHALL support backward attribution: tracing from a positive outcome backward through the tool invocation history to identify which tools contributed.
- *Rationale*: The original notes describe following "references of how that state came to be backwards through the tool log." This is how the attribution signal is produced.
- *Verifiable by*: Given a successful outcome that used the output of Tool A, which used the output of Tool B, both Tool A and Tool B receive attribution credit.

**R8**: Given a presentation budget (maximum number of tools shown expanded), the system SHALL present tools in descending rank order, expanding the top N and compressing the rest.
- *Rationale*: Screen and token budgets are finite. Highest-value tools should get the most prominent presentation.
- *Verifiable by*: With a budget of 5, the 5 highest-ranked tools are expanded. The rest are compressed.

**R9**: Compressed tools SHALL remain accessible -- never fully hidden. A compressed tool SHALL be expandable with one action.
- *Rationale*: Hiding low-ranked tools prevents rediscovery. The system must occasionally present low-ranked tools to keep learning about their counterfactual value (exploration-exploitation tradeoff).
- *Verifiable by*: A compressed tool is visible as a collapsed entry. The user can expand it with one click/action.

**R10**: Counter updates SHALL be incremental: each interaction event updates only the affected tool's counters, not all tools' ranks.
- *Rationale*: Recalculating all ranks on every event is wasteful. Most events affect one tool.
- *Verifiable by*: Selecting Tool A updates only Tool A's counters. Other tools' data is unchanged.

## Acceptance Criteria

**AC1** [R1, R2, R3]: Given a tool displayed 100 times, selected 10 times, and with output used downstream 8 times, when its usage data is queried, then displays=100, selections=10, attributions=8.

**AC2** [R4]: Given Tool A (selection rate 5%, attribution rate 90%, outcome quality 90%) and Tool B (selection rate 60%, attribution rate 10%, outcome quality 20%), when ranks are compared, then Tool A outranks Tool B.

**AC3** [R6]: Given the same tool with 50 selections by User X and 2 selections by User Y, when rank is queried per user context, then the rank differs between User X and User Y.

**AC4** [R7]: Given a successful outcome produced by a chain of three tool invocations (T1 -> T2 -> T3), when backward attribution runs, then all three tools receive attribution credit.

**AC5** [R8]: Given 20 tools ranked 1-20 and a budget of 5, when the presentation is generated, then tools ranked 1-5 are expanded and tools ranked 6-20 are compressed.

**AC6** [R9]: Given a tool ranked 20th (compressed), when the user selects it, then it expands with one action.

**AC7** [R10]: Given 100 tools, when Tool A receives a selection event, then only Tool A's counters are updated.

## Open Questions

- **Exploration rate**: How often should low-ranked tools be promoted to "expanded" to maintain exploration? Fixed rate? Decaying schedule?
- **Attribution decay**: Should attribution credit decay over time? A tool that was useful 6 months ago may be less relevant now.
- **Cold start**: How are new tools (zero display history) ranked? Do they get a default rank, or are they always expanded until sufficient data is collected?
- **Data structure**: The original notes ask explicitly about what data structure to use for representing the prioritization. Is a simple scored list sufficient, or is a more sophisticated structure (e.g., contextual bandit, Bayesian ranking) needed?
