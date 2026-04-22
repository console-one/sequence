/**
 * sequence.ts — The kernel. Mount + fire laws + project.
 *
 * A Sequence is an append-only block log with a derived projection.
 * mount() is the single operation: append entries, fire laws until stable.
 * Laws replace all internal mechanisms (cascade, resume, invalidation,
 * behavioral commitments, conjunction updates).
 *
 * The projection IS the interface. Another sequence reads it via
 * get()/typeAt(). fn types at unfilled paths ARE the gaps.
 *
 * CASCADE ORDERING (intentional semantics):
 * fireLaws processes one path at a time from a BFS queue. Each derived
 * value is computed against the CURRENT projection (including mutations
 * from earlier cascade steps in the same mount). This means cascade order
 * can affect outcome when multiple derived values share dependencies.
 * This is intentional: it matches append-only semantics where later
 * statements see the effects of earlier ones. The visited set prevents
 * infinite loops but allows sequential propagation.
 *
 * CHANGE TRACKING:
 * MountResult.changes contains every path mutation (direct, cascade,
 * invalidate, resume) with old/new values. This is the pull-based
 * notification mechanism — callers inspect changes after mount() returns.
 */

import { type MountEntry, type Block, type BlockOpts } from './statement';
import { type Type, type Constraint, constraintOf, constraintsOf, isAny, isNever, properties } from './type';
import { check, type Gap, compose, covers, backwardInfer, typeSpecificity, evaluateExpr, cdf, survival, posteriorPredictive, conjugateUpdate, type DistParams } from './compose';
import { runAdmissionLaws } from './laws';

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

/**
 * A Map<string, V> with an incrementally-maintained children index.
 *
 * Every set/delete updates a `parent → segment → refcount` index of
 * each inserted path's ancestor prefixes. `childSegments(parent)`
 * then returns the direct child segments of any prefix in O(1) —
 * the primitive the kernel's `keys(prefix)` rides on, and the
 * foundation every other structural index (block log, label
 * backlinks, consumer-declared `indexSpec` projections) sits above.
 *
 * Without this, `keys(prefix)` scans every path in the Map on every
 * call, and consumer index classes that `bindFrom($var, 'prefix.*')`
 * pay that linear scan per fixpoint pass per class per mount — the
 * quadratic amplification that blocked the earlier block-log mirror
 * (see SEQUENCE_NODES.md). With it, the primitive is cheap enough
 * to carry the full block log plus arbitrary consumer indexes.
 *
 * Refcounting handles the "sibling path still exists" case: removing
 * `a.b.c` while `a.b.d` still exists keeps `b` as a child of `a`
 * because the segment count at that depth stays positive.
 */
export class PathMap<V> extends Map<string, V> {
  private _children = new Map<string, Map<string, number>>();

  set(path: string, value: V): this {
    if (!super.has(path)) this.addChild(path);
    super.set(path, value);
    return this;
  }

  delete(path: string): boolean {
    if (super.has(path)) this.removeChild(path);
    return super.delete(path);
  }

  clear(): void {
    super.clear();
    this._children.clear();
  }

  /** O(1) direct-child segments under `parent`. Empty string `''`
   *  is the root — returns the top-level segments. */
  childSegments(parent: string): readonly string[] {
    const m = this._children.get(parent);
    return m ? [...m.keys()] : [];
  }

  private addChild(path: string): void {
    const parts = path.split('.');
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('.');
      const segment = parts[i];
      let segMap = this._children.get(parent);
      if (!segMap) {
        segMap = new Map();
        this._children.set(parent, segMap);
      }
      segMap.set(segment, (segMap.get(segment) ?? 0) + 1);
    }
  }

  private removeChild(path: string): void {
    const parts = path.split('.');
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('.');
      const segment = parts[i];
      const segMap = this._children.get(parent);
      if (!segMap) continue;
      const count = segMap.get(segment);
      if (count === undefined) continue;
      if (count <= 1) {
        segMap.delete(segment);
        if (segMap.size === 0) this._children.delete(parent);
      } else {
        segMap.set(segment, count - 1);
      }
    }
  }
}

/**
 * Per-path record in the unified constraint store.
 *
 * Claims are grouped by OWNER — the lifecycle holder of the
 * narrowing. An owner is a synthetic id that names who can later
 * replace or release the claim:
 *
 *   `bind:${author}`        — author's overwriteable bind value
 *   `schema:${author}`      — author's schema declaration
 *   `commitment:${id}`      — held by an active commitment
 *   `kernel`                — kernel-internal mounts (_rt, _exec, ...)
 *
 * The slot's effective region is the meet (intersection) of every
 * owner's claims. The kernel rejects writes whose meet would be
 * `never`. When an owner releases (e.g. a commitment is revoked),
 * `releaseOwner` drops their claims and the aggregate recomputes —
 * other owners' claims persist.
 *
 * Segments aren't pre-decided per kind; they're declared by claim
 * mounts and grow via projection conjunctions promoted by the
 * cascade (LEARNING_AS_COMPRESSION.md).
 */
export type ConstraintNode = {
  kind?: import('./type').Kind;
  claims: Map<string, Constraint[]>;
  meta?: import('./type').TypeMeta;
};

/** Build a synthetic owner id for a bind by `author`. Two writes
 *  from the same author via different ops (bind vs schema) own
 *  separate slots and don't collide. */
export function bindOwner(author: string | undefined): string {
  return `bind:${author ?? 'anon'}`;
}

/** Build a synthetic owner id for a schema mount by `author`. */
export function schemaOwner(author: string | undefined): string {
  return `schema:${author ?? 'anon'}`;
}

/** Build a synthetic owner id for a commitment-held claim. */
export function commitmentOwner(commitmentId: string): string {
  return `commitment:${commitmentId}`;
}

/** Default owner for kernel-internal bind writes (sidecar paths
 *  like _rt, _exec, _blocks that aren't author-owned). */
const KERNEL_BIND_OWNER = 'bind:kernel';

/** Default owner for kernel-internal schema writes. */
const KERNEL_SCHEMA_OWNER = 'schema:kernel';

export type Projection = {
  /** The unified constraint store. One entry per path. Every constraint
   *  observable at the path lives here — kind, properties, refs,
   *  laws, behavioral predicates — plus the bind value (boundValue
   *  slot). The single source of truth per CONSTRAINT_GRAPH.md
   *  Artifact 5. */
  nodes: PathMap<ConstraintNode>;
  /** Registered capability markers — true means a capability exists at this path. Serializable. */
  capabilities: Map<string, true>;
  policies: Map<string, { transition?: string; interpolate?: string; compact?: 'preserve' | 'default' | number }>;
  /**
   * Forward dependency cache: source path → set of dependent paths.
   * This is a COMPILED FAST PATH over the canonical data in `nodes`
   * at `_deps.{source}`. fireLaws reads from here for O(1).
   */
  depIndex: Map<string, Set<string>>;
  /** Reverse dependency cache: dependent path → set of source paths. Fast path over _rdeps.{dep}. */
  reverseDepIndex: Map<string, Set<string>>;
};

/** A capability invocation that the Sequence needs but cannot execute internally. */
export type PendingInvocation = {
  toolId: string;
  args: unknown[];
  targetPath: string;
};

/** A single path mutation that occurred during a mount (direct, cascade, invalidation, or resume). */
export type PathChange = {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  cause: 'direct' | 'cascade' | 'invalidate' | 'resume';
  /** Wall-clock time of this change (_rt). The only monotonic measure of state evolution. */
  time: number;
  /** Which block seq# originated this change. */
  sourceBlock?: number;
  /** Which backward entry fired (for cascade/resume/invalidate). */
  lawId?: string;
};

export type MountResult = {
  ok: boolean;
  blockSeq: number;
  gaps?: Gap[];
  invalidated?: string[];
  resumed?: number[];
  cascaded?: string[];
  /** Capabilities the Sequence needs invoked externally. */
  pendingInvocations?: PendingInvocation[];
  /** All path mutations during this mount. */
  changes?: PathChange[];
  /** Paths evicted from working set (scored below budget). */
  evicted?: string[];
  /** Paths promoted back into working set (scored above threshold). */
  promoted?: string[];
  /** Identity of the actor that authored this block (BlockOpts.author
   *  on the outermost mount). onBlockApplied observers use this to
   *  decide whether to forward the block to other peers — e.g., a
   *  Sequence-node composition forwards peer-authored mounts to
   *  upstream but NOT upstream-authored mounts (would echo-loop).
   *  See specs/docs/SEQUENCE_NODES.md. */
  author?: string;
  nextWake: number;
  /** Set ONLY when this mount triggered an async fn-cap invocation
   *  (impl returned a Promise). Resolves when the impl's Promise
   *  settles — with the resolved value on success, or {error} on
   *  reject. Fire-and-forget callers ignore it; imperative callers
   *  that want to await the cap's outcome use this to bridge JS
   *  Promise semantics with the kernel's async-cap result mount. */
  toolCompletion?: Promise<{
    ok: boolean;
    output?: unknown;
    error?: string;
    latencyMs: number;
  }>;
};

export type GapInfo = { path: string; type: Type; priority: number; capabilities: string[]; inputsNeeded?: Type };

/**
 * Concreteness as a computed distribution — transient, not stored.
 *
 * Returned by Sequence.concretenessDistribution(path, seq?). The
 * three factors are structurally present (completion, type-survival,
 * provenance); each is a function of time. The composed cdf is their
 * product.
 *
 * This is not a lattice value type — it's a computation over the fn-IO
 * chain and ancestor type chain for a path, evaluated on demand. It has
 * no home in the projection's constraint store.
 */
export interface ConcretenessDistribution {
  /** P(path realized-and-interpretable by time t), combining all three factors. */
  cdf(t: number): number;
  /** Individual factor functions, each P(contribution by time t). */
  factors: {
    completion: (t: number) => number;
    typeSurvival: (t: number) => number;
    provenance: (t: number) => number;
  };
}
export type SearchPlan = { meetable: boolean; steps: SearchStep[]; gaps: { type: Type; reason: string }[]; probability: number };
export type SearchStep = { capabilityId: string; requiredOutput: Type; requiredInput: Type; inputReady: boolean };
type CapInfo = { id: string; fnType: Type; inputType: Type; outputType: Type };

// ═══════════════════════════════════════════════════════════════════════
// BACKWARD INDEX — unified law dispatch
// ═══════════════════════════════════════════════════════════════════════
// Every reaction in the Sequence (cascade, resume, invalidation,
// behavioral predicates, conjunction propagation) is a backward-inferred
// entry: "when these watch paths change, re-evaluate this condition and
// fire this consequent." The backward index unifies all five into one
// Map<watchPath, Set<BackwardEntry>>.

type BackwardEntry =
  | { kind: 'cascade'; id: string; targetPath: string; fnId: string; argPaths: string[] }
  | { kind: 'resume'; id: string; blockSeq: number; watchPaths: string[] }
  | { kind: 'invariant'; id: string; blockSeq: number; watchPaths: string[] }
  | { kind: 'behavioral'; id: string; sourcePath: string; observePath: string; priorPath: string }
  | { kind: 'conjunction'; id: string; blockSeq: number; refs: string[]; consequence: string };

function emptyProjection(): Projection {
  return { nodes: new PathMap(), capabilities: new Map(), policies: new Map(), depIndex: new Map(), reverseDepIndex: new Map() };
}

/** Random hex identifier for a Sequence that wasn't given one. Not
 *  cryptographic — collision avoidance is probabilistic. 12 hex
 *  chars = 48 bits, more than enough for typical topologies. */
