# Unix Runtime

## Original Notes

Unix is the philosophical layer -- not a specific OS, but the conventions that Linux, macOS, and BSD share. Everything is a file, processes communicate via pipes and signals, the shell is the composition layer. The FT system should feel natural on Unix: its store inspectable via cat, grep, and jq; its processes responsive to signals; its capabilities composable via pipes. If you cannot pipe the output of one FT operation into another, you have failed the Unix test.

The tension: the FT store is a rich, typed, graph-structured data system, but Unix tools assume flat text streams, line-oriented data, and simple process lifecycle (exit 0 = success). The runtime bridges this semantic gap without dumbing down the store or requiring custom tools for basic operations.

## Problem Context

- **Actor(s)**: Shell users; scripts; other Unix processes; pipes; process managers; shell completion engines.
- **Domain**: Making the system a first-class Unix citizen -- inspectable via standard tools (cat, grep, jq), composable via pipes, responsive to signals, and integrated with shell workflows.
- **Core Tension**: The system has rich, typed, graph-structured state, but Unix tools assume flat text streams, line-oriented data, and simple exit codes. The interface must bridge this gap without requiring custom tools for basic operations.

## Requirements

**R1**: State output SHALL be valid JSON consumable by standard Unix tools (jq, grep, awk).
- *Rationale*: Unix interoperability requires machine-parseable text output; JSON is the de facto standard.
- *Verifiable by*: `ft read config.model | jq .` produces valid, formatted JSON.

**R2**: The system SHALL accept statements via standard input, enabling composition with other commands.
- *Rationale*: Unix composition works by piping stdout to stdin; the system must participate.
- *Verifiable by*: `echo '{"path":"config.model","value":"opus"}' | ft write` writes the statement and exits 0.

**R3**: Exit codes SHALL follow Unix conventions: 0 for success, distinct non-zero codes for not-found, type error, and missing data.
- *Rationale*: Shell scripts use exit codes for control flow; incorrect codes break scripting.
- *Verifiable by*: A successful read exits 0; a read of a non-existent path exits with a "not found" code; a missing-data condition exits with a distinct code.

**R4**: The runtime SHALL respond to Unix signals per convention: SIGTERM for graceful shutdown, SIGHUP for config reload, SIGINT for immediate clean exit.
- *Rationale*: Every process manager and shell expects these signal semantics.
- *Verifiable by*: Send SIGTERM -- process persists state and exits. Send SIGHUP -- configuration is reloaded. Send SIGINT -- process exits immediately.

**R5**: Streaming operations SHALL emit newline-delimited JSON (NDJSON) where each line is independently parseable.
- *Rationale*: NDJSON is the standard for streaming structured data on Unix; each line can be processed by `jq` or `head`.
- *Verifiable by*: `ft subscribe config | head -5` receives 5 JSON lines and exits cleanly; each line is valid JSON.

**R6**: Data output SHALL go to stdout and diagnostic messages SHALL go to stderr, never mixed.
- *Rationale*: Mixing data and diagnostics breaks pipe composition; `2>/dev/null` must cleanly suppress diagnostics.
- *Verifiable by*: `ft read config.model 2>/dev/null` produces only data. `ft read config.model >/dev/null` produces only diagnostics.

**R7**: Operations SHALL be invocable as standalone commands that compose via pipes, producing correct results when chained.
- *Rationale*: The ability to chain operations via pipes is the fundamental Unix composition primitive.
- *Verifiable by*: `ft cap extract --file report.pdf | ft cap summarize` produces the expected composite result.

**R8**: The runtime SHALL support shell tab-completion for store paths and command arguments in bash, zsh, and fish.
- *Rationale*: Tab completion is essential for interactive use and discoverability.
- *Verifiable by*: Typing `ft read config.<TAB>` in a supported shell shows available paths under `config`.

**R9**: The runtime MAY provide a FUSE virtual filesystem interface mapping store paths to filesystem paths.
- *Rationale*: "Everything is a file" taken literally enables integration with any tool that reads files.
- *Verifiable by*: When mounted, `ls /ft/config/` lists store paths and `cat /ft/config/model` outputs the value.

## Acceptance Criteria

**AC1** [R1, R2]: Given a running system, when `echo '{"path":"config.model","value":"opus"}' | ft write` is executed followed by `ft read config.model | jq .`, then the output is valid JSON containing the written value.

**AC2** [R3]: Given a store with path `config.model` set, when `ft read config.model` runs, then exit code is 0. When `ft read config.nonexistent` runs, then exit code is non-zero and distinct from the missing-data code.

**AC3** [R4]: Given a running daemon, when SIGTERM is sent, then the process persists state and exits. When SIGHUP is sent, then configuration is reloaded without restart.

**AC4** [R5, R6]: Given a subscription, when `ft subscribe config | head -5` is run, then 5 lines of valid NDJSON are received on stdout with no diagnostic output intermixed.

**AC5** [R7]: Given two operations, when chained via `ft cap extract --file report.pdf | ft cap summarize`, then the output of the first is correctly consumed by the second.

**AC6** [R8]: Given bash/zsh/fish with completions installed, when `ft read config.<TAB>` is typed, then available sub-paths are shown.

**AC7** [R9]: Given FUSE mounted at /ft, when `cat /ft/config/model` is run, then the store value at `config.model` is output.

## FT System Demands

- **Required Primitives**: JSON-serializable state output. NDJSON streaming. Stdin-based input parsing. Exit code mapping for distinct error categories.
- **Required Operations**: Pipe-composable CLI commands. Shell completion generation for bash, zsh, and fish.
- **Gaps**: FUSE integration is optional and depends on platform support (not available on all systems).

## Open Questions

- Should the FUSE mount be read-only or read-write?
- What are the specific exit code numbers for not-found vs. type-error vs. missing-data?
- Should shell completions be statically generated or dynamically queried from the running store?
