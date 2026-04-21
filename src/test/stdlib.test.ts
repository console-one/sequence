/**
 * stdlib.test.ts — Verify stdlib .ft packages exist and parse.
 *
 * Guard: if packages/stdlib/openai.ft exists, the runtime must be able
 * to read and parse it. This ensures the package install path works.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tokenize } from '../dsl/tokenizer';
import { Parser } from '../dsl/parser';

const STDLIB_DIR = join(__dirname, '..', '..', 'stdlib');

describe('stdlib packages', () => {

  test('packages/stdlib/openai.ft exists and parses without error', () => {
    const path = join(STDLIB_DIR, 'openai.ft');
    expect(existsSync(path)).toBe(true);

    const source = readFileSync(path, 'utf-8');
    expect(source.length).toBeGreaterThan(0);

    // Must tokenize without throwing
    const tokens = tokenize(source);
    expect(tokens.length).toBeGreaterThan(0);

    // Must parse without throwing
    const ast = new Parser(tokens).parseProgram();
    expect(ast.length).toBeGreaterThan(0);

    // Should contain assign statements for openai.chat
    const assigns = ast.filter(s => s.kind === 'assign');
    expect(assigns.some((s: any) => s.path.startsWith('openai.chat'))).toBe(true);
  });

  test('packages/stdlib/github.ft exists and parses without error', () => {
    const path = join(STDLIB_DIR, 'github.ft');
    expect(existsSync(path)).toBe(true);

    const source = readFileSync(path, 'utf-8');
    const tokens = tokenize(source);
    const ast = new Parser(tokens).parseProgram();
    expect(ast.length).toBeGreaterThan(0);

    const assigns = ast.filter(s => s.kind === 'assign');
    expect(assigns.some((s: any) => s.path.startsWith('github.'))).toBe(true);
  });
});
