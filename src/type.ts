/**
 * type.ts — The type representation.
 *
 * A type is a serializable constraint set that describes what values
 * are valid at a position in the tree. Types are inert data. They do
 * not mutate, resolve refs, or execute. Those operations happen in
 * merge.ts when the tree checks a value against a type.
 *
 * A type has:
 *   kind        — the base shape: 'string', 'number', 'boolean', 'null',
 *                 'object', 'array', 'fn', 'any', 'never', 'or'
 *   constraints — an array of { op, args } predicates on the value
 *   meta        — description, name, visibility, and other annotations
 *
 * Constraints are serializable. Every constraint is { op: string, args: unknown[] }.
 * The `op` determines what the constraint checks. The `args` are the parameters.
 * No constraint contains a live function — only identifiers (refs to capabilities).
 *
 * This file defines the data shape. The builder is in builder.ts.
 */

// ═══════════════════════════════════════════════════════════════════════
// TYPE
// ═══════════════════════════════════════════════════════════════════════

/** The base kinds a type position can have. */
export type Kind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'object'
  | 'array'
  | 'fn'
  | 'any'
  | 'never'
  | 'or';

/**
 * A single constraint on a type position.
 *
 * Constraints are the atoms of the type system. Each is one predicate:
 *   { op: 'literal', args: ['hello'] }         — value must be 'hello'
 *   { op: 'min', args: [0] }                   — value must be >= 0
 *   { op: 'property', args: ['name', <Type>] } — must have property 'name' of <Type>
 *   { op: 'maxLength', args: [100] }           — string length <= 100
 *
 * The merge function interprets constraints. New ops can be added
 * without changing this type — they just need a merge handler.
 */
export type Constraint = {
  readonly op: string;
  readonly args: readonly unknown[];
};

/**
 * Metadata on a type position.
 *
 * Not constraints — annotations that affect rendering, documentation,
 * and visibility without changing what values are valid.
 */
export type TypeMeta = {
  /** Human-readable name for this type (used in hoisting). */
  readonly name?: string;
  /** Description — may be a segmented string with refs. */
  readonly description?: string;
  /** Visibility predicate — who can see this position. */
  readonly visibility?: Constraint;
  /** Any additional metadata. */
  readonly [key: string]: unknown;
};

/**
 * A type: a serializable constraint set.
 *
 * Immutable. The builder produces these. The tree stores them.
 * The merge function reads them. Nobody mutates them.
 */
export type Type = {
  readonly kind: Kind;
  readonly constraints: readonly Constraint[];
  readonly meta?: TypeMeta;
};

// ═══════════════════════════════════════════════════════════════════════
// CONSTRAINT CONSTRUCTORS
// ═══════════════════════════════════════════════════════════════════════
// These are convenience functions, not special. They produce Constraint
// objects. You can also construct constraints directly as { op, args }.

/** Value must be exactly this literal. */
export function literal(value: unknown): Constraint {
  return { op: 'literal', args: [value] };
}

/** Numeric minimum (inclusive). */
export function min(value: number): Constraint {
  return { op: 'min', args: [value] };
}

/** Numeric maximum (inclusive). */
export function max(value: number): Constraint {
  return { op: 'max', args: [value] };
}

/** Numeric range (inclusive). */
export function range(lo: number, hi: number): Constraint {
  return { op: 'range', args: [lo, hi] };
}

/**
 * Template: a string-shaped claim composed of literal regions and
 * substrate-path references. Returns a Type — not a single constraint —
 * because the substrate already names this exactly: a `kind:'string'`
 * type with `segment(...)` constraints, where each segment's inner
 * Type is either a literal string or a `ref(path)` to a substrate
 * value. There's no special "template" op in the kernel; the same
 * segment + ref + cascade machinery that handles structured claims
 * generally is what makes a templated narrative reflow.
 *
 *   template('Hello {{user}}, welcome to {{place}}.')
 *
 * parses to a `kind:'string'` Type with five segments (alternating
 * literal and ref). The schema-mount path registers dep edges from
 * each ref'd substrate path to the schema's mount path; cascade
 * re-projects the concatenated string when any dep changes.
 *
 * The function exists as a CONSTRUCTOR convenience — it parses the
 * source text into the segmented-string shape so callers don't have
 * to write the segment constraints by hand. The substrate sees only
 * segments + refs, exactly like every other structured claim. There
 * is no "template" constraint op.
 */
