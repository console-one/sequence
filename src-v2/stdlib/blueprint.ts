import {
  type Constraint, type Type, createType, param, returns, impl, derived, properties,
} from '../../src/type';
import {
  check,
} from '../../src/compose';
import {
  type Sequence,
  type BlockTemplate,
} from '../sequence';

// ═══════════════════════════════════════════════════════════════════════
// BLUEPRINT — a Sequence scope with typed gaps the USER fills through a
// form UI. Every gap is a type-only cell. Every fill is a seq.insert().
// When all gaps have values, `complete` derives true. The blueprint
// itself is type state, not a TS object.
//
// Layout after installBlueprint(seq, 'github', { gaps: [...] }):
//   _blueprints.github.description    string
//   _blueprints.github.gaps.apiKey    string /regex/      (type-only)
//   _blueprints.github.gaps.org       string              (type-only)
//   _blueprints.github.gaps.repo      string              (type-only)
//   _blueprints.github.gaps.apiKey._description  string   ("Personal access token")
//   _blueprints.github.complete       boolean (derived)
//
// User fills via `seq.insert({ path: '_blueprints.github.gaps.apiKey', value: '...' })`.
// Cascade re-derives `complete`. UI picks up state by reading the gaps reader.
// ═══════════════════════════════════════════════════════════════════════

export type BlueprintGapSpec = {
  /** Gap name — becomes cell path segment under _blueprints.{id}.gaps */
  name: string;
  /** Type of the gap — drives UI form field via its kind + constraints */
  type: Type;
  /** Human-readable label shown in the UI form */
  description?: string;
  /** Optional: path of an existing value that may pre-fill this gap
   *  (e.g. a previously-entered constant the user can reuse) */
  reuseFrom?: string;
};

export function installBlueprint(
  seq: Sequence,
  id: string,
  config: { description: string; gaps: BlueprintGapSpec[] },
): void {
  const base = `_blueprints.${id}`;
  const gapNames = config.gaps.map(g => g.name);
  seq.insert({ path: `${base}.description`, value: config.description });
  seq.insert({ path: `${base}.gap_names`, value: gapNames });
  seq.insert({ path: `${base}.version`, value: 0 });

  for (const gap of config.gaps) {
    const gapPath = `${base}.gaps.${gap.name}`;
    seq.insert({ path: gapPath, type: gap.type });
    if (gap.description) {
      seq.insert({ path: `${gapPath}._description`, value: gap.description });
    }
    if (gap.reuseFrom) {
      seq.insert({ path: `${gapPath}._reuseFrom`, value: gap.reuseFrom });
    }
  }

  // Observation rule: any value-write under the gaps scope bumps the
  // blueprint version counter. Derivations downstream (complete, gaps
  // reader, kit progression) depend on the version — NOT on gap paths
  // directly — because computeDerived bails if any dep is undefined, and
  // by design gap cells start type-only (undefined values).
  const bumpEmitterId = `${base}.kernel.bump_version`;
  seq.emitters.set(bumpEmitterId, (_ctx) => {
    const cur = (seq.get(`${base}.version`) as number | undefined) ?? 0;
    return [{ path: `${base}.version`, value: cur + 1 }];
  });
  seq.insert({
    path: `_rules.blueprint_${id}_version`,
    rules: [{
      id: `blueprint_${id}_version`,
      phase: 'observation',
      scope: '',
      watching: [`${base}.gaps.*`],
      when: { op: 'deltaKindIs', args: ['value'] },
      emit: bumpEmitterId,
    }],
  });

  // complete = all gaps filled. Impl closes over seq, reads gap values
  // fresh; derivation dep is the version counter.
  seq.impls.set(`${base}.kernel.check_complete`, (_v: number) => {
    return gapNames.every(n => seq.get(`${base}.gaps.${n}`) !== undefined);
  });
  seq.insert({
    path: `${base}.complete`,
    type: createType('boolean', [
      derived(`${base}.kernel.check_complete`, `${base}.version`),
    ]),
  });
}


// ═══════════════════════════════════════════════════════════════════════
// GAPS READER — structured, form-renderable projection of unresolved
// gaps under a blueprint (or any scope). Each entry reports enough
// per-type metadata for a generic UI renderer to pick the right form
// field: kind, description, current value, constraint hints.
//
// Output shape (value at _readers.{name}.gaps):
//   [
//     {
//       path: '_blueprints.github.gaps.apiKey',
//       name: 'apiKey',
//       kind: 'string',
//       description: 'Personal access token',
//       filled: false,
//       currentValue: undefined,
//       pattern: '^ghp_.+',       // if type has pattern()
//       range: { min: 0, max: 100 },  // if type has min/max
//       properties: [...],        // if type.kind === 'object'
//       reuseFrom: 'const.github_token',  // if reuse hint declared
//     },
//     ...
//   ]
//
// Re-derives when any gap cell changes (filled or reverted).
// ═══════════════════════════════════════════════════════════════════════

export type GapEntry = {
  path: string;
  name: string;
  kind: string;
  description?: string;
  filled: boolean;
  currentValue?: unknown;
  pattern?: string;
  range?: { min?: number; max?: number };
  properties?: Array<{ name: string; kind: string; optional: boolean }>;
  reuseFrom?: string;
};

