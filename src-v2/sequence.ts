/**
 * sequence.ts (v2) — the kernel.
 *
 * ONE OPERATION: insert(coord, value?|type?|rules?).
 *
 * ONE ALGORITHM: traverse to the target cell collecting lexical rules;
 * check admission rules (scope + guard); check where-clauses; compose the
 * incoming fact with existing state → delta; apply; then propagate the
 * delta (a) along lattice axes to structural neighbors (ref cascade,
 * temporal resume) and (b) through observation rules in scope whose
 * guards match the delta. Recurse to fixpoint with a cycle-guard.
 *
 * THREE LATTICE AXES: structural, temporal, ref. These are directions
 * of the lattice, not features. Features express themselves as RULES
 * mounted at scope, evaluated by the one generic dispatcher, emitting
 * follow-up blocks through runtime-registered emitter functions.
 *
 * NO HARDCODED FEATURE CODE IN THIS FILE. No '_commitments', no
 * '_holders', no 'posteriorAdmit', no 'indexSpec', no 'invocation record
 * fields'. Anything feature-shaped lives in stdlib.ts and installs
 * itself by registering emitters + mounting rules. If the kernel grows
 * to include feature-specific paths, constraint ops, or dimensions —
 * that's the v1 drift and should be rejected.
 *
 * Uses Type/Constraint vocabulary from ../src/type + compose rules from
 * ../src/compose. Rewrites only the engine around them.
 */

import { type Type, type Constraint, isNever } from '../src/type';
import { compose as composeTypes, check, typeSpecificity } from '../src/compose';

// ═══════════════════════════════════════════════════════════════════════
// CORE DATA
// ═══════════════════════════════════════════════════════════════════════

/** Axes of the lattice. FIXED SET — extending this is an ontology
 *  decision, not a feature addition. */
export type Axis = 'structural' | 'temporal' | 'ref';

export type Coordinate = { path: string; identity?: string };

export type Block = {
  seq: number;
  coord: Coordinate;
  op: 'narrow' | 'invalidate';
  value?: unknown;
  type?: Type;
  rules?: Rule[];
  where?: Constraint[];
  time: number;
  author?: string;
  status: 'applied' | 'suspended' | 'invalidated';
  /** Why this block was created: propagation origin + axis or rule id. */
  cause?: { from: string; axis?: Axis; ruleId?: string };
};

export type Cell = {
  path: string;
  value?: unknown;
  type?: Type;
  blocks: Block[];
  /** Rules declared at this cell's scope. Collected during traversal. */
  rules: Rule[];
  /** Incidence collections per lattice axis (directed). */
  in: Partial<Record<Axis, Set<string>>>;
  out: Partial<Record<Axis, Set<string>>>;
  /** Structural children (implicit structural-axis edges). */
  children: Map<string, Cell>;
};

export type Delta = {
  path: string;
  kind: 'none' | 'value' | 'type' | 'invocation' | 'retraction' | 'access';
  prev?: unknown;
  next?: unknown;
  /** For kind='access' only: hit means cell.value was present at read
   *  time; miss means the cell was absent OR type-only. The consumer's
   *  context class (if any) classifies the read for posterior keying. */
  accessKind?: 'hit' | 'miss';
  contextClass?: string;
};

/** A declarative rule. All feature logic lives in rules + their
 *  registered emitters. Rules are data (serializable); emitters are
 *  runtime functions (not persisted, re-registered on boot). */
export type Rule = {
  id: string;
  /** admission: pre-compose gate on insert.
   *  observation: post-compose, fires during propagate on write deltas.
   *  access: fires on get() — a read event, not a write. */
  phase: 'admission' | 'observation' | 'access';
  /** Path prefix this rule applies to (empty = global). */
  scope: string;
  /** Optional guard constraint evaluated against cell + delta + block. */
  when?: Constraint;
  /** Optional glob-prefix patterns; any cell change under a watched
   *  prefix triggers the rule even if the cell is outside `scope`. */
  watching?: string[];
  /** Required for observation and access rules — id of an emitter
   *  registered on `seq.emitters`. */
  emit?: string;
};

export type EmitterCtx = {
  cell: Cell;
  delta: Delta;
  block: Block;
  rule: Rule;
  seq: Sequence;
  /** Extra bindings extracted during matching (for future use — pattern
   *  variables from scope templates, etc.). */
  bindings: Record<string, unknown>;
};

