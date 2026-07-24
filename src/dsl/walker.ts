/**
 * walker.ts — The receive side of the ft protocol.
 *
 * Walks a parsed AST and mounts each statement into a Sequence.
 * This is NOT a compiler — the Sequence IS the compiler. This is
 * just the adapter that maps AST nodes to mount calls.
 */

import { type Statement, type Expr, type Modifiers, type PrimitiveConstraint, type WhereStatement } from './ast';
import { type Sequence, type MountResult } from '../sequence';
import { tokenize } from './tokenizer';
import { Parser } from './parser';
import {
  type Type, type Constraint, constraintOf,
  identity as identityConstraint,
  temporal as temporalConstraint,
  distribution as distributionConstraint,
  equation as equationConstraint,
  derived,
  createType,
  indexSpec,
  bindFrom,
  pattern as patternConstraint,
  min as minConstraint,
  max as maxConstraint,
  literal as literalConstraint,
} from '../type';
import { type BlockOpts } from '../statement';
import { FT } from '../builder';
import { compose } from '../compose';

/** Strip literal constraints from a type, keeping the structural shape.
 *  Used for array literals: [{name: "alice"}, {name: "bob"}] → array of {name: string} */
function generalizeType(type: Type): Type {
  if (type.kind === 'object') {
    const newConstraints = type.constraints.map(c => {
      if (c.op === 'property') {
        const [key, propType, optional] = c.args as [string, Type, boolean];
        return { op: 'property', args: [key, generalizeType(propType), optional] } as Constraint;
      }
      return c;
    });
    return createType('object', newConstraints, type.meta);
  }
  // Strip literal constraints — keep kind-level constraints
  const nonLiteral = type.constraints.filter(c => c.op !== 'literal');
  if (nonLiteral.length !== type.constraints.length) {
    return createType(type.kind, nonLiteral, type.meta);
  }
  return type;
}

export type WalkResult = {
  mounts: MountResult[];
  comments: { text: string; line: number }[];
};

/** Resolve an import path to ft text contents. Returns null if not found. */
export type ImportResolver = (path: string) => string | null;

/**
 * Walk AST statements, mount each into the Sequence.
 * Returns all mount results and preserved comments.
 *
 * `defaultOpts` (optional): block metadata merged into every mount
 * this walk produces — used by transports to thread author identity
 * on incoming messages so provenance enforcement can see who wrote
 * what. Implemented via a Proxy that wraps `seq` so no call site in
 * the walker needs to know it exists.
 */
/** If stmt is an assign/narrow of an object with GATED properties,
 *  return the lowered statement list: the parent statement (gated
 *  SCHEMA properties kept for shape, gates stripped; gated CONCRETE
 *  properties removed — their values must wait behind the gate) plus
 *  one child statement per gated property carrying the modifiers.
 *  Gate conditions resolve LEXICALLY: a condition path whose first
 *  segment names a sibling property is prefixed with the parent path
 *  (`while alive = true` inside Worker means Worker.alive); anything
 *  else (`events.taskExpired`, `_rt`) stays absolute. Null when there
 *  is nothing to lower — the common path is untouched. */
function lowerGatedProperties(stmt: Statement, seq?: Sequence): Statement[] | null {
  if (stmt.kind !== 'assign' && stmt.kind !== 'narrow') return null;
  const v = (stmt as any).value;
  if (!v || v.kind !== 'object') return null;
  const gated = v.properties.filter((p: any) => p.modifiers);
  if (gated.length === 0) return null;

  const parentPath = (stmt as any).path as string;
  // Lexical scope = the statement's own properties UNION the target's
  // already-declared properties (a narrow names only what it writes,
  // but its gates may reference any sibling the schema declares).
  const siblingKeys = new Set<string>(v.properties.map((p: any) => p.key));
  const declared = seq?.typeAt(parentPath);
  if (declared) {
    for (const c of declared.constraints) {
      if (c.op === 'property' && typeof c.args[0] === 'string') siblingKeys.add(c.args[0]);
    }
  }
  const scopePath = (path: string): string =>
    siblingKeys.has(path.split('.')[0]) ? `${parentPath}.${path}` : path;
  const scopeCondition = (c: any): any => {
    if (!c || typeof c !== 'object') return c;
    if (typeof c.path === 'string') return { ...c, path: scopePath(c.path) };
    if (c.lhs?.kind === 'name' && typeof c.lhs.name === 'string') {
      return { ...c, lhs: { ...c.lhs, name: scopePath(c.lhs.name) } };
    }
    return c;
  };
  const scopeModifiers = (m: any): any => ({
    ...m,
    ...(m.when ? { when: m.when.map(scopeCondition) } : {}),
    ...(m.while ? { while: m.while.map(scopeCondition) } : {}),
    ...(m.onBreak ? { onBreak: { ...m.onBreak, path: scopePath(m.onBreak.path) } } : {}),
  });

  const parentProps = v.properties
    .filter((p: any) => !p.modifiers || !isConcrete(p.value))
    .map((p: any) => (p.modifiers ? { key: p.key, value: p.value, optional: p.optional } : p));
  const out: Statement[] = [];
  if (parentProps.length > 0) {
    out.push({ ...(stmt as any), value: { kind: 'object', properties: parentProps } });
  }
  for (const p of gated) {
    out.push({
      kind: stmt.kind,
      path: `${parentPath}.${p.key}`,
      value: p.value,
      modifiers: scopeModifiers(p.modifiers),
    } as unknown as Statement);
  }
  return out;
}

