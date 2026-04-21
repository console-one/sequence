/**
 * taskqueue.test.ts — Realizes the labelledtaskqueue.md spec as a
 * concrete class, with one test per acceptance criterion.
 *
 * This is the first spec→implementation bridge in the repo. The
 * corresponding .ft class is at packages/stdlib/taskqueue.ft.
 *
 * Each test names the AC it covers, so spec ↔ test traceability is
 * visible. Failed or skipped ACs are explicit, not hidden.
 */

import { Sequence } from '../sequence';
import { receive } from '../dsl/walker';
import { readFileSync } from 'fs';
import { join } from 'path';

const STDLIB = join(__dirname, '..', '..', 'stdlib');
const taskqueueFt = readFileSync(join(STDLIB, 'taskqueue.ft'), 'utf-8');

function bootQueue(): Sequence {
  const seq = new Sequence(() => Date.now());
  receive(taskqueueFt, seq);
  return seq;
}

describe('labelledtaskqueue spec — class realization', () => {

  // ─────────────────────────────────────────────────────────────
  // AC1 [R3]: well-formed task → status "pending" immediately.
  // ─────────────────────────────────────────────────────────────
  test('AC1: well-formed task is accepted immediately with status pending', () => {
    const seq = bootQueue();

    const result = receive(
      'tasks.deploy << { status: "pending", input: "deploy to prod" }',
      seq,
    );

    const failures = result.mounts.filter(m => !m.ok);
    expect(failures).toEqual([]);
    expect(seq.get('tasks.deploy.status')).toBe('pending');
    expect(seq.get('tasks.deploy.input')).toBe('deploy to prod');
  });

  // ─────────────────────────────────────────────────────────────
  // AC2 [R4]: task missing required field → rejected.
  // ─────────────────────────────────────────────────────────────
  test('AC2: task missing required field (input) is rejected', () => {
    const seq = bootQueue();

    // Direct kernel mount so we can inspect the failure reason.
    // The task is missing the required `input` field.
    const result = seq.mount('bind', 'tasks.deploy', { status: 'pending' });

    expect(result.ok).toBe(false);
    expect(result.gaps).toBeDefined();
    // The reason should reference the missing field.
    const reason = JSON.stringify(result.gaps);
    expect(reason).toMatch(/input/);
  });

  // ─────────────────────────────────────────────────────────────
  // AC3 [R5]: claim sets status=active + records assignee.
  // Uses a batched mount (one block) so status+assignee are atomic.
  // ─────────────────────────────────────────────────────────────
  test('AC3: worker claim sets status to active and records assignee', () => {
    const seq = bootQueue();

    // Submit
    receive('tasks.deploy << { status: "pending", input: "deploy to prod" }', seq);

    // Claim: atomic batch with where-gate on current status = pending.
    const claim = seq.mount([
      { op: 'bind', path: 'tasks.deploy.status', value: 'active' },
      { op: 'bind', path: 'tasks.deploy.assignee', value: 'alice' },
    ], {
      where: [{ op: 'eq', args: ['tasks.deploy.status', 'pending'] }],
    });

    expect(claim.ok).toBe(true);
    expect(seq.get('tasks.deploy.status')).toBe('active');
    expect(seq.get('tasks.deploy.assignee')).toBe('alice');
  });

  // ─────────────────────────────────────────────────────────────
  // AC5 [R6]: already-claimed task → second claim fails/defers.
  // (AC4 concurrent claim is the same semantic — one wins.)
  // ─────────────────────────────────────────────────────────────
  test('AC5: claim on already-active task is not applied', () => {
    const seq = bootQueue();
    receive('tasks.deploy << { status: "pending", input: "deploy to prod" }', seq);

    // Alice claims.
    seq.mount([
      { op: 'bind', path: 'tasks.deploy.status', value: 'active' },
      { op: 'bind', path: 'tasks.deploy.assignee', value: 'alice' },
    ], {
      where: [{ op: 'eq', args: ['tasks.deploy.status', 'pending'] }],
    });

    // Bob tries to claim — same where-gate, now unsatisfied.
    const bob = seq.mount([
      { op: 'bind', path: 'tasks.deploy.status', value: 'active' },
      { op: 'bind', path: 'tasks.deploy.assignee', value: 'bob' },
    ], {
      where: [{ op: 'eq', args: ['tasks.deploy.status', 'pending'] }],
    });

    // Bob's claim was not applied — status/assignee unchanged.
    expect(seq.get('tasks.deploy.assignee')).toBe('alice');
    // Bob's claim is either ok:false or a suspended block.
    // The spec says "informed that the task is no longer available" —
    // we surface this via the where-gate failure in the mount result.
    expect(bob.ok).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────
  // AC6 [R8]: complete → status=done + output attached atomically.
  // ─────────────────────────────────────────────────────────────
  test('AC6: assigned worker completes with typed output', () => {
    const seq = bootQueue();
    receive('tasks.deploy << { status: "pending", input: "deploy to prod" }', seq);

    // Claim.
    seq.mount([
      { op: 'bind', path: 'tasks.deploy.status', value: 'active' },
      { op: 'bind', path: 'tasks.deploy.assignee', value: 'alice' },
    ], {
      where: [{ op: 'eq', args: ['tasks.deploy.status', 'pending'] }],
    });

    // Complete: alice sets status=done and output in one batch,
    // gated on her being the assignee (R7: only assigned worker).
    const done = seq.mount([
      { op: 'bind', path: 'tasks.deploy.status', value: 'done' },
      { op: 'bind', path: 'tasks.deploy.output', value: 'deployed to prod at v2.1.3' },
    ], {
      where: [
        { op: 'eq', args: ['tasks.deploy.status', 'active'] },
        { op: 'eq', args: ['tasks.deploy.assignee', 'alice'] },
      ],
    });

    expect(done.ok).toBe(true);
    expect(seq.get('tasks.deploy.status')).toBe('done');
    expect(seq.get('tasks.deploy.output')).toBe('deployed to prod at v2.1.3');
  });

  // ─────────────────────────────────────────────────────────────
  // R7 regression: non-assignee worker cannot complete.
  // Not a numbered AC, but the spec's R7 is explicit.
  // ─────────────────────────────────────────────────────────────
  test('R7: non-assigned worker cannot complete', () => {
    const seq = bootQueue();
    receive('tasks.deploy << { status: "pending", input: "deploy to prod" }', seq);

    // Alice claims.
    seq.mount([
      { op: 'bind', path: 'tasks.deploy.status', value: 'active' },
      { op: 'bind', path: 'tasks.deploy.assignee', value: 'alice' },
    ], {
      where: [{ op: 'eq', args: ['tasks.deploy.status', 'pending'] }],
    });

    // Bob tries to complete — where-gate on assignee=bob fails.
    const bobCompletes = seq.mount([
      { op: 'bind', path: 'tasks.deploy.status', value: 'done' },
      { op: 'bind', path: 'tasks.deploy.output', value: 'bob did it' },
    ], {
      where: [
        { op: 'eq', args: ['tasks.deploy.status', 'active'] },
        { op: 'eq', args: ['tasks.deploy.assignee', 'bob'] },
      ],
    });

    expect(bobCompletes.ok).toBe(false);
    expect(seq.get('tasks.deploy.status')).toBe('active'); // unchanged
    expect(seq.get('tasks.deploy.output')).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────
  // DEFERRED ACs — documented, not implemented in this first pass.
  // ─────────────────────────────────────────────────────────────

  test.skip('AC4: concurrent claim — exactly one succeeds', () => {
    // Single-threaded kernel gives us mutual exclusion per-block, but
    // "concurrent" here means simultaneous network arrival. That's a
    // transport-level concern, not a kernel concern. The semantic
    // (AC5 above) is what actually matters.
  });

  test.skip('AC7: deadline expiration — status transitions to "expired"', () => {
    // Requires a while-gate with a temporal predicate (deadline > _rt)
    // and a cascade when _rt crosses the threshold. The kernel has
    // _rt in changedPaths so temporal gates re-evaluate, but we need
    // to express "deadline > _rt" as a while constraint in ft text
    // OR mount it directly. Not in first pass.
  });

  test.skip('AC8/AC9: label-implied constraints', () => {
    // Needs a label registry: name → constraint set. Then applying a
    // label = narrowing the task schema with that constraint set.
    // DSL-expressible but out of scope for first pass.
  });

  test.skip('AC10: derived priority from input completeness + dependents', () => {
    // Kernel already does this: Sequence.gaps() returns priority
    // based on concreteness * betweenness. Needs tasks to surface
    // as gaps (currently they don't because input is set at submit).
    // The "incomplete input" case in the spec would be a task with
    // an unfilled input obligation — which we could model as a task
    // whose input is a schema, not a value. Out of scope.
  });

  test.skip('AC11: expired task still queryable with status="expired"', () => {
    // Trivial once AC7 is wired — expired is a valid status value
    // and the task path persists through the transition.
  });
});
