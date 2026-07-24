# Type To Type -- Type Transformations Through Function Chains

A value passing through a pipeline of capabilities evolves in type at each step. Step 1 produces `{data: any, source: string}`. Step 2 requires `{data: object}` and produces `{data: object, parsed: true}`. At each junction, the system computes the narrowed type -- the intersection of the prior step's output and the next step's input constraint. If the intersection is empty, the pipeline is broken at that junction.

This is type-level reasoning. It happens at declaration time, before any step executes. The scheduler can predict the full pipeline's type trajectory, measure concreteness at each step, and run backward inference (given the final desired type, what must the first step receive?). During execution, each step's status is independently tracked: completed, ready, or waiting.

The hard part is backward inference through steps that preserve properties. If step 2 passes all fields through unchanged, then a requirement on step 3's output is also a requirement on step 2's input. The system must propagate requirements backward through preservation without loss.

## The Chain Type

A chain is an ordered sequence of capabilities. Each step has an input type, an output type, and a status:

```ft
ChainStep = {
  capability: string,
  status: "waiting" | "ready" | "completed",
  concreteness: number 0..1
}
```

`concreteness` is the type concreteness at this step's output junction -- how resolved the type is after this step runs (or is predicted to be). It increases monotonically through the chain.

```ft
Chain = {
  stepCount: number.integer >= 1,
  overallConcreteness: number 0..1,
  valid: boolean
}
```

`valid` is false if any junction is incompatible. The system identifies the first incompatible junction and surfaces it as a gap.

## Junction Narrowing

At each step boundary, the type narrows. The output of step N is intersected with the input constraint of step N+1. The result is at least as concrete as the output alone:

```ft
step1 = ChainStep
step1 << { capability = "fetchData", status = "waiting", concreteness = 0.1 }

step2 = ChainStep
step2 << { capability = "parseJSON", status = "waiting", concreteness = 0.4 }

step3 = ChainStep
step3 << { capability = "extractUser", status = "waiting", concreteness = 0.9 }
```

The concreteness progression (0.1 -> 0.4 -> 0.9) is the type trajectory. Each step contributes to narrowing. The system computes this at declaration time by analyzing the type signatures.

If step 1 produces `{data: string}` but step 2 requires `{data: number}`, the intersection is empty. The chain is invalid at that junction:

```ft
incompatibleChain = Chain
incompatibleChain << { valid = false }
```

The incompatibility surfaces as a gap identifying the exact junction and the mismatched types.

## Backward Inference

Given a final output requirement, backward inference traces input requirements through each step. If the final requirement is `{user: {name: string}}`, step 3 needs `{data: {name: string, email: string}}`, step 2 needs `{data: any}`, and step 1 needs `{url: string}`:

```ft
BackwardResult = {
  targetStep: string,
  requiredInput: string,
  satisfiable: boolean
}

backwardInfer = (chain: Chain, finalRequirement: string) -> BackwardResult
cap backwardInfer
```

If any step in the backward pass produces an unsatisfiable requirement (e.g., the final requirement asks for a field no step produces), the system surfaces this as an unsatisfiable requirement rather than silently failing.

Steps that preserve properties (pass fields through unchanged) propagate requirements backward without modification. A requirement for "name" at step 3, traced backward through a preserves-all step 2, appears as a requirement for "name" at step 2's input. This is critical for pipelines with intermediate steps that filter or transform only some fields.

## Execution Status

During execution, each step's status updates independently:

```ft
-- After step 1 completes
step1 << { status = "completed", concreteness = 0.25 }
step2 << { status = "ready" }
step3 << { status = "waiting" }
```

"Completed" means the step has run and its actual output is known (which may be narrower than the predicted type). "Ready" means the step's input is available. "Waiting" means the step's input is not yet available.

When a step completes and its actual output is narrower than predicted, the concreteness at subsequent junctions updates to reflect the actual type. Type-level prediction is conservative -- actual execution only makes things more concrete, never less.

## Concreteness as Progress Metric

The concreteness at each step is a progress metric through the pipeline. The user sees "we're 10% concrete after step 1, 40% after step 2, 90% after step 3":

```ft
ConcretenessTrajectory = {
  stepIndex: number.integer >= 0,
  predicted: number 0..1,
  actual: number 0..1
}
```

`predicted` is the type-level estimate (computed at declaration time). `actual` updates as steps execute. `actual` is always >= `predicted` (execution only narrows).

## What This Validates

| AC | Expressed by |
|----|-------------|
| Chain validated at declaration time | `Chain.valid` computed from junction compatibility |
| Narrowed type at each junction | `ChainStep.concreteness` increases monotonically |
| Incompatible junction surfaced as gap | `valid = false` with identification of mismatched junction |
| Backward inference from final requirement | `backwardInfer` traces input requirements through steps |
| Preservation propagation | Preserves-all steps pass requirements backward unchanged |
| Concreteness as progress metric | `ConcretenessTrajectory` with predicted and actual |
| Independent step status tracking | `status = "completed" / "ready" / "waiting"` per step |
| Type trajectory predicted before execution | `Chain` concreteness computed at declaration time |