export function walk(
  statements: Statement[],
  seqIn: Sequence,
  resolve?: ImportResolver,
  defaultOpts?: BlockOpts,
): WalkResult {
  const seq = defaultOpts ? wrapSeqWithDefaultOpts(seqIn, defaultOpts) : seqIn;
  const mounts: MountResult[] = [];
  const comments: { text: string; line: number }[] = [];

  for (const rawStmt of statements) {
    // Property-gate lowering: an assign/narrow whose object value has
    // gated properties (`{ task: string while alive = true }`) splits
    // into the parent statement minus those properties plus one child
    // statement per gated property carrying its own modifiers — so
    // property gates ARE statement gates, one semantics.
    const lowered = lowerGatedProperties(rawStmt, seq);
    if (lowered) {
      const sub = walk(lowered, seq, resolve);
      mounts.push(...sub.mounts);
      comments.push(...sub.comments);
      continue;
    }
    const stmt = rawStmt;
    // Glob expansion: if path contains .*, expand to all existing children
    // and mount the pattern for future children at the parent prefix
    if ('path' in stmt && typeof (stmt as any).path === 'string' && (stmt as any).path.includes('.*')) {
      const globPath = (stmt as any).path as string;
      const [prefix, ...rest] = globPath.split('.*');
      const suffix = rest.join('.*'); // handle nested globs
      const children = seq.keys(prefix);
      for (const child of children) {
        const expandedPath = suffix ? `${prefix}.${child}${suffix}` : `${prefix}.${child}`;
        const expandedStmt = { ...stmt, path: expandedPath } as Statement;
        const sub = walk([expandedStmt], seq);
        mounts.push(...sub.mounts);
      }
      // Also mount at the glob path itself as a pattern schema
      // so typeAt can find it for future children via ancestor walk
      if (stmt.kind === 'assign' || stmt.kind === 'narrow') {
        const type = toType(stmt.value);
        mounts.push(seq.mount('schema', globPath, type));
      }
      continue;
    }

    switch (stmt.kind) {
      case 'in': {
        // Scoped context: prefix all write paths in the body,
        // mount backing ref if present, propagate while clause.
        const inStmt = stmt as import('./ast').InStatement;
        const scopePath = inStmt.path;

        // Mount the backing ref if declared: `in path = backing`
        if (inStmt.backing) {
          const backingType = toType(inStmt.backing);
          const inOpts = inStmt.whileClause
            ? { while: inStmt.whileClause.map(toConstraint) }
            : undefined;
          mounts.push(seq.mount('schema', scopePath, backingType, inOpts));
        }

        // Rewrite the body: prefix every statement's path with
        // the scope path, and propagate the while clause as a
        // modifier on every statement. Then walk the rewritten
        // body through the normal walk — no scope stack needed.
        const prefixedBody: Statement[] = inStmt.body.map(s => {
          if ('path' in s && typeof (s as any).path === 'string') {
            const prefixed = { ...s, path: `${scopePath}.${(s as any).path}` };
            // Propagate while clause into modifiers
            if (inStmt.whileClause && 'modifiers' in s) {
              const mods = { ...(s as any).modifiers };
              mods.while = [...(mods.while ?? []), ...inStmt.whileClause];
              (prefixed as any).modifiers = mods;
            }
            return prefixed as Statement;
          }
          // Nested `in` — compose the paths
          if (s.kind === 'in') {
            return { ...s, path: `${scopePath}.${s.path}` } as Statement;
          }
          return s;
        });
        const sub = walk(prefixedBody, seq, resolve, defaultOpts);
        mounts.push(...sub.mounts);
        comments.push(...sub.comments);
        break;
      }

      case 'where_stmt': {
        // Conditional scope gate: evaluate conditions via the
        // kernel's evalWithBindings (which handles arithmetic,
        // derivation, aggregates, forall, and conjunction
        // propagation). When the where is inside a block-body fn
        // def, `_bindings` carries the fn-param scope that
        // substituteWhereStmt threaded through; at top level it's
        // empty and the kernel resolves against absolute paths
        // only.
        const bindings = (stmt as any)._bindings ?? {};
        const allPass = stmt.conditions.every(c => evalWhereCondition(c, seq, bindings));
        if (allPass) {
          const sub = walk(stmt.body, seq, resolve);
          mounts.push(...sub.mounts);
          comments.push(...sub.comments);
        }
        break;
      }

      case 'index': {
        // Declarative index-constrained schema. The surface:
        //   index <anchor> {
        //     over <v> in <set>
        //     [where <cond>, <cond>...]
        //     <body-stmts>
        //   }
        // compiles to a single schema mount at `anchor` carrying an
        // `indexSpec` constraint. The `over` clauses become
        // `bindFrom` entries in `where`, the filter conditions
        // become additional constraints (implicit AND with the
        // binds), and the body statements flatten into
        // `{op, path, value}` records with `{var}` interpolation
        // preserved verbatim — the kernel substitutes at fire time.
        const idx = stmt as import('./ast').IndexStatement;
        const indexedBy = idx.overs.map(o => o.variable);
        const whereConstraints: Constraint[] = [
          ...idx.overs.map(o => bindFrom(o.variable, o.from)),
          ...((idx.filter ?? []).map(toConstraint)),
        ];
        const body: Array<{ op: string; path: string; value?: unknown }> = [];
        for (const bs of idx.body) {
          if (bs.kind === 'assign' || bs.kind === 'narrow') {
            body.push({
              op: 'bind',
              path: (bs as any).path,
              value: toValue((bs as any).value, seq),
            });
          }
          // Other body statement kinds are deliberately not supported
          // yet: schema mounts, nested indexes, and sub-blocks are
          // open questions on how `{var}` interpolation composes with
          // them. Keep the surface honest: if you need them, mount
          // the indexSpec in TS until the semantics land.
        }
        mounts.push(seq.mount('schema', idx.anchor, createType('any', [
          indexSpec({ indexedBy, where: whereConstraints, body }),
        ])));
        break;
      }

      case 'spread_stmt': {
        // Projection primitive: `...project(glob_path, mapperFn).where(cond)`
        // iterates the glob, optionally filters, and invokes the mapper
        // fn once per qualifying child. Handled inline because the
        // semantics are "fire side effects for each tuple", not
        // "paste ft text".
        if (stmt.expr.kind === 'project') {
          applyProject(stmt.expr as any, seq, mounts);
          break;
        }

        // Block-level paste: evaluate the expr to a string of ft text
        // and walk it inline as if it had been written in place. The
        // typical form is `...expand()` where expand is a tool
        // returning a snippet. Non-string results are skipped (no-op).
        const snippet = toValue(stmt.expr, seq);
        if (typeof snippet === 'string' && snippet.length > 0) {
          const nested = receive(snippet, seq, resolve, defaultOpts);
          mounts.push(...nested.mounts);
          comments.push(...nested.comments);
        }
        break;
      }

      case 'assign': {
        // Block-body fn def: `fname = (args) -> [stmts]` (optionally `: T`).
        // Mount schema (fn type) + tool with live impl closure. The
        // closure binds params from input and re-walks the body with
        // those bindings substituted into paths and value expressions.
        if (stmt.value.kind === 'function' && (stmt.value as any).body) {
          const fnExpr = stmt.value as any;

          // Backwards inference v1: if the author wrote a return
          // annotation, compile the body's static path mounts into
          // a nested object type and verify that type implies the
          // declared return. Any property in the declared return
          // that the body doesn't statically produce is an error.
          // Dynamic-path statements (`{var}` segments) are skipped
          // in v1 — they need parameterized type support that isn't
          // wired yet. Annotations on bodies dominated by dynamic
          // paths will get a weak check; omit the annotation in
          // those cases until the stronger inference lands.
          if (fnExpr.returns) {
            const paramTypes: Record<string, Type> = {};
            for (const p of fnExpr.params) {
              paramTypes[p.name] = toType(p.type);
            }
            const compiledBody = compileBlockBodyType(fnExpr.body ?? [], paramTypes);
            const declaredReturn = toType(fnExpr.returns);
            const check = checkBlockBodyAgainstReturn(compiledBody, declaredReturn);
            if (check.ok === false) {
              throw new Error(
                `block-body fn "${stmt.path}" does not produce its declared return type: ${check.reason}`
              );
            }
          }

          const fnType = toType(stmt.value);
          const opts = toOpts(stmt.modifiers);
          mounts.push(seq.mount('schema', stmt.path, fnType, opts));
          const impl = buildFnImpl(fnExpr, seq, resolve);
          mounts.push(seq.mount('tool', stmt.path, impl, opts));
          break;
        }

        const type = toType(stmt.value);
        const opts = toOpts(stmt.modifiers);
        // If the value is concrete (literal/object with all literals), mount as bind.
        // If it's a type (schema), mount as schema.
        if (isConcrete(stmt.value)) {
          // Skip the kind-declaring schema mount when an ancestor (a
          // glob like `tasks.*`) already declares the path's kind.
          // Re-declaring with a different kind would be incoherent
          // and the substrate's coherence check would reject it; the
          // bind alone validates the value against the inherited
          // type. (Bind-without-prior-schema still gets the schema
          // mount to declare the kind for downstream readers.)
          const inherited = seq.typeAt(stmt.path);
          if (!inherited) {
            // Schema mount carries the kind only — strip the literal
            // so a gated `=` doesn't land the value through the
            // unconditional schema. The bind carries the value gated
            // by `opts.where`. R-A6.7.1.
            const schemaOnly: Type = { ...type, constraints: type.constraints.filter(c => c.op !== 'literal') };
            mounts.push(seq.mount('schema', stmt.path, schemaOnly));
          }
          mounts.push(seq.mount('bind', stmt.path, toValue(stmt.value, seq), opts));
        } else {
          mounts.push(seq.mount('schema', stmt.path, type, opts));
        }
        break;
      }

      case 'narrow': {
        // Block-RHS: structural patch with per-binding operator dispatch.
        // `a << { x << 3, y = 5 }` recurses each inner statement at the
        // prefixed sub-path, preserving its own kind (narrow vs assign).
        // No outer type compose — a block isn't a type, it's a patch shape.
        if (stmt.value.kind === 'block') {
          const inner: Statement[] = [];
          for (const inStmt of stmt.value.statements) {
            if (inStmt.kind === 'assign' || inStmt.kind === 'narrow') {
              inner.push({ ...inStmt, path: `${stmt.path}.${(inStmt as any).path}` } as Statement);
            }
          }
          const sub = walk(inner, seq, resolve, defaultOpts);
          mounts.push(...sub.mounts);
          comments.push(...sub.comments);
          break;
        }

        const opts = toOpts(stmt.modifiers);

        // Numeric leaf delta: `count << 5` on a numeric path is +=, not type
        // narrow. `<<` is monoid-meet at leaves; for numbers the meet is sum.
        // Without this, `count << 3` then `count << 5` composes literal(3) with
        // literal(5) → never, and the second narrow fails.
        if (stmt.value.kind === 'literal' && typeof stmt.value.value === 'number') {
          const existingType = seq.typeAt(stmt.path);
          if (existingType && existingType.kind === 'number') {
            const prior = seq.get(stmt.path);
            const base = typeof prior === 'number' ? prior : 0;
            mounts.push(seq.mount('bind', stmt.path, base + stmt.value.value, opts));
            break;
          }
        }

        const newType = toType(stmt.value);
        const existing = seq.typeAt(stmt.path);
        if (existing) {
          const composed = compose(existing, newType);
          if (composed.kind === 'never') {
            mounts.push({ ok: false, blockSeq: -1, nextWake: Infinity, gaps: [{ path: stmt.path, reason: 'narrow incompatible', constraint: { op: 'never', args: [] } }] });
            break;
          }

          // Value-binding through an existing object schema:
          // `tasks.deploy << { status: "pending", ... }` against an
          // inherited `tasks.* = { status: union, ... }` is binding a
          // task INSTANCE, not refining the schema. Skip the schema
          // overwrite — the composed type would have literal constraints
          // from the values (e.g. status: literal("pending")) that lock
          // the path against later updates. Sub-path binds below will
          // validate through the inherited schema.
          const isValueBindThroughSchema =
            isConcrete(stmt.value) &&
            stmt.value.kind === 'object' &&
            existing.kind === 'object';
          if (!isValueBindThroughSchema) {
            mounts.push(seq.mount('schema', stmt.path, composed, opts));
          }
        } else {
          mounts.push(seq.mount('schema', stmt.path, newType, opts));
        }
        // Bind concrete values at sub-paths
        if (stmt.value.kind === 'object') {
          for (const prop of stmt.value.properties) {
            if (isConcrete(prop.value)) {
              mounts.push(seq.mount('bind', `${stmt.path}.${prop.key}`, toValue(prop.value, seq), opts));
            }
          }
        } else if (isConcrete(stmt.value)) {
          mounts.push(seq.mount('bind', stmt.path, toValue(stmt.value, seq), opts));
        }
        break;
      }

      case 'delete':
        mounts.push(seq.mount('delete', stmt.path, undefined));
        break;

      case 'tool': {
        const opts = stmt.when ? { where: stmt.when.map(toConstraint) } : undefined;
        mounts.push(seq.mount('tool', stmt.path, true, opts));
        break;
      }

      case 'policy':
        mounts.push(seq.mount('policy', stmt.path, stmt.spec));
        break;

      case 'comment':
        comments.push({ text: stmt.text, line: stmt.line });
        break;

      case 'import': {
        // Import: load the file, receive its contents, bind the exported name.
        // If a resolver is provided, load and mount the file's contents.
        // The imported name becomes whatever the file defines at that name.
        if (resolve) {
          const content = resolve(stmt.from);
          if (content) {
            const imported = receive(content, seq, resolve);
            mounts.push(...imported.mounts);
            // If the file defines a type/value at the imported name, it's already mounted.
            // If not, create a ref so the name resolves to whatever the file exported.
            if (!seq.typeAt(stmt.name) && seq.get(stmt.name) === undefined) {
              mounts.push(seq.mount('schema', stmt.name, FT.ref(stmt.from.replace(/\.ft$/, ''))));
            }
          } else {
            // File not found — mount as unresolved ref (gap)
            mounts.push(seq.mount('schema', stmt.name, FT.ref(stmt.from)));
          }
        } else {
          // No resolver — mount as ref (gap until resolved)
          mounts.push(seq.mount('schema', stmt.name, FT.ref(stmt.from)));
        }
        break;
      }

      case 'export':
        // Export marks the block's result. At the walker level in a top-level
        // context, this is a no-op (the block handler manages exports).
        break;

      case 'reader': {
        // Reader: mounted observation contract at _readers.{name}.*
        // Each property becomes a value under the reader's namespace.
        // The hoist reads these to produce qualified projections.
        const readerPath = `_readers.${stmt.name}`;
        for (const prop of stmt.properties) {
          if (isConcrete(prop.value)) {
            mounts.push(seq.mount('bind', `${readerPath}.${prop.key}`, toValue(prop.value, seq)));
          } else {
            const propType = toType(prop.value);
            mounts.push(seq.mount('schema', `${readerPath}.${prop.key}`, propType));
            // If it's a name reference (like a path pattern), bind the string
            if (prop.value.kind === 'name') {
              mounts.push(seq.mount('bind', `${readerPath}.${prop.key}`, (prop.value as any).name));
            }
          }
        }
        // Mark as active reader
        mounts.push(seq.mount('bind', `${readerPath}._active`, true));
        break;
      }

      case 'class': {
        // Class desugars to mount operations:
        //   Constructor params → full type-checking where clauses
        //   while clause → lifecycle (dispose = while break → cascade invalidation)
        //   Body statements → schemas/tools/binds at prefix.path with class lifecycle
        //   `this` = the class name prefix, `prev` = sequence getPrevious
        const prefix = stmt.name;

        // Constructor params: mount schemas AND build where constraints.
        // Non-optional params gate mounting via `satisfies` (full type
        // check, not just exists — carries refinement predicates,
        // temporal bounds, probability models through to the guard).
        const whereConstraints: import('../type').Constraint[] = [];
        for (const p of stmt.params) {
          const paramType = toType(p.type);
          // Mount param schema so the gap is visible with full type info
          mounts.push(seq.mount('schema', p.name, paramType));
          if (!p.optional) {
            whereConstraints.push({ op: 'satisfies', args: [p.name, paramType] });
          }
        }

        // while clause → lifecycle. Full condition parser output —
        // supports AND/OR/NOT, temporal comparisons, regex, etc.
        const whileConstraints: import('../type').Constraint[] = stmt.whileClause
          ? stmt.whileClause.map(toConstraint)
          : [];

        const classOpts: import('../statement').BlockOpts = {
          ...(whereConstraints.length > 0 ? { where: whereConstraints } : {}),
          ...(whileConstraints.length > 0 ? { while: whileConstraints } : {}),
        };

        // Mount class status with lifecycle guards
        mounts.push(seq.mount('bind', `${prefix}._status`, 'ready', classOpts));

        // Walk ALL body statements under the class prefix.
        // Each body statement inherits the class lifecycle (classOpts)
        // AND carries its own modifiers (when/while/onBreak/by from the body stmt).
        for (const bodyStmt of stmt.body) {
          if (bodyStmt.kind === 'assign') {
            const bodyType = toType(bodyStmt.value);
            const bodyPath = `${prefix}.${bodyStmt.path}`;
            // Merge class lifecycle with statement's own modifiers
            const stmtOpts = toOpts(bodyStmt.modifiers) ?? {};
            const mergedWhere = [...(classOpts.where ?? []), ...((stmtOpts as any).where ?? [])];
            const mergedWhile = [...(classOpts.while ?? []), ...((stmtOpts as any).while ?? [])];
            const mergedOpts: import('../statement').BlockOpts = {
              ...(mergedWhere.length > 0 ? { where: mergedWhere } : {}),
              ...(mergedWhile.length > 0 ? { while: mergedWhile } : {}),
              ...((stmtOpts as any).onBreakPath ? { onBreakPath: (stmtOpts as any).onBreakPath } : {}),
              ...((stmtOpts as any).author ? { author: (stmtOpts as any).author } : {}),
            };

            if (bodyType.kind === 'fn') {
              // Method: fn type with full contract (preserves, identity,
              // equation, temporal, probability — all in the type constraints).
              // Tool marker makes it invocable. If the method has a block
              // body, mount the impl closure as the tool value.
              mounts.push(seq.mount('schema', bodyPath, bodyType, mergedOpts));
              const methodBody = bodyStmt.value.kind === 'function'
                ? (bodyStmt.value as any).body
                : undefined;
              const toolValue = methodBody
                ? buildFnImpl(bodyStmt.value as any, seq, resolve)
                : true;
              mounts.push(seq.mount('tool', bodyPath, toolValue, mergedOpts));
            } else {
              // Property: schema with full type (refinement predicates,
              // temporal constraints, etc). Bind if concrete.
              mounts.push(seq.mount('schema', bodyPath, bodyType, mergedOpts));
              if (isConcrete(bodyStmt.value)) {
                mounts.push(seq.mount('bind', bodyPath, toValue(bodyStmt.value, seq), mergedOpts));
              }
            }
          } else if (bodyStmt.kind === 'narrow') {
            // Narrow: compose with existing type at this path
            const bodyType = toType(bodyStmt.value);
            const bodyPath = `${prefix}.${bodyStmt.path}`;
            const existing = seq.typeAt(bodyPath);
            if (existing) {
              const composed = compose(existing, bodyType);
              mounts.push(seq.mount('schema', bodyPath, composed, classOpts));
            } else {
              mounts.push(seq.mount('schema', bodyPath, bodyType, classOpts));
            }
          } else if (bodyStmt.kind === 'tool') {
            // Tool declaration within class body
            const toolOpts = bodyStmt.when
              ? { where: [...(classOpts.where ?? []), ...bodyStmt.when.map(toConstraint)] }
              : classOpts;
            mounts.push(seq.mount('tool', `${prefix}.${bodyStmt.path}`, true, toolOpts));
          } else if (bodyStmt.kind === 'comment') {
            comments.push({ text: bodyStmt.text, line: bodyStmt.line });
          }
        }
        break;
      }
    }
  }

  return { mounts, comments };
}

