/**
 * commitments.test.ts — Phase 1 coverage for the commitment primitive.
 *
 * Asserts the eight-field record schema, write-lease enforcement via
 * producedBy, status transitions, observation helpers (commitments,
 * openCommitments, readCommitment), and the convention path.
 *
 * No fn-kind retirement, session-rules collapse, or _callstack reader
 * yet — those are Phase 2-4 in specs/docs/COMMITMENTS.md.
 */

import { Sequence } from '../sequence';
import {
  COMMITMENT_PREFIX,
  installCommitmentSchema,
  electCommitment,
  fulfillCommitment,
  revokeCommitment,
  violateCommitment,
  readCommitment,
  commitments,
  openCommitments,
} from '../commitments';

describe('commitments — Phase 1 convention', () => {
  test('installCommitmentSchema mounts the record schema at _commitments.*', () => {
    const seq = new Sequence();
    installCommitmentSchema(seq);
    const schema = seq.typeAt(`${COMMITMENT_PREFIX}.*`);
    expect(schema?.kind).toBe('object');
    const propNames = (schema?.constraints ?? [])
      .filter(c => c.op === 'property')
      .map(c => c.args[0]);
    expect(propNames).toEqual(expect.arrayContaining([
      'typeRef', 'holder', 'deadline', 'distribution',
      'contingencies', 'head', 'control', 'status',
    ]));
  });

  test('electCommitment mounts a record with status=pending and the supplied fields', () => {
    const seq = new Sequence();
    const handle = electCommitment(seq, {
      id: 'task1',
      typeRef: 'classes.TaskOutcome',
      holder: 'id.agents.builder',
      deadline: 1_000_000,
      contingencies: ['inputs.foo', 'inputs.bar'],
      head: 'tasks.task1.outcome',
    });
    expect(handle.id).toBe('task1');
    expect(handle.recordPath).toBe(`${COMMITMENT_PREFIX}.task1`);
    expect(handle.head).toBe('tasks.task1.outcome');
    expect(handle.control).toBe(`${COMMITMENT_PREFIX}.task1.control`);

    const r = readCommitment(seq, 'task1');
    expect(r).toBeDefined();
    expect(r?.typeRef).toBe('classes.TaskOutcome');
    expect(r?.holder).toBe('id.agents.builder');
    expect(r?.deadline).toBe(1_000_000);
    expect(r?.contingencies).toEqual(['inputs.foo', 'inputs.bar']);
    expect(r?.head).toBe('tasks.task1.outcome');
    expect(r?.status).toBe('pending');
  });

  test('electCommitment without explicit head defaults to record_path.head', () => {
    const seq = new Sequence();
    const { head } = electCommitment(seq, {
      id: 'c1',
      typeRef: 'classes.Foo',
    });
    expect(head).toBe(`${COMMITMENT_PREFIX}.c1.head`);
  });

  test('fulfillCommitment writes the final value to the head and flips status', () => {
    const seq = new Sequence();
    const handle = electCommitment(seq, {
      id: 'task2',
      typeRef: 'classes.SumOutcome',
      head: 'tasks.task2.outcome',
    });
    fulfillCommitment(seq, 'task2', { sum: 42 });
    expect(seq.get('tasks.task2.outcome')).toEqual({ sum: 42 });
    expect(readCommitment(seq, 'task2')?.status).toBe('fulfilled');
  });

  test('revokeCommitment writes cancel to control and flips status', () => {
    const seq = new Sequence();
    const handle = electCommitment(seq, {
      id: 'task3',
      typeRef: 'classes.Cancellable',
    });
    revokeCommitment(seq, 'task3', 'user requested');
    expect(seq.get(`${handle.control}`)).toBe('cancel');
    const r = readCommitment(seq, 'task3');
    expect(r?.status).toBe('revoked');
    expect(seq.get(`${handle.recordPath}.revokeReason`)).toBe('user requested');
  });

  test('violateCommitment flips status with optional reason', () => {
    const seq = new Sequence();
    electCommitment(seq, {
      id: 'task4',
      typeRef: 'classes.Lateable',
      deadline: 1,
    });
    violateCommitment(seq, 'task4', 'deadline elapsed at _rt=2');
    expect(readCommitment(seq, 'task4')?.status).toBe('violated');
  });

  test('commitments() enumerates every record; status filter narrows', () => {
    const seq = new Sequence();
    electCommitment(seq, { id: 'a', typeRef: 'classes.A' });
    electCommitment(seq, { id: 'b', typeRef: 'classes.B' });
    electCommitment(seq, { id: 'c', typeRef: 'classes.C' });
    fulfillCommitment(seq, 'b');
    revokeCommitment(seq, 'c');

    const all = commitments(seq);
    expect(all.map(c => c.id).sort()).toEqual(['a', 'b', 'c']);

    const open = openCommitments(seq);
    expect(open.map(c => c.id)).toEqual(['a']);

    const fulfilled = commitments(seq, 'fulfilled');
    expect(fulfilled.map(c => c.id)).toEqual(['b']);

    const revoked = commitments(seq, 'revoked');
    expect(revoked.map(c => c.id)).toEqual(['c']);
  });

  test('open commitments are the call stack — query reads the substrate, no observability plane', () => {
    const seq = new Sequence();
    // Simulate three nested calls outstanding
    electCommitment(seq, { id: 'parent', typeRef: 'classes.Parent', head: 'parent.outcome' });
    electCommitment(seq, { id: 'child1', typeRef: 'classes.Child', head: 'parent.children.c1', contingencies: ['parent.inputs.x'] });
    electCommitment(seq, { id: 'child2', typeRef: 'classes.Child', head: 'parent.children.c2', contingencies: ['parent.inputs.y'] });

    const stack = openCommitments(seq);
    expect(stack).toHaveLength(3);

    // Stack frames are queryable via ordinary type-state — no separate
    // observability API. The contingency graph relates frames.
    const child1 = stack.find(c => c.id === 'child1');
    expect(child1?.contingencies).toEqual(['parent.inputs.x']);
  });

  test('holder grants write-lease via producedBy on the head path', () => {
    const seq = new Sequence();
    // Establish two distinct authors. The cascade carries the author
    // through default mount opts; in real use, the WebSocket connection
    // tags incoming blocks with their session id.
    electCommitment(seq, {
      id: 'task5',
      typeRef: 'classes.Restricted',
      holder: 'id.alice',
      head: 'tasks.task5.outcome',
    });

    // The head schema now has a producedBy(id.alice) constraint —
    // verify it landed.
    const headSchema = seq.typeAt('tasks.task5.outcome');
    const hasProducedBy = headSchema?.constraints.some(
      c => c.op === 'producedBy' && c.args[0] === 'id.alice'
    );
    expect(hasProducedBy).toBe(true);
  });

  test('readCommitment returns undefined when the id does not exist', () => {
    const seq = new Sequence();
    expect(readCommitment(seq, 'nonexistent')).toBeUndefined();
  });

  test('terminal status does not transition further (caller-side discipline; substrate accepts)', () => {
    // Phase 1 does not enforce monotonic status transitions in the
    // kernel — that's a Phase 3 cascade rule. This test documents the
    // expected eventual semantics: terminal statuses are stable. For
    // now, the substrate accepts re-mounts; downstream rules that
    // observe status should treat fulfilled / violated / revoked as
    // sticky.
    const seq = new Sequence();
    electCommitment(seq, { id: 'task6', typeRef: 'classes.Foo' });
    fulfillCommitment(seq, 'task6');
    expect(readCommitment(seq, 'task6')?.status).toBe('fulfilled');

    // Until Phase 3, the substrate doesn't reject this — it just
    // overwrites. Documented gap.
    revokeCommitment(seq, 'task6');
    expect(readCommitment(seq, 'task6')?.status).toBe('revoked');
  });
});
