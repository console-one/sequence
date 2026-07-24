// 01 — Types and values are one continuum.
//
// A schema is a loose type. A value is a maximally concrete type. Binding
// a value doesn't leave the type system — it moves along the same axis,
// measured by `concreteness` (0 = anything, 1 = fully determined).
// `compose` is the lattice meet: it can only narrow, never loosen.
import {
  Sequence, FT, compose, typeSpecificity, isNever,
} from '@console-one/sequence';
import { assert } from './_assert.mjs';

console.log('01-continuum — a value IS a maximally concrete type');

// A store with a schema (loose) and then a value (concrete).
const seq = new Sequence();
seq.mount('schema', 'count', FT.number());
const loose = seq.concreteness('count');

seq.mount('bind', 'count', 42);
const bound = seq.concreteness('count');

assert(loose < 1, `schema alone is not concrete (concreteness ${loose})`);
assert(bound === 1, 'binding a value reaches concreteness 1 — the value is the most specific type');
assert(seq.get('count') === 42, 'and the value reads back');

// compose() only narrows. Meet of two constraints is tighter than either.
const a = FT.number().min(0).toType();
const b = FT.number().max(10).toType();
const meet = compose(a, b);
assert(
  typeSpecificity(meet) >= Math.max(typeSpecificity(a), typeSpecificity(b)),
  'compose(a, b) is at least as specific as either side',
);

// Meet with a literal is the literal — the continuum's concrete end.
const lit = FT.number(7).toType();
const narrowed = compose(b, lit);
assert(typeSpecificity(narrowed) === 1, 'compose with a value yields a fully concrete type');

// Contradictory requirements have no inhabitant: the meet is never.
const contradiction = compose(FT.number().min(100).toType(), FT.number().max(10).toType());
assert(isNever(contradiction), 'compose of contradictory constraints is never — the lattice bottom');

console.log('PASS');
