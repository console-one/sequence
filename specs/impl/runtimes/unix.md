# Unix Runtime

Unix is the philosophical layer -- not a specific OS, but the conventions that Linux, macOS, and BSD share. Everything is a file, processes communicate via pipes and signals, the shell is the composition layer. The FT system should feel natural on Unix: its store inspectable via cat, grep, and jq; its processes responsive to signals; its capabilities composable via pipes. If you cannot pipe the output of one FT operation into another, you have failed the Unix test.

The tension: the FT store is a rich, typed, graph-structured data system, but Unix tools assume flat text streams, line-oriented data, and simple process lifecycle (exit 0 = success). The runtime bridges this semantic gap without dumbing down the store or requiring custom tools for basic operations.

## Text-Readable State

Constraint store state is exposed as readable text (JSON by default) consumable by standard Unix tools:

```ft
TextOutput = {
  format: "json",
  jqCompatible: boolean,
  humanReadable: boolean
}
```

The command `ft read config.model | jq .` produces valid JSON. The store is not opaque -- it participates in the Unix text processing ecosystem.

## Pipe-Based Input

Statements are accepted via standard input, enabling composition with other commands:

```ft
StdinInput = {
  acceptsPipe: boolean,
  format: "json",
  lineDelimited: boolean
}
```

The command `echo '{"path":"config.model","value":"opus"}' | ft write` writes the statement. Unix composition works by piping stdout to stdin, and the FT system participates.

## Exit Codes

Unix exit codes are used correctly for control flow:

```ft
ExitCodes = {
  success: 0,
  notFound: number,
  typeError: number,
  gapDetected: number
}
```

A successful read exits 0. A read of a non-existent path exits non-zero. A gap (type declared but no value) exits with a gap-specific code distinct from "not found." Shell scripts use exit codes for control flow, so correctness is mandatory.

## Signal Handling

The runtime responds to Unix signals per convention:

```ft
SignalHandling = {
  sigterm: "graceful-shutdown",
  sighup: "config-reload",
  sigint: "immediate-clean-exit"
}
```

SIGTERM triggers graceful shutdown with state persistence. SIGHUP reloads configuration. SIGINT terminates cleanly. Violating these conventions breaks every process manager and shell.

## Streaming Output

Streaming operations emit line-delimited JSON for real-time downstream consumption:

```ft
StreamOutput = {
  format: "ndjson",
  lineDelimited: boolean,
  headCompatible: boolean
}
```

The command `ft subscribe config | head -5` receives 5 JSON lines and exits cleanly. Each line is independently parseable by jq.

## Stream Separation

Data output goes to stdout, diagnostics go to stderr. Never mixed:

```ft
StreamSeparation = {
  dataStream: "stdout",
  diagnosticStream: "stderr",
  mixed: false
}
```

The command `ft read config.model 2>/dev/null` produces only data. `ft read config.model >/dev/null` produces only diagnostics.

## Capability Pipelines

Capabilities are invocable as standalone commands that participate in Unix pipelines:

```ft
PipelineCapability = {
  stdinInput: boolean,
  stdoutOutput: boolean,
  composable: boolean
}
```

```ft
tool PipelineCapability.stdinInput
tool PipelineCapability.stdoutOutput
```

Two capabilities chained via a pipe produce the correct composite result: `ft cap extract --file report.pdf | ft cap summarize` works as expected.

## Shell Completion

The runtime supports shell completion for store paths and command arguments:

```ft
ShellCompletion = {
  bash: boolean,
  zsh: boolean,
  fish: boolean,
  pathCompletion: boolean
}
```

Typing `ft read config.<TAB>` shows available paths under config. Tab completion is essential for interactive use.

## Virtual Filesystem (Optional)

A FUSE interface maps store paths to filesystem paths:

```ft
FUSEMount = {
  mountPoint: string,
  readOnly: boolean,
  available: boolean
}
```

When mounted, `ls /ft/config/` lists paths under config and `cat /ft/config/model` outputs the value. This is "everything is a file" taken literally.

## What This Validates

| AC | Expressed by |
|----|-------------|
| JSON output readable by jq | `TextOutput.jqCompatible` |
| Pipe input accepted | `StdinInput.acceptsPipe` |
| Correct exit codes | `ExitCodes` with distinct values per failure type |
| Signal handling per convention | `SignalHandling` with SIGTERM/SIGHUP/SIGINT |
| Line-delimited streaming | `StreamOutput` in ndjson format |
| Stdout for data, stderr for diagnostics | `StreamSeparation.mixed = false` |
| Capabilities composable via pipes | `PipelineCapability.composable` |
| Tab completion for paths | `ShellCompletion.pathCompletion` |
| FUSE virtual filesystem | `FUSEMount` maps store to filesystem |