export function template(text: string): Type {
  // Parse the text into alternating literal / ref segments. Each
  // `{{path}}` becomes a segment whose inner Type is a string with a
  // `ref(path)` constraint — same constraint the kernel already uses
  // for install-via-ref aliasing. Literal pieces become segments
  // whose inner Type is a string with a `literal(text)` constraint.
  const HOLE_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*(?::\s*[a-zA-Z_][\w]*\s*)?\}\}/g;
  const parts: Constraint[] = [];
  let lastIndex = 0;
  let segIdx = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(HOLE_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      const literalText = text.slice(lastIndex, m.index);
      parts.push(segment(`s${segIdx++}`, createType('string', [literal(literalText)])));
    }
    parts.push(segment(`s${segIdx++}`, createType('string', [{ op: 'ref', args: [m[1]] }])));
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(segment(`s${segIdx++}`, createType('string', [literal(text.slice(lastIndex))])));
  }
  return createType('string', parts);
}

/** String length bounds. */
export function length(minLen?: number, maxLen?: number): Constraint {
  return { op: 'length', args: [minLen, maxLen] };
}

/** String pattern match. */
export function pattern(re: string): Constraint {
  return { op: 'pattern', args: [re] };
}

/** Object property: key must exist with this type. */
export function property(key: string, type: Type, optional?: boolean): Constraint {
  return { op: 'property', args: [key, type, optional ?? false] };
}

/** Array element type. */
export function element(type: Type): Constraint {
  return { op: 'element', args: [type] };
}

/** Array length bounds. */
export function arrayLength(minLen?: number, maxLen?: number): Constraint {
  return { op: 'arrayLength', args: [minLen, maxLen] };
}

/** Function input type. */
export function param(type: Type): Constraint {
  return { op: 'param', args: [type] };
}

/** Function output type. */
export function returns(type: Type): Constraint {
  return { op: 'returns', args: [type] };
}

/** Function implementation reference (string ID, never a live function). */
export function impl(id: string): Constraint {
  return { op: 'impl', args: [id] };
}

/**
 * Preserves: declares which concrete subtypes of a function's input
 * are guaranteed to appear in its output.
 *
 * This is the conservation law that enables backward inference.
 * Without it, the function is a black box. With it, constraints on the
 * output can be traced backward to requirements on the input.
 *
 * Forms:
 *   preserves('*')              — all input properties pass through (T → T & Effects)
 *   preserves('content', 'data.content') — input.content appears at output.data.content
 *
 * The mapping doesn't mean the values are identical — it means the
 * TYPE CONSTRAINTS are preserved. If input.x is a string, output.x (or
 * whatever it maps to) is at least a string.
 *
 * @param inputPath  — path within the input type ('*' = all properties)
 * @param outputPath — path within the output type (defaults to inputPath)
 */
export function preserves(inputPath: string, outputPath?: string): Constraint {
  return { op: 'preserves', args: [inputPath, outputPath ?? inputPath] };
}

// ── Equational constraints (identity + temporal) ───────────────────
//
// Standard equational notation for value-level identities:
//
//   ∀ x : Input .
//     f(x).id  ≡  x.id                           -- value identity
//     g(f(x))  ≡  x            @ t > t_f          -- round-trip with temporal scope
//     f(x).time ≡  t_f + δ(x)  ± margin           -- temporal bound
//
// These are the backward inference wires. Without them, functions are
// black boxes. With them, output requirements propagate backward to
// input requirements through the equations.
//
// Two levels:
//   FUNCTION-LEVEL: identity/temporal on a fn type
//     → relates that function's output to its input
//   SCOPE-LEVEL: equation on an object type
//     → relates values across sibling functions in the same scope

/**
 * Identity: VALUE-level equality between function output and input paths.
 *
 *   identity('id', '.')       — output.id ≡ input
 *   identity('name', 'name')  — output.name ≡ input.name
 *   identity('.', '.')        — output ≡ input (pure identity fn)
 *
 * backwardInfer: if output.id must be V, then input must be V.
 */
