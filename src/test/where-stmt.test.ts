/**
 * where-stmt.test.ts — `where (conds) { stmts }` conditional scope gate.
 *
 * `where` is a scope-gate statement form: evaluate conditions at walk
 * time; if every condition passes, walk the body. No iteration, no
 * new bindings. Condition paths reference visible scope (fn params
 * inside a block-body fn def, or absolute sequence paths at top
 * level).
 *
 * This fixes the broken form `.where(chan.users.{user}.visible = ...)`
 * by giving `{user}` a visible binding: the fn's declared `user`
 * param. The substitution runs BEFORE the walker evaluates the
 * condition, so the walker only ever sees concrete absolute paths.
 */

import { receive } from '../dsl/walker';
import { Sequence } from '../sequence';

describe('where statement — top-level scope gate', () => {
  test('where body runs when condition is true', () => {
    const seq = new Sequence(() => 1000);
    seq.mount('bind', 'config.enabled', true);

    receive(`
      where (config.enabled = true) {
        log.ran = 1
      }
    `, seq);

    expect(seq.get('log.ran')).toBe(1);
  });

  test('where body is skipped when condition is false', () => {
    const seq = new Sequence(() => 1000);
    seq.mount('bind', 'config.enabled', false);

    receive(`
      where (config.enabled = true) {
        log.ran = 1
      }
    `, seq);

    expect(seq.get('log.ran')).toBeUndefined();
  });

  test('multi-condition where uses implicit AND', () => {
    const seq = new Sequence(() => 1000);
    seq.mount('bind', 'config.enabled', true);
    seq.mount('bind', 'state.ready', true);

    receive(`
      where (config.enabled = true, state.ready = true) {
        log.ran = 1
      }
    `, seq);

    expect(seq.get('log.ran')).toBe(1);

    // Disabling either clause skips the body.
    const seq2 = new Sequence(() => 1000);
    seq2.mount('bind', 'config.enabled', true);
    seq2.mount('bind', 'state.ready', false);

    receive(`
      where (config.enabled = true, state.ready = true) {
        log.ran = 1
      }
    `, seq2);

    expect(seq2.get('log.ran')).toBeUndefined();
  });

  test('exists condition in where', () => {
    const seq = new Sequence(() => 1000);
    seq.mount('bind', 'state.x.value', 42);

    receive(`
      where (state.x.value exists) {
        log.observed = 1
      }
    `, seq);

    expect(seq.get('log.observed')).toBe(1);

    // No path → no body run.
    const seq2 = new Sequence(() => 1000);
    receive(`
      where (state.x.value exists) {
        log.observed = 1
      }
    `, seq2);
    expect(seq2.get('log.observed')).toBeUndefined();
  });
});

describe('where statement — inside block-body fn def', () => {
  test('condition references fn params via {var} interpolation', () => {
    const seq = new Sequence(() => 1000);

    // `user` is the fn's declared param. `{user}` in the where's
    // condition path is substituted to the param value before the
    // walker evaluates it.
    receive(`
      deliver = (reqId: string, user: string) -> [
        where (chan.users.{user}.visible = true) {
          req.{reqId}.status = "delivered"
        }
        where (chan.users.{user}.visible != true) {
          req.{reqId}.status = "queued"
        }
      ]
    `, seq);

    seq.mount('bind', 'chan.users.alice.visible', true);
    seq.mount('bind', 'chan.users.bob.visible', false);

    // alice has a visible channel → delivered
    seq.mount('bind', 'deliver', { reqId: 'r1', user: 'alice' });
    expect(seq.get('req.r1.status')).toBe('delivered');

    // bob does not → queued
    seq.mount('bind', 'deliver', { reqId: 'r2', user: 'bob' });
    expect(seq.get('req.r2.status')).toBe('queued');
  });

  test('two mutually exclusive where blocks implement branching', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      classify = (id: string, score: number) -> [
        where (score >= 50) {
          results.{id} = "pass"
        }
        where (score < 50) {
          results.{id} = "fail"
        }
      ]
    `, seq);

    seq.mount('bind', 'classify', { id: 'a', score: 80 });
    seq.mount('bind', 'classify', { id: 'b', score: 30 });

    expect(seq.get('results.a')).toBe('pass');
    expect(seq.get('results.b')).toBe('fail');
  });

  test('where body can contain nested project', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      mark = (id: string) -> [
        log.{id} = "marked"
      ]

      runIfEnabled = (flag: string) -> [
        where (config.{flag} = true) {
          ...project(r in items.{id}, mark)
        }
      ]
    `, seq);

    seq.mount('bind', 'items.a', { value: 1 });
    seq.mount('bind', 'items.b', { value: 2 });
    seq.mount('bind', 'config.live', true);
    seq.mount('bind', 'config.debug', false);

    // live flag → both items marked
    seq.mount('bind', 'runIfEnabled', { flag: 'live' });
    expect(seq.get('log.a')).toBe('marked');
    expect(seq.get('log.b')).toBe('marked');

    // debug flag → no items marked (body gated out)
    const seq2 = new Sequence(() => 1000);
    receive(`
      mark = (id: string) -> [
        log.{id} = "marked"
      ]

      runIfEnabled = (flag: string) -> [
        where (config.{flag} = true) {
          ...project(r in items.{id}, mark)
        }
      ]
    `, seq2);
    seq2.mount('bind', 'items.a', { value: 1 });
    seq2.mount('bind', 'config.debug', false);
    seq2.mount('bind', 'runIfEnabled', { flag: 'debug' });
    expect(seq2.get('log.a')).toBeUndefined();
  });

  test('where is skipped when condition references unset path', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      tryWrite = (key: string) -> [
        where (flags.{key} = true) {
          log.{key} = "ran"
        }
      ]
    `, seq);

    // No flag mounted → condition false → body skipped
    seq.mount('bind', 'tryWrite', { key: 'x' });
    expect(seq.get('log.x')).toBeUndefined();

    // Flag mounted → condition true → body runs
    seq.mount('bind', 'flags.x', true);
    seq.mount('bind', 'tryWrite', { key: 'x' });
    expect(seq.get('log.x')).toBe('ran');
  });
});
