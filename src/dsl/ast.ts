/**
 * ast.ts — AST for the behavioral type DSL.
 *
 * Two operators: = (overwrite) and << (narrow/compose).
 * Blocks are scoped computations with import/export.
 * Everything reduces. What's concrete is a value. What isn't is an obligation.
 */

// ═══════════════════════════════════════════════════════════════════════
// STATEMENTS
// ═══════════════════════════════════════════════════════════════════════

export type Statement =
  | AssignStatement        // x = expr
  | NarrowStatement        // x << expr
  | DeleteStatement        // delete x
  | CapStatement           // cap path [when cond]
  | PolicyStatement        // policy path: spec
  | ImportStatement        // import name from 'path'
  | ExportStatement        // export expr
  | CommentStatement       // -- narrative context (preserved, not stripped)
  | ClassStatement         // class Name(deps) while cond { props; methods }
  | ReaderStatement        // reader name { source, mode, filter, limit, ... }
  | SpreadStatement        // ...expr — expr evaluates to ft text that gets pasted inline
  | WhereStatement         // where (conds) { stmts } — conditional scope gate
  | InStatement            // in path [= backing] [while cond] { stmts } — scoped context
  ;

/**
 * Spread statement: `...expr` at block/statement position.
 * The expr is evaluated at walk time and must produce a STRING of
 * ft text; that text is re-parsed and walked as if it had been
 * written inline at the spread's position. Lets a capability return
 * a snippet of statements that paste into the surrounding block.
 */
export type SpreadStatement = { kind: 'spread_stmt'; expr: Expr };

/**
 * Where statement: `where (conds) { stmts }` — conditional scope
 * gate. All conditions are evaluated at walk time; if every
 * condition passes, the body runs (its statements are walked as
 * normal, mounting side effects). Otherwise the body is skipped.
 *
 * `where` introduces NO new bindings. Condition expressions
 * reference bindings that are already visible in the enclosing
 * scope — typically fn parameters when the where appears inside
 * a block-body fn def, or nothing (only absolute paths) when at
 * top level. The substitution pipeline in buildFnImpl rewrites
 * `{var}` segments in condition paths using fn param bindings
 * BEFORE the walker evaluates them, so the walker sees fully
 * concrete absolute paths.
 */
export type WhereStatement = { kind: 'where_stmt'; conditions: ConditionExpr[]; body: Statement[] };

export type AssignStatement = { kind: 'assign'; path: string; value: Expr; modifiers: Modifiers };
export type NarrowStatement = { kind: 'narrow'; path: string; value: Expr; modifiers: Modifiers };
export type DeleteStatement = { kind: 'delete'; path: string };
export type CapStatement = { kind: 'cap'; path: string; when?: ConditionExpr[] };
export type PolicyStatement = { kind: 'policy'; path: string; spec: Record<string, unknown> };

// Note: transition policies ({ transition: 'add' }) are eliminated.
// All transitions — same-path or cross-class — are refinement predicates using prev.
// Policy remains for compaction rules only.
export type ImportStatement = { kind: 'import'; name: string; from: string };
export type ExportStatement = { kind: 'export'; value: Expr };
export type CommentStatement = { kind: 'comment'; text: string; line: number };

/** Class declaration: typed partition with constructor deps, lifecycle, methods.
 *  Desugars to: where clauses (deps), while clause (lifecycle),
 *  property schemas, method fn types + cap markers. */
export type ClassStatement = {
  kind: 'class';
  name: string;
  /** Constructor parameters = where clause deps. Each must be satisfied to mount. */
  params: { name: string; type: Expr; optional: boolean }[];
  /** Lifecycle condition. Instance invalidated when this breaks. */
  whileClause?: ConditionExpr[];
  /** Body: property declarations and method definitions. */
  body: Statement[];
};

/**
 * In statement: `in path [= backing] [while cond] { stmts }`
 *
 * Scoped context block. All write paths in the body are prefixed
 * with `path`. Unqualified reads (via `get()` / name resolution)
 * resolve relative to `path` first, then fall back to absolute.
 *
 * Optional `= backing`: creates a ref claim at `path` pointing
 * to `backing` (the claim pattern).
 *
 * Optional `while cond`: lifetime gate on the scope. All mounts
 * inside carry the while clause. On while-break, the scope's
 * bind entries are cleaned up.
 *
 * Nesting composes: `in a { in b { x = 1 } }` → `a.b.x = 1`.
 */
export type InStatement = {
  kind: 'in';
  path: string;
  backing?: Expr;
  whileClause?: ConditionExpr[];
  body: Statement[];
};

export type Modifiers = {
  when?: ConditionExpr[];
  while?: ConditionExpr[];
  onBreak?: { path: string; value: Expr };
  author?: string;
};

// ═══════════════════════════════════════════════════════════════════════
// EXPRESSIONS — right side of = or <<, block bodies, export values
// ═══════════════════════════════════════════════════════════════════════

export type Expr =
  | PrimitiveExpr
  | LiteralExpr
  | ObjectExpr
  | ArrayExpr
  | FunctionExpr
  | UnionExpr
  | IntersectionExpr
  | RefExpr            // ref(path) — live reference
  | SnapshotExpr       // snapshot(path) — copy current value
  | NameExpr           // bare name — resolves in scope
  | BlockExpr          // { import ...; stmts; export expr }
  | CallExpr           // fn(args)
  | BinopExpr          // a + b, a * b
  | RefinedExpr        // base type | predicate
  | LetExpr            // let $var = expr (in predicate chains)
  | PrevExpr           // prev or prev.path — pre-mount projection snapshot
  | ExpansionExpr      // [[ label : description ]] — stub/gap for incremental filling
  | SegmentedExpr     // T1 . T2 . T3 — ordered heterogeneous segments (tuple)
  | ProjectExpr       // project(set, mapper).where(cond) — iteration primitive
  ;

