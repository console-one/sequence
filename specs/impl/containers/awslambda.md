# AWS Lambda Container

## Original Notes

We want to create a container for the process to run in an AWS Lambda. This would obviously have certain limitations because AWS Lambda doesn't enable you to have persistent memory for a long period of time or persistent memory beyond certain size thresholds. You can't really rely on it to have a good single-threaded scheduler and other things, but it would be really strong for managing one-shot agent narratives that we might want to have highly parallelized but running in sequence in very rapid scale-up and scale-down notation.

We would like to create an AWS Lambda image type with the ability to have certain tools that are required for a certain LLM to run with a certain tool recipe that can run on AWS Lambda. It would just be a central orchestrator, probably running on Docker EC2, able to fan out work to like 100 of them, let's just say, and just do big-time scheduling.

If any of the, we probably would, on boot, have the AWS Lambda image set up its process environment. Its process would then try to claim a lock while we're setting up the snapshot environment. We're setting up the sockets to register the content-addressable ID of that Lambda to mount its process log at some location in the distributed server. If anybody wants to call this agent, they would call that process in the distributed server, like `send message` or whatever. That `send message` in the distributed server would just write to the socket store, which would eventually come to this agent. We would set up the rules within the process for this agent to update some local value for: heartbeat, send heartbeat, claim lock, extend lock, claim every N seconds -- to basically send heartbeats through that socket, which the central server would then receive and patch to the partition dedicated to this process's agent's last lock claim time. And it would be like when this agent's facade is mounted. It would be mounted with the condition to tear it down and remove the agent's hold on locks if that heartbeat isn't sent. And like D scale the jobs from it, et cetera. The second it's in, like, the server, when it sets up on the server, it's going to send its contract for all the different types of requests that could be sent to it. It could potentially handle its capabilities and then the orchestration server. It looks at those capabilities, figures out what function types it has that are undefined based on conjugates or whatever, and uses that information that the agent exists to update the probabilities and the resolution path for all the functions that would be enabled because this agent is available to now handle those types of task requests.

Those functions would be like if the agent registered under the orchestration server, saying, "Hey, orchestration server, I can do read and write to the file system for data type X." The orchestration server has internally some definition of the probability that it could mount a function for reading and writing to just data type X. Using the identity equivalences, adding that agent and that agent's constraints might create a new shortest path for any plan that requires that as a prerequisite. And so, as part of that entire rebalancing process, it might then start sending some of its tasks to the agent. Or it might just include the agent in a round-robin queue that gets the next request for that particular function anytime it's called.

---

A Lambda worker is an ephemeral compute unit that boots, does one job, and dies. The orchestrator needs to treat it as a reliable capability provider for the duration of its lifecycle without assuming it will live forever. The hard part is the lifecycle: register identity, declare capabilities, prove liveness via heartbeat, hold locks on assigned work, and have all of that unwind automatically when the worker disappears. Every Lambda is a temporary extension of the orchestrator's capability surface.

The boot sequence is load-bearing: identity must exist before a lock can be claimed, a lock before a heartbeat proves anything, a heartbeat before capabilities are meaningful, and capabilities before work can arrive. Get the order wrong and work arrives at an unprepared worker.

## Worker Identity and Lifecycle

A Lambda worker has a content-addressed identity derived from its configuration, a heartbeat timestamp, a liveness window, and a boot phase that must progress through a fixed order. Liveness is derived from the heartbeat -- it is not stored separately, it is a predicate on the stored timestamp vs current time.

```ft
LambdaWorker = {
  id: string,
  configHash: string,
  heartbeat: number,
  livenessWindow: number,
  alive: boolean
}
```

The `alive` field is a refinement: it equals whether the heartbeat timestamp is recent enough relative to the liveness window. The parser cannot express the temporal predicate `alive = (heartbeat > _rt - livenessWindow)` directly, but that is the semantic -- every time the runtime clock advances, `alive` re-evaluates.

Boot progresses through phases in strict order. Each phase depends on the prior completing:

```ft
LambdaWorker << {
  bootPhase: "identity" | "lock" | "heartbeat" | "capabilities" | "ready"
}
```

## Lock and Task Assignment

A worker holds a lock on assigned tasks. The lock is valid only while the worker is alive. When the heartbeat expires, the lock breaks, and tasks return to the unassigned pool:

```ft
WorkerLock = {
  workerId: string,
  taskId: string,
  held: boolean while alive = true
}
```

When `alive` becomes false (heartbeat too old), the `while` condition breaks and `held` is removed. The task's schema still exists in the orchestrator, so it reappears as an unfulfilled obligation. This is the entire reassignment mechanism -- there is no explicit "reassign" operation.

```ft
worker1 = LambdaWorker
worker1 << { id: "lambda-abc123", configHash: "sha256:abc", livenessWindow: 5000 }
worker1 << { heartbeat: prev }
```

Each heartbeat is a narrow that updates the timestamp. The worker's process loop mounts it periodically. If no heartbeat arrives and time advances past the window, `alive` evaluates to false on the next mount.

## Capability Declaration

After boot, the worker declares what it can do. Each capability is a typed function signature. The orchestrator uses these to route tasks:

```ft
WorkerCapability = {
  name: string,
  inputType: string,
  outputType: string,
  workerId: string
}
```

When a worker registers capabilities, the orchestrator re-evaluates which pending tasks are now resolvable. A new capability may create a shorter resolution path for plans that require it as a prerequisite:

```ft
cap LambdaWorker.heartbeat
cap LambdaWorker.task
cap WorkerCapability.name
```

## Task Routing

The orchestrator routes tasks to workers based on declared capabilities. When multiple workers can handle the same task type, work is distributed fairly:

```ft
TaskRouting = {
  taskId: string,
  requiredCapability: string,
  assignedWorker: string,
  status: "pending" | "assigned" | "completed" | "expired"
}
```

A task requiring capability X is matched only to workers that declared X. Distribution across multiple eligible workers follows round-robin or equivalent fair policy.

## Socket Communication

Workers communicate with the orchestrator via a socket channel. The worker's process log is mounted at a known location in the distributed state:

```ft
WorkerSocket = {
  workerId: string,
  endpoint: string,
  processLogPath: string,
  connected: boolean
}
```

Any process can send a message to a worker by writing to its mounted location. The socket layer delivers it to the worker.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Worker registers content-addressed ID | `worker1 << { id, configHash }` at boot |
| Worker declares typed capabilities | `WorkerCapability` with input/output types |
| Heartbeat stored and readable | `worker1 << { heartbeat: prev }` |
| Lock valid while heartbeat fresh | `held: boolean while alive = true` |
| Lock expires on missed heartbeat | `while` breaks when `alive` becomes false |
| Tasks resurface for reassignment | Schema remains, obligation reappears |
| New capabilities trigger re-evaluation | `cap WorkerCapability.name` registration |
| Fair distribution across workers | `TaskRouting` with round-robin assignment |
| Boot phases ordered | `bootPhase` enum progressing in sequence |
| Socket-based communication | `WorkerSocket` with mounted process log |
| 100 concurrent workers | `LambdaWorker` pattern scales horizontally |
