/**
 * cap-auto-wiring.test.ts — capability invocations fire like derived values
 * when the match is unambiguous.
 *
 * The kernel has long made a distinction between derived values (schema
 * carries `derived(...)`, cascade fires automatically) and capability
 * invocations (gap exists + matching cap in backward inference, but the
 * caller has to fire explicitly). These are the same operation: path
 * needs a value, fn can produce it, inputs available, fire it.
 *
 * This suite locks in the unification for the safe case — SOLE match
 * between a gap's required type and the cap's output type, with input
 * values present at the paths named by the cap's param type's property
 * keys. When multiple caps could fill the gap, the kernel does NOT wire
 * — ambiguity is left to a handler at a higher scope.
 *
 * Calling convention: the cap impl is invoked with a single object arg
 * whose shape matches the param type (same convention as explicit
 * `mount('bind', capPath, inputObject)`). The cascade packs values read
 * from the input paths into that object keyed by the param property
 * names.
 */

import { Sequence } from '../sequence';
import { createType, param, returns, property } from '../type';
import { FT } from '../builder';

describe('capability auto-wiring — sole-match fires in cascade', () => {
  function mkDoubleCap(): { schema: ReturnType<typeof createType>; impl: (i: { x: number }) => number } {
    return {
      schema: createType('fn', [
        param(createType('object', [property('x', FT.number(), false)])),
        returns(FT.number()),
      ]),
      impl: (input: { x: number }) => input.x * 2,
    };
  }

  test('sole-match cap auto-fires when input paths have values (cap then gap)', () => {
    const seq = new Sequence(() => 1000);
    const { schema, impl } = mkDoubleCap();

    // Register the capability — fn-typed schema + fn bind.
    seq.mount('schema', 'math.double', schema);
    seq.mount('bind', 'math.double', impl);

    // Declare the gap — a number-typed schema with no value.
    seq.mount('schema', 'result.doubled', FT.number());

    // Gap is unfilled because no input exists yet.
    expect(seq.get('result.doubled')).toBeUndefined();

    // Provide input at the cap's declared property path.
    seq.mount('bind', 'x', 21);

    // Cascade fires the cap and fills the gap.
    expect(seq.get('result.doubled')).toBe(42);
  });

  test('gap-then-cap order also wires and fires', () => {
    const seq = new Sequence(() => 1000);
    const { schema, impl } = mkDoubleCap();

    seq.mount('schema', 'result.doubled', FT.number());
    seq.mount('bind', 'x', 7);

    // Before the cap is registered, nothing to fire.
    expect(seq.get('result.doubled')).toBeUndefined();

    seq.mount('schema', 'math.double', schema);
    seq.mount('bind', 'math.double', impl);

    expect(seq.get('result.doubled')).toBe(14);
  });

  test('multi-match does NOT wire — ambiguity left for a handler', () => {
    const seq = new Sequence(() => 1000);

    // Two caps, both producing number from {x: number}.
    const schemaA = createType('fn', [
      param(createType('object', [property('x', FT.number(), false)])),
      returns(FT.number()),
    ]);
    const schemaB = createType('fn', [
      param(createType('object', [property('x', FT.number(), false)])),
      returns(FT.number()),
    ]);
    seq.mount('schema', 'math.double', schemaA);
    seq.mount('bind', 'math.double', (i: { x: number }) => i.x * 2);
    seq.mount('schema', 'math.square', schemaB);
    seq.mount('bind', 'math.square', (i: { x: number }) => i.x * i.x);

    seq.mount('schema', 'result.value', FT.number());
    seq.mount('bind', 'x', 5);

    // Both caps match — kernel should not pick arbitrarily.
    expect(seq.get('result.value')).toBeUndefined();
  });

  test('missing-input does not fire — impl waits for all declared inputs', () => {
    const seq = new Sequence(() => 1000);
    const { schema, impl } = mkDoubleCap();

    seq.mount('schema', 'math.double', schema);
    seq.mount('bind', 'math.double', impl);
    seq.mount('schema', 'result.doubled', FT.number());

    // No input at path `x` — cap has no values to read.
    expect(seq.get('result.doubled')).toBeUndefined();
  });

  test('gap with a pre-existing value is NOT wired when the cap arrives', () => {
    const seq = new Sequence(() => 1000);
    const { schema, impl } = mkDoubleCap();

    // Schema + value land before the cap exists. Wiring skips this
    // gap because it already has a value — nothing needs filling.
    seq.mount('schema', 'result.doubled', FT.number());
    seq.mount('bind', 'result.doubled', 99);
    seq.mount('bind', 'x', 21);

    seq.mount('schema', 'math.double', schema);
    seq.mount('bind', 'math.double', impl);

    // No wiring was installed, so subsequent input changes do not
    // cascade into the gap. The explicit value is preserved. (If a
    // wire HAD been installed, it would behave as a derived
    // invariant and overwrite — that's the trade-off; the guard
    // protects committed values by refusing to wire over them.)
    expect(seq.get('result.doubled')).toBe(99);
    seq.mount('bind', 'x', 5);
    expect(seq.get('result.doubled')).toBe(99);
  });
});
