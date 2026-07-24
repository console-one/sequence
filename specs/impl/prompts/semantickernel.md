# Semantic Kernel

## Original Notes

Here I'm saying that the semantic kernel here is just going to be what happens if we hoist the entire frame of an organization's process at a single point in time. Instead of giving that to our scheduler with backward inference, we are just going to give it to an LLM to pick the next task or write code to fill in the gaps. That code would just be the merge request for the next state. If that doesn't work, then it's okay; the gaps will change, and we'll just keep sending it to the LLM forever, or until we literally can't call that LLM anymore.

The point I'm trying to make is that I think it's just important that we have an example of this. We show how the system coheres to being able to have a semantic kernel or a knowledge graph network to run your scheduling, and they're both really actually the same thing. The only question is: do you use preference-based greedy optimization or something to fill in your gaps and make the sole determination about what other calls you're going to be making to yourself internally? If you continue to have gaps after that, do you just throw an exception to the user or an administrator, or do you capture that exception by an Alalam and tell it to try to figure things out? You then just give it the full state of the kernel relevant to putting its attention relevant to where that exception occurred.

---

The "semantic kernel" is not a special system. It is the ordinary process state -- tasks, gaps, capabilities -- rendered as a prompt and handed to an LLM to decide what to do next. The LLM and an algorithmic scheduler operate on the exact same gap data structure. Swapping between them requires zero changes to the data model.

The hard part is convergence and escalation. The system runs a loop: render state, interpret (LLM or algorithm), apply updates, check gaps, repeat. Each turn should close gaps. When an interpreter cannot resolve a gap after N attempts, the system escalates -- narrowing focus to the unresolved gap and handing it to a different interpreter (larger LLM, human, specialized service). The loop always terminates, either through convergence or budget exhaustion.

## The Process State

The process state holds tasks, their statuses, and gaps. This is the data both the LLM scheduler and the algorithmic scheduler operate on. Neither requires special fields.

```ft
KernelTask = {
  name: string,
  status: "blocked" | "ready" | "complete",
  output?: string,
  outputType: string
}

KernelState = {
  tasks: ref(KernelTask),
  gapCount: number.integer >= 0,
  turnCount: number.integer >= 0
}
```

A task is "blocked" when it depends on unfilled gaps, "ready" when it can be worked on, and "complete" when its output has a value. The gap count and turn count are tracked at the kernel level.

## The Convergence Loop

The loop renders state, sends to an interpreter, applies the result, and checks whether gaps remain. It terminates on convergence (zero gaps) or budget exhaustion.

```ft
ConvergenceLoop = {
  budget: number.integer >= 1,
  interpreter: "llm" | "algorithm",
  status: "running" | "converged" | "exhausted",
  state: ref(KernelState),
  turns: ref(KernelTurn)
}

ConvergenceLoop << { status: "converged" when state.gapCount = 0 }
ConvergenceLoop << { status: "exhausted" when turns.length >= budget }

KernelTurn = {
  frame: number.integer >= 0,
  prompt: string,
  response: string,
  appliedUpdates: ref(StateUpdate),
  violations: ref(Violation),
  gapsRemaining: number.integer >= 0
}

StateUpdate = {
  path: string,
  value: string,
  valid: boolean
}

Violation = {
  path: string,
  expected: string,
  actual: string
}
```

Each turn records the prompt, response, applied updates, and violations. Invalid updates produce violations that feed back into the next prompt. The interpreter field selects between LLM and algorithmic scheduling -- the state structure is identical for both.

## Interpreter Interchangeability

The LLM scheduler and the algorithmic scheduler read the same gap list and produce state updates in the same format. The interpreter is a configuration choice, not a data model choice.

```ft
-- Both interpreters:
--   1. Read state.tasks and state.gapCount
--   2. Produce StateUpdate entries
--   3. StateUpdates are validated and applied identically
-- Swapping interpreter requires changing ConvergenceLoop.interpreter, nothing else
```

The gap data structure has no interpreter-specific fields. A gap is a gap regardless of whether an LLM or an algorithm resolves it.

## Escalation

When a gap persists after N turns, the system escalates. Escalation narrows the rendered state to the scope of the unresolved gap and hands it to a different interpreter. The escalation interpreter sees deeper detail at the problem site, not the entire organization state.

```ft
Escalation = {
  sourceGap: string,
  focusedState: string,
  escalatedTo: "larger_llm" | "human" | "specialist",
  result?: string
}
```

Escalation narrows attention: the escalation interpreter receives a focused prompt scoped to the gap's subtree. This is the "capture the exception and give it the full state relevant to where that exception occurred" pattern from the original notes.

```ft
tool ConvergenceLoop.state
tool ConvergenceLoop.turns
tool KernelTask.output
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Full state rendered as prompt | `KernelTurn.prompt` contains tasks, gaps, statuses |
| Valid and invalid updates handled | `StateUpdate.valid` and `Violation` records |
| Interpreter interchangeability | Same `KernelState` structure, `interpreter` is config |
| Convergence to zero gaps | `status: "converged" when state.gapCount = 0` |
| Budget exhaustion terminates loop | `status: "exhausted" when turns.length >= budget` |
| Escalation narrows focus | `Escalation` scopes to `sourceGap` with `focusedState` |
| Audit trail per turn | `KernelTurn` records prompt, response, updates, violations |
