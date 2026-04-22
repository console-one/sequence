/**
 * hoist.ts — The emit side of the ft protocol.
 *
 * Projects a Sequence's state into valid ft block text.
 * The output IS valid ft input — round-trippable through the parser.
 *
 * Concrete values → `path = value`
 * Schemas without values → `path = Type`
 * Gaps (beyond depth limit) → `path = [[ token : type signature ]]`
 * Comments → `-- @source: ... @valid: ...` qualifying metadata
 */

import { type Type, constraintsOf, constraintOf, literalValue } from './type';

/**
 * Readable: the minimal interface hoist needs.
 * Sequence satisfies this.
 */
export type Readable = {
  get(path: string): unknown;
  typeAt(path: string): Type | undefined;
  /** Schema exactly at path, NO ref following or ancestor walk. */
  rawTypeAt(path: string): Type | undefined;
  keys(path?: string): string[];
};

export type HoistOptions = {
  depth?: number;
  expanded?: Set<string>;
  tools?: Set<string>;
  /** Reader identity bindings for visibility enforcement. */
  reader?: Map<string, unknown>;
  /** Sort children of a path by a child field value. */
  sortBy?: { path: string; by: string; desc?: boolean };
  /** Filter children of a path by a predicate. */
  filterBy?: { path: string; field: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; value: unknown };
  /** Named reader contract to use for projection. Reads from _readers.{name}.* */
  readerContract?: string;
};

export type HoistResult = {
  text: string;
  expandTokens: string[];
};

let tokenCounter = 0;
function nextToken(): string {
  tokenCounter++;
  const major = Math.floor(tokenCounter / 100) + 1;
  const minor = Math.floor((tokenCounter % 100) / 10) + 1;
  const sub = (tokenCounter % 10) + 1;
  return `${major}.${minor}.${sub}`;
}

/**
 * Hoist: project a Sequence into ft text.
 *
 * The output is valid ft syntax that can be parsed back
 * and mounted into another Sequence (round-trip).
 */
export function hoist(tree: Readable, opts: HoistOptions = {}): HoistResult {
  const depth = opts.depth ?? 2;
  const expanded = opts.expanded ?? new Set<string>();
  const tools = opts.tools ?? new Set<string>();
  const reader = opts.reader;
  const expandTokens: string[] = [];
  const lines: string[] = [];

  tokenCounter = 0;

  const topKeys = tree.keys().filter(k => !k.startsWith('_'));

  for (const key of topKeys) {
    emitPath(tree, key, key, 0, depth, expanded, tools, reader, opts, expandTokens, lines);
  }

  // Emit gaps as comments
  const gapLines = emitGaps(tree, topKeys, tools);
  if (gapLines.length > 0) {
    lines.push('');
    lines.push('-- Gaps (obligations without values):');
    lines.push(...gapLines);
  }

  return { text: lines.join('\n'), expandTokens };
}

/**
 * Hoist for a named reader contract.
 * Reads the reader's properties from _readers.{name}.* and produces
 * a qualified projection: scoped to source, filtered, limited, with mode.
 */
