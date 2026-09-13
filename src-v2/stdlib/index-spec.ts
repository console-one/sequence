import {
  type Constraint, constraintOf, indexSpec, bindFrom,
} from '../../src/type';
import {
  check,
} from '../../src/compose';
import {
  type Sequence,
  type EmitterCtx,
  type BlockTemplate,
} from '../sequence';

// ═══════════════════════════════════════════════════════════════════════
// INDEXSPEC — tuple-product rule driver.
//
// Observation rule that fires on any cell change and re-evaluates every
// mounted index_spec class. Each class projects its binding-space tuples
// and emits body entries at interpolated paths. Idempotency via compose.
// ═══════════════════════════════════════════════════════════════════════

type IndexSpecData = {
  indexedBy?: string[];
  where?: Constraint[];
  body?: Array<{ op: string; path: string; value?: unknown }>;
};
type Tuple = Record<string, unknown>;

// ─── the registry of mounted classes ───────────────────────────────────
//
// The driver has to know which cells carry an index_spec constraint. It
// used to find out by walking every cell of the fold on every change —
// O(N_cells) per change, so a log replay cost O(rows × cells) and live
// ingest paid a full walk per insert.
//
// A class appears at exactly one moment: when its schema lands, which is
// the type delta Case A already sees. So Case A maintains this registry
// and Case B iterates it. Nothing else is needed to know the set.
//
// The set is seeded once per Sequence, on the driver's first dispatch,
// for classes that landed while this driver was not listening — a fold
// restored with the driver uninstalled, the shape a host uses to keep a
// replay off the projection path. That is ONE walk for the life of the
// instance, not one per insert.
//
// Keyed by Sequence so it is per-instance, runtime-only, and collected
// with the instance — the same shape as the other stdlib driver state
// (federation.ts, commitments.ts).

type ClassRegistry = { classes: Set<string>; seeded: boolean };

const registries = new WeakMap<Sequence, ClassRegistry>();

function registryFor(seq: Sequence): ClassRegistry {
  let reg = registries.get(seq);
  if (!reg) {
    reg = { classes: new Set<string>(), seeded: false };
    registries.set(seq, reg);
  }
  return reg;
}

/** One walk, once per Sequence: adopt classes that landed before this
 *  driver was listening. Union, never replace — Case A may already have
 *  registered classes that landed after install. */
function seedRegistry(reg: ClassRegistry, seq: Sequence): void {
  reg.seeded = true;
  for (const c of seq.cells()) {
    if (c.type && constraintOf(c.type, 'index_spec')) reg.classes.add(c.path);
  }
}

export function indexSpecDriver(ctx: EmitterCtx): BlockTemplate[] {
  const { cell, delta, seq } = ctx;
  const reg = registryFor(seq);
  const induced: BlockTemplate[] = [];

  // Case A: a class schema just landed (its own type-change delta) — the
  // one moment a cell becomes a class or stops being one. The registry is
  // maintained here; the bodies fire for the current tuples.
  if (delta.kind === 'type' && cell.type) {
    const spec = constraintOf(cell.type, 'index_spec');
    if (spec) {
      reg.classes.add(cell.path);
      induced.push(...fireBodies(cell.path, spec.args[0] as IndexSpecData, seq));
    } else {
      reg.classes.delete(cell.path);
    }
  }

  // Case B: any cell change. Re-project every mounted class. Since filter
  // args can reference arbitrary paths (via value-bound vars, `_rt`, or
  // cell-path templates), pre-determining which class a given change can
  // affect is brittle; re-projecting all of them is correct, and
  // idempotent through the kernel's same-value compose check — body
  // writes that produce the current value don't cascade further.
  //
  // Performance: O(N_classes) per change — which is now what the code
  // does, not only what this comment says. The classes come from the
  // registry above; the fold is not walked.
  if (!reg.seeded) seedRegistry(reg, seq);
  for (const classPath of reg.classes) {
    const t = seq.typeAt(classPath);
    const spec = t ? constraintOf(t, 'index_spec') : undefined;
    if (!spec) { reg.classes.delete(classPath); continue; }
    induced.push(...fireBodies(classPath, spec.args[0] as IndexSpecData, seq));
  }

  return induced;
}

function fireBodies(classPath: string, spec: IndexSpecData, seq: Sequence): BlockTemplate[] {
  const tuples = projectTuples(spec, seq);
  const out: BlockTemplate[] = [];
  for (const t of tuples) {
    for (const entry of spec.body ?? []) {
      const template: BlockTemplate = {
        path: interpolate(entry.path, t),
        value: interpolateValue(entry.value, t, seq),
      };
      // op: 'delete' in an index_spec body is a convention for
      // clearing the target cell. Map onto the kernel's invalidate op.
      if (entry.op === 'delete') {
        template.op = 'invalidate';
        template.value = undefined;
      }
      out.push(template);
    }
  }
  return out;
}