export type Emitter = (ctx: EmitterCtx) => BlockTemplate[];

export type BlockTemplate = {
  path: string;
  value?: unknown;
  type?: Type;
  rules?: Rule[];
  /** Where-clause gate; if present, the emitted block is admitted only
   *  when every constraint evaluates true. On failure the block suspends
   *  and wires temporal-axis watches on referenced paths, so a later
   *  mount that satisfies the gate will resume it. This is how
   *  emitters express "fire X when condition Y becomes true." */
  where?: Constraint[];
  author?: string;
  /** Emit op. Default 'narrow'. Set to 'invalidate' when the template
   *  should clear the cell (delete-shaped semantics for index_spec
   *  bodies, HolderRelease, etc.). */
  op?: 'narrow' | 'invalidate';
};

export type GuardOp = (
  c: Constraint,
  seq: Sequence,
  ctx: { cell: Cell; delta?: Delta; block?: Block },
) => boolean;

export type Frame = {
  cell: Cell;
  rulesInScope: readonly Rule[];
  depth: number;
  seen: Set<string>;
};

export type InsertInput = {
  path: string;
  value?: unknown;
  type?: Type;
  rules?: Rule[];
  where?: Constraint[];
  author?: string;
  identity?: string;
};

export type InsertResult = { block: Block; changes: Delta[]; suspended: boolean };

// ═══════════════════════════════════════════════════════════════════════
// SEQUENCE
// ═══════════════════════════════════════════════════════════════════════

export class Sequence {
  private root: Cell = makeCell('');
  private clock: () => number;
  private nextSeq = 0;

  /** Watcher index: glob prefix → rule ids. Populated by installRule for
   *  rules that declare `watching`. Lookup fires rules on any change under
   *  a watched prefix. */
  private watchers = new Map<string, Set<string>>();
  /** All installed rules by id — for watcher dispatch lookup. */
  private rulesById = new Map<string, Rule>();
  /** Re-entrancy guard for access dispatch. Prevents recursive access
   *  events when an access-rule emitter reads cells while running. */
  private accessInFlight = false;
  /** Per-path guard for auto-expand on get(). Prevents cycles (Y derives
   *  from X derives from Y) while still allowing chained expansion
   *  through distinct paths. */
  private expandInProgress = new Set<string>();

