/**
 * hoist-catalog.test.ts — hoistCatalog: the capability frame.
 *
 * hoist() renders state; hoistCatalog() renders every fn-typed schema as
 * nested package blocks with named-type extraction (the storylens
 * `type QueryInput = { … }` / `pkg = { verb { … } }` form). Born from
 * the observatory-app shadow-build collapse (2026-07-17): the office
 * frame must HOIST, not emit a flat dotted list.
 */

import { Sequence } from '../sequence';
import { FT } from '../builder';
import { hoistCatalog } from '../hoist';

function catalogSeq(): Sequence {
  const seq = new Sequence();
  seq.mount('schema', 'ls', FT.fn({ input: FT.object({}), description: 'list topics' }));
  seq.mount('schema', 'note', FT.fn({
    input: FT.object({ topic: FT.string(), text: FT.string() }),
    description: 'append a note',
  }));
  // A package: two verbs sharing one input shape (→ one named type).
  seq.mount('schema', 'content.get', FT.fn({
    input: FT.object({ topicID: FT.string(), contentID: FT.string() }),
    description: 'read an item',
  }));
  seq.mount('schema', 'content.rm', FT.fn({
    input: FT.object({ topicID: FT.string(), contentID: FT.string() }),
    description: 'tombstone an item',
  }));
  // A long input (→ hoisted by length even though unshared).
  seq.mount('schema', 'content.register', FT.fn({
    input: FT.object({
      topicID: FT.string(),
      name: FT.string(),
      'indexedAttrs?': FT.array(FT.string()),
      'actions?': FT.array(FT.string()),
      'localOnly?': FT.boolean(),
    }),
    description: 'declare a content type',
  }));
  // Leaf AND package under the same head (`cash` + `cash.add`).
  seq.mount('schema', 'cash', FT.fn({
    input: FT.object({ 'months?': FT.number() }),
    description: 'the cash forecast',
  }));
  seq.mount('schema', 'cash.add', FT.fn({
    input: FT.object({ label: FT.string(), amount: FT.string() }),
    description: 'declare a cash event',
  }));
  return seq;
}

describe('hoistCatalog', () => {
  const text = hoistCatalog(catalogSeq()).text;

  test('groups verbs into nested package blocks, not dotted paths', () => {
    expect(text).toContain('content = {');
    expect(text).toMatch(/content = \{[\s\S]*get [\s\S]*rm [\s\S]*\}/);
    expect(text).not.toMatch(/^content\.get/m);
  });

  test('extracts a shared input shape into ONE named type definition', () => {
    expect(text).toContain('type ContentGetInput = { topicID: string, contentID: string }');
    // Both users reference the name; the shape is defined exactly once.
    expect(text.match(/topicID: string, contentID: string/g)).toHaveLength(1);
    expect(text).toMatch(/get ContentGetInput/);
    expect(text).toMatch(/rm ContentGetInput/);
  });

  test('hoists long inputs by length; keeps short unshared inputs inline', () => {
    expect(text).toContain('type ContentRegisterInput =');
    expect(text).toMatch(/note \{ topic: string, text: string \}/);
  });

  test('a path that is both leaf and package renders leaf line then block', () => {
    const cashLeaf = text.indexOf('cash { months?: number }');
    const cashBlock = text.indexOf('cash = {');
    expect(cashLeaf).toBeGreaterThan(-1);
    expect(cashBlock).toBeGreaterThan(cashLeaf);
    expect(text).toMatch(/add \{ label: string, amount: string \}/);
  });

  test('descriptions render as ft comments; empty inputs render {}', () => {
    expect(text).toContain('-- append a note');
    expect(text).toMatch(/ls \{\}/);
  });

  test('is fast on a wide flat catalog (the gaps() trap does not apply)', () => {
    const seq = new Sequence();
    for (let i = 0; i < 80; i++) {
      seq.mount('schema', `pkg${i % 8}.verb${i}`, FT.fn({
        input: FT.object({ a: FT.string(), 'b?': FT.number() }),
        description: `verb ${i}`,
      }));
    }
    const t0 = Date.now();
    const out = hoistCatalog(seq).text;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(out).toContain('pkg0 = {');
    expect(out.split('\n').length).toBeGreaterThan(80);
  });
});
