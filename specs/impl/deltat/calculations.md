# Calculations -- Type Interpolation Functions Over Time

## Original Notes

Calculation should be like standard functions for performing type interpolation over time and are like learned or inferred interpolation functions for what the potential values of a particular unknown field type would resolve to. These are things like something that traces the path of likelihood action or an arc of that. If you were to cut from something that goes from 0 to 100 between t_n and t_(n+k), you could cut that path at any point and get an assumption about what your probability is at that time. Rearrange these equations to be able to find the time when a certain probability breaches some threshold.

And some of these functions might be piece-wise, like changes or non-linear. I don't know that. Hopefully that's fine, but yeah, you could imagine that there's some curve or piece-wise contiguous set of curves that might have steps between them of the probability of the system being in some state over the unknown. I'm sure that there is a s***load of operations research which qualifies the different types of functions that are very common and very found in these kinds of circumstances, like Poisson distributions, etc. Having those calculations written here, given a certain inference model input or whatever over a particular set of features, and showing how those would be used if we materialize concretely certain features, how that function might react to them, if it even can, or if those features are like pick a new function. I don't know, but you got to tell me.

And the second thing would be: what is this, the golden standard of what these functions look like and how they're calculated, beyond just saying "black box transformer"? No, I need particular inference structures that, in my non-linear algebra-minded brain, I would be able to look at and be like, "Okay, I understand how this takes in a particular type and then, based on the concreteness state of that type at t, generates a function of its concreteness at different points for all slices between tn and tn+k." This is intuitive to me.

---

A type's concreteness at any moment is a number between 0 and 1. When a capability is running and its output is not yet resolved, we want an explicit mathematical function that estimates the probability of resolution over time. Not a black box. Not a neural net. A named, inspectable curve drawn from standard operations research -- linear, exponential, Poisson CDF, piecewise -- that the user can look at and understand.

These functions take the current concreteness state of the type's inputs as parameters. As inputs materialize, the curve sharpens -- its uncertainty bounds narrow. If the materialization reveals the process has fundamentally different behavior (e.g., a cache hit changes linear to step), the function form itself switches. Critically, these functions are invertible: given a target probability threshold, the system can solve for the time at which that threshold is breached.

The hard part is not any single function. It is the interplay: partial evaluability (some inputs resolved, some not), composition (piecewise joining of sub-functions), and the inversion of composed functions where closed-form inverses may not exist.

## The Interpolation Function Type

An interpolation function has a named form, parameters bound to type paths, and produces a probability with uncertainty bounds. Evaluability tracks how many of the function's inputs are currently resolved:

```ft
InterpolationFn = {
  form: "linear" | "exponential" | "poisson_cdf" | "log_linear" | "piecewise",
  tStart: number >= 0,
  tEnd: number >= 0,
  evaluability: number 0..1
}
```

The `form` field is not decorative -- it determines the closed-form equation used. Each form is a named, inspectable mathematical structure, not an opaque model.

## Function Families

Each family is a concrete parameterization. Linear interpolation is the simplest: probability rises from 0 to 1 over the interval. Exponential decay models processes that are likely to complete early. Poisson CDF models arrival processes. Log-linear models diminishing returns. Piecewise joins segments at breakpoints.

```ft
LinearParams = {
  a: number,
  b: number
}

ExponentialParams = {
  a: number,
  lambda: number >= 0,
  b: number
}

PoissonCDFParams = {
  lambda: number >= 0
}

LogLinearParams = {
  a: number,
  b: number
}

PiecewiseParams = {
  segmentCount: number.integer >= 1
}
```

Evaluation of a function at time `t` produces a bounded prediction -- a central estimate with lower and upper margins. Point estimates without bounds are forbidden (the user explicitly demands ranges, not false precision):

```ft
BoundedPrediction = {
  value: number 0..1,
  lower: number 0..1,
  upper: number 0..1
}
```

## Evaluating and Inverting

The core operations are evaluate (given time, return probability) and invert (given probability threshold, return time). Evaluation works even when inputs are partially resolved -- it returns what it can with an evaluability score. Inversion solves for the time at which P(t) first meets or exceeds a threshold.

For linear: `P(t) = a*t + b`, inversion is `t = (P - b) / a`. For Poisson CDF: `P(t) = 1 - exp(-lambda*t)`, inversion is `t = -ln(1 - P) / lambda`. For piecewise and composed functions, closed-form inversion may not exist -- numerical approximation is acceptable, but must be flagged as approximate.

```ft
evaluate = (fn: InterpolationFn, t: number >= 0) -> BoundedPrediction
invert = (fn: InterpolationFn, threshold: number 0..1) -> { t: number >= 0 }
```

Evaluability is the ratio of resolved inputs to total required inputs. With zero inputs resolved, evaluability is 0 and the prediction is maximally uncertain. With all resolved, evaluability is 1 and the prediction is as sharp as the function form allows. Resolving more inputs never decreases evaluability -- this is monotonic.

## Reacting to Input Materialization

When an input parameter is materialized (e.g., the payload size becomes known), the function reacts in one of two ways: either the curve sharpens (bounds narrow, same form) or the function form itself switches (linear becomes piecewise because the input reveals cache-hit behavior). The switch is declared via conditional form selection -- not discovered at runtime.

```ft
formSelector = {
  default: InterpolationFn,
  conditional: InterpolationFn when inputRevealsCacheBehavior EXISTS
}
```

The conditional form takes precedence when its condition is met. This is the same `when` gate used everywhere else in the type system -- no special mechanism for function-form switching.

## Composition

Multiple functions combine into composite curves. Two piecewise functions covering adjacent intervals join into a single piecewise function. A linear function added to an exponential produces a composite that evaluates correctly at all points but may not have a clean closed-form inverse.

```ft
composite = {
  left: InterpolationFn,
  right: InterpolationFn,
  joinMode: "sequential" | "additive" | "multiplicative"
}
```

When `joinMode` is "sequential", the left function covers `[tStart, tMid]` and the right covers `[tMid, tEnd]`. When "additive", both evaluate at every point and their outputs sum (then clamp to [0,1]). When "multiplicative", outputs multiply (modeling independent probability contributions).

Invertibility of composites depends on the join mode and the constituent forms. Sequential composites invert by delegating to whichever segment contains the target. Additive and multiplicative composites may require numerical methods. The system must flag when inversion is approximate rather than exact.

## Capability Registration

A capability registers its interpolation function as part of its type contract. The function is not a separate metadata layer -- it is part of the type:

```ft
tool evaluate
tool invert
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Named, inspectable mathematical form | `InterpolationFn.form` -- every function has a named form |
| Five function families supported | `LinearParams`, `ExponentialParams`, `PoissonCDFParams`, `LogLinearParams`, `PiecewiseParams` |
| Evaluation at any time in interval | `evaluate` capability takes `fn` and `t`, returns `BoundedPrediction` |
| Input concreteness shapes the curve | `evaluability` field tracks input resolution; bounds narrow as inputs resolve |
| Function form switches on materialization | `formSelector` with conditional `when` gate |
| Invertible -- find time for threshold | `invert` capability solves for `t` given a threshold |
| Evaluability as queryable metric | `InterpolationFn.evaluability` is 0..1, monotonically increasing |
| Composable into complex curves | `composite` with sequential, additive, multiplicative join modes |
| Uncertainty bounds on every prediction | `BoundedPrediction` includes `value`, `lower`, `upper` |
