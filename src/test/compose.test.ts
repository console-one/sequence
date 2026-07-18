/**
 * compose.test.ts — Lattice meet + type specificity.
 *
 * compose(A, B) = tightest type consistent with both.
 * typeSpecificity(T) = structural constraint measure [0,1].
 * For actual probability, use Sequence.concreteness(path, atTime).
 */

import { FT } from '../builder';
import { compose, covers, typeSpecificity, backwardInfer, evaluateExpr, exprConcreteness, check, selectFirstBranch } from '../compose';
import { createType, isNever, isAny, literalValue, properties, ANY, add, mul, call, pm, type Expr, Type } from '../type';

describe('compose — lattice meet', () => {

  // ── Identity & absorbing ──────────────────────────────────────────

  test('any ∧ X = X', () => {
    const s = FT.string();
    expect(compose(ANY, s)).toEqual(s);
    expect(compose(s, ANY)).toEqual(s);
  });

  test('never ∧ X = never', () => {
    const n = FT.never('reason');
    const s = FT.string();
    expect(isNever(compose(n, s))).toBe(true);
    expect(isNever(compose(s, n))).toBe(true);
  });

  test('any ∧ any = any', () => {
    expect(isAny(compose(ANY, ANY))).toBe(true);
  });

  // ── Kind compatibility ────────────────────────────────────────────

  test('incompatible kinds → never', () => {
    expect(isNever(compose(FT.string(), FT.number()))).toBe(true);
  });

  test('same kind, no constraints → same kind', () => {
    const result = compose(FT.string(), FT.string());
    expect(result.kind).toBe('string');
  });

  // ── Numeric constraints ───────────────────────────────────────────

  test('min ∧ min = tighter min', () => {
    const result = compose(FT.number().min(5), FT.number().min(10));
    const minC = result.constraints.find(c => c.op === 'min');
    expect(minC?.args[0]).toBe(10);
  });

  test('max ∧ max = tighter max', () => {
    const result = compose(FT.number().max(100), FT.number().max(50));
    const maxC = result.constraints.find(c => c.op === 'max');
    expect(maxC?.args[0]).toBe(50);
  });

  test('min > max → never', () => {
    const result = compose(FT.number().min(100), FT.number().max(50));
    expect(isNever(result)).toBe(true);
  });

  test('min ∧ max compatible → both kept', () => {
    const result = compose(FT.number().min(0), FT.number().max(100));
    expect(result.kind).toBe('number');
    expect(result.constraints.some(c => c.op === 'min' && c.args[0] === 0)).toBe(true);
    expect(result.constraints.some(c => c.op === 'max' && c.args[0] === 100)).toBe(true);
  });

  test('range ∧ range = intersection', () => {
    const result = compose(
      createType('number', [{ op: 'range', args: [0, 100] }]),
      createType('number', [{ op: 'range', args: [50, 200] }]),
    );
    const rangeC = result.constraints.find(c => c.op === 'range');
    expect(rangeC?.args).toEqual([50, 100]);
  });

  test('disjoint ranges → never', () => {
    const result = compose(
      createType('number', [{ op: 'range', args: [0, 10] }]),
      createType('number', [{ op: 'range', args: [20, 30] }]),
    );
    expect(isNever(result)).toBe(true);
  });

  // ── Literal constraints ───────────────────────────────────────────

  test('same literal ∧ same literal = literal', () => {
    const result = compose(FT.string('hello'), FT.string('hello'));
    expect(literalValue(result)).toBe('hello');
  });

  test('different literals → never', () => {
    const result = compose(FT.string('hello'), FT.string('world'));
    expect(isNever(result)).toBe(true);
  });

  test('literal ∧ unconstrained kind = literal', () => {
    const result = compose(FT.string('hello'), FT.string());
    expect(literalValue(result)).toBe('hello');
  });

  // ── String constraints ────────────────────────────────────────────

  test('length ∧ length = tighter bounds', () => {
    const result = compose(
      FT.string().length(5, 100),
      FT.string().length(10, 50),
    );
    const lenC = result.constraints.find(c => c.op === 'length');
    expect(lenC?.args).toEqual([10, 50]);
  });

  test('contradictory lengths → never', () => {
    const result = compose(
      FT.string().length(50, 100),
      FT.string().length(10, 20),
    );
    expect(isNever(result)).toBe(true);
  });

  test('different patterns → both kept', () => {
    const result = compose(
      FT.string().pattern('^a'),
      FT.string().pattern('z$'),
    );
    const patterns = result.constraints.filter(c => c.op === 'pattern');
    expect(patterns.length).toBe(2);
  });

  // ── Object constraints ────────────────────────────────────────────

  test('disjoint properties → merged object', () => {
    const result = compose(
      FT.object({ name: FT.string() }),
      FT.object({ age: FT.number() }),
    );
    const props = properties(result);
    expect(props.length).toBe(2);
    expect(props.find(p => p.key === 'name')?.type.kind).toBe('string');
    expect(props.find(p => p.key === 'age')?.type.kind).toBe('number');
  });

  test('overlapping properties → recursively composed', () => {
    const result = compose(
      FT.object({ x: FT.number().min(0) }),
      FT.object({ x: FT.number().max(100) }),
    );
    const props = properties(result);
    const xType = props.find(p => p.key === 'x')?.type;
    expect(xType?.constraints.some(c => c.op === 'min')).toBe(true);
    expect(xType?.constraints.some(c => c.op === 'max')).toBe(true);
  });

  test('contradictory property types → never', () => {
    const result = compose(
      FT.object({ x: FT.string() }),
      FT.object({ x: FT.number() }),
    );
    expect(isNever(result)).toBe(true);
  });

  test('optional ∧ required = required', () => {
    const result = compose(
      FT.object({ 'x?': FT.string() }),
      FT.object({ x: FT.string() }),
    );
    const props = properties(result);
    expect(props.find(p => p.key === 'x')?.optional).toBe(false);
  });

  // ── Array constraints ─────────────────────────────────────────────

  test('element types compose', () => {
    const result = compose(
      FT.array(FT.number().min(0)),
      FT.array(FT.number().max(100)),
    );
    const elem = result.constraints.find(c => c.op === 'element');
    const elemType = elem?.args[0] as any;
    expect(elemType.constraints.some((c: any) => c.op === 'min')).toBe(true);
    expect(elemType.constraints.some((c: any) => c.op === 'max')).toBe(true);
  });

  // ── Function type constraints ─────────────────────────────────────

  test('fn params compose', () => {
    const result = compose(
      FT.fn({ input: FT.object({ a: FT.string() }) }),
      FT.fn({ input: FT.object({ b: FT.number() }) }),
    );
    const paramC = result.constraints.find(c => c.op === 'param');
    const paramType = paramC?.args[0] as any;
    const props = properties(paramType);
    expect(props.length).toBe(2);
  });

  test('fn returns compose', () => {
    const result = compose(
      FT.fn({ output: FT.object({ status: FT.string('done') }) }),
      FT.fn({ output: FT.object({ id: FT.string() }) }),
    );
    const returnsC = result.constraints.find(c => c.op === 'returns');
    const retType = returnsC?.args[0] as any;
    const props = properties(retType);
    expect(props.length).toBe(2);
  });

  // ── Union types ───────────────────────────────────────────────────

  test('union ∧ type = distribute', () => {
    const union = FT.or(FT.string(), FT.number());
    const result = compose(union, FT.string());
    // string branch survives, number branch → never
    expect(result.kind).toBe('string');
  });

  test('union ∧ type where no branch matches → never', () => {
    const union = FT.or(FT.string(), FT.number());
    const result = compose(union, FT.boolean());
    expect(isNever(result)).toBe(true);
  });

  // ── Commutativity ─────────────────────────────────────────────────

  test('compose is commutative for basic types', () => {
    const a = FT.number().min(5).max(100);
    const b = FT.number().min(10).max(50);
    const ab = compose(a, b);
    const ba = compose(b, a);
    // Both should have min(10) and max(50)
    expect(ab.constraints.find(c => c.op === 'min')?.args[0])
      .toBe(ba.constraints.find(c => c.op === 'min')?.args[0]);
    expect(ab.constraints.find(c => c.op === 'max')?.args[0])
      .toBe(ba.constraints.find(c => c.op === 'max')?.args[0]);
  });
});

