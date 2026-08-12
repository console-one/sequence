import {
  type Type, derived,
} from '../../src/type';
import {
  type Sequence,
} from '../sequence';

// ═══════════════════════════════════════════════════════════════════════
// PARTITION MODEL (ported from v1 sequence.ts) — six semantic
// partitions: state / proc / id / req / chan / proj. Partition is a
// dimension of TYPE: `partition('id')` declared on a type's constraints
// puts its cell in the identity partition regardless of mount path.
// `partitionOf(path, type?)` prefers the type-declared partition over
// the path prefix (and `_*` paths are always 'state').
//
// `installPartitionDirection` mounts a global admission rule that
// rejects mounts whose type has a `ref(target)` constraint pointing
// to a partition not allowed from the cell's own partition. See
// PARTITION_MODEL.md for the directionality rules.
// ═══════════════════════════════════════════════════════════════════════

export type Partition = 'state' | 'proc' | 'id' | 'req' | 'chan' | 'proj';

const PARTITION_PREFIXES: Record<string, Partition> = {
  state: 'state', proc: 'proc', id: 'id',
  req: 'req',     chan: 'chan', proj: 'proj',
};

const ALL_PARTITIONS: ReadonlySet<Partition> = new Set<Partition>([
  'state', 'proc', 'id', 'req', 'chan', 'proj',
]);

/**
 * Allowed reference directions per partition.
 * `state may reference state, id` means a path in the state partition
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

/** Persistence rules per partition (declarative for stdlib consumers). */
export const PARTITION_PERSISTENCE: Record<Partition, 'required' | 'policy' | 'never'> = {
  state: 'required',
  id:    'required',
  req:   'required',
  proc:  'policy',
  chan:  'policy',
  proj:  'never',
};

/** Authority rules per partition. proj is read-only (writes are derived). */
export const PARTITION_AUTHORITY: Record<Partition, boolean> = {
  state: true, proc: true, id: true,
  req: true,   chan: true, proj: false,
};

/** Extract the partition declared on a type's constraints, if any. */
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
 * Derive the partition for a path. Type declaration wins over path
 * prefix; internal paths (`_*`) are always 'state'; otherwise the
 * leading segment determines the partition (unprefixed = 'state').
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
 * Install the partition reference-direction admission rule. For every
 * mount whose type carries a `ref(target)` constraint, the rule:
 *   1. computes from-partition = partitionOf(cell.path, block.type)
 *   2. computes to-partition = partitionOf(target, sequence's typeAt(target))
 *   3. rejects if to-partition not in ALLOWED_REFS[from-partition].
 *
 * Internal paths (`_*`) bypass — they are kernel infrastructure. Cascade-
 * emitted blocks (`block.cause.ruleId`) bypass — substrate transitions
 * are not user claims.
 */
export function installPartitionDirection(seq: Sequence): void {
  const guardOp = '_partition_direction';

  seq.guards.set(guardOp, (_c, s, ctx) => {
    const block = ctx.block;
    if (!block) return true;
    if (block.cause?.ruleId) return true;
    const path = ctx.cell.path;
    if (path.startsWith('_')) return true;
    const blockType = block.type;
    if (!blockType) return true;
    const fromPartition = partitionOf(path, blockType);
    for (const c of blockType.constraints ?? []) {
      if (c.op !== 'ref') continue;
      const target = c.args[0];
      if (typeof target !== 'string' || target.startsWith('_')) continue;
      const targetType = s.typeAt(target);
      const toPartition = partitionOf(target, targetType);
      if (!ALLOWED_REFS[fromPartition].has(toPartition)) {
        return false;
      }
    }
    return true;
  });

  seq.insert({
    path: '_rules._partition_direction',
    rules: [{
      id: '_partition_direction',
      phase: 'admission',
      scope: '',
      when: { op: guardOp, args: [] },
    }],
  });
}

