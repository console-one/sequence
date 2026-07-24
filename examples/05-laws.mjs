// 05 — Laws are data, enforced by the substrate at the write boundary.
//
// An admission law is mounted like any other fact. From then on the
// STORE — not caller discipline — rejects writes that violate it. The
// law here reads live state ('sessions.holder') at admission time, so
// changing the holder changes who may write, with no code change.
import { Sequence, createType, law, eq } from '@console-one/sequence';
import { assert } from './_assert.mjs';

console.log('05-laws — the store enforces its own constitution');

const seq = new Sequence();
seq.mount('bind', 'sessions.holder', 'alice');
seq.mount('schema', 'sessions', createType('any', [
  law({
    admission: true,
    check: eq('$author', 'sessions.holder'),
    reason: 'only the current session holder may write',
  }),
]));

// The holder writes: admitted.
const ok = seq.mount('bind', 'sessions.tick', 1, { author: 'alice' });
assert(ok.ok === true && seq.get('sessions.tick') === 1, "alice (the holder) writes and it lands");

// Anyone else: rejected at the boundary, with the law's reason, and the
// store is untouched — no partial write to unwind.
const denied = seq.mount('bind', 'sessions.tick', 2, { author: 'bob' });
assert(denied.ok === false, "bob's write is rejected by the mounted law");
assert(
  denied.gaps?.[0]?.reason === 'only the current session holder may write',
  'the rejection carries the law\'s own stated reason',
);
assert(seq.get('sessions.tick') === 1, 'the denied write left no trace');

// The law reads live state — and governs its own handoff: an unsigned
// attempt to reassign the holder is itself rejected. Alice must sign it.
assert(!seq.mount('bind', 'sessions.holder', 'bob').ok, 'even the handoff is governed — an unsigned reassignment is rejected');
seq.mount('bind', 'sessions.holder', 'bob', { author: 'alice' });
assert(seq.mount('bind', 'sessions.tick', 3, { author: 'bob' }).ok, 'after handoff, bob is admitted');
assert(!seq.mount('bind', 'sessions.tick', 4, { author: 'alice' }).ok, 'and alice no longer is');

console.log('PASS');
