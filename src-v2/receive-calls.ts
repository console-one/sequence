/**
 * receive-calls.ts (v2) — the ft CALL subset, executed against the kernel.
 *
 * Stage 1 of the v1 deletion ledger (2026-07-17): the write side of the
 * ft DSL lands on v2. This module REUSES the shared tokenizer/parser
 * (src/dsl — engine-neutral AST) and executes the OPERABLE subset an
 * LLM or console drives tools with:
 *
 *   x = content.get({ topicID: "t1", contentID: "c1" })
 *   note({ topic: "t1", text: "hello" })          (bare call: `_` bind)
 *
 * Calls resolve through `seq.impls` — v2's existing implementation
 * registry — and are ASYNC-NATIVE (`await impl(args)`): real transports
 * (kernel RPC, http) are async, which v1's synchronous walker could
 * never execute. Results insert back into the Sequence via the ONE
 * operation, so admission/rules/propagation apply to tool output like
 * any other fact.
 *
 * NOT here (by design, not omission): laws, classes, readers, narrows,
 * imports — the full receive port is a later ledger stage. Unsupported
 * statements are reported as errors, never silently skipped.
 */

import { parse } from '../src/dsl/parser';
import type { Statement, Expr, FunctionExpr } from '../src/dsl/ast';
import { FT } from '../src/builder';
import type { Type } from '../src/type';
import type { Sequence, InsertResult } from './sequence';

export type CallOutcome = {
  /** The bind path (`_` for a bare call). */
  path: string;
  /** The called impl path, when the statement was a call. */
  fn?: string;
  /** The awaited result value. */
  value: unknown;
  /** The kernel's insert result for the bind. */
  insert: InsertResult;
  /** True when this statement DEFINED a function (registered an impl +
   *  inserted its type) rather than executing one. */
  defined?: boolean;
};

export type ReceiveCallsResult = {
  outcomes: CallOutcome[];
  /** One entry per statement that could not be executed; the text names
   *  the statement kind so the caller (or LLM) can correct. */
  errors: string[];
};

/** Local bindings visible inside a fn body (params + body binds).
 *  Names resolve here FIRST, then fall through to the Sequence. */
type Scope = Map<string, unknown>;

/** Resolve a (possibly dotted) name to a value: exact scope hit, then
 *  the longest scope-bound prefix with the remainder dereferenced on
 *  the bound value (`l.title` where `l` is a param), then the cell at
 *  the full path, then the longest cell-valued prefix + deref (`x.items`
 *  where a whole object was bound at `x`). Prefix probing reads cells
 *  via getCell — no access events fire for speculative lookups; only
 *  the full-path get() is a real read. Unresolvable stays `undefined`
 *  (the subset's existing contract), never a throw. */
function derefName(seq: Sequence, name: string, scope?: Scope): unknown {
  if (scope?.has(name)) return scope.get(name);
  const segs = name.split('.');
  const walk = (root: unknown, rest: string[]): unknown => {
    let v: unknown = root;
    for (const s of rest) {
      if (v === null || typeof v !== 'object') return undefined;
      v = (v as Record<string, unknown>)[s];
    }
    return v;
  };
  if (scope) {
    for (let i = segs.length - 1; i >= 1; i--) {
      const prefix = segs.slice(0, i).join('.');
      if (scope.has(prefix)) return walk(scope.get(prefix), segs.slice(i));
    }
  }
  const direct = seq.get(name);
  if (direct !== undefined) return direct;
  for (let i = segs.length - 1; i >= 1; i--) {
    const prefix = segs.slice(0, i).join('.');
    const cell = seq.getCell(prefix);
    if (cell?.value !== undefined) return walk(cell.value, segs.slice(i));
  }
  return undefined;
}

/** Evaluate an argument expression to a VALUE. The subset is literals,
 *  objects, arrays, name reads (scope first, then seq.get), and nested
 *  calls (awaited). Anything else is a typed error naming the kind. */
