/**
 * builder.ts — Fluent builder API for constructing types.
 *
 * Usage:
 *   FT.string()                          → string type
 *   FT.string('hello')                   → string literal
 *   FT.string().length(1, 100)           → string with length bounds
 *   FT.number().min(0).max(100)          → bounded number
 *   FT.object({ name: FT.string() })     → object with typed properties
 *   FT.array(FT.string())                → array of strings
 *   FT.fn({ input: A, output: B })       → function type
 *   FT.or(FT.string(), FT.number())      → union type
 *   FT.any()                              → accepts anything
 *
 * The builder returns Type objects (from type.ts). Types are immutable.
 * Every builder method returns a NEW builder — no mutation.
 *
 * The design:
 *   - Consumer types FT. → sees available kinds
 *   - Picks a kind (e.g., string) → sees methods for that kind
 *   - Chains methods → each returns a new builder with accumulated constraints
 *   - The result IS a Type (the builder extends Type)
 *
 * The builder never imports the tree, merge, or store. It only knows
 * about Type and Constraint from type.ts. It's pure construction.
 */

import {
  type Type, type Kind, type Constraint, type TypeMeta,
  createType, literal, min, max, range, length, pattern,
  property, element, arrayLength, param, returns, impl,
  preserves as preservesConstraint,
  identity as identityConstraint,
  temporal as temporalConstraint,
  equation as equationConstraint,
  law as lawConstraint,
  distribution as distributionConstraint,
  prior as priorConstraint,
  ref as refConstraint, derived, segment, defaultValue,
  type Expr,
} from './type';

// ═══════════════════════════════════════════════════════════════════════
// BUILDER
// ═══════════════════════════════════════════════════════════════════════

/**
 * A TypeBuilder wraps a Type under construction.
 *
 * Every method returns a new TypeBuilder with the constraint added.
 * The builder IS a Type — it has kind, constraints, meta. You can
 * pass it anywhere a Type is expected.
 *
 * Methods are kind-specific: .min() only appears on number builders,
 * .property() only on object builders, etc. This is enforced by
 * returning typed sub-interfaces from each kind constructor.
 */
class TypeBuilder implements Type {
  readonly kind: Kind;
  readonly constraints: readonly Constraint[];
  readonly meta?: TypeMeta;

  constructor(kind: Kind, constraints: readonly Constraint[] = [], meta?: TypeMeta) {
    this.kind = kind;
    this.constraints = constraints;
    this.meta = meta;
  }

  /** Create a new builder with an additional constraint. */
  protected with(constraint: Constraint): this {
    return this._clone([...this.constraints, constraint], this.meta) as this;
  }

  /** Create a new builder with updated meta. */
  protected withMeta(update: Partial<TypeMeta>): this {
    return this._clone(this.constraints, { ...this.meta, ...update }) as this;
  }

  /** Override in subclasses to return the correct subtype. */
  protected _clone(constraints: readonly Constraint[], meta?: TypeMeta): TypeBuilder {
    return new TypeBuilder(this.kind, constraints, meta);
  }

  // ── Common methods (all kinds) ────────────────────────────────────

  /** Set a literal value. The type only accepts this exact value. */
  literal(value: unknown): this { return this.with(literal(value)); }

  /** Set the human-readable description. */
  description(desc: string): this { return this.withMeta({ description: desc }); }

  /** Set the type name (used in hoisting and display). */
  name(name: string): this { return this.withMeta({ name }); }

  /** Attach arbitrary metadata. */
  annotate(key: string, value: unknown): this { return this.withMeta({ [key]: value }); }

  /** Convert to plain Type (strips builder methods). */
  toType(): Type { return createType(this.kind, [...this.constraints], this.meta ? { ...this.meta } : undefined); }
}

// ═══════════════════════════════════════════════════════════════════════
// KIND-SPECIFIC BUILDERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * String type builder.
 *
 * Methods: .literal(), .length(), .pattern(), .description()
 */
class StringBuilder extends TypeBuilder {
  constructor(constraints: readonly Constraint[] = [], meta?: TypeMeta) {
    super('string', constraints, meta);
  }
  protected _clone(c: readonly Constraint[], m?: TypeMeta) { return new StringBuilder(c, m); }

  /** String length bounds. length(max) or length(min, max). */
  length(minOrMax: number, maxLen?: number): StringBuilder {
    if (maxLen === undefined) return new StringBuilder([...this.constraints, length(undefined, minOrMax)], this.meta);
    return new StringBuilder([...this.constraints, length(minOrMax, maxLen)], this.meta);
  }

  /** String must match regex pattern. */
  pattern(re: string): StringBuilder {
    return new StringBuilder([...this.constraints, pattern(re)], this.meta);
  }
}

