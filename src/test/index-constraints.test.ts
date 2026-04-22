/**
 * index-constraints.test.ts — class-level tuple projection.
 *
 * Proves the index-constraint primitive (generalization of key())
 * that lets a class's where clause project into a tuple space and
 * fire its constructor body once per tuple, with runtime path
 * interpolation from the tuple bindings. This is the building
 * block the contextgraph tick phases and most spec workflows
 * need to stop being TypeScript.
 */

import { Sequence } from '../sequence';
import { createType, indexSpec, bindFrom, eq } from '../type';

describe('index constraints — one binding', () => {
  test('fires constructor once per key in glob when mounted AFTER inputs', () => {
    const seq = new Sequence();
    // Inputs first: two policies exist.
    seq.mount('bind', '_policies.p1', { triggerValue: 'open' });
    seq.mount('bind', '_policies.p2', { triggerValue: 'closed' });

    // Index-constrained class: bind $policy from _policies.*,
    // body writes a derived path per policy.
    seq.mount('schema', 'Promotion', createType('any', [
      indexSpec({
        indexedBy: ['policy'],
        where: [bindFrom('policy', '_policies.*')],
        body: [
          { op: 'bind', path: 'reqs.{policy}.status', value: 'open' },
        ],
      }),
    ]));

    // Expect both policies produced a req entry.
    expect(seq.get('reqs.p1.status')).toBe('open');
    expect(seq.get('reqs.p2.status')).toBe('open');
  });

  test('fires constructor for late-arriving inputs (cascade via end-of-mount pass)', () => {
    const seq = new Sequence();
    // Class mounted first: no policies yet, nothing fires.
    seq.mount('schema', 'Promotion', createType('any', [
      indexSpec({
        indexedBy: ['policy'],
        where: [bindFrom('policy', '_policies.*')],
        body: [
          { op: 'bind', path: 'reqs.{policy}.status', value: 'open' },
        ],
      }),
    ]));
    expect(seq.get('reqs.p1.status')).toBeUndefined();

    // Policies added later — end-of-mount index pass catches them.
    seq.mount('bind', '_policies.p1', { triggerValue: 'open' });
    expect(seq.get('reqs.p1.status')).toBe('open');

    seq.mount('bind', '_policies.p2', { triggerValue: 'closed' });
    expect(seq.get('reqs.p2.status')).toBe('open');
  });

  test('zero tuples when binding space is empty', () => {
    const seq = new Sequence();
    seq.mount('schema', 'Promotion', createType('any', [
      indexSpec({
        indexedBy: ['policy'],
        where: [bindFrom('policy', '_policies.*')],
        body: [
          { op: 'bind', path: 'reqs.{policy}.status', value: 'open' },
        ],
      }),
    ]));
    // No inputs, no reqs.
    expect(seq.keys('reqs')).toEqual([]);
  });

  test('body interpolates the same variable in multiple entries', () => {
    const seq = new Sequence();
    seq.mount('bind', '_policies.p1', { triggerValue: 'open' });

    seq.mount('schema', 'Promotion', createType('any', [
      indexSpec({
        indexedBy: ['policy'],
        where: [bindFrom('policy', '_policies.*')],
        body: [
          { op: 'bind', path: 'reqs.{policy}.status', value: 'open' },
          { op: 'bind', path: 'reqs.{policy}.source', value: '{policy}' },
        ],
      }),
    ]));

    expect(seq.get('reqs.p1.status')).toBe('open');
    expect(seq.get('reqs.p1.source')).toBe('p1');
  });
});

describe('index constraints — filter predicates', () => {
  test('filter excludes tuples that do not satisfy a predicate', () => {
    const seq = new Sequence();
    // Flat-path mounts so get('_policies.p1.triggerValue') returns
    // the field directly. Objects mounted at a single path are
    // stored as one value — they do not auto-expand into child
    // paths, which is why the filter must use flat paths.
    seq.mount('bind', '_policies.p1.triggerValue', 'open');
    seq.mount('bind', '_policies.p2.triggerValue', 'closed');

    // Only fire for policies whose triggerValue == 'open'.
    seq.mount('schema', 'Promotion', createType('any', [
      indexSpec({
        indexedBy: ['policy'],
        where: [
          bindFrom('policy', '_policies.*'),
          eq('_policies.$policy.triggerValue', 'open'),
        ],
        body: [
          { op: 'bind', path: 'reqs.{policy}.status', value: 'firing' },
        ],
      }),
    ]));

    expect(seq.get('reqs.p1.status')).toBe('firing');
    expect(seq.get('reqs.p2.status')).toBeUndefined();
  });
});

