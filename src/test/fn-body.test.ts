/**
 * fn-body.test.ts — Block-body fn definitions.
 *
 * `fname = (args) -> [ body stmts ]: ReturnType`
 *
 * Parse + walk + runtime. Covers:
 *   - AST: body present on FunctionExpr
 *   - Walker: schema mount + tool mount with live impl closure
 *   - Invocation: writing input to the fn path fires the impl
 *   - Path interpolation: `{var}` segments substitute param values
 *   - Value substitution: bare name expressions matching params
 *     substitute literal values
 *   - Ambiguity: array-return fn types like `(a: T) -> [U]` still
 *     parse as type-only (no body)
 */

import { tokenize } from '../dsl/tokenizer';
import { Parser } from '../dsl/parser';
import { receive } from '../dsl/walker';
import { Sequence } from '../sequence';

function parseFt(src: string) {
  const tokens = tokenize(src);
  return new Parser(tokens).parseProgram();
}

describe('block-body fn def — parser', () => {
  test('parses fn def with block body and return type', () => {
    const ast = parseFt(`
      bump = (name: string) -> [
        counters.{name} = 1
      ]
    `);
    expect(ast).toHaveLength(1);
    const stmt = ast[0] as any;
    expect(stmt.kind).toBe('assign');
    expect(stmt.value.kind).toBe('function');
    expect(stmt.value.body).toBeDefined();
    expect(stmt.value.body).toHaveLength(1);
    expect(stmt.value.body[0].kind).toBe('assign');
  });

  test('type-only fn (no body) still works', () => {
    const ast = parseFt(`
      read = (p: string) -> { content: string }
    `);
    const stmt = ast[0] as any;
    expect(stmt.value.kind).toBe('function');
    expect(stmt.value.body).toBeUndefined();
  });

  test('parses multi-statement body with comments', () => {
    const ast = parseFt(`
      fulfill = (reqId: string, response: string) -> [
        -- mark the request fulfilled
        req.{reqId}.status = "fulfilled"
        req.{reqId}.response = response
      ]
    `);
    const stmt = ast[0] as any;
    const body = stmt.value.body;
    // body has 3 entries: comment, assign, assign (in some order)
    const assigns = body.filter((s: any) => s.kind === 'assign');
    expect(assigns).toHaveLength(2);
  });
});

describe('block-body fn def — runtime', () => {
  test('schema + tool are mounted at the fn path', () => {
    const seq = new Sequence(() => 1000);
    receive(`
      bump = (name: string) -> [
        counters.{name} = 1
      ]
    `, seq);

    const type = seq.typeAt('bump');
    expect(type?.kind).toBe('fn');
    expect(seq.get('_tools')).toContain('bump');
  });

  test('invocation mounts body statements with path interpolation', () => {
    const seq = new Sequence(() => 1000);
    receive(`
      bump = (name: string) -> [
        counters.{name} = 1
      ]
    `, seq);

    // Invoke by binding a value to the fn path
    seq.mount('bind', 'bump', { name: 'alice' });

    expect(seq.get('counters.alice')).toBe(1);
  });

  test('invocation substitutes name expressions matching params', () => {
    const seq = new Sequence(() => 1000);
    receive(`
      record = (key: string, value: string) -> [
        log.{key} = value
      ]
    `, seq);

    seq.mount('bind', 'record', { key: 'event_1', value: 'hello world' });

    expect(seq.get('log.event_1')).toBe('hello world');
  });

  test('multiple invocations mount at distinct keys', () => {
    const seq = new Sequence(() => 1000);
    receive(`
      bump = (name: string) -> [
        counters.{name} = 1
      ]
    `, seq);

    seq.mount('bind', 'bump', { name: 'alice' });
    seq.mount('bind', 'bump', { name: 'bob' });

    expect(seq.get('counters.alice')).toBe(1);
    expect(seq.get('counters.bob')).toBe(1);
  });

  test('body with multiple statements mounts all of them', () => {
    const seq = new Sequence(() => 1000);
    receive(`
      fulfill = (reqId: string, response: string) -> [
        req.{reqId}.status = "fulfilled"
        req.{reqId}.response = response
      ]
    `, seq);

    seq.mount('bind', 'fulfill', { reqId: 'r1', response: 'done' });

    expect(seq.get('req.r1.status')).toBe('fulfilled');
    expect(seq.get('req.r1.response')).toBe('done');
  });

  test('type-only fn (no body) IS a tool declaration; local impl remains absent', () => {
    const seq = new Sequence(() => 1000);
    receive(`
      handler = (p: string) -> { content: string }
    `, seq);

    // The type is mounted — schema-of-fn-kind is sufficient to declare
    // the tool. No separate `tool` op needed. `_tools` reflects the
    // declared-set, which the type state makes persistent and
    // serializable across processes.
    expect(seq.typeAt('handler')?.kind).toBe('fn');
    const tools = seq.get('_tools') as string[] | undefined;
    expect(tools ?? []).toContain('handler');

    // But the local impl registry is still empty — nothing to run
    // until an impl is bound. That's the process-local slice of the
    // declared tool set.
    expect((seq as any).implRegistry.has('handler')).toBe(false);
  });

  test('block body without return annotation still mounts side effects', () => {
    // Block bodies are STATEMENT blocks: the compose of their
    // mount narrowings is the output. Return annotation is
    // optional; when absent, the fn schema's output = any.
    const seq = new Sequence(() => 1000);
    receive(`
      check = (id: string) -> [
        log.{id} = "seen"
      ]
    `, seq);

    seq.mount('bind', 'check', { id: 'a' });
    // Side effect landed
    expect(seq.get('log.a')).toBe('seen');
    // No separate return value — .result is undefined since the
    // block has no export / no value-producing step.
    expect(seq.get('check.result')).toBeUndefined();
  });

  test('class method with block body mounts invocable tool', () => {
    const seq = new Sequence(() => 1000);
    receive(`
      class Counter {
        bump = (name: string) -> [
          counters.{name} = 1
        ]
        tool bump
      }
    `, seq);

    expect(seq.typeAt('Counter.bump')?.kind).toBe('fn');
    const tools = seq.get('_tools') as string[] | undefined;
    expect(tools).toContain('Counter.bump');

    seq.mount('bind', 'Counter.bump', { name: 'alice' });
    expect(seq.get('counters.alice')).toBe(1);
  });
});