export function identity(outputPath: string, inputPath: string): Constraint {
  return { op: 'identity', args: [outputPath, inputPath] };
}

/**
 * Temporal: an inequality on _rt relative to function IO.
 *
 * Every temporal constraint is an inequality:
 *   temporal('gt', outputExpr, inputExpr)
 *     → output available WHEN _rt > inputExpr
 *     → e.g., temporal('gt', '_rt', add('_rt.input', lit(2000)))
 *       means: output available when _rt > Ti + 2000ms
 *
 *   temporal('lt', outputExpr, boundExpr)
 *     → output VALID WHILE _rt < boundExpr
 *     → e.g., temporal('lt', '_rt', add('_rt.input', lit(86400000)))
 *       means: output valid for 24h after input
 *
 * Compose: same direction inequalities tighten
 *   gt(X, A) ∧ gt(X, B) → gt(X, max(A, B))   (latest availability)
 *   lt(X, A) ∧ lt(X, B) → lt(X, min(A, B))   (earliest expiry)
 *   gt(X, A) ∧ lt(X, B) where A > B → contradiction (never valid)
 *
 * @param dir   — 'gt' (available after) or 'lt' (valid until)
 * @param lhs   — what's being bounded (usually '_rt')
 * @param bound — the bound expression (Expr over input properties + _rt.input)
 */
export function temporal(dir: 'gt' | 'lt', lhs: string, bound: Expr): Constraint {
  return { op: 'temporal', args: [dir, lhs, bound] };
}

/**
 * Equation: scope-level equality across sibling functions.
 *
 * Placed on an OBJECT type to express cross-function identities
 * WITH temporal bounds and probability over time:
 *
 *   equation('getReport($setReport)', '$setReport.input', {
 *     from: path('setReport._t'),                    // valid after set completes
 *     until: add(path('setReport._t'), lit(86400000)), // valid for 24h
 *     reliability: call('decay', path('_elapsed')),    // P degrades over time
 *   })
 *
 *   ∀ r : Report .
 *     getReport(setReport(r)) ≡ r
 *     @ t ∈ [t_set, t_set + 24h]
 *     P(holds) = decay(t - t_set)
 *
 * Notation for lhs/rhs:
 *   $fnName       — the output of calling fnName
 *   $fnName.path  — a path within fnName's output
 *   fnName.input  — fnName's declared input type
 *   plain path    — a value at that path in the scope
 *
 * @param lhs  — left-hand side expression
 * @param rhs  — right-hand side expression
 * @param opts — temporal scope and probability (all Expr trees, evaluable against _rt)
 */
export function equation(
  lhs: string,
  rhs: string,
  opts?: {
    /** Equation valid from this time (Expr → ms). Evaluated against projection. */
    from?: Expr;
    /** Equation valid until this time (Expr → ms). */
    until?: Expr;
    /** P(equation holds at time t). Expr over elapsed time since 'from'. */
    reliability?: Expr;
  },
): Constraint {
  return { op: 'equation', args: [lhs, rhs, opts] };
}

// ── Distributions, latent variables, behavioral laws ───────────────
//
// C2.3: Functions declare completion time as a DISTRIBUTION, not a point.
// L1-L2: Latent variables with conjugate priors.
// I3: Cross-method behavioral laws with full trigger/observation structure.
// H2: History query expressions.

/**
 * Distribution: a probability distribution over a property.
 *
 * Used for:
 *   - Completion time: distribution('time', 'exponential', { rate: 0.001 })
 *   - Reliability: distribution('reliability', 'beta', { alpha: 9, beta: 1 })
 *   - Failure rate: distribution('failure', 'weibull', { shape: 2, scale: 5000 })
 *
 * The distribution replaces point estimates. Instead of computable('time', lit(2000)),
 * you get distribution('time', 'lognormal', { mu: 7.6, sigma: 0.3 }) which gives:
 *   - P(completion ≤ τ) = CDF(τ)
 *   - Expected value = E[T]
 *   - Survival: P(still running at τ) = 1 - CDF(τ)
 *
 * Supported families:
 *   exponential: { rate }                → P(T≤t) = 1 - e^(-rate*t)
 *   weibull:     { shape, scale }        → P(T≤t) = 1 - e^(-(t/scale)^shape)
 *   lognormal:   { mu, sigma }          → P(T≤t) = Φ((ln(t)-mu)/sigma)
 *   beta:        { alpha, beta }         → for reliability/probability params
 *   gamma:       { shape, rate }         → for rate parameters
 *   fixed:       { value }               → degenerate (point estimate)
 *
 * @param property — what this distribution describes ('time', 'reliability', etc.)
 * @param family   — distribution family name
 * @param params   — distribution parameters
 */
