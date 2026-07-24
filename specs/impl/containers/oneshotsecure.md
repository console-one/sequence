# One-Shot Secure Container

A one-shot secure container is an ephemeral sandbox for executing untrusted code. The parent process injects input, the sandbox runs the code in isolation, and the parent extracts output after execution. No bidirectional communication during execution. No persistent state after destruction. The sandbox is presumed hostile -- it can run arbitrary code, so the isolation boundary is the only defense.

Speed matters because sandboxes are used for individual agent transition steps or single tool calls. If lifecycle overhead is high, agents will avoid sandboxing. The target is seconds, not minutes.

## Sandbox Lifecycle

A sandbox has four states: created (input injected), running (code executing), completed (output available), destroyed (nothing remains). The lifecycle is strictly one-directional:

```ft
Sandbox = {
  containerId: string,
  status: "created" | "running" | "completed" | "destroyed",
  timeout: number,
  startedAt: number,
  elapsed: number >= 0
}
```

Every sandbox has a timeout. If execution does not complete within the allowed time, the sandbox is forcibly destroyed. This is enforced by the system, not by the sandboxed code.

## Capability Restriction

The sandbox receives only an explicitly declared set of capabilities. By default, this is minimal -- code execution with stdout/stderr capture. No filesystem, no network, no shell unless specifically granted per-invocation:

```ft
SandboxCapabilities = {
  codeExecution: boolean,
  stdoutCapture: boolean,
  stderrCapture: boolean,
  filesystemRead: boolean,
  networkAccess: boolean,
  shellAccess: boolean
}
```

```ft
minimalSandbox = SandboxCapabilities
minimalSandbox << {
  codeExecution: true,
  stdoutCapture: true,
  stderrCapture: true,
  filesystemRead: false,
  networkAccess: false,
  shellAccess: false
}
```

Per-invocation scoping allows the parent to grant the minimum necessary for each task. A sandbox for pure computation gets only code execution. A sandbox that needs a dataset gets code execution plus read access to that specific dataset.

## Input Injection

The sandbox receives specific input data at creation time. It has no access to the parent's broader state:

```ft
SandboxInput = {
  taskId: string,
  data: string,
  language: string
}
```

The input is copied into the sandbox. The parent's state is not accessible from within. This is not a restriction -- it is the isolation guarantee.

## Output Extraction

Results flow one-way from the sandbox back to the parent. The sandbox writes to a designated output location; the parent reads it after execution:

```ft
SandboxResult = {
  taskId: string,
  exitCode: number,
  stdout: string,
  stderr: string,
  elapsed: number >= 0,
  status: "success" | "failure" | "timeout"
}
```

The parent treats all sandbox output as untrusted data. The sandbox cannot push state into the parent -- the parent pulls the result at its own discretion.

## Ephemeral Cleanup

After execution, the container is destroyed. No volumes, no processes, no persistent artifacts remain:

```ft
Sandbox << {
  status: "destroyed"
}
-- containerId no longer exists on host
-- no volumes from this container exist
-- no processes from this container remain
```

This is non-negotiable. Persistent artifacts from untrusted execution are a liability.

## Cross-Environment Support

The same sandboxing model works locally (Docker on user's machine) and remotely (AWS Lambda, EC2). The isolation guarantees are environment-agnostic even though the implementation differs:

```ft
SandboxEnvironment = {
  type: "docker-local" | "docker-remote" | "lambda",
  available: boolean
}
```

A deterministic computation produces the same result in any environment.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Sandbox isolated from parent state | `SandboxInput` has only task data, no parent access |
| No filesystem access by default | `filesystemRead: false` in minimal sandbox |
| No network access by default | `networkAccess: false` in minimal sandbox |
| Ephemeral -- no persistent state | Status transitions to "destroyed", nothing remains |
| One-way data flow | `SandboxResult` read by parent after execution |
| Timeout enforcement | `Sandbox.timeout` with forced destruction |
| Per-invocation capability scoping | `SandboxCapabilities` configured per sandbox |
| Structured execution result | `SandboxResult` with exitCode, stdout, stderr, elapsed |
| Cross-environment compatibility | `SandboxEnvironment` with local and remote types |
| Fast lifecycle | Target is seconds for trivial computation |