describe('backwardInfer — derive input from required output', () => {

  test('no preserves → returns declared param (black box)', () => {
    const fn = FT.fn({
      input: FT.object({ query: FT.string() }),
      output: FT.array(FT.any()),
    });
    const required = FT.object({ status: FT.string('done') });
    const result = backwardInfer(fn, required);
    // Can't infer beyond declared param
    const props = properties(result);
    expect(props.length).toBe(1);
    expect(props[0].key).toBe('query');
  });

  test('preserves(*) — effect properties not required from input', () => {
    // addStatus: T → T & { status: 'done' }
    const fn = FT.fn({
      input: FT.object({ id: FT.string() }),
      output: FT.object({ id: FT.string(), status: FT.string('done') }),
      preserves: '*',
    });
    // Require: { status: 'done' } — function already provides this
    const required = FT.object({ status: FT.string('done') });
    const result = backwardInfer(fn, required);
    // Input just needs what param declares (id)
    const props = properties(result);
    expect(props.length).toBe(1);
    expect(props[0].key).toBe('id');
  });

  test('preserves(*) — non-effect properties traced to input', () => {
    // addStatus: T → T & { status: 'done' }
    const fn = FT.fn({
      
      input: FT.object({ id: FT.string() }),

      output: FT.object({ 
        id: FT.string(), 
        status: FT.string('done') 
      }),
      preserves: '*',
    });
    // Require: { status: 'done', name: string }
    // status is an effect. name is NOT → must come from input.
    const required = FT.object({
      status: FT.string('done'),
      name: FT.string(),
    });
    const result = backwardInfer(fn, required);
    const props = properties(result);
    const keys = props.map(p => p.key).sort();
    expect(keys).toEqual(['id', 'name']); // id from param, name from requirement
  });

  test('preserves(*) — backward chain through two functions', () => {
    // f1: T → T & { parsed: true }
    const f1 = FT.fn({
      input: FT.any(),
      output: FT.object({ parsed: FT.boolean(true) }),
      preserves: '*',
    });
    // f2: U → U & { validated: true }
    const f2 = FT.fn({
      input: FT.any(),
      output: FT.object({ validated: FT.boolean(true) }),
      preserves: '*',
    });

    // Goal: { parsed: true, validated: true, id: string }
    const goal = FT.object({
      parsed: FT.boolean(true),
      validated: FT.boolean(true),
      id: FT.string(),
    });

    // Backward through f2: f2 adds { validated }, so input needs { parsed, id }
    const f2Input = backwardInfer(f2, goal);
    const f2Props = properties(f2Input);
    const f2Keys = f2Props.map(p => p.key).sort();
    expect(f2Keys).toEqual(['id', 'parsed']);

    // Backward through f1: f1 adds { parsed }, so input needs { id }
    const f1Input = backwardInfer(f1, f2Input);
    const f1Props = properties(f1Input);
    const f1Keys = f1Props.map(p => p.key).sort();
    expect(f1Keys).toEqual(['id']);
  });

  test('preserves with specific path mapping', () => {
    // wrap: { content: T } → { data: T, timestamp: number }
    // preserves: input.content → output.data
    const fn = FT.fn({
      input: FT.object({ content: FT.any() }),
      output: FT.object({
        data: FT.object({ value: FT.any() }),
        timestamp: FT.number(),
      }),
      preserves: [['content', 'data']],
    });

    // Require output with specific data type
    const required = FT.object({
      data: FT.object({ value: FT.string() }),
      timestamp: FT.number(),
    });
    const result = backwardInfer(fn, required);
    const props = properties(result);
    // output.data maps back to input.content via preserves
    // timestamp has no mapping → effect, not required from input
    const contentProp = props.find(p => p.key === 'content');
    expect(contentProp).toBeDefined();
    // The content property should carry the required type from output.data
    expect(contentProp!.type.kind).toBe('object');
    // No 'data' in input — that's an output path
    expect(props.find(p => p.key === 'data')).toBeUndefined();
  });

  test('non-fn type → returns any', () => {
    const result = backwardInfer(FT.string(), FT.number());
    expect(isAny(result)).toBe(true);
  });

  test('preserves(*) with any param — unconstrained input', () => {
    // A function that accepts anything and adds status
    const fn = FT.fn({
      input: FT.any(),
      output: FT.object({ status: FT.string('done') }),
      preserves: '*',
    });

    // If we only need status, param suffices (any)
    const required = FT.object({ status: FT.string('done') });
    const result = backwardInfer(fn, required);
    expect(isAny(result)).toBe(true);

    // If we need more, those requirements flow to input
    const required2 = FT.object({
      status: FT.string('done'),
      id: FT.string(),
    });
    const result2 = backwardInfer(fn, required2);
    const props = properties(result2);
    expect(props.some(p => p.key === 'id')).toBe(true);
  });
});