export function distribution(
  property: string,
  family: 'exponential' | 'weibull' | 'lognormal' | 'beta' | 'gamma' | 'fixed',
  params: Record<string, number>,
): Constraint {
  return { op: 'distribution', args: [property, family, params] };
}

/**
 * Decay: type-survival function. How long is this type expected to remain
 * interpretable as declared, absent an authoritative retraction?
 *
 * Applied as a type-level constraint composed in via lattice meet. Lives
 * at the root of an object tree (or on a glob schema that defines instance
 * shapes); concreteness walks the ancestor type chain to find the nearest
 * decay claim and uses it for the type-survival factor.
 *
 * Two forms:
 *
 * 1. **Named family with params** — compact, serializable to ft text,
 *    dispatches to the built-in implementations in compose.ts::survival.
 *      decay('exponential', { rate: 0.001 })
 *      → half-life ≈ 693 seconds under exp(-rate * dt)
 *
 * 2. **Direct function** — the function describing the evolution IS the
 *    second arg. No registry lookup, no string-to-path indirection. The
 *    concreteness evaluator calls it with elapsed time and gets back
 *    P(still interpretable). This form is for learned or runtime-composed
 *    evolutions that don't fit any named family; it's not round-trippable
 *    through ft text (functions aren't serializable), but it's the
 *    primary mechanism for any use case where the evolution is known as
 *    a function rather than as a family + parameters.
 *      decay('fn', (dt) => Math.exp(-0.001 * dt))
 *
 * Composed via intersection: two types with decay constraints compose to
 * pointwise product of their survival functions. Tighter decay wins via
 * lattice meet.
 *
 * Absent any decay constraint on a path or its ancestor chain, the
 * type-survival factor is 1 — there is no hidden default. The
 * responsibility is on the person mounting the type to declare its
 * tentativeness.
 *
 * @param family — decay family name, or 'fn' for a direct function arg
 * @param paramsOrFn — distribution params (named family) or a function (dt: number) => number (fn form)
 */
export function decay(
  family: 'exponential' | 'weibull' | 'fixed' | 'fn',
  paramsOrFn: Record<string, number> | ((dt: number) => number),
): Constraint {
  return { op: 'decay', args: [family, paramsOrFn] };
}

/**
 * Prior: latent variable with a conjugate prior distribution.
 *
 * Latent variables track unobserved state that gets updated via
 * conjugate Bayesian updates as observations arrive.
 *
 *   prior('reliability', 'beta', { alpha: 1, beta: 1 })
 *     → starts as uniform [0,1]
 *     → on success: alpha += 1
 *     → on failure: beta += 1
 *     → posterior predictive: P(success) = alpha / (alpha + beta)
 *
 * Sufficient statistics are stored as values at the path:
 *   path._prior = { family, alpha, beta }
 *
 * @param name    — latent variable name
 * @param family  — conjugate family ('beta', 'gamma', 'dirichlet')
 * @param initial — initial hyperparameters (sufficient statistics)
 */
export function prior(
  name: string,
  family: 'beta' | 'gamma' | 'dirichlet',
  initial: Record<string, number>,
): Constraint {
  return { op: 'prior', args: [name, family, initial] };
}

/**
 * Behavioral law: cross-method implication with full structure.
 *
 * Two modes, distinguished by the `admission` flag:
 *
 *   Observational (default). Evaluated post-mount; tracks
 *   trigger → implies → terminates across invocations and updates
 *   a confidence prior.
 *
 *     law({
 *       trigger: 'set($value) => $id',
 *       implies: 'get($id) => $value',
 *       activation: temporal('gt', '_rt', '_trigger._t'),
 *       confidence: distribution('reliability', 'beta', { alpha: 9, beta: 1 }),
 *       terminates: 'delete($id)',
 *     })
 *
 *   Admission. Evaluated pre-mount; rejects the mount if `check`
 *   evaluates false. Bindings available in `check`: `$author`
 *   (block author), `$path` (entry path), `$time` (mount time).
 *
 *     law({
 *       admission: true,
 *       check: eq('$author', 'sessions.alice.holder'),
 *       reason: 'only the current session holder can write here',
 *     })
 *
 * @param spec — the behavioral law specification
 */
