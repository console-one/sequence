/**
 * evaluate.ts (v2) — standalone constraint evaluation over plain state.
 *
 * ONE EXPORT: evaluateConstraint(constraint, state, bindings) — evaluate
 * a serialized Constraint ({op, args}, the shared laws vocabulary from
 * ../src/type) against a PLAIN JS object and a binding map, without
 * constructing a Sequence instance.
 *
 * WHY THIS EXISTS: consumers that hold folded state as a plain object
 * (topic-dao's G3 write conditions are the first) previously had to
 * construct an ephemeral v1 Sequence, mount the state leaf-by-leaf, and
 * call the v1 engine's evalWithBindings. That made an admission path
 * depend on the v1 engine. This module is the v2 replacement: same
 * vocabulary, no engine instance.
 *
 * WHAT IS REUSED (never reimplemented): every relation — equality and
 * numeric ordering — is delegated to `check` from ../src/compose, the
 * shared v2 conformance machinery. eq is `literal` conformance
 * (Object.is); gte/lte/gt/lt are `min`/`max` conformance over the
 * `number` kind (non-numbers never satisfy an ordering — the kind check
 * runs first). This is the same delegation v1's own `satisfies` op uses
 * and the same shape product code (constraint-relation.ts) already
 * proved. NOTHING is imported from the v1 engine (src/sequence.ts).
 *
 * WHAT THIS MODULE OWNS (resolution, not relation semantics):
 *   - dot-path lookup into the plain state object. Mirrors the
 *     leaf-mount discipline the previous ephemeral-mount path produced:
 *     plain objects are interior nodes; scalars/arrays/null are leaves;
 *     keys holding `undefined` don't exist; a plain object with no
 *     transitive leaf (e.g. `{}`) is not addressable — `exists` is
 *     false for it and it contributes no countable key.
 *   - `$var` bindings: a whole-string `$name` arg resolves to
 *     bindings[name] verbatim (type-preserving — a bound number stays a
 *     number); `$name` as a SEGMENT of a dotted path substitutes its
 *     stringified value. An unbound `$name` falls through to path
 *     lookup and (state having no such key) resolves undefined — unmet,
 *     never silently met.
 *   - comparison argument policy (the laws contract): the LHS of a
 *     comparison is a path (or binding) — a missing path is undefined
 *     and the comparison is false. The RHS is a path if one exists at
 *     that key, otherwise the literal string itself.
 *
 * SUPPORTED OPS (closed set — this is the G3 write-condition
 * vocabulary, not a capability registry):
 *   eq neq lt lte gt gte exists notExists count_lt count_gte
 *   or_clause and_clause not_clause
 *
 * UNSUPPORTED — LOUD BY DESIGN: `forall` (variable-binding iteration),
 * glob paths (`a.b.*`), aggregate/arithmetic/history argument
 * expressions ({fn}, {op,lhs,rhs}, {ref}, {op:'history'}), and every
 * other v1-engine op (regex/between/one_of/contains/cdf_gte/...) exist
 * only in the v1 engine's evaluator. The v2 machinery cannot evaluate
 * them, so this module throws a named error instead of guessing or
 * quietly returning false. Honesty over completeness: a caller that
 * needs one of these forms should see the gap, not a silent verdict.
 */

import type { Constraint } from '../src/type';
import { createType, literal, min, max, type Kind } from '../src/type';
import { check } from '../src/compose';

const SUPPORTED_OPS = [
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte',
  'exists', 'notExists', 'count_lt', 'count_gte',
  'or_clause', 'and_clause', 'not_clause',
] as const;

const NUMBER = createType('number');

