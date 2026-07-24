/**
 * doc-blocks.test.ts — the tutorial is executable, and this proves it.
 *
 * Every ```ft block in doc/*.md is received into a per-file Sequence in
 * document order and must mount cleanly (suspension via `when` counts as
 * clean — it is the documented behavior, not a failure). Blocks fenced
 * ```ft-rejected exist to demonstrate refusal and must produce at least
 * one rejected mount. A doc edit that breaks either fails the suite —
 * the pages cannot drift from the kernel.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sequence } from '../sequence';
import { receive } from '../dsl/walker';

const DOC_DIR = join(__dirname, '..', '..', 'doc');

type DocBlock = { lang: 'ft' | 'ft-rejected'; content: string; line: number };

/** ```ft and ```ft-rejected fences, interleaved in document order. */
function extractDocBlocks(md: string): DocBlock[] {
  const out: DocBlock[] = [];
  const lines = md.split('\n');
  let lang: DocBlock['lang'] | null = null;
  let buf: string[] = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (lang === null && (t === '```ft' || t === '```ft-rejected')) {
      lang = t === '```ft' ? 'ft' : 'ft-rejected';
      buf = [];
      start = i + 1;
      continue;
    }
    if (lang !== null && t === '```') {
      out.push({ lang, content: buf.join('\n'), line: start });
      lang = null;
      continue;
    }
    if (lang !== null) buf.push(lines[i]);
  }
  return out;
}

const docFiles = readdirSync(DOC_DIR).filter((f) => f.endsWith('.md')).sort();

describe('doc/ ft blocks execute against the kernel', () => {
  for (const file of docFiles) {
    const blocks = extractDocBlocks(readFileSync(join(DOC_DIR, file), 'utf8'));
    if (blocks.length === 0) continue;

    test(`${file} — ${blocks.length} block(s), shared scope, document order`, () => {
      const seq = new Sequence();
      for (const b of blocks) {
        const result = receive(b.content, seq);
        const mounts = result.mounts ?? [];
        if (b.lang === 'ft') {
          // A `when`-gated mount suspends as ok:false with a "where:" gap
          // — that is the documented behavior part 2 demonstrates, not a
          // failure. Anything else not-ok is a broken doc.
          const failed = mounts.filter(
            (m) =>
              !m.ok &&
              !(m.gaps ?? []).every((g) => String(g.reason ?? '').startsWith('where:')),
          );
          expect({
            file,
            line: b.line,
            failures: failed.map((m) => m.gaps?.[0]?.reason ?? 'unknown'),
          }).toEqual({ file, line: b.line, failures: [] });
        } else {
          expect(mounts.some((m) => !m.ok)).toBe(true);
        }
      }
    });
  }
});
