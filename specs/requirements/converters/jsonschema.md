# JSON Schema Converter

JSON Schema is the lingua franca for describing data shapes across APIs, configuration files, and tool definitions. This converter translates a JSON Schema into the system's internal type representation -- same validation rules, same constraints, same structure, just in a form the system can use for backward inference, tool generation, and agent instruction.

The conversion is a pure function: same schema in, same type out, every time. Features the internal type system cannot enforce directly are preserved as metadata, never silently dropped.

## Problem Context

- **Actor(s)**: External systems that publish JSON Schemas (APIs, config files, tool definitions); the converter; internal processes that consume the resulting types for validation, inference, and code generation.
- **Domain**: Schema translation -- converting the JSON Schema vocabulary into internal type representations while preserving all semantic information.
- **Core Tension**: JSON Schema is expressive (composition keywords, conditional schemas, recursive references, format annotations) but the internal type system may not have a direct equivalent for every feature. The converter must be lossless in intent -- what it cannot enforce structurally, it must preserve as retrievable metadata. Silently dropping information is unacceptable.

## Requirements

**R1**: JSON Schema primitives (`string`, `number`, `integer`, `boolean`, `null`) SHALL map one-to-one to internal type primitives.
- *Rationale*: Primitives are the foundation of every schema. A lossy primitive mapping corrupts everything built on top of it.
- *Verifiable by*: Converting `{"type": "string"}` produces an internal string type. Converting `{"type": "integer"}` produces an internal integer type (not just number).

**R2**: String constraints (minLength, maxLength, pattern) SHALL be preserved in the internal type representation.
- *Rationale*: A string without its pattern constraint is a lossy conversion. Constraints are what make types useful for validation.
- *Verifiable by*: Converting `{"type": "string", "minLength": 1, "maxLength": 255, "pattern": "^[a-z]+$"}` produces an internal type that enforces all three constraints.

**R3**: Numeric constraints (minimum, maximum, exclusiveMinimum, exclusiveMaximum) SHALL be preserved. The `multipleOf` constraint SHALL be preserved at minimum as metadata.
- *Rationale*: Numeric bounds are critical for validation. `minimum: 0` on a salary field prevents negative values.
- *Verifiable by*: Converting `{"type": "number", "minimum": 0, "maximum": 100}` produces an internal type that rejects -1 and 101.

**R4**: JSON Schema objects with declared properties SHALL convert to internal object types, preserving the required/optional distinction for each field.
- *Rationale*: Required vs optional is a structural constraint. Treating all fields as optional when some are required breaks validation.
- *Verifiable by*: Converting `{"type": "object", "properties": {"name": {"type": "string"}, "age": {"type": "integer"}}, "required": ["name"]}` produces a type where `name` is required and `age` is optional.

**R5**: JSON Schema arrays with item type declarations SHALL convert to internal array types that enforce the element type.
- *Rationale*: An array of strings is a different type than an array of numbers. The item constraint must carry through conversion.
- *Verifiable by*: Converting `{"type": "array", "items": {"type": "string"}}` produces a type that rejects an array containing a number element.

**R6**: JSON Schema composition keywords SHALL map to internal type operations: `anyOf`/`oneOf` to union types, `allOf` to intersection types.
- *Rationale*: Composition is how complex schemas are built from simpler ones. Without composition support, the converter cannot handle real-world schemas.
- *Verifiable by*: Converting `{"anyOf": [{"type": "string"}, {"type": "number"}]}` produces a union type that accepts both strings and numbers.

**R7**: The `oneOf` exclusivity constraint (exactly one branch matches, not just at-least-one) SHALL be preserved as metadata even if the internal type system represents it identically to `anyOf`.
- *Rationale*: `oneOf` and `anyOf` have different validation semantics. Silently collapsing them loses the producer's intent.
- *Verifiable by*: Converting a `oneOf` schema and inspecting its metadata shows the exclusivity constraint is preserved.

**R8**: JSON Schema `enum` constraints SHALL convert to literal union types where each allowed value is a distinct literal.
- *Rationale*: Enums are a fundamental constraint pattern. A field that accepts only "red", "green", or "blue" must reject "purple".
- *Verifiable by*: Converting `{"type": "string", "enum": ["red", "green", "blue"]}` produces a type that accepts "red" and rejects "purple".