export function law(spec: {
  /** What triggers this law: method call pattern with $variable bindings */
  trigger?: string;
  /** What the trigger implies for future observations */
  implies?: string;
  /** When the implication activates (temporal constraint) */
  activation?: Constraint;
  /** Confidence function — how reliable is this implication over time */
  confidence?: Constraint;
  /** What terminates this implication */
  terminates?: string;
  /** Admission mode: evaluate `check` pre-mount; reject on false. */
  admission?: boolean;
  /** Pre-mount boolean expression. Required when `admission` is true. */
  check?: Constraint;
  /** Human-readable rejection reason when an admission check fails. */
  reason?: string;
}): Constraint {
  return { op: 'law', args: [spec] };
}

/**
 * History query: expression over the call trace.
 *
 * Used in where clauses, equations, and behavioral laws to
 * reference past events.
 *
 *   history('last', 'set', { key: 'id' })     → last call to set with key=id
 *   history('count', 'get')                    → number of get calls
 *   history('exists', 'set', { value: '$x' })  → was set called with this value
 *
 * @param op     — query operator
 * @param method — method name to query
 * @param filter — optional property filter on the call
 */
export function history(
  op: 'last' | 'count' | 'sum' | 'exists' | 'forall',
  method: string,
  filter?: Record<string, unknown>,
): Constraint {
  return { op: 'history', args: [op, method, filter] };
}

/**
 * Ref: this position derives its value from another path.
 *
 * When reading a ref'd position, follow the source path and return
 * that value. If the source doesn't exist, this position is a gap.
 *
 * @param source — the path this position reads from
 */
export function ref(source: string): Constraint {
  return { op: 'ref', args: [source] };
}

/**
 * Derived: this position's value is computed by calling a function
 * with values from other paths as arguments.
 *
 * @param fnId — the capability ID to call
 * @param argPaths — paths to read and pass as arguments
 */
export function derived(fnId: string, ...argPaths: string[]): Constraint {
  return { op: 'derived', args: [fnId, ...argPaths] };
}

// ── Computable expression constraints ────────────────────────────────

/**
 * An Expr is a serializable arithmetic expression tree.
 *
 * Used in function type contracts to express output properties
 * (time, cost, quality) as functions of input properties.
 *
 * Forms:
 *   number                        — literal constant
 *   string                        — path reference (resolved from input at eval time)
 *   { add: Expr[] }               — sum of terms
 *   { mul: Expr[] }               — product of terms
 *   { fn: string, arg: Expr }     — named function application (e.g., approxtokens)
 *   { pm: Expr, margin: Expr }    — center ± margin (uncertainty band)
 *
 * Expressions are data. They contain no live functions.
 * Evaluation happens in compose.ts with concrete bindings.
 */
export type Expr =
  | number
  | string
  | { add: Expr[] }
  | { mul: Expr[] }
  | { fn: string; arg: Expr }
  | { pm: Expr; margin: Expr };

/**
 * Computable: an output property whose value is an expression over inputs.
 *
 * This is how function types express dependent output guarantees:
 *   "output.time will be <expr> given these inputs"
 *   "output.cost will be <expr> given these inputs"
 *
 * When inputs are concrete, the expression evaluates to a value (± margin).
 * When inputs are partial, the expression evaluates to a range.
 * The concreteness of the computable = concreteness of its input refs.
 *
 * @param outputPath — which output property this constrains
 * @param expr — the expression tree
 */
export function computable(outputPath: string, expr: Expr): Constraint {
  return { op: 'computable', args: [outputPath, expr] };
}

