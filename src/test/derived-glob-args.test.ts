/**
 * derived-glob-args.test.ts — Commit 6.
 *
 * Derived constraints can now take glob argPaths like `tasks.urgent.*`.
 * When any descendant changes, the cascade walks ancestor-glob matches
 * and fires the derived fn with (triggerPath, triggerValue, ...exact-arg-values).
 *
 * This is the primitive that makes readers expressible as derived rules —
 * no new BackwardEntry kind, no registerReader API, just mount.
 */

import { Sequence } from '../sequence';
import { FT } from '../builder';

describe('derived with glob argPaths (Commit 6)', () => {
  // ─── Plain glob-arg cascade ────────────────────────────────────
  test('glob arg fires cascade when any descendant changes', () => {
    const seq = new Sequence(() => 1000);
    const events: Array<{ path: string; value: unknown }> = [];

    // Register a tool that records each fire.
    seq.mount('tool', 'record', (triggerPath: string, triggerValue: unknown) => {
      events.push({ path: triggerPath, value: triggerValue });
      return `${triggerPath}=${triggerValue}`;
    });

    // Derived schema with a glob arg.
    seq.mount('schema', 'observer.emission', FT.derived('record', 'tasks.urgent.*'));

    // Initial state — no fires yet.
    expect(events).toEqual([]);

    // Write a path under the glob — cascade fires once.
    seq.mount('bind', 'tasks.urgent.deploy.status', 'pending');
    expect(events).toEqual([
      { path: 'tasks.urgent.deploy.status', value: 'pending' },
    ]);

    // Write another path under the glob — cascade fires again.
    seq.mount('bind', 'tasks.urgent.deploy.assignee', 'alice');
    expect(events.length).toBe(2);
    expect(events[1]).toEqual({ path: 'tasks.urgent.deploy.assignee', value: 'alice' });

    // Write a path OUTSIDE the glob — no fire.
    const prevLen = events.length;
    seq.mount('bind', 'tasks.normal.deploy.status', 'pending');
    expect(events.length).toBe(prevLen);
  });

  test('derived fn output is stored at the target path', () => {
    const seq = new Sequence(() => 2000);

    seq.mount('tool', 'latestLine', (triggerPath: string, triggerValue: unknown) => {
      return `${triggerPath} = ${JSON.stringify(triggerValue)}`;
    });
    seq.mount('schema', 'emission.latest', FT.derived('latestLine', 'log.*'));

    seq.mount('bind', 'log.entry1', 'hello');
    expect(seq.get('emission.latest')).toBe('log.entry1 = "hello"');

    seq.mount('bind', 'log.entry2', 42);
    expect(seq.get('emission.latest')).toBe('log.entry2 = 42');
  });

  test('glob arg with additional exact args combines trigger + context', () => {
    const seq = new Sequence(() => 3000);

    // fn takes (triggerPath, triggerValue, contextVal)
    seq.mount('tool', 'combined', (triggerPath: string, triggerValue: unknown, ctx: unknown) => {
      return `[${ctx}] ${triggerPath} = ${triggerValue}`;
    });

    seq.mount('bind', 'meta.prefix', 'URGENT');
    seq.mount('schema', 'emission.tagged', FT.derived('combined', 'alerts.*', 'meta.prefix'));

    seq.mount('bind', 'alerts.fire.level', 'critical');
    expect(seq.get('emission.tagged')).toBe('[URGENT] alerts.fire.level = critical');
  });

  // ─── Reader-shaped use: emissions land at _readers.{name}.emission ─
  test('reader expressed as a derived rule with glob scope (no new primitive)', () => {
    const seq = new Sequence(() => 4000);
    const emitted: string[] = [];

    // The "sink" is a tool that records the emission.
    // In server.ts this would send over a WebSocket; the kernel doesn't
    // know about transport — it just binds the emission at the target path.
    seq.mount('tool', 'formatEmission', (triggerPath: string, triggerValue: unknown) => {
      const line = `${triggerPath} = ${JSON.stringify(triggerValue)}`;
      emitted.push(line);
      return line;
    });

    // Register "alice's reader" — a derived rule whose target is
    // _readers.alice.emission and whose glob arg is the scope.
    seq.mount('schema', '_readers.alice.emission',
      FT.derived('formatEmission', 'tasks.urgent.*'));

    // Register "bob's reader" with a different scope.
    seq.mount('schema', '_readers.bob.emission',
      FT.derived('formatEmission', 'tasks.normal.*'));

    // Change a path in alice's scope.
    seq.mount('bind', 'tasks.urgent.deploy.status', 'active');
    expect(emitted).toContain('tasks.urgent.deploy.status = "active"');
    expect(seq.get('_readers.alice.emission')).toBe('tasks.urgent.deploy.status = "active"');

    // Change a path in bob's scope — alice shouldn't see it.
    const emittedBefore = [...emitted];
    seq.mount('bind', 'tasks.normal.feature.status', 'pending');
    // Bob's emission fires
    expect(seq.get('_readers.bob.emission')).toBe('tasks.normal.feature.status = "pending"');
    // Alice's emission is unchanged
    expect(seq.get('_readers.alice.emission')).toBe('tasks.urgent.deploy.status = "active"');
    // The NEW emissions list contains only bob's fire
    const newEmissions = emitted.slice(emittedBefore.length);
    expect(newEmissions).toEqual(['tasks.normal.feature.status = "pending"']);
  });
});
