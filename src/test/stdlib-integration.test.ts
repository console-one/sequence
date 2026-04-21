/**
 * stdlib-integration.test.ts — End-to-end: install .ft package,
 * surface auth gap, provide validated key, gap closes, invoke works.
 */

import { Sequence } from '../sequence';
import { receive } from '../dsl/walker';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createType, producedBy } from '../type';

const STDLIB = join(__dirname, '..', '..', 'stdlib');

describe('stdlib integration: install → gap → fill → invoke', () => {

  test('install openai.ft → fn gap → install impl → gap closes → invoke', () => {
    const seq = new Sequence(() => Date.now());

    // Step 1: Install the package
    const ftText = readFileSync(join(STDLIB, 'openai.ft'), 'utf-8');
    receive(ftText, seq);

    // Step 2: openai.chat is a fn type
    const chatSchema = seq.typeAt('openai.chat');
    expect(chatSchema).toBeDefined();
    expect(chatSchema!.kind).toBe('fn');

    // Step 3: openai.chat is a gap (fn schema, no impl)
    expect(seq.gaps().some(g => g.path === 'openai.chat')).toBe(true);

    // Step 4: Install impl → gap closes
    seq.mount('cap', 'openai.chat', (_input: any) => ({
      content: 'mock response',
      tokens_used: 42,
    }));
    expect(seq.gaps().some(g => g.path === 'openai.chat')).toBe(false);

    // Step 5: Invoke → output at .result
    seq.mount('bind', 'openai.chat', {
      messages: [{ role: 'user', content: 'hello' }],
    });
    const output = seq.get('openai.chat.result');
    expect(output).toEqual({ content: 'mock response', tokens_used: 42 });
  });

  test('provenance-gated key: raw key rejected, validated key accepted', () => {
    const seq = new Sequence(() => Date.now());

    // Require provenance on key path
    seq.mount('schema', 'keys.openai', createType('string', [
      producedBy('keyValidator'),
    ]));

    // Raw key → rejected
    const bad = seq.mount('bind', 'keys.openai', 'sk-raw');
    expect(bad.ok).toBe(false);
    expect(bad.gaps![0].reason).toContain('provenance required');

    // Validated key → accepted
    const good = seq.mount('bind', 'keys.openai', 'sk-validated', {
      author: 'keyValidator',
    });
    expect(good.ok).toBe(true);
    expect(seq.get('keys.openai')).toBe('sk-validated');
  });

  test('full chain: install package + provenance key + invoke', () => {
    const seq = new Sequence(() => Date.now());

    // Install package
    const ftText = readFileSync(join(STDLIB, 'openai.ft'), 'utf-8');
    receive(ftText, seq);

    // Set up provenance requirement on key
    seq.mount('schema', 'keys.openai', createType('string', [
      producedBy('keyValidator'),
    ]));

    // Provide validated key
    seq.mount('bind', 'keys.openai', 'sk-real-key', { author: 'keyValidator' });
    expect(seq.get('keys.openai')).toBe('sk-real-key');

    // Install impl for openai.chat
    seq.mount('cap', 'openai.chat', (_input: any) => ({
      content: 'hello from openai',
      tokens_used: 10,
    }));

    // No more fn gap
    expect(seq.gaps().some(g => g.path === 'openai.chat')).toBe(false);

    // Invoke
    seq.mount('bind', 'openai.chat', {
      messages: [{ role: 'user', content: 'test' }],
    });
    expect(seq.get('openai.chat.result')).toEqual({
      content: 'hello from openai',
      tokens_used: 10,
    });
  });
});