/** Helper: literal expression */
export function lit(n: number): Expr { return n; }
/** Helper: path reference expression */
export function path(p: string): Expr { return p; }
/** Helper: addition */
export function add(...terms: Expr[]): Expr { return { add: terms }; }
/** Helper: multiplication */
export function mul(...factors: Expr[]): Expr { return { mul: factors }; }
/** Helper: named function application */
export function call(fnName: string, arg: Expr): Expr { return { fn: fnName, arg }; }
/** Helper: uncertainty band (center ± margin) */
export function pm(center: Expr, margin: Expr): Expr { return { pm: center, margin }; }

// ── Segment constraints ─────────────────────────────────────────────

/**
 * Segment: a named region within a segmented string or array.
 *
 * Each segment has:
 *   name     — unique identifier within the segmented type
 *   type     — constraint on the segment's content
 *   budget   — max size (characters, tokens, items) — optional
 *   mutations — what operations are allowed on this segment
 */
export function segment(
  name: string,
  type: Type,
  opts?: { budget?: number; mutations?: string[]; locked?: boolean },
): Constraint {
  return { op: 'segment', args: [name, type, opts?.budget, opts?.mutations, opts?.locked] };
}

/**
 * Key: declares which fields identify an element within a collection.
 * When a value is narrowed into a collection with a key constraint,
 * the key fields are extracted from the value to derive the mount path.
 *
 * key('user', 'workspace') on Session means:
 *   sessions << { user: "alice", workspace: "acme", ... }
 *   mounts at sessions.alice.acme
 */
export function key(...fields: string[]): Constraint {
  return { op: 'key', args: fields };
}

/**
 * Endpoint: the address this capability is bound to.
 * A function with an endpoint is a concrete capability instance, not a schema.
 * Two functions with different endpoints are different capabilities (compose → never).
 *
 * @param url — the service endpoint URL or address
 */
export function endpoint(url: string): Constraint {
  return { op: 'endpoint', args: [url] };
}

/**
 * Auth: the identity path this capability requires for authentication.
 * The referenced path must exist and contain a valid credential.
 * Different auth paths mean different capability instances with different
 * rate limits, permissions, and behavioral profiles.
 *
 * @param identityPath — path to the credential (e.g., "id.keys.github_token")
 */
export function auth(identityPath: string): Constraint {
  return { op: 'auth', args: [identityPath] };
}

/**
 * Provenance: this path's value must have been produced by a specific
 * capability or author. Checked at mount admission — rejected or gapped
 * if the mounting block doesn't satisfy the provenance requirement.
 *
 * @param producer — capability path or author identity that must have produced this value
 * @param maxAge — optional: max ms since production (for expiry/re-validation)
 */
export function producedBy(producer: string, maxAge?: number): Constraint {
  return { op: 'producedBy', args: [producer, maxAge] };
}

/**
 * Declare which kernel partition a type lives in.
 *
 * Partitions are a dimension of type, not a property of the path a
 * value happens to be mounted at. A type with `partition('id')`
 * belongs to the identity partition regardless of where it's
 * mounted — the Sequence's partition-aware mount admission walks
 * this constraint FIRST when computing a mount's partition, and
 * only falls back to path prefix when the type doesn't declare one.
 *
 * Valid values are the six kernel partitions (see PARTITION_MODEL.md):
 *   'state' | 'proc' | 'id' | 'req' | 'chan' | 'proj'
 *
 * Typed parameter intentionally left as `string` here (not a union)
 * because the Partition type lives in `sequence.ts` and type.ts is
 * upstream of it in the import graph — the Sequence-level validation
 * narrows it at enforcement time.
 *
 * @param p — one of the six kernel partitions
 */
export function partition(p: 'state' | 'proc' | 'id' | 'req' | 'chan' | 'proj'): Constraint {
  return { op: 'partition', args: [p] };
}

/**
 * cdf_gte: claim on the concreteness distribution of a path.
 *   cdfGte(path, t, p)  means  P(path concrete by time t) ≥ p
 *
 * Used in where/while gates to express temporal commitments over
 * the three-factor concreteness distribution (completion × type-
 * survival × provenance). Evaluated at mount/fire time by querying
 * Sequence.concretenessDistribution(path).cdf(t).
 *
 *   seq.mount([{ op: 'bind', path: 'tasks.deploy.status', value: 'pending' }], {
 *     while: [cdfGte('tasks.deploy.result', _rt + 10_000, 0.95)],
 *   })
 *   // "this block is valid only while the concreteness of
 *   //  tasks.deploy.result by _rt+10s is at least 95%"
 *
 * The `t` arg can be a numeric literal, a path, or an arithmetic expr
 * (e.g. `{ op: '+', lhs: '_rt', rhs: 10_000 }`). Same with `p`.
 */
