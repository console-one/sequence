# Type To Timeline -- Scheduler Resolution Depth for Time-Based Probability

## Original Notes

Here, I think a lot of the answers might be able to be inferred from the contents of the event economics folder, or at least comments that I made there. This is what principle process would we be using to determine how to update the probability of certain sub-branches at a particular type being different from the highest-level partition in terms of completion time or in terms of probability being concrete at a certain point in time, etc.?

If I have some assumption about some function that can either take in A or B, like it takes in an object of, I don't know, user type as its input, but I know that that function's duration is going to be super different if that user type is either an admin or a customer. At what point do we change the internal scheduler's resolution depth of the potential values of that user type to break it out into probabilities, if that is probably to either an A or B user type or an admin type, which would be determined based off of some other conjugate and then search, and then maybe use the search for that other conjugate during back inference to cut the branch path depending on whatever we find?

It sounds like a lot, but it's like what time-based type over time interpolation policy mount process do we obtain in order to optimally schedule without loading the system with so much unnecessary type information that it becomes incoherent? We might already be doing this by virtue of the algorithm; maybe not. Having that written out clearly in this file and the mathematics that's used to do it would be, I think, very useful.

---

## Problem Context

- **Actor(s)**: The scheduler (which estimates capability durations), input types with sub-type variance (which cause different execution profiles), the resolution planner (which finds ways to disambiguate inputs).
- **Domain**: Demand-driven sub-type expansion for scheduling -- deciding when an input type's sub-variants matter enough for scheduling accuracy to justify the cost of expanding them into separate probability-weighted paths.
- **Core Tension**: Treating every input as a coarse type hides order-of-magnitude scheduling differences (admin: 5s, customer: 45s). Expanding every input into sub-type probabilities is exponentially expensive and makes the system incoherent. The system needs a principled trigger for when expansion is worth the cost.

## Requirements

**R1**: A capability SHALL be able to declare multiple time profiles -- one per input sub-type -- when the input sub-type significantly affects execution duration.
- *Rationale*: A function that takes 5 seconds for admins and 45 seconds for customers has fundamentally different scheduling implications depending on which sub-type the input turns out to be.
- *Verifiable by*: A capability's type contract includes multiple time profiles keyed by input sub-type, each with an estimated duration and margin.

**R2**: The system SHALL compute a divergence metric for each input: the absolute difference between the fastest and slowest time profiles.
- *Rationale*: Divergence quantifies how much the scheduling estimate would change based on sub-type resolution.
- *Verifiable by*: Given time profiles of 5s and 45s, the divergence is 40s.

**R3**: The system SHALL gate sub-type expansion on a configurable significance threshold. Only inputs with divergence exceeding the threshold SHALL be expanded.
- *Rationale*: Expanding inputs with negligible divergence wastes computation without improving scheduling.
- *Verifiable by*: An input with 1s of divergence (below a 5s threshold) is not expanded. An input with 40s of divergence (above the threshold) is expanded.

**R4**: When an input is flagged as time-divergent, the scheduler SHALL expand it into probability-weighted sub-type paths, each with its own time estimate and margin.
- *Rationale*: After expansion, the scheduler can reason about the best-case and worst-case durations and make informed decisions.
- *Verifiable by*: After expansion of a divergent input, the scheduler shows separate paths (e.g., admin: 30% probability, 5s estimate; customer: 70% probability, 45s estimate).

**R5**: Expansion SHALL be demand-driven: only inputs flagged as time-divergent SHALL be expanded. All other inputs SHALL remain as single compressed scores.
- *Rationale*: Expanding everything is the exponential blowup the system must avoid.
- *Verifiable by*: In a capability with 10 inputs, only the 2 flagged as divergent have sub-type breakdowns; the other 8 remain as single estimates.

**R6**: After expansion, the system SHALL use backward inference to find what capability or information source can resolve the sub-type ambiguity.
- *Rationale*: Knowing that user.role is divergent is useful only if the system can find a way to resolve it (e.g., "call lookupUser to determine the role").
- *Verifiable by*: For a divergent input "user.role", backward inference produces a resolution plan identifying a capability ("lookupUser") that can resolve the ambiguity.

**R7**: The resolution plan SHALL include the estimated cost (time, resources) of performing the resolution itself.
- *Rationale*: Resolving a divergent input has its own cost. The scheduler must weigh "time to resolve" against "scheduling value of knowing."
- *Verifiable by*: A resolution plan includes an estimated resolution cost (e.g., 2 seconds for a database lookup).

**R8**: When a divergent input is resolved, non-matching sub-type paths SHALL be eliminated and the scheduler SHALL collapse to a single time estimate.
- *Rationale*: Once the sub-type is known, the expanded paths serve no purpose. The scheduler needs one estimate, not a distribution.
- *Verifiable by*: After resolving user.role = "admin", the customer path is eliminated and the scheduler shows a single estimate of 5s +/- 1s.

**R9**: Time-divergent inputs SHALL receive elevated priority in the resolution queue, proportional to their divergence.
- *Rationale*: Resolving a 40s-divergence input has more scheduling value than resolving a 5s-divergence input.
- *Verifiable by*: An input with 40s divergence appears higher in the resolution queue than one with 5s divergence.

**R10**: The significance threshold SHOULD be configurable and MAY be adaptive in future versions.
- *Rationale*: Different deployments have different tolerance for scheduling imprecision.
- *Verifiable by*: The threshold can be changed via configuration and the system respects the new value.

## Acceptance Criteria

**AC1** [R1, R2]: Given a capability with time profiles admin = 5s and customer = 45s, when divergence is computed, then divergence = 40s.

**AC2** [R3]: Given a threshold of 5s, when an input has divergence = 2s, then it is not expanded. When another input has divergence = 40s, then it is expanded.

**AC3** [R4, R5]: Given 10 inputs where 2 are flagged as divergent, when the scheduler processes them, then exactly 2 inputs have sub-type probability breakdowns and the other 8 are single estimates.

**AC4** [R6, R7]: Given a divergent input "user.role", when backward inference runs, then a resolution plan is produced identifying a resolving capability and its estimated cost.

**AC5** [R8]: Given expanded paths admin (30%, 5s) and customer (70%, 45s), when user.role is resolved to "admin", then the customer path is eliminated and the scheduler shows a single estimate: 5s +/- 1s.

**AC6** [R9]: Given two divergent inputs -- one with 40s divergence and one with 5s divergence -- when the resolution queue is ordered, then the 40s-divergence input appears first.

## Open Questions

1. Should the threshold be a fixed absolute value (e.g., 5 seconds) or a relative ratio (e.g., slow/fast > 3x)? Different domains may benefit from different threshold types.
2. When backward inference finds multiple ways to resolve a divergent input, how does the system choose? Cheapest resolution cost? Fastest? Most certain?
3. How does this interact with the priority system from the compressed spec? Is scheduling-value priority additive with dependency-participation priority, or do they compose differently?