export function hoistForReader(tree: Readable, readerName: string): HoistResult {
  const source = tree.get(`_readers.${readerName}.source`) as string ?? '*';
  const mode = tree.get(`_readers.${readerName}.mode`) as string ?? 'stable';
  const filter = tree.get(`_readers.${readerName}.filter`) as string | undefined;
  const limit = tree.get(`_readers.${readerName}.limit`) as number | undefined;
  const depth = tree.get(`_readers.${readerName}.depth`) as number ?? 3;
  const render = tree.get(`_readers.${readerName}.render`) as string | undefined;
  const sink = tree.get(`_readers.${readerName}.sink`) as string | undefined;

  const expandTokens: string[] = [];
  const lines: string[] = [];
  tokenCounter = 0;

  // Header: reader metadata
  lines.push(`-- reader: ${readerName} (mode=${mode}${render ? `, render=${render}` : ''}${sink ? `, sink=${sink}` : ''})`);

  // Determine source paths
  let sourcePaths: string[];
  if (source === '*') {
    sourcePaths = tree.keys().filter(k => !k.startsWith('_'));
  } else if (source.endsWith('.*')) {
    const prefix = source.slice(0, -2);
    sourcePaths = tree.keys(prefix).map(k => `${prefix}.${k}`);
  } else if (source.startsWith('_blocks')) {
    // History mode: emit lifecycle facts
    sourcePaths = tree.keys('_blocks').map(k => `_blocks.${k}`);
  } else {
    sourcePaths = [source];
  }

  // Filter
  if (filter) {
    const filterPrefix = filter.endsWith('.*') ? filter.slice(0, -2) : filter;
    if (mode === 'implications') {
      // Implications mode: find paths reachable from source that match filter
      const deps = tree.get(`_deps.${source}`) as string[] | undefined;
      if (deps) {
        sourcePaths = deps.filter(d => d.startsWith(filterPrefix));
        // Include the source itself
        sourcePaths.unshift(source);
      }
    } else if (source.startsWith('_blocks')) {
      // History filter: only blocks targeting matching paths
      sourcePaths = sourcePaths.filter(bp => {
        const target = tree.get(`${bp}.target`) as string;
        return target && target.startsWith(filterPrefix);
      });
    }
  }

  // Limit
  if (limit && sourcePaths.length > limit) {
    const shown = sourcePaths.slice(0, limit);
    const remaining = sourcePaths.length - limit;
    sourcePaths = shown;
    // Add expansion token for remaining
    const token = `${readerName}.more`;
    expandTokens.push(token);
    lines.push(`-- showing ${limit} of ${limit + remaining}`);
  }

  // Emit paths
  const opts: HoistOptions = { depth };
  for (const path of sourcePaths) {
    emitPath(tree, path, path, 0, depth, new Set(), new Set(), undefined, opts, expandTokens, lines);
  }

  // Expansion cursor
  if (limit && sourcePaths.length === limit) {
    const token = `${readerName}.next`;
    expandTokens.push(token);
    lines.push(`[[ ${token} : ${sourcePaths.length} more ]]`);
  }

  // Gaps within scope
  if (mode !== 'history') {
    const gapLines = emitGaps(tree, sourcePaths.map(p => p.split('.')[0]), new Set());
    if (gapLines.length > 0) {
      lines.push('');
      lines.push('-- Gaps:');
      lines.push(...gapLines);
    }
  }

  return { text: lines.join('\n'), expandTokens };
}

