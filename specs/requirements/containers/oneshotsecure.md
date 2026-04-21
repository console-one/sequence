# One-Shot Secure Container

## Original Notes

(No original notes section was present in the original file. The narrative below the heading served as the design description.)

## Problem Context

- **Actor(s)**: Parent process (trusted, initiates the sandbox), sandboxed code (untrusted, executes within the container), the system operator who configures capability policies.
- **Domain**: Ephemeral sandboxed execution of untrusted code. The parent injects input, the sandbox runs in isolation, and the parent extracts output afterward. No bidirectional communication during execution.
- **Core Tension**: Speed vs. isolation. Sandboxes are used for individual agent steps or single tool calls, so lifecycle overhead must be seconds, not minutes. But the sandbox must be presumed hostile -- arbitrary code runs inside, so the isolation boundary is the only defense.

## Requirements

**R1**: A sandbox SHALL have a strictly one-directional lifecycle: created -> running -> completed -> destroyed. No backward transitions.
- *Rationale*: Backward transitions (e.g., re-running after completion) would break the isolation model -- the sandbox environment may have been mutated by the first execution.
- *Verifiable by*: Attempting to transition a "completed" sandbox back to "running" is rejected.

**R2**: Every sandbox SHALL have a configurable timeout. If execution does not complete within the timeout, the sandbox SHALL be forcibly destroyed.
- *Rationale*: Untrusted code may hang or loop forever. The parent must not wait indefinitely.
- *Verifiable by*: A sandbox running code with an infinite loop is destroyed after the configured timeout.

**R3**: By default, a sandbox SHALL have only code execution and stdout/stderr capture. Filesystem access, network access, and shell access SHALL be denied unless explicitly granted per-invocation.
- *Rationale*: Minimal default permissions limit the blast radius of hostile code. Each invocation gets only what it needs.
- *Verifiable by*: A sandbox created with default capabilities cannot read any files, make network requests, or execute shell commands.

**R4**: Sandbox capabilities SHALL be configurable per-invocation, allowing the parent to grant the minimum necessary for each task.
- *Rationale*: A sandbox for pure computation needs only code execution. A sandbox that needs a dataset gets read access to that specific dataset. One-size-fits-all permissions are either too restrictive or too permissive.
- *Verifiable by*: Two sandboxes created by the same parent with different capability configurations have different access levels.

**R5**: The sandbox SHALL receive input data only at creation time. The sandbox SHALL NOT have access to the parent's broader state during execution.
- *Rationale*: This is the isolation guarantee. The sandbox operates on a copy, not a reference.
- *Verifiable by*: Code running inside the sandbox cannot read any parent state beyond the explicitly injected input.

**R6**: Data flow from sandbox to parent SHALL be one-way: the parent reads the result after execution completes. The sandbox SHALL NOT be able to push state into the parent during execution.
- *Rationale*: Preventing push from sandbox to parent ensures the parent controls when and how it ingests untrusted output.
- *Verifiable by*: During execution, no state changes from the sandbox are visible to the parent. After completion, the parent retrieves the result at its own discretion.

**R7**: The parent SHALL treat all sandbox output as untrusted data.
- *Rationale*: Hostile code can produce arbitrary output. The parent must validate/sanitize before acting on it.
- *Verifiable by*: The result extraction interface does not automatically execute or interpret sandbox output.

**R8**: After execution, the container SHALL be destroyed completely: no volumes, no processes, no persistent artifacts remain on the host.
- *Rationale*: Persistent artifacts from untrusted execution are a security liability.
- *Verifiable by*: After destruction, no container, volume, or process from that sandbox exists on the host.

**R9**: The execution result SHALL include structured metadata: exit code, stdout, stderr, elapsed time, and a status indicator (success/failure/timeout).
- *Rationale*: The parent needs to programmatically determine what happened -- not just whether it succeeded, but how it failed.
- *Verifiable by*: A completed sandbox result contains all five fields. A timed-out sandbox has status "timeout."

**R10**: The sandboxing model SHALL work across environments (local Docker, remote Docker, AWS Lambda) with identical isolation guarantees regardless of the underlying implementation.
- *Rationale*: Agents should not need to know whether their sandbox is local or remote. Identical guarantees simplify the programming model.
- *Verifiable by*: A deterministic computation produces the same result in local Docker and remote Lambda sandboxes.

**R11**: Sandbox lifecycle (create, execute, extract, destroy) SHALL complete within seconds for trivial computations.
- *Rationale*: Sandboxes are used per-step in agent workflows. Multi-minute overhead would make sandboxing impractical and agents would avoid it.
- *Verifiable by*: A sandbox executing `print("hello")` completes its full lifecycle in under 5 seconds.

## Acceptance Criteria

**AC1** [R1]: Given a sandbox in "completed" state, when the parent attempts to re-run it, then the attempt is rejected.

**AC2** [R2]: Given a sandbox with a 10-second timeout executing an infinite loop, when 10 seconds elapse, then the sandbox is destroyed and the result status is "timeout."

**AC3** [R3]: Given a sandbox created with default capabilities, when code inside attempts `open("/etc/passwd")`, then the operation fails.

**AC4** [R4]: Given a sandbox created with filesystem-read permission scoped to `/data/input.csv`, when code reads `/data/input.csv`, then it succeeds. When code reads `/data/secret.key`, then it fails.

**AC5** [R5, R6]: Given a sandbox executing code, when the code attempts to write to a parent-visible location, then the write has no effect on the parent's state.

**AC6** [R8]: Given a sandbox that has been destroyed, when the host is inspected, then no container, volume, or process from that sandbox exists.

**AC7** [R9]: Given a sandbox that exits with code 1 and writes "error" to stderr, when the parent extracts the result, then the result contains exit code 1, stderr "error", and status "failure."

**AC8** [R10]: Given the same deterministic code and input, when executed in a local Docker sandbox and a Lambda sandbox, then both produce identical output.

**AC9** [R11]: Given a sandbox executing `print("hello")`, when the full lifecycle runs (create, execute, extract, destroy), then it completes in under 5 seconds.

## Open Questions

- **Capability granularity**: How fine-grained should filesystem scoping be? Per-file? Per-directory? Per-operation (read vs. read+write)?
- **Resource limits**: Should sandboxes have configurable CPU and memory limits beyond the timeout?
- **Nested sandboxing**: Can code inside a sandbox request its own sandbox, and if so, what permissions does it inherit?