function describeGap(path: string, name: string, cell: { type?: Type; value?: unknown } | undefined, description: string | undefined, reuseFrom: string | undefined): GapEntry {
  const entry: GapEntry = {
    path,
    name,
    kind: cell?.type?.kind ?? 'any',
    filled: cell?.value !== undefined,
    currentValue: cell?.value,
  };
  if (description) entry.description = description;
  if (reuseFrom) entry.reuseFrom = reuseFrom;
  if (!cell?.type) return entry;

  const cs = cell.type.constraints;
  const patternC = cs.find(c => c.op === 'pattern');
  if (patternC) entry.pattern = patternC.args[0] as string;

  const minC = cs.find(c => c.op === 'min');
  const maxC = cs.find(c => c.op === 'max');
  const rangeC = cs.find(c => c.op === 'range');
  if (rangeC) entry.range = { min: rangeC.args[0] as number, max: rangeC.args[1] as number };
  else if (minC || maxC) {
    entry.range = {};
    if (minC) entry.range.min = minC.args[0] as number;
    if (maxC) entry.range.max = maxC.args[0] as number;
  }

  if (cell.type.kind === 'object') {
    const props = cs.filter(c => c.op === 'property').map(c => {
      const [n, t, opt] = c.args as [string, Type, boolean];
      return { name: n, kind: t.kind, optional: !!opt };
    });
    if (props.length > 0) entry.properties = props;
  }

  return entry;
}

/**
 * Install a gaps-document reader for a blueprint's gaps. The reader's
 * output cell re-derives whenever any gap cell changes.
 *
 * Prereq: installBlueprint has been called with the same gap names.
 */
export function installBlueprintGapsReader(
  seq: Sequence,
  readerName: string,
  blueprintId: string,
): void {
  const bpBase = `_blueprints.${blueprintId}`;
  const gapNames = seq.get(`${bpBase}.gap_names`) as string[] | undefined;
  if (!gapNames) {
    throw new Error(
      `installBlueprintGapsReader: blueprint '${blueprintId}' not installed ` +
      `(no cell at ${bpBase}.gap_names)`,
    );
  }

  // Impl closes over seq; dep on blueprint version counter ensures the
  // reader re-derives on any gap write without requiring gap cells to
  // have values.
  seq.impls.set(`_readers.${readerName}.kernel.collect_gaps`, (_v: number) => {
    const entries: GapEntry[] = [];
    for (const name of gapNames) {
      const gapPath = `${bpBase}.gaps.${name}`;
      const cell = seq.getCell(gapPath);
      const description = seq.get(`${gapPath}._description`) as string | undefined;
      const reuseFrom = seq.get(`${gapPath}._reuseFrom`) as string | undefined;
      entries.push(describeGap(gapPath, name, cell, description, reuseFrom));
    }
    return entries;
  });

  seq.insert({
    path: `_readers.${readerName}.kind`,
    value: 'gaps_document',
  });
  seq.insert({
    path: `_readers.${readerName}.blueprintRef`,
    value: bpBase,
  });
  seq.insert({
    path: `_readers.${readerName}.gaps`,
    type: createType('array', [
      derived(`_readers.${readerName}.kernel.collect_gaps`, `${bpBase}.version`),
    ]),
  });
}


// ═══════════════════════════════════════════════════════════════════════
// KIT — narrative ordering over a blueprint's gaps. Specifies which gap
// to ask the user first, descriptions/hints, and optionally dependencies
// (B is only shown when A is filled). The kit is type state; the UI
// reads _kits.{id}.current_gap to know what to render next.
//
// Layout after installKit:
//   _kits.{id}.description     string
//   _kits.{id}.blueprintRef    string  ('_blueprints.{bpId}')
//   _kits.{id}.order           string[]
//   _kits.{id}.current_gap     string | null   (derived — first unfilled per order)
//   _kits.{id}.progress        { filled: N, total: M } (derived)
// ═══════════════════════════════════════════════════════════════════════

export function installKit(
  seq: Sequence,
  id: string,
  config: {
    blueprintId: string;
    order: string[];
    description?: string;
  },
): void {
  const base = `_kits.${id}`;
  const bpBase = `_blueprints.${config.blueprintId}`;
  seq.insert({ path: `${base}.blueprintRef`, value: bpBase });
  seq.insert({ path: `${base}.order`, value: config.order });
  if (config.description) {
    seq.insert({ path: `${base}.description`, value: config.description });
  }

  // Kit derivations depend on the blueprint's version counter (bumped by
  // installBlueprint's observation rule on gap writes). Impls close over
  // seq to read gap values fresh — same pattern as the gaps reader.
  seq.impls.set(`${base}.kernel.current_gap`, (_v: number) => {
    for (const name of config.order) {
      if (seq.get(`${bpBase}.gaps.${name}`) === undefined) return name;
    }
    return null;
  });
  seq.insert({
    path: `${base}.current_gap`,
    type: createType('any', [
      derived(`${base}.kernel.current_gap`, `${bpBase}.version`),
    ]),
  });

  seq.impls.set(`${base}.kernel.progress`, (_v: number) => {
    let filled = 0;
    for (const name of config.order) {
      if (seq.get(`${bpBase}.gaps.${name}`) !== undefined) filled++;
    }
    return { filled, total: config.order.length };
  });
  seq.insert({
    path: `${base}.progress`,
    type: createType('object', [
      derived(`${base}.kernel.progress`, `${bpBase}.version`),
    ]),
  });
}


