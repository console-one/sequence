# Part 4: Laws and identity

Access rules usually live outside the data they protect — in middleware,
in a policy service, in reviewer vigilance. In sequence a law is a fact:
you mount it, and from that moment the *store* enforces it at admission,
against every write, including writes that would change the law's own
inputs. This part builds a session-holder rule, watches it refuse a
write, and hands the session over — under the same law.

## The store's constitution is data

The rule: only the current session holder may write under `sessions.`.
State the holder, then mount the law on the subtree's schema:

```js
seq.mount('bind', 'sessions.holder', 'alice');
seq.mount('schema', 'sessions', createType('any', [
  law({
    admission: true,
    check: eq('$author', 'sessions.holder'),
    reason: 'only the current session holder may write',
  }),
]));
```

Note what the check compares: `$author` (who is writing) against
`sessions.holder` — **live state**, read at admission time. The law has
no hardcoded principal in it.

## Enforcement, with receipts

Alice writes; the mount is admitted. Bob writes; the boundary refuses
him — with the law's own stated reason, and no partial write behind:

```js
seq.mount('bind', 'sessions.tick', 1, { author: 'alice' });  // { ok: true }
seq.mount('bind', 'sessions.tick', 2, { author: 'bob' });
```

```
{ ok: false, gaps: [ { reason: "only the current session holder may write" } ] }
seq.get('sessions.tick') → 1        // untouched
```

## The law governs its own handoff

Here is the part that makes this a constitution and not a lookup table.
Reassigning the holder is *itself a write under `sessions.`* — so an
unsigned handoff is refused, and only alice can hand the session to bob:

```js
seq.mount('bind', 'sessions.holder', 'bob');                     // { ok: false } — unsigned
seq.mount('bind', 'sessions.holder', 'bob', { author: 'alice' }); // { ok: true }
```

After the signed handoff, the SAME law now admits bob and refuses
alice — no rule changed, only the state it reads:

```js
seq.mount('bind', 'sessions.tick', 3, { author: 'bob' });    // { ok: true }
seq.mount('bind', 'sessions.tick', 4, { author: 'alice' });  // { ok: false }
```

Because the rule is evaluated against live state, "rotate the on-call",
"transfer ownership", "freeze writes during an incident" are all data
transitions, not deployments.

## Identity: deriving inputs backward from a goal

The other half of this part is about function types that carry more
than shapes. A tool can declare what it **preserves** — input that flows
through to output — and that makes planning *backward* computable:

```js
// parse: T → T & { parsed: true }
const parse = FT.fn({
  input: FT.object({ id: FT.string().toType() }).toType(),
  output: FT.object({ parsed: FT.boolean(true).toType() }).toType(),
  preserves: '*',
}).toType();

// validate: T → T & { validated: true }, requires parsed input
const validate = FT.fn({
  input: FT.object({ parsed: FT.boolean(true).toType() }).toType(),
  output: FT.object({ validated: FT.boolean(true).toType() }).toType(),
  preserves: '*',
}).toType();
```

The goal: a record that is validated and still carries its `name`. Walk
the chain backward with `backwardInfer` — goal → what validate needs →
what parse needs:

```js
const goal = FT.object({
  validated: FT.boolean(true).toType(),
  name: FT.string().toType(),
}).toType();

const validateInput = backwardInfer(validate, goal);
const parseInput    = backwardInfer(parse, validateInput);
```

```
validate needs: { parsed, name }   // its precondition + the goal's name, traced back
parse needs:    { id, name }       // the chain bottoms out at the true required input
```

What each step *produces* is never demanded of its input (`validated`
doesn't appear upstream), and what the goal needs that no step produces
(`name`) is traced all the way back. Point this at a catalog of tool
types and "what do I need in order to reach this state" becomes a
query, not a design meeting.

Both halves of this part are the same idea at two boundaries: the write
boundary (laws decide what may become true) and the planning boundary
(identity decides what must already be true). In both cases the deciding
information is carried *in the types*, where the machine can use it.

Next: [Part 5 — attention](part5-attention.md), where the store renders
itself differently for each reader's budget — and reports what it left
out.
