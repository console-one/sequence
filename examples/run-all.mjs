// Driver: run every numbered example as its own process; any assertion
// failure fails the whole run. `node examples/run-all.mjs`
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const examples = readdirSync(dir).filter(f => /^\d\d-.*\.mjs$/.test(f)).sort();

let failed = 0;
for (const file of examples) {
  const r = spawnSync(process.execPath, [join(dir, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
  console.log('');
}

if (failed > 0) {
  console.error(`${failed}/${examples.length} examples FAILED`);
  process.exit(1);
}
console.log(`${examples.length}/${examples.length} examples passed`);