/**
 * Receive ft text: parse and mount into a Sequence.
 * The complete receive side of the protocol.
 *
 * `defaultOpts` (optional): block metadata merged into every mount
 * this call produces. Threaded through to walk().
 *
 * `opts.mutable` (optional): strip schema-emission from this receive
 * pass so that `path = value` statements produce only the bind,
 * not the accompanying literal-valued schema that would lock the
 * path. Use for wire-protocol messages that carry mutable state
 * updates (heartbeats, status transitions, counters) — the client
 * sends `sessions.alice.heartbeat = 12345` repeatedly and each
 * call must overwrite the previous value. Without this, the first
 * mount locks `sessions.alice.heartbeat` to literal(12345), and
 * every subsequent heartbeat fails the type check silently.
 */
export function receive(
  ftText: string,
  seq: Sequence,
  resolve?: ImportResolver,
  defaultOpts?: BlockOpts,
  opts?: { mutable?: boolean },
): WalkResult {
  const tokens = tokenize(ftText);
  const ast = new Parser(tokens).parseProgram();
  const target = opts?.mutable ? stripSchemaEmission(seq) : seq;
  return walk(ast, target, resolve, defaultOpts);
}

/**
 * Proxy wrapper around a Sequence that merges `defaultOpts` into every
 * mount() call's block options. Used by walk() when the caller supplies
 * default block metadata (e.g. author identity for provenance).
 *
 * All non-mount method calls pass through to the original sequence
 * unchanged (bound to `target` so `this` resolves correctly).
 */
