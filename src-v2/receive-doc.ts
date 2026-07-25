/**
 * receive-doc.ts (v2) — the ft DEFINITION-SET subset, mounted on the
 * kernel. Stage 2 of the v1 deletion ledger: where receive-calls.ts
 * (stage 1) executes the calls an LLM drives tools WITH, this module
 * receives the documents a kernel vends tools THROUGH — the round-trip
 * law's receiving half. A second kernel that receives a vended document
 * gains the tools, WITH their constraints queryable from the types:
 *
 *   mail.search = (q: string) -> { hits: [string] } ~survival(exp, r)
 *       → insert fn type; the distribution suffix mounts as
 *         distribution('time', 'exponential', { rate: r })
 *   mail.search._validUntil = 1060000
 *       → insert the fact AND narrow the tool's type with
 *         lte('$now', 1060000) — the exact family validity.ts
 *         timeHorizon() reads; expiry is queryable from the type alone
 *   mail.search._reliability = { alpha: 9, beta: 1 }
 *       → insert the fact AND narrow with
 *         distribution('reliability', 'beta', {alpha, beta})
 *   narratives.team = "..."   → plain fact bind
 *   tool mail.search          → offer assertion: fn type must exist
 *
 * This is why nothing load-bearing may live in `--` comments: strip
 * every comment from a vended frame and this module still reconstructs
 * the same tools, the same constraints, the same expiry facts.
 *
 * NOT here (by design, not omission): laws, classes, readers, imports,
 * fn BODIES (those execute — receive-calls.ts owns them). Unsupported
 * statements are reported as errors, never silently skipped. Call
 * statements with literal args are executed through the shared
 * receiveCall path so admission/rules apply to their output.
 */

import { parse } from '../src/dsl/parser';
import type { Statement, Expr, FunctionExpr } from '../src/dsl/ast';
import { toType } from '../src/dsl/walker';
import { FT } from '../src/builder';
import {
  type Constraint, createType, param, returns, lte, distribution,
} from '../src/type';
import type { Sequence } from './sequence';
import { receiveCall } from './receive-calls';

export type ReceiveDocResult = {
  /** Statements applied (inserts + executed calls). */
  applied: number;
  /** Tool paths whose fn types this document mounted. */
  tools: string[];
  /** One entry per statement that could not be applied, naming why. */
  errors: string[];
};

// ── type expressions → Type: the SHARED walker mapping ──────────────
// One AST→Type conversion serves both engines (src/dsl/walker toType):
// primitives with inline constraints, objects, arrays, unions, literal
// types, and refinement predicates (MATCHES/IN/>=/<= — the exact-
// semantics subset) all mount with their constraints intact.

/** The parsed `~family(params)` suffix → a distribution constraint on
 *  the definition. `survival(exp, r)` is the spec's positional form for
 *  the exponential family over completion time. */
function distributionConstraintOf(
  d: NonNullable<FunctionExpr['distribution']>,
): Constraint {
  const family = d.family === 'exp' ? 'exponential' : d.family;
  if (family === 'survival') {
    const params = { ...d.params };
    const sub = (params as Record<string, unknown>).distribution;
    delete (params as Record<string, unknown>).distribution;
    const mapped = sub === 'exp' ? 'exponential' : typeof sub === 'string' ? sub : 'exponential';
    return distribution('time', mapped as 'exponential', params);
  }
  return distribution('time', family as 'exponential', d.params);
}

// ── concrete value expressions (fact binds) ──────────────────────────

function valueFromExpr(e: Expr): unknown {
  switch (e.kind) {
    case 'literal': return e.value;
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const p of e.properties) out[p.key] = valueFromExpr(p.value);
      return out;
    }
    case 'array':
      return (e.elements ?? []).map((el) => valueFromExpr(el.expr));
  }
  throw new Error(`unsupported value expression '${e.kind}' in a fact bind`);
}

/** Sibling-fact grammar: `<tool>._validUntil` / `<tool>._reliability`
 *  binds ALSO narrow the tool's type, so the fact is queryable from the
 *  type alone (planner-readable, merge-safe). */