function projectTuples(spec: IndexSpecData, seq: Sequence): Tuple[] {
  const where = spec.where ?? [];
  const binds = where.filter(c => c.op === 'bind_from');
  const filters = where.filter(c => c.op !== 'bind_from');
  const bases: Record<string, string> = {};

  // Value-bound vars: bound by reading the value at a concrete path
  // (not by iterating a glob's segments). For these, `{var}.field` in a
  // downstream filter means `${var_value}.field`, NOT `${base}.${var}.field`.
  const valueBoundVars = new Set<string>();

  let tuples: Tuple[] = [{}];
  for (const b of binds) {
    const [v, g] = b.args as [string, string];
    const isGlob = g.endsWith('.*');
    const prefixRaw = g.replace(/\.\*$/, '');
    const next: Tuple[] = [];
    for (const t of tuples) {
      // Interpolate any {prior_var} in the path using the current tuple.
      const path = interpolate(prefixRaw, t);
      if (isGlob) {
        bases[v] = path;
        const segs = seq.childSegments(path);
        for (const s of segs) next.push({ ...t, [v]: s });
      } else {
        // Concrete path — bind the VALUE at that path.
        const val = seq.get(path);
        if (val !== undefined) {
          bases[v] = path;
          valueBoundVars.add(v);
          next.push({ ...t, [v]: val });
        }
        // If value undefined, tuple drops.
      }
    }
    tuples = next;
  }

  for (const f of filters) {
    tuples = tuples.filter(t => evalFilter(f, t, bases, seq, valueBoundVars));
  }
  return tuples;
}

function evalFilter(
  c: Constraint,
  t: Tuple,
  bases: Record<string, string>,
  seq: Sequence,
  valueBoundVars: Set<string> = new Set(),
): boolean {
  // resolve walks an argument recursively:
  //   - object with {op, lhs, rhs}: arithmetic, compute and return number
  //   - string matching `{var}`: tuple lookup (var value)
  //   - `{var}.field` where var is segment-bound: seq.get(base.seg.field)
  //   - `{var}.field` where var is value-bound:   seq.get(var_value.field)
  //   - string `_rt`: reads seq._rt or falls back to seq.now()
  //   - any other string: pass through (literal)
  //   - non-string, non-object: pass through (number, boolean, etc.)
  const resolve = (arg: unknown): unknown => {
    if (arg && typeof arg === 'object' && 'op' in (arg as any)) {
      const { op, lhs, rhs } = arg as { op: string; lhs: unknown; rhs: unknown };
      const l = resolve(lhs);
      const r = resolve(rhs);
      if (typeof l !== 'number' || typeof r !== 'number') return undefined;
      switch (op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        default: return undefined;
      }
    }
    if (typeof arg !== 'string') return arg;
    const whole = arg.match(/^\{(\w+)\}$/);
    if (whole && whole[1] in t) return t[whole[1]];
    if (arg in t) return t[arg];
    const parts = arg.split('.');
    if (parts[0] in t && parts.length > 1) {
      if (valueBoundVars.has(parts[0])) {
        // Value-bound: var value IS the base path; append the rest.
        const basePath = String(t[parts[0]]);
        return seq.get(`${basePath}.${parts.slice(1).join('.')}`);
      }
      const base = bases[parts[0]];
      const seg = String(t[parts[0]]);
      return seq.get(`${base}.${seg}.${parts.slice(1).join('.')}`);
    }
    if (arg === '_rt') {
      const rt = seq.get('_rt') as number | undefined;
      return rt ?? seq.now();
    }
    return arg;
  };
  const l = resolve(c.args[0]);
  const r = resolve(c.args[1]);
  switch (c.op) {
    case 'eq':        return l === r;
    case 'neq':       return l !== r;
    case 'exists':    return l !== undefined;
    case 'notExists': return l === undefined;
    case 'gt':        return typeof l === 'number' && typeof r === 'number' && l > r;
    case 'lt':        return typeof l === 'number' && typeof r === 'number' && l < r;
    case 'gte':       return typeof l === 'number' && typeof r === 'number' && l >= r;
    case 'lte':       return typeof l === 'number' && typeof r === 'number' && l <= r;
    default:          return true;
  }
}

function interpolate(template: string, t: Tuple): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(t[k] ?? `{${k}}`));
}
function interpolateValue(template: unknown, t: Tuple, seq?: Sequence): unknown {
  if (template === null || template === undefined) return template;
  if (typeof template !== 'string') {
    // { _deref: 'path' } — read the current value at that path
    if (seq && typeof template === 'object' && '_deref' in (template as any)) {
      const p = (template as { _deref: string })._deref;
      if (p === '_rt') return (seq.get('_rt') as number | undefined) ?? seq.now();
      return seq.get(p);
    }
    return template;
  }
  const whole = template.match(/^\{(\w+)\}$/);
  if (whole && whole[1] in t) return t[whole[1]];
  return template.replace(/\{(\w+)\}/g, (_, k) => String(t[k] ?? `{${k}}`));
}