async function evalArg(seq: Sequence, expr: Expr, scope?: Scope): Promise<unknown> {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const p of expr.properties) out[p.key] = await evalArg(seq, p.value, scope);
      return out;
    }
    case 'array': {
      if (!expr.elements) return [];
      const out: unknown[] = [];
      for (const el of expr.elements) {
        const v = await evalArg(seq, el.expr, scope);
        if (el.spread && Array.isArray(v)) out.push(...v);
        else out.push(v);
      }
      return out;
    }
    case 'name':
      return derefName(seq, expr.name, scope);
    case 'call':
      return invokeCall(seq, expr.fn, expr.args, scope);
    default:
      throw new Error(`unsupported argument expression: ${expr.kind}`);
  }
}

/** SPECIAL FORMS — the conditional-effects unlock (2026-07-18). A
 *  conditional guarding an EFFECT cannot be an ordinary function under
 *  eager evaluation (both branches would run — check-then-create becomes
 *  create-always). When `pick`/`or`/`attempt` are called with a single
 *  OBJECT-LITERAL argument, the evaluator itself elects: the condition
 *  evaluates first, then ONLY the chosen branch expression. Results are
 *  identical to the eager combinators for pure branches (every shipped
 *  renderer definition is unchanged); effectful branches become safe.
 *  `attempt({ do, else })` is the same mechanism for the error axis:
 *  evaluate `do`; on a thrown statement error, evaluate `else` instead
 *  (mirrors receiveCalls' collect-and-continue philosophy, scoped to an
 *  expression). Called with a non-literal argument (a bound object),
 *  pick/or fall through to their value-level impls — already-computed
 *  values have no evaluation order to elect. attempt has no value-level
 *  meaning and refuses non-literal args loudly. */
const SPECIAL_FORMS = new Set(['pick', 'or', 'attempt']);
const NOT_SPECIAL = Symbol('not-special');

async function evalSpecialForm(
  seq: Sequence,
  fn: string,
  argExprs: Expr[],
  scope?: Scope,
): Promise<unknown | typeof NOT_SPECIAL> {
  if (argExprs.length !== 1 || argExprs[0].kind !== 'object') {
    if (fn === 'attempt') {
      throw new Error(
        "attempt requires literal branches: attempt({ do: <expr>, else: <expr> })",
      );
    }
    return NOT_SPECIAL;
  }
  const props = new Map(argExprs[0].properties.map((p) => [p.key, p.value]));
  const evalProp = async (key: string): Promise<unknown> => {
    const e = props.get(key);
    return e === undefined ? undefined : evalArg(seq, e, scope);
  };
  if (fn === 'pick') {
    const cond = await evalProp('cond');
    return cond ? evalProp('a') : evalProp('b');
  }
  if (fn === 'or') {
    const a = await evalProp('a');
    if (a !== undefined && a !== null) return a;
    return evalProp('b');
  }
  // attempt
  try {
    return await evalProp('do');
  } catch {
    return evalProp('else');
  }
}

async function invokeCall(seq: Sequence, fn: string, argExprs: Expr[], scope?: Scope): Promise<unknown> {
  if (SPECIAL_FORMS.has(fn)) {
    const special = await evalSpecialForm(seq, fn, argExprs, scope);
    if (special !== NOT_SPECIAL) return special;
  }
  const impl = seq.impls.get(fn);
  if (!impl) throw new Error(`no implementation registered at '${fn}'`);
  const args: unknown[] = [];
  for (const a of argExprs) args.push(await evalArg(seq, a, scope));
  return await impl(...args);
}

/** `counters.{name}` → `counters.alice` — path segments interpolate from
 *  the fn scope (the dsl's `{var}` convention, fn-body.test.ts). */
function interpolatePath(path: string, scope: Scope): string {
  return path.replace(/\{(\w+)\}/g, (_, v: string) =>
    scope.has(v) ? String(scope.get(v)) : `{${v}}`,
  );
}

/** A minimal type-expression → Type mapping for fn param annotations.
 *  Primitives map exactly; anything richer degrades to a bare object —
 *  honest (the frame shows `{}`), refined later, never wrong. */
function typeExprToFT(t: Expr): Type {
  if (t.kind === 'primitive') {
    switch (t.base) {
      case 'string': return FT.string();
      case 'number': return FT.number();
      case 'boolean': return FT.boolean();
      case 'null': return FT.null();
    }
  }
  return FT.object();
}

/** DEFINE a function from `name = (params) -> [ body ]`: register an
 *  impl that executes the body statements in a local scope (params +
 *  body binds; the block's compiled state IS the return value, per the
 *  ast.ts contract), and insert the fn TYPE at the path so the
 *  definition appears in the hoisted frame like any built-in. */
