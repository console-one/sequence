/**
 * bind-fn-as-tool.test.ts — `mount('bind', path, fn)` is equivalent to
 * `mount('tool', path, fn)` when the schema at `path` is fn-typed.
 *
 * Phase A of the `tool`-op collapse. The user's position: a tool
 * is a mounted coherent function, not a distinct kind of mount. These
 * tests prove that binding a function value to an fn-typed schema
 * produces exactly the same projection state as the legacy tool path —
 * same `implRegistry` entry, same `tools` marker, same `_tools`
 * list. Subsequent phases will migrate callers and eventually delete
 * the `tool` op; this phase just makes `bind` sufficient.
 */

import { Sequence } from '../sequence';
import { createType, param, returns } from '../type';
import { FT } from '../builder';

describe('bind with fn value registers impl (tool-op collapse Phase A)', () => {
  function mkFnSchema() {
    return createType('fn', [
      param(createType('object', [])),
      returns(createType('object', [])),
    ]);
  }

  test('bind(path, fn) on an fn-typed schema populates tools and implRegistry', () => {
    const seq = new Sequence();
    seq.mount('schema', 'fs.read', mkFnSchema());
    const impl = (_input: unknown) => ({ content: 'hello' });

    seq.mount('bind', 'fs.read', impl);

    // The tool is visible in the `_tools` index and in
    // `projection.tools`, exactly like a tool mount would have.
    expect(seq.projection.tools.has('fs.read')).toBe(true);
    const tools = seq.get('_tools') as string[];
    expect(tools).toContain('fs.read');
  });

  test('bind(path, fn) and tool(path, fn) produce identical projection state', () => {
    const impl = (_input: unknown) => ({ ok: true });

    const a = new Sequence();
    a.mount('schema', 'echo.once', mkFnSchema());
    a.mount('bind', 'echo.once', impl);

    const b = new Sequence();
    b.mount('schema', 'echo.once', mkFnSchema());
    b.mount('tool', 'echo.once', impl);

    // Same tool marker
    expect(a.projection.tools.has('echo.once')).toBe(true);
    expect(b.projection.tools.has('echo.once')).toBe(true);

    // Same `_tools` list
    expect(a.get('_tools')).toEqual(b.get('_tools'));

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
    expect(seq.projection.tools.has('greeting')).toBe(false);
  });

  test('bind(path, fn) on a non-fn schema falls through to the normal bind path', () => {
    // Edge case: binding a function to a non-fn-typed path. The
    // type check at the schema will reject or pass-through depending
    // on the schema's shape. What it MUST NOT do is register the
    // function as a tool — tools require an fn-typed schema.
    const seq = new Sequence();
    seq.mount('schema', 'weird', FT.string());
    seq.mount('bind', 'weird', (() => 'callable') as any);
    // No tool registration happened — the schema isn't fn-typed.
    expect(seq.projection.tools.has('weird')).toBe(false);
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
// Phase B — schema mount of fn-kind IS the tool declaration
// ═══════════════════════════════════════════════════════════════════════
//
// `tools` holds the declared-set of tools — type state,
// persistent, serialized, queried by cross-process coordination
// (PendingInvocation, planning, getTools). `implRegistry` is
// the process-local slice of those declarations that have cached
// local impls.
//
// Declaration and local-impl are different concerns. Before Phase B
// the only way to populate `tools` was via the `tool` mount op.
// That confused declaration with registration. Now a schema mount of
// fn-kind populates `tools` automatically — the schema IS the
// declaration. A subsequent bind provides the local impl.

describe('schema mount of fn-kind populates tools (Phase B)', () => {
  function mkFnSchema() {
    return createType('fn', [
      param(createType('object', [])),
      returns(createType('object', [])),
    ]);
  }

  test('schema mount with fn kind marks the path as a declared tool', () => {
    const seq = new Sequence();
    seq.mount('schema', 'fs.read', mkFnSchema());
    expect(seq.projection.tools.has('fs.read')).toBe(true);
    expect(seq.get('_tools')).toContain('fs.read');
  });

  test('schema mount with non-fn kind does NOT mark as tool', () => {
    const seq = new Sequence();
    seq.mount('schema', 'org.name', FT.string());
    expect(seq.projection.tools.has('org.name')).toBe(false);
    const tools = (seq.get('_tools') as string[] | undefined) ?? [];
    expect(tools).not.toContain('org.name');
  });

  test('declaration without local impl — the tool is declared but implRegistry is empty', () => {
    const seq = new Sequence();
    seq.mount('schema', 'external.api', mkFnSchema());
    // Declared
    expect(seq.projection.tools.has('external.api')).toBe(true);
    // But this process can't run it locally — no impl.
    expect((seq as any).implRegistry.has('external.api')).toBe(false);
  });

  test('declaration then bind fn — the local impl joins the existing declaration', () => {
    const seq = new Sequence();
    seq.mount('schema', 'math.square', mkFnSchema());
    expect(seq.projection.tools.has('math.square')).toBe(true);
    expect((seq as any).implRegistry.has('math.square')).toBe(false);

    seq.mount('bind', 'math.square', (input: any) => ({ value: input.value * input.value }));
    expect(seq.projection.tools.has('math.square')).toBe(true);
    expect((seq as any).implRegistry.has('math.square')).toBe(true);

    seq.mount('bind', 'math.square', { value: 7 });
    expect(seq.get('math.square.result')).toEqual({ value: 49 });
  });

  test('schema re-mount (idempotent) does not duplicate the _tools entry', () => {
    const seq = new Sequence();
    seq.mount('schema', 'do.it', mkFnSchema());
    seq.mount('schema', 'do.it', mkFnSchema());
    const tools = seq.get('_tools') as string[];
    const count = tools.filter(c => c === 'do.it').length;
    expect(count).toBe(1);
  });

  test('legacy `tool path true` and new `schema path fnType` produce the same declared-tool state', () => {
    const a = new Sequence();
    a.mount('schema', 'x', mkFnSchema());
    a.mount('tool', 'x', true);

    const b = new Sequence();
    b.mount('schema', 'x', mkFnSchema());
    // No tool mount — the schema alone declares the tool.

    expect(a.projection.tools.has('x')).toBe(true);
    expect(b.projection.tools.has('x')).toBe(true);
    expect(a.get('_tools')).toEqual(b.get('_tools'));
  });
});