function siblingConstraint(path: string, value: unknown): { tool: string; c: Constraint } | null {
  const m = /^(.*)\._(validUntil|reliability)$/.exec(path);
  if (!m) return null;
  const tool = m[1];
  if (m[2] === 'validUntil' && typeof value === 'number') {
    return { tool, c: lte('$now', value) };
  }
  if (m[2] === 'reliability' && value !== null && typeof value === 'object') {
    const { alpha, beta } = value as { alpha?: number; beta?: number };
    if (typeof alpha === 'number' && typeof beta === 'number') {
      return { tool, c: distribution('reliability', 'beta', { alpha, beta }) };
    }
  }
  return null;
}

/**
 * Parse ft `source` and mount its definition-set statements: fn type
 * declarations (no body), concrete fact binds (with the sibling-fact
 * constraint grammar), `tool` offer assertions, and literal-arg calls
 * (via the shared receiveCall). Errors are collected per statement;
 * one bad line never masks the rest.
 */
export async function receiveDocument(seq: Sequence, source: string): Promise<ReceiveDocResult> {
  const result: ReceiveDocResult = { applied: 0, tools: [], errors: [] };

  let statements: Statement[];
  try {
    statements = parse(source);
  } catch (e) {
    result.errors.push(`parse error: ${(e as Error).message}`);
    return result;
  }

  // The document's session id, if it declares one — used below to mark
  // received tools with their ORIGIN (the chain-provenance seed).
  const sessionStmt = statements.find(
    (s): s is Statement & { path: string } =>
      'path' in s && typeof (s as { path?: unknown }).path === 'string'
      && (s as { path: string }).path.startsWith('_sessions.'),
  );
  const docSession = sessionStmt?.path.split('.')[1];

  for (const stmt of statements) {
    try {
      switch (stmt.kind) {
        case 'comment':
          continue;

        case 'tool': {
          // Offer assertion: on v2 a tool IS a typed fn cell; the mark
          // must land on one that exists.
          if (seq.rawTypeAt(stmt.path)?.kind !== 'fn') {
            result.errors.push(`tool ${stmt.path}: no fn definition mounted at that path`);
          }
          continue;
        }

        case 'assign':
        case 'narrow': {
          const expr = stmt.value;

          // fn WITH body → executes; that is receive-calls' contract.
          if (expr.kind === 'function' && expr.body) {
            result.errors.push(
              `${stmt.path}: fn bodies execute — issue through receiveCalls, not the document subset`,
            );
            continue;
          }

          // fn declaration (no body) → mount the type.
          if (expr.kind === 'function') {
            const shape: Record<string, unknown> = {};
            for (const p of expr.params) {
              shape[p.optional ? `${p.name}?` : p.name] = toType(p.type);
            }
            const constraints: Constraint[] = [
              param(FT.object(shape as never).toType()),
            ];
            if (expr.returns) constraints.push(returns(toType(expr.returns)));
            if (expr.distribution) constraints.push(distributionConstraintOf(expr.distribution));
            seq.insert({ path: stmt.path, type: createType('fn', constraints) });
            result.tools.push(stmt.path);
            result.applied++;
            continue;
          }

          // call with literal args → the shared execution path.
          if (expr.kind === 'call') {
            const args = expr.args.map((a) => valueFromExpr(a));
            await receiveCall(seq, expr.fn, args[0], stmt.path);
            result.applied++;
            continue;
          }

          // concrete fact bind.
          const value = valueFromExpr(expr);
          seq.insert({ path: stmt.path, value });
          result.applied++;
          const sib = siblingConstraint(stmt.path, value);
          if (sib && seq.rawTypeAt(sib.tool)?.kind === 'fn') {
            seq.insert({ path: sib.tool, type: createType('fn', [sib.c]) });
          }
          continue;
        }

        default:
          result.errors.push(
            `unsupported statement kind '${stmt.kind}' — the document subset mounts definitions, facts and offers`,
          );
      }
    } catch (e) {
      result.errors.push(`${'path' in stmt ? `${(stmt as { path: string }).path}: ` : ''}${(e as Error).message}`);
    }
  }

  // ORIGIN MARKING (beat 12 seed): every tool received from a vended
  // document carries its grantor's session as chain provenance. A doc
  // that already stated a longer `._origin.chain` (a re-vend) keeps it —
  // the vendor extended the chain at emission.
  if (docSession) {
    for (const tool of result.tools) {
      if (tool.startsWith('_')) continue;
      if (seq.get(`${tool}._origin.chain`) === undefined) {
        seq.insert({ path: `${tool}._origin.chain`, value: docSession });
      }
    }
  }

  return result;
}
