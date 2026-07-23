/**
 * contention-sole-writer.test.ts — a consumption-contention rule encoded
 * on the shared dependency's type and enforced at admission. No kernel
 * policy, no new machinery: the statement under test is
 *
 *   "sole writer to API X, with the exception of any writer in Y
 *    (which the sole writer owns)"
 *
 * written as two admission laws on apiX's own type:
 *   - the write surface (apiX.writes.*): open until a sole-writer claim
 *     exists; then only the holder or a member of the exception list.
 *   - the claim itself (apiX.sole.*): first claimant wins; afterwards
 *     only the holder may modify it — including the exception list, so
 *     Y is OWNED by the holder and cannot be self-served into.
 */

import { Sequence } from '../sequence';
import { createType, law, eq, or, notExists, contains } from '../type';

describe('consumption contention — sole writer with owned exception group', () => {
  function mountApiX(): Sequence {
    const seq = new Sequence();
    // The write surface: who may land writes on X.
    seq.mount('schema', 'apiX.writes', createType('any', [
      law({
        admission: true,
        check: or(
          notExists('apiX.sole.holder'),        // no exclusivity claimed → open
          eq('$author', 'apiX.sole.holder'),    // the sole writer
          contains('apiX.sole.except', '$author'), // any writer in Y
        ),
        reason: 'apiX has a sole writer; author is neither holder nor excepted',
      }),
    ]));
    // The claim: first claimant wins; then only the holder may touch it.
    // This is what makes Y "owned" — the exception list lives under the
    // same guard.
    seq.mount('schema', 'apiX.sole', createType('any', [
      law({
        admission: true,
        check: or(
          notExists('apiX.sole.holder'),
          eq('$author', 'apiX.sole.holder'),
        ),
        reason: 'the sole-writer claim is owned by its holder',
      }),
    ]));
    return seq;
  }

  test('before any claim, the write surface is open', () => {
    const seq = mountApiX();
    expect(seq.mount('bind', 'apiX.writes.w0', 'x', { author: 'anyone' }).ok).toBe(true);
  });

  test('holder writes pass; a non-excepted writer is rejected at admission', () => {
    const seq = mountApiX();
    expect(seq.mount('bind', 'apiX.sole.holder', 'kitA', { author: 'kitA' }).ok).toBe(true);

    expect(seq.mount('bind', 'apiX.writes.w1', 'a', { author: 'kitA' }).ok).toBe(true);

    const rejected = seq.mount('bind', 'apiX.writes.w2', 'b', { author: 'kitB' });
    expect(rejected.ok).toBe(false);
    expect(rejected.gaps?.[0]?.reason)
      .toBe('apiX has a sole writer; author is neither holder nor excepted');
    expect(seq.get('apiX.writes.w2')).toBeUndefined();
  });

  test('the claim cannot be seized, and Y cannot be self-served into', () => {
    const seq = mountApiX();
    seq.mount('bind', 'apiX.sole.holder', 'kitA', { author: 'kitA' });

    // kitB tries to take over the claim.
    const seize = seq.mount('bind', 'apiX.sole.holder', 'kitB', { author: 'kitB' });
    expect(seize.ok).toBe(false);
    expect(seize.gaps?.[0]?.reason).toBe('the sole-writer claim is owned by its holder');
    expect(seq.get('apiX.sole.holder')).toBe('kitA');

    // kitB tries to add itself to the exception group.
    const selfServe = seq.mount('bind', 'apiX.sole.except', ['kitB'], { author: 'kitB' });
    expect(selfServe.ok).toBe(false);
    expect(seq.get('apiX.sole.except')).toBeUndefined();
  });

  test('the holder grants membership in Y; the excepted writer is then admitted', () => {
    const seq = mountApiX();
    seq.mount('bind', 'apiX.sole.holder', 'kitA', { author: 'kitA' });

    // Grant by the owner of the claim.
    expect(seq.mount('bind', 'apiX.sole.except', ['kitB'], { author: 'kitA' }).ok).toBe(true);

    // kitB now writes through the exception.
    expect(seq.mount('bind', 'apiX.writes.w3', 'c', { author: 'kitB' }).ok).toBe(true);

    // A third party is still shut out.
    expect(seq.mount('bind', 'apiX.writes.w4', 'd', { author: 'kitC' }).ok).toBe(false);
  });
});