// ═══════════════════════════════════════════════════════════════════════
// BLUEPRINT OUTPUT — the wire from "blueprint complete" to "tool appears."
//
// Without this, a blueprint is just a filled-in form; no tool actually
// materializes. installBlueprintOutput mounts an observation rule on
// `_blueprints.{id}.complete`; when that cell's value transitions to
// true, the rule emits the fn-kind tool cell at the configured path.
// The tool's impl is registered at install time and closes over seq so
// it reads gap values fresh at each call (not baked in at mount).
//
// After installBlueprintOutput(seq, 'github', { toolPath: 'tools.github.fetch_pulls', ... }):
//   - BEFORE the blueprint completes: no cell exists at the toolPath.
//   - The moment complete becomes true: fn-kind cell + description +
//     source appear at toolPath; the impl is registered on seq.impls.
//   - Subsequent gap edits update the impl's READ values (impl is a
//     closure), so the tool transparently uses the latest config.
//   - Invoking the tool: seq.insert({ path: toolPath, value: input })
//     produces an invocation delta → existing commitment rule elects a
//     commitment → impl runs with input + gaps closure → result lands at
//     `${toolPath}.result`.
//
// The tool type participates in the AGENT_PROMPT_FRAME section 1.2
// automatically — the section-1.2 renderer walks all fn-kind cells.
// But the tools_version counter is bumped explicitly after mount so the
// section re-derives even if the walker hasn't observed the new type
// through its own dep chain.
// ═══════════════════════════════════════════════════════════════════════

export function installBlueprintOutput(
  seq: Sequence,
  blueprintId: string,
  config: {
    toolPath: string;
    inputType: Type;
    outputType: Type;
    description?: string;
    source?: { id: string; displayName?: string };
    claims?: Constraint[];
    /** Called at tool-invocation time with the user's input + a map of
     *  gap name → current gap value. Return the tool's output. */
    impl: (input: unknown, gaps: Record<string, unknown>) => unknown | Promise<unknown>;
  },
): void {
  const bpBase = `_blueprints.${blueprintId}`;
  const gapNames = seq.get(`${bpBase}.gap_names`) as string[] | undefined;
  if (!gapNames) {
    throw new Error(
      `installBlueprintOutput: blueprint '${blueprintId}' not installed ` +
      `(no cell at ${bpBase}.gap_names). Call installBlueprint first.`,
    );
  }

  // Impl closes over seq. Reads gap values fresh every call so a user
  // who later edits a gap (e.g. rotates the API key) doesn't need to
  // re-mount the tool — next invocation picks up the new value.
  const implId = `${bpBase}.kernel.tool_impl`;
  seq.impls.set(implId, async (input: unknown) => {
    const gaps: Record<string, unknown> = {};
    for (const n of gapNames) gaps[n] = seq.get(`${bpBase}.gaps.${n}`);
    return await config.impl(input, gaps);
  });

  // Emitter: on complete transitioning to `true`, mount the fn-kind cell
  // at toolPath. Idempotent — kernel compose-at-cell's sameType check
  // drops no-op type writes, so re-firing on repeated true values is safe.
  const emitterId = `${bpBase}.kernel.mount_tool`;
  seq.emitters.set(emitterId, (ctx) => {
    if (ctx.cell.path !== `${bpBase}.complete`) return [];
    if (ctx.delta.kind !== 'value') return [];
    if (ctx.delta.next !== true) return [];
    const fnType = createType('fn', [
      param(config.inputType),
      returns(config.outputType),
      impl(implId),
      ...(config.claims ?? []),
    ]);
    const templates: BlockTemplate[] = [{ path: config.toolPath, type: fnType }];
    if (config.description) {
      templates.push({ path: `${config.toolPath}._description`, value: config.description });
    }
    if (config.source) {
      templates.push({ path: `${config.toolPath}._source.id`, value: config.source.id });
      if (config.source.displayName) {
        templates.push({ path: `${config.toolPath}._source.displayName`, value: config.source.displayName });
      }
    }
    // Bump the agent-prompt tools registry so section 1.2 re-derives
    // to include the newly-mounted tool.
    const curVer = (seq.get('_prompt.registry.tools_version') as number | undefined) ?? 0;
    templates.push({ path: '_prompt.registry.tools_version', value: curVer + 1 });
    return templates;
  });

  // Observation rule — scope narrows to the blueprint subtree; emitter
  // does the final pathEq + delta-kind + next-value checks.
  seq.insert({
    path: `_rules.blueprint_${blueprintId}_output`,
    rules: [{
      id: `blueprint_${blueprintId}_output`,
      phase: 'observation',
      scope: bpBase,
      emit: emitterId,
    }],
  });
}

