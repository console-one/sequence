# Part 1: The continuum

At its core, sequence is a store where types and values sit on one axis.
A schema is a loose description; a value is the tightest possible
description; everything in between is a *partially known* thing the
store can reason about. This part shows that axis end to end on one
running example: a deployment record filling in.

Everything below uses the ft text language (part 2 covers its shape in
detail); the JavaScript API mirrors it one-for-one.

## Declaring what must become true

A deployment needs a service name, a region from an approved list, and a
replica count. Declare that — and nothing else:

```ft
deploy = { service: string, region: "us-east-1" | "eu-west-1", replicas: number }
```

The store now holds a *schema* at `deploy`. Nothing is deployable yet,
and the store knows it — asking for its obligations returns the paths
that are declared but not yet satisfied:

```
seq.obligations()          → [ { path: "deploy", … } ]
seq.concreteness('deploy') → 0.159
```

That second number is the point of this part. **Concreteness** measures
where a path sits on the type-value axis: 0 is "anything", 1 is "fully
determined". A three-field schema with an enum sits low. It is not a
boolean "valid/invalid" — it is a distance, and distances can be ranked,
budgeted, and worked off. (Part 5 ranks work by exactly this signal.)

## Filling in — and being refused

Bind the fields as they become known. Each bind is a mount on the same
log the schema went into:

```ft
deploy.service = "checkout"
deploy.replicas = 3
```

Now the wrong write arrives — a region not in the union:

```ft-rejected
deploy.region = "ap-south-2"
```

The store refuses it, and says why:

```
{ ok: false, gaps: [ { path: "deploy.region", reason: "matches none of 2 branches" } ] }
```

Two things to notice. The rejection is *structured* — a gap with a path
and a reason, not an exception string. And the store is unchanged: a
refused mount leaves no partial write to clean up.

The right value completes the record:

```ft
deploy.region = "eu-west-1"
```

```
seq.get('deploy.region')   → "eu-west-1"
seq.concreteness('deploy') → 1
seq.obligations()          → []
```

Concreteness reached 1: the record's value IS its type now, maximally
narrowed. The obligation is gone because it was never a task in a queue
— it was the *distance from 1*, and the distance is now zero.

## `=` overwrites, `<<` narrows — and at leaves, folds

There are two ways to write. `=` replaces whatever was at the path. `<<`
moves the path *downhill on the continuum*:

```ft
retries = number
retries << 4
```

```
seq.get('retries') → 4
```

`retries` went from "a number" to "the number 4" — a narrowing, always
legal. What happens if you `<<` again, onto a value that is already
concrete? The answer depends on the type's *meet*. A contradictory
string literal is refused — `"b"` is not a refinement of `"a"`:

```
x = "a"
x << "b"    → { ok: false, reason: "narrow incompatible" }   // x stays "a"
```

But for numbers the leaf meet is **sum** — `<<` on a concrete number
accumulates:

```ft
retries << 1
```

```
seq.get('retries') → 5
```

Which means a counter is one declaration and no code: every `<< 1` is an
increment, folded by the store. When you mean replacement, say `=`;
when you mean refinement-or-fold, say `<<`.

This is the whole trick of the continuum: because schemas and values are
the same substance, "validation", "progress tracking", "assignment" and
even "aggregation" stop being separate subsystems. They are one lattice,
walked downhill — with a monoid at the bottom.

## Try it

```bash
git clone https://github.com/console-one/sequence.git && cd sequence
npm install && npm run build
node --input-type=module -e "
import { Sequence, receive } from './dist/src/index.js';
const seq = new Sequence();
receive('deploy = { service: string, region: \"us-east-1\" | \"eu-west-1\", replicas: number }', seq);
console.log(seq.concreteness('deploy'));
receive('deploy.service = \"checkout\"', seq);
receive('deploy.replicas = 3', seq);
receive('deploy.region = \"eu-west-1\"', seq);
console.log(seq.concreteness('deploy'), seq.get('deploy.region'));
"
```

Next: [Part 2 — the language](part2-the-language.md), where the text
form earns its keep: wildcard schemas, suspended writes, and a working
task queue.
