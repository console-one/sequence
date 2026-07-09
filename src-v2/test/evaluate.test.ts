/**
 * evaluate.test.ts — the standalone constraint evaluator.
 *
 * evaluateConstraint(constraint, state, bindings) evaluates the laws
 * vocabulary ({op, args}) against a PLAIN object + binding map, with no
 * Sequence instance. Relations ride the shared `check` machinery.
 *
 * The fixture shapes mirror the first real consumer — topic-dao's G3
 * write conditions over folded topic state — including the exact forms
 * its corpus exercises: eq over `metadata.phase`, gte/lt over usage
 * accumulator windows (`metadata.usage.claude||calls.<window>`),
 * exists over `title`, and_clause with `$author`.
 */

import { evaluateConstraint } from '../evaluate';
import type { Constraint } from '../../src/type';

const WINDOW = 1_700_000_000_000;

/** A folded-topic-state shape (what topic-dao's G3 admission sees). */
function topicState() {
  return {
    title: 'conditional topic',
    metadata: {
      phase: 'ready',
      usage: {
        'claude||calls': { [String(WINDOW)]: 3 },
        'claude||tokens': { [String(WINDOW)]: 1200 },
      },
      flags: { urgent: true, archived: false },
      nullable: null,
      tags: ['a', 'b'],
    },
  };
}

const c = (op: string, ...args: unknown[]): Constraint => ({ op, args });

describe('evaluateConstraint — comparisons over plain state', () => {
  test('eq: path vs literal (the metadata.phase form)', () => {
    expect(evaluateConstraint(c('eq', 'metadata.phase', 'ready'), topicState())).toBe(true);
    expect(evaluateConstraint(c('eq', 'metadata.phase', 'draft'), topicState())).toBe(false);
  });

  test('eq: missing path is unmet, never met — even against null/false', () => {
    expect(evaluateConstraint(c('eq', 'metadata.missing', 'x'), topicState())).toBe(false);
    expect(evaluateConstraint(c('eq', 'no.such.path', null), topicState())).toBe(false);
    expect(evaluateConstraint(c('eq', 'no.such.path', false), topicState())).toBe(false);
  });

  test('eq: equality is Object.is — no cross-type coercion', () => {
    const state = { n: 5, s: '5', b: true, z: null };
    expect(evaluateConstraint(c('eq', 'n', 5), state)).toBe(true);
    expect(evaluateConstraint(c('eq', 'n', '5'), state)).toBe(false);
    expect(evaluateConstraint(c('eq', 'b', true), state)).toBe(true);
    expect(evaluateConstraint(c('eq', 'z', null), state)).toBe(true);
  });

  test('eq: RHS string resolves as a path when one exists, else literal', () => {
    const state = { a: 'same', b: 'same', phase: 'ready' };
    expect(evaluateConstraint(c('eq', 'a', 'b'), state)).toBe(true); // b is a path
    expect(evaluateConstraint(c('eq', 'phase', 'ready'), state)).toBe(true); // 'ready' is literal
  });

  test('neq is the exact complement of eq', () => {
    expect(evaluateConstraint(c('neq', 'metadata.phase', 'draft'), topicState())).toBe(true);
    expect(evaluateConstraint(c('neq', 'metadata.phase', 'ready'), topicState())).toBe(false);
    // missing path: eq is false, so neq is true
    expect(evaluateConstraint(c('neq', 'missing', 'x'), topicState())).toBe(true);
  });

  test('gte over a usage accumulator window (the G3 corpus form)', () => {
    const path = `metadata.usage.claude||calls.${WINDOW}`;
    expect(evaluateConstraint(c('gte', path, 3), topicState())).toBe(true);
    expect(evaluateConstraint(c('gte', path, 4), topicState())).toBe(false);
  });

  test('lt over a usage accumulator window (the while form)', () => {
    const path = `metadata.usage.claude||calls.${WINDOW}`;
    expect(evaluateConstraint(c('lt', path, 100), topicState())).toBe(true);
    expect(evaluateConstraint(c('lt', path, 3), topicState())).toBe(false);
  });

  test('ordering: boundary cases — gte/lte inclusive, gt/lt strict', () => {
    const state = { n: 10 };
    expect(evaluateConstraint(c('gte', 'n', 10), state)).toBe(true);
    expect(evaluateConstraint(c('lte', 'n', 10), state)).toBe(true);
    expect(evaluateConstraint(c('gt', 'n', 10), state)).toBe(false);
    expect(evaluateConstraint(c('lt', 'n', 10), state)).toBe(false);
    expect(evaluateConstraint(c('gt', 'n', 9), state)).toBe(true);
    expect(evaluateConstraint(c('lt', 'n', 11), state)).toBe(true);
  });

  test('ordering: non-numbers never satisfy — strings do not compare', () => {
    const state = { s: 'b', n: 5 };
    expect(evaluateConstraint(c('gte', 's', 5), state)).toBe(false);
    expect(evaluateConstraint(c('gt', 's', 5), state)).toBe(false);
    expect(evaluateConstraint(c('lt', 's', 5), state)).toBe(false);
    expect(evaluateConstraint(c('gte', 'missing', 0), state)).toBe(false);
    // RHS resolving to a non-number is also unmet
    expect(evaluateConstraint(c('gte', 'n', 's'), state)).toBe(false);
  });
});

