/**
 * compose.ts — The lattice. compose + everything derived from it.
 *
 * compose(A, B) → C: tightest type consistent with both.
 * check(type, value) → { ok, gaps }: does value satisfy type (uses compose).
 * backwardInfer(fn, required) → input type (via preserves).
 * concreteness(type) → [0,1]: probability from lattice position.
 * evaluateExpr(expr, bindings) → value ± margin.
 */

import {
  type Type, type Constraint, type Expr,
  createType, isNever, isAny, constraintOf, constraintsOf,
  properties, elementType, literalValue, never as neverType,
  ANY, property,
} from './type';

// ═══════════════════════════════════════════════════════════════════════
// GAP — a constraint that a value fails to satisfy
// ═══════════════════════════════════════════════════════════════════════

export type Gap = {
  readonly path: string;
  readonly reason: string;
  readonly constraint: Constraint;
  readonly needed?: Type;
};

export type Follow = {
  readonly ref: string;       // where to continue
  readonly path: string;      // which part of the value
  readonly value: unknown;    // the decomposed portion
};

export type CheckResult =
  | { ok: true; follows?: Follow[] }
  | { ok: false; gaps: Gap[] };

// ═══════════════════════════════════════════════════════════════════════
// COMPOSE — lattice meet
// ═══════════════════════════════════════════════════════════════════════

/**
 * Compose two types: produce the tightest type consistent with both.
 *
 * This is the lattice meet (greatest lower bound). The result has
 * every constraint from both A and B, tightened where they overlap.
 *
 * Returns never if the types are contradictory.
 */
export function compose(a: Type, b: Type): Type {
  // Identity: any ∧ X = X
  if (isAny(a)) return b;
  if (isAny(b)) return a;

  // Absorbing: never ∧ X = never
  if (isNever(a)) return a;
  if (isNever(b)) return b;

  // Union: compose distributes over or
  if (a.kind === 'or') return composeOr(a, b);
  if (b.kind === 'or') return composeOr(b, a);

  // Function application: fn << value = invoke (apply input, produce output)
  // If one side is a function type and the other matches its input type,
  // the compose result is the function's output type — this IS invocation.
  //
  // NOTE: compose is a lattice meet — it answers "can these types coexist?"
  // For fn application, it checks if the input type COMPOSES with the param
  // type (existential). Callers that need universal coverage (does the input
  // HAVE all required params?) should use covers() separately.
  // selectFirstBranch uses compose here for type-level branch elimination.
  // The DSL walker rejects `fn << value` at the statement level — fn
  // invocation uses call syntax: result = fn(args).
  if (a.kind === 'fn' && b.kind !== 'fn') {
    const paramConstraint = a.constraints.find(c => c.op === 'param');
    if (paramConstraint) {
      const inputType = paramConstraint.args[0] as Type;
      // If b composes with the input type without producing never, it's a valid application
      const inputCompose = b.kind === inputType.kind ? compose(inputType, b) : neverType('');
      if (!isNever(inputCompose)) {
        // Before returning the output, check the fn's own constraints for
        // deadline feasibility. Distribution + confidence + temporal on the fn
        // type may make this invocation infeasible even though the input matches.
        const fnContradiction = detectContradiction('fn', a.constraints as Constraint[]);
        if (fnContradiction) return neverType(fnContradiction);
        // Application succeeds — result is the output type
        const returnsConstraint = a.constraints.find(c => c.op === 'returns');
        if (returnsConstraint) return returnsConstraint.args[0] as Type;
        return ANY; // no declared output → any
      }
    }
  }
  if (b.kind === 'fn' && a.kind !== 'fn') {
    return compose(b, a); // symmetric — try the other direction
  }

  // Kind compatibility
  if (a.kind !== b.kind) {
    return neverType(`incompatible kinds: ${a.kind} and ${b.kind}`);
  }

  // Same kind — merge constraints
  return composeConstraints(a, b);
}

/**
 * Compose a union type with another type.
 * Distributes: (A | B) ∧ C = (A ∧ C) | (B ∧ C)
 * Drops branches that produce never.
 */
function composeOr(union: Type, other: Type): Type {
  const branches = constraintsOf(union, 'branch').map(c => c.args[0] as Type);
  const composed = branches
    // Coverage gate: a branch must accept the candidate before
    // compose runs. Without this, compose of non-overlapping object
    // properties always succeeds (the meet just unions them), so
    // every object branch survives. With the gate, branches whose
    // requirements aren't covered by the candidate are eliminated.
    // This makes union narrowing (`<< scopeType`) actually dispatch.
    .filter(branch => branchAccepts(branch, other))
    .map(branch => compose(branch, other))
    .filter(t => !isNever(t));

  if (composed.length === 0) return neverType('all union branches contradicted');
  if (composed.length === 1) return composed[0];
  return createType('or', composed.map(t => ({ op: 'branch', args: [t] })));
}

/**
 * Compose constraints from two types of the same kind.
 *
 * Strategy: collect all constraints. For pairs that interact
 * (e.g., two min constraints, two property constraints on same key),
 * compute the meet. For independent constraints, keep both.
 */
function composeConstraints(a: Type, b: Type): Type {
  const kind = a.kind;
  const result: Constraint[] = [];
  const handled = new Set<number>(); // indices in b.constraints that were merged

  for (const ca of a.constraints) {
    const merger = pairHandlers[ca.op];
    if (merger) {
      // Find matching constraints in b
      let merged = false;
      for (let i = 0; i < b.constraints.length; i++) {
        if (handled.has(i)) continue;
        const cb = b.constraints[i];
        if (cb.op !== ca.op && !merger.compatOps?.includes(cb.op)) continue;

        const meet = merger.meet(ca, cb);
        if (meet === null) {
          // Contradictory
          return neverType(`contradictory: ${ca.op}(${ca.args}) vs ${cb.op}(${cb.args})`);
        }
        if (meet !== undefined) {
          result.push(meet);
          handled.add(i);
          merged = true;
          break;
        }
        // undefined = no interaction, keep looking
      }
      if (!merged) result.push(ca);
    } else {
      result.push(ca);
    }
  }

  // Add unhandled constraints from b
  for (let i = 0; i < b.constraints.length; i++) {
    if (!handled.has(i)) result.push(b.constraints[i]);
  }

  // Check for contradictions in the merged set
  const contradiction = detectContradiction(kind, result);
  if (contradiction) return neverType(contradiction);

  // Merge metadata
  const meta = a.meta || b.meta
    ? { ...b.meta, ...a.meta }
    : undefined;

  return createType(kind, result, meta);
}

// ═══════════════════════════════════════════════════════════════════════
// PAIR HANDLERS — how constraints of the same op compose
// ═══════════════════════════════════════════════════════════════════════

type PairHandler = {
  /**
   * Compute the meet of two constraints.
   * Returns:
   *   Constraint  — the merged result (tighter bound)
   *   null        — contradictory (compose → never)
   *   undefined   — no interaction (keep both / not the same target)
   */
  meet: (a: Constraint, b: Constraint) => Constraint | null | undefined;
  /** Other ops this handler can compose with (e.g., min can compose with range). */
  compatOps?: string[];
};

