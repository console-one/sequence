# Plan Branching

## Original Notes

Planned branch is like we're running a plan or we're doing some sort of confidence conjugation mapping to build out the central plan for tasks or how we're going to meet tasks in the future. If we want to basically start to assume that our sort of median expectations are wrong, we can create a p1 plan, which is derivative from the p0 plan but branches out on this conjugate at this point in time with a different assumption. We then use that kind of logic to explore, I guess, different catastrophe scenarios in the belief space. I feel like that's sort of how most optimizers work, but I don't know if I'm necessarily modeling it correctly. I just thought it was worth adding here.

Scenario analysis: forking a base plan at specific assumption points to explore alternative futures and comparing their outcomes. A branch is a copy-then-modify operation -- it inherits the base plan's entire state, then diverges by substituting one or more assumptions. Derived values recompute independently within each branch.

The purpose of branching is comparison. The user needs to see exactly where branches differ (the divergence points) and what downstream effects those differences cause. Branches are independent enough to diverge meaningfully but related enough to enable structured comparison.

## Problem Context

- **Actor(s)**: Planners who need to explore alternative scenarios; analysts who compare branch outcomes; the system that must maintain branch isolation while enabling structured comparison.
- **Domain**: Scenario analysis -- forking a base plan at specific assumption points to explore "what if" alternatives, then comparing outcomes across branches to inform decision-making.
- **Core Tension**: Branches must be independent enough that changes in one never corrupt another, yet related enough that meaningful comparison is possible (shared structure, explicit divergence points, comparable metrics).

## Requirements

**R1**: The system SHALL allow creating a branch from a base plan that inherits the base plan's entire current state.
- *Rationale*: A branch starts as an exact copy so the user can change only what matters and trust that everything else is identical to the base.
- *Verifiable by*: A newly created branch with no modifications produces identical values to the base plan for all paths.

**R2**: A branch SHALL allow substituting one or more assumptions (specific values) that differ from the base plan, while inheriting all other values unchanged.
- *Rationale*: The purpose of a branch is to change specific assumptions and observe the downstream effects. Only the diverging assumptions should differ.
- *Verifiable by*: A branch created with revenue.q2 changed from 110000 to 77000 reports 77000 for revenue.q2 and identical values to the base for all other paths.

**R3**: Derived values within a branch SHALL recompute independently based on that branch's assumptions, without affecting the base plan or other branches.
- *Rationale*: Each branch is an independent scenario. If branch B1 computes profit = -3000 because of its pessimistic revenue assumption, the base plan's profit must remain at 30000.
- *Verifiable by*: Given base profit = 30000 and branch profit = -3000 (due to changed revenue), the base plan still reports profit = 30000.

**R4**: Each branch SHALL maintain an explicit record of where it diverges from the base, including the path, the base value, and the branch value.
- *Rationale*: The divergence record makes scenarios traceable and explainable. A stakeholder can see "this branch assumes Q2 revenue drops 30%" as structured data rather than having to diff the entire plan.
- *Verifiable by*: A branch's divergence record shows path "revenue.q2", base value 110000, branch value 77000.

**R5**: The system SHALL support comparing two or more branches, identifying all divergence points and their downstream effects.
- *Rationale*: The purpose of branching is comparison. The user needs a structured diff showing not just where assumptions differ but how those differences propagate to outcomes.
- *Verifiable by*: Comparing base (profit 30000), pessimistic branch (profit -3000), and optimistic branch (profit 52000) shows revenue.q2 as the divergence point and profit as a downstream effect, with values for each branch.

**R6**: When a branch's derived values violate a constraint (e.g., costs exceed revenue), the system SHALL surface the violation as an identifiable problem within that branch, without affecting other branches.
- *Rationale*: Catastrophe detection is a primary use case -- users create pessimistic branches specifically to find where constraints break. The violation must be visible in the branch that has it and absent from branches that do not.
- *Verifiable by*: A branch with negative profit (costs > revenue) reports a constraint violation; the base plan, which has positive profit, does not report one.

**R7**: Modifying a branch SHALL never affect the base plan or any other branch.
- *Rationale*: Branch independence is a safety property. If editing branch B1 silently modified B2 or the base, scenario analysis would be untrustworthy.
- *Verifiable by*: After changing costs in branch B1, both the base plan's and B2's costs are unchanged.

**R8**: Multiple branches SHALL be able to coexist simultaneously, each with its own divergence points and derived values.
- *Rationale*: Useful scenario analysis requires comparing several alternatives at once (optimistic, pessimistic, median, catastrophe).
- *Verifiable by*: Four branches (base, pessimistic, optimistic, catastrophe) exist simultaneously, each reporting its own profit value.

## Acceptance Criteria

**AC1** [R1, R2]: Given a base plan with revenue.q2 = 110000 and costs.fixed = 80000 (profit = 30000), when a pessimistic branch is created with revenue.q2 = 77000, then the branch reports revenue.q2 = 77000, costs.fixed = 80000, and profit = -3000.

**AC2** [R3, R7]: Given base profit = 30000 and pessimistic branch profit = -3000, when the pessimistic branch's costs are changed from 80000 to 90000, then pessimistic profit becomes -13000, base profit remains 30000, and any other branch is unaffected.

**AC3** [R4]: Given a pessimistic branch with revenue.q2 changed from 110000 to 77000, when the divergence record is queried, then it contains {path: "revenue.q2", baseValue: 110000, branchValue: 77000}.

**AC4** [R5]: Given base (profit 30000), pessimistic (profit -3000), and optimistic (profit 52000), when a cross-branch comparison is performed, then the output shows revenue.q2 as a divergence point (110000 / 77000 / 132000) and profit as a downstream effect (30000 / -3000 / 52000).

**AC5** [R6]: Given a pessimistic branch with profit = -3000, then that branch reports a constraint violation (costs exceed revenue). The base plan (profit = 30000) does not report a constraint violation.

**AC6** [R8]: Given four branches (base, pessimistic, optimistic, catastrophe), all four are independently queryable and report their own values without interference.

## Open Questions

- Can branches be branched (creating nested scenarios), or is branching only allowed from the base plan?
- Should divergence records be limited to explicit user changes, or should they also capture every derived value that differs from the base?
- When the base plan is updated, should existing branches rebase (re-inherit non-diverged values) or remain frozen at the state they were created from?