describe('evaluateConstraint — exists / notExists', () => {
  test('leaves, objects-with-leaves, null, arrays', () => {
    expect(evaluateConstraint(c('exists', 'title'), topicState())).toBe(true);
    expect(evaluateConstraint(c('exists', 'metadata'), topicState())).toBe(true);
    expect(evaluateConstraint(c('exists', 'metadata.nullable'), topicState())).toBe(true); // null is a value
    expect(evaluateConstraint(c('exists', 'metadata.tags'), topicState())).toBe(true); // arrays are leaves
    expect(evaluateConstraint(c('exists', 'metadata.flags.archived'), topicState())).toBe(true); // false is a value
    expect(evaluateConstraint(c('exists', 'nope'), topicState())).toBe(false);
    expect(evaluateConstraint(c('notExists', 'nope'), topicState())).toBe(true);
    expect(evaluateConstraint(c('notExists', 'title'), topicState())).toBe(false);
  });

  test('leafless objects and undefined-valued keys are not addressable', () => {
    const state = { empty: {}, nested: { hollow: {} }, ghost: undefined, real: 1 };
    expect(evaluateConstraint(c('exists', 'empty'), state)).toBe(false);
    expect(evaluateConstraint(c('exists', 'nested'), state)).toBe(false);
    expect(evaluateConstraint(c('exists', 'nested.hollow'), state)).toBe(false);
    expect(evaluateConstraint(c('exists', 'ghost'), state)).toBe(false);
    expect(evaluateConstraint(c('exists', 'real'), state)).toBe(true);
  });

  test('paths through non-objects read as absent', () => {
    const state = { leaf: 5, arr: [1, 2] };
    expect(evaluateConstraint(c('exists', 'leaf.deeper'), state)).toBe(false);
    expect(evaluateConstraint(c('exists', 'arr.0'), state)).toBe(false); // arrays are leaves, not interior nodes
  });
});

describe('evaluateConstraint — count_lt / count_gte', () => {
  test('counts addressable child keys at a path', () => {
    // metadata.usage has two dimension keys
    expect(evaluateConstraint(c('count_gte', 'metadata.usage', 2), topicState())).toBe(true);
    expect(evaluateConstraint(c('count_gte', 'metadata.usage', 3), topicState())).toBe(false);
    expect(evaluateConstraint(c('count_lt', 'metadata.usage', 3), topicState())).toBe(true);
    expect(evaluateConstraint(c('count_lt', 'metadata.usage', 2), topicState())).toBe(false);
  });

  test('non-object values and missing paths count zero', () => {
    const state = { leaf: 5, arr: [1, 2, 3], empty: {} };
    expect(evaluateConstraint(c('count_gte', 'leaf', 1), state)).toBe(false);
    expect(evaluateConstraint(c('count_gte', 'arr', 1), state)).toBe(false);
    expect(evaluateConstraint(c('count_gte', 'empty', 1), state)).toBe(false);
    expect(evaluateConstraint(c('count_gte', 'missing', 1), state)).toBe(false);
    expect(evaluateConstraint(c('count_lt', 'missing', 1), state)).toBe(true);
  });

  test('leafless children do not count', () => {
    const state = { box: { full: { x: 1 }, hollow: {}, ghost: undefined } };
    expect(evaluateConstraint(c('count_gte', 'box', 1), state)).toBe(true);
    expect(evaluateConstraint(c('count_gte', 'box', 2), state)).toBe(false);
  });
});

