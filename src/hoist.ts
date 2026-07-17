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

/* ═══════════════════════════════════════════════════════════════════════
 * CATALOG HOISTING — the capability frame
 *
 * hoist() renders STATE (values, gaps, depth compression). hoistCatalog()
 * renders the CAPABILITY SURFACE: every fn-typed schema in the tree, as
 * nested package blocks with named-type extraction — the storylens
 * `type QueryInput = { … }` / `pkg = { verb { … } }` form. Policy
 * (per the March hoister): complex/shared input shapes hoist to named
 * type definitions; simple scalars inline. Descriptions render as `--`
 * comments (the ft COMMENT token, so the text stays tokenizer-safe).
 *
 * Deliberately walks keys()+rawTypeAt — NOT gaps(): gaps() computes
 * tool-resolution across the whole set and is superlinear on a large
 * flat catalog.
 * ═══════════════════════════════════════════════════════════════════ */

export type CatalogOptions = {
  /** Inline an input object when its one-line form is at most this long
   *  AND the shape is not shared; otherwise hoist to a named type.
   *  Default 60. */
  inlineLimit?: number;
};

type CatalogEntry = { path: string; segments: string[]; type: Type };

/** `content.get` → `ContentGetInput` */
function inputTypeName(path: string): string {
  return (
    path
      .split('.')
      .map(s => s.replace(/(?:^|[-_])(\w)/g, (_, c: string) => c.toUpperCase()))
      .join('') + 'Input'
  );
}

export function hoistCatalog(tree: Readable, opts: CatalogOptions = {}): HoistResult {
  const inlineLimit = opts.inlineLimit ?? 60;

  // 1. Collect every fn-typed path (the mounted capability surface).
  const entries: CatalogEntry[] = [];
  const walk = (prefix: string): void => {
    for (const key of tree.keys(prefix || undefined)) {
      if (key.startsWith('_')) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const type = tree.rawTypeAt(path);
      if (type?.kind === 'fn') entries.push({ path, segments: path.split('.'), type });
      walk(path);
    }
  };
  walk('');
  entries.sort((a, b) => a.path.localeCompare(b.path));

  // 2. Named-type extraction. Structural key = the rendered one-line form;
  //    identical shapes share one name (first use wins). A shape hoists
  //    when shared (used ≥2×) or too long to inline.
  const shapeUses = new Map<string, number>();
  const paramOf = (t: Type): Type | undefined => constraintOf(t, 'param')?.args[0] as Type | undefined;
  for (const e of entries) {
    const p = paramOf(e.type);
    if (!p) continue;
    const rendered = renderTypeFt(p);
    if (rendered === '{}') continue;
    shapeUses.set(rendered, (shapeUses.get(rendered) ?? 0) + 1);
  }
  const namedByShape = new Map<string, string>();
  const typeDefs: string[] = [];
  const signatureFor = (e: CatalogEntry): string => {
    const p = paramOf(e.type);
    if (!p) return '{}';
    const rendered = renderTypeFt(p);
    if (rendered === '{}') return '{}';
    const shared = (shapeUses.get(rendered) ?? 0) >= 2;
    const long = rendered.includes('\n') || rendered.length > inlineLimit;
    if (!shared && !long) return rendered;
    let name = namedByShape.get(rendered);
    if (!name) {
      name = inputTypeName(e.path);
      namedByShape.set(rendered, name);
      typeDefs.push(`type ${name} = ${rendered}`);
    }
    return name;
  };

  // 3. Emit nested package blocks. Group by leading segments; a verb that
  //    is both a leaf and a package (`cash` + `cash.add`) renders its leaf
  //    line first, then its block.
  const lines: string[] = [];
  const describe = (t: Type): string => {
    const d = (t.meta as { description?: string } | undefined)?.description;
    return d ? `  -- ${d}` : '';
  };
  const emitLeaf = (e: CatalogEntry, name: string, indent: string): void => {
    lines.push(`${indent}${name} ${signatureFor(e)}${describe(e.type)}`);
  };
  const byPrefix = (prefix: string): CatalogEntry[] =>
    entries.filter(e => (prefix ? e.path === prefix || e.path.startsWith(prefix + '.') : true));
  const emitGroup = (prefix: string, depth: number, out: string[]): void => {
    const indent = '  '.repeat(depth);
    const heads = new Map<string, CatalogEntry[]>();
    for (const e of byPrefix(prefix)) {
      if (e.path === prefix) continue;
      const head = e.segments[depth];
      const group = heads.get(head) ?? [];
      group.push(e);
      heads.set(head, group);
    }
    for (const [head, group] of [...heads.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const childPrefix = prefix ? `${prefix}.${head}` : head;
      const selfEntry = group.find(e => e.path === childPrefix);
      const hasChildren = group.some(e => e.path !== childPrefix);
      if (selfEntry) out.push(`${indent}${head} ${signatureFor(selfEntry)}${describe(selfEntry.type)}`);
      if (hasChildren) {
        out.push(`${indent}${head} = {`);
        emitGroup(childPrefix, depth + 1, out);
        out.push(`${indent}}`);
      }
    }
  };
  void emitLeaf;

  // Per-top-level-head SECTIONS — the frame IS a budgeted view (each
  // package is one section; the frame renders through the SAME
  // renderOffers/planView compiler the topic views use). One head's
  // block, self-contained — mirrors the top-level loop body of emitGroup.
  const topHeads = new Set(entries.map(e => e.segments[0]));
  const sections: { id: string; text: string }[] = [];
  for (const head of [...topHeads].sort()) {
    const buf: string[] = [];
    const group = entries.filter(e => e.path === head || e.path.startsWith(head + '.'));
    const selfEntry = group.find(e => e.path === head);
    const hasChildren = group.some(e => e.path !== head);
    if (selfEntry) buf.push(`${head} ${signatureFor(selfEntry)}${describe(selfEntry.type)}`);
    if (hasChildren) {
      buf.push(`${head} = {`);
      emitGroup(head, 1, buf);
      buf.push(`}`);
    }
    if (buf.length) sections.push({ id: head, text: buf.join('\n') });
  }
  // typeDefs is populated lazily by signatureFor during the loop above —
  // prepend the _types section only AFTER the loop has filled it.
  if (typeDefs.length) sections.unshift({ id: '_types', text: typeDefs.join('\n') });

  const text = sections.map(s => s.text).join('\n\n');
  return Object.assign({ text, expandTokens: [] as string[] }, { sections });
}

/** The catalog as SECTIONS — the frame's offer-set. Each top-level
 *  package (plus `_types`) is one section; office renders these through
 *  the same renderOffers/planView compiler the topic views use, so the
 *  frame and a topic view are literally the same render operation. */
export function hoistCatalogSections(tree: Readable, opts: CatalogOptions = {}): { id: string; text: string }[] {
  return (hoistCatalog(tree, opts) as unknown as { sections: { id: string; text: string }[] }).sections;
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
