# File System Access

A file system is the simplest contractlike surface: paths map to content, and the behavioral identity between write and read is the entire contract. Write something, read it back, get the same thing. List a directory, see what was written there. The hard part is not the operations -- it is expressing the temporal scope of these identities. After you write, the read identity holds until the next write or delete. The system must express this duration, not just the instantaneous state.

There are no side effects. Write does not "cause" a state change -- its return type includes a refinement predicate that constrains what read will return. The "effect" IS the type.

## The FileSystem Type

A file system has three operations. Read takes a path and returns content with size metadata. Write takes a path and content and returns a success indicator. List takes a directory path and returns entries. All paths must be absolute:

```ft
FileSystem = {
  read: (path: string, encoding?: string) -> { content: string, size: number >= 0, mtime: number },
  write: (path: string, content: string, createDirs?: boolean) -> { ok: true, bytesWritten: number >= 0 },
  list: (path: string, pattern?: string, recursive?: boolean) -> { name: string, isDir: boolean, size: number >= 0 }
}
```

All path parameters are constrained to absolute paths (must start with `/`). This is a pattern constraint on the `string` type -- anything without a leading slash fails at the type level, before any I/O occurs. The optional parameters (`encoding`, `createDirs`, `recursive`) are structural -- the caller may omit them.

## Behavioral Identities

The structural type above defines the shape of operations. The behavioral contract defines what those operations *mean* relative to each other. These identities cannot be expressed in the parser's current syntax, so they live here as prose:

- **Size-content identity**: `read(p).size` always equals `byteLength(read(p).content)`. This is atemporal -- it holds for every call, always.
- **Write-read identity**: After `write(p, content)` returns, `read(p).content = content`. This holds from write's return time until the next write to the same path (or deletion). External mutations may break it -- the survival probability accounts for this.
- **Write-list consistency**: After `write(p, content)` returns, `list(parent(p))` includes an entry with the basename of `p`. This holds until the file is deleted.
- **Bytes-written identity**: `write(p, content).bytesWritten = byteLength(content)`. Atemporal.

These are refinement predicates on the return types. They are not separate "law" declarations -- they ARE the return type, constraining what subsequent operations will observe.

These identities are enforced at runtime through predicate observation. When a value changes at a path governed by an identity (e.g., `read(p)` after `write(p, content)`), the Sequence checks whether the observation matches the commitment. If `read` returns the content that `write` committed, the reliability prior's alpha increments, strengthening confidence that the identity holds. If it doesn't -- because an external process mutated the file, or the filesystem silently truncated -- beta increments, degrading confidence. The posterior predictive `P(next observation matches) = alpha / (alpha + beta)` is stored at `fs._prior.reliability` and feeds directly into the survival function's probability, which in turn affects gap prioritization during feasibility computation.

## Instantiation

A concrete file system is an instance of the type. The capabilities are registered so the system knows it can call them:

```ft
localFs = FileSystem
tool localFs.read
tool localFs.write
tool localFs.list
```

When the agent needs file content, backward inference finds `localFs.read` because its output type matches the need. When the agent writes a file, the system knows that `localFs.read` on the same path will return the written content -- not because of a separate rule, but because write's return type says so.

## Composition with Auditable Behavior

The file system can be composed with an auditing layer. Every read and write is recorded in history, enabling "what was accessed and when" queries:

```ft
AuditableFS = {
  read: (path: string) -> { content: string },
  write: (path: string, content: string) -> { ok: true }
}
```

Auditable behavior means that after any call, a history entry exists for that call. This is a cross-cutting behavioral identity:

- After `read(p)` returns, `history.exists(read, p)` holds permanently.
- After `write(p, c)` returns, `history.exists(write, p, c)` holds permanently.

Composing `FileSystem & AuditableFS` gives a file system where every operation both satisfies the read-write identities AND records itself in history.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Read returns content + size + mtime | `read` return type in FileSystem |
| Write returns ok + bytesWritten | `write` return type in FileSystem |
| List returns entries with metadata | `list` return type in FileSystem |
| Absolute paths enforced | Prose: pattern constraint on `string` path params (must start with `/`) |
| Write-read identity holds after write | Prose: write return constrains subsequent read (temporal scope) |
| Written file appears in directory listing | Prose: write-list consistency identity |
| Size equals byte length of content | Prose: size-content atemporal identity |
| Backward inference discovers read for content needs | `cap localFs.read` registration |
