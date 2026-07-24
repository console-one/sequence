// 04 — Function types carry identity, so plans can be derived backward.
//
// A tool's type declares not just param/return shapes but what it
// PRESERVES (input properties that flow through to output). That makes
// the question "what input do I need to reach this goal?" computable:
// backwardInfer chains requirements from the goal back through each
// step. covers() then checks whether a candidate satisfies a claim.
import {
  FT, backwardInfer, covers, properties,
} from '@console-one/sequence';
import { assert } from './_assert.mjs';

console.log('04-identity — deriving required inputs from a required output');

// parse: T → T & { parsed: true }   (passes everything through, adds a mark)
const parse = FT.fn({
  input: FT.object({ id: FT.string().toType() }).toType(),
  output: FT.object({ parsed: FT.boolean(true).toType() }).toType(),
  preserves: '*',
}).toType();

// validate: T → T & { validated: true }
const validate = FT.fn({
  input: FT.object({ parsed: FT.boolean(true).toType() }).toType(),
  output: FT.object({ validated: FT.boolean(true).toType() }).toType(),
  preserves: '*',
}).toType();

// The goal: a record that is validated AND still carries its name.
const goal = FT.object({
  validated: FT.boolean(true).toType(),
  name: FT.string().toType(),
}).toType();

// Walk the chain backward: goal → what validate needs → what parse needs.
const validateInput = backwardInfer(validate, goal);
const parseInput = backwardInfer(parse, validateInput);

const validateKeys = properties(validateInput).map(p => p.key).sort();
const parseKeys = properties(parseInput).map(p => p.key).sort();
console.log(`  validate needs: {${validateKeys}}   parse needs: {${parseKeys}}`);

assert(validateKeys.includes('parsed'), "validate's own precondition survives");
assert(validateKeys.includes('name'), "the goal's 'name' is traced back through preserves(*)");
assert(!validateKeys.includes('validated'), 'what the step PRODUCES is not demanded of its input');
assert(parseKeys.includes('id') && parseKeys.includes('name'), 'the chain bottoms out at the original required input');
assert(!parseKeys.includes('parsed'), "parse produces 'parsed'; it is not required upstream");

// covers(): does a candidate discharge a claim? Order matters — a loose
// candidate does not satisfy a tight requirement.
const tight = FT.object({ id: FT.string().toType(), name: FT.string().toType() }).toType();
const looseCandidate = FT.object({ id: FT.string().toType() }).toType();
assert(covers(looseCandidate, tight), 'a record with id+name covers the claim "has id"');
assert(!covers(tight, looseCandidate), 'a record with only id does NOT cover the claim "has id+name"');

console.log('PASS');