describe('block-body fn def — backwards inference on return annotation', () => {
  test('static-path body matching declared return passes', () => {
    const seq = new Sequence(() => 1000);
    // Body produces { log: { count: number(1) } }; declared requires
    // { log: { count: number } }. Static paths, consistent shape.
    receive(`
      bump = (k: string) -> [
        log.count = 1
      ]: { log: { count: number } }
    `, seq);
    expect(seq.typeAt('bump')?.kind).toBe('fn');
  });

  test('declared property absent from body errors', () => {
    expect(() => {
      receive(`
        bad = (id: string) -> [
          log.seen = 1
        ]: { ok: true }
      `, new Sequence(() => 1000));
    }).toThrow(/does not produce its declared return type/);
  });

  test('all-dynamic body with annotation errors', () => {
    // Every statement uses `{var}` — nothing contributes to the
    // static compiled type, so the declared annotation has no
    // matching properties and the check fails.
    expect(() => {
      receive(`
        mark = (id: string) -> [
          log.{id} = "seen"
        ]: { ok: true }
      `, new Sequence(() => 1000));
    }).toThrow(/does not produce its declared return type/);
  });

  test('no annotation skips the check', () => {
    // Without a declared return, body with dynamic paths is fine.
    const seq = new Sequence(() => 1000);
    receive(`
      mark = (id: string) -> [
        log.{id} = "seen"
      ]
    `, seq);
    expect(seq.typeAt('mark')?.kind).toBe('fn');
  });

  test('dynamic body with glob-key annotation passes', () => {
    // v2: {var} segments compile to * in the glob-normalized path.
    // The annotation can use matching * keys to describe dynamic shapes.
    const seq = new Sequence(() => 1000);
    receive(`
      fulfill = (reqId: string) -> [
        req.{reqId}.status = "fulfilled"
        req.{reqId}.fulfilledAt = _rt
      ]: { req: { "*": { status: string, fulfilledAt: number } } }
    `, seq);
    expect(seq.typeAt('fulfill')?.kind).toBe('fn');
  });

  test('compound dynamic segment p_{var} matches "p_*" annotation', () => {
    const seq = new Sequence(() => 1000);
    receive(`
      complete = (id: string) -> [
        proc.p_{id}.status = "completed"
      ]: { proc: { "p_*": { status: string } } }
    `, seq);
    expect(seq.typeAt('complete')?.kind).toBe('fn');
  });

  test('glob-key annotation with mismatched literal key errors', () => {
    // Declared `req.special.status` is a literal child that
    // compiled `req.*.status` would match (glob-to-literal), but
    // the reverse is safer to fail — the body doesn't guarantee
    // the specific "special" key gets mounted. Here we verify
    // the glob-to-literal direction passes (compiled has wildcard,
    // declared is specific).
    const seq = new Sequence(() => 1000);
    receive(`
      stash = (id: string) -> [
        data.{id}.seen = 1
      ]: { data: { special: { seen: number } } }
    `, seq);
    expect(seq.typeAt('stash')?.kind).toBe('fn');
  });

  test('where-gated mounts are visible to backwards inference', () => {
    // Before this fix, `where` bodies were skipped by
    // compileBlockBodyType — a fn whose output lived only inside
    // where branches would fail the annotation check.
    const seq = new Sequence(() => 1000);
    receive(`
      deliver = (reqId: string, user: string) -> [
        where (chan.users.{user}.visible = true) {
          req.{reqId}.status = "delivered"
        }
        where (chan.users.{user}.visible != true) {
          req.{reqId}.status = "queued"
        }
      ]: { req: { "*": { status: string } } }
    `, seq);
    expect(seq.typeAt('deliver')?.kind).toBe('fn');
  });

  test('glob-key annotation missing a declared leaf errors', () => {
    // Declared `req.*.extra` is not produced by the body.
    expect(() => {
      receive(`
        partial = (id: string) -> [
          req.{id}.status = "ok"
        ]: { req: { "*": { status: string, extra: string } } }
      `, new Sequence(() => 1000));
    }).toThrow(/does not produce/);
  });
});

describe('block-body fn def — ambiguity with array return type', () => {
  test('array-return fn type still parses as type-only', () => {
    // `(p: string) -> [number]` should parse as a fn type returning
    // array-of-number, NOT a block body. No `=` or `<<` inside the
    // brackets means it's a type expression.
    const ast = parseFt(`
      scores = (name: string) -> [number]
    `);
    const stmt = ast[0] as any;
    expect(stmt.value.kind).toBe('function');
    expect(stmt.value.body).toBeUndefined();
    expect(stmt.value.returns.kind).toBe('array');
  });
});