describe('backwardInfer — identity (value-level)', () => {

  test('identity maps output requirement to input', () => {
    // fn: (input: string) => { id: string } where output.id === input
    const fn = FT.fn({
      input: FT.string(),
      output: FT.object({ id: FT.string() }),
      identity: [['id', '.']],  // output.id === input (root)
    });

    // If output.id must be 'abc' → input must be 'abc'
    const required = FT.object({ id: FT.string('abc') });
    const result = backwardInfer(fn, required);
    // The literal 'abc' should flow back to the input
    expect(literalValue(result)).toBe('abc');
  });

  test('identity with property-to-property mapping', () => {
    // fn: ({ name }) => { owner: name } where output.owner === input.name
    const fn = FT.fn({
      input: FT.object({ name: FT.string() }),
      output: FT.object({ owner: FT.string(), created: FT.number() }),
      identity: [['owner', 'name']],
    });

    const required = FT.object({ owner: FT.string('alice') });
    const result = backwardInfer(fn, required);
    const props = properties(result);
    const nameProp = props.find(p => p.key === 'name');
    expect(nameProp).toBeDefined();
    expect(literalValue(nameProp!.type)).toBe('alice');
  });

  test('scope-level equation is expressible on object types', () => {
    // A scope with set/get functions and cross-function identity
    const reportAPI = FT.object({
      setReport: FT.fn({
        input: FT.object({ id: FT.string(), content: FT.string() }),
        output: FT.string(),  // returns the report ID
        identity: [['.',  'input.id']],  // output ≡ input.id
      }),
      getReport: FT.fn({
        input: FT.string(),  // report ID
        output: FT.object({ id: FT.string(), content: FT.string() }),
        identity: [['id', '.']],  // output.id ≡ input
      }),
    })
    // Scope-level: getReport(setReport(r)) ≡ r @ t > t_set, P = decay(elapsed)
    .eq('getReport($setReport)', '$setReport.input', {
      from: 'setReport._t',                       // valid after set completes
      reliability: { fn: 'decay', arg: '_elapsed' }, // P degrades over time
    });

    // The equation constraint is present on the object type
    const eqs = reportAPI.constraints.filter(c => c.op === 'equation');
    expect(eqs.length).toBe(1);
    expect(eqs[0].args[0]).toBe('getReport($setReport)');
    expect(eqs[0].args[1]).toBe('$setReport.input');
    expect((eqs[0].args[2] as any).from).toBe('setReport._t');
    expect((eqs[0].args[2] as any).reliability).toEqual({ fn: 'decay', arg: '_elapsed' });

    // setReport's identity: output ≡ input.id
    const setFn = reportAPI.constraints.find(
      c => c.op === 'property' && c.args[0] === 'setReport'
    );
    expect(setFn).toBeDefined();
    const setType = setFn!.args[1] as Type;
    const setIdentities = setType.constraints.filter(c => c.op === 'identity');
    expect(setIdentities.length).toBe(1);
    expect(setIdentities[0].args).toEqual(['.', 'input.id']);

    // backwardInfer on setReport: if output must be 'report-1', then input.id must be 'report-1'
    const required = FT.string('report-1');
    const inputNeeded = backwardInfer(setType, required);
    // Should have id = 'report-1' in the input
    const idProp = properties(inputNeeded).find(p => p.key === 'id');
    // The identity maps output (root) to input.id — so literal flows to input.id
    expect(idProp).toBeDefined();
  });
});

