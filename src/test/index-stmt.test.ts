/**
 * index-stmt.test.ts — `index <anchor> { over v in set ... where cond ... body }`
 *
 * DSL surface for indexSpec-constrained schemas. Compiles to a single
 * `seq.mount('schema', anchor, createType('any', [indexSpec({...})]))`
 * and relies on the existing kernel cascade to fire the body per
 * tuple with `{var}` interpolation — zero new kernel work.
 */

import { receive } from '../dsl/walker';
import { Sequence } from '../sequence';

describe('index statement', () => {
  test('single binding: fires body per matching child', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      index _sessions.active {
        over user in sessions.*
        sessions.{user}.status = "active"
      }
    `, seq);

    seq.mount('bind', 'sessions.alice.heartbeat', 900);
    seq.mount('bind', 'sessions.bob.heartbeat', 950);

    expect(seq.get('sessions.alice.status')).toBe('active');
    expect(seq.get('sessions.bob.status')).toBe('active');
  });

  test('filter: only tuples passing the where clause fire', () => {
    const seq = new Sequence(() => 1000);

    // heartbeat > (_rt - 100) — fresh within last 100ms
    receive(`
      index _sessions.fresh {
        over user in sessions.*
        where sessions.{user}.heartbeat > _rt - 100
        sessions.{user}.status = "fresh"
      }
    `, seq);

    seq.mount('bind', 'sessions.alice.heartbeat', 950); // fresh (50ms old)
    seq.mount('bind', 'sessions.bob.heartbeat',   800); // stale (200ms old)

    expect(seq.get('sessions.alice.status')).toBe('fresh');
    expect(seq.get('sessions.bob.status')).toBeUndefined();
  });

  test('multiple bindings: tuple per matching combination', () => {
    const seq = new Sequence(() => 1000);

    // Label backlink index — parallels services/contextgraph/label-rules.ts.
    receive(`
      index _indexes.label_backlinks {
        over id in _blocks.*
        over seq in _blocks.{id}.*
        over label in _blocks.{id}.{seq}.label
        _labels.{label}.{id}.{seq} = true
      }
    `, seq);

    // Simulate labeled blocks landing.
    seq.mount('bind', '_blocks.local.1.label', 'bug');
    seq.mount('bind', '_blocks.local.2.label', 'feature');
    seq.mount('bind', '_blocks.peer.1.label', 'bug');

    expect(seq.get('_labels.bug.local.1')).toBe(true);
    expect(seq.get('_labels.feature.local.2')).toBe(true);
    expect(seq.get('_labels.bug.peer.1')).toBe(true);
  });

  test('where with comma-separated conditions: implicit AND', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      index _sessions.ready {
        over user in sessions.*
        where exists(sessions.{user}.heartbeat),
              exists(sessions.{user}.env)
        sessions.{user}.status = "ready"
      }
    `, seq);

    // alice has both — should fire
    seq.mount('bind', 'sessions.alice.heartbeat', 950);
    seq.mount('bind', 'sessions.alice.env', 'docker');
    // bob is missing env — should NOT fire
    seq.mount('bind', 'sessions.bob.heartbeat', 950);

    expect(seq.get('sessions.alice.status')).toBe('ready');
    expect(seq.get('sessions.bob.status')).toBeUndefined();
  });

  test('re-fires when binding space changes', () => {
    const seq = new Sequence(() => 1000);

    receive(`
      index _sessions.active {
        over user in sessions.*
        sessions.{user}.status = "active"
      }
    `, seq);

    seq.mount('bind', 'sessions.alice.heartbeat', 900);
    expect(seq.get('sessions.alice.status')).toBe('active');

    // Add a new session after the index is already mounted.
    seq.mount('bind', 'sessions.carol.heartbeat', 999);
    expect(seq.get('sessions.carol.status')).toBe('active');
  });
});
