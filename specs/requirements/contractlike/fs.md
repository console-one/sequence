# File System Access

A file system is the simplest contractlike surface: paths map to content, and the behavioral identity between write and read is the entire contract. Write something, read it back, get the same thing. List a directory, see what was written there. The hard part is not the operations -- it is expressing the temporal scope of these identities. After you write, the read identity holds until the next write or delete. The system must express this duration, not just the instantaneous state.

There are no side effects. Write does not "cause" a state change -- its return type includes a refinement predicate that constrains what read will return. The "effect" IS the type.

## Problem Context

- **Actor(s)**: Agents reading/writing files; external processes that may concurrently modify the file system.
- **Domain**: Local or remote file system access -- reading file content, writing files, listing directory entries.
- **Core Tension**: The behavioral identities (write-read, write-list, size-content) have temporal scope -- they hold from the moment of write until the next mutation. External processes can break these identities at any time, so the system must track confidence in their continued validity rather than assuming they hold forever.

## Requirements

**R1**: The `read` operation SHALL accept an absolute path and return the file's content, byte size, and last-modified timestamp.
- *Rationale*: Agents need content for processing, size for resource estimation, and mtime for staleness detection.
- *Verifiable by*: Reading an existing file returns all three fields with correct values.

**R2**: The `write` operation SHALL accept an absolute path and content string, and return a success indicator and the number of bytes written.
- *Rationale*: Agents need confirmation that the write succeeded and how much data was persisted.
- *Verifiable by*: Writing content to a path returns `{ok: true, bytesWritten: N}` where N matches the byte length of the content.

**R3**: The `list` operation SHALL accept an absolute directory path and return entries with name, directory flag, and size for each item.
- *Rationale*: Agents need to enumerate directory contents to discover files, distinguish files from subdirectories, and estimate sizes.
- *Verifiable by*: Listing a directory with known contents returns an entry for each item with correct metadata.

**R4**: All path parameters SHALL be constrained to absolute paths (starting with `/`). A relative path SHALL be rejected before any I/O occurs.
- *Rationale*: Relative paths are ambiguous without a working directory context. Requiring absolute paths eliminates a class of bugs.
- *Verifiable by*: Calling any operation with a path like `"foo/bar"` (no leading slash) is rejected with a constraint error.

**R5**: After a successful `write(path, content)`, a subsequent `read(path)` SHALL return `content` as the file's content, provided no intervening write or delete to that path has occurred.
- *Rationale*: This is the fundamental write-read identity. Without it, the file system abstraction is meaningless.
- *Verifiable by*: Write "hello" to `/tmp/test.txt`, then read `/tmp/test.txt` -- the content is "hello".

**R6**: After a successful `write(path, content)`, `list(parent(path))` SHALL include an entry with the basename of `path`, provided no intervening delete of that path has occurred.
- *Rationale*: A written file must appear in its parent directory listing. This is the write-list consistency identity.
- *Verifiable by*: Write to `/tmp/test.txt`, then list `/tmp/` -- an entry named "test.txt" is present.

**R7**: For any successful `read(path)`, the returned `size` SHALL equal the byte length of the returned `content`.
- *Rationale*: Size and content must be internally consistent. A size that disagrees with the content length indicates a corrupted read.
- *Verifiable by*: For any read result, `byteLength(result.content) === result.size`.

**R8**: The `write` operation SHALL optionally accept a `createDirs` flag. When true, intermediate directories SHALL be created if they do not exist.
- *Rationale*: Agents should not need to manually create directory hierarchies before writing files.
- *Verifiable by*: Writing to `/tmp/a/b/c/file.txt` with `createDirs: true` succeeds even if `/tmp/a/b/c/` does not exist.

**R9**: The system SHALL track the reliability of behavioral identities (write-read, write-list) over time, accounting for external mutations that may break them.
- *Rationale*: On a shared file system, external processes may modify files between write and read. The system must degrade confidence rather than blindly asserting identities hold.
- *Verifiable by*: After an external process modifies a file that was previously written, the system's confidence in the write-read identity for that path decreases.

**R10**: File system read, write, and list operations SHALL be discoverable by agents that need file content or need to persist data.
- *Rationale*: When an agent needs file content, the system should identify `read` as a means to obtain it without hardcoded knowledge.
- *Verifiable by*: When an agent requires string content from a file path, the system identifies `read` as the relevant operation.

## Acceptance Criteria

**AC1** [R1]: Given a file at `/tmp/test.txt` with content "hello" (5 bytes), when reading `/tmp/test.txt`, then the result is `{content: "hello", size: 5, mtime: <timestamp>}`.

**AC2** [R2]: Given no file at `/tmp/new.txt`, when writing "world" to `/tmp/new.txt`, then the result is `{ok: true, bytesWritten: 5}`.

**AC3** [R4]: Given any operation called with path `"relative/path"`, then the operation is rejected with a constraint error before any I/O.

**AC4** [R5]: Given `write("/tmp/test.txt", "alpha")` succeeds, when `read("/tmp/test.txt")` is called with no intervening mutation, then `result.content === "alpha"`.

**AC5** [R6]: Given `write("/tmp/test.txt", "data")` succeeds, when `list("/tmp/")` is called, then an entry with `name: "test.txt"` is present.

**AC6** [R7]: Given any successful `read(path)`, then `byteLength(result.content) === result.size`.

**AC7** [R8]: Given `/tmp/deep/` does not exist, when `write("/tmp/deep/nested/file.txt", "data", createDirs: true)`, then the write succeeds and the file is created.

**AC8** [R9]: Given `write("/tmp/test.txt", "v1")` succeeds, when an external process overwrites `/tmp/test.txt` with "v2", then the system's confidence that `read("/tmp/test.txt")` returns "v1" decreases.

## FT System Demands

- Behavioral identities (R5, R6, R7) have temporal scope: they hold from one operation until the next contradicting operation. The type system must express "this property holds from time T1 until time T2."
- Reliability tracking (R9) requires a mechanism to observe whether predicted outcomes match actual outcomes and update confidence accordingly. This is a Bayesian prior update pattern.
- Cross-cutting auditability (recording every read/write in history) should be composable with the file system interface without modifying the core type definitions.
