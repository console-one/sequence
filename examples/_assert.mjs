// Tiny assertion helper shared by the examples. Each example is a proof:
// it exits non-zero the moment a claim it demonstrates stops being true.
export function assert(cond, label) {
  if (!cond) {
    console.error(`  ✗ FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`  ✓ ${label}`);
}
