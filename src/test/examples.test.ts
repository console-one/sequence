/**
 * examples.test.ts — the public examples are proofs; keep them green.
 *
 * Each examples/NN-*.mjs asserts the claim it demonstrates and exits
 * non-zero on failure. They import the BUILT package ('@console-one/sequence'
 * self-reference → dist/), so this guard runs only when dist/ exists —
 * present in any tree that has run `npm run build`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const built = existsSync(join(root, 'dist', 'src', 'index.js'));

(built ? test : test.skip)('all public examples pass against the built package', () => {
  const r = spawnSync(process.execPath, [join(root, 'examples', 'run-all.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.status !== 0) {
    throw new Error(`examples failed:\n${r.stdout}\n${r.stderr}`);
  }
  expect(r.stdout).toContain('6/6 examples passed');
}, 130_000);
