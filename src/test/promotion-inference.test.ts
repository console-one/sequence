/**
 * promotion-inference.test.ts — Promotion via observation accumulation.
 *
 * promoteRefinements() walks the block log, joins observed bind values
 * at each path, and mounts the lattice-join (a union of literals, or a
 * single literal if all observations agree) as a new constraint with
 * owner=`derived:learning`. releaseOwner vacates those constraints;
 * other owners' claims persist.
 */

import { Sequence } from '../sequence';
import { createType } from '../type';

describe('promoteRefinements — observation-driven constraint promotion', () => {
  test('three distinct observations at a path → promoted union constraint', () => {
    const seq = new Sequence();
    seq.mount('schema', 'status', createType('string', []));
    seq.mount('bind', 'status', 'a');
    seq.mount('bind', 'status', 'b');
    seq.mount('bind', 'status', 'c');
    expect(seq.promoteRefinements({ minEvidence: 2 })).toContain('status');
  });

  test('below minEvidence threshold → no promotion', () => {
    const seq = new Sequence();
    seq.mount('bind', 'x', 10);
    seq.mount('bind', 'x', 20);
    expect(seq.promoteRefinements({ minEvidence: 5 })).not.toContain('x');
  });

  test('releaseOwner(derived:learning) vacates the promoted constraint', () => {
    const seq = new Sequence();
    seq.mount('schema', 'status', createType('string', []));
    seq.mount('bind', 'status', 'a');
    seq.mount('bind', 'status', 'b');
    seq.mount('bind', 'status', 'c');
    seq.promoteRefinements({ minEvidence: 2 });
    const affected = seq.releaseOwner('derived:learning');
    expect(affected).toContain('status');
  });

  test('enableLearning fires promotion at every cascade fixpoint', () => {
    const seq = new Sequence();
    seq.enableLearning(2);
    seq.mount('schema', 'status', createType('string', []));
    seq.mount('bind', 'status', 'a');
    // Below threshold (1 distinct value): no derived claim yet.
    expect(seq.releaseOwner('derived:learning')).not.toContain('status');
    // Crossing the threshold: the next mount's cascade auto-promotes.
    seq.mount('bind', 'status', 'b');
    // The derived:learning owner now claims at this path.
    expect(seq.releaseOwner('derived:learning')).toContain('status');
  });

  test('disableLearning stops auto-promotion', () => {
    const seq = new Sequence();
    seq.enableLearning(2);
    seq.mount('schema', 'fresh', createType('string', []));
    seq.mount('bind', 'fresh', 'x');
    seq.mount('bind', 'fresh', 'y');  // promotes
    seq.releaseOwner('derived:learning');
    seq.disableLearning();
    seq.mount('bind', 'fresh', 'z');
    // No re-promotion after disable.
    expect(seq.releaseOwner('derived:learning')).not.toContain('fresh');
  });
});