describe('evaluateConstraint — $var bindings', () => {
  const bindings = { now: WINDOW + 50, author: 'user-andrew', by: 'agent:scheduler' };

  test('whole-string $var binds verbatim, type-preserved', () => {
    expect(evaluateConstraint(
      c('eq', '$author', 'user-andrew'), topicState(), bindings)).toBe(true);
    expect(evaluateConstraint(
      c('eq', '$author', 'someone-else'), topicState(), bindings)).toBe(false);
    // a bound number stays a number — ordering works on it
    expect(evaluateConstraint(
      c('gte', '$now', WINDOW), topicState(), bindings)).toBe(true);
    expect(evaluateConstraint(
      c('lte', '$now', WINDOW), topicState(), bindings)).toBe(false);
  });

  test('unbound $var falls through to path lookup — unmet, never met', () => {
    expect(evaluateConstraint(c('eq', '$by', 'agent:x'), topicState(), {})).toBe(false);
    expect(evaluateConstraint(c('exists', '$by'), topicState(), {})).toBe(false);
    expect(evaluateConstraint(c('exists', '$by'), topicState(), bindings)).toBe(true);
  });

  test('$var as a path segment substitutes its stringified value', () => {
    const state = { owners: { 'user-andrew': { role: 'admin' } } };
    expect(evaluateConstraint(
      c('eq', 'owners.$author.role', 'admin'), state, bindings)).toBe(true);
    expect(evaluateConstraint(
      c('eq', 'owners.$author.role', 'admin'), state, { author: 'someone-else' })).toBe(false);
  });
});

describe('evaluateConstraint — composite clauses', () => {
  test('and_clause with $author + exists (the G3 corpus form)', () => {
    const bindings = { author: 'user-andrew' };
    const met = c('and_clause',
      c('eq', '$author', 'user-andrew'),
      c('exists', 'title'),
    );
    const unmet = c('and_clause',
      c('eq', '$author', 'someone-else'),
      c('exists', 'title'),
    );
    expect(evaluateConstraint(met, topicState(), bindings)).toBe(true);
    expect(evaluateConstraint(unmet, topicState(), bindings)).toBe(false);
  });

  test('or_clause / not_clause / nesting', () => {
    expect(evaluateConstraint(c('or_clause',
      c('eq', 'metadata.phase', 'draft'),
      c('eq', 'metadata.phase', 'ready'),
    ), topicState())).toBe(true);
    expect(evaluateConstraint(c('or_clause',
      c('eq', 'metadata.phase', 'draft'),
      c('eq', 'metadata.phase', 'review'),
    ), topicState())).toBe(false);
    expect(evaluateConstraint(c('not_clause',
      c('eq', 'metadata.phase', 'draft'),
    ), topicState())).toBe(true);
    expect(evaluateConstraint(c('not_clause', c('and_clause',
      c('exists', 'title'),
      c('not_clause', c('eq', 'metadata.phase', 'draft')),
    )), topicState())).toBe(false);
  });

  test('empty composites: and is vacuously true, or is vacuously false', () => {
    expect(evaluateConstraint(c('and_clause'), topicState())).toBe(true);
    expect(evaluateConstraint(c('or_clause'), topicState())).toBe(false);
  });

  test('non-constraint members fail loud', () => {
    expect(() => evaluateConstraint(
      c('and_clause', 'not-a-constraint'), topicState())).toThrow(/requires Constraint/);
    expect(() => evaluateConstraint(
      c('not_clause', 42), topicState())).toThrow(/requires Constraint/);
  });
});

