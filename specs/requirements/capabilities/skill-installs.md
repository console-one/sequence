# Skill Installation (Tool Annotation Transposition)

## Original Notes

This refers to the capability to transpose general scale annotations that are used for general tools like Claude code or Open Claude. Make them available as capability groups or tools, or sets of capabilities that can be provisionally viewed or inspected or annotated to have certain behavioral considerations for the rest of the model.

## Problem Context

- **Actor(s)**: External tool providers (Claude Code, MCP servers, OpenAPI services), agents consuming tool capabilities, users and administrators annotating tool behavior.
- **Domain**: Tool integration and behavioral annotation. External tools publish schemas (MCP tool definitions, OpenAPI specs, JSON Schema). The system must import these definitions, make them inspectable and discoverable, and allow behavioral annotations (safety constraints, reliability metadata, access controls) to be layered on without modifying the original tool definitions.
- **Core Tension**: External tools define their own schemas in their own formats, but the system needs a unified way to discover, inspect, compose, and constrain them. Annotations must layer on top of the original definitions without altering them, so the source of truth remains the external tool's own schema.

## Requirements

**R1**: The system SHALL support importing external tool definitions from standard schema formats (MCP tool definitions, OpenAPI specs, JSON Schema) and registering them as system capabilities.
- *Rationale*: External tools are the primary source of agent capabilities. If their schemas cannot be imported, every capability must be hand-authored, which does not scale.
- *Verifiable by*: An MCP tool definition with a JSON Schema input is imported and produces a system capability with the correct input/output types.

**R2**: Imported capabilities SHALL preserve the tool's original description as human-readable context alongside the typed schema.
- *Rationale*: Tool descriptions are critical for tool selection (by agents or users). The description is the most useful metadata for understanding what a tool does. Stripping it loses essential context.
- *Verifiable by*: After importing a tool, inspecting the resulting capability shows both the typed schema and the original description text.

**R3**: Multiple tools from the same source SHALL be installable as a capability group -- inspectable and manageable as a single unit.
- *Rationale*: A tool provider like Claude Code exposes 20+ tools. Managing them individually is impractical. A group enables bulk install, uninstall, and inspection.
- *Verifiable by*: Installing a group makes all its member capabilities available. Uninstalling the group removes all of them. Inspecting the group lists all members.

**R4**: Installed capabilities SHALL be annotatable with behavioral metadata -- including safety constraints, access control conditions, and execution time characteristics -- without modifying the original tool definition.
- *Rationale*: The raw tool definition is a structural schema. Real-world usage requires additional constraints: block dangerous commands, restrict access to authorized users, record performance characteristics. These must compose on top of the original, not alter it.
- *Verifiable by*: After adding a safety constraint to an imported tool (e.g., blocking certain shell commands), the original tool definition is unchanged, the constraint is visible on inspection, and invoking a blocked command is rejected.

**R5**: Installed capabilities SHALL be discoverable by type matching -- if a task requires a capability with a specific input/output signature, any installed skill with a compatible signature SHOULD be discoverable.
- *Rationale*: Structural type matching is how the system connects needs to capabilities. A task needing "(path: string) -> {content: string}" should find any installed tool with a compatible signature.
- *Verifiable by*: After importing a "readFile" tool with signature (path: string) -> {content: string}, a search for capabilities matching that signature includes "readFile".

**R6**: Invocations of external tool capabilities SHALL be delegated to the external provider -- the system declares the invocation intent with arguments, and the external provider executes it and returns the result.
- *Rationale*: The system does not execute external tools. It describes the call; the environment or host process fulfills it. This separation preserves the boundary between declaration and execution.
- *Verifiable by*: Invoking an imported skill produces an invocation record with the capability identifier and arguments. The external provider receives this record and returns a result.

**R7**: Annotations on imported capabilities SHALL be independently removable -- removing an annotation restores the capability to its pre-annotation state.
- *Rationale*: Annotations are experimental and context-dependent. A safety constraint added for one context may not apply in another. Annotations must be reversible.
- *Verifiable by*: After adding and then removing a safety annotation, the capability behaves as it did before the annotation was added.

## Acceptance Criteria

**AC1** [R1]: Given an MCP server exposing tools {bash, readFile, writeFile} with JSON Schema inputs, when the tools are imported, then three capabilities are registered with input/output types matching the original schemas.

**AC2** [R2]: Given an imported tool with description "Execute a shell command and return stdout/stderr", when the capability is inspected, then the description text is present alongside the typed schema.

**AC3** [R3]: Given a tool provider with 5 tools imported as a group "claudeCode", when the group is uninstalled, then all 5 capabilities are removed. When the group is inspected, all 5 members are listed.

**AC4** [R4]: Given an imported "bash" capability, when a safety annotation is added blocking commands matching "rm -rf|sudo|shutdown", then invoking bash with "rm -rf /" is rejected, while invoking with "ls -la" succeeds. The original tool definition is unchanged.

**AC5** [R5]: Given imported tools {readFile: (path: string) -> {content: string}, writeFile: (path: string, content: string) -> {ok: boolean}}, when searching for capabilities matching (path: string) -> {content: string}, then readFile is found.

**AC6** [R6]: Given an imported external tool "bash", when invoked with arguments {command: "echo hello"}, then an invocation record is produced with the tool identifier and arguments, and the external provider receives and fulfills it.

**AC7** [R4, R7]: Given a "bash" capability with a safety annotation blocking "sudo", when the annotation is removed, then "sudo apt update" is no longer rejected by the annotation (though the external provider may still reject it).

## Open Questions

- How should schema format conflicts be handled when the same tool is available via both MCP and OpenAPI with slightly different schemas?
- Should capability groups support partial installation (install 3 of 5 tools from a provider)?
- What is the annotation precedence when multiple annotations conflict (e.g., one allows a command, another blocks it)?