describe('behavioral laws — cross-method protocol', () => {

  test('Store protocol: set/get with behavioral law', () => {
    const store = FT.object({
      set: FT.fn({
        input: FT.object({ key: FT.string(), value: FT.any() }),
        output: FT.string(), // returns key
        identity: [['.', 'input.key']],
      }),
      get: FT.fn({
        input: FT.string(), // key
        output: FT.any(),
        identity: [['.', '.']],  // output ≡ what was stored at input key
      }),
      delete: FT.fn({
        input: FT.string(),
        output: FT.boolean(),
      }),
    })
    .law({
      trigger: 'set($value, $key) => $key',
      implies: 'get($key) => $value',
      terminates: 'delete($key)',
    });

    // Laws are present as constraints
    const laws = store.constraints.filter(c => c.op === 'law');
    expect(laws.length).toBe(1);
    const spec = laws[0].args[0] as any;
    expect(spec.trigger).toBe('set($value, $key) => $key');
    expect(spec.implies).toBe('get($key) => $value');
    expect(spec.terminates).toBe('delete($key)');

    // Methods are properties with fn types
    const setProp = store.constraints.find(
      c => c.op === 'property' && c.args[0] === 'set'
    );
    expect(setProp).toBeDefined();
    expect((setProp!.args[1] as Type).kind).toBe('fn');
  });

  test('distribution constraint on fn type', () => {
    const apiCall = FT.fn({
      input: FT.object({ url: FT.string() }),
      output: FT.object({ status: FT.number(), body: FT.string() }),
    });

    // Manually add distribution constraints (builder support TBD)
    const withDist = createType('fn', [
      ...apiCall.constraints,
      { op: 'distribution', args: ['time', 'lognormal', { mu: 7.6, sigma: 0.3 }] },
      { op: 'distribution', args: ['reliability', 'beta', { alpha: 95, beta: 5 }] },
    ]);

    const timeDist = withDist.constraints.find(
      c => c.op === 'distribution' && c.args[0] === 'time'
    );
    expect(timeDist).toBeDefined();
    expect(timeDist!.args[1]).toBe('lognormal');
    expect((timeDist!.args[2] as any).mu).toBe(7.6);

    const relDist = withDist.constraints.find(
      c => c.op === 'distribution' && c.args[0] === 'reliability'
    );
    expect(relDist).toBeDefined();
    expect((relDist!.args[2] as any).alpha).toBe(95);
  });
});

describe('distribution CDF evaluation', () => {

  test('exponential CDF', () => {
    const { cdf } = require('../compose');
    // P(T ≤ 1000) with rate 0.001
    expect(cdf('exponential', 1000, { rate: 0.001 })).toBeCloseTo(0.632, 2);
    expect(cdf('exponential', 0, { rate: 0.001 })).toBe(0);
    expect(cdf('exponential', 10000, { rate: 0.001 })).toBeGreaterThan(0.99);
  });

  test('fixed CDF', () => {
    const { cdf } = require('../compose');
    expect(cdf('fixed', 500, { value: 1000 })).toBe(0);  // not yet
    expect(cdf('fixed', 1000, { value: 1000 })).toBe(1);  // exactly at
    expect(cdf('fixed', 2000, { value: 1000 })).toBe(1);  // after
  });

  test('posteriorPredictive beta', () => {
    const { posteriorPredictive } = require('../compose');
    // Beta(9, 1) → P(success) = 9/10 = 0.9
    expect(posteriorPredictive('beta', { alpha: 9, beta: 1 })).toBeCloseTo(0.9, 2);
    // Beta(1, 1) → P(success) = 0.5 (uniform prior)
    expect(posteriorPredictive('beta', { alpha: 1, beta: 1 })).toBeCloseTo(0.5, 2);
  });

  test('conjugateUpdate beta', () => {
    const { conjugateUpdate } = require('../compose');
    const initial = { alpha: 1, beta: 1 };
    const afterSuccess = conjugateUpdate('beta', initial, 'success');
    expect(afterSuccess.alpha).toBe(2);
    expect(afterSuccess.beta).toBe(1);
    const afterFailure = conjugateUpdate('beta', afterSuccess, 'failure');
    expect(afterFailure.alpha).toBe(2);
    expect(afterFailure.beta).toBe(2);
  });

  test('conjugateUpdate with evidence weight — validity(t) on the update', () => {
    const { conjugateUpdate, evidenceDecay } = require('../compose');
    // Weight 1 IS the classical update (the default path above).
    expect(conjugateUpdate('beta', { alpha: 1, beta: 1 }, 'success', 1).alpha).toBe(2);
    // A half-life-aged success contributes half a success.
    const w = evidenceDecay(7 * 86_400_000, 7 * 86_400_000);
    expect(w).toBeCloseTo(0.5, 10);
    expect(conjugateUpdate('beta', { alpha: 1, beta: 1 }, 'success', w).alpha).toBeCloseTo(1.5, 10);
    // Gamma: both sufficient statistics scale by the weight.
    const g = conjugateUpdate('gamma', { shape: 1, rate: 1 }, 4, 0.25);
    expect(g.shape).toBeCloseTo(1.25, 10);
    expect(g.rate).toBeCloseTo(2, 10);
    // Decay edges: fresh = 1; disabled half-life = 1; ancient → 0.
    expect(evidenceDecay(0, 1000)).toBe(1);
    expect(evidenceDecay(5000, 0)).toBe(1);
    expect(evidenceDecay(100 * 86_400_000, 86_400_000)).toBeLessThan(1e-9);
  });
});