function emitPath(
  tree: Readable, path: string, displayPath: string,
  currentDepth: number, maxDepth: number,
  expanded: Set<string>, tools: Set<string>,
  reader: Map<string, unknown> | undefined,
  opts: HoistOptions,
  expandTokens: string[], lines: string[],
): void {
  const value = tree.get(path);
  const type = tree.typeAt(path);
  let children = tree.keys(path);

  // Visibility enforcement: masked data indistinguishable from non-existent.
  if (type?.meta?.visibility && reader) {
    const vis = type.meta.visibility as { op: string; args: readonly unknown[] };
    if (!checkVisibility(vis, reader)) return;
  }

  // Leaf: has value, no children — only render if there's actual data
  if (children.length === 0) {
    if (value !== undefined) {
      lines.push(`${displayPath} = ${renderValueFt(value)}`);
    }
    return;
  }

  // Beyond depth limit and not explicitly expanded → compress
  if (currentDepth >= maxDepth && !expanded.has(path)) {
    const token = nextToken();
    expandTokens.push(token);
    const sig = type ? renderTypeFt(type) : `{ ${children.length} items }`;
    lines.push(`${displayPath} = [[ ${token} : ${sig} ]]`);
    return;
  }

  // Read-time filter: exclude children that don't match the predicate.
  // This never mutates stored data — just omits from the rendered view.
  if (opts.filterBy && opts.filterBy.path === path) {
    const { field, op, value: expected } = opts.filterBy;
    children = children.filter(childKey => {
      const childVal = tree.get(`${path}.${childKey}.${field}`);
      if (childVal === undefined) return false;
      switch (op) {
        case 'eq': return Object.is(childVal, expected);
        case 'neq': return !Object.is(childVal, expected);
        case 'gt': return typeof childVal === 'number' && typeof expected === 'number' && childVal > expected;
        case 'gte': return typeof childVal === 'number' && typeof expected === 'number' && childVal >= expected;
        case 'lt': return typeof childVal === 'number' && typeof expected === 'number' && childVal < expected;
        case 'lte': return typeof childVal === 'number' && typeof expected === 'number' && childVal <= expected;
        default: return true;
      }
    });
  }

  // Read-time sort: reorder children by a field value.
  // Stored order unchanged — this is a view projection.
  if (opts.sortBy && opts.sortBy.path === path) {
    const { by, desc } = opts.sortBy;
    children = [...children].sort((a, b) => {
      const va = tree.get(`${path}.${a}.${by}`);
      const vb = tree.get(`${path}.${b}.${by}`);
      if (va === undefined && vb === undefined) return 0;
      if (va === undefined) return 1;
      if (vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return desc ? vb - va : va - vb;
      if (typeof va === 'string' && typeof vb === 'string') return desc ? vb.localeCompare(va) : va.localeCompare(vb);
      return 0;
    });
  }

  // Expand: emit each child
  for (const childKey of children) {
    const childPath = `${path}.${childKey}`;
    const childDisplay = `${displayPath}.${childKey}`;
    emitPath(tree, childPath, childDisplay, currentDepth + 1, maxDepth, expanded, tools, reader, opts, expandTokens, lines);
  }
}

/** Evaluate a visibility constraint against reader identity bindings. */
function checkVisibility(constraint: { op: string; args: readonly unknown[] }, reader: Map<string, unknown>): boolean {
  switch (constraint.op) {
    case 'eq': {
      const path = constraint.args[0] as string;
      const expected = constraint.args[1];
      return Object.is(reader.get(path), expected);
    }
    case 'exists': return reader.has(constraint.args[0] as string);
    case 'one_of': {
      const val = reader.get(constraint.args[0] as string);
      return (constraint.args[1] as unknown[]).some(v => Object.is(val, v));
    }
    case 'and_clause':
      return (constraint.args as { op: string; args: readonly unknown[] }[]).every(c => checkVisibility(c, reader));
    case 'or_clause':
      return (constraint.args as { op: string; args: readonly unknown[] }[]).some(c => checkVisibility(c, reader));
    case 'not_clause':
      return !checkVisibility(constraint.args[0] as { op: string; args: readonly unknown[] }, reader);
    default: return true; // unknown constraint → visible by default
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER VALUES AS FT SYNTAX
// ═══════════════════════════════════════════════════════════════════════

function renderValueFt(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (typeof value === 'string') return `"${escapeString(value)}"`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length <= 5) return `[${value.map(renderValueFt).join(', ')}]`;
    return `[${value.slice(0, 3).map(renderValueFt).join(', ')}, ... +${value.length - 3}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const props = entries.map(([k, v]) => `${k}: ${renderValueFt(v)}`);
    if (props.join(', ').length < 80) return `{ ${props.join(', ')} }`;
    return `{\n  ${props.join(',\n  ')}\n}`;
  }
  return String(value);
}

function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER TYPES AS FT SYNTAX
// ═══════════════════════════════════════════════════════════════════════

function renderTypeFt(type: Type): string {
  switch (type.kind) {
    case 'string': {
      let s = 'string';
      const pat = constraintOf(type, 'pattern');
      if (pat) s += ` /${pat.args[0]}/`;
      const len = constraintOf(type, 'length');
      if (len) {
        const [mn, mx] = len.args as [number?, number?];
        if (mn !== undefined && mx !== undefined) s += ` ${mn}..${mx}`;
        else if (mn !== undefined) s += ` >= ${mn}`;
        else if (mx !== undefined) s += ` <= ${mx}`;
      }
      const lit = literalValue(type);
      if (lit !== undefined) return `"${escapeString(String(lit))}"`;
      return s;
    }
    case 'number': {
      let s = 'number';
      const intC = constraintOf(type, 'integer');
      if (intC) s += '.integer';
      const mn = constraintOf(type, 'min');
      const mx = constraintOf(type, 'max');
      const rng = constraintOf(type, 'range');
      if (rng) s += ` ${rng.args[0]}..${rng.args[1]}`;
      else if (mn && mx) s += ` ${mn.args[0]}..${mx.args[0]}`;
      else if (mn) s += ` >= ${mn.args[0]}`;
      else if (mx) s += ` <= ${mx.args[0]}`;
      const lit = literalValue(type);
      if (lit !== undefined) return String(lit);
      return s;
    }
    case 'boolean': {
      const lit = literalValue(type);
      if (lit !== undefined) return String(lit);
      return 'boolean';
    }
    case 'null': return 'null';
    case 'any': return '[[ gap ]]';
    case 'never': return 'never';
    case 'object': {
      const props = constraintsOf(type, 'property');
      if (props.length === 0) return '{}';
      const fields = props.map(p => {
        const [key, propType, optional] = p.args as [string, Type, boolean];
        return `${key}${optional ? '?' : ''}: ${renderTypeFt(propType)}`;
      });
      if (fields.join(', ').length < 80) return `{ ${fields.join(', ')} }`;
      return `{\n  ${fields.join(',\n  ')}\n}`;
    }
    case 'array': {
      const elem = constraintOf(type, 'element');
      const len = constraintOf(type, 'arrayLength');
      let s = elem ? `[${renderTypeFt(elem.args[0] as Type)}]` : '[any]';
      if (len) {
        const [mn, mx] = len.args as [number?, number?];
        if (mn !== undefined && mx !== undefined) s = `[${elem ? renderTypeFt(elem.args[0] as Type) : 'any'}, ${mn}..${mx}]`;
      }
      return s;
    }
    case 'fn': {
      const p = constraintOf(type, 'param');
      const r = constraintOf(type, 'returns');
      const pStr = p ? renderTypeFt(p.args[0] as Type) : 'any';
      const rStr = r ? renderTypeFt(r.args[0] as Type) : 'any';
      return `(${pStr}) -> ${rStr}`;
    }
    case 'or': {
      const branches = constraintsOf(type, 'branch');
      return branches.map(b => renderTypeFt(b.args[0] as Type)).join(' | ');
    }
    default:
      return type.kind;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// GAP EMISSION
// ═══════════════════════════════════════════════════════════════════════

function emitGaps(tree: Readable, rootKeys: string[], tools: Set<string>): string[] {
  const gaps: string[] = [];

  function walk(prefix: string) {
    const children = tree.keys(prefix || undefined);
    for (const key of children) {
      const path = prefix ? `${prefix}.${key}` : key;
      // Use rawTypeAt — we want the literal schema mounted at this
      // path, not the ref-followed or ancestor-resolved type.
      // typeAt now walks ancestor refs, which would dereference
      // the ref we're trying to REPORT as a gap.
      const type = tree.rawTypeAt(path);

      if (type) {
        // Only show BLOCKING gaps: unresolved refs and pending derived values
        // NOT every schema without a value — empty collections aren't gaps
        const ref = constraintOf(type, 'ref');
        if (ref) {
          const source = ref.args[0] as string;
          if (tree.get(source) === undefined) {
            gaps.push(`-- ${path} -> ref(${source}) [unresolved]`);
          }
        }
        const derived = constraintOf(type, 'derived');
        if (derived) {
          const [fnId, ...argPaths] = derived.args as string[];
          const missing = argPaths.filter(p => tree.get(p) === undefined);
          if (!tools.has(fnId) || missing.length > 0) {
            gaps.push(`-- ${path} -> ${fnId}(${argPaths.join(', ')}) [pending]`);
          }
        }
      }

      walk(path);
    }
  }

  for (const key of rootKeys) walk(key);
  return gaps;
}