export function cdfGte(path: string, t: number | Expr, p: number | Expr): Constraint {
  return { op: 'cdf_gte', args: [path, t, p] };
}

/**
 * concrete_at: shorthand for cdfGte(path, t, 0.5).
 *   concreteAt(path, t)  means  P(path concrete by t) ≥ 0.5
 *
 * "More likely than not concrete by t" — useful for loose temporal
 * commitments where you want momentum-style pressure but not strict
 * confidence.
 */
export function concreteAt(path: string, t: number | Expr): Constraint {
  return { op: 'concrete_at', args: [path, t] };
}

/**
 * Version: declares the cap's policy version. Consumers can read
 * `_caps_version.{toolPath}` to know which version of a cap they are
 * running. Admission requires the version to be present on writes
 * that replace the cap's fn schema, so hot-reload always increments.
 *
 *   version(n)
 */
export function version(n: number): Constraint {
  return { op: 'version', args: [n] };
}

/**
 * Response policy: declares how a capability's gap should be filled.
 * Baked into the function type — every invocation inherits these terms.
 *
 *   timeout    — max ms before escalation (default: no timeout)
 *   confidence — min probability of completion (default: 0.95)
 *   escalation — what to do on policy violation: "warning" | "error" | "retry"
 */
export function responsePolicy(
  timeout?: number,
  confidence?: number,
  escalation?: 'warning' | 'error' | 'retry',
): Constraint {
  return { op: 'responsePolicy', args: [timeout, confidence, escalation ?? 'warning'] };
}

// ── Composition operators ───────────────────────────────────────────

/**
 * Default: patch-if-missing. Only merges a value into a position
 * if that position doesn't already have a concrete value.
 */
export function defaultValue(value: unknown): Constraint {
  return { op: 'default', args: [value] };
}


// ── Relational constraints (for where/while clauses) ────────────────
// First arg is always a path (resolved from sequence). Remaining are literals
// unless wrapped in { ref: path }.

/** Path must have a value. */
export function exists(path: string): Constraint { return { op: 'exists', args: [path] }; }

/** Path must not have a value. */
export function notExists(path: string): Constraint { return { op: 'notExists', args: [path] }; }

/** Value at path must equal literal. */
export function eq(path: string, value: unknown): Constraint { return { op: 'eq', args: [path, value] }; }

/** Not equal. */
export function neq(path: string, value: unknown): Constraint { return { op: 'neq', args: [path, value] }; }

/** Value at path must be less than literal. */
export function lt(path: string, value: unknown): Constraint { return { op: 'lt', args: [path, value] }; }

/** Less than or equal. */
export function lte(path: string, value: unknown): Constraint { return { op: 'lte', args: [path, value] }; }

/** Greater than. */
export function gt(path: string, value: unknown): Constraint { return { op: 'gt', args: [path, value] }; }

/** Greater than or equal. */
export function gte(path: string, value: unknown): Constraint { return { op: 'gte', args: [path, value] }; }

/** Count of children at path must be less than n. */
export function countLt(path: string, n: number): Constraint { return { op: 'count_lt', args: [path, n] }; }

/** Count of children at path must be greater than or equal to n. */
export function countGte(path: string, n: number): Constraint { return { op: 'count_gte', args: [path, n] }; }

// ── Composite predicates (for complex where/while clauses) ──────────

/** Any of the constraints must hold (disjunction). */
export function or(...clauses: Constraint[]): Constraint { return { op: 'or_clause', args: clauses }; }

/** All of the constraints must hold (explicit conjunction — where arrays are implicit AND). */
export function and(...clauses: Constraint[]): Constraint { return { op: 'and_clause', args: clauses }; }

/** Negation: the constraint must NOT hold. */
export function not(clause: Constraint): Constraint { return { op: 'not_clause', args: [clause] }; }

