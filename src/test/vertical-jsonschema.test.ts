/**
 * vertical-jsonschema.test.ts — Validates that the FT type system can express
 * JSON Schema → FT Type conversion. No new framework code — just compositions
 * of existing primitives (type.ts, compose.ts, builder.ts).
 *
 * Each test maps to an acceptance criterion from impl/converters/jsonschema.md.
 */

import { FT } from '../builder';
import { type Type, createType, literal, property, element, arrayLength, constraintOf, constraintsOf, literalValue } from '../type';
import { compose, check, typeSpecificity } from '../compose';

// ═══════════════════════════════════════════════════════════════════════
// CONVERTER — JSON Schema → FT Type (pure function, no framework code)
// ═══════════════════════════════════════════════════════════════════════

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  enum?: unknown[];
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  title?: string;
  description?: string;
  examples?: unknown[];
  default?: unknown;
};

function jsonSchemaToType(schema: JsonSchema, defs?: Record<string, JsonSchema>): Type {
  const allDefs = defs ?? schema.$defs ?? {};

  // $ref resolution
  if (schema.$ref) {
    const refPath = schema.$ref.replace('#/$defs/', '');
    const resolved = allDefs[refPath];
    if (!resolved) return FT.never(`unresolved $ref: ${schema.$ref}`);
    return jsonSchemaToType(resolved, allDefs);
  }

  // Composition keywords
  if (schema.allOf) {
    return schema.allOf
      .map(s => jsonSchemaToType(s, allDefs))
      .reduce((a, b) => compose(a, b));
  }
  if (schema.anyOf || schema.oneOf) {
    const branches = (schema.anyOf ?? schema.oneOf)!;
    return FT.or(...branches.map(s => jsonSchemaToType(s, allDefs)));
  }

  // Enum → union of literals
  if (schema.enum) {
    if (schema.enum.length === 1) {
      return fromLiteral(schema.enum[0], schema);
    }
    return FT.or(...schema.enum.map(v => fromLiteral(v, schema)));
  }

  // Metadata
  const meta: Record<string, unknown> = {};
  if (schema.title) meta.name = schema.title;
  if (schema.description) meta.description = schema.description;
  if (schema.examples) meta.examples = schema.examples;
  const hasMeta = Object.keys(meta).length > 0;

  // Primitives + constraints
  switch (schema.type) {
    case 'string': {
      let t = FT.string();
      if (schema.minLength !== undefined || schema.maxLength !== undefined) t = t.length(schema.minLength, schema.maxLength);
      if (schema.pattern) t = t.pattern(schema.pattern);
      if (schema.default !== undefined) return addMeta(addDefault(t, schema.default), hasMeta ? meta : undefined);
      return addMeta(t, hasMeta ? meta : undefined);
    }
    case 'number': case 'integer': {
      let t = schema.type === 'integer' ? FT.number().integer() : FT.number();
      if (schema.minimum !== undefined) t = t.min(schema.minimum);
      if (schema.maximum !== undefined) t = t.max(schema.maximum);
      if (schema.exclusiveMinimum !== undefined) t = t.min(schema.exclusiveMinimum + (schema.type === 'integer' ? 1 : 0.000001));
      if (schema.exclusiveMaximum !== undefined) t = t.max(schema.exclusiveMaximum - (schema.type === 'integer' ? 1 : 0.000001));
      return addMeta(t, hasMeta ? meta : undefined);
    }
    case 'boolean': return addMeta(FT.boolean(), hasMeta ? meta : undefined);
    case 'null': return addMeta(FT.null(), hasMeta ? meta : undefined);
    case 'object': {
      const props: Record<string, Type> = {};
      const required = new Set(schema.required ?? []);
      for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
        const propKey = required.has(key) ? key : `${key}?`;
        props[propKey] = jsonSchemaToType(propSchema, allDefs);
      }
      return addMeta(FT.object(props), hasMeta ? meta : undefined);
    }
    case 'array': {
      let t = schema.items ? FT.array(jsonSchemaToType(schema.items, allDefs)) : FT.array(FT.any());
      if (schema.minItems !== undefined || schema.maxItems !== undefined) t = t.length(schema.minItems, schema.maxItems);
      return addMeta(t, hasMeta ? meta : undefined);
    }
    default:
      return addMeta(FT.any(), hasMeta ? meta : undefined);
  }
}

