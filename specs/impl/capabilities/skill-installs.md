# Skill Installation (Tool Annotation Transposition)

External tools (Claude Code, Open Claude, MCP servers) publish tool definitions with schemas. Skill installation transposes these annotations into FT capability types — making them inspectable, composable, and behaviorally annotatable within the system.

## Original Notes

This refers to the capability to transpose general scale annotations that are used for general tools like Claude code or Open Claude. Make them available as capability groups or tools, or sets of capabilities that can be provisionally viewed or inspected or annotated to have certain behavioral considerations for the rest of the model.

## The Core Pattern

An external tool publishes a schema (like MCP tool definitions or OpenAPI specs). Skill installation reads these schemas and mounts them as FT capabilities:

```ft
-- External tool definition (from MCP, OpenAPI, etc.)
-- Input: the raw tool schema
ExternalToolDef = {
  name: string,
  description: string,
  inputSchema: _,      -- JSON Schema or equivalent
  outputSchema?: _
}

-- Skill install: transpose into FT capability
installSkill = (tool: ExternalToolDef) -> { ok: true
  | let ftInput = jsonSchemaToType(tool.inputSchema)
  | let ftOutput = tool.outputSchema ? jsonSchemaToType(tool.outputSchema) : any
  | capabilities HAS tool.name  @[T_out..)
  | capabilities[tool.name].input = ftInput
  | capabilities[tool.name].output = ftOutput
}
```

The transposition:
- JSON Schema `inputSchema` → FT type (via converters/jsonschema)
- Tool `description` → comment in the ft block (narrative context)
- Tool `name` → capability path
- External invocation → PendingInvocation (the tool is external, system yields to caller)

## Capability Groups

Multiple tools from the same source form a capability group — inspectable as a unit:

```ft
-- Claude Code tools as a group
claudeCodeSkills = [
  "Tools from Claude Code CLI — shell interaction, file operations, search"

  bash = (command: string) -> { stdout: string, stderr: string, exitCode: number }
  
  readFile = (path: string) -> { content: string }
  
  writeFile = (path: string, content: string) -> { ok: true }
  
  search = (pattern: string, path?: string) -> [{ file: string, line: number, content: string }]
  
  -- All are external capabilities (Claude Code executes them)
  tool bash
  tool readFile
  tool writeFile
  tool search
]
```

## Provisional Viewing and Behavioral Annotation

Installed skills can be:
- **Viewed**: inspect the capability group's types, descriptions, gap status
- **Annotated**: narrow the capabilities with behavioral predicates

```ft
-- Annotate Claude Code's bash with behavioral considerations
claudeCodeSkills << [
  bash = (command: string) -> { stdout, stderr, exitCode
    -- Safety: certain commands are gated
    | command NOT MATCHES /rm -rf|sudo|shutdown/
  } when permissions.shellAccess = true

  -- Reliability annotation from observed behavior
  readFile = (path: string) -> { content: string }
    ~lognormal(mu=3.0, sigma=0.8)
]
```

The annotation narrows the skill's type — adding behavioral predicates (safety constraints), temporal models (execution time distributions), and preconditions (permission gates). The original capability is unchanged — the annotation composes on top.

## Requirements

**R1**: The system SHALL support transposing external tool definitions (MCP, OpenAPI, JSON Schema) into FT capability types.
- *Rationale*: External tools are the primary source of agent capabilities. If they can't be imported, the system is limited to hand-written capabilities.
- *Verifiable by*: An MCP tool definition with a JSON Schema input produces a mountable FT capability with the correct input type.

**R2**: Transposed capabilities SHALL preserve the tool's description as narrative context (comments) alongside the typed schema.
- *Rationale*: Tool descriptions are critical for LLM tool selection — the description IS the prompt context. Stripping it loses the most useful metadata.
- *Verifiable by*: After skill installation, hoisting the capability includes the original description as a comment.

**R3**: Multiple tools from the same source SHALL be installable as a capability group — inspectable and manageable as a unit.
- *Rationale*: Claude Code has 20+ tools. Managing them individually is impractical. A group can be installed, uninstalled, or inspected as one.
- *Verifiable by*: Installing a group makes all its capabilities available. Uninstalling the group removes all of them.

**R4**: Installed skills SHALL be annotatable — users or the system can narrow capabilities with behavioral predicates, safety constraints, permission gates, and execution time distributions WITHOUT modifying the original tool definition.
- *Rationale*: The raw tool definition is a structural schema. Behavioral annotation adds: safety (block dangerous commands), reliability (execution time), access control (permission gates). These compose on top — they don't modify the source.
- *Verifiable by*: After annotating bash with a safety constraint, attempting a blocked command suspends instead of executing.

**R5**: External tool invocations SHALL produce PendingInvocations — the Sequence yields the invocation to the caller, who handles it externally and provides the result.
- *Rationale*: The Sequence doesn't execute external tools. It declares the need. The environment fulfills it. This IS the external capability model (C1).
- *Verifiable by*: Invoking an installed skill produces a PendingInvocation with the correct capId and args.

**R6**: The system SHALL support discovering installed skills by type matching — if a gap needs `(string) -> { content: string }`, any installed skill with a compatible signature should be discoverable.
- *Rationale*: Structural type matching is how the system finds capabilities. `compose(gap_type, skill_type) ≠ never` means the skill can fill the gap. This works automatically with the existing search/gap mechanism.
- *Verifiable by*: After installing readFile, a gap for string content traces to readFile via backward inference.

## FT System Demands

- Transposition IS converters/jsonschema → already validated (16 tests)
- Capability registration IS `mount('cap', path, true)` for external tools
- Groups ARE block types `[ ]` with named entries
- Annotation IS `<<` narrowing with behavioral predicates
- PendingInvocation IS the existing external capability model
- Discovery IS the existing `search()` / `gaps()` mechanism

This is purely a composition of existing primitives: converters (schema import) + mount/cap (registration) + << (annotation) + PendingInvocation (external execution) + search (discovery).