**R9**: JSON Schema `$ref` pointers to local definitions SHALL be resolved to produce fully expanded internal types. Recursive references (a type that references itself) SHALL be handled without infinite expansion.
- *Rationale*: `$ref` is how JSON Schema avoids duplication. The converter must follow references to produce complete types. Tree-like structures (nodes referencing nodes) are recursive and must terminate.
- *Verifiable by*: A schema with `$ref: "#/$defs/Address"` produces the same internal type as if the Address definition were inlined. A recursive tree-node schema does not cause infinite expansion.

**R10**: External `$ref` targets (URLs pointing to schemas outside the current document) SHALL be explicitly out of scope for this converter. Encountering one SHALL produce a clear error, not a silent failure.
- *Rationale*: External schema resolution involves network I/O, caching, and versioning concerns that are outside the converter's responsibility.
- *Verifiable by*: A schema with `$ref: "https://example.com/schema.json"` produces an error identifying the unsupported external reference.

**R11**: JSON Schema features without a direct type equivalent (title, description, examples, default, readOnly, deprecated, conditional schemas like `if`/`then`/`else`) SHALL be preserved as retrievable metadata annotations, NEVER silently dropped.
- *Rationale*: These features carry important information for documentation, agent instruction, and UI generation. Dropping them reduces the value of the conversion.
- *Verifiable by*: Converting a schema with `title`, `description`, and `examples` produces a type whose metadata includes all three, accessible for display or instruction.

**R12**: The conversion SHALL be deterministic -- converting the same JSON Schema twice SHALL produce identical internal types.
- *Rationale*: Non-deterministic conversion would break caching, equality checks, and any process that depends on stable type identities.
- *Verifiable by*: Converting the same schema 100 times produces 100 identical results.

**R13**: Conversion errors (unsupported features, unresolvable references) SHALL produce typed errors identifying the specific issue, NOT generic failure messages.
- *Rationale*: "Conversion failed" is unhelpful. "Unsupported feature: if/then/else at path $.properties.discount" is actionable.
- *Verifiable by*: A schema using an unsupported feature produces an error message that names the feature and its location in the schema.

## Acceptance Criteria

**AC1** [R1]: Given `{"type": "string"}`, when converted, then the result is an internal string type.

**AC2** [R1]: Given `{"type": "integer"}`, when converted, then the result is an internal integer type (distinct from a general number type).

**AC3** [R2]: Given `{"type": "string", "minLength": 1, "maxLength": 255, "pattern": "^[a-z]+$"}`, when converted, then the internal type rejects empty strings, strings longer than 255, and strings containing uppercase letters.

**AC4** [R3]: Given `{"type": "number", "minimum": 0, "maximum": 100}`, when converted, then the internal type rejects -1 and 101.

**AC5** [R4]: Given `{"type": "object", "properties": {"name": {"type": "string"}, "age": {"type": "integer"}}, "required": ["name"]}`, when converted, then validating `{age: 25}` (missing required `name`) fails.

**AC6** [R5]: Given `{"type": "array", "items": {"type": "string"}}`, when converted, then validating `["a", 1]` fails due to the number element.

**AC7** [R6]: Given `{"anyOf": [{"type": "string"}, {"type": "number"}]}`, when converted, then the type accepts both `"hello"` and `42`.

**AC8** [R8]: Given `{"type": "string", "enum": ["red", "green", "blue"]}`, when converted, then the type accepts `"red"` and rejects `"purple"`.

**AC9** [R9]: Given a schema with `$ref: "#/$defs/Address"` where `$defs.Address = {"type": "object", "properties": {"street": {"type": "string"}}}`, when converted, then the result is an object type with a `street: string` field.

**AC10** [R11]: Given `{"type": "string", "title": "User Name", "description": "Display name", "examples": ["Alice", "Bob"]}`, when converted, then the type's metadata includes title, description, and examples.

**AC11** [R12]: Given any JSON Schema, when converted twice, then the two results are identical.

**AC12** [R10]: Given a schema with `$ref: "https://example.com/schema.json"`, when conversion is attempted, then an error is produced identifying the unsupported external reference.

## FT System Demands

- String format annotations (e.g., `"format": "email"`, `"format": "date-time"`) have no direct type enforcement equivalent. The type system needs a metadata layer for non-enforceable annotations.
- Array count constraints (minItems, maxItems) and the `uniqueItems` constraint need either first-class support or a metadata path.
- `additionalProperties` control (allowing or disallowing extra fields beyond declared properties) may need type system support for open vs closed object types.