describe('typeSpecificity — structural constraint measure', () => {

  test('never = 0', () => {
    expect(typeSpecificity(FT.never())).toBe(0);
  });

  test('any > 0 (unconstrained but satisfiable, not impossible)', () => {
    expect(typeSpecificity(ANY)).toBeGreaterThan(0);
    expect(typeSpecificity(ANY)).toBeLessThan(0.1);
  });

  test('literal = 1 (fully determined)', () => {
    expect(typeSpecificity(FT.string('hello'))).toBe(1);
    expect(typeSpecificity(FT.number(42))).toBe(1);
  });

  test('constrained > unconstrained', () => {
    const bare = FT.number();
    const constrained = FT.number().min(0).max(100);
    expect(typeSpecificity(constrained)).toBeGreaterThan(typeSpecificity(bare));
  });

  test('object specificity = product of properties', () => {
    const allLiteral = FT.object({ x: FT.number(1), y: FT.number(2) });
    expect(typeSpecificity(allLiteral)).toBe(1);

    const oneLiteral = FT.object({ x: FT.number(1), y: FT.number() });
    expect(typeSpecificity(oneLiteral)).toBeLessThan(1);
    expect(typeSpecificity(oneLiteral)).toBeGreaterThan(0);
  });

  test('more constraints → more specific', () => {
    const c1 = typeSpecificity(FT.number().min(0));
    const c2 = typeSpecificity(FT.number().min(0).max(100));
    expect(c2).toBeGreaterThan(c1);
  });
});

describe('evaluateExpr — computable output properties', () => {

  test('literal returns value', () => {
    const result = evaluateExpr(42, {});
    expect(result?.value).toBe(42);
  });

  test('path reference resolves from bindings', () => {
    const result = evaluateExpr('input.duration', { 'input.duration': 500 });
    expect(result?.value).toBe(500);
  });

  test('missing path → undefined', () => {
    const result = evaluateExpr('input.missing', {});
    expect(result).toBeUndefined();
  });

  test('addition', () => {
    const expr: Expr = add(100, 'input.duration', 50);
    const result = evaluateExpr(expr, { 'input.duration': 500 });
    expect(result?.value).toBe(650);
  });

  test('multiplication', () => {
    const expr: Expr = mul('input.tokens', 0.356);
    const result = evaluateExpr(expr, { 'input.tokens': 1000 });
    expect(result?.value).toBeCloseTo(356);
  });

  test('named function', () => {
    const approxtokens = (n: number) => 0.34 * n;
    const expr: Expr = call('approxtokens', 'input.length');
    const result = evaluateExpr(expr, { 'input.length': 1000 }, { approxtokens });
    expect(result?.value).toBeCloseTo(340);
  });

  test('uncertainty band (±)', () => {
    const expr: Expr = pm(
      add(100, 'input.base'),
      mul(0.5, 'input.base'),
    );
    const result = evaluateExpr(expr, { 'input.base': 200 });
    expect(result?.value).toBe(300);  // 100 + 200
    expect(result?.lo).toBe(200);     // 300 - 100
    expect(result?.hi).toBe(400);     // 300 + 100
  });

  test('full example: output.time polynomial', () => {
    // output.time = input.start + 100 + input.duration + approxtokens(input.message) * 0.356
    //   ± (0.5 * approxtokens(input.message))
    const approxtokens = (n: number) => 0.34 * n;

    const timeExpr: Expr = pm(
      add(
        'input.start',
        100,
        'input.duration',
        mul(call('approxtokens', 'input.messageLen'), 0.356),
      ),
      mul(0.5, call('approxtokens', 'input.messageLen')),
    );

    const bindings = {
      'input.start': 1000,
      'input.duration': 200,
      'input.messageLen': 500,
    };

    const result = evaluateExpr(timeExpr, bindings, { approxtokens });
    // center = 1000 + 100 + 200 + (0.34 * 500) * 0.356
    //        = 1000 + 100 + 200 + 170 * 0.356
    //        = 1300 + 60.52 = 1360.52
    // margin = 0.5 * (0.34 * 500) = 0.5 * 170 = 85
    expect(result).toBeDefined();
    expect(result!.value).toBeCloseTo(1360.52);
    expect(result!.lo).toBeCloseTo(1360.52 - 85);
    expect(result!.hi).toBeCloseTo(1360.52 + 85);
  });

  test('partial bindings → undefined', () => {
    const expr: Expr = add('a', 'b');
    // Only one binding provided
    expect(evaluateExpr(expr, { a: 10 })).toBeUndefined();
  });
});

