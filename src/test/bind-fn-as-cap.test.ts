/**
 * bind-fn-as-cap.test.ts — `mount('bind', path, fn)` is equivalent to
 * `mount('cap', path, fn)` when the schema at `path` is fn-typed.
 *
 * Phase A of the `cap`-op collapse. The user's position: a capability
 * is a mounted coherent function, not a distinct kind of mount. These
 * tests prove that binding a function value to an fn-typed schema
 * produces exactly the same projection state as the legacy cap path —
 * same `implRegistry` entry, same `capabilities` marker, same `_caps`
 * list. Subsequent phases will migrate callers and eventually delete
 * the `cap` op; this phase just makes `bind` sufficient.
 */

import { Sequence } from '../sequence';
import { createType, param, returns } from '../type';
import { FT } from '../builder';

describe('bind with fn value registers impl (cap-op collapse Phase A)', () => {
  function mkFnSchema() {
    return createType('fn', [
      param(createType('object', [])),
      returns(createType('object', [])),
    ]);
  }

  test('bind(path, fn) on an fn-typed schema populates capabilities and implRegistry', () => {
    const seq = new Sequence();
    seq.mount('schema', 'fs.read', mkFnSchema());
    const impl = (_input: unknown) => ({ content: 'hello' });

    seq.mount('bind', 'fs.read', impl);

    // The capability is visible in the `_caps` index and in
    // `projection.capabilities`, exactly like a cap mount would have.
    expect(seq.projection.capabilities.has('fs.read')).toBe(true);
    const caps = seq.get('_caps') as string[];
    expect(caps).toContain('fs.read');
  });

  test('bind(path, fn) and cap(path, fn) produce identical projection state', () => {
    const impl = (_input: unknown) => ({ ok: true });

    const a = new Sequence();
    a.mount('schema', 'echo.once', mkFnSchema());
    a.mount('bind', 'echo.once', impl);

    const b = new Sequence();
    b.mount('schema', 'echo.once', mkFnSchema());
    b.mount('cap', 'echo.once', impl);

    // Same capability marker
    expect(a.projection.capabilities.has('echo.once')).toBe(true);
    expect(b.projection.capabilities.has('echo.once')).toBe(true);

    // Same `_caps` list
    expect(a.get('_caps')).toEqual(b.get('_caps'));

    // Same invocation behavior: binding a NON-function value to the
    // fn-typed path invokes the registered impl with that value as
    // input and records `.input` / `.result`.
    a.mount('bind', 'echo.once', { ping: true });
    b.mount('bind', 'echo.once', { ping: true });
    expect(a.get('echo.once.result')).toEqual({ ok: true });
    expect(b.get('echo.once.result')).toEqual({ ok: true });
    expect(a.get('echo.once.input')).toEqual({ ping: true });
    expect(b.get('echo.once.input')).toEqual({ ping: true });
  });

  test('bind(path, fn) followed by bind(path, input) runs the impl with the input', () => {
    const seq = new Sequence();
    seq.mount('schema', 'double', createType('fn', [
      param(createType('object', [])),
      returns(createType('object', [])),
    ]));
    seq.mount('bind', 'double', (input: any) => ({ value: input.value * 2 }));
    seq.mount('bind', 'double', { value: 21 });
    expect(seq.get('double.result')).toEqual({ value: 42 });
    expect(seq.get('double.input')).toEqual({ value: 21 });
  });

  test('bind(path, non-function) on a non-fn schema still stores as data', () => {
    // The fn-value detection must NOT fire when the schema isn't fn-typed.
    const seq = new Sequence();
    seq.mount('schema', 'greeting', FT.string());
    seq.mount('bind', 'greeting', 'hello');
    expect(seq.get('greeting')).toBe('hello');
    expect(seq.projection.capabilities.has('greeting')).toBe(false);
  });

  test('bind(path, fn) on a non-fn schema falls through to the normal bind path', () => {
    // Edge case: binding a function to a non-fn-typed path. The
    // type check at the schema will reject or pass-through depending
    // on the schema's shape. What it MUST NOT do is register the
    // function as a cap — capabilities require an fn-typed schema.
    const seq = new Sequence();
    seq.mount('schema', 'weird', FT.string());
    seq.mount('bind', 'weird', (() => 'callable') as any);
    // No cap registration happened — the schema isn't fn-typed.
    expect(seq.projection.capabilities.has('weird')).toBe(false);
  });

  test('re-binding a new fn to the same path replaces the impl', () => {
    const seq = new Sequence();
    seq.mount('schema', 'versioned', mkFnSchema());
    seq.mount('bind', 'versioned', (_: unknown) => ({ version: 1 }));
    seq.mount('bind', 'versioned', { call: true });
    expect(seq.get('versioned.result')).toEqual({ version: 1 });

    seq.mount('bind', 'versioned', (_: unknown) => ({ version: 2 }));
    seq.mount('bind', 'versioned', { call: true });
    expect(seq.get('versioned.result')).toEqual({ version: 2 });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Phase B — schema mount of fn-kind IS the capability declaration
// ═══════════════════════════════════════════════════════════════════════
//
// `capabilities` holds the declared-set of capabilities — type state,
// persistent, serialized, queried by cross-process coordination
// (PendingInvocation, planning, getCapabilities). `implRegistry` is
// the process-local slice of those declarations that have cached
// local impls.
//
// Declaration and local-impl are different concerns. Before Phase B
// the only way to populate `capabilities` was via the `cap` mount op.
// That confused declaration with registration. Now a schema mount of
// fn-kind populates `capabilities` automatically — the schema IS the
// declaration. A subsequent bind provides the local impl.

describe('schema mount of fn-kind populates capabilities (Phase B)', () => {
  function mkFnSchema() {
    return createType('fn', [
      param(createType('object', [])),
      returns(createType('object', [])),
    ]);
  }

  test('schema mount with fn kind marks the path as a declared capability', () => {
    const seq = new Sequence();
    seq.mount('schema', 'fs.read', mkFnSchema());
    expect(seq.projection.capabilities.has('fs.read')).toBe(true);
    expect(seq.get('_caps')).toContain('fs.read');
  });

  test('schema mount with non-fn kind does NOT mark as capability', () => {
    const seq = new Sequence();
    seq.mount('schema', 'org.name', FT.string());
    expect(seq.projection.capabilities.has('org.name')).toBe(false);
    const caps = (seq.get('_caps') as string[] | undefined) ?? [];
    expect(caps).not.toContain('org.name');
  });

  test('declaration without local impl — the capability is declared but implRegistry is empty', () => {
    const seq = new Sequence();
    seq.mount('schema', 'external.api', mkFnSchema());
    // Declared
    expect(seq.projection.capabilities.has('external.api')).toBe(true);
    // But this process can't run it locally — no impl.
    expect((seq as any).implRegistry.has('external.api')).toBe(false);
  });

  test('declaration then bind fn — the local impl joins the existing declaration', () => {
    const seq = new Sequence();
    seq.mount('schema', 'math.square', mkFnSchema());
    expect(seq.projection.capabilities.has('math.square')).toBe(true);
    expect((seq as any).implRegistry.has('math.square')).toBe(false);

    seq.mount('bind', 'math.square', (input: any) => ({ value: input.value * input.value }));
    expect(seq.projection.capabilities.has('math.square')).toBe(true);
    expect((seq as any).implRegistry.has('math.square')).toBe(true);

    seq.mount('bind', 'math.square', { value: 7 });
    expect(seq.get('math.square.result')).toEqual({ value: 49 });
  });

  test('schema re-mount (idempotent) does not duplicate the _caps entry', () => {
    const seq = new Sequence();
    seq.mount('schema', 'do.it', mkFnSchema());
    seq.mount('schema', 'do.it', mkFnSchema());
    const caps = seq.get('_caps') as string[];
    const count = caps.filter(c => c === 'do.it').length;
    expect(count).toBe(1);
  });

  test('legacy `cap path true` and new `schema path fnType` produce the same declared-capability state', () => {
    const a = new Sequence();
    a.mount('schema', 'x', mkFnSchema());
    a.mount('cap', 'x', true);

    const b = new Sequence();
    b.mount('schema', 'x', mkFnSchema());
    // No cap mount — the schema alone declares the capability.

    expect(a.projection.capabilities.has('x')).toBe(true);
    expect(b.projection.capabilities.has('x')).toBe(true);
    expect(a.get('_caps')).toEqual(b.get('_caps'));
  });
});
