# Stream API

A stream is an ordered, append-only sequence of typed items under a common path prefix. Chat messages, event logs, agent interaction records -- they all reduce to the same pattern: indexed children under a prefix with a schema constraining their shape. The design constraint is that streams must NOT be a special-cased type. They emerge from existing primitives: path hierarchy, schema declaration at a prefix, and sequential index convention.

The hard part is not the data model (it's trivially an indexed collection). The hard part is that schema enforcement, enumeration, random access, and multi-stream isolation must all work without introducing any stream-specific operations.

## The Stream Type

A stream is a path prefix with a schema. Items are children at sequential indices. The schema at the prefix constrains every child:

```ft
Stream = {
  schema: { role: string, content: string },
  count: number >= 0
}
```

The schema is not stored per-item. It is declared once at the prefix. Every item written to an indexed child must conform.

## Writing Items

Producers append items to the next sequential index. Each item is a value write to an indexed child path. Three items in a message stream:

```ft
messages = Stream
messages << { schema: { role: string, content: string } }
messages.0 = { role: "system", content: "You are a helpful assistant." }
messages.1 = { role: "user", content: "Hello" }
messages.2 = { role: "assistant", content: "Hi there." }
```

Each `messages.N` is a separate path. The schema at `messages` constrains all of them. A write to `messages.3` with `role: 123` would be rejected because it violates the prefix schema (role must be a string).

## Reading Items

Consumers enumerate children at the prefix to get all items, or read a specific index for random access:

```ft
-- List keys at "messages" returns ["0", "1", "2"]
-- Read messages.1 returns { role: "user", content: "Hello" }
-- Count of keys = 3
```

There is no stream-specific read operation. Listing children and reading by path are the same operations used everywhere else.

## Multiple Independent Streams

Different streams live under different prefixes. They share no state and cannot interfere with each other. Each has its own schema:

```ft
events = Stream
events << { schema: { kind: string, timestamp: number } }
events.0 = { kind: "login", timestamp: 1700000000 }

logs = Stream
logs << { schema: { level: string, message: string } }
logs.0 = { level: "info", message: "Started" }
```

Reading `events` returns only event items. Reading `logs` returns only log items. The prefixes are independent namespaces.

## Capabilities

Stream operations are externally provided -- producers mount items, consumers read the prefix:

```ft
cap Stream.schema
cap messages.0
cap messages.1
cap messages.2
```

No special "append" capability exists. Writing to the next index IS the append.

## What This Validates

| AC | Expressed by |
|----|-------------|
| 3 items written to sequential indices are retrievable in order | `messages.0`, `messages.1`, `messages.2` as separate path writes |
| Schema at prefix rejects non-conforming items | `messages << { schema: { role: string, content: string } }` constrains all children |
| Conforming items are accepted | `messages.1 = { role: "user", content: "Hello" }` satisfies the schema |
| Key enumeration returns all indices in order | Listing children at `messages` returns `["0", "1", "2"]` |
| Random access by index works | Reading `messages.1` returns the correct item |
| Multiple streams coexist independently | `events` and `logs` under separate prefixes with separate schemas |
| No stream-specific operations involved | Only path hierarchy, schema declaration, and value writes are used |