function randomIdentity(): string {
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// PARTITIONS — semantic classification of every mount path
// ═══════════════════════════════════════════════════════════════════════
// Six partitions per PARTITION_MODEL.md. The partition is a dimension of
// TYPE — a type can declare `partition('id')` via the type-level partition
// constraint, and that declaration wins over path prefix. When a type
// doesn't declare one (or the mount has no schema), we fall back to the
// lexical prefix match. Internal paths (_*) bypass partition checks —
// they are kernel infrastructure.
//
// The model doc (PARTITION_MODEL.md §"Recommended Concrete Encoding")
// calls out explicitly that prefixes are a surface encoding and the
// partition must drive persistence / visibility / lifecycle / indexing
// policy. Making partitionOf type-aware is the first step toward that:
// callers with schema in scope now get the type-declared partition even
// when their mount path doesn't carry the canonical prefix.

export type Partition = 'state' | 'proc' | 'id' | 'req' | 'chan' | 'proj';

const PARTITION_PREFIXES: Record<string, Partition> = {
  state: 'state',
  proc: 'proc',
  id: 'id',
  req: 'req',
  chan: 'chan',
  proj: 'proj',
};

const ALL_PARTITIONS: ReadonlySet<Partition> = new Set<Partition>([
  'state', 'proc', 'id', 'req', 'chan', 'proj',
]);

// ═══════════════════════════════════════════════════════════════════════
// SEGMENTED STRING PROJECTION
// ═══════════════════════════════════════════════════════════════════════
//
// A `kind:'string'` Type with `segment(...)` constraints projects to
// the concatenation of its segments' resolved values. Each segment's
// inner Type carries either a `literal` (constant text) or a `ref`
// (substrate-path lookup). Unfilled refs render as `{{path}}` so the
// projection sharpens as deps land — concreteness aligns with the
// substrate's productivity story.
//
// This is the substrate's general-purpose "narrative with holes":
// templates, derivations, transclusions all flow through the same
// segment + ref + cascade machinery. No special template op.
// `template(text)` in type.ts is a constructor that builds this
// shape; the kernel sees only segments and refs.

/** Read a path via the kernel's normal projection lookup. */
type SegRead = (path: string) => unknown;

/**
 * Compute the concatenated projection of a string-typed Type with
 * segment constraints. Returns undefined when the Type has no
 * segments (caller should fall through to whatever default applies).
 */
function projectSegmentedString(type: Type, read: SegRead): string | undefined {
  if (type.kind !== 'string') return undefined;
  const segs = type.constraints.filter(c => c.op === 'segment');
  if (segs.length === 0) return undefined;
  let out = '';
  for (const seg of segs) {
    const segType = seg.args[1] as Type | undefined;
    if (!segType) continue;
    const lit = segType.constraints?.find(c => c.op === 'literal');
    if (lit) { out += String(lit.args[0] ?? ''); continue; }
    const ref = segType.constraints?.find(c => c.op === 'ref');
    if (ref) {
      const target = ref.args[0] as string;
      const v = read(target);
      out += (v === undefined || v === null) ? `{{${target}}}` : String(v);
      continue;
    }
    // Segment with neither literal nor ref — treat as empty.
  }
  return out;
}


/**
 * Extract the partition declared by a type, if any. Walks the type's
 * constraints for the first `partition(p)` entry and returns it. A
 * type with no partition constraint returns undefined.
 */
export function partitionOfType(type: Type | undefined): Partition | undefined {
  if (!type || !type.constraints) return undefined;
  for (const c of type.constraints) {
    if (c.op === 'partition') {
      const p = c.args[0] as string;
      if (ALL_PARTITIONS.has(p as Partition)) return p as Partition;
    }
  }
  return undefined;
}

/**
 * Derive partition from a path, optionally informed by the type at
 * that path. When a type declares `partition(...)`, the declaration
 * wins over path prefix. Internal paths (_*) always return 'state'.
 * Type-less calls fall back to the original prefix match, preserving
 * backwards compatibility with every existing caller.
 */
export function partitionOf(path: string, type?: Type): Partition {
  if (path.startsWith('_')) return 'state';
  const declared = partitionOfType(type);
  if (declared) return declared;
  const dot = path.indexOf('.');
  const prefix = dot === -1 ? path : path.slice(0, dot);
  return PARTITION_PREFIXES[prefix] ?? 'state';
}

/**
 * Allowed reference directions per partition.
 * "state may reference state, id" means a path in the state partition
 * can depend on paths in state or id partitions.
 */
const ALLOWED_REFS: Record<Partition, ReadonlySet<Partition>> = {
  state: new Set(['state', 'id']),
  proc:  new Set(['state', 'id', 'req', 'chan', 'proc']),
  id:    new Set(['id', 'state']),
  req:   new Set(['state', 'id', 'chan', 'req']),
  chan:  new Set(['id', 'req']),
  proj:  new Set(['state', 'proc', 'id', 'req', 'chan', 'proj']),
};

/** Persistence rules per partition. */
const PARTITION_PERSISTENCE: Record<Partition, 'required' | 'policy' | 'never'> = {
  state: 'required',
  id:    'required',
  req:   'required',
  proc:  'policy',
  chan:  'policy',
  proj:  'never',
};

/** Authority rules per partition. */
const PARTITION_AUTHORITY: Record<Partition, boolean> = {
  state: true,
  proc:  true,
  id:    true,
  req:   true,
  chan:  true,
  proj:  false,
};

/**
 * Direction check between two already-resolved partitions. Internal
 * paths (_*) bypass the check unconditionally — they are kernel
 * infrastructure. Callers compute the partitions with type info
 * (via `partitionOf(path, type)`) before invoking so type-declared
 * partitions win over path prefix.
 */
function partitionDirectionAllowed(
  fromPath: string,
  toPath: string,
  fromPartition: Partition,
  toPartition: Partition,
): boolean {
  if (fromPath.startsWith('_') || toPath.startsWith('_')) return true;
  return ALLOWED_REFS[fromPartition].has(toPartition);
}

// ═══════════════════════════════════════════════════════════════════════
// SEQUENCE
// ═══════════════════════════════════════════════════════════════════════

export class Sequence {
  private blocks: Block[] = [];
  private nextBlockSeq = 0;
  private clock: () => number;
  private proj: Projection = emptyProjection();
  private invalidatedBlocks = new Set<number>();
  private resumedBlocks = new Set<number>();
  /** O(1) block lookup by sequence number. */
  private blockBySeq = new Map<number, Block>();
  /**
   * Unified backward index: watch path → backward entries that fire when that path changes.
   * Subsumes the old depIndex-for-cascade, suspendedByPath, activeWhiles, activePredicates,
   * and conjIndex. One index, one dispatch loop in fireLaws.
   */
  private backwardIndex = new Map<string, Set<BackwardEntry>>();
  /** All backward entries by ID, for O(1) removal. */
  private backwardEntries = new Map<string, BackwardEntry>();
  /** Cached conjunction probability: conjunction key → probability. */
  private conjProbCache = new Map<string, number>();
  /** Cached gap priority: path → priority. Updated on delta, not recomputed. */
  private gapPriorityCache = new Map<string, number>();
  /** Test observability only — size of the priority cache. */
  get _priorityCacheSize(): number { return this.gapPriorityCache.size; }
  /**
   * Glob dep index: prefix → dependents. When a derived constraint has an
   * argPath ending in `.*`, the prefix (without `.*`) is indexed here with
   * the dependent path. fireLaws walks ancestor prefixes of each changed
   * path to fire glob-arg derived cascades.
   *
   * This is the cascade's support for subspace subscriptions — the same
   * machinery serves aggregate computations, reader emissions, and any
   * other "react to any in-scope change" pattern, without a new BackwardEntry kind.
   */
  private globDepIndex = new Map<string, Set<string>>();
  /** Stash for the latest async cap completion's Promise — picked up
   *  by mount()'s result builder so imperative callers can await. */
  private pendingToolCompletion: Promise<{ ok: boolean; output?: unknown; error?: string; latencyMs: number }> | undefined;
  /** Re-entry guard for runIndexConstraints. Class bodies mount
   *  their per-tuple entries via this.mount(), which re-enters
   *  mount() and would otherwise trigger another index-constraint
   *  pass. Guarded so the outermost pass handles all cascaded mounts. */
  private instantiatingIndex = false;
  /** Counter incremented by applyEntry whenever a bind actually
   *  changes a value (new path, or new value at existing path).
   *  runIndexConstraints uses this as a fixpoint signal: a pass that
   *  produces zero real mutations is the convergence point — even
   *  though every sub-mount advances head and updates _rt, only
   *  changed user-data counts as "new work". */
  private mutationCount = 0;
  /** Frozen time for a single cascade. The outermost mount reads the
   *  clock once; every nested mount triggered during that cascade
   *  (law frame bookkeeping, index-class body mounts, etc.) reads
   *  back this same value. Null means the next mount is outermost
   *  and should capture a fresh clock reading. */
  private cascadeTime: number | null = null;
  /** Post-mount observers. Each is called with the MountResult of a
   *  successful outer mount (not nested body mounts — those are
   *  part of the same cascade). Use cases: persistence hooks,
   *  delta forwarders, external caches. Observer callbacks must
   *  not themselves call `mount()`; nested mounts should live in
   *  index-class bodies instead. */
  private blockObservers: Array<(result: MountResult) => void> = [];

  /** Auto-promotion threshold. When a positive integer, every
   *  outermost cascade fixpoint runs `promoteRefinements({minEvidence})`
   *  so observed regularities become declared constraints without
   *  external prompting. Infinity = disabled. Configure via
   *  `enableLearning(n)`. */
  private learningThreshold: number = Infinity;

  /** Turn on observation-driven constraint promotion. After every
   *  outermost mount cascade, the substrate scans the block log for
   *  paths with at least `minEvidence` distinct bind values and
   *  mounts the lattice-join as an owned claim. The same algorithm
   *  as `promoteRefinements`, fired automatically. */
  enableLearning(minEvidence: number = 5): void {
    this.learningThreshold = minEvidence;
  }

  /** Disable auto-promotion (the default). Manual `promoteRefinements`
   *  calls still work. */
  disableLearning(): void {
    this.learningThreshold = Infinity;
  }

  /** Register a callback that fires after every outer mount
   *  completes. Returns an unregister function. */
  onBlockApplied(cb: (result: MountResult) => void): () => void {
    this.blockObservers.push(cb);
    return () => {
      const i = this.blockObservers.indexOf(cb);
      if (i >= 0) this.blockObservers.splice(i, 1);
    };
  }
  /**
   * Pointer to the entries array of the block currently being
   * mounted. applyEntry uses this to append synthetic log entries
   * for fn invocation side-effects (`.input`, `.result`) so
   * `getAt(path, seq)` can retrieve per-call IO from the log
   * itself — no shadow snapshots required.
   */
  private currentBlockEntries: MountEntry[] | null = null;
  /** The block author for the mount currently being applied. Used by
   *  applyEntry's bind/schema/delete handlers to assign the correct
   *  owner to each claim. Reset to undefined between outer mounts. */
  private currentBlockAuthor: string | undefined = undefined;
  /**
   * Runtime-only capability implementations. NOT part of the serializable projection.
   * When a Function is passed to mount('cap'), it goes here. The projection only gets
   * a marker (true). For external invocation, pass a descriptor or true instead of a
   * function, and handle PendingInvocations from MountResult.
   */
  private implRegistry = new Map<string, Function>();
  lockExpiry: number = Infinity;

  /** Stable identifier for this Sequence. Scopes per-process state
   *  (block log at `_blocks.{identity}.{seq}.*`, and by extension
   *  anything derived from block state) so deltas from a peer can
   *  land at the receiver without colliding with the receiver's own
   *  block counter. Generated at construction when not supplied — a
   *  random hex suffices for single-process use; distributed
   *  topologies should pass their own identity (session id, node
   *  name, etc.) so observers can address a specific peer's log. */
  readonly identity: string;

  constructor(clock?: () => number, initial?: MountEntry[], identity?: string) {
    this.clock = clock ?? (() => Date.now());
    this.identity = identity ?? randomIdentity();
    // Bootstrap partition rules as readable values — the Sequence
    // describes its own partition semantics as type state.
    for (const p of ['state', 'proc', 'id', 'req', 'chan', 'proj'] as Partition[]) {
      this._writeBind(`_partitions.${p}.persistence`, PARTITION_PERSISTENCE[p]);
      this._writeBind(`_partitions.${p}.authoritative`, PARTITION_AUTHORITY[p]);
      this._writeBind(`_partitions.${p}.allowedRefs`, [...ALLOWED_REFS[p]]);
    }
    if (initial) this.mount(initial);
  }

  get lockRemaining(): number { return Math.max(0, this.lockExpiry - this.clock()); }
  get realtime(): number { return this.clock(); }
  get head(): number { return this.nextBlockSeq; }

  // CONSTRAINT GRAPH (CONSTRAINT_GRAPH.md HC1+HC6, owner-tagged)
  //
  // proj.nodes is the sole store. A node carries {kind?, claims, meta?}
  // where claims: Map<owner, Constraint[]>. The owner is the lifecycle
  // holder; releaseOwner drops everything they claimed.

  /** Aggregate the path's claims into a flat constraint list — the
   *  view compose/check use. Claims appear in stable owner-key order. */
  private _aggregateConstraints(node: ConstraintNode): Constraint[] {
    const out: Constraint[] = [];
    for (const cs of node.claims.values()) for (const c of cs) out.push(c);
    return out;
  }

  /** Value at `path` — the most recent literal/bound across all
   *  claims. Bind owners write `bound(v)`; schema owners may write
   *  `literal(v)`. Either surfaces as the path's value. */
  private _leafValueAt(path: string): unknown {
    const node = this.proj.nodes.get(path);
    if (!node) return undefined;
    let lit: unknown = undefined;
    for (const cs of node.claims.values()) {
      for (let i = cs.length - 1; i >= 0; i--) {
        if (cs[i].op === 'bound') return cs[i].args[0];
        if (cs[i].op === 'literal' && lit === undefined) lit = cs[i].args[0];
      }
    }
    return lit;
  }

  private _hasLeafValue(path: string): boolean {
    const node = this.proj.nodes.get(path);
    if (!node) return false;
    for (const cs of node.claims.values()) {
      for (const c of cs) if (c.op === 'bound' || c.op === 'literal') return true;
    }
    return false;
  }

  /** Raw Type at this exact path — kind + aggregated claims. Internal.
   *  `typeAt` is the public ancestor-walking view. */
  private _typeOf(path: string): Type | undefined {
    const node = this.proj.nodes.get(path);
    if (!node || node.kind === undefined) return undefined;
    return { kind: node.kind, constraints: this._aggregateConstraints(node), meta: node.meta };
  }

  /** Schema-only view — bind-derived claims (owner starts with `bind:`)
   *  filtered out. Used when validating a NEW bind against declared
   *  schema, where prior bind values are state being replaced. */
  private _declaredTypeOf(path: string): Type | undefined {
    const t = this._typeAtRaw(path);
    if (!t) return undefined;
    // _typeAtRaw flattens claims; we filter the bound op (which only
    // bind-owners produce). Schema owners can produce `literal` and
    // those stay (they ARE the declared shape).
    const declared = t.constraints.filter(c => c.op !== 'bound');
    if (declared.length === t.constraints.length) return t;
    return { kind: t.kind, constraints: declared, meta: t.meta };
  }

  private *_iterateLeafValues(): Generator<[string, unknown]> {
    for (const [path] of this.proj.nodes) {
      const v = this._leafValueAt(path);
      if (v !== undefined) yield [path, v];
    }
  }

  private *_iterateTypes(): Generator<[string, Type]> {
    for (const [path, node] of this.proj.nodes) {
      if (node.kind === undefined) continue;
      yield [path, { kind: node.kind, constraints: this._aggregateConstraints(node), meta: node.meta }];
    }
  }

  /** Bind a value at `path` on behalf of `owner` (default kernel-bind).
   *
   *  Latest-bind-wins across authors: a bind from any `bind:*` owner
   *  clears every other `bind:*` owner's bound constraint at this
   *  path. There is one current value per slot; the latest binder
   *  asserts it. Schema (`schema:*`) and commitment (`commitment:*`)
   *  claims are untouched — those have different lifecycle semantics
   *  and may coexist with the bind value. */
  private _writeBind(path: string, v: unknown, owner: string = KERNEL_BIND_OWNER): void {
    const existing = this.proj.nodes.get(path);
    const bound: Constraint = { op: 'bound', args: [v] };
    if (!existing) {
      const claims = new Map<string, Constraint[]>();
      claims.set(owner, [bound]);
      this.proj.nodes.set(path, { claims });
      return;
    }
    // Clear bound constraints from every other bind:* owner so the
    // latest binder's value is the slot's current value.
    for (const [o, cs] of existing.claims) {
      if (o === owner || !o.startsWith('bind:')) continue;
      const without = cs.filter(c => c.op !== 'bound');
      if (without.length === 0) existing.claims.delete(o);
      else existing.claims.set(o, without);
    }
    existing.claims.set(owner, [bound]);
  }

  /** Mount a schema at `path` on behalf of `owner`. Replaces this
   *  owner's prior schema claim; other owners' claims (including
   *  binds and other schemas) are untouched. The kind is set if the
   *  node has none yet — kinds are sticky once declared. */
  private _writeSchema(path: string, T: Type, owner: string = KERNEL_SCHEMA_OWNER): void {
    const existing = this.proj.nodes.get(path);
    if (!existing) {
      const claims = new Map<string, Constraint[]>();
      claims.set(owner, [...T.constraints]);
      this.proj.nodes.set(path, { kind: T.kind, claims, meta: T.meta });
      return;
    }
    existing.claims.set(owner, [...T.constraints]);
    // Kind sticks once declared; meta refreshes from the most recent
    // schema mount. Per-owner meta is future work — today the node
    // meta is the latest declarer's view.
    const nextKind = existing.kind ?? T.kind;
    const nextMeta = T.meta ?? existing.meta;
    if (nextKind !== existing.kind || nextMeta !== existing.meta) {
      this.proj.nodes.set(path, { ...existing, kind: nextKind, meta: nextMeta });
    }
  }

  /** Drop the bind claim by `owner` at `path`. Other owners' claims
   *  intact. If no claims remain and no kind declared, removes node. */
  private _deleteLeafValue(path: string, owner: string = KERNEL_BIND_OWNER): void {
    const node = this.proj.nodes.get(path);
    if (!node) return;
    const cs = node.claims.get(owner);
    if (!cs) return;
    const without = cs.filter(c => c.op !== 'bound');
    if (without.length === 0) node.claims.delete(owner);
    else node.claims.set(owner, without);
    if (node.claims.size === 0 && node.kind === undefined) this.proj.nodes.delete(path);
  }

  /** Cascade-derived write at `path`. Supersedes any other bind
   *  values from any owner — the substrate's derivation IS the
   *  authoritative value at a derived path. Schema-declared
   *  literal/min/max constraints are preserved. */
  private _writeDerived(path: string, v: unknown): void {
    const node = this.proj.nodes.get(path);
    const bound: Constraint = { op: 'bound', args: [v] };
    if (!node) {
      const claims = new Map<string, Constraint[]>();
      claims.set('derived:kernel', [bound]);
      this.proj.nodes.set(path, { claims });
      return;
    }
    // Strip every owner's bound constraint; non-bound (schema)
    // claims persist untouched.
    for (const [owner, cs] of node.claims) {
      const without = cs.filter(c => c.op !== 'bound');
      if (without.length === 0) node.claims.delete(owner);
      else node.claims.set(owner, without);
    }
    node.claims.set('derived:kernel', [bound]);
  }

  /** Public lifecycle op: drop ALL claims by `owner` across every
   *  path. Used when a commitment is revoked, an author disconnects,
   *  or any holder vacates the substrate. The aggregate region at
   *  every affected path recomputes — incompatibility windows close
   *  as the holder's narrowings vacate. Returns the list of paths
   *  that had claims by this owner (for cascade dispatch). */
  releaseOwner(owner: string): string[] {
    const affected: string[] = [];
    for (const [path, node] of this.proj.nodes) {
      if (!node.claims.has(owner)) continue;
      affected.push(path);
      node.claims.delete(owner);
      if (node.claims.size === 0 && node.kind === undefined) this.proj.nodes.delete(path);
    }
    return affected;
  }

  /** Total number of value-changing bind operations recorded across
   *  this Sequence's lifetime. Unlike `head`, this excludes no-op
   *  re-mounts (same path + same value). Consumers use this as a
   *  "did any real work happen?" signal across a mount or a
   *  fixpoint pass — e.g. tick() reports an empty result when the
   *  only mutation was its own kicker fact. */
  get realMutations(): number { return this.mutationCount; }

  // ═══ BACKWARD INDEX — register/remove/lookup ═══════════════════════

  private addBackwardEntry(entry: BackwardEntry, watchPaths: Iterable<string>): void {
    this.backwardEntries.set(entry.id, entry);
    for (const p of watchPaths) {
      if (!this.backwardIndex.has(p)) this.backwardIndex.set(p, new Set());
      this.backwardIndex.get(p)!.add(entry);
    }
  }

  private removeBackwardEntry(id: string): void {
    const entry = this.backwardEntries.get(id);
    if (!entry) return;
    this.backwardEntries.delete(id);
    for (const [, entries] of this.backwardIndex) {
      entries.delete(entry);
    }
  }
  get length(): number { return this.blocks.length; }
  get projection(): Readonly<Projection> { return this.proj; }

  /** Public iterator over (path, Type) pairs for every path with a
   *  declared kind. */
  iterateTypes(): Iterable<[string, Type]> { return this._iterateTypes(); }

  /** Public iterator over (path, value) pairs for every path with a
   *  bind value. */
  iterateValues(): Iterable<[string, unknown]> { return this._iterateLeafValues(); }

  /** Promote accumulated observations at each path into a tighter
   *  declared type — the lattice-join of observed bind values. The
   *  candidate is a union of the distinct literals seen at the path;
   *  mounted with owner=`derived:learning` so `releaseOwner` vacates
   *  it. Returns paths promoted.
   *
   *  MDL gate: at least `minEvidence` distinct observations; skip if
   *  the current declared type already covers the candidate. */
  promoteRefinements(opts?: { minEvidence?: number }): string[] {
    const minEvidence = opts?.minEvidence ?? 3;
    const observed = new Map<string, Set<unknown>>();
    for (const b of this.blocks) {
      if (b.status !== 'applied' || this.invalidatedBlocks.has(b.seq)) continue;
      for (const e of b.entries) {
        if (e.op !== 'bind' || e.path.startsWith('_')) continue;
        let set = observed.get(e.path);
        if (!set) { set = new Set(); observed.set(e.path, set); }
        set.add(e.value);
      }
    }
    const promoted: string[] = [];
    for (const [p, set] of observed) {
      if (set.size < minEvidence) continue;
      const values = [...set];
      const kind = (['number', 'string', 'boolean'] as const).find(k => values.every(v => typeof v === k)) ?? 'any';
      const candidate: Type = values.length === 1
        ? { kind, constraints: [{ op: 'literal', args: [values[0]] }] }
        : { kind, constraints: [{ op: 'or_clause', args: values.map(v => ({ op: 'literal', args: [v] })) }] };
      const current = this._declaredTypeOf(p);
      if (current && isNever(compose(current, candidate))) continue;
      this._writeSchema(p, candidate, 'derived:learning');
      promoted.push(p);
    }
    return promoted;
  }

  // ═══ MOUNT — the single operation ═════════════════════════════════

  mount(
    opOrEntries: string | MountEntry[],
    pathOrOpts?: string | BlockOpts,
    value?: unknown,
    opts?: BlockOpts,
  ): MountResult {
    let entries: MountEntry[];
    let blockOpts: BlockOpts | undefined;
    if (typeof opOrEntries === 'string') {
      entries = [{ op: opOrEntries as MountEntry['op'], path: pathOrOpts as string, value }];
      blockOpts = opts;
    } else {
      entries = opOrEntries;
      blockOpts = pathOrOpts as BlockOpts | undefined;
    }

    const blockSeq = this.nextBlockSeq++;
    // Freeze `_rt` across a single cascade. The outer mount picks up
    // a fresh clock reading, but every nested mount fired by
    // runIndexConstraints during that cascade reuses the same time.
    // Without this, body values that resolve to `_rt` (e.g.
    // `createdAt = {_deref: '_rt'}`) would see a new `Date.now()` on
    // every fixpoint pass, appearing as a real mutation and blocking
    // convergence.
    const wasOutermost = this.cascadeTime === null;
    const time = this.cascadeTime ?? this.clock();
    if (wasOutermost) this.cascadeTime = time;
    try {
    this._writeBind('_rt', time);
    this._writeBind('_lockExpiry', this.lockExpiry);

    // ─── Partition reference validation ───────────────────────────
    // For each entry, check that any paths it depends on (via schema
    // ref/derived, where/while constraints) are in allowed partitions.
    // Partition lookups are type-aware: a path's partition comes from
    // the type declared at that path when available (via `partition(p)`
    // on the type's constraints), falling back to the lexical prefix
    // match only when no type is in scope. For ref targets, the target's
    // type is looked up in the current projection — if the target
    // already has a schema mounted, its declared partition takes
    // precedence over its path prefix.
    const partitionErrors: string[] = [];
    const schemaFor = (path: string): Type | undefined => this._typeOf(path);
    const partitionAt = (path: string, explicitType?: Type): Partition =>
      partitionOf(path, explicitType ?? schemaFor(path));
    for (const entry of entries) {
      const entryType = entry.op === 'schema' ? (entry.value as Type | undefined) : undefined;
      const entryPartition = partitionAt(entry.path, entryType);
      // Schema entries: check ref and derived constraint targets
      if (entry.op === 'schema' && entry.value) {
        const type = entry.value as Type;
        for (const c of type.constraints) {
          if (c.op === 'ref') {
            const src = c.args[0] as string;
            const srcPartition = partitionAt(src);
            if (!partitionDirectionAllowed(entry.path, src, entryPartition, srcPartition)) {
              partitionErrors.push(`${entry.path} (${entryPartition}) cannot reference ${src} (${srcPartition})`);
            }
          }
          if (c.op === 'derived') {
            const [, ...argPaths] = c.args as string[];
            for (const ap of argPaths) {
              const apPartition = partitionAt(ap);
              if (!partitionDirectionAllowed(entry.path, ap, entryPartition, apPartition)) {
                partitionErrors.push(`${entry.path} (${entryPartition}) cannot reference ${ap} (${apPartition})`);
              }
            }
          }
        }
      }
    }
    // Block-level constraints: where/while paths must be reachable from every entry's partition
    if (blockOpts?.where || blockOpts?.while) {
      const constraintPaths = new Set<string>();
      for (const c of [...(blockOpts.where ?? []), ...(blockOpts.while ?? [])]) {
        Sequence.collectPaths(c, constraintPaths);
      }
      for (const entry of entries) {
        const entryType = entry.op === 'schema' ? (entry.value as Type | undefined) : undefined;
        const entryPartition = partitionAt(entry.path, entryType);
        for (const cp of constraintPaths) {
          const cpPartition = partitionAt(cp);
          if (!partitionDirectionAllowed(entry.path, cp, entryPartition, cpPartition)) {
            partitionErrors.push(`${entry.path} (${entryPartition}) cannot depend on ${cp} (${cpPartition}) via where/while`);
          }
        }
      }
    }
    if (partitionErrors.length > 0) {
      const block: Block = { seq: blockSeq, time, entries, ...blockOpts, status: 'suspended' };
      this.blocks.push(block);
      this.indexBlock(block);
      return {
        ok: false, blockSeq, nextWake: this.nextWake(),
        gaps: partitionErrors.map(reason => ({ path: entries[0]?.path ?? '', reason, constraint: { op: 'partition', args: [] } })),
      };
    }

    // Where gate
    if (blockOpts?.where) {
      const failed = blockOpts.where.filter(c => !this.evalConstraint(c));
      if (failed.length > 0) {
        const block: Block = { seq: blockSeq, time, entries, ...blockOpts, status: 'suspended' };
        this.blocks.push(block);
        this.indexBlock(block);

        // Mount lifecycle fact: this block is pending, visible to other agents.
        // _rt is the only monotonic measure of state evolution.
        const blockPath = `_blocks.${this.identity}.${blockSeq}`;
        this._writeBind(`${blockPath}.status`, 'suspended');
        this._writeBind(`${blockPath}.suspendedAt`, time);
        this._writeBind(`${blockPath}.target`, entries[0]?.path ?? '');
        if (blockOpts.author) this._writeBind(`${blockPath}.author`, blockOpts.author);
        if (blockOpts.label) this._writeBind(`${blockPath}.label`, blockOpts.label);
        // Mount unmet conditions as schemas — these ARE the gaps that
        // backward inference walks. When a capability fills them, the
        // backward index triggers resume.
        for (let i = 0; i < failed.length; i++) {
          const c = failed[i];
          this._writeBind(`${blockPath}.pending.${i}`, `${c.op}(${c.args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(', ')})`);
        }

        const gaps = failed.map(c => ({
          path: entries[0]?.path ?? '', reason: `where: ${c.op}(${c.args.join(', ')})`, constraint: c,
        }));
        return { ok: false, blockSeq, gaps, nextWake: this.nextWake() };
      }
    }

    // Key-derived path resolution: if a bind targets a collection with a key constraint,
    // derive the actual path from the value's key fields before type-checking.
    entries = entries.map(entry => {
      if (entry.op !== 'bind' || typeof entry.value !== 'object' || entry.value === null || Array.isArray(entry.value)) return entry;
      const globSchema = this._typeOf(entry.path + '.*');
      if (!globSchema) return entry;
      const keyConstraint = globSchema.constraints.find(c => c.op === 'key');
      if (!keyConstraint) return entry;
      const obj = entry.value as Record<string, unknown>;
      const keyParts = (keyConstraint.args as string[]).map(f => String(obj[f] ?? '')).filter(Boolean);
      if (keyParts.length === 0) return entry;
      return { ...entry, path: `${entry.path}.${keyParts.join('.')}` };
    });

    // Helper: provenance enforcement. Runs the producedBy check on
    // any schema that constrains the entry path. Used by both bind
    // and schema entries — under CONSTRAINT_GRAPH.md HC4, every
    // narrowing of any constraint at a path is subject to the same
    // pre-mount authorization, regardless of which op triggered it.
    // (R-A6.7.2: a schema mount that lands a literal constraint
    // surfaces that literal as a value via Session A's read-side
    // unification; provenance must reject it the same way it would
    // reject a bind of the same value.)
    const checkProvenance = (entryPath: string, schemaForCheck: Type): MountResult | null => {
      const provenanceCs = constraintsOf(schemaForCheck, 'producedBy');
      for (const pc of provenanceCs) {
        const [requiredProducer, maxAge] = pc.args as [string, number | undefined];
        const author = blockOpts?.author;
        const authorMatch = author === requiredProducer;
        let execMatch = false;
        for (const [p, v] of this._iterateLeafValues()) {
          if (!p.startsWith('_exec.') || !p.endsWith('.invoked')) continue;
          if (v !== requiredProducer) continue;
          const execSeqStr = p.split('.')[1];
          const produced = this._leafValueAt(`_exec.${execSeqStr}.produced`) as string[] | undefined;
          if (produced?.includes(entryPath)) {
            if (maxAge !== undefined) {
              const execTime = this._leafValueAt(`_exec.${execSeqStr}.time`) as number | undefined;
              if (execTime !== undefined && (time - execTime) > maxAge) continue;
            }
            execMatch = true;
            break;
          }
        }
        if (!authorMatch && !execMatch) {
          return {
            ok: false, blockSeq, nextWake: this.nextWake(),
            gaps: [{
              path: entryPath,
              reason: `provenance required: must be produced by "${requiredProducer}"${maxAge ? ` within ${maxAge}ms` : ''}`,
              constraint: pc,
            }],
          };
        }
      }
      return null;
    };

    // Type-check + resolve defaults/transitions (copy to avoid mutation)
    const resolved: MountEntry[] = [];
    for (const entry of entries) {
      if (entry.op === 'bind') {
        const { value: withDefaults, defaultedKeys } = this.applyDefaults(entry.path, entry.value);
        const val = this.applyTransition(entry.path, withDefaults);
        // Substrate coherence: the bind narrows the path to a single-
        // inhabitant region (the literal {val}). Meet against the
        // DECLARED constraint set — the prior bound is the value
        // being replaced and is excluded from the meet (otherwise
        // every state transition would self-collide). If the meet
        // is `never`, the new value violates the declared type and
        // the bind is rejected.
        const declared = this._declaredTypeOf(entry.path);
        if (declared) {
          const result = check(declared, val, entry.path);
          if (!result.ok) {
            const block: Block = { seq: blockSeq, time, entries, ...blockOpts, status: 'suspended' };
            this.blocks.push(block);
            this.indexBlock(block);
            return { ok: false, blockSeq, gaps: (result as any).gaps, nextWake: this.nextWake() };
          }
          const provReject = checkProvenance(entry.path, declared);
          if (provReject) return provReject;
        }
        resolved.push({ ...entry, value: val });
        // Track provenance: which fields were user-provided vs defaulted
        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          const defaultSet = new Set(defaultedKeys);
          for (const key of Object.keys(val as Record<string, unknown>)) {
            this._writeBind(`${entry.path}.${key}._provenance`, defaultSet.has(key) ? 'default' : 'user');
          }
        }
      } else if (entry.op === 'schema' && this.instantiatingIndex !== true) {
        const incoming = entry.value as Type | undefined;
        if (incoming) {
          // Substrate coherence: every narrowing meets against the
          // existing constraint set. If the meet is `never`, the
          // narrowing inhabits an empty region of value-space and
          // must be rejected — two writes can't both occupy the
          // same slot with contradictory values.
          //
          // Concrete cases this catches:
          //   - schema literal vs prior bind value (different values)
          //   - schema literal vs prior schema literal (different values)
          //   - any future range/regex/distribution narrowings whose
          //     intersection is empty
          //
          // This is the kernel-level coherence guarantee. Today's
          // representation is a flat constraint list; a richer
          // segment/interval representation would compute the same
          // meet directly on the value-space region.
          const existingType = this.typeAt(entry.path);
          if (existingType) {
            const meet = compose(existingType, incoming);
            if (isNever(meet)) {
              return {
                ok: false, blockSeq, nextWake: this.nextWake(),
                gaps: [{
                  path: entry.path,
                  reason: `schema mount narrows to never — incompatible with existing constraints at ${entry.path}`,
                  constraint: { op: 'never', args: [] } as Constraint,
                }],
              };
            }
          }
          // Provenance: a value-establishing schema mount (one that
          // lands a literal) on a path declaring producedBy must
          // satisfy provenance just as a bind would.
          const incomingHasLiteral = incoming.constraints.some(c => c.op === 'literal');
          if (incomingHasLiteral && existingType && constraintsOf(existingType, 'producedBy').length > 0) {
            const provReject = checkProvenance(entry.path, existingType);
            if (provReject) return provReject;
          }
        }
        resolved.push(entry);
      } else {
        resolved.push(entry);
      }
    }

    entries = resolved;

    // Admission laws — pre-mount authorization checks declared as
    // `law({ admission: true, check, reason })` on any schema whose
    // path (literal or glob) covers the entry being mounted. The
    // check constraint is evaluated with `$author`, `$path`, `$time`
    // bindings. First failure rejects the whole block. This is the
    // mechanism behind signature verification, session-holder
    // enforcement, heartbeat takedown prevention — any predicate
    // that must run before the value lands, not after.
    {
      const admission = runAdmissionLaws(
        this, entries, blockOpts?.author, time,
        this.instantiatingIndex,
      );
      if (admission.ok === false) {
        return {
          ok: false, blockSeq, nextWake: this.nextWake(),
          gaps: [{
            path: admission.entryPath,
            reason: admission.reason,
            constraint: admission.constraint as Constraint,
          }],
        };
      }
    }

    // Apply — track direct changes
    // entries is readonly Block.entries, but we may need to APPEND
    // invocation-side-effect entries (fn `.input`/`.result`) during
    // applyEntry. Build the block with a mutable copy, set the
    // currentBlockEntries pointer so applyEntry can extend it, then
    // store the block. The block's entries array IS the mutable one
    // (not a second copy) so later getAt() queries see the extended
    // history — the kernel's log is the source of truth for per-call
    // input/result retrieval.
    const blockEntries: MountEntry[] = [...entries];
    const block: Block = { seq: blockSeq, time, entries: blockEntries, ...blockOpts, status: 'applied' };
    this.blocks.push(block);
    this.blockBySeq.set(blockSeq, block);
    // Every outermost block exposes its metadata at
    // `_blocks.{identity}.{seq}.*` as readable type state. The
    // identity prefix scopes this Sequence's block log so cross-
    // process emission doesn't collide: two peers both counting
    // their blocks from 1 store under distinct identity keys, and
    // the receiver of a peer's deltas can preserve the peer's
    // attribution without overwriting its own log.
    //
    // That turns the block log into a queryable collection indexed
    // by path hierarchy — any consumer can declare an `indexSpec`
    // projecting over `_blocks.*` (all peers), `_blocks.{id}.*`
    // (one peer), or with any where clause over the dimensions
    // below. The existing cascade + runIndexConstraints fixpoint
    // maintains the consumer's result set; the existing emission
    // protocol delivers deltas. No separate cursor API.
    //
    // Dimensions written:
    //   - time    — clock value at block application
    //   - status  — 'applied' (mirrored to 'suspended' / 'invalid'
    //               later by those code paths)
    //   - author  — BlockOpts.author when set
    //   - label   — BlockOpts.label when set (used by label-rules.ts
    //               for concept backlinks)
    //   - paths   — deduped array of paths the block's entries
    //               touched; lets where clauses filter by what
    //               a block mutated
    //
    // Performance: gated on PathMap's children-index (keys() is O(1)
    // per prefix), which makes dense `_blocks.*` cheap. See the
    // comment block above the PathMap class for the amplification
    // this would cause without that index.
    const blockRoot = `_blocks.${this.identity}.${blockSeq}`;
    this._writeBind(`${blockRoot}.time`, time);
    this._writeBind(`${blockRoot}.status`, 'applied');
    if (blockOpts?.author) {
      this._writeBind(`${blockRoot}.author`, blockOpts.author);
    }
    if (blockOpts?.label) {
      this._writeBind(`${blockRoot}.label`, blockOpts.label);
    }
    const blockPaths = blockEntries
      .map(e => e.path)
      .filter((p, i, a) => a.indexOf(p) === i);
    this._writeBind(`${blockRoot}.paths`, blockPaths);
    const changedPaths: string[] = ['_rt']; // _rt always changes — triggers temporal invariants
    const changes: PathChange[] = [];
    const priorEntriesRef = this.currentBlockEntries;
    const priorAuthorRef = this.currentBlockAuthor;
    this.currentBlockEntries = blockEntries;
    this.currentBlockAuthor = blockOpts?.author;
    try {
      for (const entry of entries) {
        if (entry.op === 'bind') {
          const oldValue = this._leafValueAt(entry.path);
          this.applyEntry(entry);
          changes.push({ path: entry.path, oldValue, newValue: entry.value, cause: 'direct', time, sourceBlock: blockSeq });
        } else {
          this.applyEntry(entry);
        }
        changedPaths.push(entry.path);
      }
    } finally {
      this.currentBlockEntries = priorEntriesRef;
      this.currentBlockAuthor = priorAuthorRef;
    }
    // While constraints are indexed by indexBlock (called above via this.blocks.push + indexBlock pattern)
    // Re-index the applied block for invariant entries if it has while constraints
    if (blockOpts?.while?.length) this.indexBlock(block);

    // Auto-wire any gap whose type is covered by exactly one registered
    // capability. This lifts the kernel distinction between derived
    // values and capability invocations — both become the same cascade
    // mechanism. Inputs already present at declared paths get added to
    // changedPaths so the very fireLaws below propagates them through
    // the just-installed dep edges, rather than waiting for some later
    // mutation to trigger the cascade.
    //
    // Gate on mount shape: wiring state changes only when a new schema
    // or capability lands, or when a function binds to an fn-typed
    // schema (impl becoming available). Plain value binds can't change
    // the wiring landscape and skip this scan — keeping the O(N²)
    // schema×cap walk off every downstream value update.
    const mayAffectWiring = entries.some(e => {
      if (e.op === 'schema' || e.op === 'cap') return true;
      if (e.op === 'bind' && typeof e.value === 'function') return true;
      return false;
    });
    if (mayAffectWiring) {
      const wiredInputs = this.tryAutoWire();
      for (const p of wiredInputs) changedPaths.push(p);
    }

    // Fire laws until stable
    const fx = this.fireLaws(changedPaths, time);
    changes.push(...fx.changes);

    // Extract execution record — the normalized knowledge graph node.
    // Only for mounts with semantic content (binds that produce values).
    // Schema/cap/policy mounts are structural setup, not knowledge graph edges.
    if (entries.some(e => e.op === 'bind')) {
      const execPath = `_exec.${blockSeq}`;
      this._writeBind(`${execPath}.time`, time);
      if (blockOpts?.author) this._writeBind(`${execPath}.runBy`, blockOpts.author);
      const produced: string[] = [];
      const used: string[] = [];
      for (const c of changes) {
        produced.push(c.path);
        if (c.oldValue !== undefined) used.push(c.path);
      }
      if (produced.length > 0) this._writeBind(`${execPath}.produced`, produced);
      if (used.length > 0) this._writeBind(`${execPath}.used`, used);
      const primaryPath = entries[0]?.path;
      if (primaryPath) {
        // Type-aware partition tag: if the primary path has a schema
        // already mounted (which it typically does by the time exec
        // records its trace), its declared partition wins over the
        // lexical prefix. Unschematised paths fall back to prefix.
        this._writeBind(
          `${execPath}.partition`,
          partitionOf(primaryPath, this._typeOf(primaryPath)),
        );
        const targetSchema = this.typeAt(primaryPath);
        if (targetSchema?.kind === 'fn') {
          this._writeBind(`${execPath}.invoked`, primaryPath);
          // No per-call IO snapshot needed: the fn invocation path
          // in applyEntry pushes `.input` and `.result` sub-binds
          // into the block's entries array, so history queries can
          // read them via getAt(path, blockSeq) from the log.
        }
        if (targetSchema) this._writeBind(`${execPath}.objectType`, targetSchema.kind);
      }
      if (fx.resumed.length > 0) {
        this._writeBind(`${execPath}.satisfied`, fx.resumed.map(s => `_blocks.${this.identity}.${s}`));
      }
    }

    // Fire any index-constrained classes whose binding space may
    // have been affected by this mount. Class bodies run per-tuple
    // via nested mount() calls. New tuples mount new values;
    // re-fired tuples are no-ops by same-value-at-same-path compose
    // idempotency. Runs a fixpoint over a frozen `_rt` so downstream
    // classes fired by cascading body mounts all see a consistent
    // time, then unfreezes on return from the outermost mount.
    this.runIndexConstraints();

    // Re-score: manage working set if a memory budget is configured
    const ws = this.rescoreWorkingSet(time);

    const toolCompletion = this.pendingToolCompletion;
    this.pendingToolCompletion = undefined;
    const result: MountResult = {
      ok: true, blockSeq,
      invalidated: fx.invalidated.length > 0 ? fx.invalidated : undefined,
      resumed: fx.resumed.length > 0 ? fx.resumed : undefined,
      cascaded: fx.cascaded.length > 0 ? fx.cascaded : undefined,
      pendingInvocations: fx.pendingInvocations.length > 0 ? fx.pendingInvocations : undefined,
      changes: changes.length > 0 ? changes : undefined,
      evicted: ws.evicted.length > 0 ? ws.evicted : undefined,
      promoted: ws.promoted.length > 0 ? ws.promoted : undefined,
      author: blockOpts?.author,
      nextWake: this.nextWake(),
      toolCompletion,
    };
    // Auto-promote: when learning is enabled, run the observation-
    // accumulation pass at every outermost cascade fixpoint. The
    // promotion writes new owned claims (owner='derived:learning')
    // which the substrate treats like any other narrowing — they
    // join the constraint graph and the next cascade meets against
    // them. LEARNING_AS_COMPRESSION's terminal action.
    if (wasOutermost && this.learningThreshold !== Infinity) {
      this.promoteRefinements({ minEvidence: this.learningThreshold });
    }
    // Notify observers — but only on the outermost mount so a
    // single cascade produces one observer callback per external
    // trigger, not one per nested body mount. Nested mounts still
    // propagate through their own cascades and mutate state; the
    // observer sees the whole cascade as a single block result.
    if (wasOutermost && this.blockObservers.length > 0) {
      for (const cb of this.blockObservers) {
        try { cb(result); } catch { /* observer failures don't abort the mount */ }
      }
    }
    return result;
    } finally {
      // Release the frozen cascade clock when unwinding the
      // outermost mount — nested mounts inside body passes or law
      // bookkeeping must all see the same `_rt` value. Using
      // try/finally so every early-return path (partition error,
      // where-gate, provenance reject, admission fail) releases
      // consistently.
      if (wasOutermost) this.cascadeTime = null;
    }
  }

  /** Sugar for single entry. */
  append(op: string, path: string, value: unknown,
    opts?: { where?: Constraint[]; while?: Constraint[]; onBreakPath?: string },
  ): MountResult & { seq: number } {
    const result = this.mount(op, path, value, opts);
    return { ...result, seq: result.blockSeq };
  }

  // ═══ FIRE LAWS — the single post-mount loop ══════════════════════

  /**
   * Substitute `$var` references in a constraint tree with their
   * bound values. Used by the `forall` evaluator to produce a
   * per-iteration body that standard evalConstraint can process
   * without needing a scoped bindings context.
   *
   * Substitutes at two levels in string args:
   *   - whole-string: `$x` → `String(bindings.x)`
   *   - segmented path: `foo.$x.bar` → `foo.{bindings.x}.bar`
   * Recurses into nested constraint args (for and/or/not/forall).
   */
  private static substituteVars(c: Constraint, bindings: Record<string, unknown>): Constraint {
    const substArg = (a: unknown): unknown => {
      if (typeof a === 'string') {
        if (a.startsWith('$')) {
          const name = a.slice(1);
          if (name in bindings) return String(bindings[name]);
          return a;
        }
        if (a.includes('.$')) {
          return a.split('.').map(seg => {
            if (seg.startsWith('$')) {
              const name = seg.slice(1);
              return name in bindings ? String(bindings[name]) : seg;
            }
            return seg;
          }).join('.');
        }
        return a;
      }
      if (Array.isArray(a)) return a.map(substArg);
      if (typeof a === 'object' && a !== null) {
        // Nested constraint?
        if ('op' in (a as any) && 'args' in (a as any) && Array.isArray((a as any).args)) {
          return Sequence.substituteVars(a as Constraint, bindings);
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(a as any)) out[k] = substArg(v);
        return out;
      }
      return a;
    };
    return { op: c.op, args: c.args.map(substArg) };
  }

  /** Extract all path references from a constraint tree (recursive for composite predicates).
   *  Also extracts paths from aggregate function args and glob patterns. */
  private static collectPaths(c: Constraint, into: Set<string>): void {
    if (c.op === 'or_clause' || c.op === 'and_clause') {
      for (const sub of c.args as Constraint[]) Sequence.collectPaths(sub, into);
    } else if (c.op === 'not_clause') {
      Sequence.collectPaths(c.args[0] as Constraint, into);
    } else {
      for (const arg of c.args) {
        if (typeof arg === 'string') {
          // For glob paths like 'prefix.*.field', watch the prefix
          // so any child change triggers re-evaluation
          if (arg.includes('.*')) {
            const prefix = arg.slice(0, arg.indexOf('.*'));
            into.add(prefix);
          } else {
            into.add(arg);
          }
        }
        // Aggregate function objects: { fn: 'sum', args: ['prefix.*.field'] }
        if (typeof arg === 'object' && arg !== null && 'fn' in (arg as any)) {
          for (const subArg of (arg as any).args ?? []) {
            if (typeof subArg === 'string') {
              if (subArg.includes('.*')) {
                into.add(subArg.slice(0, subArg.indexOf('.*')));
              } else {
                into.add(subArg);
              }
            }
          }
        }
        // Arithmetic expression objects: { op: '+', lhs: 'path', rhs: 30000 }
        if (typeof arg === 'object' && arg !== null && 'lhs' in (arg as any)) {
          const extractPaths = (expr: unknown): void => {
            if (typeof expr === 'string') {
              if (expr.includes('.*')) into.add(expr.slice(0, expr.indexOf('.*')));
              else into.add(expr);
            }
            if (typeof expr === 'object' && expr !== null && 'lhs' in (expr as any)) {
              extractPaths((expr as any).lhs);
              extractPaths((expr as any).rhs);
            }
          };
          extractPaths(arg);
        }
      }
    }
  }

  /** Register a block in indexes. Suspended blocks get backward entries for resume + conjunction. */
  private indexBlock(block: Block): void {
    this.blockBySeq.set(block.seq, block);
    if (block.status === 'suspended') {
      // Resume entry: watches all paths in where constraints + entry paths
      const watchPaths = new Set<string>();
      if (block.where) for (const c of block.where) Sequence.collectPaths(c, watchPaths);
      for (const e of block.entries) watchPaths.add(e.path);
      this.addBackwardEntry(
        { kind: 'resume', id: `resume:${block.seq}`, blockSeq: block.seq, watchPaths: [...watchPaths] },
        watchPaths,
      );
      // Conjunction entry: for O(delta) priority propagation on multi-ref where
      if (block.where && block.where.length > 0) {
        const refs = [...watchPaths].filter(p => !block.entries.some(e => e.path === p));
        if (refs.length > 1) {
          this.addBackwardEntry(
            { kind: 'conjunction', id: `conj:${block.seq}`, blockSeq: block.seq, refs, consequence: block.entries[0]?.path ?? '' },
            refs,
          );
        }
      }
    }
    if (block.status === 'applied' && block.while?.length) {
      // Invariant entry: watches paths in while constraints
      const watchPaths = new Set<string>();
      for (const c of block.while) Sequence.collectPaths(c, watchPaths);
      this.addBackwardEntry(
        { kind: 'invariant', id: `while:${block.seq}`, blockSeq: block.seq, watchPaths: [...watchPaths] },
        watchPaths,
      );
    }
  }

  /** Remove a block from all backward indexes (called on resume/invalidation). */
  private unindexBlock(seq: number): void {
    this.removeBackwardEntry(`resume:${seq}`);
    this.removeBackwardEntry(`conj:${seq}`);
    this.removeBackwardEntry(`while:${seq}`);
  }

  /** Register a behavioral predicate as a backward entry. */
  private registerPredicate(schemaPath: string, observePath: string, _expectedRef: string): void {
    const priorPath = `${schemaPath}._prior.reliability`;
    this.addBackwardEntry(
      { kind: 'behavioral', id: `behavioral:${schemaPath}→${observePath}`, sourcePath: schemaPath, observePath, priorPath },
      [observePath],
    );
  }

  /**
   * Enforce a behavioral predicate when its observed path changes.
   */
  private enforceBehavioral(entry: BackwardEntry & { kind: 'behavioral' }): void {
    const sourceSchema = this._typeOf(entry.sourcePath);
    if (!sourceSchema) return;

    const identityC = constraintsOf(sourceSchema, 'identity');
    const equationC = constraintsOf(sourceSchema, 'equation');

    for (const ic of identityC) {
      const [outPath, inPath] = ic.args as [string, string];
      if (outPath !== entry.observePath && inPath !== entry.observePath) continue;
      const outVal = this.get(outPath);
      const inVal = this.get(inPath);
      if (outVal === undefined || inVal === undefined) continue;
      const holds = Object.is(outVal, inVal);
      const currentPrior = this.get(entry.priorPath) as Record<string, number> | undefined;
      const prior = currentPrior ?? { alpha: 1, beta: 1 };
      this._writeBind(entry.priorPath, conjugateUpdate('beta', prior, holds ? 'success' : 'failure'));
    }

    for (const ec of equationC) {
      const [lhs, rhs, opts] = ec.args as [string, string, { from?: any; until?: any } | undefined];
      const lhsVal = this.get(lhs);
      const rhsVal = this.get(rhs);
      if (lhsVal === undefined || rhsVal === undefined) continue;
      if (opts?.from) {
        const fromVal = typeof opts.from === 'number' ? opts.from :
          typeof opts.from === 'string' ? this.get(opts.from) : undefined;
        if (typeof fromVal === 'number' && this.clock() < fromVal) continue;
      }
      const holds = Object.is(lhsVal, rhsVal);
      const currentPrior = this.get(entry.priorPath) as Record<string, number> | undefined;
      const prior = currentPrior ?? { alpha: 1, beta: 1 };
      this._writeBind(entry.priorPath, conjugateUpdate('beta', prior, holds ? 'success' : 'failure'));
    }
  }

  /**
   * Re-score the working set after every mount.
   *
   * If _process.evictionPolicy capability is registered, invoke it.
   * Otherwise use the default heuristic (backward inference walk from top gaps).
   * The result is WRITTEN to _process.workingSet — it's observable state,
   * not a side channel. Readers cascade from it.
   */
  private rescoreWorkingSet(_time: number): { evicted: string[]; promoted: string[] } {
    const budget = this._leafValueAt('_reader.maxItems') as number | undefined;
    if (!budget || budget <= 0) return { evicted: [], promoted: [] };

    // Try mounted eviction policy capability first
    const policyFn = this.implRegistry.get('_process.evictionPolicy');
    if (policyFn) {
      try {
        const result = (policyFn as any)({
          budget,
          gaps: this.gaps(),
          projection: this.proj,
        });
        if (result && result.keep && result.evict) {
          this.writeWorkingSet(result.keep, result.evict, result.promoted ?? [], result.nextLikelyNeeded ?? []);
          return { evicted: result.evict.map((e: any) => e.path ?? e), promoted: (result.promoted ?? []).map((p: any) => p.path ?? p) };
        }
      } catch { /* fall through to default */ }
    }

    // Default: backward inference walk from top gaps
    // Score = how likely this path is to be needed by the next gap resolution
    const gapList = this.gaps();
    const neededPaths = new Set<string>();

    // Walk backward from each gap through capability input requirements
    for (const gap of gapList.slice(0, 10)) { // top 10 gaps
      neededPaths.add(gap.path);
      if (gap.inputsNeeded && gap.inputsNeeded.kind === 'object') {
        for (const c of gap.inputsNeeded.constraints) {
          if (c.op === 'property') neededPaths.add(c.args[0] as string);
        }
      }
      // Also keep dependencies of this gap
      const deps = this.proj.reverseDepIndex.get(gap.path);
      if (deps) for (const d of deps) neededPaths.add(d);
    }

    // Score all non-internal paths using time-conditioned concreteness.
    // Lookahead horizon: the earliest pending temporal wake, or +60s if
    // none pending. This is what "re-score for _rt_next" means in practice
    // — evaluate the distribution at whatever time we'll next observe
    // something change, and sort by probability of concreteness at that
    // horizon. Commit 5 of the concreteness-as-distribution pass.
    const now = this.clock();
    const nextWake = this.nextWake();
    const lookaheadT = isFinite(nextWake) && nextWake > now
      ? Math.min(nextWake, now + 60_000)
      : now + 60_000;

    const scored: { path: string; score: number; reason: string }[] = [];
    for (const [path] of this._iterateLeafValues()) {
      if (path.startsWith('_')) continue;
      const onGapPath = neededPaths.has(path);
      const c = this.concretenessDistribution(path).cdf(lookaheadT);
      const deps = this.proj.depIndex.get(path)?.size ?? 0;
      const revDeps = this.proj.reverseDepIndex.get(path)?.size ?? 0;
      const betweenness = 1 + deps + revDeps;
      const score = (onGapPath ? 2 : 0) + c * betweenness;
      const reason = onGapPath ? 'on gap resolution path' : `cdf(t+${lookaheadT - now}ms)=${c.toFixed(2)} betweenness=${betweenness}`;
      scored.push({ path, score, reason });
    }
    for (const [path] of this._iterateTypes()) {
      if (path.startsWith('_') || this._hasLeafValue(path)) continue;
      const onGapPath = neededPaths.has(path);
      const deps = this.proj.depIndex.get(path)?.size ?? 0;
      const revDeps = this.proj.reverseDepIndex.get(path)?.size ?? 0;
      const betweenness = 1 + deps + revDeps;
      const score = (onGapPath ? 2 : 0) + 0.5 * betweenness;
      scored.push({ path, score, reason: onGapPath ? 'gap on resolution path' : 'gap' });
    }

    scored.sort((a, b) => b.score - a.score);

    const kept = scored.slice(0, budget);
    const evictedItems = scored.slice(budget);
    const nextLikelyNeeded = [...neededPaths].slice(0, 5).map(p => ({
      path: p,
      probability: this.concretenessDistribution(p).cdf(lookaheadT),
    }));

    // Write to _process.workingSet — this IS observable state
    this.writeWorkingSet(kept, evictedItems, [], nextLikelyNeeded);

    return {
      evicted: evictedItems.map(e => e.path),
      promoted: [],
    };
  }

  /** Write working set decisions to _process.workingSet as observable state. */
  private writeWorkingSet(
    kept: { path: string; score: number; reason: string }[],
    evicted: { path: string; score: number; reason: string }[],
    promoted: { path: string; score?: number; reason?: string }[],
    nextLikelyNeeded: { path: string; probability: number }[],
  ): void {
    this._writeBind('_process.workingSet.kept', kept.slice(0, 20)); // top 20 for observability
    this._writeBind('_process.workingSet.evicted', evicted.slice(0, 20));
    this._writeBind('_process.workingSet.promoted', promoted);
    this._writeBind('_process.workingSet.nextLikelyNeeded', nextLikelyNeeded);
  }

  private fireLaws(initialPaths: string[], time: number) {
    const resumed: number[] = [];
    const cascaded: string[] = [];
    const invalidated: string[] = [];
    const pendingInvocations: PendingInvocation[] = [];
    const changes: PathChange[] = [];
    const queue = [...initialPaths];
    const visited = new Set<string>();

    // Transitional step (Commit 1 of the concreteness-as-distribution pass):
    // when the forward cascade walks _rt (it always does — _rt is in
    // changedPaths on every mount), cached gap priorities become stale
    // because priority is derived from concreteness, which under the new
    // model is time-conditioned on _rt_next. Clear the cache as a
    // consequence of the cascade visiting _rt. Subsequent gaps() calls
    // lazily repopulate with current values.
    //
    // This is a cache-clear, not a cascade-derived value — that deeper
    // refactor lives in Commit 5 where rescoreWorkingSet is rewired to
    // time-conditioned concreteness. The intent here is to move the
    // invalidation INTO the forward cascade's dispatch so later commits
    // can replace the cache with derived values without a second rewire.
    if (initialPaths.includes('_rt')) {
      this.gapPriorityCache.clear();
    }

    while (queue.length > 0) {
      const path = queue.shift()!;
      if (visited.has(path)) continue;
      visited.add(path);

      // Cascade helper: fire a derived dependent, either for an exact-arg
      // cascade (collects all arg values) or a glob-arg cascade (passes the
      // triggering change path + value as the head args, followed by any
      // exact-arg values).
      const fireDerived = (dp: string, triggerPath: string | null) => {
        const s = this._typeOf(dp);
        // Template constraint: same cascade shape as derived. Re-render
        // mount it at the schema path. This is the operational form
        // of "narrative-with-holes IS a tool" — the same primitive
        // that fires derived rules drives a segmented string's
        // reflow. No special branch beyond projecting from segments.
        if (s && s.kind === 'string') {
          const next = projectSegmentedString(s, (p) => this._leafValueAt(p));
          if (next !== undefined) {
            const oldVal = this._leafValueAt(dp);
            if (Object.is(next, oldVal)) return;
            const cascadeBlock: Block = { seq: this.nextBlockSeq++, time, entries: [{ op: 'bind', path: dp, value: next }], status: 'applied' };
            this.blocks.push(cascadeBlock);
            this.blockBySeq.set(cascadeBlock.seq, cascadeBlock);
            this._writeDerived(dp, next);
            cascaded.push(dp);
            changes.push({ path: dp, oldValue: oldVal, newValue: next, cause: 'cascade', time, sourceBlock: cascadeBlock.seq, lawId: 'segmented_string' });
            queue.push(dp);
            return;
          }
        }
        const dc = s ? constraintOf(s, 'derived') : undefined;
        if (!dc) return;
        const [fnId, ...aps] = dc.args as string[];
        const args: unknown[] = [];
        if (triggerPath !== null) {
          args.push(triggerPath, this.get(triggerPath));
        }
        let ok = true;
        for (const a of aps) {
          // Glob args are passed via triggerPath; don't look them up
          // as exact values.
          if (a === '*' || a.endsWith('.*')) continue;
          const v = this.get(a);
          if (v === undefined) { ok = false; break; }
          args.push(v);
        }
        if (!ok) return;
        const fn = this.implRegistry.get(fnId);
        if (!fn) {
          if (this.proj.capabilities.has(fnId)) {
            pendingInvocations.push({ toolId: fnId, args, targetPath: dp });
          }
          return;
        }
        let r: unknown;
        try {
          // Calling-convention branch: if the target impl has a fn-typed
          // schema with an object param, it expects a single input object
          // (the cap invocation convention — same as `mount('bind', cap,
          // input)`). Pack positional arg values into an object keyed by
          // the param type's property names, in declared order. For
          // legacy derived caps registered via `mount('cap', id, fn)`
          // there's no schema at `fnId`, so fall through to positional.
          const targetSchema = this._typeOf(fnId);
          if (targetSchema && targetSchema.kind === 'fn') {
            const pc = constraintOf(targetSchema, 'param');
            const pt = pc ? (pc.args[0] as Type) : null;
            if (pt && pt.kind === 'object') {
              const pps = properties(pt).filter(p => !p.optional);
              const packed: Record<string, unknown> = {};
              for (let i = 0; i < pps.length; i++) packed[pps[i].key] = args[i];
              r = (fn as any)(packed);
            } else {
              r = (fn as any)(...args);
            }
          } else {
            r = (fn as any)(...args);
          }
        } catch { return; }
        const oldVal = this._leafValueAt(dp);
        if (Object.is(r, oldVal)) return;
        const cascadeBlock: Block = { seq: this.nextBlockSeq++, time, entries: [{ op: 'bind', path: dp, value: r }], status: 'applied' };
        this.blocks.push(cascadeBlock);
        this.blockBySeq.set(cascadeBlock.seq, cascadeBlock);
        this._writeDerived(dp, r);
        cascaded.push(dp);
        changes.push({ path: dp, oldValue: oldVal, newValue: r, cause: 'cascade', time, sourceBlock: cascadeBlock.seq, lawId: `derived:${fnId}` });
        queue.push(dp);
      };

      // Cascade via depIndex — exact-path dependencies.
      const deps = this.proj.depIndex.get(path);
      if (deps) for (const dp of deps) fireDerived(dp, null);

      // Cascade via globDepIndex — glob-arg dependencies. Walk ancestor
      // prefixes of `path`; any derived rule registered under an ancestor
      // prefix fires with (path, value) as its head args. The empty-string
      // prefix is the catch-all for `*` glob args.
      const pathParts = path.split('.');
      for (let i = pathParts.length; i >= 1; i--) {
        const ancestor = pathParts.slice(0, i).join('.');
        const globDeps = this.globDepIndex.get(ancestor);
        if (!globDeps) continue;
        for (const dp of globDeps) fireDerived(dp, path);
      }
      const catchAllDeps = this.globDepIndex.get('');
      if (catchAllDeps) for (const dp of catchAllDeps) fireDerived(dp, path);

      // Unified backward index dispatch: process all entries watching this path
      // AND entries watching ancestor prefixes (for glob-aggregate while clauses
      // where 'invoice.lines' watches 'invoice.lines.d.total' changes)
      const watchedEntries = new Set<BackwardEntry>();
      const direct = this.backwardIndex.get(path);
      if (direct) for (const e of direct) watchedEntries.add(e);
      // Walk ancestor prefixes
      const parts = path.split('.');
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join('.');
        const ancestorEntries = this.backwardIndex.get(ancestor);
        if (ancestorEntries) for (const e of ancestorEntries) watchedEntries.add(e);
      }
      if (watchedEntries.size > 0) for (const entry of [...watchedEntries]) {
        // Skip already-processed entries
        if (!this.backwardEntries.has(entry.id)) continue;

        switch (entry.kind) {
          case 'resume': {
            if (this.resumedBlocks.has(entry.blockSeq)) break;
            const b = this.blockBySeq.get(entry.blockSeq);
            if (!b || b.status !== 'suspended') break;
            if (b.where && !b.where.every(c => this.evalConstraint(c))) break;
            let pass = true;
            for (const e of b.entries) {
              if (e.op === 'bind') { const s = this.typeAt(e.path); if (s && !check(s, e.value, e.path).ok) { pass = false; break; } }
            }
            if (!pass) break;
            const rb: Block = { ...b, seq: this.nextBlockSeq++, time, status: 'applied' };
            this.blocks.push(rb);
            this.blockBySeq.set(rb.seq, rb);
            this.resumedBlocks.add(b.seq);
            this.unindexBlock(b.seq);
            // Lifecycle transition: suspended → applied
            const blockPath = `_blocks.${this.identity}.${b.seq}`;
            this._writeBind(`${blockPath}.status`, 'resumed');
            this._writeBind(`${blockPath}.resumedAt`, time);
            this._writeBind(`${blockPath}.resumedBy`, path); // the path change that triggered resume
            // Clear pending conditions
            const pendingKeys = this.keys(`${blockPath}.pending`);
            for (const pk of pendingKeys) this._deleteLeafValue(`${blockPath}.pending.${pk}`);

            for (const e of rb.entries) {
              if (e.op === 'bind') {
                const oldVal = this._leafValueAt(e.path);
                this.applyEntry(e);
                changes.push({ path: e.path, oldValue: oldVal, newValue: e.value, cause: 'resume', time, sourceBlock: b.seq, lawId: entry.id });
              } else {
                this.applyEntry(e);
              }
              queue.push(e.path);
            }
            if (b.while?.length) this.indexBlock(rb);
            resumed.push(rb.seq);
            break;
          }

          case 'invariant': {
            const b = this.blockBySeq.get(entry.blockSeq);
            if (!b || b.status !== 'applied' || this.invalidatedBlocks.has(entry.blockSeq)) break;
            if (!b.while) break;
            if (b.while.every(c => this.evalConstraint(c))) break; // still holds
            // While broke — invalidate
            const ie: MountEntry[] = [{ op: 'invalidate', path: b.entries[0]?.path ?? '', value: entry.blockSeq }];
            if (b.onBreakPath) ie.push({ op: 'bind', path: b.onBreakPath, value: true });
            const invBlock: Block = { seq: this.nextBlockSeq++, time, entries: ie, status: 'applied' };
            this.blocks.push(invBlock);
            this.blockBySeq.set(invBlock.seq, invBlock);
            this.invalidatedBlocks.add(entry.blockSeq);
            this.unindexBlock(entry.blockSeq);
            // Lifecycle transition: applied → invalidated
            const invBlockPath = `_blocks.${this.identity}.${entry.blockSeq}`;
            this._writeBind(`${invBlockPath}.status`, 'invalidated');
            this._writeBind(`${invBlockPath}.invalidatedAt`, time);
            this._writeBind(`${invBlockPath}.invalidatedBy`, path); // the path change that broke the while

            for (const e of b.entries) {
              if (e.op === 'bind') {
                const oldVal = this._leafValueAt(e.path);
                // Roll back to the block's original owner so we drop
                // the right claim. Without this, the delete creates a
                // no-op for a different owner and the bind survives.
                this._deleteLeafValue(e.path, bindOwner(b.author));
                invalidated.push(e.path);
                changes.push({ path: e.path, oldValue: oldVal, newValue: undefined, cause: 'invalidate', time, sourceBlock: entry.blockSeq, lawId: entry.id });
              }
              // Schema cleanup on while-break is intentionally NOT
              // done here. Removing schemas during cascade can break
              // class-body lifecycles (e.g., the Workspace class in
              // bootstrap.ft — its body mounts are while-gated, and
              // removing the schema during an intermediate cascade
              // step permanently kills the class even if the while
              // condition recovers). For the claim pattern (ref
              // schema with while-gate), disposal is handled by the
              // ref walk failing after the while-break: resolveImpl
              // walks the ref and finds the target, but the claim's
              // bind entries are cleaned up above, so per-claim
              // state (input/result) disappears. The ref schema
              // persists as a dead declaration — future invocations
              // see the fn type but resolveImpl returns the backing
              // impl (not a claim-scoped one), which is the correct
              // fallback.
            }
            if (b.onBreakPath) {
              const oldVal = this._leafValueAt(b.onBreakPath);
              this._writeBind(b.onBreakPath, true);
              changes.push({ path: b.onBreakPath, oldValue: oldVal, newValue: true, cause: 'invalidate', time, sourceBlock: entry.blockSeq, lawId: entry.id });
              queue.push(b.onBreakPath);
            }
            break;
          }

          case 'behavioral': {
            this.enforceBehavioral(entry);
            break;
          }

          case 'conjunction': {
            const key = entry.refs.join('|') + '→' + entry.consequence;
            let prob = 1;
            for (const ref of entry.refs) prob *= this.concreteness(ref);
            const oldProb = this.conjProbCache.get(key) ?? 0;
            this.conjProbCache.set(key, prob);
            if (Math.abs(prob - oldProb) < 0.001) break;
            for (const ref of entry.refs) {
              if (ref === path) continue;
              this.gapPriorityCache.delete(ref);
            }
            break;
          }

        }
      }
    }

    return { resumed, cascaded, invalidated, pendingInvocations, changes };
  }

  // ═══ READS ════════════════════════════════════════════════════════

  get(path: string, visited?: Set<string>): unknown {
    visited ??= new Set();
    if (visited.has(path)) return undefined;
    visited.add(path);
    // 1. Exact-path schema with a ref → follow it. This is the
    //    classic "this path IS a pointer" case; the pointer
    //    dereferences to its target unconditionally.
    const schema = this._typeOf(path);
    if (schema) { const rc = constraintOf(schema, 'ref'); if (rc) return this.get(rc.args[0] as string, visited); }
    // 2. Direct value at this path → return it. Per-install
    //    overrides live here: a sub-path under an install prefix
    //    with a direct bind short-circuits the ancestor-ref walk
    //    below, so `alice.tools.openai.auth = "sk-alice"` takes
    //    precedence over the aliased template default.
    const direct = this._leafValueAt(path);
    if (direct !== undefined) return direct;
    // 3. SCHEMA-AS-VALUE: if the schema at this path narrows to a
    //    `literal(v)` constraint, that literal IS the value. Per
    //    the substrate's continuum invariant, a value is a type
    //    that has consumed all available constraint space — a
    //    `literal` constraint IS that case. Reading the value
    //    must surface it whether it landed via `bind` (proj.values)
    //    or via `schema(X, createType(kind, [literal(v)]))` —
    //    these are operationally equivalent narrowings to one
    //    inhabitant.
    if (schema) {
      const lit = constraintOf(schema, 'literal');
      if (lit !== undefined) return lit.args[0];
    }
    // 4. STRUCTURAL-LEAF-COLLECTION: if no direct value exists at
    //    this path but the path has children, walk them and build
    //    the structured value from the leaves. This is the
    //    leaves-as-values reading: a node with decomposing
    //    constraints (object props, array elements) is the
    //    structural form of its leaves' values. Hoist uses the
    //    same traversal pattern; this collapses both into one
    //    reader.
    //
    //    Guard: only fire when the path is genuinely object-shaped
    //    OR has no schema (free-form paths). Fn-typed paths have
    //    sub-paths that are CONFIG (endpoint, auth, limits) not
    //    structural value — their "value" comes from invocation,
    //    not from collecting children. Same for string/number/
    //    boolean/array primitives where children are sidecars.
    const isObjectShaped = !schema || schema.kind === 'object';
    const childSegs = isObjectShaped ? this.proj.nodes.childSegments(path) : [];
    if (childSegs.length > 0) {
      const segs = new Set<string>();
      for (const s of childSegs) segs.add(s);
      const obj: Record<string, unknown> = {};
      let any = false;
      for (const seg of segs) {
        if (seg === '*') continue;       // glob slot — never a real child
        if (seg.startsWith('_')) continue; // kernel-internal sidecars (_provenance etc.)
        const childPath = path ? `${path}.${seg}` : seg;
        const childVal = this.get(childPath, visited);
        if (childVal !== undefined) {
          obj[seg] = childVal;
          any = true;
        }
      }
      if (any) return obj;
    }
    // 5. Ancestor-ref walk — the install-via-ref primitive. If
    //    an ancestor path has a ref schema, rewrite this read as
    //    `{refTarget}.{suffix}` and recurse. This is what makes
    //    `alice.tools.openai = ref(_templates.openai)` actually
    //    behave as an install: reads at `alice.tools.openai.chat`
    //    resolve through the alias to the template at
    //    `_templates.openai.chat` without anyone having to know
    //    there's a ref involved.
    const parts = path.split('.');
    for (let i = parts.length - 1; i > 0; i--) {
      const ancestor = parts.slice(0, i).join('.');
      const ancSchema = this._typeOf(ancestor);
      if (!ancSchema) continue;
      const rc = constraintOf(ancSchema, 'ref');
      if (!rc) continue;
      const target = rc.args[0] as string;
      const suffix = parts.slice(i).join('.');
      return this.get(`${target}.${suffix}`, visited);
    }
    return undefined;
  }

  getAt(path: string, seq: number): unknown {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.seq > seq || b.status !== 'applied' || this.invalidatedBlocks.has(b.seq)) continue;
      for (const e of b.entries) { if (e.path === path && e.op === 'bind') return e.value; }
    }
    return undefined;
  }

  getPrevious(path: string): unknown {
    let found = false;
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];
      if (b.status !== 'applied' || this.invalidatedBlocks.has(b.seq)) continue;
      for (const e of b.entries) {
        if (e.path === path && e.op === 'bind') { if (found) return e.value; found = true; }
      }
    }
    return undefined;
  }

  /** Public typeAt: HC1 merged view — bind-derived `bound` constraints
   *  surface as `literal` constraints in the returned Type so external
   *  compose/check logic treats them uniformly. */
  typeAt(path: string, visited?: Set<string>): Type | undefined {
    const raw = this._typeAtRaw(path, visited);
    if (!raw) return undefined;
    if (!raw.constraints.some(c => c.op === 'bound')) return raw;
    const cs = raw.constraints.map(c => c.op === 'bound' ? { op: 'literal', args: c.args } as Constraint : c);
    return { kind: raw.kind, constraints: cs, meta: raw.meta };
  }

  /** Internal typeAt walk that returns constraints raw (bind values
   *  remain as `bound` ops). The kernel uses this when it needs to
   *  distinguish declared from bound; external callers use `typeAt`. */
  private _typeAtRaw(path: string, visited?: Set<string>): Type | undefined {
    visited ??= new Set();
    if (visited.has(path)) return undefined;
    visited.add(path);
    const own = this._typeOf(path);
    if (own) {
      // Exact-path schema with a ref — follow it to get the real
      // type. Same contract as get(): the ref dereferences.
      const rc = constraintOf(own, 'ref');
      if (rc) return this._typeAtRaw(rc.args[0] as string, visited);
      return own;
    }
    // Walk ancestors — two parallel resolution paths at each level:
    //   (a) the classic object-property / glob-schema extraction
    //       used for reading nested fields through structured types
    //   (b) an ancestor-ref check: if the ancestor is an alias
    //       (e.g. alice.tools.openai = ref(_templates.openai)),
    //       rewrite the read as `{refTarget}.{suffix}` and recurse.
    //       This is what makes install-via-ref work for types —
    //       typeAt returns the template's fn schema when asked for
    //       an installed invocation's type.
    const parts = path.split('.');
    for (let i = parts.length - 1; i >= 1; i--) {
      const parentPath = parts.slice(0, i).join('.');
      const parentSchema = this._typeOf(parentPath);
      if (!parentSchema) {
        // (a) Glob pattern: parent.* schema
        const globPath = parentPath + '.*';
        const globSchema = this._typeOf(globPath);
        if (globSchema) {
          // Walk into the glob schema for segments beyond the glob slot.
          // parts[i] is the glob slot (any child of parentPath); parts[i+1..]
          // are deeper segments that must be resolved by walking properties
          // of the glob schema.
          let current: Type = globSchema;
          for (let j = i + 1; j < parts.length; j++) {
            if (current.kind !== 'object') return current;
            const childKey = parts[j];
            const propConstraint = current.constraints.find(
              c => c.op === 'property' && c.args[0] === childKey
            );
            if (!propConstraint) return undefined;
            current = propConstraint.args[1] as Type;
          }
          return current;
        }
        continue;
      }
      // (b) Ancestor ref — rewrite the read path and recurse.
      const ancRef = constraintOf(parentSchema, 'ref');
      if (ancRef) {
        const target = ancRef.args[0] as string;
        const suffix = parts.slice(i).join('.');
        return this._typeAtRaw(`${target}.${suffix}`, visited);
      }
      // (a') Classic object-property extraction.
      if (parentSchema.kind === 'object') {
        const childKey = parts[i];
        const propConstraint = parentSchema.constraints.find(
          c => c.op === 'property' && c.args[0] === childKey
        );
        if (propConstraint) return propConstraint.args[1] as Type;
        const optPropConstraint = parentSchema.constraints.find(
          c => c.op === 'property' && c.args[0] === childKey && c.args[2] === true
        );
        if (optPropConstraint) return optPropConstraint.args[1] as Type;
      }
      // If parent is not an object, return it as-is (array element type, etc.)
      return parentSchema;
    }
    return undefined;
  }

  rawTypeAt(path: string): Type | undefined { return this._typeOf(path); }

  keys(path?: string): string[] {
    // O(child-count) via PathMap's incremental children index.
    // Previously this was a linear scan of every entry in
    // `proj.values` plus every entry in `proj.schemas` per call —
    // which pushed runIndexConstraints to quadratic cost as the
    // total path count grew. Now both Maps are PathMap instances
    // that maintain a `parent → direct-child-segments` refcount
    // on every set/delete.
    //
    // Glob segments (`*`) are schema patterns, not concrete keys —
    // without this filter, `keys('sessions')` could return `['*']`
    // when a glob schema is mounted, and downstream code that
    // interpolates `*` into a path would end up with paths
    // containing `.*` and resolveGlob would recurse infinitely.
    const parent = path ?? '';
    const result = new Set<string>();
    for (const seg of this.proj.nodes.childSegments(parent)) {
      if (seg !== '*') result.add(seg);
    }
    return [...result];
  }

  has(path: string): boolean { return this._hasLeafValue(path); }

  suspended(): Block[] {
    return this.blocks.filter(b => b.status === 'suspended' && !this.resumedBlocks.has(b.seq));
  }

  /**
   * Cursor query: the blocks applied at-or-after `seq`, in append
   * order. The backbone of cross-process trace subscription and
   * historical replay. Returns *blocks*, not deltas — the consumer
   * sees the atomic unit of mutation with full metadata (seq, time,
   * entries, author, label) and can reconstruct causality across
   * processes when merged with other sources by `block.time`.
   *
   * Filtering is consumer-side: every block carries its pkey
   * (entry paths), author, and time, so any selection predicate
   * runs against the block the consumer already has. If server-
   * side pre-filtering becomes a bandwidth concern, the kernel's
   * existing indexes (backwardIndex per path, _exec.{seq}.produced
   * per block, _dep_partitions per partition) are already there
   * to accelerate it — no new filter type required.
   */
  appliedSince(seq: number): Block[] {
    return this.blocks.filter(b => b.seq >= seq && b.status === 'applied' && !this.invalidatedBlocks.has(b.seq));
  }

  isInvalidated(seq: number): boolean { return this.invalidatedBlocks.has(seq); }

  // ═══ TEMPORAL ═════════════════════════════════════════════════════

  nextWake(): number {
    let earliest = this.lockExpiry;
    // Check invariant (while) entries for temporal bounds
    for (const entry of this.backwardEntries.values()) {
      if (entry.kind !== 'invariant') continue;
      const b = this.blockBySeq.get(entry.blockSeq);
      if (!b?.while) continue;
      for (const c of b.while) {
        if (typeof c.args[0] === 'string' && c.args[0] === '_rt' && typeof c.args[1] === 'number') {
          if ((c.op === 'lt' || c.op === 'lte') && c.args[1] < earliest) earliest = c.args[1] as number;
        }
      }
    }
    for (const b of this.suspended()) {
      if (!b.where) continue;
      for (const c of b.where) {
        if (typeof c.args[0] === 'string' && c.args[0] === '_rt' && typeof c.args[1] === 'number') {
          if ((c.op === 'gt' || c.op === 'gte') && (c.args[1] as number) < earliest) earliest = c.args[1] as number;
        }
      }
    }
    return earliest;
  }

  // ═══ CONCRETENESS — certainty × feasibility ══════════════════════

  certainty(path: string): number {
    const value = this.get(path);
    const schema = this.typeAt(path);
    if (value !== undefined && (!schema || check(schema, value, path).ok)) {
      const now = this.clock();
      for (let i = this.blocks.length - 1; i >= 0; i--) {
        const b = this.blocks[i];
        if (b.status !== 'applied' || this.invalidatedBlocks.has(b.seq)) continue;
        for (const e of b.entries) {
          if (e.path === path && e.op === 'bind') {
            if (b.time <= now) return 1;
            return Math.max(0, 1 - ((b.time - now) / (this.lockExpiry - now || 60000)));
          }
        }
      }
      return 1;
    }
    // Commitment: matching capability exists
    if (schema && schema.kind !== 'fn') {
      const caps = this.getCapabilities();
      if (caps.some(c => !isNever(compose(c.outputType, schema)) && this.proj.capabilities.has(c.id))) return 1;
    }
    return 0;
  }

  feasibility(path: string, _v?: Set<string>): number {
    _v ??= new Set();
    if (_v.has(path)) return 0;
    _v.add(path);
    const val = this.get(path);
    const sch = this.typeAt(path);
    if (val !== undefined && (!sch || check(sch, val, path).ok)) { _v.delete(path); return 1; }
    if (!sch) { const h = Math.min(this.nextWake(), this.lockExpiry) - this.clock(); _v.delete(path); return 1 - Math.exp(-0.000001 * (h > 0 && isFinite(h) ? h : 60000)); }
    if (isNever(sch)) { _v.delete(path); return 0; }
    const caps = this.getCapabilities();
    const matching = caps.filter(c => !isNever(compose(c.outputType, sch)));
    if (matching.length === 0) { _v.delete(path); return typeSpecificity(sch); }
    const dl = this.pathDeadline(path);
    const rem = dl - this.clock();
    const viable = rem > 0 || !isFinite(dl) ? 1 : 0;
    let best = typeSpecificity(sch) * viable;
    for (const cap of matching) {
      const rel = this.readCapProp(cap, 'reliability') ?? typeSpecificity(cap.outputType);
      const cr = this.feasibility(cap.id, _v);
      const inp = this.inputFeasibility(cap, sch, _v);
      const tf = this.timeFactor(cap, rem);
      best = Math.max(best, rel * cr * inp * tf);
    }
    _v.delete(path);
    return best;
  }

  concreteness(path: string, _v?: Set<string>): number {
    const c = this.certainty(path);
    if (c === 1) return 1;
    if (c > 0) return c;
    return this.feasibility(path, _v);
  }

  concretenessDistribution(path: string, _seq?: number): ConcretenessDistribution {
    const now = this.clock();
    const value = this.get(path);
    const schema = this.typeAt(path);
    const alreadyRealized = value !== undefined && (!schema || check(schema, value, path).ok);

    // Factor 1 — Completion: time distribution on the type's IO.
    let timeFamily: string | undefined;
    let timeParams: DistParams | undefined;
    if (schema) {
      const timeDist = schema.constraints.find(c => c.op === 'distribution' && c.args[0] === 'time');
      if (timeDist) {
        timeFamily = timeDist.args[1] as string;
        timeParams = timeDist.args[2] as DistParams;
      }
    }

    // Factor 2 — Type survival: nearest decay constraint in ancestor chain.
    const decayInfo = this.findDecayInfo(path);

    // Scalar fallback for completion when no time distribution is present.
    // Uses the existing feasibility computation as the best-we-have estimate.
    const scalarFallback = alreadyRealized ? 1 : this.feasibility(path);

    const completionAt = (t: number): number => {
      if (alreadyRealized) return 1;
      if (timeFamily && timeParams) {
        return cdf(timeFamily, Math.max(0, t - now), timeParams);
      }
      return scalarFallback;
    };

    const typeSurvivalAt = (t: number): number => {
      if (!decayInfo) return 1;
      const dt = Math.max(0, t - decayInfo.rootTime);
      // 'fn' form: the function IS the arg. Call it directly. No registry.
      if (decayInfo.family === 'fn') {
        const fn = decayInfo.fn;
        return typeof fn === 'function' ? fn(dt) : 1;
      }
      // Named family: dispatch to built-in survival implementation.
      return survival(decayInfo.family, dt, decayInfo.params as DistParams);
    };

    // Placeholder: provenance-survival factor. Dimensionality present,
    // accuracy stubbed to 1 until producer-decay chain walking lands.
    const provenanceAt = (_t: number): number => 1;

    return {
      cdf(t: number): number {
        return completionAt(t) * typeSurvivalAt(t) * provenanceAt(t);
      },
      factors: {
        completion: completionAt,
        typeSurvival: typeSurvivalAt,
        provenance: provenanceAt,
      },
    };
  }

  /**
   * Walk the ancestor type chain from this path upward, looking for the
   * nearest type carrying a `decay` constraint. Returns the parsed decay
   * info including the effective root time (the earliest mount time of
   * any ancestor carrying the decay constraint).
   *
   * Two forms are surfaced:
   *   family 'exponential' | 'weibull' | 'fixed' — params is DistParams
   *   family 'fn' — fn is the direct evolution function (dt) => number
   */
  private findDecayInfo(path: string): {
    family: string;
    params?: DistParams;
    fn?: (dt: number) => number;
    rootTime: number;
  } | undefined {
    const parts = path.split('.');
    for (let i = parts.length; i >= 1; i--) {
      const ancestorPath = parts.slice(0, i).join('.');
      const schemas = [
        this._typeOf(ancestorPath),
        this._typeOf(ancestorPath + '.*'),
      ];
      for (const schema of schemas) {
        if (!schema) continue;
        const decayC = schema.constraints.find(c => c.op === 'decay');
        if (!decayC) continue;
        const family = decayC.args[0] as string;
        const rootTime = this.rootMountTime(ancestorPath);
        if (family === 'fn') {
          return {
            family,
            fn: decayC.args[1] as (dt: number) => number,
            rootTime,
          };
        }
        return {
          family,
          params: decayC.args[1] as DistParams,
          rootTime,
        };
      }
    }
    return undefined;
  }

  /**
   * Earliest bind time for a path (or one of its descendants). Used as
   * the anchor point for type-survival decay calculations. If nothing
   * has been mounted at this path yet, returns the current clock.
   */
  private rootMountTime(path: string): number {
    let earliest = Infinity;
    for (const b of this.blocks) {
      if (b.status !== 'applied' || this.invalidatedBlocks.has(b.seq)) continue;
      for (const e of b.entries) {
        if (e.path === path || e.path.startsWith(path + '.')) {
          if (b.time < earliest) earliest = b.time;
        }
      }
    }
    return isFinite(earliest) ? earliest : this.clock();
  }

  // ═══ GAPS + SEARCH ════════════════════════════════════════════════

  obligations(): { path: string; type: Type }[] {
    const r: { path: string; type: Type }[] = [];
    for (const [path, schema] of this._iterateTypes()) {
      if (schema.constraints.some(c => c.op === 'ref' || c.op === 'derived')) continue;
      const v = this.get(path);
      if (v === undefined) {
        // fn schema with installed impl → capability-availability obligation satisfied.
        // Invocation/result gaps are separate — this only covers "can something do this."
        if (schema.kind === 'fn' && this.implRegistry.has(path)) continue;
        r.push({ path, type: schema }); continue;
      }
      if (!check(schema, v, path).ok) r.push({ path, type: schema });
    }
    return r;
  }

  gaps(): GapInfo[] {
    const obs = this.obligations();
    if (obs.length === 0) return [];
    const caps = this.getCapabilities();
    // Lookahead horizon for time-conditioned priority (Commit 5).
    // Priorities reflect P(path realized-and-interpretable) at the
    // nearest pending temporal wake, or +60s if none is pending.
    const now = this.clock();
    const nextWake = this.nextWake();
    const lookaheadT = isFinite(nextWake) && nextWake > now
      ? Math.min(nextWake, now + 60_000)
      : now + 60_000;
    return obs.map(ob => {
      const matching = caps.filter(c => !isNever(compose(c.outputType, ob.type)));
      // Use cached priority if available (updated by propagateConjDelta on O(delta))
      let priority = this.gapPriorityCache.get(ob.path);
      if (priority === undefined) {
        // Compute: three-way conjunction flow + betweenness.
        // Each ref's contribution is its time-conditioned concreteness
        // distribution evaluated at the lookahead horizon.
        let conjBoost = 0;
        const watchEntries = this.backwardIndex.get(ob.path);
        if (watchEntries) for (const entry of watchEntries) {
          if (entry.kind !== 'conjunction') continue;
          let otherProb = 1;
          for (const ref of entry.refs) {
            if (ref !== ob.path) {
              otherProb *= this.concretenessDistribution(ref).cdf(lookaheadT);
            }
          }
          conjBoost = Math.max(conjBoost, otherProb);
        }
        const dependents = this.proj.depIndex.get(ob.path)?.size ?? 0;
        const betweenness = 1 + conjBoost + dependents;
        priority = this.concretenessDistribution(ob.path).cdf(lookaheadT) * betweenness;
        this.gapPriorityCache.set(ob.path, priority);
      }
      return {
        path: ob.path, type: ob.type,
        priority,
        capabilities: matching.map(c => c.id),
        inputsNeeded: matching.length > 0 ? backwardInfer(matching[0].fnType, ob.type) : undefined,
      };
    }).sort((a, b) => b.priority - a.priority);
  }

  /**
   * Branch-and-bound search through capability graph.
   * Explores multiple paths, prunes when cumulative probability drops
   * below the best complete plan found so far. Returns the globally
   * best plan, not just the first one found.
   */
  search(requiredType: Type, maxDepth = 5): SearchPlan {
    const caps = this.getCapabilities();
    let bestPlan: SearchPlan | null = null;

    const explore = (
      req: Type, depth: number, neededBy: string,
      stepsAcc: SearchStep[], probAcc: number, visited: Set<string>,
    ): void => {
      if (depth > maxDepth) return;
      // Prune: if accumulated probability is already worse than best complete plan, stop
      if (bestPlan && probAcc <= bestPlan.probability) return;

      const key = JSON.stringify(req);
      if (visited.has(key)) return;
      visited.add(key);

      const matches = caps.filter(c => !isNever(compose(c.outputType, req)));
      if (matches.length === 0) {
        // Dead end — record as a plan with gaps
        const plan: SearchPlan = {
          meetable: false, steps: [...stepsAcc], probability: probAcc,
          gaps: [{ type: req, reason: neededBy }],
        };
        if (!bestPlan || probAcc > bestPlan.probability) bestPlan = plan;
        visited.delete(key);
        return;
      }

      // Sort candidates by score descending (best-first search)
      const scored = matches.map(c => ({
        cap: c,
        score: (this.readCapProp(c, 'reliability') ?? typeSpecificity(c.outputType)) * this.feasibility(c.id),
      })).sort((a, b) => b.score - a.score);

      for (const { cap, score } of scored) {
        const branchProb = probAcc * score;
        // Prune: this branch can't beat the current best
        if (bestPlan && branchProb <= bestPlan.probability) continue;

        const inputReq = backwardInfer(cap.fnType, req);
        const inputReady = this.isInputAvailable(inputReq);
        const step: SearchStep = { capabilityId: cap.id, requiredOutput: req, requiredInput: inputReq, inputReady };
        const branchSteps = [...stepsAcc, step];

        if (inputReady || isAny(inputReq)) {
          // Complete plan — inputs satisfied
          const plan: SearchPlan = { meetable: true, steps: branchSteps, probability: branchProb, gaps: [] };
          if (!bestPlan || branchProb > bestPlan.probability) bestPlan = plan;
        } else {
          // Recurse: need to find capabilities for the input
          explore(inputReq, depth + 1, cap.id, branchSteps, branchProb, visited);
        }
      }
      visited.delete(key);
    };

    explore(requiredType, 0, 'root', [], 1, new Set());
    return bestPlan ?? { meetable: false, steps: [], gaps: [{ type: requiredType, reason: 'no capabilities' }], probability: 0 };
  }

  /**
   * Compact old blocks, respecting per-path compaction policies:
   *   - 'preserve': never compact blocks at this path (audit/trace)
   *   - number N: keep every Nth block at this path (historical sampling)
   *   - 'default' or unset: keep only the last value (current behavior)
   */
  compact(beforeSeq: number): { removed: number; kept: number } {
    const keep: Block[] = [];
    const remove: Block[] = [];
    for (const b of this.blocks) {
      if (b.seq >= beforeSeq) { keep.push(b); continue; }
      if (b.status === 'suspended') { keep.push(b); continue; }
      // Check if any entry's path has a 'preserve' policy
      const preserved = b.entries.some(e => {
        const policy = this.policyAt(e.path);
        return policy?.compact === 'preserve';
      });
      if (preserved) { keep.push(b); continue; }
      remove.push(b);
    }
    // From removable blocks, build snapshots respecting snapshot_every policies
    const snapshot = new Map<string, Block>();
    const pathBlockCounts = new Map<string, number>(); // track Nth-block for sampling
    for (const b of remove) {
      if (this.invalidatedBlocks.has(b.seq)) continue;
      for (const e of b.entries) {
        const policy = this.policyAt(e.path);
        const sampleRate = typeof policy?.compact === 'number' ? policy.compact : 0;
        if (sampleRate > 0) {
          // snapshot_every(N): keep every Nth block for this path
          const count = (pathBlockCounts.get(e.path) ?? 0) + 1;
          pathBlockCounts.set(e.path, count);
          if (count % sampleRate === 0) {
            keep.push({ ...b, entries: [e] });
            continue;
          }
        }
        // Default: last-value-wins snapshot
        snapshot.set(`${e.op}:${e.path}`, { ...b, entries: [e] });
      }
    }
    this.blocks = [...snapshot.values(), ...keep];
    // Rebuild indexes after compaction
    this.blockBySeq.clear();
    this.backwardIndex.clear();
    this.backwardEntries.clear();
    for (const b of this.blocks) this.indexBlock(b);
    return { removed: remove.length, kept: this.blocks.length };
  }

  // ═══ CAPABILITY AUTO-WIRING ════════════════════════════════════
  //
  // Derived values and capability invocations are the same operation:
  // a path needs a value, a fn can produce it, its inputs are (or
  // will be) available, fire it. For safe sole-match cases the kernel
  // now wires them automatically — a gap whose required type is
  // covered by exactly ONE cap's output type gains a `derived`
  // constraint citing the cap and its input property paths. From
  // there the existing cascade does the rest: when any input path
  // gets a value, fireLaws picks up the dependency, fireDerived
  // collects the remaining inputs, packs them into an object matching
  // the cap's param type, and invokes.
  //
  // When multiple caps could fill the gap the kernel does NOT wire.
  // Ambiguity is resolution that belongs to a handler at some
  // containing scope juncture — a session, process, or outer
  // Sequence — not to the kernel. Unresolved gaps propagate outward
  // through the same mechanism readers use today.
  //
  // Preconditions the kernel relies on:
  //   - The cap's fn-typed schema is present (carries param + returns).
  //   - The impl is registered (implRegistry.has(toolPath)) — without
  //     it we can't fire, so we also can't safely wire.
  //   - The cap impl is a pure function of its declared param type.
  //     Any `seq.get()` inside the closure is a hidden dependency the
  //     dep graph won't see, and attempt-2 (reverted) failed exactly
  //     there. See services/contextgraph/src/auth.ts for the closure-
  //     over-secret pattern that keeps declared inputs complete.
  //
  // Returns the list of input paths whose dependents just changed —
  // mount() adds these to `changedPaths` before firing laws, so
  // values already present at those paths propagate through the
  // new wiring in the same cascade as the mount that enabled it.
  private tryAutoWire(): string[] {
    const propagated: string[] = [];
    for (const [gapPath, gapSchema] of this._iterateTypes()) {
      if (gapSchema.kind === 'fn') continue;
      if (this._hasLeafValue(gapPath)) continue;
      if (constraintOf(gapSchema, 'derived')) continue;
      // Internal kernel namespaces are off-limits for auto-wiring —
      // _deps/_rdeps/_caps/_blocks/_exec are the reflective view of
      // the Sequence's own state, not application gaps to fill.
      if (gapPath.startsWith('_')) continue;

      // Find caps whose output covers gapSchema AND whose impl is
      // registered in this process. A cap without an impl can't
      // be fired here, so we don't wire against it.
      const matches: Array<{ path: string; inputPaths: string[] }> = [];
      for (const [toolPath, capSchema] of this._iterateTypes()) {
        if (capSchema.kind !== 'fn') continue;
        if (!this.implRegistry.has(toolPath)) continue;
        const rc = constraintOf(capSchema, 'returns');
        const pc = constraintOf(capSchema, 'param');
        if (!rc || !pc) continue;
        const outputType = rc.args[0] as Type;
        const paramType = pc.args[0] as Type;
        if (paramType.kind !== 'object') continue;
        if (!covers(gapSchema, outputType)) continue;
        const inputPaths = properties(paramType).filter(p => !p.optional).map(p => p.key);
        matches.push({ path: toolPath, inputPaths });
      }

      if (matches.length !== 1) continue;
      const { path: toolPath, inputPaths } = matches[0];

      // Install the derived constraint + dep edges. The constraint
      // args follow the derived convention: [fnId, ...argPaths].
      const newConstraint: Constraint = { op: 'derived', args: [toolPath, ...inputPaths] };
      const newSchema: Type = { ...gapSchema, constraints: [...gapSchema.constraints, newConstraint] };
      this._writeSchema(gapPath, newSchema);
      for (const p of inputPaths) {
        this.addDep(p, gapPath);
        // If the input already has a value, mount() should cascade
        // from it through the new dep so the gap gets filled in the
        // same fireLaws pass — not on some future unrelated mutation.
        if (this._hasLeafValue(p)) propagated.push(p);
      }
    }
    return propagated;
  }

  // ═══ DEP MANAGEMENT — values are truth, caches are fast paths ═════

  /** Add a dependency: source → dependent. Writes the value AND updates the cache.
   *  Tags each edge with source and dependent partitions for partition-aware queries. */
  private addDep(source: string, dependent: string): void {
    // Cache (fast path for fireLaws)
    if (!this.proj.depIndex.has(source)) this.proj.depIndex.set(source, new Set());
    this.proj.depIndex.get(source)!.add(dependent);
    if (!this.proj.reverseDepIndex.has(dependent)) this.proj.reverseDepIndex.set(dependent, new Set());
    this.proj.reverseDepIndex.get(dependent)!.add(source);
    // Values (canonical, readable via get(), watchable by backward index)
    const depsVal = (this._leafValueAt(`_deps.${source}`) as string[] | undefined) ?? [];
    if (!depsVal.includes(dependent)) {
      this._writeBind(`_deps.${source}`, [...depsVal, dependent]);
    }
    const rdepsVal = (this._leafValueAt(`_rdeps.${dependent}`) as string[] | undefined) ?? [];
    if (!rdepsVal.includes(source)) {
      this._writeBind(`_rdeps.${dependent}`, [...rdepsVal, source]);
    }
    // Partition-tagged dep edges: _dep_partitions.{sourcePartition}.{source} = [dependent, ...]
    // Enables queries like "all deps from proc partition" without scanning the full dep index.
    // Type-aware: if the source has a schema with a `partition(p)`
    // declaration, that wins over the path prefix.
    const srcP = partitionOf(source, this._typeOf(source));
    const pKey = `_dep_partitions.${srcP}.${source}`;
    const pVal = (this._leafValueAt(pKey) as string[] | undefined) ?? [];
    if (!pVal.includes(dependent)) {
      this._writeBind(pKey, [...pVal, dependent]);
    }
  }

  // ═══ INTERNALS ════════════════════════════════════════════════════

  private applyEntry(entry: MountEntry): void {
    switch (entry.op) {
      case 'bind': {
        const bowner = bindOwner(this.currentBlockAuthor);
        if (entry.value === undefined) { this._deleteLeafValue(entry.path, bowner); break; }

        // Key-derived addressing: if this path has a glob schema with a key constraint,
        // and the value is an object, derive the actual path from the key fields.
        // sessions << { user: "alice", workspace: "acme" } → sessions.alice.acme
        const globSchema = this._typeOf(entry.path + '.*');
        if (globSchema && typeof entry.value === 'object' && entry.value !== null && !Array.isArray(entry.value)) {
          const keyConstraint = globSchema.constraints.find(c => c.op === 'key');
          if (keyConstraint) {
            const obj = entry.value as Record<string, unknown>;
            const keyParts = (keyConstraint.args as string[]).map(f => {
              const v = obj[f];
              return v !== undefined ? String(v) : '';
            }).filter(Boolean);
            if (keyParts.length > 0) {
              const derivedPath = `${entry.path}.${keyParts.join('.')}`;
              this.applyEntry({ op: 'bind', path: derivedPath, value: entry.value });
              break;
            }
          }
        }

        // Check type at target path — the type determines how this write
        // gets processed. Use the DECLARED type (no prior bind literal)
        // so a state transition isn't rejected as a literal mismatch
        // against the value being replaced.
        const schema = this._declaredTypeOf(entry.path);
        if (schema) {
          const result = check(schema, entry.value, entry.path);
          if (!result.ok) {
            // Type rejects the write — don't apply
            // The gaps from the check tell us what's wrong/missing
            break;
          }
          if (result.follows && result.follows.length > 0) {
            // Type decomposes the write: each follow continues at its ref target
            for (const f of result.follows) {
              this.applyEntry({ op: 'bind', path: f.ref, value: f.value });
            }
            // Apply the full value locally too (the source of truth for this path)
            this._writeBind(entry.path, entry.value, bowner);
            break;
          }
        }
        // Write-path classification for fn-typed schemas:
        //   bind(path, fn)    when value is itself a function →
        //     REGISTER the fn as the impl for this path. Equivalent
        //     to the legacy `mount('cap', path, fn)` — the two paths
        //     converge on exactly the same state (implRegistry entry
        //     + capabilities marker + _caps list). This lets callers
        //     treat "a capability is a mounted coherent function" as
        //     the model, without a distinct `cap` op, which is the
        //     direction the `cap`-op collapse work is heading.
        //
        //   bind(path, value) when value is NOT a function → INVOKE
        //     the already-registered impl with `value` as the input.
        //     The capability produces the output; the schema stays;
        //     value goes to `.input`, result to `.result`.
        if (schema && schema.kind === 'fn') {
          if (typeof entry.value === 'function') {
            // Register-as-impl path. Mirrors the cap dispatch below
            // so `bind(path, fn)` and `cap(path, fn)` produce
            // identical projection state.
            this.implRegistry.set(entry.path, entry.value as Function);
            this.proj.capabilities.set(entry.path, true);
            this._writeBind('_caps', [...this.proj.capabilities.keys()]);
            break;
          }
          // resolveImpl walks ancestor refs — the impl may be
          // registered at a shared cap path while `entry.path` is
          // a session install alias. Side effects still record at
          // entry.path below, keeping session state isolated.
          const impl = this.resolveImpl(entry.path);
          if (impl) {
            const paramConstraint = schema.constraints.find(c => c.op === 'param');
            const inputType = paramConstraint ? paramConstraint.args[0] as Type : null;
            if (!inputType || check(inputType, entry.value, entry.path).ok) {
              // Elect a commitment record for this invocation. Per
              // specs/docs/COMMITMENTS.md, every fn-typed invocation
              // is a write-lease — the impl is the holder committing
              // to produce a result at .result (the head). Sync
              // impls fulfill at tick-end; async impls fulfill when
              // the Promise settles; throws → violate.
              //
              // The commitment record's fields are written as
              // side-effect entries on the outer block (same pattern
              // as `.input`/`.result` below), so they land atomically
              // and appear in the block log for audit.
              const commitmentId = `c_${this.nextBlockSeq}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
              const commitmentPath = `_commitments.${commitmentId}`;
              const head = `${entry.path}.result`;
              const writeCommitmentField = (field: string, value: unknown) => {
                const e: MountEntry = { op: 'bind', path: `${commitmentPath}.${field}`, value };
                this._writeBind(e.path, value);
                if (this.currentBlockEntries) this.currentBlockEntries.push(e);
              };
              writeCommitmentField('typeRef', entry.path);
              writeCommitmentField('holder', entry.path);
              writeCommitmentField('head', head);
              writeCommitmentField('control', `${commitmentPath}.control`);
              writeCommitmentField('status', 'pending');
              this.mutationCount++;

              // Record the input and result as REAL log entries on
              // the containing block. Two consequences:
              //   1. `getAt('{fnPath}.input', invocationSeq)` reads
              //      the per-call input from the log — no need to
              //      shadow-snapshot at _exec.{seq}.callInput.
              //   2. History queries walk this.blocks directly,
              //      finding each invocation by the presence of an
              //      .input bind on a fn-typed path.
              const inputEntry: MountEntry = { op: 'bind', path: `${entry.path}.input`, value: entry.value };
              const priorInput = this._leafValueAt(inputEntry.path);
              if (!Object.is(priorInput, inputEntry.value)) this.mutationCount++;
              this._writeBind(inputEntry.path, inputEntry.value);
              if (this.currentBlockEntries) this.currentBlockEntries.push(inputEntry);
              const startTs = Date.now();
              try {
                const output = impl(entry.value);
                if (output !== undefined && typeof (output as any)?.then === 'function') {
                  // Async impl — resolve the Promise, then mount
                  // the result. The mount fires a new block (not
                  // part of the current cascade) so downstream
                  // deps and deltas see it as a separate event.
                  // The Promise is ALSO stashed at this.pendingToolCompletion
                  // so mount()'s result builder can surface it on
                  // MountResult.toolCompletion — imperative callers
                  // await this to bridge JS Promise semantics with
                  // the substrate's async cap result mount.
                  const resultPath = head;
                  const errorPath = `${entry.path}.error`;
                  this.pendingToolCompletion = (output as Promise<unknown>).then((resolved) => {
                    const lat = Date.now() - startTs;
                    if (resolved !== undefined) {
                      this.mount('bind', resultPath, resolved);
                    }
                    this.mount('bind', `${commitmentPath}.status`, 'fulfilled');
                    return { ok: true, output: resolved, latencyMs: lat };
                  }, (err: any) => {
                    const lat = Date.now() - startTs;
                    const msg = err?.message ?? String(err);
                    this.mount('bind', errorPath, msg);
                    this.mount('bind', `${commitmentPath}.violateReason`, msg);
                    this.mount('bind', `${commitmentPath}.status`, 'violated');
                    return { ok: false, error: msg, latencyMs: lat };
                  });
                } else if (output !== undefined) {
                  const resultEntry: MountEntry = { op: 'bind', path: head, value: output };
                  this.applyEntry(resultEntry);
                  if (this.currentBlockEntries) this.currentBlockEntries.push(resultEntry);
                  writeCommitmentField('status', 'fulfilled');
                } else {
                  // Sync impl returned undefined (void-typed). Still
                  // a fulfillment — the commitment is considered
                  // complete once the impl returns without throw.
                  writeCommitmentField('status', 'fulfilled');
                }
              } catch (e: any) {
                this._writeBind(`${entry.path}.error`, e.message);
                writeCommitmentField('violateReason', e.message);
                writeCommitmentField('status', 'violated');
              }
              break;
            }
          }
        }

        // Bump the mutation counter only if this bind actually
        // changed the stored value. Same-value re-mounts keep the
        // counter still — that is how the index-constraint fixpoint
        // detects convergence: if a pass produces zero mutations,
        // every body mount was a no-op and there is no more work.
        const priorValue = this._leafValueAt(entry.path);
        if (!Object.is(priorValue, entry.value)) this.mutationCount++;
        this._writeBind(entry.path, entry.value, bowner);
        break;
      }
      case 'delete': {
        const downer = bindOwner(this.currentBlockAuthor);
        // Clean up provenance sidecars written by the object-bind
        // path above. When an object is mounted at path X, mount()
        // writes `{X}.{field}._provenance` entries for each field —
        // delete without cleanup leaves those dangling, which makes
        // keys(X) still report X as a child even though X itself
        // has no value.
        const former = this._leafValueAt(entry.path);
        this._deleteLeafValue(entry.path, downer);
        if (former !== null && typeof former === 'object' && !Array.isArray(former)) {
          for (const k of Object.keys(former as Record<string, unknown>)) {
            this._deleteLeafValue(`${entry.path}.${k}._provenance`);
          }
        }
        // SCHEMA-LITERAL CLEAR: drop only `literal` constraints from
        // the deleter's schema claim, not the whole claim. Other
        // constraints (ref, property, min, ...) persist — those
        // declare type shape, not value.
        const sowner = schemaOwner(this.currentBlockAuthor);
        const node = this.proj.nodes.get(entry.path);
        const schemaCs = node?.claims.get(sowner);
        if (schemaCs && schemaCs.some(c => c.op === 'literal')) {
          const remaining = schemaCs.filter(c => c.op !== 'literal');
          if (remaining.length === 0) node!.claims.delete(sowner);
          else node!.claims.set(sowner, remaining);
          if (node!.claims.size === 0 && node!.kind === undefined) this.proj.nodes.delete(entry.path);
        }
        break;
      }
      case 'schema': {
        // HC4: cascade fires on any narrowing that changes observable
        // state. A schema mount that lands a literal (or removes one)
        // changes get() at this path — bump mutationCount so cascade
        // dispatch sees it the same way it sees a bind.
        const sowner = schemaOwner(this.currentBlockAuthor);
        const priorVal = this._leafValueAt(entry.path);
        this._writeSchema(entry.path, entry.value as Type, sowner);
        const newVal = this._leafValueAt(entry.path);
        if (!Object.is(priorVal, newVal)) this.mutationCount++;
        if (entry.value) {
          const type = entry.value as Type;
          // Fn-kind schema IS the declaration that a capability exists
          // at this path. `capabilities` is the declared-set (type
          // state; persistent across processes); `implRegistry` is the
          // per-process local scope of what impls are cached here.
          // They serve different questions:
          //   capabilities.has(x) — is X a declared capability the
          //                         system knows about, even if this
          //                         process can't currently run it?
          //   implRegistry.has(x) — can THIS process invoke X right now?
          // A schema mount of an fn-typed value populates the declared
          // set as a side effect — no separate cap declaration needed.
          // The legacy `cap path true` becomes redundant with
          // `schema path fnType`.
          if (type.kind === 'fn' && !this.proj.capabilities.has(entry.path)) {
            this.proj.capabilities.set(entry.path, true);
            this._writeBind('_caps', [...this.proj.capabilities.keys()]);
          }
          // Surface the cap's policy version (R11) at a stable
          // _caps_version.{toolPath} address so consumers can read
          // which version of a cap they are running. Hot-reload of
          // the schema replaces the stored version with the new one.
          if (type.kind === 'fn') {
            const versionConstraint = type.constraints.find(c => c.op === 'version');
            if (versionConstraint) {
              const v = (versionConstraint.args as unknown[])[0];
              if (typeof v === 'number') {
                this._writeBind(`_caps_version.${entry.path}`, v);
              }
            }
          }
          for (const c of type.constraints) {
            if (c.op === 'ref') {
              const src = c.args[0] as string;
              this.addDep(src, entry.path);
            }
            if (c.op === 'identity') {
              const [outPath, inPath] = c.args as [string, string];
              this.registerPredicate(entry.path, outPath, inPath);
            }
            if (c.op === 'equation') {
              const [lhs, rhs] = c.args as [string, string, unknown?];
              this.registerPredicate(entry.path, lhs, rhs);
            }
            if (c.op === 'derived') {
              const [, ...aps] = c.args as string[];
              for (const a of aps) {
                // Glob arg: index under the prefix. The cascade walks
                // ancestor prefixes to fire glob deps.
                //   `prefix.*`  → prefix = "prefix"
                //   `*`         → prefix = "" (catch-all, matches any path)
                if (a === '*' || a.endsWith('.*')) {
                  const prefix = a === '*' ? '' : a.slice(0, -2);
                  if (!this.globDepIndex.has(prefix)) this.globDepIndex.set(prefix, new Set());
                  this.globDepIndex.get(prefix)!.add(entry.path);
                } else {
                  this.addDep(a, entry.path);
                }
              }
            }
            // Segmented strings with ref segments project to the
            // concatenation of their resolved segments. Register dep
            // edges so the schema's path reflows when any ref'd
            // substrate value changes. The fireDerived branch above
            // handles cascade; here we just register the deps. Initial
            // projection seeds AFTER the constraint loop, once we know
            // the type holds segments.
            if (c.op === 'segment' && type.kind === 'string') {
              const segType = c.args[1] as Type | undefined;
              const ref = segType?.constraints?.find(cc => cc.op === 'ref');
              if (ref) this.addDep(ref.args[0] as string, entry.path);
            }
          }
          // Seed initial projection for segmented strings. Runs once
          // per schema mount; the fireDerived branch handles cascade
          // on subsequent dep changes.
          if (type.kind === 'string') {
            const seeded = projectSegmentedString(type, (p) => this._leafValueAt(p));
            if (seeded !== undefined && seeded !== this._leafValueAt(entry.path)) {
              this._writeBind(entry.path, seeded);
            }
          }
        }
        break;
      }
      case 'cap':
        // Projection gets a serializable marker; live functions go to implRegistry
        this.proj.capabilities.set(entry.path, true);
        if (typeof entry.value === 'function') this.implRegistry.set(entry.path, entry.value as Function);
        // Write capability list as a value — readable via get('_caps')
        this._writeBind('_caps', [...this.proj.capabilities.keys()]);
        break;
      case 'narrow': {
        // CONSTRAINT_GRAPH.md Artifact 6 R-A6.1. Compose constraints
        // into the constraint set at path. The kernel-level write
        // primitive that bind and schema desugar to.
        //
        // The value MUST be a Constraint[]. Literal constraints in the
        // list update the bind value (boundValue slot); other
        // constraints accumulate as schema-side narrowings.
        const constraints = (entry.value ?? []) as Constraint[];
        for (const c of constraints) {
          if (c.op === 'literal') {
            this._writeBind(entry.path, c.args[0]);
          } else {
            // Compose this single constraint into the schema side. We
            // synthesize a Type with kind preserved from any existing
            // schema (or 'any' if absent) so the partial narrowing
            // doesn't lose the path's declared kind.
            const existing = this._typeOf(entry.path);
            const merged: Type = {
              kind: existing?.kind ?? 'any',
              constraints: [...(existing?.constraints ?? []), c],
              meta: existing?.meta,
            };
            this._writeSchema(entry.path, merged);
          }
        }
        break;
      }
      case 'policy': this.proj.policies.set(entry.path, entry.value as any); break;
      case 'invalidate': this.invalidatedBlocks.add(entry.value as number); break;
    }
  }

  /** Resolve a glob path (prefix.*) to all matching child values at the leaf field. */
  private resolveGlob(pattern: string): unknown[] {
    const starIdx = pattern.indexOf('.*');
    if (starIdx === -1) {
      const v = this.get(pattern);
      return v !== undefined ? [v] : [];
    }
    const prefix = pattern.slice(0, starIdx);
    const suffix = pattern.slice(starIdx + 2); // after .*
    const children = this.keys(prefix);
    const results: unknown[] = [];
    for (const child of children) {
      const childPath = suffix ? `${prefix}.${child}${suffix}` : `${prefix}.${child}`;
      if (childPath.includes('.*')) {
        results.push(...this.resolveGlob(childPath));
      } else {
        const v = this.get(childPath);
        if (v !== undefined) results.push(v);
      }
    }
    return results;
  }

  /** Compute an aggregate over a glob path. */
  /**
   * Query the call history by walking the block log directly. Per-
   * call input and result are stored as real block entries (the fn
   * invocation path in applyEntry pushes `.input` and `.result`
   * sub-binds into the containing block's entries array), so every
   * invocation's IO is recoverable via getAt(path, blockSeq). No
   * shadow snapshots, no duplication — the Sequence IS the history,
   * and the kernel's natural compression applies uniformly.
   *
   * For each `_exec.{seq}` record whose `.invoked` matches `method`
   * (by last segment of the fn path), read the call's input via
   * getAt('{invoked}.input', seq). Apply the field filter. Aggregate
   * based on `op`:
   *
   *   'last'   → { seq, invoked, input, output, time }
   *   'count'  → number of matching calls
   *   'exists' → boolean
   *   'sum'    → sum over (output.value | output | 0) per match
   *
   * `last` returns a navigable record — the seq number lets callers
   * pull any other per-call path via getAt if they need more than
   * input/output/time.
   */
  private resolveHistory(
    op: string,
    method: string,
    filter?: Record<string, unknown>,
  ): unknown {
    const execKeys = this.keys('_exec')
      .map(k => parseInt(k, 10))
      .filter(n => !isNaN(n))
      .sort((a, b) => b - a); // newest first

    type Rec = { seq: number; invoked: string; input: unknown; output: unknown; time: number };
    const matches: Rec[] = [];

    for (const sk of execKeys) {
      const invoked = this._leafValueAt(`_exec.${sk}.invoked`) as string | undefined;
      if (!invoked) continue;
      const calledMethod = invoked.split('.').pop() ?? '';
      if (calledMethod !== method) continue;
      // Read the per-call input and result from the block log.
      // getAt walks blocks backward from `sk` looking for a bind at
      // the given path — the fn invocation added `.input`/`.result`
      // entries to block `sk`, so this returns exactly that call's
      // IO, not a later overwrite.
      const input = this.getAt(`${invoked}.input`, sk);
      const output = this.getAt(`${invoked}.result`, sk);
      const time = (this._leafValueAt(`_exec.${sk}.time`) as number | undefined) ?? 0;
      if (filter && Object.keys(filter).length > 0) {
        if (input === null || typeof input !== 'object') continue;
        const obj = input as Record<string, unknown>;
        let ok = true;
        for (const [k, v] of Object.entries(filter)) {
          if (!Object.is(obj[k], v)) { ok = false; break; }
        }
        if (!ok) continue;
      }
      matches.push({ seq: sk, invoked, input, output, time });
    }

    switch (op) {
      case 'last': return matches[0];
      case 'count': return matches.length;
      case 'exists': return matches.length > 0;
      case 'sum': {
        let total = 0;
        for (const m of matches) {
          const v = m.output !== null && typeof m.output === 'object'
            ? (m.output as any).value
            : m.output;
          if (typeof v === 'number') total += v;
        }
        return total;
      }
      default: return undefined;
    }
  }

  private resolveAggregate(fn: string, args: unknown[]): unknown {
    const pattern = args[0] as string;
    switch (fn) {
      case 'sum': {
        const vals = this.resolveGlob(pattern);
        return vals.reduce((acc: number, v) => acc + (typeof v === 'number' ? v : 0), 0);
      }
      case 'count': {
        if (typeof pattern === 'string' && pattern.includes('.*')) return this.resolveGlob(pattern).length;
        return this.keys(pattern).length;
      }
      case 'count_where': {
        const field = args[1] as string;
        const expected = args[2];
        const vals = this.resolveGlob(pattern);
        return vals.filter(v => {
          if (typeof v === 'object' && v !== null && field in (v as any)) return Object.is((v as any)[field], expected);
          return Object.is(v, expected);
        }).length;
      }
      case 'min': {
        const vals = this.resolveGlob(pattern).filter((v): v is number => typeof v === 'number');
        return vals.length > 0 ? Math.min(...vals) : undefined;
      }
      case 'max': {
        const vals = this.resolveGlob(pattern).filter((v): v is number => typeof v === 'number');
        return vals.length > 0 ? Math.max(...vals) : undefined;
      }
      case 'avg': {
        const vals = this.resolveGlob(pattern).filter((v): v is number => typeof v === 'number');
        return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
      }
      default: return undefined;
    }
  }

  /**
   * Public entry for constraint evaluation with variable bindings.
   * Substitutes `$var` references in the constraint tree with
   * values from `bindings` (type-preserving — numbers stay numbers)
   * and wraps each substitution in `{ literal: value }` so that
   * evalConstraint's resolvePath/resolveValue treat the substituted
   * form as a raw value, not a path to look up. Used by admission-law
   * enforcement to check pre-mount authorization predicates where
   * bindings come from block-level context (author, path, time)
   * rather than from the sequence's stored state.
   */
  public evalWithBindings(c: Constraint, bindings: Record<string, unknown>): boolean {
    const substituted = Sequence.substituteLiterals(c, bindings);
    return this.evalConstraint(substituted);
  }

  // ═══ INDEX CONSTRAINTS — class-level tuple projection ══════════════

  /**
   * Project a where clause into a tuple space. Returns the set of
   * tuples (binding maps) that satisfy every filter predicate,
   * starting from the Cartesian product of every `bind_from` domain.
   *
   * A `bind_from(var, glob)` clause contributes to the product:
   * for each immediate child key of `glob`'s prefix, a new tuple is
   * created that binds `var` to that key. Any non-bind_from
   * constraint is a filter: a tuple passes iff the constraint
   * evaluates to true with that tuple's bindings substituted.
   *
   * A where clause with zero `bind_from` clauses returns `[{}]` (one
   * unit tuple — "fire once") when all predicates pass, or `[]`
   * (empty — "don't fire") when a predicate fails.
   */
  private evalBindings(clauses: readonly Constraint[]): Record<string, unknown>[] {
    let tuples: Record<string, unknown>[] = [{}];
    for (const c of clauses) {
      if (c.op === 'bind_from') {
        const [varName, globPath] = c.args as [string, string];
        const next: Record<string, unknown>[] = [];
        // Dependent bindings: if the globPath contains `{var}`
        // references, interpolate them per-tuple before resolving.
        for (const tuple of tuples) {
          const concretePath = globPath.includes('{')
            ? this.interpolatePath(globPath, tuple)
            : globPath;
          if (concretePath.endsWith('.*')) {
            // Glob: bind var to each key matched by the pattern.
            // Simple trailing wildcard (`chan.users.alice.*`): use
            // keys() for immediate children. Interior wildcards
            // (`state.contracts.*.approval.*`): use path-pattern
            // matching against all value paths so each matched
            // FULL path becomes a tuple. Promotion uses the
            // interior form by binding to a field containing a
            // pattern string.
            const segments = concretePath.split('.');
            const starCount = segments.filter(s => s === '*').length;
            const hasInteriorStar = starCount > 1 ||
              (starCount === 1 && segments[segments.length - 1] !== '*');
            if (starCount === 1 && segments[segments.length - 1] === '*' && !hasInteriorStar) {
              // Trailing-only glob: iterate child keys of the prefix.
              const prefix = concretePath.slice(0, -2);
              const childKeys = this.keys(prefix);
              for (const key of childKeys) {
                next.push({ ...tuple, [varName]: key });
              }
            } else {
              // Interior / multi wildcards: scan all value paths
              // and tuple-bind each match (the full matched path,
              // not a single key segment).
              for (const [valuePath] of this._iterateLeafValues()) {
                if (valuePath.startsWith('_')) continue;
                if (this.matchPathPattern(concretePath, valuePath)) {
                  next.push({ ...tuple, [varName]: valuePath });
                }
              }
            }
          } else {
            // Field-deref: bind var to the value at the path.
            // `user in req.{req}.user` reads the req's user field
            // and binds `user` to that value, contributing a single
            // tuple. If the path has no value, the current tuple
            // is filtered out (no binding to extend).
            const value = this.get(concretePath);
            if (value !== undefined) {
              next.push({ ...tuple, [varName]: value });
            }
          }
        }
        tuples = next;
      } else {
        tuples = tuples.filter(t => this.evalWithBindings(c, t));
      }
    }
    return tuples;
  }

  /**
   * Interpolate `{var}` or `{var:modifier}` placeholders in a path
   * string with a tuple binding. Modifiers transform the substituted
   * value before inserting it:
   *   - `:key` replaces `.` with `_`, so a path-valued binding can be
   *     used as a path-segment key (e.g. binding a `state.foo.bar`
   *     subject into `req.r_{subject:key}.status`, producing
   *     `req.r_state_foo_bar.status` instead of deeply nested keys).
   */
  private interpolatePath(path: string, tuple: Record<string, unknown>): string {
    return path.replace(/\{(\w+)(?::(\w+))?\}/g, (match, name, modifier) => {
      if (!(name in tuple)) return match;
      const raw = String(tuple[name]);
      if (modifier === 'key') return raw.replace(/\./g, '_');
      return raw;
    });
  }

  /**
   * Expand a glob pattern to a list of concrete paths it matches.
   * The pattern may contain `*` segments at any level:
   *   - `req.*` → every direct child of req
   *   - `state.*.pending` → every `state.X.pending` where that
   *      specific sub-path exists
   *   - `chan.users.*.*.visible` → every two-deep descendant
   *
   * A path matches if it has ANY presence — either a direct value
   * (via `get`) OR sub-paths beneath it (via `keys`). The second
   * condition matters for iteration patterns like `req.*` where a
   * child `req.r1` has no whole-object value but holds sub-path
   * binds (`req.r1.subject`, `req.r1.status`, etc.). Without it,
   * project iteration over such children would silently miss them.
   */
  matchingPaths(pattern: string): string[] {
    const segs = pattern.split('.');
    const results: string[] = [];
    const walk = (i: number, acc: string): void => {
      if (i === segs.length) {
        if (this.get(acc) !== undefined || this.keys(acc).length > 0) {
          results.push(acc);
        }
        return;
      }
      const seg = segs[i];
      const sep = acc === '' ? '' : '.';
      if (seg === '*') {
        for (const k of this.keys(acc)) walk(i + 1, `${acc}${sep}${k}`);
      } else {
        walk(i + 1, `${acc}${sep}${seg}`);
      }
    };
    walk(0, '');
    return results;
  }

  /**
   * Match a dot-separated path against a pattern where `*`
   * matches exactly one segment at that position. Both sides
   * must have the same number of segments. Used by evalBindings
   * for interior-wildcard globPaths (e.g. `state.contracts.*.legal`).
   */
  private matchPathPattern(pattern: string, path: string): boolean {
    const pp = pattern.split('.');
    const pa = path.split('.');
    if (pp.length !== pa.length) return false;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i] !== '*' && pp[i] !== pa[i]) return false;
    }
    return true;
  }

  /**
   * Interpolate `{var}` in a value. Strings are interpolated
   * in-place; objects are walked recursively so that nested string
   * fields inside a body's value get substituted. Non-string, non-
   * object values pass through untouched.
   *
   * Special form `{ _deref: path }` — emitted by the walker for
   * index-class body values that are name expressions with
   * `{var}` interpolation — gets interpolated-and-dereferenced:
   * the path's `{var}` segments are substituted per-tuple, then
   * the resulting path is read from the sequence to produce a
   * value. This is how body entries like
   * `requiredAction = _policies.promotion.{policy}.requiredAction`
   * resolve dynamically at fire time.
   */
  private interpolateValue(value: unknown, tuple: Record<string, unknown>): unknown {
    if (typeof value === 'string') {
      return value.includes('{') ? this.interpolatePath(value, tuple) : value;
    }
    if (Array.isArray(value)) return value.map(v => this.interpolateValue(v, tuple));
    if (typeof value === 'object' && value !== null) {
      const derefPath = (value as any)._deref;
      if (typeof derefPath === 'string') {
        const concretePath = derefPath.includes('{')
          ? this.interpolatePath(derefPath, tuple)
          : derefPath;
        return this.get(concretePath);
      }
      // Expression shape: `{op, lhs, rhs}` — the same three-part
      // form `resolveExpr` already handles for constraint filters.
      // Operands recurse through interpolateValue (so `{var}` segments
      // get substituted and nested `_deref` forms resolve against the
      // sequence), then the binop is applied via the shared reducer.
      // Body values and filter args share one arithmetic vocabulary.
      if ('op' in (value as any) && 'lhs' in (value as any) && 'rhs' in (value as any)) {
        const lhs = this.interpolateValue((value as any).lhs, tuple);
        const rhs = this.interpolateValue((value as any).rhs, tuple);
        return Sequence.applyBinop((value as any).op, lhs, rhs);
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.interpolateValue(v, tuple);
      }
      return out;
    }
    return value;
  }

  /**
   * Iterate every schema with an `index_spec` constraint and fire
   * its body once per tuple in the current binding space. Called at
   * the end of every mount() so:
   *   - initial mount of an index-constrained schema instantiates
   *     all currently-satisfying tuples immediately
   *   - later mounts that change the binding space (new keys under
   *     a bind_from glob, or new values that satisfy a filter
   *     predicate) re-evaluate and mount any new tuples
   *
   * Already-fired tuples are re-fired on every pass. This is safe
   * because same-value-at-same-path compose is a no-op — the
   * kernel's idempotency handles deduplication structurally.
   * Optimization via per-class fired-tuple memoization is future
   * work once the primitive is proven.
   */
  private runIndexConstraints(): void {
    if (this.instantiatingIndex) return;
    this.instantiatingIndex = true;
    try {
      // Fixpoint loop: each pass re-projects every class's tuple
      // space against current state. A body mount from one class
      // can expand another class's binding space (e.g. promotion
      // creates a req whose user field lets preroute fire, whose
      // preferredChannel lets deliver fire, whose delivered status
      // lets claiming fire). A single linear pass would miss those
      // downstream classes because the re-entry guard blocks nested
      // runIndexConstraints calls during body mounts.
      //
      // Termination: the loop exits when an entire pass produces
      // zero mutations (every body mount was a same-value no-op).
      // `mutationCount` is bumped by applyEntry only on real
      // changes — head advances on every mount, including _rt
      // updates and no-op re-mounts, so head is not a convergence
      // signal. Bounded by a hard iteration limit to fail loud on
      // non-convergent feedback loops rather than hang silently.
      const maxPasses = 32;
      let lastMutatingClass: string | undefined;
      let lastMutatingPath: string | undefined;
      let lastMutatingValue: unknown;
      for (let pass = 0; pass < maxPasses; pass++) {
        const mutationsBefore = this.mutationCount;
        for (const [schemaPath, schema] of this._iterateTypes()) {
          const specConstraint = constraintOf(schema, 'index_spec');
          if (!specConstraint) continue;
          const spec = specConstraint.args[0] as {
            indexedBy?: string[];
            where?: Constraint[];
            body?: Array<{ op: string; path: string; value?: unknown }>;
          };
          // Within-pass tuple iteration with re-evaluation on
          // mutation. After each tuple's body produces a real change,
          // re-project the where clause: a body mount may have
          // satisfied an exclusion filter that now invalidates a
          // remaining tuple. Without the re-eval, both task A and
          // task B fire bodies even though task A's mount of
          // `cap.input` was supposed to make task B's
          // `notExists(cap.input)` filter false.
          //
          // The `seen` set guards against re-firing tuples that
          // already executed this pass (re-eval would surface them
          // again because they still match — we want exactly-once
          // per pass). Idempotent classes whose bodies don't mutate
          // (mountCount delta == 0) skip the re-eval entirely,
          // preserving the prior O(tuples) per-pass cost for
          // promotion-style classes.
          const tupleKey = (t: Record<string, unknown>): string => {
            const keys = Object.keys(t).sort();
            return keys.map(k => `${k}=${JSON.stringify(t[k])}`).join('|');
          };
          let tuples = this.evalBindings(spec.where ?? []);
          const seenTuples = new Set<string>();
          let i = 0;
          while (i < tuples.length) {
            const tuple = tuples[i++];
            const key = tupleKey(tuple);
            if (seenTuples.has(key)) continue;
            seenTuples.add(key);
            const mutBeforeTuple = this.mutationCount;
            for (const bodyEntry of spec.body ?? []) {
              const path = this.interpolatePath(bodyEntry.path, tuple);
              const value = this.interpolateValue(bodyEntry.value, tuple);
              const mutBefore = this.mutationCount;
              this.mount(bodyEntry.op as any, path, value);
              if (this.mutationCount !== mutBefore) {
                lastMutatingClass = schemaPath;
                lastMutatingPath = path;
                lastMutatingValue = value;
              }
            }
            // If this tuple's body produced a real mutation, the
            // binding space may have shifted. Re-project so the
            // remaining tuples reflect the post-mutation state.
            if (this.mutationCount !== mutBeforeTuple) {
              tuples = this.evalBindings(spec.where ?? []);
              i = 0;
            }
          }
        }
        // Zero real value changes this pass → fixpoint reached.
        if (this.mutationCount === mutationsBefore) return;
      }
      // If we hit the pass cap the binding space is likely
      // non-convergent (a class mounts something that re-triggers
      // its own tuples). Surface as an error with the offending
      // mount so the rule can be debugged — "class X kept writing
      // path Y = Z" is a concrete lead.
      throw new Error(
        `runIndexConstraints: ${maxPasses} passes without fixpoint — ` +
        `likely feedback loop. Last mutation: class "${lastMutatingClass}" ` +
        `mounted ${lastMutatingPath} = ${JSON.stringify(lastMutatingValue)}`,
      );
    } finally {
      this.instantiatingIndex = false;
    }
  }

  /**
   * Substitute `$var` references in a constraint tree with literal
   * wrappers. Distinct from `substituteVars` (used by `forall`):
   * forall substitutes strings for path-segment interpolation,
   * whereas admission checks need the substituted value to survive
   * as a typed literal (number/boolean/object — not stringified).
   *
   * Non-$var strings pass through unchanged (they remain paths).
   */
  private static substituteLiterals(c: Constraint, bindings: Record<string, unknown>): Constraint {
    const subst = (a: unknown): unknown => {
      if (typeof a === 'string') {
        // Whole-string $var: produce a literal wrapper so the value
        // survives resolution as its original type.
        if (a.startsWith('$') && !a.includes('.')) {
          const name = a.slice(1);
          if (name in bindings) return { literal: bindings[name] };
          return a;
        }
        // Whole-string `{var}` / `{var:key}` — treat the substituted
        // binding as a raw literal, not a path. Without this, a
        // path-valued binding like `subject` substituted into a
        // comparison RHS would be read back by `resolveValue` as
        // the value AT that path — so `neq(stored, substituted)`
        // would compare the stored path string to the dereferenced
        // state value and spuriously evaluate to true. Index-class
        // idempotency filters rely on this literal wrapping.
        const wholeBrace = a.match(/^\{(\w+)(?::(\w+))?\}$/);
        if (wholeBrace) {
          const name = wholeBrace[1];
          if (name in bindings) {
            const raw = String(bindings[name]);
            const val = wholeBrace[2] === 'key' ? raw.replace(/\./g, '_') : raw;
            return { literal: val };
          }
          return a;
        }
        // Segmented path with `.$var.` or `.{var}.` references:
        // substitute each matching segment with its bound value
        // stringified. Both syntaxes coexist: `$var` is the
        // historical form used by forall; `{var}` is the index-class
        // body interpolation form (unified so filter predicates
        // can use the same path shape as body mounts).
        if (a.includes('.$') || a.startsWith('$') || a.includes('{')) {
          return a.split('.').map(seg => {
            if (seg.startsWith('$')) {
              const name = seg.slice(1);
              return name in bindings ? String(bindings[name]) : seg;
            }
            const m = seg.match(/^\{(\w+)\}$/);
            if (m) {
              const name = m[1];
              return name in bindings ? String(bindings[name]) : seg;
            }
            return seg;
          }).join('.');
        }
        return a;
      }
      if (Array.isArray(a)) return a.map(subst);
      if (typeof a === 'object' && a !== null) {
        if ('op' in (a as any) && 'args' in (a as any) && Array.isArray((a as any).args)) {
          return Sequence.substituteLiterals(a as Constraint, bindings);
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(a as any)) out[k] = subst(v);
        return out;
      }
      return a;
    };
    return { op: c.op, args: c.args.map(subst) };
  }

  /**
   * Shared binary-op reducer. Both `resolveExpr` (constraint filters)
   * and `interpolateValue` (index-class body values) use this to keep
   * arithmetic vocabulary and edge-case handling in one place: any
   * non-numeric operand returns undefined, divide-by-zero returns
   * undefined (not NaN), and new ops land here once and apply
   * everywhere the `{op, lhs, rhs}` shape is accepted.
   */
  private static applyBinop(op: string, lhs: unknown, rhs: unknown): unknown {
    if (typeof lhs !== 'number' || typeof rhs !== 'number') return undefined;
    switch (op) {
      case '+': return lhs + rhs;
      case '-': return lhs - rhs;
      case '*': return lhs * rhs;
      case '/': return rhs !== 0 ? lhs / rhs : undefined;
    }
    return undefined;
  }

  private evalConstraint(c: Constraint): boolean {
    /** Resolve arithmetic/aggregate expressions recursively. */
    const resolveExpr = (arg: unknown): unknown => {
      if (typeof arg === 'number' || typeof arg === 'boolean' || arg === null) return arg;
      if (typeof arg === 'string') {
        if (arg.includes('.*')) return this.resolveGlob(arg);
        return this.get(arg);
      }
      if (typeof arg === 'object' && arg !== null) {
        if ('fn' in (arg as any)) return this.resolveAggregate((arg as any).fn, (arg as any).args);
        if ('ref' in (arg as any)) return this.get((arg as any).ref);
        // Literal wrapper: bypass path resolution and return the
        // raw value. Produced by substituteLiterals when replacing
        // a $var in an admission check — preserves the value's
        // original type (number stays number, bool stays bool) and
        // prevents evalConstraint from re-interpreting it as a path.
        if ('literal' in (arg as any)) return (arg as any).literal;
        // history query: { op: 'history', args: [op, method, filter] }
        if ((arg as any).op === 'history' && Array.isArray((arg as any).args)) {
          const [hop, method, filter] = (arg as any).args as [string, string, Record<string, unknown> | undefined];
          return this.resolveHistory(hop, method, filter);
        }
        // Arithmetic: { op: '+' | '-' | '*' | '/', lhs, rhs }
        if ('op' in (arg as any) && 'lhs' in (arg as any)) {
          const lhs = resolveExpr((arg as any).lhs);
          const rhs = resolveExpr((arg as any).rhs);
          return Sequence.applyBinop((arg as any).op, lhs, rhs);
        }
      }
      return arg;
    };
    /** Resolve the LHS of a comparison — always a path/expr, never a literal string. */
    const resolvePath = (arg: unknown): unknown => {
      if (typeof arg === 'string') return this.get(arg);
      return resolveExpr(arg);
    };
    /** Resolve the RHS of a comparison — try as path, fall back to literal string. */
    const resolveValue = (arg: unknown): unknown => {
      if (typeof arg === 'object' && arg !== null) return resolveExpr(arg);
      if (typeof arg === 'string') { const v = this.get(arg); return v !== undefined ? v : arg; }
      return arg;
    };
    switch (c.op) {
      // ── Original comparisons ──
      case 'eq': return Object.is(resolvePath(c.args[0]), resolveValue(c.args[1]));
      case 'neq': return !Object.is(resolvePath(c.args[0]), resolveValue(c.args[1]));
      case 'lt': { const a = resolvePath(c.args[0]), b = resolveValue(c.args[1]); return typeof a === 'number' && typeof b === 'number' && a < b; }
      case 'lte': { const a = resolvePath(c.args[0]), b = resolveValue(c.args[1]); return typeof a === 'number' && typeof b === 'number' && a <= b; }
      case 'gt': { const a = resolvePath(c.args[0]), b = resolveValue(c.args[1]); return typeof a === 'number' && typeof b === 'number' && a > b; }
      case 'gte': { const a = resolvePath(c.args[0]), b = resolveValue(c.args[1]); return typeof a === 'number' && typeof b === 'number' && a >= b; }
      case 'exists': {
        const arg = c.args[0];
        if (typeof arg === 'string' && arg.includes('.*')) return this.resolveGlob(arg).length > 0;
        // exists checks if a PATH has a value — use get() directly, not resolve()
        // (resolve falls back to the literal string which is always !== undefined)
        if (typeof arg === 'string') return this.get(arg) !== undefined;
        return resolvePath(arg) !== undefined;
      }
      case 'notExists': {
        const arg = c.args[0];
        if (typeof arg === 'string') return this.get(arg) === undefined;
        return resolvePath(arg) === undefined;
      }
      case 'count_lt': { const keys = this.keys(typeof c.args[0] === 'string' ? c.args[0] : undefined); return keys.length < (resolveValue(c.args[1]) as number); }
      case 'count_gte': { const keys = this.keys(typeof c.args[0] === 'string' ? c.args[0] : undefined); return keys.length >= (resolveValue(c.args[1]) as number); }

      // ── Composite predicates ──
      case 'or_clause': return (c.args as Constraint[]).some(sub => this.evalConstraint(sub));
      case 'and_clause': return (c.args as Constraint[]).every(sub => this.evalConstraint(sub));
      case 'not_clause': return !this.evalConstraint(c.args[0] as Constraint);

      // ── Quantified predicates ──
      //
      // forall($var, setPath, body):
      //   Iterate the elements of setPath, bind $var per-element,
      //   evaluate body (a Constraint) with `$var` references in its
      //   path args substituted with the bound value. Returns true
      //   iff every iteration's body evaluates to true.
      //
      // setPath semantics:
      //   - glob (`foo.*`) → iterate child KEYS of `foo`
      //   - array value    → iterate elements
      //   - scalar/object  → iterate once with the whole value
      //
      // Substitution is lexical: the body is a Constraint whose
      // string args may reference `$var` or `$var.field`. We walk
      // the tree, substitute literally, then recurse through
      // evalConstraint on the substituted form.
      case 'forall': {
        const [varName, setPath, body] = c.args as [string, string, Constraint];
        if (!body || !varName || !setPath) return true;
        let elements: unknown[];
        if (typeof setPath === 'string' && setPath.endsWith('.*')) {
          elements = this.keys(setPath.slice(0, -2));
        } else if (typeof setPath === 'string') {
          const v = this.get(setPath);
          if (Array.isArray(v)) elements = v;
          else if (v === undefined) elements = [];
          else elements = [v];
        } else {
          return true;
        }
        for (const el of elements) {
          const substituted = Sequence.substituteVars(body, { [varName]: el });
          if (!this.evalConstraint(substituted)) return false;
        }
        return true;
      }

      // ── Concreteness-distribution predicates (Commit 3) ──
      //
      // cdf_gte(path, t, p): P(path realized-and-interpretable by time t) >= p
      //   Queries concretenessDistribution(path).cdf(t) and compares.
      //   Use in where/while gates to express "this path must achieve
      //   probability p of concreteness by time t."
      //
      // concrete_at(path, t): shorthand for cdf_gte(path, t, 0.5) — the
      //   path is "more likely than not" concrete by t. Useful for
      //   loose temporal commitments where you want momentum but not
      //   strict confidence.
      case 'cdf_gte': {
        const path = c.args[0];
        if (typeof path !== 'string') return false;
        const t = resolveValue(c.args[1]);
        const p = resolveValue(c.args[2]);
        if (typeof t !== 'number' || typeof p !== 'number') return false;
        const dist = this.concretenessDistribution(path);
        return dist.cdf(t) >= p;
      }
      case 'concrete_at': {
        const path = c.args[0];
        if (typeof path !== 'string') return false;
        const t = resolveValue(c.args[1]);
        if (typeof t !== 'number') return false;
        const dist = this.concretenessDistribution(path);
        return dist.cdf(t) >= 0.5;
      }

      // ── Value predicates ──
      case 'regex': {
        const v = resolvePath(c.args[0]);
        return typeof v === 'string' && new RegExp(c.args[1] as string).test(v);
      }
      case 'between': {
        const v = resolvePath(c.args[0]);
        const lo = resolveValue(c.args[1]);
        const hi = resolveValue(c.args[2]);
        if (typeof v === 'number' && typeof lo === 'number' && typeof hi === 'number') return v >= lo && v <= hi;
        if (typeof v === 'string' && typeof lo === 'string' && typeof hi === 'string') return v >= lo && v <= hi;
        return false;
      }
      case 'one_of': {
        const v = resolvePath(c.args[0]);
        const values = c.args[1] as unknown[];
        return values.some(val => Object.is(v, val));
      }
      case 'contains': {
        const v = resolvePath(c.args[0]);
        const target = resolveValue(c.args[1]);
        if (typeof v === 'string' && typeof target === 'string') return v.includes(target);
        if (Array.isArray(v)) return v.some(el => Object.is(el, target));
        return false;
      }
      case 'satisfies': {
        const v = resolvePath(c.args[0]);
        if (v === undefined) return false;
        return check(c.args[1] as Type, v, typeof c.args[0] === 'string' ? c.args[0] as string : '').ok;
      }

      default: return false;
    }
  }

  private applyDefaults(path: string, value: unknown): { value: unknown; defaultedKeys: string[] } {
    const schema = this._typeOf(path);
    if (!schema || schema.kind !== 'object' || typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { value, defaultedKeys: [] };
    }
    const obj = value as Record<string, unknown>;
    const defaults: Record<string, unknown> = {};
    const defaultedKeys: string[] = [];
    for (const c of schema.constraints) {
      if (c.op !== 'property') continue;
      const [key, propType] = c.args as [string, Type, boolean];
      if (key in obj) continue;
      if (propType) {
        for (const pc of propType.constraints) {
          if (pc.op === 'default') { defaults[key] = pc.args[0]; defaultedKeys.push(key); break; }
          if (pc.op === 'literal' && c.args[2] === true) { defaults[key] = pc.args[0]; defaultedKeys.push(key); break; }
        }
      }
    }
    return {
      value: defaultedKeys.length > 0 ? { ...obj, ...defaults } : value,
      defaultedKeys,
    };
  }

  private applyTransition(path: string, value: unknown): unknown {
    const policy = this.policyAt(path);
    if (!policy?.transition || policy.transition === 'replace') return value;
    const prev = this._leafValueAt(path);
    if (prev === undefined || typeof value !== 'number' || typeof prev !== 'number') return value;
    return policy.transition === 'add' ? prev + value : prev * value;
  }

  private policyAt(path: string): { transition?: string; interpolate?: string; compact?: 'preserve' | 'default' | number } | undefined {
    const exact = this.proj.policies.get(path);
    if (exact) return exact;
    const parts = path.split('.');
    for (let i = parts.length - 1; i >= 1; i--) {
      const p = this.proj.policies.get(parts.slice(0, i).join('.'));
      if (p) return p;
    }
    return undefined;
  }

  capabilityAt(path: string): Function | undefined {
    const exact = this.implRegistry.get(path);
    if (exact) return exact;
    const parts = path.split('.');
    for (let i = parts.length - 1; i >= 1; i--) {
      const c = this.implRegistry.get(parts.slice(0, i).join('.'));
      if (c) return c;
    }
    return undefined;
  }

  /**
   * Resolve an impl for a path that may be a session-install ref
   * alias into a shared cap. Walks ancestor paths looking for
   * either (a) a direct impl in the implRegistry, or (b) a schema
   * with a `ref` constraint — in which case it rewrites the lookup
   * as `{refTarget}.{suffix}` and recurses. This is what makes
   * `sessions.alice.tools.openai.chat` invoke the cap that was
   * actually registered at `openai.chat`: the session's path is an
   * alias, the impl lookup follows the ancestor ref, finds the
   * cap's registered function, and returns it.
   *
   * Cycle-safe via the visited set.
   *
   * Critically, the CALLER (applyEntry's fn invocation branch)
   * still records `.input`/`.result` at the ORIGINAL entry path —
   * so side-effects land in the session's namespace, not the
   * cap's. That's what keeps per-session usage counters, law
   * frames, and contract priors isolated across installs.
   */
  private resolveImpl(path: string, visited?: Set<string>): Function | undefined {
    visited ??= new Set();
    if (visited.has(path)) return undefined;
    visited.add(path);
    // 1. Exact path — the caller is asking for this specific path's
    //    impl, so only exact matches count. (We do NOT walk
    //    ancestors for direct impls the way `capabilityAt` does,
    //    because that would make `.result` and `.input` sub-paths
    //    resolve to the parent fn's impl and trigger a recursive
    //    re-invocation on every fn's output. Exact-path-only
    //    matches the pre-install-via-ref invocation semantics.)
    const exact = this.implRegistry.get(path);
    if (exact) return exact;
    // 2. Check if the CURRENT path has a ref schema that should
    //    be walked. This handles `tools.primary = openai.chat`
    //    where `tools.primary` itself carries `ref('openai.chat')`
    //    and the impl lives at the target, not the alias.
    const selfSchema = this._typeOf(path);
    if (selfSchema) {
      const selfRef = selfSchema.constraints.find(c => c.op === 'ref');
      if (selfRef) {
        const target = selfRef.args[0] as string;
        return this.resolveImpl(target, visited);
      }
    }
    // 3. Walk ancestors looking ONLY for ref schemas. When an
    //    ancestor is a ref alias (e.g. sessions.alice.tools.openai
    //    → openai), rewrite the lookup as `{refTarget}.{suffix}`
    //    and recurse. The recursion then does exact-path lookup
    //    at the resolved target, finding the cap's impl there.
    const parts = path.split('.');
    for (let i = parts.length - 1; i > 0; i--) {
      const ancestor = parts.slice(0, i).join('.');
      const schema = this._typeOf(ancestor);
      if (!schema) continue;
      const rc = schema.constraints.find(c => c.op === 'ref');
      if (!rc) continue;
      const target = rc.args[0] as string;
      const suffix = parts.slice(i).join('.');
      return this.resolveImpl(`${target}.${suffix}`, visited);
    }
    // 4. Compose-lineage fallback. When steps 1-3 find nothing, the
    //    path has a fn-typed schema but no impl and no explicit
    //    ref ancestor. Per substrate invariants (types=values,
    //    compose=meet, narrowing IS inheritance), if the target's
    //    fn type is a narrowing of some registered impl's fn type
    //    (the registered param covers the target param), that
    //    impl is dispatch-compatible and we use it.
    //
    //    Ambiguity guard: if multiple registered impls cover the
    //    target, fall back to typeSpecificity — pick the single
    //    most-specific covering impl. If two impls tie on
    //    specificity (unrelated but structurally compatible), the
    //    kernel cannot disambiguate; return undefined and let the
    //    caller surface the miss (install-via-ref is the explicit
    //    remedy).
    if (selfSchema && selfSchema.kind === 'fn') {
      const targetParam = selfSchema.constraints.find(c => c.op === 'param')?.args[0] as Type | undefined;
      if (!targetParam) return undefined;
      const candidates: { path: string; impl: Function; specificity: number }[] = [];
      for (const [regPath, regImpl] of this.implRegistry) {
        if (regPath === path) continue;
        const regSchema = this._typeOf(regPath);
        if (!regSchema || regSchema.kind !== 'fn') continue;
        const regParam = regSchema.constraints.find(c => c.op === 'param')?.args[0] as Type | undefined;
        if (!regParam) continue;
        // Registered param must cover target param — meaning target
        // is equal to or narrower than the registered impl's input.
        // That's the narrowing-is-inheritance dispatch relationship.
        if (!covers(targetParam, regParam)) continue;
        // Specificity on the param type (not the full fn schema):
        // fn schemas all have the same 2-constraint structural
        // count (param + returns), which would leave every
        // candidate tied. The discriminating information is in
        // the param's own constraints.
        candidates.push({ path: regPath, impl: regImpl, specificity: typeSpecificity(regParam) });
      }
      if (candidates.length === 0) return undefined;
      if (candidates.length === 1) return candidates[0].impl;
      // Pick the most specific covering candidate. A unique max wins;
      // tied max → ambiguous, return undefined.
      candidates.sort((a, b) => b.specificity - a.specificity);
      if (candidates[0].specificity > candidates[1].specificity) return candidates[0].impl;
      return undefined;
    }
    return undefined;
  }

  private pathDeadline(path: string): number {
    let dl = this.lockExpiry;
    for (const entry of this.backwardEntries.values()) {
      if (entry.kind !== 'invariant') continue;
      const b = this.blockBySeq.get(entry.blockSeq);
      if (!b?.while || !b.entries.some(e => e.path === path || path.startsWith(e.path + '.'))) continue;
      for (const c of b.while) {
        if (c.args[0] === '_rt' && typeof c.args[1] === 'number' && (c.op === 'lt' || c.op === 'lte') && (c.args[1] as number) < dl) dl = c.args[1] as number;
      }
    }
    return dl;
  }

  private getCapabilities(): CapInfo[] {
    const r: CapInfo[] = [];
    for (const [path, schema] of this._iterateTypes()) {
      if (schema.kind !== 'fn' || !this.proj.capabilities.has(path)) continue;
      const p = constraintOf(schema, 'param');
      const ret = constraintOf(schema, 'returns');
      r.push({
        id: path, fnType: schema,
        inputType: p ? p.args[0] as Type : { kind: 'any', constraints: [] },
        outputType: ret ? ret.args[0] as Type : { kind: 'any', constraints: [] },
      });
    }
    return r;
  }

  private isInputAvailable(inputType: Type): boolean {
    if (isAny(inputType)) return true;
    if (isNever(inputType)) return false;
    if (inputType.kind !== 'object') return false;
    for (const p of properties(inputType)) {
      if (p.optional) continue;
      const v = this.get(p.key);
      if (v === undefined || !check(p.type, v, p.key).ok) return false;
    }
    return true;
  }

  private readCapProp(cap: CapInfo, name: string): number | undefined {
    const dist = constraintsOf(cap.fnType, 'distribution').find(c => c.args[0] === name);
    if (dist) {
      const [, family, params] = dist.args as [string, string, Record<string, number>];
      const stored = this.get(`${cap.id}._prior.${name}`) as Record<string, number> | undefined;
      return posteriorPredictive(family, stored ?? params);
    }
    const pr = constraintsOf(cap.fnType, 'prior').find(c => c.args[0] === name);
    if (pr) {
      const [, family, initial] = pr.args as [string, string, Record<string, number>];
      const stored = this.get(`${cap.id}._prior.${name}`) as Record<string, number> | undefined;
      return posteriorPredictive(family, stored ?? initial);
    }
    const c = constraintsOf(cap.fnType, 'computable').find(c => c.args[0] === name);
    if (!c) return undefined;
    const bindings = new Map<string, number>();
    const paramC = constraintOf(cap.fnType, 'param');
    if (paramC && (paramC.args[0] as Type).kind === 'object') {
      for (const p of properties(paramC.args[0] as Type)) {
        const v = this.get(p.key);
        if (typeof v === 'number') bindings.set(p.key, v);
      }
    }
    const result = evaluateExpr(c.args[1] as any, bindings);
    return result ? Math.min(1, Math.max(0, result.value)) : undefined;
  }

  private timeFactor(cap: CapInfo, remainingMs: number): number {
    if (!isFinite(remainingMs) || remainingMs === Infinity) return 1;
    if (remainingMs <= 0) return 0;
    const dist = constraintsOf(cap.fnType, 'distribution').find(c => c.args[0] === 'time');
    if (dist) return cdf(dist.args[1] as string, remainingMs, dist.args[2] as Record<string, number>);
    const tc = constraintsOf(cap.fnType, 'temporal');
    if (tc.length > 0) {
      const [dir, , bound] = tc[0].args as [string, string, unknown];
      if (dir === 'gt') {
        const bindings = new Map<string, number>([['_rt', this.clock()], ['_rt.input', this.clock()]]);
        const r = evaluateExpr(bound as any, bindings);
        if (r) { const t = (r.hi ?? r.value) - this.clock(); return t >= remainingMs ? 0 : 1 - (t / remainingMs); }
      }
    }
    const c = constraintsOf(cap.fnType, 'computable').find(c => c.args[0] === 'time');
    if (!c) return 1;
    const bindings = new Map<string, number>();
    const r = evaluateExpr(c.args[1] as any, bindings);
    if (!r) return 1;
    const est = r.hi ?? r.value;
    return est >= remainingMs ? 0 : 1 - (est / remainingMs);
  }

  private inputFeasibility(cap: CapInfo, gapType: Type, visited: Set<string>): number {
    const hasP = constraintsOf(cap.fnType, 'preserves').length > 0;
    if (hasP) return this.typeFeasibility(backwardInfer(cap.fnType, gapType), visited);
    const prefix = cap.id + '.';
    let hasSub = false;
    let product = 1;
    for (const [p, s] of this._iterateTypes()) {
      if (!p.startsWith(prefix)) continue;
      hasSub = true;
      const v = this.get(p);
      if (v === undefined || !check(s, v, p).ok) product *= this.feasibility(p, visited);
    }
    if (hasSub) return product;
    return this.typeFeasibility(backwardInfer(cap.fnType, gapType), visited);
  }

  private typeFeasibility(type: Type, visited: Set<string>): number {
    if (isAny(type)) return 1;
    if (isNever(type)) return 0;
    if (type.kind === 'object') {
      const props = properties(type);
      if (props.length === 0) return 1;
      let product = 1;
      for (const p of props) { if (!p.optional) product *= this.feasibility(p.key, visited); }
      return product;
    }
    return this.isInputAvailable(type) ? 1 : typeSpecificity(type);
  }
}