function defineFn(seq: Sequence, path: string, fnExpr: FunctionExpr): InsertResult {
  const params = fnExpr.params;
  seq.impls.set(path, async (argsIn: unknown) => {
    const args = (argsIn ?? {}) as Record<string, unknown>;
    const scope: Scope = new Map();
    for (const p of params) {
      if (!p.optional && args[p.name] === undefined) {
        throw new Error(`${path}: param '${p.name}' is required`);
      }
      scope.set(p.name, args[p.name]);
    }
    const locals: Record<string, unknown> = {};
    for (const stmt of fnExpr.body ?? []) {
      if (stmt.kind === 'comment') continue;
      if (stmt.kind !== 'assign') {
        throw new Error(`${path}: unsupported body statement '${stmt.kind}' in the call subset`);
      }
      const bindPath = interpolatePath(stmt.path, scope);
      const value = await evalArg(seq, stmt.value, scope);
      scope.set(bindPath, value);
      locals[bindPath] = value;
    }
    return locals;
  });
  const shape: Record<string, Type> = {};
  for (const p of params) {
    shape[p.optional ? `${p.name}?` : p.name] = typeExprToFT(p.type);
  }
  return seq.insert({ path, type: FT.fn({ input: FT.object(shape) }) });
}

/**
 * Execute ONE call programmatically — the surface-compiler entry point
 * (terminal argv / MCP dispatch). A surface that already holds structured
 * args must not serialize them into ft text just to parse them back
 * (quoting/escaping of arbitrary user strings is a defect farm); it calls
 * here instead. Identical semantics to the `call` branch of receiveCalls:
 * same impl resolution, same result insertion (admission/rules apply to
 * the output like any other fact). Special forms don't apply — a surface
 * dispatches real registered fns, never evaluation-order forms.
 */
export async function receiveCall(
  seq: Sequence,
  fn: string,
  args?: unknown,
  bindPath = '_',
): Promise<CallOutcome> {
  const impl = seq.impls.get(fn);
  if (!impl) throw new Error(`no implementation registered at '${fn}'`);
  const value = await impl(args);
  const insert = seq.insert({ path: bindPath, value });
  return { path: bindPath, fn, value, insert };
}

/**
 * Parse ft `source` and execute its call statements against `seq`.
 * Each successful call binds its result: `x = fn(...)` inserts at `x`;
 * a bare `fn(...)` (parsed as an expression statement where the grammar
 * allows) binds at `_`. Errors are collected per-statement; execution
 * continues so one bad line does not mask the rest.
 */
export async function receiveCalls(seq: Sequence, source: string): Promise<ReceiveCallsResult> {
  const outcomes: CallOutcome[] = [];
  const errors: string[] = [];

  let statements: Statement[];
  try {
    statements = parse(source);
  } catch (e) {
    return { outcomes, errors: [`parse error: ${(e as Error).message}`] };
  }

  for (const stmt of statements) {
    try {
      if (stmt.kind === 'comment') continue;
      if (stmt.kind !== 'assign') {
        errors.push(`unsupported statement kind '${stmt.kind}' — the call subset executes assignments only`);
        continue;
      }
      const expr = stmt.value;
      if (expr.kind === 'function' && expr.body) {
        const insert = defineFn(seq, stmt.path, expr);
        const sig = expr.params.map((p) => `${p.name}${p.optional ? '?' : ''}`).join(', ');
        outcomes.push({ path: stmt.path, value: `fn(${sig})`, insert, defined: true });
      } else if (expr.kind === 'call') {
        const value = await invokeCall(seq, expr.fn, expr.args);
        const insert = seq.insert({ path: stmt.path, value });
        outcomes.push({ path: stmt.path, fn: expr.fn, value, insert });
      } else {
        // Plain value assignment in the same subset: evaluate and insert.
        const value = await evalArg(seq, expr);
        const insert = seq.insert({ path: stmt.path, value });
        outcomes.push({ path: stmt.path, value, insert });
      }
    } catch (e) {
      errors.push(`${stmt.kind === 'assign' ? stmt.path : stmt.kind}: ${(e as Error).message}`);
    }
  }

  return { outcomes, errors };
}
