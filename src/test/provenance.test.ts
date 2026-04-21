/**
 * provenance.test.ts — Provenance enforcement at mount admission.
 *
 * A producedBy constraint on a schema means: the value at this path
 * must have been produced by a specific capability or author.
 * Checked at mount time — not after the fact.
 */

import { Sequence } from '../sequence';
import { FT } from '../builder';
import { createType, property, producedBy } from '../type';

describe('provenance enforcement', () => {

  test('unvalidated value rejected when producedBy required', () => {
    const seq = new Sequence(() => 1000000);

    // Schema: this path requires values produced by 'validateOpenAIKey'
    seq.mount('schema', 'id.keys.openai', createType('string', [
      producedBy('validateOpenAIKey'),
    ]));

    // Try to mount a value without the right author or exec record
    const r = seq.mount('bind', 'id.keys.openai', 'sk-raw-unvalidated-key');
    expect(r.ok).toBe(false);
    expect(r.gaps![0].reason).toContain('provenance required');
    expect(r.gaps![0].reason).toContain('validateOpenAIKey');
  });

  test('validated value accepted when author matches producer', () => {
    const seq = new Sequence(() => 1000000);

    seq.mount('schema', 'id.keys.openai', createType('string', [
      producedBy('validateOpenAIKey'),
    ]));

    // Mount with matching author — this block was produced by the validator
    const r = seq.mount('bind', 'id.keys.openai', 'sk-validated-key', {
      author: 'validateOpenAIKey',
    });
    expect(r.ok).toBe(true);
    expect(seq.get('id.keys.openai')).toBe('sk-validated-key');
  });

  test('validated value accepted via exec record', () => {
    let now = 1000000;
    const seq = new Sequence(() => now);

    seq.mount('schema', 'id.keys.openai', createType('string', [
      producedBy('validateOpenAIKey'),
    ]));

    // Simulate: a prior mount by the validator produced this path
    // Mount the exec record first (as the validator would)
    seq.mount('schema', 'validateOpenAIKey', createType('fn', [
      { op: 'param', args: [createType('object', [property('rawKey', FT.string())])] },
      { op: 'returns', args: [FT.string()] },
    ]));
    seq.mount('cap', 'validateOpenAIKey', (input: any) => input.rawKey);

    // Invoke the validator — this creates an exec record
    seq.mount('bind', 'validateOpenAIKey', { rawKey: 'sk-test-key' }, {
      author: 'system',
    });

    // The exec record exists with produced: ['validateOpenAIKey.result']
    // But the key itself needs to be at 'id.keys.openai'
    // For the exec match to work, the exec record must show
    // the validator produced the target path.

    // Manually create the exec evidence (simulating what the system would do
    // if the validator's output was routed to id.keys.openai)
    const execSeq = seq.head;
    seq.mount('bind', `_exec.${execSeq}.invoked`, 'validateOpenAIKey');
    seq.mount('bind', `_exec.${execSeq}.produced`, ['id.keys.openai']);
    seq.mount('bind', `_exec.${execSeq}.time`, now);

    // Now mount the validated key — exec record proves provenance
    const r = seq.mount('bind', 'id.keys.openai', 'sk-test-key');
    expect(r.ok).toBe(true);
  });

  test('expired validation rejected when maxAge exceeded', () => {
    let now = 1000000;
    const seq = new Sequence(() => now);

    // Schema: must be produced by validator, valid for 60 seconds
    seq.mount('schema', 'id.keys.openai', createType('string', [
      producedBy('validateOpenAIKey', 60000),
    ]));

    // Create exec evidence from 30 seconds ago (within window)
    const execSeq = seq.head;
    seq.mount('bind', `_exec.${execSeq}.invoked`, 'validateOpenAIKey');
    seq.mount('bind', `_exec.${execSeq}.produced`, ['id.keys.openai']);
    seq.mount('bind', `_exec.${execSeq}.time`, now - 30000);

    // Mount within window — accepted
    const r1 = seq.mount('bind', 'id.keys.openai', 'sk-fresh-key');
    expect(r1.ok).toBe(true);

    // Advance time past the maxAge window
    now = 1000000 + 90000; // 90 seconds later

    // Schema still requires producedBy with 60s maxAge
    // The exec record is now 120 seconds old — expired
    // Need to re-mount to trigger the check
    seq.mount('schema', 'id.keys.openai', createType('string', [
      producedBy('validateOpenAIKey', 60000),
    ]));

    const r2 = seq.mount('bind', 'id.keys.openai', 'sk-stale-key');
    expect(r2.ok).toBe(false);
    expect(r2.gaps![0].reason).toContain('provenance required');
  });

  test('author match works for any producer identity', () => {
    const seq = new Sequence(() => 1000000);

    seq.mount('schema', 'state.report', createType('string', [
      producedBy('reportGenerator'),
    ]));

    // Wrong author — rejected
    const r1 = seq.mount('bind', 'state.report', 'fake report', { author: 'user' });
    expect(r1.ok).toBe(false);

    // Right author — accepted
    const r2 = seq.mount('bind', 'state.report', 'real report', { author: 'reportGenerator' });
    expect(r2.ok).toBe(true);
  });

  test('no producedBy constraint → normal mount works', () => {
    const seq = new Sequence(() => 1000000);

    // No provenance requirement
    seq.mount('schema', 'data.x', FT.string());
    const r = seq.mount('bind', 'data.x', 'hello');
    expect(r.ok).toBe(true);
  });

  test('provenance gap includes producer name and maxAge in reason', () => {
    const seq = new Sequence(() => 1000000);

    seq.mount('schema', 'id.keys.test', createType('string', [
      producedBy('keyValidator', 30000),
    ]));

    const r = seq.mount('bind', 'id.keys.test', 'raw-key');
    expect(r.ok).toBe(false);
    expect(r.gaps![0].reason).toContain('keyValidator');
    expect(r.gaps![0].reason).toContain('30000ms');
    expect(r.gaps![0].constraint.op).toBe('producedBy');
  });

  // ─── AUDIT: correct shape, wrong provenance ─────────────────

  test('correct shape but wrong provenance → rejected at admission', () => {
    const seq = new Sequence(() => 1000000);

    // Schema: object with specific shape + provenance requirement
    seq.mount('schema', 'state.apiContract', createType('object', [
      property('tier', FT.string(), false),
      property('valid', createType('boolean', []), false),
      producedBy('contractValidator'),
    ]));

    // Value has the exact right shape — but no provenance
    const r = seq.mount('bind', 'state.apiContract', { tier: 'tier-1', valid: true });
    expect(r.ok).toBe(false);
    expect(r.gaps![0].reason).toContain('provenance required');
    expect(r.gaps![0].reason).toContain('contractValidator');

    // Same value, now with correct author → accepted
    const r2 = seq.mount('bind', 'state.apiContract', { tier: 'tier-1', valid: true }, {
      author: 'contractValidator',
    });
    expect(r2.ok).toBe(true);
    expect(seq.get('state.apiContract')).toEqual({ tier: 'tier-1', valid: true });
  });

  test('same value accepted when _exec evidence satisfies producedBy', () => {
    let now = 1000000;
    const seq = new Sequence(() => now);

    seq.mount('schema', 'state.validated', createType('string', [
      producedBy('myValidator'),
    ]));

    // Without evidence → rejected
    const r1 = seq.mount('bind', 'state.validated', 'data');
    expect(r1.ok).toBe(false);

    // Plant exec evidence showing myValidator produced state.validated
    const execSeq = seq.head;
    seq.mount('bind', `_exec.${execSeq}.invoked`, 'myValidator');
    seq.mount('bind', `_exec.${execSeq}.produced`, ['state.validated']);
    seq.mount('bind', `_exec.${execSeq}.time`, now);

    // With evidence → accepted
    const r2 = seq.mount('bind', 'state.validated', 'data');
    expect(r2.ok).toBe(true);
  });
});
