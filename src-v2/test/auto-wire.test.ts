/**
 * auto-wire.test.ts — installAutoWire: install a `derived` constraint
 * on any gap whose required type is covered by EXACTLY one registered
 * tool, leave ambiguous gaps untouched.
 */

import { Sequence } from '../sequence';
import { installAutoWire } from '../stdlib';
import { createType, param, returns, property } from '../../src/type';

function fnType(input: any, output: any) {
  return createType('fn', [param(input), returns(output)]);
}

describe('installAutoWire — single-match wiring', () => {
  test('gap with exactly one matching tool gains derived constraint', () => {
    const s = new Sequence();
    installAutoWire(s);

    // Tool: takes { x: number } → number.
    const inputType = createType('object', [property('x', createType('number'), false)]);
    const outputType = createType('number');
    s.impls.set('tools.add1', (i: { x: number }) => i.x + 1);
    s.insert({ path: 'tools.add1', type: fnType(inputType, outputType) });

    // Gap: type number at state.result.
    s.insert({ path: 'state.result', type: createType('number') });

    const t = s.typeAt('state.result');
    const derivedC = t?.constraints.find(c => c.op === 'derived');
    expect(derivedC).toBeDefined();
    // Auto-wire goes through a wrapper that packs positional args back
    // into the declared object shape. The wrapper id is deterministic.
    expect(derivedC?.args[0]).toMatch(/^_auto_wire\.wrappers\..*tools_add1$/);
    expect(derivedC?.args.slice(1)).toEqual(['x']);
    // The wrapper impl must be registered.
    expect(s.impls.has(derivedC?.args[0] as string)).toBe(true);
  });

  test('cascade: when input arrives, tool fires through the wired gap', () => {
    const s = new Sequence();
    installAutoWire(s);
    const inputType = createType('object', [property('n', createType('number'), false)]);
    s.impls.set('tools.double', (i: { n: number }) => i.n * 2);
    s.insert({ path: 'tools.double', type: fnType(inputType, createType('number')) });
    s.insert({ path: 'state.result', type: createType('number') });
    // Wiring landed; now provide the input.
    s.insert({ path: 'n', value: 21 });
    // The kernel cascade fills `state.result` via the derived constraint.
    expect(s.get('state.result')).toBe(42);
  });
});

describe('installAutoWire — ambiguity is NOT wired', () => {
  test('two tools covering the same gap type leave the gap unwired', () => {
    const s = new Sequence();
    installAutoWire(s);
    const inputType = createType('object', [property('x', createType('number'), false)]);
    s.impls.set('tools.a', (i: { x: number }) => i.x);
    s.impls.set('tools.b', (i: { x: number }) => i.x + 1);
    s.insert({ path: 'tools.a', type: fnType(inputType, createType('number')) });
    s.insert({ path: 'tools.b', type: fnType(inputType, createType('number')) });
    s.insert({ path: 'state.result', type: createType('number') });

    const t = s.typeAt('state.result');
    expect(t?.constraints.find(c => c.op === 'derived')).toBeUndefined();
  });
});

describe('installAutoWire — preconditions enforced', () => {
  test('does not wire fn-kind gaps (tools are not gaps)', () => {
    const s = new Sequence();
    installAutoWire(s);
    const inputType = createType('object', [property('x', createType('number'), false)]);
    s.impls.set('tools.f', (i: any) => i.x);
    s.insert({ path: 'tools.f', type: fnType(inputType, createType('number')) });
    // Mount another fn-kind gap — must not be wired.
    s.insert({ path: 'state.handler', type: createType('fn') });
    expect(s.typeAt('state.handler')?.constraints.find(c => c.op === 'derived'))
      .toBeUndefined();
  });

  test('does not wire under internal (_*) paths', () => {
    const s = new Sequence();
    installAutoWire(s);
    const inputType = createType('object', [property('x', createType('number'), false)]);
    s.impls.set('tools.f', (i: any) => i.x);
    s.insert({ path: 'tools.f', type: fnType(inputType, createType('number')) });
    s.insert({ path: '_internal.thing', type: createType('number') });
    expect(s.typeAt('_internal.thing')?.constraints.find(c => c.op === 'derived'))
      .toBeUndefined();
  });

  test('does not wire when tool has no registered impl', () => {
    const s = new Sequence();
    installAutoWire(s);
    const inputType = createType('object', [property('x', createType('number'), false)]);
    // Type but no impl — must not wire.
    s.insert({ path: 'tools.unimplemented', type: fnType(inputType, createType('number')) });
    s.insert({ path: 'state.result', type: createType('number') });
    expect(s.typeAt('state.result')?.constraints.find(c => c.op === 'derived'))
      .toBeUndefined();
  });

  test('does not re-wire a gap that already has a derived constraint', () => {
    const s = new Sequence();
    installAutoWire(s);
    const inputType = createType('object', [property('x', createType('number'), false)]);
    s.impls.set('tools.f', (i: any) => i.x);
    s.insert({ path: 'tools.f', type: fnType(inputType, createType('number')) });
    // Pre-existing derived constraint pointing at a non-existent tool — auto-wire
    // must not overwrite it.
    s.insert({
      path: 'state.result',
      type: createType('number', [
        { op: 'derived', args: ['tools.preexisting', 'x'] },
      ]),
    });
    const t = s.typeAt('state.result');
    const derivedCs = t?.constraints.filter(c => c.op === 'derived') ?? [];
    expect(derivedCs).toHaveLength(1);
    expect(derivedCs[0].args[0]).toBe('tools.preexisting');
  });

  test('does not wire when the gap already has a value', () => {
    const s = new Sequence();
    installAutoWire(s);
    const inputType = createType('object', [property('x', createType('number'), false)]);
    s.impls.set('tools.f', (i: any) => i.x);
    s.insert({ path: 'tools.f', type: fnType(inputType, createType('number')) });
    // Gap already realized.
    s.insert({ path: 'state.result', value: 7 });
    expect(s.typeAt('state.result')?.constraints.find(c => c.op === 'derived'))
      .toBeUndefined();
  });
});