const pairHandlers: Record<string, PairHandler> = {

  literal: {
    meet(a, b) {
      if (b.op !== 'literal') return undefined;
      return Object.is(a.args[0], b.args[0]) ? a : null;
    },
  },

  min: {
    meet(a, b) {
      if (b.op === 'min') {
        return { op: 'min', args: [Math.max(a.args[0] as number, b.args[0] as number)] };
      }
      if (b.op === 'max') {
        if ((a.args[0] as number) > (b.args[0] as number)) return null;
        return undefined; // compatible, keep both
      }
      return undefined;
    },
    compatOps: ['max'],
  },

  max: {
    meet(a, b) {
      if (b.op === 'max') {
        return { op: 'max', args: [Math.min(a.args[0] as number, b.args[0] as number)] };
      }
      if (b.op === 'min') {
        if ((b.args[0] as number) > (a.args[0] as number)) return null;
        return undefined;
      }
      return undefined;
    },
    compatOps: ['min'],
  },

  range: {
    meet(a, b) {
      if (b.op !== 'range') return undefined;
      const lo = Math.max(a.args[0] as number, b.args[0] as number);
      const hi = Math.min(a.args[1] as number, b.args[1] as number);
      if (lo > hi) return null;
      return { op: 'range', args: [lo, hi] };
    },
  },

  length: {
    meet(a, b) {
      if (b.op !== 'length') return undefined;
      const minA = a.args[0] as number | undefined;
      const maxA = a.args[1] as number | undefined;
      const minB = b.args[0] as number | undefined;
      const maxB = b.args[1] as number | undefined;
      const lo = (minA !== undefined && minB !== undefined) ? Math.max(minA, minB) :
                 minA ?? minB;
      const hi = (maxA !== undefined && maxB !== undefined) ? Math.min(maxA, maxB) :
                 maxA ?? maxB;
      if (lo !== undefined && hi !== undefined && lo > hi) return null;
      return { op: 'length', args: [lo, hi] };
    },
  },

  pattern: {
    meet(a, b) {
      if (b.op !== 'pattern') return undefined;
      if (a.args[0] === b.args[0]) return a;
      return undefined; // different patterns — keep both (both must match)
    },
  },

  property: {
    meet(a, b) {
      if (b.op !== 'property') return undefined;
      const [keyA, typeA, optA] = a.args as [string, Type, boolean];
      const [keyB, typeB, optB] = b.args as [string, Type, boolean];
      if (keyA !== keyB) return undefined;

      const merged = compose(typeA, typeB);
      if (isNever(merged)) return null;

      const optional = optA && optB;
      return { op: 'property', args: [keyA, merged, optional] };
    },
  },

  element: {
    meet(a, b) {
      if (b.op !== 'element') return undefined;
      const merged = compose(a.args[0] as Type, b.args[0] as Type);
      if (isNever(merged)) return null;
      return { op: 'element', args: [merged] };
    },
  },

  arrayLength: {
    meet(a, b) {
      if (b.op !== 'arrayLength') return undefined;
      const minA = a.args[0] as number | undefined;
      const maxA = a.args[1] as number | undefined;
      const minB = b.args[0] as number | undefined;
      const maxB = b.args[1] as number | undefined;
      const lo = (minA !== undefined && minB !== undefined) ? Math.max(minA, minB) :
                 minA ?? minB;
      const hi = (maxA !== undefined && maxB !== undefined) ? Math.min(maxA, maxB) :
                 maxA ?? maxB;
      if (lo !== undefined && hi !== undefined && lo > hi) return null;
      return { op: 'arrayLength', args: [lo, hi] };
    },
  },

  param: {
    meet(a, b) {
      if (b.op !== 'param') return undefined;
      const merged = compose(a.args[0] as Type, b.args[0] as Type);
      if (isNever(merged)) return null;
      return { op: 'param', args: [merged] };
    },
  },

  returns: {
    meet(a, b) {
      if (b.op !== 'returns') return undefined;
      const merged = compose(a.args[0] as Type, b.args[0] as Type);
      if (isNever(merged)) return null;
      return { op: 'returns', args: [merged] };
    },
  },

  branch: {
    meet() { return undefined; },
  },

  segment: {
    meet(a, b) {
      if (b.op !== 'segment') return undefined;
      const [posA, typeA, budgetA, mutationsA, spreadA] = a.args as [string, Type, number?, string[]?, boolean?];
      const [posB, typeB, budgetB, mutationsB, spreadB] = b.args as [string, Type, number?, string[]?, boolean?];
      // Different positions → independent, keep both
      if (posA !== posB) return undefined;
      // Same position → compose inner types (tighten)
      const merged = compose(typeA, typeB);
      if (isNever(merged)) return null; // contradictory
      // Budget: take the tighter (smaller)
      const budget = (budgetA !== undefined && budgetB !== undefined)
        ? Math.min(budgetA, budgetB)
        : budgetA ?? budgetB;
      // Mutations: intersection (only mutations allowed by both)
      const mutations = (mutationsA && mutationsB)
        ? mutationsA.filter(m => mutationsB!.includes(m))
        : mutationsA ?? mutationsB;
      // Spread: both must agree (or take the one that's defined)
      const spread = spreadA ?? spreadB;
      return { op: 'segment', args: [posA, merged, budget, mutations?.length ? mutations : undefined, spread] };
    },
  },

  // ── Temporal + identity + equation pair handlers ──────────────

  temporal: {
    meet(a, b) {
      if (b.op !== 'temporal') return undefined;
      const [aDir, aLhs, aBound] = a.args as [string, string, unknown];
      const [bDir, bLhs, bBound] = b.args as [string, string, unknown];
      // Different LHS → independent, keep both
      if (aLhs !== bLhs) return undefined;
      // Same direction: tighten
      if (aDir === bDir && aDir === 'gt') {
        // gt(X, A) ∧ gt(X, B) → gt(X, max(A, B)) — latest availability
        if (typeof aBound === 'number' && typeof bBound === 'number') {
          return { op: 'temporal', args: ['gt', aLhs, Math.max(aBound, bBound)] };
        }
        return undefined; // can't statically merge complex Expr
      }
      if (aDir === bDir && aDir === 'lt') {
        // lt(X, A) ∧ lt(X, B) → lt(X, min(A, B)) — earliest expiry
        if (typeof aBound === 'number' && typeof bBound === 'number') {
          return { op: 'temporal', args: ['lt', aLhs, Math.min(aBound, bBound)] };
        }
        return undefined;
      }
      // Opposite directions: check for contradiction (>= not >)
      if (aDir === 'gt' && bDir === 'lt') {
        if (typeof aBound === 'number' && typeof bBound === 'number' && aBound >= bBound) {
          return null; // gt(X, 5) ∧ lt(X, 5) → never valid
        }
      }
      if (aDir === 'lt' && bDir === 'gt') {
        if (typeof aBound === 'number' && typeof bBound === 'number' && bBound >= aBound) {
          return null;
        }
      }
      return undefined; // keep both
    },
  },

  identity: {
    meet(a, b) {
      if (b.op !== 'identity') return undefined;
      const [aOut, aIn] = a.args as [string, string];
      const [bOut, bIn] = b.args as [string, string];
      // Same output path mapped to different input paths → contradiction
      if (aOut === bOut && aIn !== bIn) return null;
      // Same mapping → keep one
      if (aOut === bOut && aIn === bIn) return a;
      // Different output paths → independent, keep both
      return undefined;
    },
  },

  equation: {
    meet(a, b) {
      if (b.op !== 'equation') return undefined;
      const [aLhs, aRhs] = a.args as [string, string];
      const [bLhs, bRhs] = b.args as [string, string];
      // Same equation → keep one
      if (aLhs === bLhs && aRhs === bRhs) {
        // Merge temporal bounds: tighter of both
        const aOpts = a.args[2] as { from?: any; until?: any; reliability?: any } | undefined;
        const bOpts = b.args[2] as { from?: any; until?: any; reliability?: any } | undefined;
        if (!aOpts && !bOpts) return a;
        const from = (aOpts?.from !== undefined && bOpts?.from !== undefined)
          ? (typeof aOpts.from === 'number' && typeof bOpts.from === 'number'
            ? Math.max(aOpts.from, bOpts.from) : aOpts.from)
          : aOpts?.from ?? bOpts?.from;
        const until = (aOpts?.until !== undefined && bOpts?.until !== undefined)
          ? (typeof aOpts.until === 'number' && typeof bOpts.until === 'number'
            ? Math.min(aOpts.until, bOpts.until) : aOpts.until)
          : aOpts?.until ?? bOpts?.until;
        const reliability = aOpts?.reliability ?? bOpts?.reliability;
        return { op: 'equation', args: [aLhs, aRhs, { from, until, reliability }] };
      }
      // Contradictory equations (same LHS, different RHS) → contradiction
      if (aLhs === bLhs && aRhs !== bRhs) return null;
      // Different equations → independent, keep both
      return undefined;
    },
  },

  preserves: {
    meet(a, b) {
      if (b.op !== 'preserves') return undefined;
      const [aIn, aOut] = a.args as [string, string];
      const [bIn, bOut] = b.args as [string, string];
      if (aIn === bIn && aOut === bOut) return a; // same → keep one
      if (aIn === '*' || bIn === '*') return aIn === '*' ? a : b; // wildcard subsumes
      return undefined; // different paths → keep both
    },
  },
};