describe('exprConcreteness — how evaluable is an expression?', () => {

  test('pure constant = 1', () => {
    expect(exprConcreteness(42, new Set())).toBe(1);
    expect(exprConcreteness(add(1, 2, 3), new Set())).toBe(1);
  });

  test('all refs available = 1', () => {
    const expr: Expr = add('a', 'b');
    expect(exprConcreteness(expr, new Set(['a', 'b']))).toBe(1);
  });

  test('no refs available = 0', () => {
    const expr: Expr = add('a', 'b');
    expect(exprConcreteness(expr, new Set())).toBe(0);
  });

  test('partial refs = fraction', () => {
    const expr: Expr = add('a', 'b', 'c');
    expect(exprConcreteness(expr, new Set(['a']))).toBeCloseTo(1/3);
    expect(exprConcreteness(expr, new Set(['a', 'b']))).toBeCloseTo(2/3);
  });

  test('refs inside nested expressions counted', () => {
    const expr: Expr = pm(
      add('x', mul('y', 0.5)),
      mul(0.1, 'z'),
    );
    // refs: x, y, z (3 total)
    expect(exprConcreteness(expr, new Set(['x', 'y', 'z']))).toBe(1);
    expect(exprConcreteness(expr, new Set(['x']))).toBeCloseTo(1/3);
  });
});