function unsupported(what: string): never {
  throw new Error(
    `evaluateConstraint: ${what} is not supported by the standalone v2 ` +
    `evaluator (supported ops: ${SUPPORTED_OPS.join(', ')}). This form ` +
    `exists only in the v1 Sequence engine; it was deliberately NOT ` +
    `re-implemented here.`,
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Does this value contain at least one addressable leaf? A leaf is any
 *  defined non-plain-object value. Mirrors the leaf-mount discipline:
 *  `{}` (and objects of empty objects) were never mounted, so they are
 *  not addressable. */
function hasLeaf(v: unknown): boolean {
  if (v === undefined) return false;
  if (!isPlainObject(v)) return true;
  for (const child of Object.values(v)) {
    if (hasLeaf(child)) return true;
  }
  return false;
}

/** Walk a dot-joined path through plain objects. Returns the value at
 *  the path under leaf-mount addressability: undefined-valued keys and
 *  leafless objects read as absent. (Keys containing a literal '.' are
 *  not addressable — same limitation the mount path had.) */
function valueAtPath(state: unknown, path: string): unknown {
  let cur: unknown = state;
  for (const seg of path.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  if (cur === undefined) return undefined;
  if (isPlainObject(cur)) return hasLeaf(cur) ? cur : undefined;
  return cur;
}

/** Count addressable child keys at a path — the `count_*` domain.
 *  A child counts iff it holds at least one leaf. */
function countKeysAtPath(state: unknown, path: string): number {
  let cur: unknown = state;
  for (const seg of path.split('.')) {
    if (!isPlainObject(cur)) return 0;
    cur = cur[seg];
  }
  if (!isPlainObject(cur)) return 0;
  let n = 0;
  for (const child of Object.values(cur)) {
    if (hasLeaf(child)) n++;
  }
  return n;
}

/** Whole-string `$name` binding lookup. Returns the bound value
 *  verbatim (type-preserving — a bound string is a VALUE here, never
 *  re-read as a path). Returns undefined when the arg is not a
 *  whole-string $var or the name is unbound. */
function wholeBinding(
  arg: string,
  bindings: Record<string, unknown>,
): { hit: true; value: unknown } | { hit: false } {
  if (arg.startsWith('$') && !arg.includes('.')) {
    const name = arg.slice(1);
    if (name in bindings) return { hit: true, value: bindings[name] };
  }
  return { hit: false };
}

/** Substitute `$name` SEGMENTS of a dotted path with their stringified
 *  bound values. Unbound names pass through unchanged (they remain
 *  path text — an unbound $var resolves like any missing path). */
function substituteSegments(arg: string, bindings: Record<string, unknown>): string {
  if (!arg.includes('$')) return arg;
  return arg.split('.').map(seg => {
    if (seg.startsWith('$')) {
      const name = seg.slice(1);
      if (name in bindings) return String(bindings[name]);
    }
    return seg;
  }).join('.');
}

function rejectGlob(path: string): void {
  if (path.includes('.*') || path === '*') unsupported(`glob path '${path}'`);
}

/** Argument value of a comparison side. `side` encodes the laws
 *  contract: 'path' (LHS) — strings are paths, missing means undefined;
 *  'value' (RHS) — strings are paths when present, else the literal
 *  string. Non-string scalars are literals. Expression objects are the
 *  v1 engine's — loud. */
function resolveArg(
  arg: unknown,
  side: 'path' | 'value',
  state: unknown,
  bindings: Record<string, unknown>,
): unknown {
  if (typeof arg === 'number' || typeof arg === 'boolean' || arg === null) return arg;
  if (typeof arg === 'string') {
    const bound = wholeBinding(arg, bindings);
    if (bound.hit) return bound.value; // the bound value, verbatim
    const path = substituteSegments(arg, bindings);
    rejectGlob(path);
    const v = valueAtPath(state, path);
    if (side === 'value') return v !== undefined ? v : path;
    return v;
  }
  if (typeof arg === 'object' && arg !== null) {
    unsupported(`argument expression ${JSON.stringify(arg)}`);
  }
  return arg;
}

/** The kind of a literal value, for conformance checking. */
function kindOf(v: unknown): Kind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    default: return 'object';
  }
}

/** Equality as `literal` conformance — Object.is, via check. A missing
 *  (undefined) LHS never equals anything: the kind check fails first. */
function equalByCheck(a: unknown, b: unknown): boolean {
  return check(createType(kindOf(b), [literal(b)]), a).ok;
}

function asConstraint(v: unknown, context: string): Constraint {
  if (
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    typeof (v as { op?: unknown }).op === 'string' &&
    Array.isArray((v as { args?: unknown }).args)
  ) return v as Constraint;
  throw new Error(
    `evaluateConstraint: ${context} requires Constraint arguments ({op, args}) — got ${JSON.stringify(v)}`,
  );
}

/**
 * Evaluate a serialized Constraint against a plain state object.
 *
 * @param constraint — {op, args} in the laws vocabulary (see header).
 * @param state — the plain JS object paths address (e.g. a folded
 *   topic state). Missing paths read as undefined and comparisons over
 *   them are unmet (false) — never silently met.
 * @param bindings — `$var` values keyed WITHOUT the '$'
 *   (e.g. { now: 1700000000000, author: 'user-x', by: 'agent:y' }
 *   serves `$now` / `$author` / `$by`).
 * @returns true iff the constraint holds.
 * @throws on malformed shapes and on forms outside the supported
 *   vocabulary (fail loud — see header).
 */
export function evaluateConstraint(
  constraint: Constraint,
  state: unknown,
  bindings: Record<string, unknown> = {},
): boolean {
  const c = asConstraint(constraint, 'evaluateConstraint');
  const lhs = () => resolveArg(c.args[0], 'path', state, bindings);
  const rhs = () => resolveArg(c.args[1], 'value', state, bindings);

  switch (c.op) {
    case 'eq': return equalByCheck(lhs(), rhs());
    case 'neq': return !equalByCheck(lhs(), rhs());

    // Ordering relations: both sides must be numbers (the `number` kind
    // check inside `check` enforces the LHS; the RHS guard mirrors it).
    // gte/lte are min/max conformance; gt/lt are their strict
    // complements over numeric LHS (a > b ⇔ a is a number and NOT a ≤ b).
    case 'gte': {
      const b = rhs();
      return typeof b === 'number' && check(createType('number', [min(b)]), lhs()).ok;
    }
    case 'lte': {
      const b = rhs();
      return typeof b === 'number' && check(createType('number', [max(b)]), lhs()).ok;
    }
    case 'gt': {
      const a = lhs(), b = rhs();
      return typeof b === 'number' && check(NUMBER, a).ok &&
        !check(createType('number', [max(b)]), a).ok;
    }
    case 'lt': {
      const a = lhs(), b = rhs();
      return typeof b === 'number' && check(NUMBER, a).ok &&
        !check(createType('number', [min(b)]), a).ok;
    }

    case 'exists': return lhs() !== undefined;
    case 'notExists': return lhs() === undefined;

    case 'count_lt':
    case 'count_gte': {
      const arg = c.args[0];
      if (typeof arg !== 'string') return false;
      const path = substituteSegments(arg, bindings);
      rejectGlob(path);
      const n = rhs();
      if (typeof n !== 'number') return false;
      const count = countKeysAtPath(state, path);
      const meetsMin = check(createType('number', [min(n)]), count).ok;
      return c.op === 'count_gte' ? meetsMin : !meetsMin;
    }

    case 'or_clause':
      return c.args.some(sub =>
        evaluateConstraint(asConstraint(sub, 'or_clause'), state, bindings));
    case 'and_clause':
      return c.args.every(sub =>
        evaluateConstraint(asConstraint(sub, 'and_clause'), state, bindings));
    case 'not_clause':
      return !evaluateConstraint(asConstraint(c.args[0], 'not_clause'), state, bindings);

    case 'forall':
      unsupported(`op 'forall' (variable-binding iteration)`);
    // eslint-disable-next-line no-fallthrough
    default:
      unsupported(`op '${c.op}'`);
  }
}
