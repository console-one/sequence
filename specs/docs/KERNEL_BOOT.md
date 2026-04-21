# Kernel Boot: Precise Examples

How the Sequence gets loaded, populated, and starts servicing requests.

---

## 1. The Environment Contract

An environment is anything that can:
1. Construct a Sequence
2. Register capabilities (mount `cap` entries)
3. Drive the generator loop (pull hoisted ft, push responses)
4. Persist snapshots (serialize projection, restore from snapshot)

```typescript
/**
 * The minimal interface an environment must satisfy.
 * Electron, CLI, Lambda, browser — all implement this.
 */
interface Environment {
  /** Provide a clock. Environments own time. */
  clock(): number;

  /** Load a snapshot (if one exists). Returns mount entries to replay. */
  loadSnapshot(): MountEntry[] | null;

  /** Save a snapshot. Called periodically or on shutdown. */
  saveSnapshot(projection: Readonly<Projection>, seq: number): void;

  /** Register this environment's capabilities via the mount function. */
  mountCapabilities(mount: (op: string, path: string, value: unknown, opts?: any) => any): void;
}
```

That's the contract. Three methods + a clock. Everything else is the Sequence. The process loop (generator channel) is created by `bootKernel` and returned to the caller.

---

## 2. Kernel Boot

```typescript
import { Sequence, type MountEntry, type Projection } from './sequence';
import { tokenize } from './dsl/tokenizer';
import { Parser } from './dsl/parser';
import { walk } from './dsl/walker';
import { hoist } from './hoist';

function bootKernel(env: Environment): {
  seq: Sequence;
  channel: Generator<string, void, string>;
  render: () => RenderResult;
} {
  // 1. Create the Sequence with the environment's clock
  const seq = new Sequence(env.clock);

  // 2. Load snapshot if available (resume from prior state)
  const snapshot = env.loadSnapshot();
  if (snapshot) {
    for (const entry of snapshot) seq.mount(entry.op, entry.path, entry.value);
  }

  // 3. Mount the environment's capabilities (receives mount function, not Sequence)
  env.mountCapabilities((op, path, value, opts) => seq.mount(op, path, value, opts));

  // 4. Return the Sequence, generator channel, and render function
  return { seq, channel: createChannel(seq, env), render: () => renderForReader(seq) };
}

function* channel(seq: Sequence, env: Environment): Generator<string, void, string> {
  let lastSnapshotSeq = 0;

  // Initial hoist — the first yield gives the environment the current state
  let view = hoist(seq).text;

  while (true) {
    // Yield current state as ft text, receive response as ft text
    const incoming = yield view;

    // Parse and mount the response
    const tokens = tokenize(incoming);
    const ast = new Parser(tokens).parseProgram();
    const result = walk(ast, seq);

    // Handle pending invocations — capabilities the Sequence needs invoked
    for (const mount of result.mounts) {
      if (mount.pendingInvocations) {
        for (const inv of mount.pendingInvocations) {
          // The environment resolves these — call the capability, mount the result
          // This happens in the env.run() loop, not here
        }
      }
    }

    // Snapshot periodically (every 100 blocks)
    if (seq.head - lastSnapshotSeq > 100) {
      env.saveSnapshot(seq.projection, lastSnapshotSeq);
      lastSnapshotSeq = seq.head;
    }

    // Re-hoist for next yield
    view = hoist(seq).text;
  }
}
```

---

## 3. Electron Environment (concrete example)

