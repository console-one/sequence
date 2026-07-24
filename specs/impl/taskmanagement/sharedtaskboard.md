# Shared Task Board

Multiple processes see the same board. Tasks move between columns -- todo, doing, done -- with conditional transitions that prevent double-claiming and enforce state machine rules. The columns are not separate containers; they are projections of the same data filtered by status. The board is always consistent because there is only one source of truth.

The additional complexity beyond a simple queue: work-in-progress limits. A configurable cap on how many tasks can be in "doing" simultaneously prevents overcommitment. When the cap is reached, further claims suspend until an active task completes and frees capacity.

## The Board Task Type

A task on the board has identity, status, title, typed input and output, and an assignee:

```ft
BoardTask = {
  id: string,
  status: "todo" | "doing" | "done",
  title: string,
  input: ref(taskInput),
  output: ref(taskOutput),
  assignee: string
}
```

Status is the single discriminator. Column membership is derived from it -- the "todo" column is all tasks where `status = "todo"`, not a separate list. This guarantees a task appears in exactly one column at all times.

## The Board Configuration

The board itself carries configuration, including the WIP limit:

```ft
Board = {
  name: string,
  wipLimit: number.integer >= 0,
  activeCount: number.integer >= 0
}
```

`activeCount` tracks how many tasks currently have `status = "doing"`. This is a derived count -- it reflects the current state, not a manually maintained counter.

## Adding Tasks

Adding a task to the board is an unconditional write. The task enters as "todo":

```ft
task1 = BoardTask
task1 << {
  id: "task-001",
  status: "todo",
  title: "Write specification",
  input: ref(taskInput)
}
```

Both processes connected to the board see the task immediately. Shared visibility is inherent -- the tasks live in a shared region, not in any process's private state.

## Claiming (Todo to Doing)

Moving a task from "todo" to "doing" is conditional on its current status. The claim also checks the WIP limit:

```ft
task1 << { status: "doing" when status = "todo" }
task1 << { assignee: "worker-A" }
board1 << { activeCount: prev + 1 }
```

The `when status = "todo"` gate prevents double-claiming. If process B tries to claim the same task after process A already has, B's operation suspends because `status` is no longer "todo". The `activeCount` increments via `prev + 1` to track current WIP.

## WIP Limit Enforcement

When the active count reaches the WIP limit, further claims suspend:

```ft
task2 = BoardTask
task2 << {
  id: "task-002",
  status: "doing" when board1.activeCount < board1.wipLimit
}
```

The `when` gate on `activeCount < wipLimit` blocks the transition until capacity is available. When an active task completes and `activeCount` decreases, the suspended claim re-evaluates and proceeds.

## Completing (Doing to Done)

Completion transitions the task to "done", attaches output, releases the assignee hold, and decrements the active count:

```ft
task1 << {
  status: "done" when status = "doing",
  output: ref(taskOutput)
}
board1 << { activeCount: prev - 1 }
```

The `activeCount` decrement via `prev - 1` frees WIP capacity. Any claims suspended on the WIP limit re-evaluate -- if capacity is now available, one of them proceeds.

## Column Projection

The board view is a projection. Each column is a filtered view of the same underlying task set:

```ft
-- todo column: all tasks where status = "todo"
-- doing column: all tasks where status = "doing"  
-- done column: all tasks where status = "done"
```

The union of all columns equals the complete task set. No task is missing from any column, and no task appears in two columns. This is guaranteed by the single `status` field -- a task has exactly one status at any time.

## Capabilities

Board operations -- status transitions, assignment, output, and board configuration -- are externally provided:

```ft
tool BoardTask.status
tool BoardTask.assignee
tool BoardTask.output
tool Board.wipLimit
tool Board.activeCount
```

## What This Validates

| AC | Expressed by |
|----|-------------|
| Shared visibility across processes | Tasks in shared region, both processes read same state |
| Schema-violating task rejected | Task missing `title` fails schema validation |
| Valid status transition (todo to doing) | `status: "doing" when status = "todo"` |
| Double-claim prevented | Second process's `when status = "todo"` fails, suspends |
| Simultaneous claim race: one wins, one suspends | First `when` succeeds, second suspends on changed status |
| Suspended claim resumes on release | Condition re-evaluates when status changes back |
| WIP limit blocks excess claims | `when board1.activeCount < board1.wipLimit` gates transition |
| Completion frees WIP capacity | `activeCount: prev - 1` decrements, suspended claims resume |
| Column projection equals full task set | Columns are filtered views of single status field |
| Completion releases hold and stores output | Status to "done" with `output: ref(taskOutput)` |