export type PrimitiveExpr = {
  kind: 'primitive';
  base: 'string' | 'number' | 'boolean' | 'null';
  constraints: PrimitiveConstraint[];
};

export type PrimitiveConstraint =
  | { op: 'pattern'; value: string }
  | { op: 'length'; min?: number; max?: number }
  | { op: 'min'; value: number }
  | { op: 'max'; value: number }
  | { op: 'range'; lo: number; hi: number }
  | { op: 'integer' }
  ;

export type LiteralExpr = { kind: 'literal'; value: string | number | boolean | null };
export type ObjectExpr = { kind: 'object'; properties: { key: string; value: Expr; optional: boolean }[] };
export type ArrayElement = { expr: Expr; spread: boolean };
export type ArrayExpr = { kind: 'array'; element: Expr; minLength?: number; maxLength?: number; elements?: ArrayElement[] };

export type FunctionExpr = {
  kind: 'function';
  params: { name: string; type: Expr; optional: boolean }[];
  /** Return type annotation. Required for type-only fn forms
   *  `(args) -> T`. Optional for block-body fn defs — when absent,
   *  the block's compiled state IS the output (future backwards
   *  inference will check declared annotations against it). */
  returns?: Expr;
  preserves?: '*' | [string, string][];
  distribution?: { family: string; params: Record<string, number> };
  /** Block body: statements executed on invocation with param bindings in scope.
   *  Presence signals "function definition"; absence = "function type only". */
  body?: Statement[];
};

export type UnionExpr = { kind: 'union'; branches: Expr[] };
export type IntersectionExpr = { kind: 'intersection'; members: Expr[] };
export type RefExpr = { kind: 'ref'; path: string };
export type SnapshotExpr = { kind: 'snapshot'; path: string };
export type NameExpr = { kind: 'name'; name: string };
export type CallExpr = { kind: 'call'; fn: string; args: Expr[] };
/**
 * `project(binding in set, mapper).where(cond)` — iteration over a
 * path pattern. The set contains one or more `{name}` wildcards
 * that become fields on the binding. The filter references
 * `binding.field` for record access; the mapper is invoked per
 * match with the binding as input.
 *
 * Required form — legacy `project(set, mapper)` without an
 * explicit binding was removed to keep iteration scope visible.
 */
export type ProjectExpr = {
  kind: 'project';
  /** Declared iteration variable name (e.g. `r`). Visible in filter. */
  binding: string;
  set: Expr;
  mapper: Expr;
  filter?: ConditionExpr;
};
export type BinopExpr = { kind: 'binop'; op: '+' | '-' | '*' | '/'; lhs: Expr; rhs: Expr };
export type LetExpr = { kind: 'let'; name: string; value: Expr };
export type PrevExpr = { kind: 'prev'; path?: string }; // prev = whole snapshot, prev.x = specific path
export type ExpansionExpr = { kind: 'expansion'; label?: string; description: string }; // [[ label : desc ]] — gap/stub
/** T1 . T2 . T3 — ordered heterogeneous segments. Each segment is a typed position. */
export type SegmentedExpr = { kind: 'segmented'; segments: Expr[] };

/**
 * Reader: a mounted observation/projection contract over the sequence.
 * Declares what to observe (source), how to filter/project (mode, filter, limit),
 * where to write output (sink), and rendering hint.
 */
export type ReaderStatement = {
  kind: 'reader';
  name: string;
  properties: { key: string; value: Expr }[];
};

export type BlockExpr = {
  kind: 'block';
  statements: Statement[];
};

export type RefinedExpr = {
  kind: 'refined';
  base: Expr;
  predicates: Predicate[];
};

// ═══════════════════════════════════════════════════════════════════════
// PREDICATES — after | in refinements
// ═══════════════════════════════════════════════════════════════════════

export type Predicate =
  | ComparisonPredicate
  | ForallPredicate
  ;

export type ComparisonPredicate = {
  kind: 'comparison';
  lhs: Expr;
  op: '=' | '!=' | '<' | '<=' | '>' | '>=' | 'MATCHES' | 'HAS' | 'IN' | 'SATISFIES';
  rhs: Expr;
  temporal?: { from: Expr; until?: Expr };
  probability?: { family: string; distribution: string; params: Record<string, number> };
};

export type ForallPredicate = {
  kind: 'forall';
  variable: string;
  set: Expr;
  body: Predicate;
};

// ═══════════════════════════════════════════════════════════════════════
// CONDITIONS — in when/while clauses
// ═══════════════════════════════════════════════════════════════════════

export type ConditionExpr =
  | { kind: 'exists'; path: string }
  | { kind: 'not_exists'; path: string }
  | { kind: 'compare'; lhs: Expr; op: '=' | '!=' | '<' | '<=' | '>' | '>='; rhs: Expr }
  | { kind: 'matches'; path: string; pattern: string }
  | { kind: 'and'; clauses: ConditionExpr[] }
  | { kind: 'or'; clauses: ConditionExpr[] }
  | { kind: 'not'; clause: ConditionExpr }
  ;