```typescript
import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

class ElectronEnvironment implements Environment {
  private dataPath: string;

  constructor() {
    this.dataPath = join(app.getPath('userData'), 'sequence-state.json');
  }

  clock(): number {
    return Date.now();
  }

  loadSnapshot(): MountEntry[] | null {
    if (!existsSync(this.dataPath)) return null;
    try {
      const raw = readFileSync(this.dataPath, 'utf-8');
      const state = JSON.parse(raw);
      // Convert stored state back to mount entries
      const entries: MountEntry[] = [];
      for (const [path, value] of Object.entries(state.values ?? {})) {
        entries.push({ op: 'bind', path, value });
      }
      for (const [path, schema] of Object.entries(state.schemas ?? {})) {
        entries.push({ op: 'schema', path, value: schema });
      }
      for (const [path, policy] of Object.entries(state.policies ?? {})) {
        entries.push({ op: 'policy', path, value: policy });
      }
      for (const path of state.capabilities ?? []) {
        entries.push({ op: 'cap', path, value: true });
      }
      return entries;
    } catch {
      return null;
    }
  }

  saveSnapshot(projection: Readonly<Projection>, _sinceSeq: number): void {
    const state = {
      values: Object.fromEntries(projection.values),
      schemas: Object.fromEntries(
        [...projection.schemas].map(([k, v]) => [k, v])
      ),
      policies: Object.fromEntries(projection.policies),
      capabilities: [...projection.capabilities.keys()],
    };
    writeFileSync(this.dataPath, JSON.stringify(state, null, 2));
  }

  mountCapabilities(mount: (op: string, path: string, value: unknown, opts?: any) => any): void {
    // Filesystem capability
    mount('schema', 'fs.read', FT.fn({
      input: FT.object({ path: FT.string().pattern('^/') }),
      output: FT.object({ content: FT.string(), size: FT.number().min(0) }),
    }).toType());
    mount('cap', 'fs.read', async (input: { path: string }) => {
      const content = readFileSync(input.path, 'utf-8');
      return { content, size: Buffer.byteLength(content) };
    });

    // Shell capability
    mount('schema', 'shell.exec', FT.fn({
      input: FT.object({ command: FT.string() }),
      output: FT.object({ stdout: FT.string(), exitCode: FT.number() }),
    }).toType());
    mount('cap', 'shell.exec', async (input: { command: string }) => {
      const { execSync } = require('child_process');
      try {
        const stdout = execSync(input.command, { encoding: 'utf-8' });
        return { stdout, exitCode: 0 };
      } catch (e: any) {
        return { stdout: e.stderr ?? '', exitCode: e.status ?? 1 };
      }
    });

    // IPC bridge to renderer — renderer's requests come as ft text
    // via the channel, capabilities for UI are registered here
    mount('cap', 'ui.render', true); // external — renderer fills this
  }

  async run(ch: Generator<string, void, string>): Promise<void> {
    // Initial state
    let state = ch.next().value!;

    // Process loop: handle pending invocations and tick
    const tick = () => {
      // Advance time — just mount a tick
      state = ch.next('_tick = ' + Date.now()).value!;

      // Check for pending invocations in the state
      // (hoist renders them as expansion tokens)
      // In practice, the IPC bridge sends state to renderer,
      // renderer sends ft text back, which feeds into ch.next()
    };

    // Tick on nextWake schedule
    const scheduleNext = () => {
      // Parse nextWake from the hoisted state (or compute from seq directly)
      // For now, tick every second
      setTimeout(() => {
        tick();
        scheduleNext();
      }, 1000);
    };

    scheduleNext();

    // IPC: renderer sends ft text, we feed it into the channel
    // ipcMain.on('ft-message', (event, ftText) => {
    //   state = ch.next(ftText).value!;
    //   event.reply('ft-response', state);
    // });
  }
}

// Boot
const env = new ElectronEnvironment();
const ch = bootKernel(env);
env.run(ch);
```

---

## 4. CLI Environment (concrete example)

```typescript
import * as readline from 'readline';

class CLIEnvironment implements Environment {
  clock(): number { return Date.now(); }

  loadSnapshot(): MountEntry[] | null {
    // CLI is ephemeral — no snapshot
    return null;
  }

  saveSnapshot(): void {
    // No persistence in CLI mode
  }

  mountCapabilities(mount: (op: string, path: string, value: unknown, opts?: any) => any): void {
    // CLI can read/write files
    mount('schema', 'fs.read', FT.fn({
      input: FT.object({ path: FT.string() }),
      output: FT.object({ content: FT.string() }),
    }).toType());
    mount('cap', 'fs.read', (input: { path: string }) => {
      return { content: require('fs').readFileSync(input.path, 'utf-8') };
    });

    // CLI can prompt the user
    mount('schema', 'user.input', FT.fn({
      input: FT.object({ prompt: FT.string() }),
      output: FT.object({ response: FT.string() }),
    }).toType());
    mount('cap', 'user.input', true); // external — filled by the run loop
  }

  async run(ch: Generator<string, void, string>): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

    let state = ch.next().value!;

    while (true) {
      // Display current state (ft text — includes expansion tokens for gaps)
      console.log('\n' + state);

      // Check if there are expansion tokens (gaps to fill)
      if (!state.includes('[[')) {
        console.log('\n[fully concrete — done]');
        break;
      }

      // User provides ft text (fills expansion tokens or adds new state)
      const input = await ask('\nft> ');
      if (input === 'exit') break;

      state = ch.next(input).value!;
    }

    rl.close();
  }
}
```

---

## 5. Lambda Environment (concrete example)