/**
 * Post-merge contradiction check.
 *
 * Some contradictions only emerge from the combination of constraints
 * that individually merged fine (e.g., min + max that crossed).
 */
function detectContradiction(kind: string, constraints: Constraint[]): string | null {
  if (kind === 'number') {
    const mins = constraints.filter(c => c.op === 'min');
    const maxs = constraints.filter(c => c.op === 'max');
    const lit = constraints.find(c => c.op === 'literal');
    for (const mn of mins) {
      for (const mx of maxs) {
        if ((mn.args[0] as number) > (mx.args[0] as number)) {
          return `min ${mn.args[0]} > max ${mx.args[0]}`;
        }
      }
    }
    // Literal vs bounds: a concrete value must satisfy all min/max constraints
    if (lit && typeof lit.args[0] === 'number') {
      const v = lit.args[0] as number;
      for (const mn of mins) {
        if (v < (mn.args[0] as number)) return `literal ${v} < min ${mn.args[0]}`;
      }
      for (const mx of maxs) {
        if (v > (mx.args[0] as number)) return `literal ${v} > max ${mx.args[0]}`;
      }
    }
  }
  if (kind === 'string') {
    const lit = constraints.find(c => c.op === 'literal');
    const lens = constraints.filter(c => c.op === 'length');
    if (lit && typeof lit.args[0] === 'string' && lens.length > 0) {
      const v = (lit.args[0] as string).length;
      for (const l of lens) {
        const [minLen, maxLen] = l.args as [number | undefined, number | undefined];
        if (minLen !== undefined && v < minLen) return `literal length ${v} < minLength ${minLen}`;
        if (maxLen !== undefined && v > maxLen) return `literal length ${v} > maxLength ${maxLen}`;
      }
    }
  }
  // ── Probabilistic deadline feasibility (opt-in) ──────────────
  // When ALL THREE are present on a fn type:
  //   1. temporal upper bound (lt on _rt) — the deadline
  //   2. distribution('time', ...) — completion time distribution
  //   3. responsePolicy with confidence — required P(completion ≤ deadline)
  // Evaluate CDF. If P < confidence → contradiction.
  // This is opt-in: absent any of the three, behavior is unchanged.
  if (kind === 'fn') {
    const timeDist = constraints.find(c => c.op === 'distribution' && c.args[0] === 'time');
    const policy = constraints.find(c => c.op === 'responsePolicy');
    const temporals = constraints.filter(c => c.op === 'temporal');

    if (timeDist && policy) {
      const [, family, params] = timeDist.args as [string, string, Record<string, number>];
      const [policyTimeout, policyConfidence] = policy.args as [number | undefined, number | undefined, string?];
      const confidence = policyConfidence ?? 0.95;

      // Find available time window from constraints.
      // Source 1: responsePolicy timeout (duration in ms)
      // Source 2: temporal('lt', '_rt', deadline) ∧ temporal('gt', '_rt', start) → window = deadline - start
      // Source 3: temporal('lt', '_rt', deadline) alone → use deadline as available time
      // No runtime clock — all values from constraints only.
      let availableTime: number | null = null;

      if (typeof policyTimeout === 'number' && policyTimeout > 0) {
        availableTime = policyTimeout;
      }

      // Check for concrete temporal bounds: extract window from lt/gt pair or lone lt
      const ltBound = temporals.find(t => t.args[0] === 'lt' && typeof t.args[2] === 'number');
      const gtBound = temporals.find(t => t.args[0] === 'gt' && typeof t.args[2] === 'number');
      if (ltBound && gtBound) {
        const window = (ltBound.args[2] as number) - (gtBound.args[2] as number);
        if (window > 0) {
          // Use the tighter of policy timeout and temporal window
          availableTime = availableTime !== null ? Math.min(availableTime, window) : window;
        }
      } else if (ltBound && !gtBound && availableTime === null) {
        // lone lt bound — treat the deadline value as available time
        // (this is a heuristic; callers should pair with gt for precision)
        availableTime = ltBound.args[2] as number;
      }

      if (availableTime !== null) {
        const prob = cdf(family, availableTime, params);
        if (prob < confidence) {
          return `deadline infeasible: P(completion ≤ ${availableTime}ms) = ${prob.toFixed(4)} < required ${confidence} [${family}(${JSON.stringify(params)})]`;
        }
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// ORDERED CHOICE — first-match dispatch for union types
// ═══════════════════════════════════════════════════════════════════════

/**
 * Select the first branch of a union type that composes with `candidate`
 * without producing never. This is ordered choice — branch declaration
 * order IS the priority order. Returns null if no branch matches.
 *
 * Unlike composeOr (which keeps ALL viable branches for lattice meet),
 * this returns exactly ONE branch for dispatch decisions.
 */
export function selectFirstBranch(
  union: Type, candidate: Type,
): { branch: Type; composed: Type; index: number } | null {
  if (union.kind !== 'or') {
    if (!branchAccepts(union, candidate)) return null;
    const c = compose(union, candidate);
    return isNever(c) ? null : { branch: union, composed: c, index: 0 };
  }
  const branches = constraintsOf(union, 'branch').map(c => c.args[0] as Type);
  for (let i = 0; i < branches.length; i++) {
    if (!branchAccepts(branches[i], candidate)) continue;
    const c = compose(branches[i], candidate);
    if (!isNever(c)) return { branch: branches[i], composed: c, index: i };
  }
  return null;
}

/**
 * Does a branch accept this candidate for dispatch?
 *
 * Every type is implicitly a function — x << y is application.
 * For dispatch, the candidate must cover the branch's input
 * requirements. The only difference is where those requirements
 * live: fn types declare input via param(), other types declare
 * it via their property structure.
 *
 * fn branch + non-fn candidate: extract param, check covers.
 * fn branch + fn candidate: type-level reasoning (deadline
 *   elimination, constraint narrowing) — compose suffices.
 * non-fn branch: covers directly (property coverage).
 */
function branchAccepts(branch: Type, candidate: Type): boolean {
  if (branch.kind === 'fn') {
    if (candidate.kind === 'fn') return true; // fn-fn: compose handles it
    const paramC = constraintOf(branch, 'param');
    if (paramC) return covers(paramC.args[0] as Type, candidate);
    return true;
  }
  // Every non-fn type is implicitly a function of its constraints.
  // The candidate must cover those constraints for dispatch.
  return covers(branch, candidate);
}

// ═══════════════════════════════════════════════════════════════════════
// COVERS — does one type guarantee another's constraints?
// ═══════════════════════════════════════════════════════════════════════

/**
 * Does `candidate` cover all constraints of `required`?
 *
 * Type-level analog of check(type, value). Where compose asks "can
 * these two types coexist?" (existential — ∃ value satisfying both),
 * covers asks "does having candidate mean you definitely satisfy
 * required?" (universal — ∀ values of candidate satisfy required).
 *
 * For objects: every non-optional property in `required` must appear
 * in `candidate` with a compatible type. compose alone can't test
 * this — compose({content:string}, {status:string}) produces
 * {content:string, status:string} (not never), because adding a
 * property constraint is never contradictory. But {status:string}
 * does NOT cover {content:string} — values with only status don't
 * have content.
 *
 * For non-objects (string, number, boolean, array): compose is
 * sufficient — constraints on the same kind either conflict or they
 * don't, and there's no "missing property" analog.
 */
export function covers(required: Type, candidate: Type): boolean {
  if (isAny(required)) return true;
  if (isNever(candidate)) return true; // vacuously — no values to violate
  if (isNever(required)) return false;
  if (isAny(candidate)) return isAny(required); // any only covers any

  // Union candidate: every branch must cover required
  if (candidate.kind === 'or') {
    const branches = constraintsOf(candidate, 'branch').map(c => c.args[0] as Type);
    return branches.every(b => covers(required, b));
  }

  // Union required: candidate must cover at least one branch
  if (required.kind === 'or') {
    const branches = constraintsOf(required, 'branch').map(c => c.args[0] as Type);
    return branches.some(b => covers(b, candidate));
  }

  // Kind must match
  if (required.kind !== candidate.kind) return false;

  // Object coverage: check required properties exist in candidate
  if (required.kind === 'object') {
    const reqProps = properties(required);
    const candProps = properties(candidate);
    for (const rp of reqProps) {
      if (rp.optional) continue;
      const match = candProps.find(cp => cp.key === rp.key);
      if (!match) return false;
      // Property types must be compatible (compose, not covers —
      // we're checking type compatibility of the property, not
      // that the candidate's property is a subtype)
      if (isNever(compose(rp.type, match.type))) return false;
    }
    return true;
  }

  // Non-object: compose is sufficient
  return !isNever(compose(required, candidate));
}

// ═══════════════════════════════════════════════════════════════════════
// CHECK — does a value satisfy a type? (replaces merge.ts)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check: does this value satisfy this type?
 * Returns detailed gaps on failure for suspension reporting.
 */
export function check(type: Type, value: unknown, path = ''): CheckResult {
  if (isNever(type)) {
    return { ok: false, gaps: [{ path, reason: type.meta?.reason as string ?? 'type is never', constraint: { op: 'never', args: [] } }] };
  }
  if (isAny(type)) return { ok: true };

  // Kind check
  const kindOk = checkKind(type.kind, value, path);
  if (!kindOk.ok) return kindOk;

  // Constraint checks — accumulate both gaps and follows
  const gaps: Gap[] = [];
  const follows: Follow[] = [];
  for (const c of type.constraints) {
    const h = checkHandlers[c.op];
    if (!h) continue;
    const r = h(c, value, path, type);
    if (!r.ok) {
      gaps.push(...(r as { ok: false; gaps: Gap[] }).gaps);
    } else if (r.follows) {
      follows.push(...r.follows);
    }
  }
  if (gaps.length > 0) return { ok: false, gaps };
  return follows.length > 0 ? { ok: true, follows } : { ok: true };
}

function checkKind(kind: string, value: unknown, path: string): CheckResult {
  const fail = (exp: string) => ({ ok: false as const, gaps: [{ path, reason: `expected ${exp}, got ${typeof value}`, constraint: { op: 'kind', args: [exp] } }] });
  switch (kind) {
    case 'string': return typeof value === 'string' ? { ok: true } : fail('string');
    case 'number': return typeof value === 'number' ? { ok: true } : fail('number');
    case 'boolean': return typeof value === 'boolean' ? { ok: true } : fail('boolean');
    case 'null': return value === null ? { ok: true } : fail('null');
    case 'object': return (value !== null && typeof value === 'object' && !Array.isArray(value)) ? { ok: true } : fail('object');
    case 'array': return Array.isArray(value) ? { ok: true } : fail('array');
    case 'fn': case 'or': return { ok: true };
    default: return { ok: true };
  }
}

type CheckHandler = (c: Constraint, value: unknown, path: string, type: Type) => CheckResult;

const checkHandlers: Record<string, CheckHandler> = {
  literal(c, value, path) {
    return Object.is(value, c.args[0]) ? { ok: true } : { ok: false, gaps: [{ path, reason: `expected ${JSON.stringify(c.args[0])}, got ${JSON.stringify(value)}`, constraint: c }] };
  },
  min(c, value, path) {
    return typeof value === 'number' && value < (c.args[0] as number) ? { ok: false, gaps: [{ path, reason: `${value} < min ${c.args[0]}`, constraint: c, needed: createType('number', [c]) }] } : { ok: true };
  },
  max(c, value, path) {
    return typeof value === 'number' && value > (c.args[0] as number) ? { ok: false, gaps: [{ path, reason: `${value} > max ${c.args[0]}`, constraint: c, needed: createType('number', [c]) }] } : { ok: true };
  },
  range(c, value, path) {
    if (typeof value !== 'number') return { ok: true };
    const [lo, hi] = c.args as [number, number];
    return (value < lo || value > hi) ? { ok: false, gaps: [{ path, reason: `${value} not in [${lo}, ${hi}]`, constraint: c }] } : { ok: true };
  },
  integer(c, value, path) {
    return typeof value === 'number' && !Number.isInteger(value) ? { ok: false, gaps: [{ path, reason: `${value} not integer`, constraint: c }] } : { ok: true };
  },
  length(c, value, path) {
    if (typeof value !== 'string') return { ok: true };
    const [mn, mx] = c.args as [number?, number?];
    if (mn !== undefined && value.length < mn) return { ok: false, gaps: [{ path, reason: `length ${value.length} < ${mn}`, constraint: c }] };
    if (mx !== undefined && value.length > mx) return { ok: false, gaps: [{ path, reason: `length ${value.length} > ${mx}`, constraint: c }] };
    return { ok: true };
  },
  pattern(c, value, path) {
    if (typeof value !== 'string') return { ok: true };
    return new RegExp(c.args[0] as string).test(value) ? { ok: true } : { ok: false, gaps: [{ path, reason: `no match /${c.args[0]}/`, constraint: c }] };
  },
  property(c, value, path, _type) {
    const [key, propType, optional] = c.args as [string, Type, boolean];
    const obj = value as Record<string, unknown>;
    const childPath = path ? `${path}.${key}` : key;
    if (!(key in obj)) return optional ? { ok: true } : { ok: false, gaps: [{ path: childPath, reason: `missing "${key}"`, constraint: c, needed: propType }] };
    const r = check(propType, obj[key], childPath);
    if (!r.ok) return r;
    // If the property type has a ref, this portion of the value follows the ref
    const refConstraint = constraintOf(propType, 'ref');
    const follows: Follow[] = r.follows ? [...r.follows] : [];
    if (refConstraint) {
      follows.push({ ref: refConstraint.args[0] as string, path: childPath, value: obj[key] });
    }
    return follows.length > 0 ? { ok: true, follows } : { ok: true };
  },
  element(c, value, path, type) {
    if (!Array.isArray(value)) return { ok: true };
    // If this array has segment constraints, skip the homogeneous element check —
    // per-position validation is handled by the segment handler instead.
    if (type.constraints.some(tc => tc.op === 'segment')) return { ok: true };
    const gaps: Gap[] = [];
    for (let i = 0; i < value.length; i++) { const r = check(c.args[0] as Type, value[i], `${path}[${i}]`); if (!r.ok) gaps.push(...(r as any).gaps); }
    return gaps.length === 0 ? { ok: true } : { ok: false, gaps };
  },
  arrayLength(c, value, path) {
    if (!Array.isArray(value)) return { ok: true };
    const [mn, mx] = c.args as [number?, number?];
    if (mn !== undefined && value.length < mn) return { ok: false, gaps: [{ path, reason: `array length ${value.length} < ${mn}`, constraint: c }] };
    if (mx !== undefined && value.length > mx) return { ok: false, gaps: [{ path, reason: `array length ${value.length} > ${mx}`, constraint: c }] };
    return { ok: true };
  },
  branch(_c, value, path, type) {
    const branches = constraintsOf(type, 'branch').map(c => c.args[0] as Type);
    if (branches.length === 0) return { ok: true };
    for (const b of branches) {
      const r = check(b, value, path);
      if (r.ok) {
        // Collect follows: from the matched branch AND any sub-checks that produced follows
        const follows: Follow[] = r.follows ? [...r.follows] : [];
        const refConstraint = constraintOf(b, 'ref');
        if (refConstraint) {
          follows.push({ ref: refConstraint.args[0] as string, path, value });
        }
        return follows.length > 0 ? { ok: true, follows } : { ok: true };
      }
    }
    return { ok: false, gaps: [{ path, reason: `matches none of ${branches.length} branches`, constraint: { op: 'or', args: branches }, needed: type }] };
  },
  default() { return { ok: true }; },
  segment(c, value, path) {
    // Segment constraint: args = [positionIndex, segmentType, budget?, mutations?, locked?]
    if (!Array.isArray(value)) return { ok: true };
    const [posStr, segType] = c.args as [string, Type | undefined];
    const pos = parseInt(posStr, 10);
    if (isNaN(pos) || pos >= value.length || !segType) return { ok: true };
    return check(segType, value[pos], `${path}[${pos}]`);
  },
  describe() { return { ok: true }; },
  impl() { return { ok: true }; },
  param() { return { ok: true }; },
  returns() { return { ok: true }; },
};

// ═══════════════════════════════════════════════════════════════════════
// BACKWARD INFERENCE — derive input requirements from output requirements
// ═══════════════════════════════════════════════════════════════════════

/**
 * Given a function type and a required output type, derive the
 * minimum input type that would make the function produce a value
 * satisfying the requirement.
 *
 * This is the backward inference channel. It uses `preserves`
 * declarations to trace output requirements back to input requirements.
 *
 * Without preserves: the function is a black box. Return its declared
 * param type as-is (no additional inference possible).
 *
 * With preserves('*'): output ⊇ input. Anything required in the output
 * that the function doesn't add as an effect must come from the input.
 *   effects = returns properties not in param (what the function adds)
 *   unmet = required properties not in effects (must come from input)
 *   result = compose(param, unmet)
 *
 * With preserves(inPath, outPath): specific subtype mapping.
 * If the required output needs something at outPath, the input must
 * provide it at inPath.
 */
export function backwardInfer(fnType: Type, requiredOutput: Type): Type {
  if (fnType.kind !== 'fn') return ANY;

  // Union output: backward infer through each branch in order (ordered choice).
  // Return the input requirements for the FIRST branch whose output composes
  // with the required output. This is the backward analog of selectFirstBranch.
  if (requiredOutput.kind === 'or') {
    const branches = constraintsOf(requiredOutput, 'branch').map(c => c.args[0] as Type);
    for (const branch of branches) {
      const result = backwardInfer(fnType, branch);
      if (!isAny(result) || branches.length === 1) return result;
    }
    // No specific branch matched — fall through to general inference
  }

  const paramC = constraintOf(fnType, 'param');
  const returnsC = constraintOf(fnType, 'returns');
  const preservesList = constraintsOf(fnType, 'preserves');
  const identityList = constraintsOf(fnType, 'identity');

  const paramType = paramC ? paramC.args[0] as Type : ANY;
  const returnsType = returnsC ? returnsC.args[0] as Type : ANY;

  // Identity constraints: value-level backward inference
  // If output.X must be V, and identity(X, Y) is declared, then input.Y must be V
  if (identityList.length > 0) {
    const result = backwardInferIdentity(paramType, identityList, requiredOutput);
    // Compose with preserves result if both exist
    if (preservesList.length > 0) {
      const preservesResult = preservesList.some(c => c.args[0] === '*')
        ? backwardInferWildcard(paramType, returnsType, requiredOutput)
        : backwardInferMapped(paramType, preservesList, requiredOutput);
      return compose(result, preservesResult);
    }
    return result;
  }

  // No preserves and no identity → black box → return declared param
  if (preservesList.length === 0) return paramType;

  // Check for wildcard preserves (T → T & Effects)
  const wildcard = preservesList.some(c => c.args[0] === '*');

  if (wildcard) {
    return backwardInferWildcard(paramType, returnsType, requiredOutput);
  }

  // Specific path mappings
  return backwardInferMapped(paramType, preservesList, requiredOutput);
}

/**
 * Backward inference for preserves('*') — all input passes through.
 *
 * Effects = properties in returns that aren't in param.
 * Anything required that isn't an effect must come from input.
 */
function backwardInferWildcard(
  paramType: Type,
  returnsType: Type,
  requiredOutput: Type,
): Type {
  // For non-object types, we can't do structural diff — fall back to param
  if (requiredOutput.kind !== 'object') return paramType;

  // Compute effects: properties the function adds beyond what's in param
  const paramProps = paramType.kind === 'object' ? properties(paramType) : [];
  const returnsProps = returnsType.kind === 'object' ? properties(returnsType) : [];
  const paramKeys = new Set(paramProps.map(p => p.key));

  const effectKeys = new Set<string>();
  for (const rp of returnsProps) {
    if (!paramKeys.has(rp.key)) effectKeys.add(rp.key);
  }

  // Find required properties not provided by effects → must come from input
  const requiredProps = properties(requiredOutput);
  const inputConstraints: Constraint[] = [];

  for (const rp of requiredProps) {
    if (effectKeys.has(rp.key)) continue; // function provides this
    inputConstraints.push(property(rp.key, rp.type, rp.optional));
  }

  if (inputConstraints.length === 0) return paramType;

  const additionalInput = createType('object', inputConstraints);
  return compose(paramType, additionalInput);
}

/**
 * Backward inference for specific path mappings.
 *
 * Each preserves(inPath, outPath) says: if the output needs something
 * at outPath, the input must provide it at inPath.
 */
function backwardInferMapped(
  paramType: Type,
  preservesList: readonly Constraint[],
  requiredOutput: Type,
): Type {
  if (requiredOutput.kind !== 'object') return paramType;

  const requiredProps = properties(requiredOutput);
  const inputConstraints: Constraint[] = [];

  // Build reverse map: outputPath → inputPath
  const reverseMap = new Map<string, string>();
  for (const p of preservesList) {
    const [inPath, outPath] = p.args as [string, string];
    reverseMap.set(outPath, inPath);
  }

  for (const rp of requiredProps) {
    const inputPath = reverseMap.get(rp.key);
    if (inputPath) {
      // This output property maps back to an input property
      inputConstraints.push(property(inputPath, rp.type, rp.optional));
    }
    // If no mapping, it's an effect — function provides it
  }

  if (inputConstraints.length === 0) return paramType;

  const additionalInput = createType('object', inputConstraints);
  return compose(paramType, additionalInput);
}

/**
 * Backward inference for identity constraints (VALUE-level).
 *
 * identity(outputPath, inputPath) means: the VALUE at outputPath in the
 * output equals the VALUE at inputPath in the input.
 *
 * If the required output has a constraint at outputPath (e.g., literal('abc')),
 * that same constraint applies to inputPath in the input.
 *
 * '.' means root — identity('.', '.') means the whole output equals the input.
 */
function backwardInferIdentity(
  paramType: Type,
  identityList: readonly Constraint[],
  requiredOutput: Type,
): Type {
  const inputConstraints: Constraint[] = [];

  for (const id of identityList) {
    const [outPath, inPath] = id.args as [string, string];

    // Determine what the required output says about outPath
    let requiredAtOut: Type | undefined;
    if (outPath === '.') {
      // Output root — the entire required output type applies
      requiredAtOut = requiredOutput;
    } else if (requiredOutput.kind === 'object') {
      const prop = properties(requiredOutput).find(p => p.key === outPath);
      if (prop) requiredAtOut = prop.type;
    }

    if (!requiredAtOut) continue;

    // Map requiredAtOut to the input at inPath
    if (inPath === '.') {
      // Maps to root input — compose required with param
      return compose(paramType, requiredAtOut);
    }

    // Maps to a specific input property — strip 'input.' prefix if present
    const cleanPath = inPath.startsWith('input.') ? inPath.slice(6) : inPath;
    inputConstraints.push(property(cleanPath, requiredAtOut, false));
  }

  if (inputConstraints.length === 0) return paramType;
  return compose(paramType, createType('object', inputConstraints));
}

// ═══════════════════════════════════════════════════════════════════════
// TYPE SPECIFICITY — how constrained a type is (structural, not temporal)
// ═══════════════════════════════════════════════════════════════════════

/**
 * How specific/constrained is this type? A structural measure, NOT probability.
 *
 * Use this to compare two types: "which is narrower?" For actual probability
 * of a path resolving, use Sequence.concreteness(path, atTime) which
 * accounts for current state, tools, and time.
 *
 *   1.0  — fully determined (literal)
 *   0.0  — impossible (never)
 *   0-1  — partial (constrained but not literal)
 */
export function typeSpecificity(type: Type): number {
  if (isNever(type)) return 0;
  if (isAny(type)) return 0.01; // unconstrained but satisfiable

  if (literalValue(type) !== undefined) return 1;

  if (type.kind === 'object') {
    const props = properties(type);
    if (props.length === 0) return 0.1;
    let product = 1;
    for (const p of props) {
      product *= typeSpecificity(p.type);
    }
    // Geometric mean: prevents large objects from collapsing to near-zero
    return Math.pow(product, 1 / props.length);
  }

  if (type.kind === 'array') {
    const elem = elementType(type);
    return elem ? typeSpecificity(elem) * 0.8 : 0.1;
  }

  const constraintCount = type.constraints.filter(
    c => !['default', 'describe', 'segment', 'impl'].includes(c.op)
  ).length;

  if (constraintCount === 0) return 0.1;
  return Math.min(0.9, 0.1 + constraintCount * 0.15);
}

/** @deprecated Use typeSpecificity for structural comparison, Sequence.concreteness for probability */
export const concreteness = typeSpecificity;

// ═══════════════════════════════════════════════════════════════════════
// EXPRESSION EVALUATION — compute dependent output properties
// ═══════════════════════════════════════════════════════════════════════

/** Bindings: path → concrete value. Used to evaluate expressions. */
export type Bindings = Map<string, number> | Record<string, number>;

/** Named functions available during expression evaluation. */
export type ExprFunctions = Record<string, (n: number) => number>;

/** Result of evaluating an expression — value with optional uncertainty. */
export type ExprResult = {
  value: number;
  lo?: number;   // lower bound (value - margin)
  hi?: number;   // upper bound (value + margin)
};

/**
 * Evaluate an expression against concrete bindings.
 *
 * Returns the computed value (and uncertainty bounds if ± is present).
 * If a referenced path is missing from bindings, returns undefined
 * (the expression can't be fully evaluated — it's a gap).
 *
 * @param expr — the expression tree
 * @param bindings — path → concrete number values
 * @param fns — named functions (e.g., { approxtokens: n => 0.34 * n })
 */
export function evaluateExpr(
  expr: Expr,
  bindings: Bindings,
  fns: ExprFunctions = {},
): ExprResult | undefined {
  const resolve = (path: string): number | undefined => {
    if (bindings instanceof Map) return bindings.get(path);
    return (bindings as Record<string, number>)[path];
  };

  const eval_ = (e: Expr): number | undefined => {
    // Literal number
    if (typeof e === 'number') return e;

    // Path reference
    if (typeof e === 'string') return resolve(e);

    // Addition
    if ('add' in e) {
      let sum = 0;
      for (const term of e.add) {
        const v = eval_(term);
        if (v === undefined) return undefined;
        sum += v;
      }
      return sum;
    }

    // Multiplication
    if ('mul' in e) {
      let product = 1;
      for (const factor of e.mul) {
        const v = eval_(factor);
        if (v === undefined) return undefined;
        product *= v;
      }
      return product;
    }

    // Named function
    if ('fn' in e) {
      const fn = fns[e.fn];
      if (!fn) return undefined;
      const argVal = eval_(e.arg);
      if (argVal === undefined) return undefined;
      return fn(argVal);
    }

    // Uncertainty band — evaluated at the top level
    if ('pm' in e) {
      return eval_(e.pm); // return center; bounds handled at top level
    }

    return undefined;
  };

  const value = eval_(expr);
  if (value === undefined) return undefined;

  // Check for uncertainty band at the top level
  if (typeof expr === 'object' && 'pm' in expr) {
    const marginExpr = expr.margin;
    const margin = eval_(marginExpr);
    if (margin !== undefined) {
      return { value, lo: value - margin, hi: value + margin };
    }
  }

  return { value };
}

/**
 * Compute concreteness of an expression: how many of its path refs
 * can be resolved?
 *
 * Returns [0, 1]:
 *   1.0 — all refs resolvable → expression fully evaluable
 *   0.0 — no refs resolvable
 *
 * @param expr — the expression tree
 * @param available — set of paths that have concrete values
 */
export function exprConcreteness(expr: Expr, available: Set<string>): number {
  const refs: string[] = [];
  const collectRefs = (e: Expr): void => {
    if (typeof e === 'number') return;
    if (typeof e === 'string') { refs.push(e); return; }
    if ('add' in e) { e.add.forEach(collectRefs); return; }
    if ('mul' in e) { e.mul.forEach(collectRefs); return; }
    if ('fn' in e) { collectRefs(e.arg); return; }
    if ('pm' in e) { collectRefs(e.pm); collectRefs(e.margin); return; }
  };

  collectRefs(expr);
  if (refs.length === 0) return 1; // pure constant
  const resolved = refs.filter(r => available.has(r)).length;
  return resolved / refs.length;
}

// ═══════════════════════════════════════════════════════════════════════
// DISTRIBUTIONS — CDF, survival, posterior predictive, conjugate update
// ═══════════════════════════════════════════════════════════════════════

export type DistParams = Record<string, number>;

/**
 * CDF: P(X ≤ t) for a distribution family.
 *
 * This is what makes distribution constraints actually computable.
 * Used by feasibility() to answer: P(tool completes by deadline).
 */
export function cdf(family: string, t: number, params: DistParams): number {
  // Poisson is a COUNT distribution: P(X ≤ ⌊t⌋) is already positive at
  // t = 0 (e^{-lambda}), so the time-origin guard below must not zero it.
  if (family === 'poisson') {
    if (t < 0) return 0;
    const lambda = params.lambda ?? 1;
    return regularizedGammaQ(Math.floor(t) + 1, lambda);
  }
  if (t <= 0) return 0;
  switch (family) {
    case 'exponential': {
      const rate = params.rate ?? 0.001;
      return 1 - Math.exp(-rate * t);
    }
    case 'weibull': {
      const shape = params.shape ?? 1;
      const scale = params.scale ?? 1000;
      return 1 - Math.exp(-Math.pow(t / scale, shape));
    }
    case 'lognormal': {
      const mu = params.mu ?? 0;
      const sigma = params.sigma ?? 1;
      const z = (Math.log(t) - mu) / (sigma * Math.SQRT2);
      return 0.5 * (1 + erf(z));
    }
    case 'fixed': {
      return t >= (params.value ?? 0) ? 1 : 0;
    }
    case 'linear': {
      // P(t) = slope·t + intercept, clamped to [0, 1].
      return clamp01((params.slope ?? 0) * t + (params.intercept ?? 0));
    }
    case 'loglinear': {
      // P(t) = a·ln(t) + b, clamped to [0, 1].
      return clamp01((params.a ?? 0) * Math.log(t) + (params.b ?? 0));
    }
    case 'gamma': {
      // Erlang/gamma completion: time until the `shape`-th arrival of a
      // Poisson process at `rate` — the canonical arrival-process CDF.
      const shape = params.shape ?? 1;
      const rate = params.rate ?? 0.001;
      return regularizedGammaP(shape, rate * t);
    }
    case 'piecewise': {
      // Knots {t0,p0, t1,p1, …}: linear interpolation between knots,
      // 0 before the first, pLast after the last. Two knots at the same
      // t express a jump.
      const knots = piecewiseKnots(params);
      if (t < knots[0].t) return 0;
      const last = knots[knots.length - 1];
      if (t >= last.t) return clamp01(last.p);
      let i = 1;
      while (knots[i].t <= t) i++;
      const a = knots[i - 1], b = knots[i];
      const dt = b.t - a.t;
      if (dt === 0) return clamp01(b.p);
      return clamp01(a.p + ((t - a.t) / dt) * (b.p - a.p));
    }
    default:
      // No silent default (this was `return 0.5`): an unknown family is a
      // declaration error, not a coin flip. Same honesty contract as the
      // v2 standalone evaluator.
      throw new Error(
        `cdf: unknown distribution family '${family}' (supported: ` +
        `exponential, weibull, lognormal, fixed, linear, loglinear, ` +
        `poisson, gamma, piecewise)`,
      );
  }
}

function clamp01(p: number): number {
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** Parse piecewise knots {t0,p0,t1,p1,…} — sorted by t, p monotone
 *  non-decreasing (it is a CDF). Throws on empty or non-monotone. */
function piecewiseKnots(params: DistParams): Array<{ t: number; p: number }> {
  const knots: Array<{ t: number; p: number }> = [];
  for (let i = 0; ; i++) {
    const t = params[`t${i}`], p = params[`p${i}`];
    if (t === undefined || p === undefined) break;
    knots.push({ t, p });
  }
  if (knots.length === 0) {
    throw new Error(`cdf: piecewise family requires knot params t0,p0,t1,p1,…`);
  }
  knots.sort((a, b) => a.t - b.t);
  for (let i = 1; i < knots.length; i++) {
    if (knots[i].p < knots[i - 1].p) {
      throw new Error(
        `cdf: piecewise knots must be monotone non-decreasing in p ` +
        `(a CDF never falls): p at t=${knots[i].t} is ${knots[i].p} < ${knots[i - 1].p}`,
      );
    }
  }
  return knots;
}

/** Survival: P(X > t) = 1 - CDF(t). */
export function survival(family: string, t: number, params: DistParams): number {
  return 1 - cdf(family, t, params);
}

export type CdfInverseResult = {
  /** First t at which P(X ≤ t) reaches the threshold. */
  t: number;
  /** True when computed numerically or the threshold falls on a
   *  discontinuity — the deltat R5 honesty flag. */
  approximate: boolean;
};

/**
 * Invert a CDF: given a probability threshold, return the FIRST time at
 * which that threshold is reached (deltat/calculations.md R4).
 *
 * "When will this be 90% likely?" — the working-backwards read. Closed
 * form where one exists; monotone bisection (flagged approximate)
 * otherwise (R5). Throws when the threshold is unreachable — a CDF that
 * tops out below p has no first-reach time, and guessing one would be
 * the silent-0.5 bug in a different costume.
 */
export function cdfInverse(family: string, p: number, params: DistParams): CdfInverseResult {
  if (!(p > 0 && p <= 1)) {
    throw new Error(`cdfInverse: threshold must be in (0, 1], got ${p}`);
  }
  const asymptotic = (): never => {
    throw new Error(
      `cdfInverse: ${family} reaches 1 only asymptotically — p = 1 has no finite first-reach time`,
    );
  };
  switch (family) {
    case 'exponential': {
      if (p === 1) asymptotic();
      const rate = params.rate ?? 0.001;
      return { t: -Math.log(1 - p) / rate, approximate: false };
    }
    case 'weibull': {
      if (p === 1) asymptotic();
      const shape = params.shape ?? 1;
      const scale = params.scale ?? 1000;
      return { t: scale * Math.pow(-Math.log(1 - p), 1 / shape), approximate: false };
    }
    case 'lognormal': {
      if (p === 1) asymptotic();
      return { t: bisectCdf(family, p, params), approximate: true };
    }
    case 'fixed':
      // Degenerate: the whole mass arrives at `value`.
      return { t: params.value ?? 0, approximate: false };
    case 'linear': {
      const slope = params.slope ?? 0;
      const intercept = params.intercept ?? 0;
      if (intercept >= p) return { t: 0, approximate: false };
      if (slope <= 0) {
        throw new Error(`cdfInverse: linear CDF with slope ${slope} never reaches ${p}`);
      }
      return { t: (p - intercept) / slope, approximate: false };
    }
    case 'loglinear': {
      const a = params.a ?? 0;
      const b = params.b ?? 0;
      if (a <= 0) {
        throw new Error(`cdfInverse: loglinear inversion requires a > 0 (got a=${a})`);
      }
      return { t: Math.exp((p - b) / a), approximate: false };
    }
    case 'poisson': {
      if (p === 1) asymptotic();
      const lambda = params.lambda ?? 1;
      // Step function: first-reach times are exactly the integers.
      for (let k = 0; k <= 1_000_000; k++) {
        if (regularizedGammaQ(k + 1, lambda) >= p) return { t: k, approximate: false };
      }
      throw new Error(`cdfInverse: poisson(lambda=${lambda}) did not reach ${p} within 1e6 events`);
    }
    case 'gamma': {
      if (p === 1) asymptotic();
      return { t: bisectCdf(family, p, params), approximate: true };
    }
    case 'piecewise': {
      const knots = piecewiseKnots(params);
      const last = knots[knots.length - 1];
      if (clamp01(last.p) < p) {
        throw new Error(`cdfInverse: piecewise CDF tops out at ${last.p} < threshold ${p}`);
      }
      if (clamp01(knots[0].p) >= p) return { t: knots[0].t, approximate: false };
      for (let i = 1; i < knots.length; i++) {
        const a = knots[i - 1], b = knots[i];
        if (clamp01(b.p) < p) continue;
        if (b.t === a.t) {
          // Threshold falls inside a jump: F skips over p, so there is no
          // t with F(t) = p — the jump instant is first-reach, flagged.
          return { t: b.t, approximate: true };
        }
        const t = a.t + ((p - clamp01(a.p)) / (clamp01(b.p) - clamp01(a.p))) * (b.t - a.t);
        return { t, approximate: false };
      }
      // Monotone knots + the top-out guard above make this unreachable.
      throw new Error(`cdfInverse: piecewise inversion failed for p=${p}`);
    }
    default:
      throw new Error(
        `cdfInverse: unknown distribution family '${family}' (supported: ` +
        `exponential, weibull, lognormal, fixed, linear, loglinear, ` +
        `poisson, gamma, piecewise)`,
      );
  }
}

/** Monotone bisection inverse for families without a closed form:
 *  double the bracket until it clears p, then bisect. */
function bisectCdf(family: string, p: number, params: DistParams): number {
  let hi = 1;
  for (let i = 0; i < 1024 && cdf(family, hi, params) < p; i++) hi *= 2;
  if (cdf(family, hi, params) < p) {
    throw new Error(`cdfInverse: ${family} CDF did not reach ${p} at any finite t`);
  }
  let lo = 0;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(family, mid, params) >= p) hi = mid; else lo = mid;
  }
  return hi;
}

/** Posterior predictive for conjugate priors. */
export function posteriorPredictive(family: string, params: DistParams): number {
  switch (family) {
    case 'beta':
      return (params.alpha ?? 1) / ((params.alpha ?? 1) + (params.beta ?? 1));
    case 'gamma':
      return (params.shape ?? 1) / (params.rate ?? 1);
    default:
      // No silent default (this was `return 0.5`): dirichlet needs a
      // category argument this signature doesn't carry; anything else is
      // a declaration error.
      throw new Error(
        `posteriorPredictive: unsupported conjugate family '${family}' (supported: beta, gamma)`,
      );
  }
}

/** Conjugate update: return new hyperparameters after observation. */
export function conjugateUpdate(
  family: string, params: DistParams, observation: 'success' | 'failure' | number,
): DistParams {
  switch (family) {
    case 'beta':
      if (observation === 'success') return { ...params, alpha: (params.alpha ?? 1) + 1 };
      if (observation === 'failure') return { ...params, beta: (params.beta ?? 1) + 1 };
      return params;
    case 'gamma':
      if (typeof observation === 'number') {
        return { shape: (params.shape ?? 1) + 1, rate: (params.rate ?? 1) + observation };
      }
      return params;
    default:
      return params;
  }
}

/** Log-gamma (Lanczos approximation, g=7). */
function lgamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection: Γ(x)Γ(1−x) = π / sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized lower incomplete gamma P(s, x) — series for x < s+1,
 *  continued fraction (Lentz) otherwise. Numerical Recipes shape. */
function regularizedGammaP(s: number, x: number): number {
  if (x <= 0) return 0;
  if (x < s + 1) {
    // Series representation
    let sum = 1 / s, term = sum, n = s;
    for (let i = 0; i < 500; i++) {
      n += 1;
      term *= x / n;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - lgamma(s));
  }
  // Continued fraction for Q(s, x); P = 1 − Q
  const tiny = 1e-300;
  let b = x + 1 - s, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  const q = Math.exp(-x + s * Math.log(x) - lgamma(s)) * h;
  return 1 - q;
}

/** Regularized upper incomplete gamma Q(s, x) = 1 − P(s, x).
 *  Q(k+1, λ) is exactly the Poisson CDF P(X ≤ k) at rate λ. */
function regularizedGammaQ(s: number, x: number): number {
  return 1 - regularizedGammaP(s, x);
}

/** Error function approximation (Abramowitz & Stegun). */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

// ═══════════════════════════════════════════════════════════════════════
// PLAN-LEVEL FEASIBILITY — joint probability under dependency model
// ═══════════════════════════════════════════════════════════════════════
//
// Guard conditions:
// 1. Never infer plan-level feasibility from per-step P99.
// 2. Plan is feasible only if P(total_latency ≤ deadline) ≥ required_confidence.
// 3. Dependency model is REQUIRED. Missing → fail closed to worst_case_bound.
// 4. Weakly identified model → status = "uncertain" with conservative bound.
// 5. Correlation assumptions explicit and auditable in trace.
// 6. Every decision emits a trace.
// 7. Below threshold → infeasible (hard reject).
// 8. No silent point estimates.

export type DependencyModel = 'independent' | 'shared_factor' | 'copula' | 'worst_case_bound';

export type StepDistribution = {
  family: string;
  params: DistParams;
};

export type PlanFeasibilityTrace = {
  deadline: number;
  required_confidence: number;
  computed_probability: number;
  dependency_model: DependencyModel;
  status: 'feasible' | 'infeasible' | 'uncertain';
  reason: string;
  steps: { family: string; params: DistParams; per_step_cdf: number }[];
  /** Naive per-step product (shown for comparison — never used for decision). */
  naive_product: number;
  /** Conservative bound regardless of model (Bonferroni/comonotonic). */
  conservative_bound: number;
};

/**
 * Plan-level feasibility: P(total_latency ≤ deadline) ≥ required_confidence?
 *
 * NEVER multiplies per-step probabilities. Computes the joint distribution
 * under the declared dependency model.
 *
 * @param steps — per-step time distributions
 * @param deadline — total time budget (ms)
 * @param requiredConfidence — minimum P(completion) required
 * @param dependencyModel — correlation structure (required; null → worst_case_bound)
 */
export function planFeasibility(
  steps: StepDistribution[],
  deadline: number,
  requiredConfidence: number,
  dependencyModel?: DependencyModel | null,
): PlanFeasibilityTrace {
  const n = steps.length;
  if (n === 0) {
    return {
      deadline, required_confidence: requiredConfidence, computed_probability: 1,
      dependency_model: dependencyModel ?? 'worst_case_bound', status: 'feasible',
      reason: 'empty plan', steps: [], naive_product: 1, conservative_bound: 1,
    };
  }

  // Per-step CDFs at the full deadline (for comparison, NEVER used for plan decision)
  const stepCdfs = steps.map(s => cdf(s.family, deadline, s.params));
  const naiveProduct = stepCdfs.reduce((a, b) => a * b, 1);

  // Resolve dependency model: missing → fail closed to worst_case_bound
  const model: DependencyModel = dependencyModel ?? 'worst_case_bound';

  // Conservative bound (always computed, used as floor):
  // Comonotonic assumption (perfectly correlated): each step gets deadline/n time.
  // P(sum ≤ D) ≤ min_i(CDF_i(D/n)) — extremely conservative but safe.
  const perStepBudget = deadline / n;
  const conservativeBound = Math.min(...steps.map(s => cdf(s.family, perStepBudget, s.params)));

  let probability: number;
  let status: 'feasible' | 'infeasible' | 'uncertain';
  let reason: string;

  switch (model) {
    case 'independent': {
      // Fenton-Wilkinson approximation: sum of independent lognormals ≈ lognormal.
      // For mixed families, compute moments and approximate as lognormal.
      const moments = steps.map(s => distMoments(s.family, s.params));
      const totalMean = moments.reduce((a, m) => a + m.mean, 0);
      const totalVar = moments.reduce((a, m) => a + m.variance, 0);

      if (totalMean <= 0 || totalVar < 0) {
        probability = conservativeBound;
        reason = 'moment computation failed, fell back to conservative bound';
        status = probability >= requiredConfidence ? 'feasible' : 'infeasible';
        break;
      }

      // Fenton-Wilkinson: approximate sum as lognormal
      const sigmaS2 = Math.log(1 + totalVar / (totalMean * totalMean));
      const muS = Math.log(totalMean) - sigmaS2 / 2;
      probability = cdf('lognormal', deadline, { mu: muS, sigma: Math.sqrt(sigmaS2) });
      reason = `independent: Fenton-Wilkinson approx lognormal(mu=${muS.toFixed(3)}, sigma=${Math.sqrt(sigmaS2).toFixed(3)})`;
      status = probability >= requiredConfidence ? 'feasible' : 'infeasible';
      break;
    }

    case 'worst_case_bound': {
      // Comonotonic: perfectly correlated steps.
      // Each step gets budget = deadline / n. Joint CDF = min of per-step CDFs at that budget.
      probability = conservativeBound;
      reason = `worst_case_bound: comonotonic, per-step budget=${perStepBudget.toFixed(0)}ms`;
      status = probability >= requiredConfidence ? 'feasible' : 'infeasible';
      break;
    }

    case 'shared_factor':
    case 'copula': {
      // These require explicit parameterization that isn't provided here.
      // Fail to uncertain with conservative bound.
      probability = conservativeBound;
      reason = `${model}: parameters not provided, fell back to conservative bound`;
      status = 'uncertain';
      break;
    }
  }

  return {
    deadline,
    required_confidence: requiredConfidence,
    computed_probability: probability,
    dependency_model: model,
    status,
    reason,
    steps: steps.map((s, i) => ({
      family: s.family,
      params: s.params,
      per_step_cdf: stepCdfs[i],
    })),
    naive_product: naiveProduct,
    conservative_bound: conservativeBound,
  };
}

/** Compute mean and variance for a distribution family. */
function distMoments(family: string, params: DistParams): { mean: number; variance: number } {
  switch (family) {
    case 'lognormal': {
      const mu = params.mu ?? 0;
      const sigma = params.sigma ?? 1;
      const mean = Math.exp(mu + sigma * sigma / 2);
      const variance = (Math.exp(sigma * sigma) - 1) * Math.exp(2 * mu + sigma * sigma);
      return { mean, variance };
    }
    case 'exponential': {
      const rate = params.rate ?? 0.001;
      return { mean: 1 / rate, variance: 1 / (rate * rate) };
    }
    case 'weibull': {
      const shape = params.shape ?? 1;
      const scale = params.scale ?? 1000;
      // Gamma function approximation for Weibull moments
      const g1 = gammaApprox(1 + 1 / shape);
      const g2 = gammaApprox(1 + 2 / shape);
      return { mean: scale * g1, variance: scale * scale * (g2 - g1 * g1) };
    }
    case 'fixed': {
      const v = params.value ?? 0;
      return { mean: v, variance: 0 };
    }
    default:
      return { mean: 1000, variance: 1000000 }; // fallback
  }
}

/** Stirling approximation of Gamma(x) for x > 0. */
function gammaApprox(x: number): number {
  if (x <= 0) return 1;
  // For small x, use Γ(x) = Γ(x+1)/x recursion until x > 1
  if (x < 1) return gammaApprox(x + 1) / x;
  // Stirling: Γ(x) ≈ √(2π/x) * (x/e)^x * (1 + 1/(12x))
  return Math.sqrt(2 * Math.PI / x) * Math.pow(x / Math.E, x) * (1 + 1 / (12 * x));
}