  /** Runtime-only registries (not serializable; re-registered on boot). */
  readonly impls = new Map<string, Function>();
  readonly emitters = new Map<string, Emitter>();
  readonly guards = new Map<string, GuardOp>();

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
    installBuiltinGuards(this);
  }

  // ─── public writes ────────────────────────────────────────────────

  insert(input: InsertInput): InsertResult {
    const block: Block = {
      seq: this.nextSeq++,
      coord: { path: input.path, identity: input.identity },
      op: 'narrow',
      value: input.value,
      type: input.type,
      rules: input.rules,
      where: input.where,
      time: this.clock(),
      author: input.author,
      status: 'applied',
    };
    const changes: Delta[] = [];
    const suspended = !this.step(block, null, changes);
    return { block, changes, suspended };
  }

  // ─── public reads ─────────────────────────────────────────────────

  /**
   * Read a cell's value. Fires an access event (Wire 2) and auto-expands
   * on gap (Wire 1) — see below.
   *
   * ACCESS EVENT: dispatched to `phase:'access'` rules in scope + glob-
   * watchers. Carries `accessKind:'hit'` when a value was present at
   * read time, else `'miss'`. `contextClass` (if supplied) is threaded
   * through for conditional-posterior keying. Re-entrant calls during
   * dispatch (e.g. an emitter reading state while computing a posterior
   * update) do NOT fire further access events — guarded by
   * `accessInFlight` to prevent loops.
   *
   * AUTO-EXPAND ON GAP: if the cell has a type but no value AND the
   * type declares a local producer — currently a `derived(fnId, ...src)`
   * constraint — computeDerived is invoked and its output mounted in a
   * fresh step. `get()` then returns the now-materialized value.
   *
   * Per-path `expandInProgress` guards against cycles (Y→X→Y). Cells
   * whose type declares NO local producer — "claim slots" that an
   * external actor is responsible for filling — remain undefined. The
   * access-miss event still fires, so a reader/UI/peer can route
   * solicitation through normal observation rules.
   */
  get(path: string, contextClass?: string): unknown {
    const cell = this.findCell(path);
    const hit = cell?.value !== undefined;
    if (!this.accessInFlight) this.fireAccess(path, cell, hit, contextClass);
    if (!hit && cell?.type && !this.expandInProgress.has(path)) {
      this.expandInProgress.add(path);
      try { this.tryAutoExpand(cell); }
      finally { this.expandInProgress.delete(path); }
    }
    return cell?.value;
  }
  typeAt(path: string): Type | undefined { return this.findCell(path)?.type; }
  cells(): Cell[] { const out: Cell[] = []; walk(this.root, c => out.push(c)); return out; }

  // ─── exposed for emitters ─────────────────────────────────────────

  getCell(path: string): Cell | undefined { return this.findCell(path); }
  childSegments(prefix: string): string[] {
    const c = prefix ? this.findCell(prefix) : this.root;
    return c ? [...c.children.keys()] : [];
  }
  /** Readable conformance (the shared hoist/hoistCatalog in ../src/hoist —
   *  ONE hoister serves both engines). Same data as childSegments, named
   *  for the shared interface. */
  keys(prefix?: string): string[] { return this.childSegments(prefix ?? ''); }
  /** Readable conformance: the literal type at path. v2 typeAt is already
   *  raw (no ancestor-ref walk, unlike v1) — an alias, documented as such. */
  rawTypeAt(path: string): Type | undefined { return this.typeAt(path); }
  now(): number { return this.clock(); }
  nextSequence(): number { return this.nextSeq++; }

  // ─── the algorithm ────────────────────────────────────────────────

  private step(block: Block, parent: Frame | null, changes: Delta[]): boolean {
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > 128) return false;

    const frame = this.traverse(block.coord.path, parent, depth);

    // 1. Admission rules in scope.
    for (const r of frame.rulesInScope) {
      if (r.phase !== 'admission') continue;
      if (!scopeMatches(r, frame.cell.path)) continue;
      if (!this.runGuard(r.when, { cell: frame.cell, block })) {
        block.status = 'suspended';
        frame.cell.blocks.push(block);
        this.wireTemporalWatches(r.when, frame.cell);
        return false;
      }
    }

    // 2. Block-local where-clauses.
    if (block.where?.length) {
      for (const w of block.where) {
        if (!this.runGuard(w, { cell: frame.cell, block })) {
          block.status = 'suspended';
          frame.cell.blocks.push(block);
          this.wireTemporalWatches(w, frame.cell);
          return false;
        }
      }
    }

    // 3. Compose at cell → delta.
    const delta = this.composeAtCell(frame.cell, block);

    if (delta.kind === 'none') {
      frame.cell.blocks.push(block);
      if (block.rules) for (const r of block.rules) this.installRule(r);
      return block.status !== 'suspended';
    }

    // 4. Apply.
    this.applyDelta(frame.cell, block, delta);
    changes.push(delta);
    if (block.rules) for (const r of block.rules) this.installRule(r);
    this.registerRefEdges(frame.cell, block);

    // 5. Propagate along axes + observation rules.
    frame.seen.add(frame.cell.path);
    this.propagate(frame, delta, block, changes);

    return true;
  }

  private traverse(path: string, parent: Frame | null, depth: number): Frame {
    const segs = path ? path.split('.') : [];
    let cell = this.root;
    const rulesInScope: Rule[] = [...this.root.rules];
    for (const seg of segs) {
      let child = cell.children.get(seg);
      if (!child) {
        child = makeCell(cell.path ? `${cell.path}.${seg}` : seg);
        cell.children.set(seg, child);
      }
      cell = child;
      if (cell.rules.length) rulesInScope.push(...cell.rules);
    }
    return { cell, rulesInScope, depth, seen: new Set(parent?.seen ?? []) };
  }

  /**
   * Compose-at-cell. The type-system-level merge rule. Only type-kind
   * knowledge the kernel acts on: `kind === 'fn'` with a non-fn value
   * produces an invocation delta (so stdlib rules can elect commitments,
   * run impls, etc.). All other value writes typecheck against the
   * cell's declared type (if any) and overwrite-or-reject.
   */
  private composeAtCell(cell: Cell, block: Block): Delta {
    if (block.op === 'invalidate') {
      if (cell.value === undefined && cell.type === undefined) return none(cell.path);
      return { path: cell.path, kind: 'retraction', prev: cell.value, next: undefined };
    }
    if (block.type !== undefined) {
      const prev = cell.type;
      const next = prev ? composeTypes(prev, block.type) : block.type;
      if (isNever(next)) { block.status = 'suspended'; return none(cell.path); }
      if (prev && sameType(prev, next)) return none(cell.path);
      return { path: cell.path, kind: 'type', prev, next };
    }
    if (block.value !== undefined) {
      if (cell.type?.kind === 'fn' && typeof block.value !== 'function') {
        return { path: cell.path, kind: 'invocation', next: block.value };
      }
      if (cell.type) {
        const r = check(cell.type, block.value, cell.path);
        if (!r.ok) { block.status = 'suspended'; return none(cell.path); }
      }
      if (Object.is(cell.value, block.value)) return none(cell.path);
      return { path: cell.path, kind: 'value', prev: cell.value, next: block.value };
    }
    return none(cell.path);
  }

  private applyDelta(cell: Cell, block: Block, delta: Delta): void {
    cell.blocks.push(block);
    if (delta.kind === 'value') cell.value = delta.next;
    if (delta.kind === 'type') cell.type = delta.next as Type;
    if (delta.kind === 'retraction') cell.value = undefined;
    // invocation: cell state unchanged; stdlib rules mount sub-cells.
  }

  private registerRefEdges(cell: Cell, block: Block): void {
    if (!block.type) return;
    for (const c of block.type.constraints) {
      if (c.op !== 'derived') continue;
      const [, ...srcs] = c.args as string[];
      for (const sp of srcs) this.edge(this.ensureCell(sp), cell, 'ref');
    }
  }

  /**
   * Propagation phase: axis-based (ref cascade, temporal resume) plus
   * rule-based (observation rules in scope + glob-watchers). This is the
   * only dispatch step in the kernel. It has no feature-specific code.
   */
  private propagate(frame: Frame, delta: Delta, block: Block, changes: Delta[]): void {
    // (a) Ref axis cascade: derived cells recompute.
    const refOut = frame.cell.out.ref;
    if (refOut) for (const t of refOut) {
      if (frame.seen.has(t)) continue;
      const derived = this.computeDerived(t);
      if (derived) this.step(derived, frame, changes);
    }

    // (b) Temporal axis: suspended blocks on cells that watch this one.
    //
    // CRITICAL: snapshot blocks BEFORE iterating. A failed retry appends
    // a new suspended block to watcher.blocks; iterating the live array
    // would re-retry its own retries forever. We retry each originally-
    // suspended block exactly once per propagation step; if the retry
    // itself suspends, it stays in the log for the NEXT trigger to pick
    // up (not this one).
    const temOut = frame.cell.out.temporal;
    if (temOut) for (const wp of temOut) {
      if (frame.seen.has(wp)) continue;
      const watcher = this.findCell(wp);
      if (!watcher) continue;
      const snapshot = watcher.blocks.slice();
      for (const b of snapshot) {
        if (b.status !== 'suspended') continue;
        const retry: Block = {
          ...b,
          seq: this.nextSeq++,
          status: 'applied',
          cause: { from: frame.cell.path, axis: 'temporal' },
        };
        this.step(retry, frame, changes);
      }
    }

    // (c) Observation rules in lexical scope.
    for (const r of frame.rulesInScope) {
      if (r.phase !== 'observation') continue;
      if (!scopeMatches(r, frame.cell.path)) continue;
      this.dispatchRule(r, frame, delta, block, changes);
    }

    // (d) Glob-watcher rules (rules whose `watching` includes any
    //     ancestor-prefix of this path). Deduped across passes.
    const parts = frame.cell.path.split('.');
    const seenRules = new Set<string>();
    for (let i = 0; i <= parts.length; i++) {
      const prefix = i === 0 ? '' : parts.slice(0, i).join('.');
      const ruleIds = this.watchers.get(prefix);
      if (!ruleIds) continue;
      for (const rid of ruleIds) {
        if (seenRules.has(rid)) continue;
        seenRules.add(rid);
        const r = this.rulesById.get(rid);
        if (!r || r.phase !== 'observation') continue;
        this.dispatchRule(r, frame, delta, block, changes);
      }
    }
  }

  private dispatchRule(
    r: Rule, frame: Frame, delta: Delta, block: Block, changes: Delta[],
  ): void {
    if (r.when && !this.runGuard(r.when, { cell: frame.cell, delta, block })) return;
    const emitter = this.emitters.get(r.emit ?? '');
    if (!emitter) return;
    const templates = emitter({
      cell: frame.cell, delta, block, rule: r, seq: this, bindings: {},
    });
    for (const t of templates) {
      if (frame.seen.has(t.path)) continue;
      const induced: Block = {
        seq: this.nextSeq++,
        coord: { path: t.path },
        op: t.op ?? 'narrow',
        value: t.value,
        type: t.type,
        rules: t.rules,
        where: t.where,
        time: this.clock(),
        author: t.author,
        status: 'applied',
        cause: { from: frame.cell.path, ruleId: r.id },
      };
      this.step(induced, frame, changes);
    }
  }

  /**
   * Fire an access event for a `get()` call. Dispatches `phase:'access'`
   * rules in lexical scope (collected by read-only traversal — never
   * creates cells) plus glob-watcher access rules. The synthesized Delta
   * has `kind:'access'` with `accessKind` in {`hit`,`miss`} and the
   * caller's `contextClass` threaded through for posterior keying.
   *
   * Emitters of access rules may insert new blocks (e.g. update a
   * per-cell access posterior at _holders.{path}.access.{alpha,beta}).
   * Those inserts flow through the normal cascade. Any `seq.get()`
   * inside that cascade is short-circuited from firing further access
   * events by the `accessInFlight` guard — this prevents recursive
   * dispatch loops without suppressing the inserts themselves.
   */
  private fireAccess(
    path: string,
    cell: Cell | undefined,
    hit: boolean,
    contextClass: string | undefined,
  ): void {
    this.accessInFlight = true;
    try {
      const { rulesInScope } = this.traverseReadOnly(path);
      const accessDelta: Delta = {
        path,
        kind: 'access',
        next: hit ? cell?.value : undefined,
        accessKind: hit ? 'hit' : 'miss',
        contextClass,
      };
      const block: Block = {
        seq: this.nextSeq++,
        coord: { path },
        op: 'narrow',
        time: this.clock(),
        status: 'applied',
      };
      const frame: Frame = {
        cell: cell ?? this.root,
        rulesInScope,
        depth: 0,
        seen: new Set(),
      };
      const changes: Delta[] = [];

      for (const r of rulesInScope) {
        if (r.phase !== 'access') continue;
        if (!scopeMatches(r, path)) continue;
        this.dispatchRule(r, frame, accessDelta, block, changes);
      }

      const parts = path ? path.split('.') : [];
      const seenRules = new Set<string>();
      for (let i = 0; i <= parts.length; i++) {
        const prefix = i === 0 ? '' : parts.slice(0, i).join('.');
        const ruleIds = this.watchers.get(prefix);
        if (!ruleIds) continue;
        for (const rid of ruleIds) {
          if (seenRules.has(rid)) continue;
          seenRules.add(rid);
          const r = this.rulesById.get(rid);
          if (!r || r.phase !== 'access') continue;
          this.dispatchRule(r, frame, accessDelta, block, changes);
        }
      }
    } finally {
      this.accessInFlight = false;
    }
  }

  /** Walk to a path collecting in-scope rules WITHOUT creating cells.
   *  Used by `fireAccess` so reads don't instantiate cells that aren't
   *  already mounted (preserves `get()`'s existing non-creation semantic). */
  private traverseReadOnly(path: string): { cell: Cell | undefined; rulesInScope: Rule[] } {
    const segs = path ? path.split('.') : [];
    let cell: Cell | undefined = this.root;
    const rulesInScope: Rule[] = [...this.root.rules];
    for (const seg of segs) {
      cell = cell?.children.get(seg);
      if (!cell) return { cell: undefined, rulesInScope };
      if (cell.rules.length) rulesInScope.push(...cell.rules);
    }
    return { cell, rulesInScope };
  }

  /**
   * Wire 1 — auto-expand a gap cell on read.
   *
   * Called from `get()` when a cell has a type but no value. Examines
   * the type for a LOCAL PRODUCER and runs it:
   *
   *   - `derived(fnId, ...srcPaths)` constraint → `computeDerived` + step.
   *
   * Future extensions (fn-kind tool cells, ref-chain-to-derivable,
   * peer-expand-via) can be added here without touching `get()`.
   *
   * Cells with a type but NO local producer — "claim slots" awaiting an
   * external actor — return without action. `get()` returns undefined.
   * The access-miss observation has already fired; that's the signal a
   * reader/UI/peer can route through normal rule dispatch.
   */
  private tryAutoExpand(cell: Cell): void {
    const t = cell.type;
    if (!t) return;
    // Derived constraint: a local producer that was declared on the type.
    const derived = t.constraints.find(c => c.op === 'derived');
    if (derived) {
      const block = this.computeDerived(cell.path);
      if (block) this.step(block, null, []);
      return;
    }
    // No local producer discoverable → claim slot. No expansion.
  }

  private computeDerived(targetPath: string): Block | null {
    const cell = this.findCell(targetPath);
    if (!cell?.type) return null;
    const d = cell.type.constraints.find(c => c.op === 'derived');
    if (!d) return null;
    const [fnId, ...argPaths] = d.args as string[];
    const fn = this.impls.get(fnId);
    if (typeof fn !== 'function') return null;
    const args = argPaths.map(p => this.get(p));
    if (args.some(a => a === undefined)) return null;
    let value: unknown;
    try { value = fn(...args); } catch { return null; }
    return {
      seq: this.nextSeq++, coord: { path: targetPath }, op: 'narrow',
      value, time: this.clock(), status: 'applied',
      cause: { from: targetPath, axis: 'ref' },
    };
  }

  /**
   * Install a rule at its declared scope cell. The storage location
   * matches the semantics: a rule with scope='' lives on the root cell;
   * a rule with scope='tool' lives on the 'tool' cell. Traversal to any
   * descendant of the scope collects the rule naturally.
   *
   * The block's own path is unrelated — callers conventionally insert
   * rules at `_rules.{id}` paths for audit/enumeration, but the
   * kernel ignores that.
   */
  private installRule(r: Rule): void {
    const scopeCell = r.scope ? this.ensureCell(r.scope) : this.root;
    scopeCell.rules.push(r);
    this.rulesById.set(r.id, r);
    for (const w of r.watching ?? []) {
      const prefix = w.replace(/\.\*$/, '');
      let s = this.watchers.get(prefix);
      if (!s) { s = new Set(); this.watchers.set(prefix, s); }
      s.add(r.id);
    }
  }

  private wireTemporalWatches(c: Constraint | undefined, target: Cell): void {
    if (!c) return;
    for (const p of collectPaths(c)) this.edge(this.ensureCell(p), target, 'temporal');
  }

  private edge(source: Cell, target: Cell, axis: Axis): void {
    let o = source.out[axis]; if (!o) { o = new Set(); source.out[axis] = o; }
    o.add(target.path);
    let i = target.in[axis]; if (!i) { i = new Set(); target.in[axis] = i; }
    i.add(source.path);
  }

  // ─── cell lookup ──────────────────────────────────────────────────

  private findCell(path: string): Cell | undefined {
    if (!path) return this.root;
    let c: Cell | undefined = this.root;
    for (const seg of path.split('.')) {
      c = c.children.get(seg);
      if (!c) return undefined;
    }
    return c;
  }

  private ensureCell(path: string): Cell {
    if (!path) return this.root;
    let cur = this.root;
    for (const seg of path.split('.')) {
      let child = cur.children.get(seg);
      if (!child) {
        child = makeCell(cur.path ? `${cur.path}.${seg}` : seg);
        cur.children.set(seg, child);
      }
      cur = child;
    }
    return cur;
  }

  // ─── guard (constraint) evaluation ────────────────────────────────

  /**
   * Evaluate a constraint. Registry-extensible via seq.guards (stdlib
   * registers posteriorAdmit / etc. without touching the kernel).
   * Unknown op → permissive. Callers that need stricter semantics can
   * register a 'default' handler or a `strict` flag.
   */
  private runGuard(
    c: Constraint | undefined,
    ctx: { cell: Cell; delta?: Delta; block?: Block },
  ): boolean {
    if (!c) return true;
    const op = this.guards.get(c.op);
    if (!op) return true;
    return op(c, this, ctx);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

function none(path: string): Delta { return { path, kind: 'none' }; }

function makeCell(path: string): Cell {
  return { path, blocks: [], rules: [], in: {}, out: {}, children: new Map() };
}

function walk(c: Cell, visit: (c: Cell) => void): void {
  visit(c);
  for (const ch of c.children.values()) walk(ch, visit);
}

function sameType(a: Type, b: Type): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (typeSpecificity(a) !== typeSpecificity(b)) return false;
  if (a.constraints.length !== b.constraints.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function scopeMatches(r: Rule, path: string): boolean {
  if (!r.scope) return true;
  return path === r.scope || path.startsWith(r.scope + '.');
}

function pathMatchesGlob(path: string, glob: string): boolean {
  const prefix = glob.replace(/\.\*$/, '');
  return path === prefix || path.startsWith(prefix + '.');
}

/** Path-like arg extraction from a constraint tree (used to wire
 *  temporal watches on suspension). Over-inclusion is harmless. */
function collectPaths(c: Constraint): string[] {
  const out: string[] = [];
  const visit = (x: unknown): void => {
    if (typeof x === 'string') {
      if (!x || /^-?\d/.test(x)) return;
      out.push(x);
    } else if (Array.isArray(x)) x.forEach(visit);
    else if (x && typeof x === 'object' && 'op' in (x as any) && 'args' in (x as any)) {
      for (const a of (x as Constraint).args) visit(a);
    }
  };
  if (c.args.length > 0) visit(c.args[0]);
  for (let i = 1; i < c.args.length; i++) {
    const a = c.args[i];
    if (typeof a === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(a)) out.push(a);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// BUILT-IN GUARD OPS — the minimal set kernel needs for block gating.
// Stdlib extends this via seq.guards.set('<op>', ...). The kernel itself
// knows nothing about any feature.
// ═══════════════════════════════════════════════════════════════════════

function installBuiltinGuards(seq: Sequence): void {
  const resolve = (arg: unknown): unknown => {
    if (typeof arg !== 'string') return arg;
    const val = seq.get(arg);
    return val !== undefined ? val : arg;
  };
  seq.guards.set('eq',        c => resolve(c.args[0]) === resolve(c.args[1]));
  seq.guards.set('neq',       c => resolve(c.args[0]) !== resolve(c.args[1]));
  seq.guards.set('gt',        c => (resolve(c.args[0]) as number) >  (resolve(c.args[1]) as number));
  seq.guards.set('lt',        c => (resolve(c.args[0]) as number) <  (resolve(c.args[1]) as number));
  seq.guards.set('gte',       c => (resolve(c.args[0]) as number) >= (resolve(c.args[1]) as number));
  seq.guards.set('lte',       c => (resolve(c.args[0]) as number) <= (resolve(c.args[1]) as number));
  seq.guards.set('exists',    c => seq.get(c.args[0] as string) !== undefined);
  seq.guards.set('notExists', c => seq.get(c.args[0] as string) === undefined);

  // Shape-match predicates for rules (delta / path introspection).
  seq.guards.set('deltaKindIs',    (c, _s, ctx) => ctx.delta?.kind === c.args[0]);
  seq.guards.set('cellTypeKindIs', (c, _s, ctx) => ctx.cell.type?.kind === c.args[0]);
  seq.guards.set('pathEq',         (c, _s, ctx) => ctx.cell.path === c.args[0]);
  seq.guards.set('pathMatches',    (c, _s, ctx) => pathMatchesGlob(ctx.cell.path, c.args[0] as string));

  // Logical combinators.
  seq.guards.set('and', (c, s, ctx) =>
    (c.args as Constraint[]).every(sub => (s.guards.get(sub.op)?.(sub, s, ctx)) ?? true));
  seq.guards.set('or',  (c, s, ctx) =>
    (c.args as Constraint[]).some(sub => (s.guards.get(sub.op)?.(sub, s, ctx)) ?? false));
  seq.guards.set('not', (c, s, ctx) => {
    const sub = c.args[0] as Constraint;
    return !((s.guards.get(sub.op)?.(sub, s, ctx)) ?? false);
  });
}
