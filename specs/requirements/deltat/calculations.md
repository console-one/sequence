# Calculations -- Type Interpolation Functions Over Time

## Original Notes

Calculation should be like standard functions for performing type interpolation over time and are like learned or inferred interpolation functions for what the potential values of a particular unknown field type would resolve to. These are things like something that traces the path of likelihood action or an arc of that. If you were to cut from something that goes from 0 to 100 between t_n and t_(n+k), you could cut that path at any point and get an assumption about what your probability is at that time. Rearrange these equations to be able to find the time when a certain probability breaches some threshold.

And some of these functions might be piece-wise, like changes or non-linear. I don't know that. Hopefully that's fine, but yeah, you could imagine that there's some curve or piece-wise contiguous set of curves that might have steps between them of the probability of the system being in some state over the unknown. I'm sure that there is a great deal of operations research which qualifies the different types of functions that are very common and very found in these kinds of circumstances, like Poisson distributions, etc. Having those calculations written here, given a certain inference model input or whatever over a particular set of features, and showing how those would be used if we materialize concretely certain features, how that function might react to them, if it even can, or if those features are like pick a new function. I don't know, but you got to tell me.

And the second thing would be: what is this, the golden standard of what these functions look like and how they're calculated, beyond just saying "black box transformer"? No, I need particular inference structures that, in my non-linear algebra-minded brain, I would be able to look at and be like, "Okay, I understand how this takes in a particular type and then, based on the concreteness state of that type at t, generates a function of its concreteness at different points for all slices between tn and tn+k." This is intuitive to me.

---

## Problem Context

- **Actor(s)**: The scheduler (which needs probability estimates to make decisions), capability authors (who declare expected completion profiles), operators (who need to inspect and understand probability curves).
- **Domain**: Probability estimation over time for unresolved values -- predicting when an unknown will resolve and at what likelihood, using named mathematical functions from operations research.
- **Core Tension**: The system needs probability estimates that are (a) inspectable by humans (not black-box neural nets), (b) evaluable at any point in the interval, (c) invertible (given a probability threshold, find the time), and (d) responsive to partial information arriving during the interval. Piecewise and composed functions may not have closed-form inverses.

## Requirements

**R1**: Every probability-over-time estimate SHALL use a named, inspectable mathematical function drawn from standard operations research families.
- *Rationale*: The user explicitly rejects black-box models. The function form must be something a person can look at and understand.
- *Verifiable by*: Every estimate in the system has a function form label (e.g., "linear", "exponential", "poisson_cdf") and its parameters are queryable.

**R2**: The system SHALL support at minimum these function families: linear, exponential decay, Poisson CDF, log-linear, and piecewise.
- *Rationale*: These cover the most common operations research patterns for arrival/completion processes.
- *Verifiable by*: Each listed function family can be instantiated with parameters, evaluated, and inverted.

**R3**: Every function SHALL be evaluable at any time t within its defined interval, producing a probability value with upper and lower uncertainty bounds.
- *Rationale*: Point estimates without bounds are misleading. The user demands ranges, not false precision.
- *Verifiable by*: Evaluating a function at time t returns a triple (value, lower, upper) where lower <= value <= upper.

**R4**: Every function SHALL be invertible: given a target probability threshold, the system SHALL return the time at which that threshold is first reached.
- *Rationale*: The user needs to answer "when will this be 90% likely?" not just "what's the probability at time T?"
- *Verifiable by*: For a linear function P(t) = a*t + b with threshold P, inversion returns t = (P - b) / a.

**R5**: When a function or composed function does not have a closed-form inverse, the system SHALL use numerical approximation and SHALL flag the result as approximate.
- *Rationale*: Piecewise and composed functions may not be analytically invertible, but approximate answers are still valuable if marked as such.
- *Verifiable by*: Inverting a composite function returns a result with an "approximate" flag set to true.

**R6**: Each function SHALL track an evaluability score (0 to 1) representing the fraction of the function's input parameters that are currently resolved.
- *Rationale*: A function whose parameters are all known produces sharp estimates; one with unresolved parameters produces wide bounds.
- *Verifiable by*: A function with 2 of 4 parameters resolved reports evaluability = 0.5 with correspondingly wider bounds than one with evaluability = 1.0.

**R7**: Evaluability SHALL be monotonically non-decreasing: resolving an input parameter SHALL NOT decrease evaluability.
- *Rationale*: Learning more never makes the estimate less informed.
- *Verifiable by*: After resolving any input parameter, the evaluability score is >= its previous value.

**R8**: When an input parameter is resolved and the resolved value reveals fundamentally different process behavior, the system SHALL switch to a different function form.
- *Rationale*: For example, discovering a cache hit changes the expected completion profile from linear to near-instant. Sharpening the same curve is not sufficient.
- *Verifiable by*: A function declared with a conditional form selector switches from "exponential" to "step" when the triggering condition is met.

**R9**: Function form selection conditions SHALL be declared in advance, not discovered at runtime.
- *Rationale*: Surprise form switches are unpredictable. The capability author must declare upfront what conditions trigger a form change.
- *Verifiable by*: The set of possible function forms and their triggering conditions are available before any input is resolved.

**R10**: Functions SHALL be composable into composite curves via sequential (adjacent intervals), additive (outputs sum), and multiplicative (outputs multiply) joining.
- *Rationale*: Real processes often have distinct phases or independent probability contributions.
- *Verifiable by*: Two functions with complementary intervals can be joined sequentially and evaluated across the full combined interval.

**R11**: The invertibility status of a composite function SHALL be determinable from the join mode and constituent function forms.
- *Rationale*: The system must know whether inversion is exact or approximate before attempting it.
- *Verifiable by*: A sequential composite of two linear functions reports exact invertibility. An additive composite of exponential and linear reports approximate invertibility.

## Acceptance Criteria

**AC1** [R1, R2]: Given a request for a probability estimate, when the system produces a function, then it has a named form from the supported set and all parameters are inspectable.

**AC2** [R3]: Given a Poisson CDF function with lambda = 0.5 over interval [0, 10], when evaluated at t = 3, then the result includes a value, lower bound, and upper bound, all between 0 and 1.

**AC3** [R4]: Given an exponential decay function P(t) = 1 - exp(-0.5 * t), when inverted with threshold = 0.9, then the result is t = -ln(0.1) / 0.5 = approximately 4.6.

**AC4** [R5]: Given a piecewise function composed of three segments, when inverted with a threshold that falls on a discontinuity, then the result is returned with an "approximate" flag.

**AC5** [R6, R7]: Given a function with 3 input parameters, 1 resolved, when a second parameter is resolved, then evaluability increases from 0.33 to 0.67 and the uncertainty bounds narrow.

**AC6** [R8, R9]: Given a function with a conditional form selector (default: exponential, conditional: step when cacheHit = true), when cacheHit is resolved to true, then the function form switches to "step".

**AC7** [R10]: Given two linear functions covering [0, 5] and [5, 10] respectively, when joined sequentially, then evaluating the composite at t = 3 delegates to the first function and at t = 7 delegates to the second.

**AC8** [R10, R11]: Given an additive composite of exponential and linear functions, when inversion is attempted, then the system uses numerical approximation and flags the result as approximate.

## Open Questions

1. What is the mechanism for selecting the initial function form for a given capability? Does the capability author declare it explicitly, or is it inferred from historical execution data?
2. How should the evaluability score weight different input parameters? Are all parameters equally important, or do some contribute more to estimate sharpness than others?
3. For piecewise functions, how are breakpoints between segments determined? Are they declared by the capability author or inferred from data?
