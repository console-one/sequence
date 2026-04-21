# Timeline To Type -- Probabilistic Type Branching Over Time

## Original Notes

How we may use some function mounted at some start start time, with a timeline to entail higher resolution information about the attributes of the _type_ describing its output or its output in general.

How we may end up meeting its type with higher fidelity non-concrete classifcations (thats okay and good)

[
  t = 1,
    /*
      Proposition1:
      c1:
        Pp1 = probability process#123456 ENDS AFTER REALTIME < 2090900
        type probmisses = dot([2090900 , REALTIME], process#123456/stack['.conjuctions'])
        type a = probmisses
        type b = 1 - a
        ANY from attach(...) - 60% [c1.a],
        User from getuser(...), 40% @tinfity [c1.b]
    */
  // so ni the future
  type value = any (from Proposition1)
  t = 2090900,
  type value = USER
]

---

## Problem Context

- **Actor(s)**: Running capabilities (whose output type is not yet known), the scheduler (which uses probability-weighted type information to make decisions), downstream consumers (who want to start acting before the output is fully resolved).
- **Domain**: Progressive type resolution -- representing the output of a running process as a probability-weighted union of possible types that narrows over time and evidence until it collapses to a single concrete type.
- **Core Tension**: A running capability's output is not simply "unknown" -- it has structure. At t=0, it might be 60% likely to be "Any" and 40% likely to be "User". As time passes and partial results arrive, these probabilities shift. The system needs to represent this evolving uncertainty formally so that downstream consumers and the scheduler can make informed decisions before the output is fully resolved.

## Requirements

**R1**: A running capability's pending output SHALL be representable as a probability-weighted union of typed branches.
- *Rationale*: "Unknown" is too coarse. A probability-weighted union captures what the system actually knows about the likely output types.
- *Verifiable by*: A pending output can be queried and returns multiple branches, each with a type label and a probability summing to 1.0.

**R2**: Branch probabilities SHALL always sum to 1.0. Normalization SHALL be automatic after any update.
- *Rationale*: Probabilities that do not sum to 1 are meaningless. Manual normalization is error-prone.
- *Verifiable by*: After any branch elimination or probability shift, the sum of all live branch probabilities equals 1.0.

**R3**: Branch probabilities SHALL shift over time according to declared time functions (using the function families from the calculations spec).
- *Rationale*: The longer a capability runs, the more likely certain outcome types become. This temporal shift must be modeled, not ignored.
- *Verifiable by*: A branch declared with exponential growth has a higher probability at t=10 than at t=0.

**R4**: The capability author SHALL declare the time functions for branch probability evolution as part of the capability's type contract.
- *Rationale*: The system does not guess how probabilities evolve. The author specifies the expected behavior.
- *Verifiable by*: A capability's type contract includes per-branch time function declarations that are queryable before execution begins.

**R5**: When partial evidence arrives that is incompatible with a branch, that branch SHALL be permanently eliminated (set to probability 0, marked dead).
- *Rationale*: If the partial result has a "role" field, the "Any" branch is eliminated because "Any" cannot guarantee structured fields.
- *Verifiable by*: After evidence incompatible with branch A, branch A has probability 0 and alive = false. Surviving branches are renormalized.

**R6**: Branch elimination SHALL be permanent. A dead branch SHALL NOT return.
- *Rationale*: Evidence that eliminates a possibility cannot be un-learned. Allowing resurrection would violate monotonic narrowing.
- *Verifiable by*: After a branch is eliminated, no subsequent event restores it to alive status.

**R7**: Time-based probability shift and evidence-based branch elimination SHALL be independent and composable.
- *Rationale*: Both sources of information apply simultaneously. Time continuously shifts probabilities; evidence discretely eliminates branches.
- *Verifiable by*: A branch that time-shifts to 30% and then is eliminated goes to 0%. A branch that is not eliminated but time-shifts from 60% to 40% reflects only the time shift.

**R8**: The system SHALL track a concreteness score (0 to 1) for the probabilistic type, derived from the branch distribution. One surviving branch at 100% = concreteness 1.0.
- *Rationale*: Concreteness is the scheduler's primary input for deciding how to treat a pending output.
- *Verifiable by*: A type with two branches at 50%/50% has lower concreteness than one branch at 95%/5%.

**R9**: Concreteness SHALL be monotonically non-decreasing. Time shifts and evidence can only increase concreteness, never decrease it.
- *Rationale*: The system only learns more over time, never less.
- *Verifiable by*: At any two points t1 < t2, concreteness(t2) >= concreteness(t1).

**R10**: When exactly one branch survives (all others eliminated), the probabilistic type SHALL collapse to that branch's concrete type.
- *Rationale*: Once there is no uncertainty about which type, the union wrapper is unnecessary.
- *Verifiable by*: After all but one branch are eliminated, querying the type returns the surviving branch's type directly, not a union.

**R11**: The full state of the probabilistic type SHALL be queryable at any time: live branches, their current probabilities, concreteness score, and what evidence would eliminate each branch.
- *Rationale*: The scheduler and operators need full visibility into the evolving type state.
- *Verifiable by*: A query returns the list of live branches with probabilities, the overall concreteness, and per-branch elimination conditions.

## Acceptance Criteria

**AC1** [R1, R2]: Given a capability declared with branches Any (60%) and User (40%), when querying the pending output at t=0, then branches = [{type: "Any", probability: 0.6}, {type: "User", probability: 0.4}] and sum = 1.0.

**AC2** [R3, R4]: Given a branch with exponential growth time function, when 10 time units elapse, then the branch's probability has increased according to the declared function.

**AC3** [R5, R6]: Given branches Any (50%) and User (50%), when evidence arrives that eliminates Any, then Any has probability 0 and is dead, and User has probability 1.0.

**AC4** [R5, R2]: Given branches A (30%), B (30%), C (40%), when B is eliminated, then B = 0 and A and C are renormalized to sum to 1.0 (approximately A = 43%, C = 57%).

**AC5** [R7]: Given branches X (time-shifting from 60% to 40% over 10 units) and Y (correspondingly 40% to 60%), when at t=5 evidence eliminates X, then X = 0 and Y = 1.0 regardless of what X's time-shifted value would have been.

**AC6** [R8, R9]: Given initial branches at 50%/50% (concreteness ~0.5), when time shifts to 80%/20%, then concreteness has increased. It never drops below 0.5 subsequently.

**AC7** [R10]: Given a 3-branch type where two branches are eliminated, when querying the type, then it returns the surviving branch's type directly, with collapsed = true.

**AC8** [R11]: Given a live probabilistic type, when querying state, then the response includes all live branches with probabilities, overall concreteness, and per-branch elimination conditions.

## Open Questions

1. What granularity of evidence triggers branch elimination? Is it field-level (the result has a "role" field) or structural (the result conforms to a specific schema)?
2. When a branch is eliminated, should the system record why (which evidence killed it) for auditability?
3. How are initial branch probabilities determined? Does the capability author declare them, or are they inferred from historical data?
