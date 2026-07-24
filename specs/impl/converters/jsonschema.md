# JSON Schema Converter

JSON Schema is the lingua franca for describing data shapes across APIs, configuration files, and tool definitions. This converter translates a JSON Schema into the system's internal type representation -- same validation rules, same constraints, same structure, just in a form the system can use for backward inference, tool generation, and agent instruction.

The conversion is a pure function: same schema in, same type out, every time. Features the internal type system cannot enforce directly are preserved as metadata, never silently dropped.

## Primitive Mapping

JSON Schema primitives map one-to-one to internal primitives. These are the foundation -- every schema bottoms out here:

```ft
-- JSON Schema {"type": "string"} becomes:
jsString = string

-- JSON Schema {"type": "number"} becomes:
jsNumber = number

-- JSON Schema {"type": "integer"} becomes:
jsInteger = number.integer

-- JSON Schema {"type": "boolean"} becomes:
jsBoolean = boolean

-- JSON Schema {"type": "null"} becomes:
jsNull = null
```

The mapping is direct and lossless. Integer is represented as `number.integer` to preserve the constraint that the value must be a whole number.

## String Constraints

JSON Schema string constraints (minLength, maxLength, pattern, format) map to internal string type constraints. These are what make types useful for validation -- a string without its pattern is a lossy conversion:

```ft
-- JSON Schema {"type": "string", "minLength": 1, "maxLength": 255, "pattern": "^[a-z]+$"}
constrainedString = string /^[a-z]+$/, 1..255
```

The pattern is preserved as a regex constraint. The length range is preserved as a numeric bound. Format strings (like "email" or "date-time") that have no direct constraint equivalent are preserved as metadata annotations outside the type itself.

## Numeric Constraints

JSON Schema numeric constraints (minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf) map to internal numeric bounds:

```ft
-- JSON Schema {"type": "number", "minimum": 0, "maximum": 100}
boundedNumber = number 0..100

-- JSON Schema {"type": "integer", "minimum": 0}
positiveInteger = number.integer >= 0
```

Exclusive bounds (exclusiveMinimum, exclusiveMaximum) and multipleOf constraints are expressed as metadata annotations when the internal type system does not support them as first-class constraints.

## Object Types

JSON Schema objects with declared properties become internal object types. The required/optional distinction is preserved -- required fields use bare type declarations, optional fields use the `?` suffix:

```ft
-- JSON Schema {"type": "object", "properties": {"name": {"type": "string"}, "age": {"type": "integer"}}, "required": ["name"]}
UserObject = {
  name: string,
  age?: number.integer
}
```

The `name` field is required (it must be present). The `age` field is optional (it may be absent). Property order does not affect the resulting type.

## Array Types

JSON Schema arrays with item type declarations become internal array types. The items constraint specifies what element type is allowed:

```ft
-- JSON Schema {"type": "array", "items": {"type": "string"}}
StringArray = {
  items: string
}
```

Array count constraints (minItems, maxItems) are expressed as metadata when the internal type system does not support them as first-class bounds on collection size.

## Union and Intersection

JSON Schema composition keywords map to internal type operations. `anyOf` and `oneOf` become unions. `allOf` becomes intersections:

```ft
-- JSON Schema {"anyOf": [{"type": "string"}, {"type": "number"}]}
StringOrNumber = string | number

-- JSON Schema {"allOf": [BaseType, ExtensionType]}
-- Intersection combines all properties from both types
Combined = {
  id: number.integer,
  name: string
}
```

The difference between `anyOf` (at least one matches) and `oneOf` (exactly one matches) is a validation-time distinction. Both produce union types in the internal representation. The exclusivity constraint from `oneOf` is preserved as metadata.

## Enum Values

JSON Schema enum constraints become internal literal union types. Each allowed value is a literal in the union:

```ft
-- JSON Schema {"type": "string", "enum": ["red", "green", "blue"]}
Color = "red" | "green" | "blue"
```

Enums with mixed types (strings and numbers in the same enum) are represented as unions of literals with different types.

## Reference Resolution

JSON Schema `$ref` pointers are resolved to produce fully expanded internal types. The converter follows references to their definitions and inlines the result:

```ft
-- JSON Schema {"$ref": "#/$defs/Address"} with $defs.Address = {"type": "object", "properties": {"street": {"type": "string"}}}
import Address from "./$defs/Address"
```

Recursive references (a type that references itself, like a tree node) are handled by producing internal references that the type system can resolve without infinite expansion. External `$ref` targets (URLs) are outside the converter's scope -- only local definitions are resolved.

## Metadata Preservation

JSON Schema features that have no direct type equivalent (title, description, examples, default, readOnly, deprecated, conditional schemas) are preserved as metadata annotations. Nothing is silently dropped:

```ft
-- JSON Schema {"type": "string", "title": "User Name", "description": "Display name"}
annotatedField = string
-- title: "User Name", description: "Display name", examples: ["Alice", "Bob"]
-- These are retrievable metadata, not enforcement constraints
```

The type itself enforces the structural constraint (it must be a string). The metadata is available for display, documentation, and agent instruction but does not affect validation.

## Conversion Function

The converter is a single capability: it takes a JSON Schema and produces an internal type. The conversion is deterministic -- converting the same schema twice produces identical types:

```ft
convert = (schema: string) -> { fieldType: string }

tool convert
```

The input is the raw JSON Schema (as a string or parsed object). The output is the internal type representation. Conversion errors (unsupported features, unresolvable references) produce typed errors identifying the specific issue, not generic failure messages.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Primitives map correctly | `jsString`, `jsNumber`, `jsInteger`, `jsBoolean`, `jsNull` |
| Object with required/optional fields | `UserObject` with `name: string` and `age?: number.integer` |
| Array with item type | `StringArray` with `items: string` |
| String constraints preserved | `constrainedString` with pattern and length range |
| Numeric bounds preserved | `boundedNumber` with range, `positiveInteger` with minimum |
| anyOf becomes union | `StringOrNumber = string \| number` |
| $ref resolved to definition | `import Address from "./$defs/Address"` |
| Enum becomes literal union | `Color = "red" \| "green" \| "blue"` |
| Metadata preserved not dropped | Annotations on `annotatedField` retrievable as metadata |
| Deterministic conversion | Same schema through `convert` always produces same type |
