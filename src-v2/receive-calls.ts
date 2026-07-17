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
import type { Statement, Expr } from '../src/dsl/ast';
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
};

export type ReceiveCallsResult = {
  outcomes: CallOutcome[];
  /** One entry per statement that could not be executed; the text names
   *  the statement kind so the caller (or LLM) can correct. */
  errors: string[];
};

/** Evaluate an argument expression to a VALUE. The subset is literals,
 *  objects, arrays, name reads (seq.get), and nested calls (awaited).
 *  Anything else is a typed error naming the unsupported kind. */
async function evalArg(seq: Sequence, expr: Expr): Promise<unknown> {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const p of expr.properties) out[p.key] = await evalArg(seq, p.value);
      return out;
    }
    case 'array': {
      if (!expr.elements) return [];
      const out: unknown[] = [];
      for (const el of expr.elements) {
        const v = await evalArg(seq, el.expr);
        if (el.spread && Array.isArray(v)) out.push(...v);
        else out.push(v);
      }
      return out;
    }
    case 'name':
      return seq.get(expr.name);
    case 'call':
      return invokeCall(seq, expr.fn, expr.args);
    default:
      throw new Error(`unsupported argument expression: ${expr.kind}`);
  }
}

async function invokeCall(seq: Sequence, fn: string, argExprs: Expr[]): Promise<unknown> {
  const impl = seq.impls.get(fn);
  if (!impl) throw new Error(`no implementation registered at '${fn}'`);
  const args: unknown[] = [];
  for (const a of argExprs) args.push(await evalArg(seq, a));
  return await impl(...args);
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
      if (expr.kind === 'call') {
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