function fromLiteral(value: unknown, _schema: JsonSchema): Type {
  if (typeof value === 'string') return FT.string(value);
  if (typeof value === 'number') return FT.number(value);
  if (typeof value === 'boolean') return FT.boolean(value);
  if (value === null) return FT.null();
  return FT.any();
}

function addMeta(type: Type, meta?: Record<string, unknown>): Type {
  if (!meta) return type;
  return createType(type.kind, [...type.constraints], { ...type.meta, ...meta });
}

function addDefault(type: Type, value: unknown): Type {
  return createType(type.kind, [...type.constraints, { op: 'default', args: [value] }], type.meta);
}

// ═══════════════════════════════════════════════════════════════════════
// TESTS — each maps to an acceptance criterion
// ═══════════════════════════════════════════════════════════════════════

describe('JSON Schema → FT Type conversion', () => {

  // AC1 [R1]: primitive types
  test('AC1: primitive string', () => {
    const t = jsonSchemaToType({ type: 'string' });
    expect(t.kind).toBe('string');
  });

  test('AC1: primitive number', () => {
    const t = jsonSchemaToType({ type: 'number' });
    expect(t.kind).toBe('number');
  });

  test('AC1: primitive boolean', () => {
    const t = jsonSchemaToType({ type: 'boolean' });
    expect(t.kind).toBe('boolean');
  });

  test('AC1: primitive null', () => {
    const t = jsonSchemaToType({ type: 'null' });
    expect(t.kind).toBe('null');
  });

  // AC2 [R2]: object with required and optional fields
  test('AC2: object with required and optional properties', () => {
    const t = jsonSchemaToType({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name'],
    });
    expect(t.kind).toBe('object');
    const props = constraintsOf(t, 'property');
    const nameProp = props.find(c => c.args[0] === 'name');
    const ageProp = props.find(c => c.args[0] === 'age');
    expect(nameProp).toBeDefined();
    expect(ageProp).toBeDefined();
    expect(nameProp!.args[2]).toBe(false); // required
    expect(ageProp!.args[2]).toBe(true);   // optional
    expect((nameProp!.args[1] as Type).kind).toBe('string');
    expect((ageProp!.args[1] as Type).kind).toBe('number');
  });

  // AC3 [R3]: array with item type and count bounds
  test('AC3: array of numbers with bounds', () => {
    const t = jsonSchemaToType({
      type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 100,
    });
    expect(t.kind).toBe('array');
    const elem = constraintOf(t, 'element');
    expect(elem).toBeDefined();
    expect((elem!.args[0] as Type).kind).toBe('number');
    const len = constraintOf(t, 'arrayLength');
    expect(len).toBeDefined();
    expect(len!.args[0]).toBe(1);
    expect(len!.args[1]).toBe(100);
  });

  // AC4 [R4]: string constraints
  test('AC4: string with length and pattern constraints', () => {
    const t = jsonSchemaToType({
      type: 'string', minLength: 1, maxLength: 255, pattern: '^[a-z]+$',
    });
    expect(t.kind).toBe('string');
    const len = constraintOf(t, 'length');
    expect(len!.args[0]).toBe(1);
    expect(len!.args[1]).toBe(255);
    const pat = constraintOf(t, 'pattern');
    expect(pat!.args[0]).toBe('^[a-z]+$');
  });

  // AC5 [R5]: numeric constraints
  test('AC5: number with min/max', () => {
    const t = jsonSchemaToType({ type: 'number', minimum: 0, maximum: 100 });
    expect(t.kind).toBe('number');
    const mn = constraintOf(t, 'min');
    const mx = constraintOf(t, 'max');
    expect(mn!.args[0]).toBe(0);
    expect(mx!.args[0]).toBe(100);
  });

  // AC6 [R6]: union via anyOf
  test('AC6: anyOf produces union type', () => {
    const t = jsonSchemaToType({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(t.kind).toBe('or');
    const branches = constraintsOf(t, 'branch');
    expect(branches.length).toBe(2);
    expect((branches[0].args[0] as Type).kind).toBe('string');
    expect((branches[1].args[0] as Type).kind).toBe('number');
  });

  // AC7 [R7]: $ref resolution
  test('AC7: $ref resolves to definition', () => {
    const t = jsonSchemaToType({
      $ref: '#/$defs/Address',
      $defs: {
        Address: { type: 'object', properties: { street: { type: 'string' } }, required: ['street'] },
      },
    });
    expect(t.kind).toBe('object');
    const streetProp = constraintsOf(t, 'property').find(c => c.args[0] === 'street');
    expect(streetProp).toBeDefined();
    expect((streetProp!.args[1] as Type).kind).toBe('string');
  });

  // AC8 [R8]: enum → literal union
  test('AC8: enum produces literal union', () => {
    const t = jsonSchemaToType({ type: 'string', enum: ['red', 'green', 'blue'] });
    expect(t.kind).toBe('or');
    const branches = constraintsOf(t, 'branch');
    expect(branches.length).toBe(3);
    // Each branch is a literal string
    for (const b of branches) {
      expect((b.args[0] as Type).kind).toBe('string');
      expect(literalValue(b.args[0] as Type)).toBeDefined();
    }
    const values = branches.map(b => literalValue(b.args[0] as Type));
    expect(values).toEqual(expect.arrayContaining(['red', 'green', 'blue']));
  });

  // AC9 [R9]: metadata preservation
  test('AC9: title, description, examples preserved as metadata', () => {
    const t = jsonSchemaToType({
      type: 'string', title: 'User Name', description: 'Display name', examples: ['Alice', 'Bob'],
    });
    expect(t.meta?.name).toBe('User Name');
    expect(t.meta?.description).toBe('Display name');
    expect(t.meta?.examples).toEqual(['Alice', 'Bob']);
  });

  // AC10 [R10]: determinism
  test('AC10: same schema produces identical types', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } },
      required: ['name'],
    };
    const t1 = jsonSchemaToType(schema);
    const t2 = jsonSchemaToType(schema);
    expect(JSON.stringify(t1)).toBe(JSON.stringify(t2));
  });

  // T1: converted type validates data correctly
  test('T1: converted object type validates correct and incorrect data', () => {
    const t = jsonSchemaToType({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number', minimum: 0 },
      },
      required: ['name'],
    });
    // Valid: required name present, optional age within bounds
    expect(check(t, { name: 'Alice', age: 25 }).ok).toBe(true);
    // Valid: optional age omitted
    expect(check(t, { name: 'Bob' }).ok).toBe(true);
    // Invalid: required name missing
    expect(check(t, { age: 25 }).ok).toBe(false);
    // Invalid: age below minimum
    expect(check(t, { name: 'Eve', age: -5 }).ok).toBe(false);
  });

  // T3: allOf composition
  test('T3: allOf merges object types', () => {
    const t = jsonSchemaToType({
      allOf: [
        { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      ],
    });
    expect(t.kind).toBe('object');
    const props = constraintsOf(t, 'property');
    expect(props.some(c => c.args[0] === 'id')).toBe(true);
    expect(props.some(c => c.args[0] === 'name')).toBe(true);
  });

  // Validate that converted types work with compose
  test('composed converted types tighten correctly', () => {
    const stringSchema = jsonSchemaToType({ type: 'string', minLength: 1 });
    const patternSchema = jsonSchemaToType({ type: 'string', pattern: '^[a-z]+$' });
    const combined = compose(stringSchema, patternSchema);
    expect(combined.kind).toBe('string');
    // Has both length and pattern constraints
    expect(constraintOf(combined, 'length')).toBeDefined();
    expect(constraintOf(combined, 'pattern')).toBeDefined();
  });
});