/**
 * Number type builder.
 *
 * Methods: .literal(), .min(), .max(), .range(), .integer(),
 *          .description()
 */
class NumberBuilder extends TypeBuilder {
  constructor(constraints: readonly Constraint[] = [], meta?: TypeMeta) {
    super('number', constraints, meta);
  }
  protected _clone(c: readonly Constraint[], m?: TypeMeta) { return new NumberBuilder(c, m); }

  /** Minimum value (inclusive). */
  min(value: number): NumberBuilder {
    return new NumberBuilder([...this.constraints, min(value)], this.meta);
  }

  /** Maximum value (inclusive). */
  max(value: number): NumberBuilder {
    return new NumberBuilder([...this.constraints, max(value)], this.meta);
  }

  /** Range: min and max (inclusive). */
  range(lo: number, hi: number): NumberBuilder {
    return new NumberBuilder([...this.constraints, range(lo, hi)], this.meta);
  }

  /** Must be integer. */
  integer(): NumberBuilder {
    return new NumberBuilder([...this.constraints, { op: 'integer', args: [] }], this.meta);
  }

}

/**
 * Boolean type builder.
 */
class BooleanBuilder extends TypeBuilder {
  constructor(constraints: readonly Constraint[] = [], meta?: TypeMeta) {
    super('boolean', constraints, meta);
  }
  protected _clone(c: readonly Constraint[], m?: TypeMeta) { return new BooleanBuilder(c, m); }
}

/**
 * Null type builder.
 */
class NullBuilder extends TypeBuilder {
  constructor(constraints: readonly Constraint[] = [], meta?: TypeMeta) {
    super('null', constraints, meta);
  }
  protected _clone(c: readonly Constraint[], m?: TypeMeta) { return new NullBuilder(c, m); }
}

/**
 * Object type builder.
 *
 * Constructed from a shape: FT.object({ name: FT.string(), 'age?': FT.number() })
 * The '?' suffix marks optional properties.
 */
class ObjectBuilder extends TypeBuilder {
  constructor(constraints: readonly Constraint[] = [], meta?: TypeMeta) {
    super('object', constraints, meta);
  }
  protected _clone(c: readonly Constraint[], m?: TypeMeta) { return new ObjectBuilder(c, m); }

  /**
   * Add a property constraint.
   *
   * Usually not called directly — use FT.object({ ... }) instead.
   * This is for programmatic property addition.
   */
  prop(key: string, type: Type, optional = false): ObjectBuilder {
    return new ObjectBuilder([...this.constraints, property(key, type, optional)], this.meta);
  }

  /**
   * Add a description to a property.
   *
   * @param key — the property name
   * @param desc — the description string
   */
  describe(key: string, desc: string): ObjectBuilder {
    return new ObjectBuilder(
      [...this.constraints, { op: 'describe', args: [key, desc] }],
      this.meta,
    );
  }

  /**
   * Scope-level equation: cross-function identity with temporal bounds.
   *
   * @example
   *   FT.object({
   *     setReport: FT.fn({ ... }),
   *     getReport: FT.fn({ ... }),
   *   }).eq('getReport($setReport)', '$setReport.input', {
   *     from: path('setReport._t'),
   *     reliability: call('decay', path('_elapsed')),
   *   })
   *
   * ∀ r . getReport(setReport(r)) ≡ r @ t > t_set, P = decay(t - t_set)
   */
  eq(lhs: string, rhs: string, opts?: { from?: Expr; until?: Expr; reliability?: Expr }): ObjectBuilder {
    return new ObjectBuilder(
      [...this.constraints, equationConstraint(lhs, rhs, opts)],
      this.meta,
    );
  }

  /**
   * Behavioral law: cross-method implication.
   *
   * @example
   *   FT.object({ set: FT.fn(...), get: FT.fn(...) })
   *     .law({
   *       trigger: 'set($value) => $id',
   *       implies: 'get($id) => $value',
   *       activation: temporal('gt', '_rt', add('_trigger._t', 0)),
   *       confidence: distribution('reliability', 'exponential', { rate: 0 }),
   *       terminates: 'delete($id)',
   *     })
   */
  law(spec: {
    trigger: string;
    implies: string;
    activation?: Constraint;
    confidence?: Constraint;
    terminates?: string;
  }): ObjectBuilder {
    return new ObjectBuilder(
      [...this.constraints, lawConstraint(spec)],
      this.meta,
    );
  }
}

/**
 * Array type builder.
 *
 * Constructed with element type: FT.array(FT.string())
 */
class ArrayBuilder extends TypeBuilder {
  constructor(constraints: readonly Constraint[] = [], meta?: TypeMeta) {
    super('array', constraints, meta);
  }
  protected _clone(c: readonly Constraint[], m?: TypeMeta) { return new ArrayBuilder(c, m); }