describe('index constraints — two bindings (Cartesian product)', () => {
  test('fires one tuple per (var1, var2) combination', () => {
    const seq = new Sequence();
    seq.mount('bind', 'users.alice', { role: 'admin' });
    seq.mount('bind', 'users.bob', { role: 'user' });
    seq.mount('bind', 'envs.dev', { region: 'us' });
    seq.mount('bind', 'envs.prod', { region: 'eu' });

    seq.mount('schema', 'AccessGrant', createType('any', [
      indexSpec({
        indexedBy: ['user', 'env'],
        where: [
          bindFrom('user', 'users.*'),
          bindFrom('env', 'envs.*'),
        ],
        body: [
          { op: 'bind', path: 'grants.{user}.{env}.active', value: true },
        ],
      }),
    ]));

    expect(seq.get('grants.alice.dev.active')).toBe(true);
    expect(seq.get('grants.alice.prod.active')).toBe(true);
    expect(seq.get('grants.bob.dev.active')).toBe(true);
    expect(seq.get('grants.bob.prod.active')).toBe(true);
  });
});


describe('index constraints — cascade from nested body mount', () => {
  test('derived tool cascades all the way through — deliver→claim pattern', async () => {
    const { Sequence } = await import('../sequence');
    const { createType } = await import('../type');

    const seq = new Sequence();

    // The claiming tool fires when req.* changes. It checks for
    // status=delivered and transitions to claimed. Mimics the
    // contextgraph claiming derived tool.
    seq.mount('tool', 'claimingFn', (triggerPath: string, _value: unknown) => {
      // Iterate reqs, find any with status=delivered, set claimed.
      const rks = seq.keys('req');
      for (const rk of rks) {
        const status = seq.get(`req.${rk}.status`);
        if (status !== 'delivered') continue;
        seq.mount('bind', `req.${rk}.status`, 'claimed');
      }
      return null;
    });
    seq.mount('schema', '_claim._target', createType('any', [{
      op: 'derived',
      args: ['claimingFn', 'req.*'],
    }]));

    // Deliver index class: fires when req has visible channel.
    seq.mount('schema', 'Deliver', createType('any', [{
      op: 'index_spec',
      args: [{
        indexedBy: ['req', 'channel'],
        where: [
          { op: 'bind_from', args: ['req', 'req.*'] },
          { op: 'eq', args: ['req.{req}.status', 'open'] },
          { op: 'bind_from', args: ['channel', 'chan.*'] },
          { op: 'eq', args: ['chan.{channel}.visible', true] },
        ],
        body: [
          { op: 'bind', path: 'req.{req}.status', value: 'delivered' },
        ],
      }],
    }]));

    // Set up: a visible channel, an open req.
    seq.mount('bind', 'chan.desktop.visible', true);
    seq.mount('bind', 'req.r1.status', 'open');

    // Expect: Deliver fired (status=delivered), then the cascade
    // fired claimingFn (status=claimed).
    expect(seq.get('req.r1.status')).toBe('claimed');
  });

  test('derived tool fires after an index-class body mounts a watched path', async () => {
    const { Sequence } = await import('../sequence');
    const { createType } = await import('../type');

    const seq = new Sequence();
    const derivedFires: string[] = [];

    // A simple derived tool that records its invocations. Registered
    // at `_watcher._target` with a derived constraint that watches
    // `state.*` — it should fire when state.* changes.
    seq.mount('tool', 'recordChange', (triggerPath: string, value: unknown) => {
      derivedFires.push(`${triggerPath}=${value}`);
      return null;
    });
    seq.mount('schema', '_watcher._target', createType('any', [{
      op: 'derived',
      args: ['recordChange', 'state.*'],
    }]));

    // Direct mount — cascade should fire the derived tool.
    seq.mount('bind', 'state.foo', 1);
    expect(derivedFires).toContain('state.foo=1');

    // Now an index class that mounts `state.bar = 2` via a body
    // entry. This nested mount happens inside runIndexConstraints
    // at the END of mount(), AFTER the outer mount's fireLaws pass.
    // The nested mount has its own fireLaws pass — the derived tool
    // should still fire.
    derivedFires.length = 0;
    seq.mount('schema', 'Trigger', createType('any', [{
      op: 'index_spec',
      args: [{
        indexedBy: ['k'],
        where: [{ op: 'bind_from', args: ['k', 'inputs.*'] }],
        body: [
          { op: 'bind', path: 'state.bar', value: 2 },
        ],
      }],
    }]));

    // Add an input so the class fires.
    seq.mount('bind', 'inputs.a', 'ready');

    // Verify the body mounted state.bar=2, and the derived tool
    // fired for that change (the cascade should reach it from the
    // nested mount inside runIndexConstraints).
    expect(seq.get('state.bar')).toBe(2);
    expect(derivedFires).toContain('state.bar=2');
  });
});

describe('labeled while clauses', () => {
  test('mount stores label at _blocks.{identity}.{seq}.label when provided', () => {
    const seq = new Sequence();
    const result = seq.mount('bind', 'doc.content', 'hello', { label: 'contract-X' });
    expect(result.ok).toBe(true);
    expect(seq.get(`_blocks.${seq.identity}.${result.blockSeq}.label`)).toBe('contract-X');
  });

  test('unlabeled mounts do not write a label value', () => {
    const seq = new Sequence();
    const result = seq.mount('bind', 'doc.content', 'hello');
    expect(seq.get(`_blocks.${seq.identity}.${result.blockSeq}.label`)).toBeUndefined();
  });
});
