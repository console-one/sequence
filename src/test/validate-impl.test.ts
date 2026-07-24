/**
 * validate-impl.test.ts — Validates that ft blocks in impl/ files
 * parse, mount, and produce valid Sequence state.
 *
 * Reads each .md file in impl/, extracts ft blocks, parses them,
 * mounts them, and verifies no parse errors occurred.
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractFtBlocks } from '../dsl/extract';
import { tokenize } from '../dsl/tokenizer';
import { Parser } from '../dsl/parser';
import { walk } from '../dsl/walker';
import { Sequence } from '../sequence';

const IMPL_DIR = path.join(__dirname, '..', '..', 'specs', 'impl');

function getMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getMarkdownFiles(full));
    } else if (entry.name.endsWith('.md') && entry.name !== 'TEMPLATE.md' && entry.name !== 'REQUIREMENTS_FRAMEWORK.md' && entry.name !== 'TYPES.md') {
      results.push(full);
    }
  }
  return results;
}

function validateFile(filePath: string): { ok: boolean; blocks: number; errors: string[] } {
  const content = fs.readFileSync(filePath, 'utf-8');
  const blocks = extractFtBlocks(content);
  const errors: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    try {
      const tokens = tokenize(block.content);
      const parser = new Parser(tokens);
      const ast = parser.parseProgram();
      // Try mounting into a fresh Sequence
      const seq = new Sequence();
      walk(ast, seq);
    } catch (e: any) {
      errors.push(`Block ${i + 1} (line ${block.startLine}): ${e.message}`);
    }
  }

  return { ok: errors.length === 0, blocks: blocks.length, errors };
}

describe('impl/ ft block validation', () => {
  const files = getMarkdownFiles(IMPL_DIR);
  const filesWithFt = files.filter(f => {
    const content = fs.readFileSync(f, 'utf-8');
    return content.includes('```ft');
  });

  if (filesWithFt.length === 0) {
    test('no ft blocks found yet (skip)', () => {
      expect(true).toBe(true);
    });
    return;
  }

  // PARSE_LEDGER.json is the RATCHET (2026-07-24): the spec corpus was
  // recovered from ft history with 98 of 113 files carrying designed-but-
  // not-yet-parsed syntax (the DSL_REQUIREMENTS vs SYNTAX_SUPPORTED gap,
  // measured). A file in the ledger is a known gap and may keep failing;
  // a file NOT in the ledger must parse (regression guard); and a
  // ledgered file that STARTS parsing fails the suite until it is
  // removed — so grammar progress is recorded, never silent.
  const ledger = new Set<string>(
    JSON.parse(fs.readFileSync(path.join(IMPL_DIR, 'PARSE_LEDGER.json'), 'utf-8')) as string[],
  );

  for (const file of filesWithFt) {
    const relPath = path.relative(IMPL_DIR, file);
    const known = ledger.has(relPath);
    test(`${relPath}: ${known ? 'known grammar gap (ledgered)' : 'ft blocks parse and mount'}`, () => {
      const result = validateFile(file);
      if (known) {
        if (result.ok) {
          throw new Error(
            `${relPath} now parses — grammar progress! Remove it from specs/impl/PARSE_LEDGER.json to record the ratchet.`,
          );
        }
        return; // known gap, still a gap — documented, not silent
      }
      if (!result.ok) {
        console.error(`Errors in ${relPath}:`);
        for (const err of result.errors) console.error(`  ${err}`);
      }
      expect(result.ok).toBe(true);
    });
  }
});