  /** Min and max element count. */
  length(minLen?: number, maxLen?: number): ArrayBuilder {
    return new ArrayBuilder([...this.constraints, arrayLength(minLen, maxLen)], this.meta);
  }
}

/**
 * Function type builder.
 *
 * Constructed with: FT.fn({ input: Type, output: Type, impl?: string, description?: string })
 */
class FnBuilder extends TypeBuilder {
  constructor(constraints: readonly Constraint[] = [], meta?: TypeMeta) {
    super('fn', constraints, meta);
  }
  protected _clone(c: readonly Constraint[], m?: TypeMeta) { return new FnBuilder(c, m); }
}

/**
 * Union type builder.
 *
 * Constructed with: FT.or(FT.string(), FT.number())
 */
class OrBuilder extends TypeBuilder {
  constructor(constraints: readonly Constraint[] = [], meta?: TypeMeta) {
    super('or', constraints, meta);
  }
  protected _clone(c: readonly Constraint[], m?: TypeMeta) { return new OrBuilder(c, m); }
}

// ═══════════════════════════════════════════════════════════════════════
// FT — THE PUBLIC BUILDER API
// ═══════════════════════════════════════════════════════════════════════

/**
 * FT: the type builder namespace.
 *
 * Usage:
 *   FT.string()                     → StringBuilder
 *   FT.string('hello')              → StringBuilder with literal 'hello'
 *   FT.number()                     → NumberBuilder
 *   FT.number(42)                   → NumberBuilder with literal 42
 *   FT.boolean()                    → BooleanBuilder
 *   FT.null()                       → NullBuilder
 *   FT.object({ k: Type, ... })     → ObjectBuilder with properties
 *   FT.array(elementType)           → ArrayBuilder with element type
 *   FT.fn({ input, output, ... })   → FnBuilder with params
 *   FT.or(a, b, ...)                → OrBuilder with branches
 *   FT.any()                        → any type
 *   FT.never(reason?)               → never type
 */