// ── Index constraints: class-level tuple projection ────────────────
//
// `bindFrom($var, globPath)` introduces a free variable into a where
// clause's binding space. Instead of a boolean, the where clause
// projects a set of tuples — one per distinct combination of binds.
// `indexSpec({ indexedBy, where, body })` attaches a class-level
// index to a schema: when the schema mounts (or its inputs change),
// the kernel evaluates the binding space and fires the body once
// per new tuple, interpolating `{var}` references in body paths and
// string values.

/** Binding form: `$var ∈ globPath` (contributes to the binding space). */
export function bindFrom(varName: string, globPath: string): Constraint {
  return { op: 'bind_from', args: [varName, globPath] };
}

/**
 * Attach an index constraint to a class-like schema. The `spec.where`
 * clauses project into a tuple space; `spec.body` is the per-tuple
 * constructor that fires for every tuple in the space. Paths and
 * string values in `body` may contain `{var}` references that get
 * interpolated with the tuple's binding at fire time.
 */
export function indexSpec(spec: {
  indexedBy: string[];
  where: Constraint[];
  body: Array<{ op: string; path: string; value?: unknown }>;
}): Constraint {
  return { op: 'index_spec', args: [spec] };
}

// ── Value predicates ────────────────────────────────────────────────

/** Value at path must match a regex pattern. */
export function regex(path: string, pattern: string): Constraint { return { op: 'regex', args: [path, pattern] }; }

/** Value at path must be in the range [lo, hi] (inclusive). Works for numbers and strings. */
export function between(path: string, lo: unknown, hi: unknown): Constraint { return { op: 'between', args: [path, lo, hi] }; }

/** Value at path must be one of the listed values. */
export function oneOf(path: string, ...values: unknown[]): Constraint { return { op: 'one_of', args: [path, values] }; }

/** Value at path must contain the substring (for strings) or element (for arrays). */
export function contains(path: string, value: unknown): Constraint { return { op: 'contains', args: [path, value] }; }

/** Value at path must satisfy the given type (structural type predicate). */
/** The path's value satisfies the given type. The where-clause
 *  primitive that gates `mount` on full type-check (kind +
 *  refinements + structural properties), not just existence. */
export function satisfies(path: string, type: Type): Constraint { return { op: 'satisfies', args: [path, type] }; }

// ═══════════════════════════════════════════════════════════════════════
// TYPE CONSTRUCTORS
// ═══════════════════════════════════════════════════════════════════════
// Bare type creation without the builder. The builder wraps these.

/** Create a type from kind + constraints + optional meta. */
export function createType(kind: Kind, constraints: Constraint[] = [], meta?: TypeMeta): Type {
  return Object.freeze({ kind, constraints: Object.freeze(constraints), meta });
}

/** The any type — accepts everything. */
export const ANY: Type = createType('any');

/** The never type — accepts nothing. Carries a reason. */
export function never(reason?: string): Type {
  return createType('never', [], reason ? { reason } : undefined);
}

// ═══════════════════════════════════════════════════════════════════════
// TYPE QUERIES
// ═══════════════════════════════════════════════════════════════════════

/** Get all constraints with a specific op. */
export function constraintsOf(type: Type, op: string): readonly Constraint[] {
  return type.constraints.filter(c => c.op === op);
}

/** Get the first constraint with a specific op, or undefined. */
export function constraintOf(type: Type, op: string): Constraint | undefined {
  return type.constraints.find(c => c.op === op);
}

/** Get the literal value from a type, if it has one. */
export function literalValue(type: Type): unknown | undefined {
  const c = constraintOf(type, 'literal');
  return c ? c.args[0] : undefined;
}

/** Get all property constraints from an object type. */
export function properties(type: Type): { key: string; type: Type; optional: boolean }[] {
  return constraintsOf(type, 'property').map(c => ({
    key: c.args[0] as string,
    type: c.args[1] as Type,
    optional: c.args[2] as boolean,
  }));
}

/** Get the element type from an array type. */
export function elementType(type: Type): Type | undefined {
  const c = constraintOf(type, 'element');
  return c ? c.args[0] as Type : undefined;
}

/** Is this type 'never'? */
export function isNever(type: Type): boolean {
  return type.kind === 'never';
}

/** Is this type 'any'? */
export function isAny(type: Type): boolean {
  return type.kind === 'any';
}
