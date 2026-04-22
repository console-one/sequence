/**
 * env-loader.test.ts — `loadEnv` with impl-shim injection.
 *
 * Proves the env-kind boot pattern: `loadEnv` injects environment-
 * specific tool impls at declared paths via the `impls`
 * parameter, and user code invokes them transparently through the
 * kernel's value-bind-to-fn-schema path. This is the minimum
 * demonstration that a Unix / Docker / Lambda / browser env can
 * share a single loader and differ only in which impls they inject.
 */

import { loadEnv, createType, param, returns } from '../index';

/** Helper: mount a fn schema at a path so the impl there is invocable. */
function mountFnSchema(path: string): { op: 'schema'; path: string; value: any } {
  return {
    op: 'schema',
    path,
    value: createType('fn', [
      param(createType('object', [])),
      returns(createType('any', [])),
    ]),
  };
}

describe('loadEnv — impl-shim injection', () => {
  test('impls are mounted as tools at their declared paths', () => {
    // Mount fn schemas via entries; inject impls via the impls param.
    // The schemas are env-agnostic; only the impls differ between
    // Unix / Lambda / browser.
    const writes: Array<{ path: string; content: string }> = [];
    const reads: Record<string, string> = { '/etc/hostname': 'unix-box-1' };

    const seq = loadEnv(() => Date.now(), {
      entries: [
        mountFnSchema('fs.readFile'),
        mountFnSchema('fs.writeFile'),
        mountFnSchema('schedule.every'),
      ],
      impls: {
        'fs.readFile': (input: { path: string }) => reads[input.path] ?? '',
        'fs.writeFile': (input: { path: string; content: string }) => {
          writes.push({ path: input.path, content: input.content });
          return 'ok';
        },
        'schedule.every': (input: { ms: number }) => `sched_${input.ms}`,
      },
    });

    // Verify impls are registered as tools at their paths.
    expect(seq.projection.tools.has('fs.readFile')).toBe(true);
    expect(seq.projection.tools.has('fs.writeFile')).toBe(true);
    expect(seq.projection.tools.has('schedule.every')).toBe(true);

    // Invoke each tool by binding an input at its path — the kernel's
    // value-bind-to-fn-schema path runs the impl and mounts the
    // result at `{path}.result`.
    seq.mount('bind', 'fs.readFile', { path: '/etc/hostname' });
    expect(seq.get('fs.readFile.result')).toBe('unix-box-1');

    seq.mount('bind', 'fs.writeFile', { path: '/tmp/out', content: 'hello' });
    expect(writes).toEqual([{ path: '/tmp/out', content: 'hello' }]);

    seq.mount('bind', 'schedule.every', { ms: 1000 });
    expect(seq.get('schedule.every.result')).toBe('sched_1000');
  });

  test('replays persisted entries before mounting snapshots', () => {
    // A prior session's state comes back as entries; then snapshots
    // mount on top. This is how an env carries state across restarts:
    // persist the projection, replay as entries on next boot.
    const seq = loadEnv(() => Date.now(), {
      entries: [
        { op: 'bind', path: 'state.count', value: 7 },
        { op: 'bind', path: 'state.user', value: 'alice' },
      ],
    });

    expect(seq.get('state.count')).toBe(7);
    expect(seq.get('state.user')).toBe('alice');
  });

  test('loadEnv returns a plain Sequence — no wrapper type', () => {
    const seq = loadEnv(() => Date.now());
    // Direct kernel API available; no .seq indirection, no .stop(),
    // no .send(), no .render() wrapper.
    expect(typeof seq.mount).toBe('function');
    expect(typeof seq.get).toBe('function');
    expect(typeof seq.keys).toBe('function');
    expect(seq.head).toBe(0);
  });

  test('different impls at same schema paths produce different behavior', () => {
    // Simulates two env kinds (e.g., Unix vs Lambda) sharing the
    // same fn schema but injecting different impls. Tests the core
    // value proposition: one snapshot, many envs.
    const unixEnv = loadEnv(() => Date.now(), {
      entries: [mountFnSchema('http.get')],
      impls: {
        'http.get': (input: { url: string }) => `unix-response:${input.url}`,
      },
    });

    const lambdaEnv = loadEnv(() => Date.now(), {
      entries: [mountFnSchema('http.get')],
      impls: {
        'http.get': (input: { url: string }) => `lambda-response:${input.url}`,
      },
    });

    unixEnv.mount('bind', 'http.get', { url: '/api/user' });
    lambdaEnv.mount('bind', 'http.get', { url: '/api/user' });

    expect(unixEnv.get('http.get.result')).toBe('unix-response:/api/user');
    expect(lambdaEnv.get('http.get.result')).toBe('lambda-response:/api/user');
  });
});