export const FT = {

  /**
   * String type.
   * @param value — optional literal value
   */
  string(value?: string): StringBuilder {
    if (value !== undefined) return new StringBuilder([literal(value)]);
    return new StringBuilder();
  },

  /**
   * Number type.
   * @param value — optional literal value
   */
  number(value?: number): NumberBuilder {
    if (value !== undefined) return new NumberBuilder([literal(value)]);
    return new NumberBuilder();
  },

  /** Boolean type. */
  boolean(value?: boolean): BooleanBuilder {
    if (value !== undefined) return new BooleanBuilder([literal(value)]);
    return new BooleanBuilder();
  },

  /** Null type. */
  null(): NullBuilder {
    return new NullBuilder([literal(null)]);
  },

  /**
   * Object type from a shape.
   *
   * Keys ending in '?' are optional.
   * Values are Type objects (or builders — they implement Type).
   *
   * @example
   *   FT.object({ name: FT.string(), 'age?': FT.number() })
   */
  object(shape?: Record<string, Type>): ObjectBuilder {
    if (!shape) return new ObjectBuilder();
    const constraints: Constraint[] = [];
    for (const [rawKey, type] of Object.entries(shape)) {
      const optional = rawKey.endsWith('?');
      const key = optional ? rawKey.slice(0, -1) : rawKey;
      constraints.push(property(key, type, optional));
    }
    return new ObjectBuilder(constraints);
  },

  /**
   * Array type with element type.
   *
   * @example
   *   FT.array(FT.string())
   *   FT.array(FT.number()).length(1, 10)
   */
  array(elementType: Type): ArrayBuilder {
    return new ArrayBuilder([element(elementType)]);
  },

  /**
   * Function type.
   *
   * @param spec.input  — input type (what the function accepts)
   * @param spec.output — output type (what the function returns)
   * @param spec.impl   — implementation identifier (string ref, not a live function)
   * @param spec.description — human-readable description
   *
   * @example
   *   FT.fn({ input: FT.object({ query: FT.string() }), output: FT.array(FT.any()) })
   */
  fn(spec: {
    input?: Type;
    output?: Type;
    impl?: string;
    description?: string;
    /** Structural preservation: which input type constraints appear in output.
     *  '*' = all input properties pass through (T → T & Effects).
     *  Array of [inputPath, outputPath] for specific mappings. */
    preserves?: '*' | [string, string?][];
    /** Value identity: output.X === input.Y (value equality, not just type).
     *  Array of [outputPath, inputPath]. '.' = root.
     *  Enables backward inference: if output.X must be V, then input.Y must be V. */
    identity?: [string, string][];
    /** Temporal bounds as inequalities on _rt.
     *  Each is [dir, lhs, bound]:
     *    ['gt', '_rt', add('_rt.input', 2000)]  → available WHEN _rt > Ti + 2000ms
     *    ['lt', '_rt', add('_rt.input', 86400000)] → valid WHILE _rt < Ti + 24h
     *  Compose tightens: gt takes max bound, lt takes min bound. */
    temporal?: ['gt' | 'lt', string, Expr][];
  }): FnBuilder {
    const constraints: Constraint[] = [];
    if (spec.input) constraints.push(param(spec.input));
    if (spec.output) constraints.push(returns(spec.output));
    if (spec.impl) constraints.push(impl(spec.impl));
    if (spec.preserves === '*') {
      constraints.push(preservesConstraint('*'));
    } else if (Array.isArray(spec.preserves)) {
      for (const mapping of spec.preserves) {
        constraints.push(preservesConstraint(mapping[0], mapping[1]));
      }
    }
    if (spec.identity) {
      for (const [outPath, inPath] of spec.identity) {
        constraints.push(identityConstraint(outPath, inPath));
      }
    }
    if (spec.temporal) {
      for (const [dir, lhs, bound] of spec.temporal) {
        constraints.push(temporalConstraint(dir, lhs, bound));
      }
    }
    const meta = spec.description ? { description: spec.description } : undefined;
    return new FnBuilder(constraints, meta);
  },

  /**
   * Union type (OR).
   *
   * @example
   *   FT.or(FT.string(), FT.number())
   */
  or(...branches: Type[]): OrBuilder {
    const constraints: Constraint[] = branches.map(b => ({ op: 'branch', args: [b] }));
    return new OrBuilder(constraints);
  },

  /** Any type — accepts everything. */
  any(): TypeBuilder {
    return new TypeBuilder('any');
  },

  /** Never type — accepts nothing. */
  never(reason?: string): TypeBuilder {
    return new TypeBuilder('never', [], reason ? { reason } : undefined);
  },

  /**
   * Segmented type: a sequence of named regions, each with its own
   * type, budget, and mutation policy.
   *
   * Used for: prompt templates, structured strings, document sections.
   *
   * @param segments — array of segment specs
   *
   * @example
   *   FT.segmented([
   *     { name: 'header', type: FT.string('Welcome'), budget: 100 },
   *     { name: 'body', type: FT.string(), budget: 4000, mutations: ['expand', 'compress'] },
   *     { name: 'footer', type: FT.string(), locked: true },
   *   ])
   */
  segmented(segments: ({
    name?: string;
    type: Type;
    budget?: number;
    mutations?: string[];
    locked?: boolean;
    spread?: boolean;
  } | Type)[]): ArrayBuilder {
    const constraints: Constraint[] = segments.map((s, i) => {
      if ('kind' in s) {
        // Plain Type — positional segment
        return segment(String(i), s);
      }
      return segment(s.name ?? String(i), s.type, {
        budget: s.budget, mutations: s.mutations, locked: s.locked,
      });
    });
    return new ArrayBuilder(constraints);
  },

  /**
   * Default: applies a value only if the target position has no concrete value.
   *
   * Used for: fallback values, template defaults, configuration inheritance.
   *
   * @param shape — object mapping paths to default values
   *
   * @example
   *   FT.defaults({ model: 'gpt-4', maxTokens: 1000, verbose: false })
   */
  defaults(shape: Record<string, unknown>): ObjectBuilder {
    const constraints: Constraint[] = [];
    for (const [key, value] of Object.entries(shape)) {
      constraints.push(property(key, createType('any', [literal(value), defaultValue(value)]), true));
    }
    return new ObjectBuilder(constraints);
  },

  /**
   * Ref type: this position derives its value from another path.
   *
   * When the tree reads this position, it follows the source path.
   * If the source doesn't exist, this position is a gap.
   *
   * @param source — the path this position reads from
   * @param outputType — optional: what type the resolved value should be
   *
   * @example
   *   FT.ref('tasks.t1.output')
   *   FT.ref('config.model', FT.string())
   */
  ref(source: string, outputType?: Type): TypeBuilder {
    const constraints: Constraint[] = [refConstraint(source)];
    if (outputType) {
      // The output type constrains what the ref must resolve to
      constraints.push(...outputType.constraints);
    }
    return new TypeBuilder('any', constraints);
  },

  /**
   * Derived type: this position's value is computed by calling a function.
   *
   * The function is identified by string ID. The arguments are paths
   * in the tree. When all argument paths have concrete values AND the
   * function impl is registered, the derived value can be computed.
   *
   * @param fnId — the tool ID
   * @param argPaths — paths to read as arguments
   *
   * @example
   *   FT.derived('summarize', 'tasks.t1.input')
   *   FT.derived('add', 'a', 'b')
   */
  derived(fnId: string, ...argPaths: string[]): TypeBuilder {
    return new TypeBuilder('any', [derived(fnId, ...argPaths)]);
  },
};
