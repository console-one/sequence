/**
 * shared.ts — symbols pulled out of their natural home section to break
 * a circular import between two stdlib modules (mechanical split of the
 * former monolithic stdlib.ts; see stdlib.ts for the module map).
 *
 * `IDENT_RE` + `renderType` originally lived together with what became
 * render.ts, but reader.ts's `hoistForReader` also calls `renderType`,
 * and render.ts's own formatter needs `IDENT_RE` — a straight two-way
 * import. `resolveImpl` originally lived with what became render.ts
 * too, but is only ever called from commitments.ts, and render.ts
 * transitively depends on planner.ts which depends on commitments.ts —
 * so importing it directly from render.ts would close a three-module
 * cycle (render → planner → commitments → render). Parking all three
 * here keeps every stdlib module a DAG.
 */
import { type Type, constraintOf } from '../../src/type';
import { type Sequence } from '../sequence';

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Render a Type as ft-syntax text. Output is load-bearing for agent
 *  round-trip: hoist emits expand tokens `[[ path : render(type) ]]`,
 *  LLM responses echo the path, parser must consume whatever shape we
 *  printed. Constraints that affect the surface syntax get suffix
 *  treatment (min/max/pattern); structural constraints replace the
 *  kind name (object → { ... }, fn → (p) -> r, array → [elem]);
 *  metadata constraints (impl, derived, temporal, preserves,
 *  identity) are omitted — they parse back from other sources. */
function renderType(t: Type): string {
  const cs = t.constraints;
  const properties = cs.filter(c => c.op === 'property');
  const paramC = cs.find(c => c.op === 'param');
  const returnsC = cs.find(c => c.op === 'returns');
  const elementC = cs.find(c => c.op === 'element');
  const minC = cs.find(c => c.op === 'min');
  const maxC = cs.find(c => c.op === 'max');
  const rangeC = cs.find(c => c.op === 'range');
  const patternC = cs.find(c => c.op === 'pattern');
  const literalC = cs.find(c => c.op === 'literal');

  // Structural replacements
  if (t.kind === 'object' && properties.length > 0) {
    const props = properties.map(c => {
      const [name, type, optional] = c.args as [string, Type, boolean];
      const key = IDENT_RE.test(name) ? name : JSON.stringify(name);
      return `${key}${optional ? '?' : ''}: ${renderType(type)}`;
    });
    return `{ ${props.join(', ')} }`;
  }
  if (t.kind === 'fn') {
    const inputType = paramC ? renderType(paramC.args[0] as Type) : 'any';
    const outputType = returnsC ? renderType(returnsC.args[0] as Type) : 'any';
    return `(${inputType}) -> ${outputType}`;
  }
  if (t.kind === 'array' && elementC) {
    return `[${renderType(elementC.args[0] as Type)}]`;
  }

  // Primitive kind with optional constraint suffixes
  const base = t.kind;

  const suffixes: string[] = [];
  if (literalC) {
    const v = literalC.args[0];
    suffixes.push(typeof v === 'string' ? JSON.stringify(v) : String(v));
  }
  if (rangeC) {
    suffixes.push(`${rangeC.args[0]}..${rangeC.args[1]}`);
  } else if (minC && maxC) {
    suffixes.push(`${minC.args[0]}..${maxC.args[0]}`);
  } else if (minC) {
    suffixes.push(`${minC.args[0]}..`);
  } else if (maxC) {
    suffixes.push(`..${maxC.args[0]}`);
  }
  if (patternC) {
    suffixes.push(`/${patternC.args[0]}/`);
  }

  return suffixes.length > 0 ? `${base} ${suffixes.join(' ')}` : base;
}

function resolveImpl(cell: { path: string; type?: Type }, seq: Sequence): Function | undefined {
  const direct = seq.impls.get(cell.path);
  if (direct) return direct;
  if (cell.type) {
    const implC = constraintOf(cell.type, 'impl');
    if (implC) {
      const id = implC.args[0] as string;
      return seq.impls.get(id);
    }
  }
  return undefined;
}

export { IDENT_RE, renderType, resolveImpl };