describe('evaluateConstraint — unsupported forms are loud, never guessed', () => {
  test('forall', () => {
    expect(() => evaluateConstraint(
      c('forall', 'x', 'metadata.usage.*', c('gte', '$x', 0)), topicState(),
    )).toThrow(/forall.*not supported/s);
  });

  test('glob paths', () => {
    expect(() => evaluateConstraint(
      c('exists', 'metadata.usage.*'), topicState())).toThrow(/glob path/);
    expect(() => evaluateConstraint(
      c('count_gte', 'metadata.*', 1), topicState())).toThrow(/glob path/);
  });

  test('v1 argument expressions: aggregates, arithmetic, refs, history', () => {
    expect(() => evaluateConstraint(
      c('gte', { fn: 'sum', args: ['metadata.usage.*'] }, 5), topicState(),
    )).toThrow(/argument expression/);
    expect(() => evaluateConstraint(
      c('gte', { op: '+', lhs: 'a', rhs: 1 }, 5), topicState(),
    )).toThrow(/argument expression/);
    expect(() => evaluateConstraint(
      c('eq', { ref: 'metadata.phase' }, 'ready'), topicState(),
    )).toThrow(/argument expression/);
  });

  test('other v1-only ops', () => {
    for (const op of ['regex', 'between', 'one_of', 'contains', 'cdf_gte', 'concrete_at', 'bind_from', 'satisfies']) {
      expect(() => evaluateConstraint(
        { op, args: ['metadata.phase', 'x'] }, topicState(),
      )).toThrow(/not supported/);
    }
  });

  test('malformed constraint shapes fail loud', () => {
    expect(() => evaluateConstraint(
      { op: '', args: [] } as Constraint, topicState())).toThrow(/not supported/);
    expect(() => evaluateConstraint(
      'metadata.phase == ready' as unknown as Constraint, topicState(),
    )).toThrow(/requires Constraint/);
    expect(() => evaluateConstraint(
      { op: 'eq' } as unknown as Constraint, topicState(),
    )).toThrow(/requires Constraint/);
  });
});

describe('evaluateConstraint — import surface', () => {
  test('is exported from the /v2 index', async () => {
    const v2 = await import('../index');
    expect(v2.evaluateConstraint).toBe(evaluateConstraint);
  });
});

// ── Addressed reads (THE DSL PROGRAM seam 1) ──────────────────────────

import { atTermKey, collectAtTerms } from '../evaluate';

describe('at-terms: addressed evidence reads (gather-then-judge)', () => {
  const term = { at: { address: { uri: 'tp-1', as: 'topic' }, path: 'metadata.track.alice.d' } };
  const law = { op: 'gte', args: [term, 0.8] } as const;

  test('gathered evidence judges normally, type-preserving', () => {
    expect(evaluateConstraint(law as never, {}, { [atTermKey(term)]: 0.9 })).toBe(true);
    expect(evaluateConstraint(law as never, {}, { [atTermKey(term)]: 0.5 })).toBe(false);
  });

  test('UNGATHERED evidence is unmet — never silently true, no throw', () => {
    expect(evaluateConstraint(law as never, {}, {})).toBe(false);
  });

  test('canonical key is order-insensitive (one definition for judge + gatherer)', () => {
    const reordered = { at: { path: 'metadata.track.alice.d', address: { as: 'topic', uri: 'tp-1' } } };
    expect(atTermKey(reordered)).toBe(atTermKey(term));
  });

  test('collectAtTerms walks nested clauses and dedupes', () => {
    const nested = {
      op: 'and_clause',
      args: [law, { op: 'or_clause', args: [law, { op: 'exists', args: ['x'] }] }],
    };
    const terms = collectAtTerms(nested as never);
    expect(terms).toHaveLength(1);
    expect(atTermKey(terms[0])).toBe(atTermKey(term));
  });

  test('an RHS at-term is evidence too — ungathered RHS never falls back to literal text', () => {
    const rhsLaw = { op: 'eq', args: ['metadata.phase', term] };
    expect(evaluateConstraint(rhsLaw as never, { metadata: { phase: 'ready' } }, {})).toBe(false);
    expect(
      evaluateConstraint(rhsLaw as never, { metadata: { phase: 'ready' } }, { [atTermKey(term)]: 'ready' }),
    ).toBe(true);
  });

  test('other object args stay LOUD (the v1-engine forms are still refused)', () => {
    expect(() =>
      evaluateConstraint({ op: 'eq', args: [{ ref: 'x' }, 1] } as never, {}, {}),
    ).toThrow(/not supported/);
  });
});