```typescript
class LambdaEnvironment implements Environment {
  private s3Bucket: string;
  private snapshotKey: string;

  constructor(bucket: string, key: string) {
    this.s3Bucket = bucket;
    this.snapshotKey = key;
  }

  clock(): number { return Date.now(); }

  async loadSnapshot(): Promise<MountEntry[] | null> {
    // Load from S3
    try {
      const obj = await s3.getObject({ Bucket: this.s3Bucket, Key: this.snapshotKey });
      return JSON.parse(obj.Body.toString());
    } catch {
      return null;
    }
  }

  async saveSnapshot(projection: Readonly<Projection>): Promise<void> {
    // Incremental: only save values that changed
    const state = serializeProjection(projection);
    await s3.putObject({
      Bucket: this.s3Bucket,
      Key: this.snapshotKey,
      Body: JSON.stringify(state),
    });
  }

  mountCapabilities(mount: (op: string, path: string, value: unknown, opts?: any) => any): void {
    // Lambda-specific: register what this worker can do
    mount('schema', 'compute.transform', FT.fn({
      input: FT.object({ data: FT.string(), format: FT.string() }),
      output: FT.object({ result: FT.string(), duration: FT.number() }),
    }).toType());
    mount('cap', 'compute.transform', async (input: any) => {
      const start = Date.now();
      const result = await doTransform(input.data, input.format);
      return { result, duration: Date.now() - start };
    });

    // Heartbeat: Lambda must ping the orchestrator
    mount('schema', 'heartbeat', FT.number().toType());
    // The run loop handles periodic heartbeat mounting
  }

  async run(ch: Generator<string, void, string>): Promise<void> {
    let state = ch.next().value!;

    // Lambda receives work via orchestrator channel (SQS, WebSocket, etc.)
    // For each incoming message:
    const handleMessage = (ftText: string): string => {
      state = ch.next(ftText).value!;
      return state; // response to orchestrator
    };

    // Heartbeat: mount current time every 5s
    const heartbeatInterval = setInterval(() => {
      state = ch.next('heartbeat = ' + Date.now()).value!;
    }, 5000);

    // Lambda handler
    return {
      handler: async (event: any) => {
        const response = handleMessage(event.body);
        clearInterval(heartbeatInterval);
        return { statusCode: 200, body: response };
      }
    } as any;
  }
}
```

---

## 6. Process Log and Snapshotting

The Sequence's block log IS the process log. Every mount is a block with:
- `seq` — sequence number (monotonic)
- `time` — timestamp from environment clock
- `entries` — what was mounted (op, path, value)
- `author` — who mounted it (provenance)
- `where`/`while` — conditions

### Incremental Storage

Snapshotting uses the compaction model:

```typescript
function incrementalSave(seq: Sequence, lastSavedSeq: number, store: Storage) {
  // Get blocks since last save
  const newBlocks = seq.appliedSince(lastSavedSeq);

  if (newBlocks.length === 0) return lastSavedSeq;

  // Append new blocks to the log
  store.appendBlocks(newBlocks);

  // Periodically compact: collapse old blocks into a snapshot
  if (seq.head - lastSavedSeq > 1000) {
    // Compact blocks older than 500 seq ago
    // Respects compaction policies (preserve, snapshot_every)
    seq.compact(seq.head - 500);

    // Save the compacted projection as a checkpoint
    store.saveCheckpoint(seq.projection, seq.head);
  }

  return seq.head;
}

function loadFromStorage(store: Storage): MountEntry[] {
  // Load latest checkpoint
  const checkpoint = store.loadCheckpoint();
  if (!checkpoint) return [];

  // Replay blocks since checkpoint
  const replayBlocks = store.blocksSince(checkpoint.seq);

  // Convert checkpoint projection to mount entries
  const entries: MountEntry[] = [];
  for (const [path, schema] of checkpoint.schemas) {
    entries.push({ op: 'schema', path, value: schema });
  }
  for (const [path, value] of checkpoint.values) {
    entries.push({ op: 'bind', path, value });
  }
  for (const [path, policy] of checkpoint.policies) {
    entries.push({ op: 'policy', path, value: policy });
  }
  for (const path of checkpoint.capabilities) {
    entries.push({ op: 'cap', path, value: true });
  }

  // Then replay blocks on top
  for (const block of replayBlocks) {
    entries.push(...block.entries);
  }

  return entries;
}
```

### What gets stored where:

| Layer | What | Storage |
|-------|------|---------|
| **Projection snapshot** | Current state (values, schemas, policies, caps) | JSON file / S3 / SQLite |
| **Block log** | Append-only blocks since last snapshot | Append log / WAL |
| **Compaction** | Old blocks collapsed per policy | Overwrites snapshot |
| **Capabilities** | Markers only (not implementations) | Part of projection snapshot |
| **Reliability priors** | `path._prior.reliability = { alpha, beta }` | Part of projection values |

The implementations (live functions in `implRegistry`) are NEVER persisted. They're re-registered by `env.mountCapabilities()` on every boot. The projection is fully serializable — that was the point of the C1 fix (capabilities as markers, not functions).

---

## 7. Summary: What the Environment Does

```
1. env.clock()           → provides time
2. env.loadSnapshot()    → provides prior state (or null for fresh start)
3. env.mountCapabilities → registers what this environment can do (receives mount function)
4. bootKernel(env)       → creates Sequence, loads snapshot, mounts caps, returns { seq, channel, render }
5. caller drives channel → pulls ft text (yield), pushes responses (next), handles ticks
6. env.saveSnapshot()    → persists projection periodically (called by channel internally)
```

The Sequence handles everything else: type checking, cascade, suspension, resumption, gap tracking, behavioral predicate enforcement, conjunction propagation, search, scheduling. The environment just provides time, storage, capabilities, and the process loop.