function wrapSeqWithDefaultOpts(seq: Sequence, defaultOpts: BlockOpts): Sequence {
  return new Proxy(seq, {
    get(target, prop, receiver) {
      if (prop === 'mount') {
        return function(...args: unknown[]): MountResult {
          // mount(op, path, value, opts?) OR mount(entries, opts?)
          if (typeof args[0] === 'string') {
            args[3] = { ...defaultOpts, ...((args[3] as BlockOpts | undefined) ?? {}) };
          } else {
            args[1] = { ...defaultOpts, ...((args[1] as BlockOpts | undefined) ?? {}) };
          }
          return (target.mount as (...a: unknown[]) => MountResult).apply(target, args);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Sequence;
}

// ═══════════════════════════════════════════════════════════════════════
// AST → FT Type conversion
// ═══════════════════════════════════════════════════════════════════════

function toType(expr: Expr): Type {
  switch (expr.kind) {
    case 'primitive':
      return buildPrimitive(expr.base, expr.constraints);

    case 'literal':
      if (typeof expr.value === 'string') return FT.string(expr.value);
      if (typeof expr.value === 'number') return FT.number(expr.value);
      if (typeof expr.value === 'boolean') return FT.boolean(expr.value);
      if (expr.value === null) return FT.null();
      return FT.any();

    case 'object':
      const props: Record<string, Type> = {};
      for (const p of expr.properties) {
        const key = p.optional ? `${p.key}?` : p.key;
        props[key] = toType(p.value);
      }
      return FT.object(props);

    case 'array': {
      if (expr.elements && expr.elements.length > 0) {
        // If any element is a spread, positional segment typing breaks
        // (the flattened value's positions don't line up with the
        // declared segment indices). Fall back to a homogeneous array
        // whose element type is the union of inlined element types.
        const hasSpread = expr.elements.some(el => el.spread);
        if (hasSpread) {
          const allTypes: Type[] = [];
          for (const el of expr.elements) {
            let elType = toType(el.expr);
            if (el.spread && elType.kind === 'array') {
              const inner = constraintOf(elType, 'element');
              if (inner) elType = inner.args[0] as Type;
            }
            allTypes.push(generalizeType(elType));
          }
          const elemType = allTypes.length === 1 ? allTypes[0] : FT.or(...allTypes);
          return FT.array(elemType);
        }
        // Segmented array: each position has its own type.
        const constraints: Constraint[] = [];
        const allTypes: Type[] = [];
        for (let i = 0; i < expr.elements.length; i++) {
          const el = expr.elements[i];
          const elType = toType(el.expr);
          constraints.push({ op: 'segment', args: [String(i), elType, undefined, undefined, el.spread] });
          allTypes.push(generalizeType(elType));
        }
        const elemType = allTypes.length === 1 ? allTypes[0] : FT.or(...allTypes);
        constraints.push({ op: 'element', args: [elemType] });
        return createType('array', constraints);
      }
      let arr = FT.array(toType(expr.element));
      if (expr.minLength !== undefined || expr.maxLength !== undefined) {
        arr = arr.length(expr.minLength, expr.maxLength);
      }
      return arr;
    }

    case 'function': {
      const input = FT.object(
        Object.fromEntries(expr.params.map(p => [
          p.optional ? `${p.name}?` : p.name,
          toType(p.type),
        ]))
      );
      // Block-body fn defs can omit the return annotation — in
      // that case the fn's output type is "whatever the body
      // compiles to". We don't infer it yet (future backwards
      // inference task); surface as `any` for the fn schema.
      const output = expr.returns ? toType(expr.returns) : FT.any();
      return FT.fn({ input, output });
    }

    case 'union':
      return FT.or(...expr.branches.map(toType));

    case 'intersection':
      return expr.members.map(toType).reduce((a, b) => compose(a, b));

    case 'name':
      // Glob names (`foo.*`) at type position become array-of-string
      // (the set of child keys). Plain names become refs so existing
      // `tasks.* = Task` style schema references keep working.
      if (expr.name.endsWith('.*')) return FT.array(FT.string());
      return FT.ref(expr.name);

    case 'ref':
      return FT.ref(expr.path);

    case 'call':
      // Inline derivation: total = sum(a, b)
      // → derived schema: derived('sum', 'a', 'b')
      return FT.derived(
        expr.fn,
        ...expr.args.map(a => a.kind === 'name' ? a.name : a.kind === 'literal' ? String(a.value) : ''),
      );

    case 'expansion':
      // Expansion token = gap. Mount as any (unconstrained obligation).
      return FT.any();

    case 'segmented': {
      // T1 . T2 . T3 → array type with per-position segment constraints.
      // Each position has its own type. The array's element type is the
      // union of all segment types (for overall validation), and each
      // position carries a segment constraint with its specific type.
      const segTypes = expr.segments.map(toType);
      const constraints: Constraint[] = [];
      for (let i = 0; i < segTypes.length; i++) {
        constraints.push({ op: 'segment', args: [String(i), segTypes[i], undefined, undefined, undefined] });
      }
      // Element type = union of all segment types (any position's value is one of these)
      const elemType = segTypes.length === 1 ? segTypes[0] : FT.or(...segTypes);
      constraints.push({ op: 'element', args: [elemType] });
      constraints.push({ op: 'arrayLength', args: [segTypes.length, segTypes.length] });
      return createType('array', constraints);
    }

    case 'refined': {
      // Base type + predicates → compile predicates to constraints on the base type
      const base = toType(expr.base);
      let baseConstraints: Constraint[] = [...base.constraints];
      let effKind = base.kind;
      let propertyTightened = false;
      const extraConstraints: Constraint[] = [];
      for (const pred of expr.predicates) {
        if (pred.kind === 'comparison') {
          // Value identity: lhs = rhs → identity constraint
          if (pred.op === '=') {
            const lhsPath = exprToPath(pred.lhs);
            const rhsPath = exprToPath(pred.rhs);
            if (lhsPath && rhsPath) {
              extraConstraints.push(identityConstraint(lhsPath, rhsPath));
            }
            // Also create an equation for cross-function identities with temporal scope
            if (pred.temporal) {
              const from = pred.temporal.from;
              const until = pred.temporal.until;
              extraConstraints.push(equationConstraint(lhsPath, rhsPath, {
                from: from ? exprToExpr(from) : undefined,
                until: until ? exprToExpr(until) : undefined,
              }));
            }
          }
          // Non-identity operators on a DIRECT property narrow that
          // property's own type using the vocabulary check() already
          // enforces (pattern/min/max/union-of-literals) — never a new
          // op the admission layer would silently ignore. Before
          // 2026-07-24 these predicates parsed (or failed to — the
          // MATCHES token bug) and were dropped here without effect.
          // Exact-semantics subset only: MATCHES, IN, >=, <=. Strict
          // >/</!= and HAS/SATISFIES stay on the SYNTAX_SUPPORTED gap
          // ledger rather than shipping approximated meanings.
          if (pred.op !== '=') {
            const lhsPath = exprToPath(pred.lhs);
            if (lhsPath && !lhsPath.includes('.')) {
              const rhsVal = exprToValue(pred.rhs);
              let narrow: Type | null = null;
              if (pred.op === 'MATCHES' && typeof rhsVal === 'string') {
                narrow = createType('string', [patternConstraint(rhsVal)]);
              } else if (pred.op === 'IN' && pred.rhs?.kind === 'union') {
                const values = (pred.rhs.branches as any[])
                  .map((b) => exprToValue(b))
                  .filter((v) => v !== undefined);
                if (values.length > 0) {
                  narrow = FT.or(...values.map((v) =>
                    createType(typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string', [literalConstraint(v)]),
                  )).toType();
                }
              } else if (pred.op === '>=' && typeof rhsVal === 'number') {
                narrow = createType('number', [minConstraint(rhsVal)]);
              } else if (pred.op === '<=' && typeof rhsVal === 'number') {
                narrow = createType('number', [maxConstraint(rhsVal)]);
              }
              if (narrow) {
                if (base.kind === 'object') {
                  // Object-scoped refinement: `{...} | email MATCHES /re/`
                  // — tighten the named property's type.
                  const propIdx = baseConstraints.findIndex(
                    (bc) => bc.op === 'property' && bc.args[0] === lhsPath,
                  );
                  if (propIdx >= 0) {
                    const [key, propType, optional] = baseConstraints[propIdx].args as [string, Type, boolean];
                    baseConstraints[propIdx] = { op: 'property', args: [key, compose(propType, narrow), optional] };
                    propertyTightened = true;
                  }
                } else if (narrow.kind === effKind) {
                  // Property-scoped refinement: `email: string | email
                  // MATCHES /re/` — the refined node wraps the property's
                  // own type, so the predicate tightens the base itself.
                  baseConstraints.push(...narrow.constraints);
                  propertyTightened = true;
                } else if (narrow.kind === 'or') {
                  // `role: string | role IN {…}` — a union narrow of a
                  // scalar goes through the lattice meet, which may change
                  // the kind (string ⊓ or(lits) = or(lits)).
                  const met = compose(createType(effKind, baseConstraints, base.meta), narrow);
                  effKind = met.kind;
                  baseConstraints = [...met.constraints];
                  propertyTightened = true;
                }
              }
            }
          }
          // Temporal constraint (activation/expiry)
          if (pred.temporal) {
            const from = pred.temporal.from;
            if (from) {
              extraConstraints.push(temporalConstraint('gt', '_rt', exprToExpr(from)));
            }
          }
          // Probability model
          if (pred.probability) {
            extraConstraints.push(distributionConstraint(
              'reliability',
              pred.probability.distribution as any,
              pred.probability.params,
            ));
          }
        }
        if (pred.kind === 'forall') {
          // Quantified predicates — store as a constraint for runtime evaluation
          extraConstraints.push({
            op: 'forall',
            args: [pred.variable, exprToPath(pred.set), compilePredicate(pred.body)],
          });
        }
      }
      if (extraConstraints.length === 0 && !propertyTightened) return base;
      return createType(effKind, [...baseConstraints, ...extraConstraints], base.meta);
    }

    case 'prev':
      // prev references resolve at mount time via getPrevious
      // In a type context, prev is a ref to the current path's prior value
      return FT.any();

    case 'block': {
      // Block = syntactic expansion. Flatten to derived ref.
      // Find the export statement — that's the block's type.
      const exportStmt = expr.statements.find(s => s.kind === 'export');
      if (exportStmt && exportStmt.kind === 'export') {
        // If the export references a transform(import), flatten to derived(transform, importPath)
        const exportExpr = exportStmt.value;
        if (exportExpr.kind === 'call') {
          // export transform(a) → derived(transform, a)
          const fnName = exportExpr.fn;
          const argPaths = exportExpr.args.map(a => {
            if (a.kind === 'name') return a.name;
            if (a.kind === 'ref') return a.path;
            return '_unknown';
          });
          // Resolve imports: find import statements and replace names with paths
          const imports = new Map<string, string>();
          for (const s of expr.statements) {
            if (s.kind === 'import') imports.set(s.name, s.from);
          }
          const resolvedArgs = argPaths.map(a => imports.get(a) ?? a);
          return createType('any', [derived(fnName, ...resolvedArgs)]);
        }
        // Otherwise just compile the export expression directly
        return toType(exportExpr);
      }
      // No export — compile all statements and return last assign's type
      const lastAssign = [...expr.statements].reverse().find(s => s.kind === 'assign');
      if (lastAssign && lastAssign.kind === 'assign') return toType(lastAssign.value);
      return FT.any();
    }

    default:
      return FT.any();
  }
}

function buildPrimitive(base: string, constraints: PrimitiveConstraint[]): Type {
  switch (base) {
    case 'string': {
      let t = FT.string();
      for (const c of constraints) {
        if (c.op === 'pattern') t = t.pattern(c.value);
        if (c.op === 'length') t = t.length(c.min, c.max);
      }
      return t;
    }
    case 'number': {
      let t = FT.number();
      for (const c of constraints) {
        if (c.op === 'min') t = t.min(c.value);
        if (c.op === 'max') t = t.max(c.value);
        if (c.op === 'range') t = t.min(c.lo).max(c.hi);
        if (c.op === 'integer') t = t.integer();
      }
      return t;
    }
    case 'boolean': return FT.boolean();
    case 'null': return FT.null();
    default: return FT.any();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// AST → concrete values (for bind mounts)
// ═══════════════════════════════════════════════════════════════════════

function isConcrete(expr: Expr): boolean {
  switch (expr.kind) {
    case 'literal': return true;
    case 'object': return expr.properties.every(p => isConcrete(p.value));
    case 'array': {
      if (expr.elements) return expr.elements.every(el => isConcrete(el.expr));
      // Single-element form `[T]` is concrete only if T is concrete —
      // in that case it's treated as a one-element value array by
      // toValue (used for spread targets especially).
      return isConcrete(expr.element);
    }
    case 'call':
      // A call with concrete args is treated as concrete at walk time:
      // the walker invokes the tool via toValue and binds the
      // result. If no impl is registered the call returns undefined
      // and no bind happens — the schema still gets mounted as a gap.
      return (expr as any).args.every((a: Expr) => isConcrete(a));
    case 'name':
      // Glob names (`foo.*`) at value position resolve to the set of
      // child keys — concrete-valued. Plain names are still treated
      // as type references (not values) so existing `tasks.* = Task`
      // style schema refs keep working.
      return (expr as any).name.endsWith('.*');
    default: return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// project(set, mapper) — iterate a glob path, invoke a mapper fn per child
// ═══════════════════════════════════════════════════════════════════════

/**
 * Handle `...project(BINDING in SET, MAPPER).where(COND)` at spread
 * statement position. Iterates concrete paths matching SET,
 * builds a binding object per match (named wildcards + merged
 * sub-path fields + `_path` / `_value`), optionally filters via
 * BINDING-qualified conditions, and invokes MAPPER once per
 * qualifying binding with the binding as input.
 *
 *     fulfill = (reqId, subject, response) -> [ ... ]
 *     ...project(r in req.{reqId}, fulfill).where(r.status = "claimed")
 *
 * Fires `fulfill` once per claimed request in `req.*`, with each
 * invocation receiving `{reqId: <childKey>, subject: <sub-path>,
 * response: <sub-path>, ...}`.
 */
function applyProject(
  expr: { binding: string; set: Expr; mapper: Expr; filter?: any },
  seq: Sequence,
  _mounts: MountResult[],
): void {
  // Set: path expression with named `{wildcard}` segments.
  if (expr.set.kind !== 'name') return;
  const setName = (expr.set as any).name as string;
  // Parse pattern segments; collect wildcard names and convert to
  // `*` for the glob expansion.
  const patternSegs = setName.split('.');
  const wildcardNames: string[] = [];
  const globSegs: string[] = [];
  for (const seg of patternSegs) {
    const m = seg.match(/^\{(\w+)\}$/);
    if (m) {
      wildcardNames.push(m[1]);
      globSegs.push('*');
    } else {
      globSegs.push(seg);
    }
  }
  if (wildcardNames.length === 0) {
    // No named wildcards means no iteration — reject. The form is
    // meant for iterating over a set, not for a fixed path.
    throw new Error(`project set "${setName}" has no named wildcards; use {name} to declare an iteration variable`);
  }
  const globPattern = globSegs.join('.');

  // Mapper: bare fn name resolving to an fn-typed schema with an impl.
  if (expr.mapper.kind !== 'name') return;
  const mapperName = (expr.mapper as any).name as string;
  const mapperType = seq.typeAt(mapperName);
  if (!mapperType || mapperType.kind !== 'fn') return;

  // Cache the runtime clock value for filter resolution — `_rt`
  // in a where-clause always means "now at iteration time".
  const rt = (seq.get('_rt') as number | undefined) ?? 0;

  // Expand the glob via the Sequence's pattern walker, then
  // iterate each concrete path. matchingPaths handles one-level
  // (`req.*`) and multi-level (`state.*.pending`) uniformly.
  const matched = seq.matchingPaths(globPattern);
  for (const concretePath of matched) {
    const concreteSegs = concretePath.split('.');
    // Build the binding record: named wildcards first, then
    // merge sub-path values (sub-paths can't overwrite wildcards),
    // then reserve `_path` / `_value` for full path and leaf.
    const r: Record<string, unknown> = {};
    for (let i = 0, w = 0; i < patternSegs.length; i++) {
      const m = patternSegs[i].match(/^\{(\w+)\}$/);
      if (m) {
        r[wildcardNames[w]] = concreteSegs[i];
        w++;
      }
    }
    // Merge sub-path values under the concrete path (useful for
    // leaf-wildcard forms where the iterated path has a record
    // beneath it, e.g. `req.{reqId}` where req.r1.status exists).
    const subKeys = seq.keys(concretePath);
    for (const k of subKeys) {
      if (k in r) continue; // wildcard wins
      const v = seq.get(`${concretePath}.${k}`);
      if (v !== undefined) r[k] = v;
    }
    // Also merge whole-object value if one exists at this path.
    const wholeValue = seq.get(concretePath);
    if (wholeValue !== null && typeof wholeValue === 'object' && !Array.isArray(wholeValue)) {
      for (const [k, v] of Object.entries(wholeValue as Record<string, unknown>)) {
        if (!(k in r)) r[k] = v;
      }
    }
    r._path = concretePath;
    r._value = wholeValue;

    // Filter via walker-level substitution + kernel evaluation.
    if (expr.filter) {
      const substituted = substituteBindingRefs(expr.filter, expr.binding, r);
      const bindings: Record<string, unknown> = { _rt: rt };
      if (!evalWhereCondition(substituted, seq, bindings)) continue;
    }

    // Invoke the mapper by calling its impl directly, not via
    // `seq.mount('bind', mapperName, r)`. The bind-to-fn-schema
    // path in applyEntry records `{mapperName}.input` and
    // `{mapperName}.result` sub-binds as real mutations — for
    // project iteration that means each iteration moves the
    // sequence head even when the body is a no-op (e.g. a req
    // that doesn't match any internal gate). That breaks
    // idempotency: ticking twice with the same state should
    // produce zero new mutations, but going through the fn-
    // invocation path always writes `.input`.
    //
    // Instead: look up the impl directly and call it with the
    // binding object. The closure (buildFnImpl) substitutes
    // params, walks the body, and mounts whatever the body
    // statements require. No `.input` / `.result` sidecar, no
    // spurious head advance.
    const impl = seq.toolAt(mapperName);
    if (typeof impl === 'function') {
      try { impl(r); } catch { /* silent — same as tool-call invariant */ }
    }
  }
}

/**
 * Walk a ConditionExpr tree, replacing `binding.field` references
 * with literal values from the binding object. Bare references to
 * the binding itself (just `r` with no field) pass through
 * unchanged. Exists / not_exists / matches on binding references
 * are pre-evaluated at walker level and collapsed into trivially
 * true/false `and_clause[]` / `or_clause[]` sentinels that the
 * kernel evaluates via `every([])` / `some([])`.
 *
 * The substituted AST is then handed to `evalWhereCondition`,
 * which routes through the kernel's evalConstraint pipeline for
 * the final evaluation (including arithmetic, aggregates,
 * derivation, and absolute-path reads).
 */
function substituteBindingRefs(cond: any, bindingName: string, r: Record<string, unknown>): any {
  if (!cond) return cond;
  switch (cond.kind) {
    case 'compare':
      return {
        ...cond,
        lhs: substituteBindingInExpr(cond.lhs, bindingName, r),
        rhs: substituteBindingInExpr(cond.rhs, bindingName, r),
      };
    case 'exists':
    case 'not_exists': {
      if (typeof cond.path === 'string' && cond.path.startsWith(bindingName + '.')) {
        const fieldPath = cond.path.slice(bindingName.length + 1);
        const value = resolveFieldPath(r, fieldPath);
        const present = value !== undefined;
        const result = (cond.kind === 'exists') ? present : !present;
        return result
          ? { kind: 'and', clauses: [] }   // trivially true
          : { kind: 'or', clauses: [] };   // trivially false
      }
      return cond;
    }
    case 'matches': {
      if (typeof cond.path === 'string' && cond.path.startsWith(bindingName + '.')) {
        const fieldPath = cond.path.slice(bindingName.length + 1);
        const value = resolveFieldPath(r, fieldPath);
        let matches = false;
        if (typeof value === 'string') {
          try { matches = new RegExp(cond.pattern).test(value); } catch { /* ignore */ }
        }
        return matches
          ? { kind: 'and', clauses: [] }
          : { kind: 'or', clauses: [] };
      }
      return cond;
    }
    case 'and':
      return { ...cond, clauses: cond.clauses.map((c: any) => substituteBindingRefs(c, bindingName, r)) };
    case 'or':
      return { ...cond, clauses: cond.clauses.map((c: any) => substituteBindingRefs(c, bindingName, r)) };
    case 'not':
      return { ...cond, clause: substituteBindingRefs(cond.clause, bindingName, r) };
  }
  return cond;
}

/** Substitute a binding reference in a compare operand expression. */
function substituteBindingInExpr(expr: any, bindingName: string, r: Record<string, unknown>): any {
  if (!expr) return expr;
  if (expr.kind === 'name' && typeof expr.name === 'string') {
    const name = expr.name;
    if (name === bindingName) {
      // Bare binding reference — not meaningful as a value. Leave
      // as-is; the kernel will look it up as a sequence path
      // (which will almost always return undefined).
      return expr;
    }
    if (name.startsWith(bindingName + '.')) {
      const fieldPath = name.slice(bindingName.length + 1);
      const value = resolveFieldPath(r, fieldPath);
      if (value === undefined) {
        // Binding has no such field — emit a literal undefined so
        // comparisons against it fail cleanly. The `{literal: ...}`
        // wrapper in exprToCompareOperand preserves undefined.
        return { kind: 'literal', value: null };
      }
      if (value === null) return { kind: 'literal', value: null };
      if (typeof value === 'string') return { kind: 'literal', value };
      if (typeof value === 'number') return { kind: 'literal', value };
      if (typeof value === 'boolean') return { kind: 'literal', value };
      // Non-scalar value — not directly comparable. Leave as-is;
      // compose-equality will see an object on the lhs and fail
      // loudly rather than silently skipping.
      return expr;
    }
  }
  return expr;
}

/** Walk an object along a dotted field path, returning undefined on miss. */
function resolveFieldPath(obj: unknown, path: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  const segments = path.split('.');
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
    if (cur === undefined) return undefined;
  }
  return cur;
}

// Project filter evaluation now delegates to `evalWhereCondition`
// (see below), which routes through the kernel's
// `seq.evalWithBindings` pipeline. The old hand-rolled
// `evalProjectFilter` / `resolveFilterPath` pair that duplicated a
// subset of `evalConstraint` has been removed — same principle as
// the where statement.

// ═══════════════════════════════════════════════════════════════════════
// Where statement: conditional scope gate
// ═══════════════════════════════════════════════════════════════════════
//
// Evaluation delegates to the kernel's existing `evalWithBindings` +
// `evalConstraint` pipeline rather than re-implementing a parallel
// boolean evaluator. That machinery already handles:
//
//   - derived paths: reading a path walks its derivation chain
//   - arithmetic: `a + b` in a comparison resolves as paths, combines
//   - aggregates / history: `sum(foo.*)`, `history(...)` etc.
//   - forall / count_lt / count_gte: quantified predicates
//   - or_clause / and_clause / not_clause: composed conjunction
//   - glob existence: `foo.*` in `exists` → any matching path
//   - `$var` and `{var}` substitution via substituteLiterals
//
// My previous hand-rolled `evalWhereCondition` duplicated a subset of
// the above and bypassed the dependency/conjunction plumbing. That
// meant determining one condition's value didn't feed the others'
// resolution space — derived paths wouldn't cascade, aggregates
// wouldn't resolve, forall wouldn't work. Delegating fixes all of it
// in one shot: where's conjunction flows through the same path the
// rest of the kernel uses for block-level where/while clauses.

/**
 * Evaluate a single `where` condition via the kernel's constraint
 * evaluator. `bindings` carries fn-param values when the where is
 * inside a block-body fn def; empty at top-level.
 *
 * Scalar bound names in compare operands are prefixed with `$`
 * before converting to a Constraint so the kernel's
 * substituteLiterals pass recognizes them and substitutes with
 * the binding values. Path-segment interpolation (`{var}` inside
 * a dotted path) is already handled by substituteLiterals.
 */
function evalWhereCondition(
  cond: any,
  seq: Sequence,
  bindings: Record<string, unknown> = {},
): boolean {
  const marked = markBoundNames(cond, bindings);
  const constraint = toConstraint(marked);
  return seq.evalWithBindings(constraint, bindings);
}

/**
 * Walk a ConditionExpr tree and rewrite any bare `name(X)`
 * reference in compare operands to `name($X)` whenever `X` is a
 * known binding. The `$` prefix hands the value off to the
 * kernel's substituteLiterals → evalConstraint pipeline, which
 * handles type preservation and aggregate / arithmetic / derived
 * resolution uniformly.
 */
function markBoundNames(cond: any, bindings: Record<string, unknown>): any {
  switch (cond?.kind) {
    case 'compare':
      return { ...cond, lhs: markBoundName(cond.lhs, bindings), rhs: markBoundName(cond.rhs, bindings) };
    case 'exists':
    case 'not_exists':
      return { ...cond, path: markBoundPath(cond.path, bindings) };
    case 'matches':
      return { ...cond, path: markBoundPath(cond.path, bindings) };
    case 'and':
    case 'or':
      return { ...cond, clauses: cond.clauses.map((c: any) => markBoundNames(c, bindings)) };
    case 'not':
      return { ...cond, clause: markBoundNames(cond.clause, bindings) };
  }
  return cond;
}

function markBoundName(operand: any, bindings: Record<string, unknown>): any {
  if (operand?.kind === 'name'
      && typeof operand.name === 'string'
      && !operand.name.includes('.')
      && !operand.name.startsWith('$')
      && operand.name in bindings) {
    return { kind: 'name', name: '$' + operand.name };
  }
  return operand;
}

/**
 * Mark a bare-identifier path with `$` prefix when it matches a
 * binding. Used for exists / not_exists / matches paths that
 * should resolve to a record field, not a sequence path.
 */
function markBoundPath(path: string, bindings: Record<string, unknown>): string {
  if (typeof path !== 'string') return path;
  if (!path.includes('.') && !path.startsWith('$') && path in bindings) {
    return '$' + path;
  }
  return path;
}

/**
 * Substitute param bindings into a where statement's BODY (the
 * statements that will run if conditions pass). Conditions are
 * NOT pre-substituted here — the kernel's `evalWithBindings` does
 * that work via `substituteLiterals`, which handles arithmetic,
 * aggregates, forall, and nested constraints uniformly. Pre-
 * substituting here would either duplicate that logic or miss
 * cases.
 *
 * Bindings are passed into the walker via `where_stmt`'s eval
 * call (see case 'where_stmt' in walk). The body walk then runs
 * with the same substituted pipeline it already used.
 */
function substituteWhereStmt(
  stmt: WhereStatement,
  bindings: Record<string, unknown>,
): WhereStatement {
  // Body substitution still happens (body is a mount sequence,
  // not a constraint tree). Conditions stay raw and go through
  // evalWithBindings with the same bindings at eval time.
  const body = stmt.body.map(s => substituteBodyStmt(s, bindings));
  return { kind: 'where_stmt', conditions: stmt.conditions, body, _bindings: bindings } as WhereStatement & { _bindings?: Record<string, unknown> };
}

// ═══════════════════════════════════════════════════════════════════════
// Block-body fn def: backwards inference
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compile a block body into a flat map of mutation shapes: each
 * entry is `pathGlob → valueType` where `pathGlob` is the mount
 * path with any `{var}` interpolation segments replaced by `*`.
 *
 * Dynamic compound segments like `p_{reqId}` become `p_*`. That
 * loses the literal prefix, which is a known v2 imprecision —
 * the annotation check is slightly weaker for compound segments.
 * v3 could encode literal + wildcard as a regex/pattern type.
 *
 * `where` block bodies are RECURSED INTO with an over-approximation
 * stance: conditional mutations are treated as potentially reached,
 * and their contributions are composed into the parent compiled
 * type. This matches "backwards inference checks that the body
 * CAN produce the declared return." An under-approximation (only
 * unconditional mounts) would reject correct programs whose output
 * depends on a where gate.
 *
 * The returned map is what the block reduces to at the type level:
 * a set of narrowings, each pinned to its glob-normalized path.
 */
function compileBlockBodyType(
  body: Statement[],
  paramTypes: Record<string, Type>,
): Map<string, Type> {
  const compiled = new Map<string, Type>();
  const addContribution = (pathGlob: string, valueType: Type): void => {
    const existing = compiled.get(pathGlob);
    // Multiple contributions to the same path are alternatives
    // (from mutually-exclusive where branches, or from sequential
    // overwrites where the runtime result is the last assignment).
    // Both cases are correctly over-approximated by a UNION of the
    // contribution types — not by compose (lattice meet), which
    // would reduce disjoint literals to `never` and block correct
    // programs like `where (X) { a = "ready" }; where (!X) { a = "waiting" }`.
    compiled.set(pathGlob, existing ? FT.or(existing, valueType) : valueType);
  };
  const walkStmts = (stmts: Statement[]): void => {
    for (const stmt of stmts) {
      if (stmt.kind === 'assign' || stmt.kind === 'narrow') {
        const pathGlob = stmt.path.replace(/\{[^}]+\}/g, '*');
        const valueType = inferExprType(stmt.value, paramTypes);
        addContribution(pathGlob, valueType);
      } else if (stmt.kind === 'where_stmt') {
        // Recurse into conditional branches — over-approximate.
        walkStmts(stmt.body);
      }
      // Other statement kinds (tool, delete, spread_stmt, comment,
      // import, export, class, reader, policy) contribute nothing
      // statically — they don't mount mutations the annotation
      // models, or the checker doesn't model their effects yet.
    }
  };
  walkStmts(body);
  return compiled;
}

/**
 * Infer a best-effort type for an expression, using known param
 * types to resolve bare names. Literals get literal constraints;
 * unknown expressions fall through to `any`.
 */
function inferExprType(expr: Expr, paramTypes: Record<string, Type>): Type {
  switch (expr.kind) {
    case 'literal':
      if (typeof expr.value === 'string') return FT.string(expr.value);
      if (typeof expr.value === 'number') return FT.number(expr.value);
      if (typeof expr.value === 'boolean') return FT.boolean(expr.value);
      return FT.null();
    case 'name': {
      const name = (expr as any).name as string;
      if (name === '_rt') return FT.number();
      if (paramTypes[name]) return paramTypes[name];
      return FT.any();
    }
    case 'object': {
      const shape: Record<string, Type> = {};
      for (const p of expr.properties) {
        shape[p.optional ? `${p.key}?` : p.key] = inferExprType(p.value, paramTypes);
      }
      return FT.object(shape);
    }
    default:
      return FT.any();
  }
}

/**
 * Flatten a nested object type into `pathGlob → leafType` entries.
 * Leaf types are anything non-object. Intermediate object layers
 * expand their property lists into path segments. Keys in the
 * declared annotation can be literals (match specific children)
 * or `"*"` (match any child).
 */
function flattenType(t: Type, prefix = ''): Map<string, Type> {
  const out = new Map<string, Type>();
  if (t.kind !== 'object') {
    out.set(prefix, t);
    return out;
  }
  const propConstraints = t.constraints.filter(c => c.op === 'property');
  if (propConstraints.length === 0) {
    // Empty object = leaf at this path
    out.set(prefix, t);
    return out;
  }
  for (const c of propConstraints) {
    const [key, propType] = c.args as [string, Type, boolean];
    const subPath = prefix ? `${prefix}.${key}` : key;
    const sub = flattenType(propType, subPath);
    for (const [k, v] of sub) out.set(k, v);
  }
  return out;
}

/**
 * Match a declared path against the compiled mutation map via
 * segment-wise comparison. A segment matches if both sides are
 * identical or if either side is `*`. Returns the first matching
 * [path, type] pair or undefined if none qualify.
 */
function findMatchingCompiledPath(
  declaredPath: string,
  compiled: Map<string, Type>,
): [string, Type] | undefined {
  const declSegs = declaredPath.split('.');
  for (const [compPath, compType] of compiled) {
    const compSegs = compPath.split('.');
    if (compSegs.length !== declSegs.length) continue;
    let ok = true;
    for (let i = 0; i < declSegs.length; i++) {
      if (declSegs[i] !== compSegs[i] && declSegs[i] !== '*' && compSegs[i] !== '*') {
        ok = false;
        break;
      }
    }
    if (ok) return [compPath, compType];
  }
  return undefined;
}

/**
 * Check that a compiled block-body mutation map implies the
 * declared return annotation. Each path in the flattened
 * declaration must match SOME compiled path (via glob), and the
 * value types must compose without narrowing to `never`.
 *
 * Scalar / function / union declarations on non-object types
 * pass through unchecked for now — the interesting case is
 * object-shaped returns describing "these fields get set".
 */
function checkBlockBodyAgainstReturn(
  compiled: Map<string, Type>,
  declared: Type,
): { ok: true } | { ok: false; reason: string } {
  if (declared.kind !== 'object') return { ok: true };
  const declaredFlat = flattenType(declared);
  for (const [declPath, declType] of declaredFlat) {
    const match = findMatchingCompiledPath(declPath, compiled);
    if (!match) {
      return {
        ok: false,
        reason: `declared path "${declPath}" is not produced by any body statement`,
      };
    }
    const [, compType] = match;
    const composed = compose(compType, declType);
    if (composed.kind === 'never') {
      return {
        ok: false,
        reason: `type mismatch at "${declPath}": compiled=${compType.kind}, declared=${declType.kind}`,
      };
    }
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════
// Block-body fn impl: closure that binds params and re-walks the body
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build an invocation closure for a block-body fn def. Called by the
 * sequence when someone writes a concrete value to the fn path:
 * the input value is an object whose fields match the declared params.
 * The closure binds them, substitutes into body statements, and walks.
 */
function buildFnImpl(
  fnExpr: { params: { name: string }[]; body?: Statement[] },
  seq: Sequence,
  resolve?: ImportResolver,
): (input: unknown) => unknown {
  const body = fnExpr.body ?? [];
  return (input: unknown): unknown => {
    const bindings: Record<string, unknown> = {};
    if (input !== null && typeof input === 'object') {
      for (const p of fnExpr.params) {
        bindings[p.name] = (input as Record<string, unknown>)[p.name];
      }
    }
    // Reserved name: `_rt` always resolves to the current clock value
    // at call time (not walk time), so time-stamped mounts in the
    // body pick up the per-invocation clock.
    bindings._rt = (seq.get('_rt') as number | undefined) ?? 0;

    // A block-body fn def is a MUTATION SEQUENCE, not a type
    // definition. The walker's assign handler normally emits a
    // literal-valued schema alongside every concrete bind, which
    // LOCKS the path to that literal — a later phase that tries
    // to mutate the same path gets rejected by the schema check.
    // For fn bodies, we want the binds but NOT the locking schema
    // emission. Wrap the sequence so `mount('schema', ...)` is a
    // no-op during the body walk; binds and other ops pass through.
    //
    // (If a fn body ever legitimately wants to declare a type, it
    // can use explicit narrowing via `<<`, which routes through
    // the narrow handler and takes a different code path.)
    const mutableSeq = stripSchemaEmission(seq);
    const substituted = body.map(s => substituteBodyStmt(s, bindings));
    walk(substituted, mutableSeq, resolve);
    return undefined;
  };
}

/**
 * Wrap a Sequence so `mount('schema', ...)` calls become no-ops
 * for the duration of a fn body walk. Prevents the walker from
 * emitting literal-valued schemas that would lock mutable-state
 * paths against subsequent phase transitions.
 *
 * All non-schema mount ops (bind, delete, tool, policy,
 * invalidate) and all non-mount methods pass through unchanged.
 */
function stripSchemaEmission(seq: Sequence): Sequence {
  return new Proxy(seq, {
    get(target, prop, receiver) {
      if (prop === 'mount') {
        return function(...args: unknown[]): MountResult {
          // mount(op, path, value, opts?) — single-op form
          if (typeof args[0] === 'string' && args[0] === 'schema') {
            return { ok: true, blockSeq: -1, nextWake: Infinity };
          }
          // mount(entries, opts?) — batched form: filter out schema entries
          if (Array.isArray(args[0])) {
            const filtered = (args[0] as Array<{ op: string }>).filter(e => e.op !== 'schema');
            if (filtered.length === 0) return { ok: true, blockSeq: -1, nextWake: Infinity };
            return (target.mount as any).apply(target, [filtered, ...args.slice(1)]);
          }
          return (target.mount as any).apply(target, args);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Sequence;
}

/** Substitute param bindings into a body statement's paths and values. */
function substituteBodyStmt(stmt: Statement, bindings: Record<string, unknown>): Statement {
  switch (stmt.kind) {
    case 'assign':
    case 'narrow':
      return {
        ...stmt,
        path: interpolatePathString(stmt.path, bindings),
        value: substituteBodyExpr(stmt.value, bindings),
      } as Statement;
    case 'delete':
      return { ...stmt, path: interpolatePathString(stmt.path, bindings) };
    case 'tool':
      return { ...stmt, path: interpolatePathString(stmt.path, bindings) };
    case 'export':
      return { ...stmt, value: substituteBodyExpr(stmt.value, bindings) };
    case 'spread_stmt':
      return { ...stmt, expr: substituteBodyExpr(stmt.expr, bindings) };
    case 'where_stmt':
      return substituteWhereStmt(stmt, bindings);
    default:
      return stmt;
  }
}

/** Recursively substitute param bindings into an expression tree. */
function substituteBodyExpr(expr: Expr, bindings: Record<string, unknown>): Expr {
  switch (expr.kind) {
    case 'name': {
      // Plain name matching a bound param → literal value.
      // Only scalar bindings substitute cleanly; object/array values
      // would need deeper handling, which we can add later.
      const name = (expr as any).name as string;
      if (name in bindings) {
        const v = bindings[name];
        if (v === null) return { kind: 'literal', value: null };
        if (typeof v === 'string') return { kind: 'literal', value: v };
        if (typeof v === 'number') return { kind: 'literal', value: v };
        if (typeof v === 'boolean') return { kind: 'literal', value: v };
      }
      return expr;
    }
    case 'object':
      return {
        ...expr,
        properties: expr.properties.map(p => ({ ...p, value: substituteBodyExpr(p.value, bindings) })),
      };
    case 'array':
      return {
        ...expr,
        element: substituteBodyExpr(expr.element, bindings),
        elements: expr.elements?.map(el => ({ ...el, expr: substituteBodyExpr(el.expr, bindings) })),
      };
    case 'call':
      return {
        ...expr,
        args: expr.args.map(a => substituteBodyExpr(a, bindings)),
      };
    case 'binop':
      return {
        ...expr,
        lhs: substituteBodyExpr(expr.lhs, bindings),
        rhs: substituteBodyExpr(expr.rhs, bindings),
      };
    default:
      return expr;
  }
}

/** Replace `{var}` segments in a path string using the bindings map. */
function interpolatePathString(path: string, bindings: Record<string, unknown>): string {
  return path.replace(/\{([^}]+)\}/g, (_, varName) => {
    if (varName in bindings) {
      const v = bindings[varName];
      if (v !== undefined && v !== null) return String(v);
    }
    return `{${varName}}`;
  });
}

function toValue(expr: Expr, seq?: Sequence): unknown {
  switch (expr.kind) {
    case 'literal': return expr.value;
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const p of expr.properties) obj[p.key] = toValue(p.value, seq);
      return obj;
    }
    case 'array': {
      // Single-element array form `[T]`: usually a type expression
      // ("array of T"), but when the element is concrete we reify it
      // as a one-element value array so spread callers get the right
      // shape.
      if (!expr.elements) {
        if (!isConcrete(expr.element)) return [];
        return [toValue(expr.element, seq)];
      }
      // Spread flattening: a spread element whose value is iterable
      // is inlined. Non-iterable spread values fall through as single
      // elements (same as a non-spread element).
      const out: unknown[] = [];
      for (const el of expr.elements) {
        const v = toValue(el.expr, seq);
        if (el.spread && Array.isArray(v)) {
          out.push(...v);
        } else {
          out.push(v);
        }
      }
      return out;
    }
    case 'name': {
      // Bare identifier at value position: resolve to the value at
      // that path in the Sequence. Glob paths (`foo.*`) resolve to
      // the set of child keys so spread consumers can iterate them.
      if (!seq) return undefined;
      const n = (expr as any).name as string;
      if (n.endsWith('.*')) {
        const prefix = n.slice(0, -2);
        return seq.keys(prefix);
      }
      return seq.get(n);
    }
    case 'call': {
      // Call at value position. Builtins first (string construction
      // primitives that let fn bodies build HTTP payloads, compose
      // config, etc.), then tool lookup.
      const ce = expr as any;
      const args = (ce.args as Expr[]).map((a: Expr) => toValue(a, seq));

      // Builtins — the string construction primitives that make
      // fn-body composition of http.fetch viable without TS code.
      switch (ce.fn) {
        case 'json':   return JSON.stringify(args[0]);
        case 'concat': return args.map(String).join('');
        case 'str':    return String(args[0] ?? '');
        case 'keys':   return seq ? seq.keys(args[0] as string) : [];
        case 'get':    return seq ? seq.get(args[0] as string) : undefined;
      }

      // Tool lookup
      if (!seq) return undefined;
      const impl = seq.toolAt(ce.fn);
      if (!impl) return undefined;
      try { return (impl as any)(...args); } catch { return undefined; }
    }
    default: return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Modifiers → BlockOpts
// ═══════════════════════════════════════════════════════════════════════

function toOpts(modifiers: Modifiers): BlockOpts | undefined {
  if (!modifiers.when && !modifiers.while && !modifiers.onBreak && !modifiers.author) return undefined;
  const opts: any = {};
  if (modifiers.when) opts.where = modifiers.when.map(toConstraint);
  if (modifiers.while) opts.while = modifiers.while.map(toConstraint);
  if (modifiers.onBreak) opts.onBreakPath = modifiers.onBreak.path;
  if (modifiers.author) opts.author = modifiers.author;
  return opts;
}

function toConstraint(cond: any): Constraint {
  const opMap: Record<string, string> = {
    '=': 'eq', '!=': 'neq',
    '<': 'lt', '<=': 'lte',
    '>': 'gt', '>=': 'gte',
  };
  switch (cond.kind) {
    case 'exists': return { op: 'exists', args: [cond.path] };
    case 'not_exists': return { op: 'notExists', args: [cond.path] };
    case 'compare': return { op: opMap[cond.op] ?? cond.op, args: [exprToCompareOperand(cond.lhs), exprToCompareOperand(cond.rhs)] };
    case 'matches': return { op: 'regex', args: [cond.path, cond.pattern] };
    case 'and': return { op: 'and_clause', args: cond.clauses.map(toConstraint) };
    case 'or': return { op: 'or_clause', args: cond.clauses.map(toConstraint) };
    case 'not': return { op: 'not_clause', args: [toConstraint(cond.clause)] };
    default: return { op: 'exists', args: ['_unknown'] };
  }
}

function exprToPath(expr: any): string {
  if (expr.kind === 'name') return expr.name;
  if (expr.kind === 'path') return expr.segments.join('.');
  if (expr.kind === 'temporal_ref') return `${expr.fn}._rt.${expr.boundary}`;
  if (expr.kind === 'call') {
    const base = `${expr.fn}(${expr.args.map(exprToPath).join(',')})`;
    return expr.resultPath?.length ? `${base}.${expr.resultPath.join('.')}` : base;
  }
  return String(expr.value ?? expr.name ?? '');
}

function exprToValue(expr: any): unknown {
  if (expr.kind === 'literal') return expr.value;
  if (expr.kind === 'name') return expr.name;
  return undefined;
}

/**
 * Convert a compare-condition operand to the shape `evalConstraint`
 * expects. A literal becomes `{literal: value}` so the evaluator
 * treats it as a value, not a path. A name becomes its raw string
 * so `resolvePath` / `resolveValue` can apply their substitution /
 * lookup rules. This matters when walker preprocessing has
 * substituted a binding reference into a literal — without the
 * wrapper the literal would be reinterpreted as a sequence path
 * and lookups would silently return undefined.
 */
function exprToCompareOperand(expr: any): unknown {
  if (!expr) return undefined;
  if (expr.kind === 'literal') return { literal: expr.value };
  if (expr.kind === 'name') return expr.name;
  // Arithmetic operands emerge from `a ± b` / `a * b` / `a / b` in
  // DSL condition positions (e.g. `heartbeat > _rt - 100`). The
  // kernel's evalWithBindings evaluates a `{op, lhs, rhs}` shape
  // uniformly across the four operators — emit that form so the
  // same condition AST flows through admission, index filters, and
  // derived predicates without a parallel branch per site.
  if (expr.kind === 'binop') {
    return {
      op: expr.op,
      lhs: exprToCompareOperand(expr.lhs),
      rhs: exprToCompareOperand(expr.rhs),
    };
  }
  return exprToPath(expr);
}

// ═══════════════════════════════════════════════════════════════════════
// AST Expr → type.ts Expr (for temporal bounds in equations)
// ═══════════════════════════════════════════════════════════════════════

function exprToExpr(expr: any): any {
  if (expr.kind === 'literal' && typeof expr.value === 'number') return expr.value;
  if (expr.kind === 'name') return expr.name;
  if (expr.kind === 'temporal_ref') return `${expr.fn}._rt.${expr.boundary}`;
  if (expr.kind === 'binop') {
    if (expr.op === '+') return { add: [exprToExpr(expr.lhs), exprToExpr(expr.rhs)] };
    if (expr.op === '*') return { mul: [exprToExpr(expr.lhs), exprToExpr(expr.rhs)] };
  }
  if (expr.kind === 'call') {
    // A call with a result path (`next_write(p).T_out`) is a SYMBOLIC
    // reference into a future call's output — pass it through as the
    // same path string the equation/temporal layer speaks.
    if (expr.resultPath?.length) return exprToPath(expr);
    return { fn: expr.fn, arg: exprToExpr(expr.args[0]) };
  }
  return expr.name ?? expr.value ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════
// Predicate → Constraint (for forall bodies)
// ═══════════════════════════════════════════════════════════════════════

function compilePredicate(pred: any): Constraint {
  if (pred.kind === 'comparison') {
    return {
      op: pred.op === '=' ? 'eq' : pred.op,
      args: [exprToPath(pred.lhs), exprToValue(pred.rhs) ?? exprToPath(pred.rhs)],
    };
  }
  if (pred.kind === 'forall') {
    return {
      op: 'forall',
      args: [pred.variable, exprToPath(pred.set), compilePredicate(pred.body)],
    };
  }
  return { op: 'eq', args: ['_unknown', '_unknown'] };
}