describe('evaluateConstraint — arithmetic Expr args (delegated to evaluateExpr)', () => {
  /** The cash-flow law shape: declared amounts + a declared bound. */
  const cashState = () => ({
    subscriptions: {
      aws: { amount: 220 },
      github: { amount: 21 },
      vercel: { amount: 20 },
    },
    budget: { monthly: 300 },
  });

  test('lte over a sum of amount paths vs a bound path', () => {
    const sum = {
      add: ['subscriptions.aws.amount', 'subscriptions.github.amount', 'subscriptions.vercel.amount'],
    };
    expect(evaluateConstraint(c('lte', sum, 'budget.monthly'), cashState())).toBe(true);
    expect(evaluateConstraint(c('gt', sum, 250), cashState())).toBe(true);
    expect(evaluateConstraint(c('lte', sum, 260), cashState())).toBe(false); // 261 > 260
  });

  test('mul: product of a path and a literal (annualization)', () => {
    const annual = { mul: ['subscriptions.aws.amount', 12] };
    expect(evaluateConstraint(c('gte', annual, 2640), cashState())).toBe(true);
    expect(evaluateConstraint(c('gt', annual, 2640), cashState())).toBe(false);
  });

  test('$var bindings resolve inside expressions (number-preserving)', () => {
    const withFee = { add: ['subscriptions.aws.amount', '$fee'] };
    expect(evaluateConstraint(c('gte', withFee, 230), cashState(), { fee: 10 })).toBe(true);
    expect(evaluateConstraint(c('gte', withFee, 231), cashState(), { fee: 10 })).toBe(false);
  });

  test('unresolvable ref ⇒ unmet on EITHER polarity — never silently met', () => {
    const sum = { add: ['subscriptions.aws.amount', 'subscriptions.missing.amount'] };
    expect(evaluateConstraint(c('lte', sum, 10_000), cashState())).toBe(false);
    expect(evaluateConstraint(c('gte', sum, 0), cashState())).toBe(false);
  });

  test('non-number leaf ⇒ unmet (a string amount is evidence of nothing)', () => {
    const st = { a: { amount: 'not-a-number' }, b: 5 };
    expect(evaluateConstraint(c('lte', { add: ['a.amount', 'b'] }, 100), st)).toBe(false);
  });

  test('pm band compares by center value', () => {
    const est = { pm: 'subscriptions.aws.amount', margin: 30 };
    expect(evaluateConstraint(c('lte', est, 220), cashState())).toBe(true);
    expect(evaluateConstraint(c('lte', est, 219), cashState())).toBe(false);
  });

  test('{fn} throws loud — the standalone evaluator has no function registry', () => {
    expect(() =>
      evaluateConstraint(c('lte', { fn: 'approxtokens', arg: 'a' }, 10), {}),
    ).toThrow(/function registry/);
  });

  test('arithmetic composes inside and_clause laws', () => {
    const law = c(
      'and_clause',
      c('exists', 'budget.monthly'),
      c('lte', { add: ['subscriptions.aws.amount', 'subscriptions.github.amount'] }, 'budget.monthly'),
    );
    expect(evaluateConstraint(law, cashState())).toBe(true);
  });
});
