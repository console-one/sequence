# App Layer Semantics

## Problem Context

- **Actor(s)**: The kernel (stateful process), the host environment (Node.js, browser, CLI, test harness, Lambda, etc.), and the reader (LLM, human, UI).
- **Domain**: Bootstrapping a stateful kernel within arbitrary host environments while maintaining a clean separation between state logic and external I/O.
- **Core Tension**: The kernel must manage all state, schemas, constraints, and scoring internally, yet it depends on the host for time, persistence, external capabilities, and interaction. The boundary must be narrow enough to keep the kernel portable across radically different hosts, but expressive enough that the kernel can leverage host-specific resources.

## Requirements

**R1**: The host environment SHALL provide exactly four concerns to the kernel: current time, state restoration, state persistence, and capability registration.
- *Rationale*: A minimal, fixed interface ensures the kernel is portable across any host without conditional logic or environment detection.
- *Verifiable by*: The kernel boots and operates correctly when provided with any conforming implementation of these four concerns and no others.

**R2**: The boot sequence SHALL restore previously persisted state before accepting any new input.
- *Rationale*: Without state restoration before operation, the kernel would lose accumulated state across restarts.
- *Verifiable by*: After a restart, the kernel's state matches the state at the last persistence point.

**R3**: The boot sequence SHALL register all host-provided capabilities before the interaction loop begins.
- *Rationale*: Capabilities must be known before the kernel can reason about what missing values are resolvable.
- *Verifiable by*: Capabilities registered during boot are discoverable in the kernel's first rendered output.

**R4**: The interaction loop SHALL alternate between rendering current state for the reader and accepting input from the reader.
- *Rationale*: The kernel is reactive -- it never runs autonomously. Each render reflects the latest state; each input advances it.
- *Verifiable by*: Every render reflects all prior inputs, and the kernel produces no output except in response to the loop advancing.

**R5**: The kernel SHALL be inert between interaction cycles -- it MUST NOT perform autonomous computation or I/O.
- *Rationale*: Deterministic, reproducible behavior requires that all state changes are traceable to explicit inputs.
- *Verifiable by*: No state changes occur between an output and the next input.

**R6**: The kernel SHALL periodically persist its state during the interaction loop.
- *Rationale*: Crash recovery requires periodic checkpoints so that not all work since boot is lost.
- *Verifiable by*: After a simulated crash mid-session, restoring from the last checkpoint recovers state within a bounded number of lost interactions.

**R7**: When the kernel identifies a missing value resolvable by a registered capability, it SHALL report the required invocation to the host without executing it directly.
- *Rationale*: The kernel must never perform I/O itself. The host owns all external interactions.
- *Verifiable by*: The kernel's output includes pending invocation descriptors; the host executes them and feeds results back.

**R8**: Rendering configuration (budget size, depth limits, scoring weights) SHALL be part of the kernel's own state and modifiable through normal input.
- *Rationale*: Rendering behavior should be tunable per session/user without code changes or environment reconfiguration.
- *Verifiable by*: Changing rendering parameters via input alters subsequent render output accordingly.

**R9**: The kernel SHALL track reader engagement and adjust rendering priority of content clusters over time.
- *Rationale*: Content the reader consistently ignores should drift toward compression; content the reader engages with should remain visible.
- *Verifiable by*: After repeated interactions where the reader engages with cluster A but ignores cluster B, cluster A's rendering score increases relative to cluster B's.

**R10**: The same kernel logic SHALL operate identically across different host environments.
- *Rationale*: Portability is a core architectural constraint. Host-specific behavior belongs in the environment implementation, not the kernel.
- *Verifiable by*: The same input sequence produces the same state transitions when run against different conforming host implementations.

## Acceptance Criteria

**AC1** [R1]: Given a host that provides time, restore, persist, and capability-registration functions, when the kernel boots, then it succeeds without requiring any additional host methods.

**AC2** [R2]: Given a previously persisted snapshot, when the kernel boots, then its initial state matches the snapshot contents.

**AC3** [R3]: Given a host that registers capabilities during boot, when the first render occurs, then all registered capabilities appear in the kernel's known capability set.

**AC4** [R4]: Given a running kernel, when the host advances the loop, then the kernel first renders current state, then waits for input, then processes the input, in strict alternation.

**AC5** [R5]: Given a kernel that has rendered output, when no input is provided, then no state changes occur.

**AC6** [R6]: Given a kernel with periodic persistence configured, when the configured number of interactions elapses, then the host's persist function is called with current state.

**AC7** [R7]: Given a missing value that matches a registered capability, when the kernel renders, then the output includes a pending invocation descriptor identifying the capability and required arguments.

**AC8** [R8]: Given rendering configuration in the kernel's state, when the reader modifies a rendering parameter via input, then the next render reflects the updated parameter.

**AC9** [R9]: Given a session where the reader repeatedly engages with certain content and ignores other content, when rendering scores are recalculated, then engaged content scores higher than ignored content.

**AC10** [R10]: Given two different conforming host environments, when the same input sequence is applied to each, then the resulting state is identical.

## Open Questions

- What is the right default persistence interval? The current assumption is every 100 interactions, but this may need tuning per environment.
- Should the engagement tracking decay over time, or is cumulative tracking sufficient?