describe('selectFirstBranch — ordered choice dispatch', () => {

  test('returns first matching branch of a union', () => {
    const union = FT.or(
      FT.string().literal('open'),
      FT.string().literal('closed'),
      FT.string(),
    );
    const candidate = FT.string().literal('open');
    const result = selectFirstBranch(union, candidate);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0);
    expect(literalValue(result!.branch)).toBe('open');
  });

  test('skips non-matching branches, picks second', () => {
    const union = FT.or(
      FT.number(),
      FT.string().literal('yes'),
      FT.string(),
    );
    const candidate = FT.string().literal('yes');
    const result = selectFirstBranch(union, candidate);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(1);
  });

  test('returns null when no branch matches', () => {
    const union = FT.or(
      FT.string().literal('a'),
      FT.string().literal('b'),
    );
    const candidate = FT.number();
    const result = selectFirstBranch(union, candidate);
    expect(result).toBeNull();
  });

  test('works on non-union types', () => {
    const single = FT.string();
    const result = selectFirstBranch(single, FT.string().literal('hi'));
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0);
  });

  test('ordered choice: more specific first, general last', () => {
    const union = FT.or(
      FT.object({ method: FT.string().literal('GET'), path: FT.string() }),
      FT.object({ method: FT.string(), path: FT.string() }),
    );
    // A GET request should match the first (more specific) branch
    const getReq = FT.object({ method: FT.string().literal('GET'), path: FT.string().literal('/api') });
    const result = selectFirstBranch(union, getReq);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(0);

    // A POST request should match the second (general) branch
    const postReq = FT.object({ method: FT.string().literal('POST'), path: FT.string().literal('/api') });
    const postResult = selectFirstBranch(union, postReq);
    expect(postResult).not.toBeNull();
    expect(postResult!.index).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PROBABILISTIC DEADLINE FEASIBILITY — opt-in in compose
// ═══════════════════════════════════════════════════════════════════════

import { distribution, responsePolicy, temporal, param, returns } from '../type';

describe('probabilistic deadline feasibility', () => {

  /** Build a fn type with time distribution + optional deadline + optional confidence. */
  function timedFn(opts: {
    timeMu: number; timeSigma: number;
    timeout?: number; confidence?: number;
    temporalLt?: number; temporalGt?: number;
  }) {
    const constraints = [
      param(FT.object({ input: FT.string() })),
      returns(FT.object({ output: FT.string() })),
      distribution('time', 'lognormal', { mu: opts.timeMu, sigma: opts.timeSigma }),
    ];
    if (opts.timeout !== undefined || opts.confidence !== undefined) {
      constraints.push(responsePolicy(opts.timeout, opts.confidence));
    }
    if (opts.temporalLt !== undefined) {
      constraints.push(temporal('lt', '_rt', opts.temporalLt));
    }
    if (opts.temporalGt !== undefined) {
      constraints.push(temporal('gt', '_rt', opts.temporalGt));
    }
    return createType('fn', constraints);
  }

  // ─── Branch eliminated when confidence unmet ──────────────────

  test('compose → never when P(completion ≤ timeout) < confidence', () => {
    // lognormal(mu=7, sigma=0.5): P(≤500ms) ≈ 0.058
    // With confidence=0.95, 0.058 < 0.95 → never
    const slow = timedFn({ timeMu: 7, timeSigma: 0.5, timeout: 500, confidence: 0.95 });
    const request = timedFn({ timeMu: 7, timeSigma: 0.5, timeout: 500, confidence: 0.95 });
    const result = compose(slow, request);
    expect(isNever(result)).toBe(true);
    // Verify rejection reason
    expect((result as any).meta?.reason).toContain('deadline infeasible');
    expect((result as any).meta?.reason).toContain('lognormal');
  });

  // ─── Branch accepted when confidence met ──────────────────────

  test('compose → ok when P(completion ≤ timeout) ≥ confidence', () => {
    // lognormal(mu=7, sigma=0.5): P(≤5000ms) ≈ 0.999
    // With confidence=0.95, 0.999 ≥ 0.95 → ok
    const fast = timedFn({ timeMu: 7, timeSigma: 0.5, timeout: 5000, confidence: 0.95 });
    const request = timedFn({ timeMu: 7, timeSigma: 0.5, timeout: 5000, confidence: 0.95 });
    const result = compose(fast, request);
    expect(isNever(result)).toBe(false);
  });

  // ─── No regression: absent confidence → no check ──────────────

  test('no confidence constraint → no probabilistic check (backward compat)', () => {
    // Distribution present but no responsePolicy → should compose fine
    const noPolicy = timedFn({ timeMu: 7, timeSigma: 0.5 });
    const result = compose(noPolicy, noPolicy);
    expect(isNever(result)).toBe(false);
  });

  test('responsePolicy without distribution → no probabilistic check', () => {
    // Confidence present but no time distribution → should compose fine
    const noDist = createType('fn', [
      param(FT.object({ input: FT.string() })),
      returns(FT.object({ output: FT.string() })),
      responsePolicy(500, 0.95),
    ]);
    const result = compose(noDist, noDist);
    expect(isNever(result)).toBe(false);
  });

  // ─── Monotonicity: tighter deadline cannot increase feasibility ─

  test('tighter deadline cannot increase feasibility', () => {
    // lognormal(mu=7, sigma=0.5):
    //   P(≤5000) ≈ 0.999 (feasible at 0.95)
    //   P(≤2000) ≈ 0.885 (infeasible at 0.95)
    //   P(≤1000) ≈ 0.427 (infeasible at 0.95)
    const loose = timedFn({ timeMu: 7, timeSigma: 0.5, timeout: 5000, confidence: 0.95 });
    const medium = timedFn({ timeMu: 7, timeSigma: 0.5, timeout: 2000, confidence: 0.95 });
    const tight = timedFn({ timeMu: 7, timeSigma: 0.5, timeout: 1000, confidence: 0.95 });

    const rLoose = compose(loose, loose);
    const rMedium = compose(medium, medium);
    const rTight = compose(tight, tight);

    // Feasibility must be monotonically non-increasing with tighter deadline
    expect(isNever(rLoose)).toBe(false);   // feasible
    expect(isNever(rMedium)).toBe(true);   // infeasible
    expect(isNever(rTight)).toBe(true);    // infeasible
  });

  // ─── Temporal window via gt/lt pair ───────────────────────────

  test('temporal gt/lt pair defines available window', () => {
    // Window: 1000ms to 3000ms → 2000ms available
    // lognormal(mu=7, sigma=0.5): P(≤2000) ≈ 0.885
    // With confidence=0.80 → feasible (0.885 ≥ 0.80)
    // With confidence=0.95 → infeasible (0.885 < 0.95)
    const feasible80 = timedFn({
      timeMu: 7, timeSigma: 0.5,
      temporalGt: 1000, temporalLt: 3000,
      confidence: 0.80,
    });
    const infeasible95 = timedFn({
      timeMu: 7, timeSigma: 0.5,
      temporalGt: 1000, temporalLt: 3000,
      confidence: 0.95,
    });

    expect(isNever(compose(feasible80, feasible80))).toBe(false);
    expect(isNever(compose(infeasible95, infeasible95))).toBe(true);
  });

  // ─── Explainability: rejection reason is structured ───────────

  test('rejection reason includes CDF, confidence, deadline, and distribution params', () => {
    const infeasible = timedFn({ timeMu: 7, timeSigma: 0.5, timeout: 500, confidence: 0.95 });
    const result = compose(infeasible, infeasible);
    expect(isNever(result)).toBe(true);

    const reason = (result as any).meta?.reason as string;
    expect(reason).toContain('deadline infeasible');
    expect(reason).toContain('P(completion');
    expect(reason).toContain('500ms');
    expect(reason).toContain('0.95');
    expect(reason).toContain('lognormal');
    expect(reason).toContain('"mu":7');
    expect(reason).toContain('"sigma":0.5');
  });

  // ─── selectFirstBranch with temporal elimination ──────────────

  test('selectFirstBranch eliminates slow branch, picks fast branch', () => {
    // Branch 0: slow (mu=7, ~1097ms median) with 500ms deadline at 95% → infeasible
    // Branch 1: fast (mu=6, ~403ms median) with 500ms deadline at 95% → P(≤500)≈0.76 < 0.95 → also infeasible
    // Branch 1 with 1000ms deadline at 95%: P(≤1000)≈0.999 → feasible
    const slowBranch = timedFn({ timeMu: 7, timeSigma: 0.5, timeout: 1000, confidence: 0.95 });
    const fastBranch = timedFn({ timeMu: 6, timeSigma: 0.3, timeout: 1000, confidence: 0.95 });

    const union = createType('or', [
      { op: 'branch', args: [slowBranch] },
      { op: 'branch', args: [fastBranch] },
    ]);

    // lognormal(mu=7,sigma=0.5): P(≤1000)≈0.427 < 0.95 → branch 0 eliminated
    // lognormal(mu=6,sigma=0.3): P(≤1000)≈0.999 ≥ 0.95 → branch 1 selected
    const result = selectFirstBranch(union, fastBranch);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// covers — type-level containment
// ═══════════════════════════════════════════════════════════════════════

describe('covers — type-level containment', () => {

  test('candidate has required property → covered', () => {
    const required = createType('object', [
      { op: 'property', args: ['content', createType('string', []), false] },
    ]);
    const candidate = createType('object', [
      { op: 'property', args: ['content', createType('string', []), false] },
      { op: 'property', args: ['title', createType('string', []), false] },
    ]);
    expect(covers(required, candidate)).toBe(true);
  });

  test('candidate lacks required property → not covered', () => {
    const required = createType('object', [
      { op: 'property', args: ['content', createType('string', []), false] },
    ]);
    const candidate = createType('object', [
      { op: 'property', args: ['status', createType('string', []), false] },
    ]);
    // compose says yes (non-overlapping properties are never contradictory)
    expect(isNever(compose(required, candidate))).toBe(false);
    // covers says no (candidate doesn't have content)
    expect(covers(required, candidate)).toBe(false);
  });

  test('empty object covers any object', () => {
    const required = createType('object', []);
    const candidate = createType('object', [
      { op: 'property', args: ['x', createType('number', []), false] },
    ]);
    expect(covers(required, candidate)).toBe(true);
  });

  test('property type conflict → not covered', () => {
    const required = createType('object', [
      { op: 'property', args: ['x', createType('string', []), false] },
    ]);
    const candidate = createType('object', [
      { op: 'property', args: ['x', createType('number', []), false] },
    ]);
    expect(covers(required, candidate)).toBe(false);
  });

  test('optional property in required skipped for coverage', () => {
    const required = createType('object', [
      { op: 'property', args: ['a', createType('string', []), false] },
      { op: 'property', args: ['b', createType('string', []), true] }, // optional
    ]);
    const candidate = createType('object', [
      { op: 'property', args: ['a', createType('string', []), false] },
    ]);
    expect(covers(required, candidate)).toBe(true);
  });

  test('kind mismatch → not covered', () => {
    expect(covers(createType('string', []), createType('number', []))).toBe(false);
  });

  test('same primitive → covered', () => {
    expect(covers(createType('string', []), createType('string', []))).toBe(true);
  });

  test('any covers everything', () => {
    expect(covers(ANY, createType('string', []))).toBe(true);
    expect(covers(ANY, createType('number', []))).toBe(true);
  });

  test('required=string, candidate=any → not covered', () => {
    expect(covers(createType('string', []), ANY)).toBe(false);
  });

  test('never candidate vacuously covers', () => {
    const never = createType('string', [], { reason: 'test' });
    expect(covers(createType('string', []), never)).toBe(true);
  });

  test('nested object property coverage', () => {
    const inner = createType('object', [
      { op: 'property', args: ['url', createType('string', []), false] },
    ]);
    const required = createType('object', [
      { op: 'property', args: ['config', inner, false] },
    ]);
    const candidate = createType('object', [
      { op: 'property', args: ['config', createType('object', [
        { op: 'property', args: ['url', createType('string', []), false] },
        { op: 'property', args: ['port', createType('number', []), false] },
      ]), false] },
    ]);
    expect(covers(required, candidate)).toBe(true);
  });

  test('union candidate: all branches must cover', () => {
    const required = createType('object', [
      { op: 'property', args: ['x', createType('string', []), false] },
    ]);
    const branch1 = createType('object', [
      { op: 'property', args: ['x', createType('string', []), false] },
    ]);
    const branch2 = createType('object', [
      { op: 'property', args: ['y', createType('string', []), false] },
    ]);
    const unionBoth = createType('or', [
      { op: 'branch', args: [branch1] },
      { op: 'branch', args: [branch2] },
    ]);
    // branch2 lacks 'x' → union doesn't cover
    expect(covers(required, unionBoth)).toBe(false);

    // If both branches have x → covers
    const branch2fixed = createType('object', [
      { op: 'property', args: ['x', createType('string', []), false] },
      { op: 'property', args: ['y', createType('string', []), false] },
    ]);
    const unionFixed = createType('or', [
      { op: 'branch', args: [branch1] },
      { op: 'branch', args: [branch2fixed] },
    ]);
    expect(covers(required, unionFixed)).toBe(true);
  });
});
