/**
 * procedure.ts — procedures as declared, versioned data (DSL PROGRAM seam 4).
 *
 * A ProcedureManifest is pure vocabulary: fully serializable data (params are
 * sequence Types — frozen {kind, constraints} objects; steps are literals and
 * a CLOSED derivation vocabulary). planProcedure is the standalone pure
 * evaluator (the evaluate.ts / elect.ts precedent): manifest + supplied
 * values → validated, planned facts. No I/O, no dao, no host imports — the
 * dao layer stores and gathers; the host executes the plan.
 *
 * Lineage: installBlueprint/installKit (typed gaps a form fills) are the
 * live-Sequence form of the same contract; this module is the standalone
 * form consumers holding plain state use. The blueprint→kit→capability
 * chain: manifest params = the contract, an install's values = the kit,
 * the planned facts (declarations the runtime reconciles) = the capability.
 *
 * Derivations are deliberately tiny: lit / param / join / coalesce /
 * stripPrefix. Anything richer belongs in the Expr vocabulary as the
 * language grows — widening this ad hoc is how a second template language
 * would sneak in. Fail-loud everywhere; unknown shapes never pass silently.
 */

import type { Type } from '../src/type';
import { check } from '../src/compose';

// ─── Params: the typed install contract ─────────────────────────────────

export interface ProcedureParam {
  name: string;
  /** Sequence Type — validated with the real check() machinery. */
  type: Type;
  label?: string;
  description?: string;
  /** Applied when the value is absent or blank. A param with neither
   *  default nor optional is REQUIRED — planProcedure reports it as an
   *  open gap. */
  default?: unknown;
  optional?: boolean;
  /** Secret param: its value may flow ONLY into a storeSecret step.
   *  planProcedure fails loudly if any other template references it. */
  secret?: boolean;
  /** Numeric unit scale applied at resolution (e.g. minutes→ms = 60000). */
  scale?: number;
  /** Round the (scaled) numeric value to an integer. */
  round?: boolean;
  /** Renderer hints — opaque to the evaluator. */
  ui?: Record<string, unknown>;
}

// ─── Values: the closed derivation vocabulary ────────────────────────────

export type ProcedureValue =
  | { lit: string | number | boolean }
  | { param: string } // a param OR a prior derived name
  | { join: ProcedureValue[] } // string concatenation
  | { coalesce: ProcedureValue[] } // first non-empty value
  | { stripPrefix: [ProcedureValue, string] };

/** Config templates: leaves are either recognized ProcedureValue objects
 *  (evaluated) or plain JSON literals (passed through). */
export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | ProcedureValue
  | TemplateValue[]
  | { [key: string]: TemplateValue };

// ─── Steps ───────────────────────────────────────────────────────────────

export type StepGuard = { present: string } | { absent: string };

export interface CreateTopicStep {
  createTopic: {
    topicID: ProcedureValue;
    topicKind: string;
    renderMode?: string;
    title?: ProcedureValue;
    description?: string;
    tags?: string[];
  };
}

export interface DeclareProcessorStep {
  declareProcessor: {
    /** Deterministic instance name — installs are replayable facts. */
    name: string;
    processKind: string;
    attachTo: ProcedureValue;
    config: Record<string, TemplateValue>;
  };
}

export interface StoreSecretStep {
  storeSecret: {
    key: ProcedureValue;
    fromParam: string;
  };
}

export type ProcedureStep = (
  | CreateTopicStep
  | DeclareProcessorStep
  | StoreSecretStep
) & { when?: StepGuard };

// ─── The manifest ────────────────────────────────────────────────────────

export interface ProcedureManifest {
  /** Stable procedure id (catalog key, install dedup). */
  id: string;
  /** Version of THIS manifest+implementation pairing. Install facts
   *  record it; declarations may pin it (TopicProcessorRef.version). */
  version: string;
  title: string;
  description?: string;
  tags?: string[];
  params: ProcedureParam[];
  /** Ordered derivations; later entries may reference earlier ones. */
  derived?: Array<{ name: string; value: ProcedureValue }>;
  steps: ProcedureStep[];
}

// ─── Planned facts (host-agnostic; the host's runner executes them) ─────

export type PlannedFact =
  | {
      kind: 'createTopic';
      topicID: string;
      topicKind: string;
      renderMode?: string;
      title?: string;
      description?: string;
      tags?: string[];
    }
  | {
      kind: 'registerProcess';
      /** Deterministic processor instance name. */
      name: string;
      processRef: string;
      processKind: string;
      attachTo: string;
      config: Record<string, unknown>;
    }
  | { kind: 'writeSecret'; key: string; value: string };

export interface ProcedureGap {
  name: string;
  kind: string; // Type.kind of the missing param
  label?: string;
  description?: string;
  secret?: boolean;
  ui?: Record<string, unknown>;
}

export type PlanResult =
  | { ok: true; facts: PlannedFact[] }
  | { ok: false; gaps: ProcedureGap[] };

// ─── Evaluation ──────────────────────────────────────────────────────────

const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

const VALUE_KEYS = ['lit', 'param', 'join', 'coalesce', 'stripPrefix'] as const;

function isProcedureValue(v: unknown): v is ProcedureValue {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && (VALUE_KEYS as readonly string[]).includes(keys[0]!);
}

/** Resolve one param's raw supplied value → its resolved value (defaults,
 *  scale, round). Returns undefined when absent (caller decides gap vs
 *  optional). */
function resolveParamValue(p: ProcedureParam, supplied: unknown): unknown {
  let v = isBlank(supplied) ? p.default : supplied;
  if (isBlank(v)) return undefined;
  if (typeof v === 'number') {
    if (p.scale !== undefined) v = v * p.scale;
    if (p.round) v = Math.round(v as number);
  }
  return v;
}

/** Declared-vs-bound distinction: an optional param that was declared
 *  but not supplied reads as undefined (so coalesce/guards treat it as
 *  empty); a name the manifest never declared throws — total vocabulary,
 *  never a silent empty for a typo. */
class Scope {
  private readonly declared = new Set<string>();
  private readonly values = new Map<string, unknown>();
  declare_(name: string): void {
    this.declared.add(name);
  }
  get(name: string): unknown {
    if (!this.declared.has(name)) {
      throw new Error(`procedure value references unknown name '${name}'`);
    }
    return this.values.get(name);
  }
  set(name: string, v: unknown): void {
    this.declared.add(name);
    this.values.set(name, v);
  }
}

function evalValue(v: ProcedureValue, scope: Scope): unknown {
  if ('lit' in v) return v.lit;
  if ('param' in v) return scope.get(v.param);
  if ('join' in v) {
    return v.join
      .map((part) => {
        const r = evalValue(part, scope);
        return isBlank(r) ? '' : String(r);
      })
      .join('');
  }
  if ('coalesce' in v) {
    for (const part of v.coalesce) {
      const r = evalValue(part, scope);
      if (!isBlank(r)) return r;
    }
    return undefined;
  }
  if ('stripPrefix' in v) {
    const [inner, prefix] = v.stripPrefix;
    const r = evalValue(inner, scope);
    const s = isBlank(r) ? '' : String(r);
    return s.startsWith(prefix) ? s.slice(prefix.length) : s;
  }
  throw new Error(
    `unrecognized procedure value ${JSON.stringify(v)} — vocabulary is lit/param/join/coalesce/stripPrefix`,
  );
}

function evalString(v: ProcedureValue, scope: Scope, what: string): string {
  const r = evalValue(v, scope);
  if (isBlank(r)) throw new Error(`${what} evaluated to empty`);
  return String(r);
}

function evalTemplate(t: TemplateValue, scope: Scope): unknown {
  if (isProcedureValue(t)) return evalValue(t, scope);
  if (Array.isArray(t)) return t.map((x) => evalTemplate(x, scope));
  if (t !== null && typeof t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t)) {
      const r = evalTemplate(v as TemplateValue, scope);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return t;
}

function guardHolds(when: StepGuard | undefined, scope: Scope): boolean {
  if (!when) return true;
  if ('present' in when) return !isBlank(scope.get(when.present));
  return isBlank(scope.get(when.absent));
}

/** Walk a template collecting `{param}` references (secret-flow lint). */
function collectParamRefs(t: TemplateValue, into: Set<string>): void {
  if (isProcedureValue(t)) {
    collectValueRefs(t, into);
    return;
  }
  if (Array.isArray(t)) {
    for (const x of t) collectParamRefs(x, into);
    return;
  }
  if (t !== null && typeof t === 'object') {
    for (const v of Object.values(t)) collectParamRefs(v as TemplateValue, into);
  }
}

function collectValueRefs(v: ProcedureValue, into: Set<string>): void {
  if ('param' in v) into.add(v.param);
  else if ('join' in v) for (const p of v.join) collectValueRefs(p, into);
  else if ('coalesce' in v) for (const p of v.coalesce) collectValueRefs(p, into);
  else if ('stripPrefix' in v) collectValueRefs(v.stripPrefix[0], into);
}

// ─── The evaluator ───────────────────────────────────────────────────────

/**
 * Plan a procedure install: validate values against the typed param
 * contract (open required params → gaps, never a throw; INVALID supplied
 * values → throw, named), evaluate derivations, then instantiate the
 * guarded steps into planned facts.
 */
export function planProcedure(
  manifest: ProcedureManifest,
  values: Record<string, unknown>,
): PlanResult {
  // 1. Secret-flow lint (manifest-level; independent of values).
  lintSecretFlow(manifest);

  // 2. Resolve params: defaults + scale, typed validation, gap collection.
  const scope = new Scope();
  const gaps: ProcedureGap[] = [];
  for (const p of manifest.params) scope.declare_(p.name);
  for (const p of manifest.params) {
    const v = resolveParamValue(p, values[p.name]);
    if (v === undefined) {
      if (!p.optional) {
        gaps.push({
          name: p.name,
          kind: p.type.kind,
          ...(p.label !== undefined ? { label: p.label } : {}),
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(p.secret ? { secret: true } : {}),
          ...(p.ui !== undefined ? { ui: p.ui } : {}),
        });
      }
      continue;
    }
    // Validate the PRE-scale supplied value's type kind is what the scale
    // math assumed? No — validate the resolved value against the declared
    // type; scale preserves kind (number→number).
    const result = check(p.type, v);
    if (!result.ok) {
      throw new Error(
        `procedure '${manifest.id}' param '${p.name}' invalid: ${JSON.stringify(result)}`,
      );
    }
    scope.set(p.name, v);
  }
  if (gaps.length > 0) return { ok: false, gaps };

  // 3. Derivations, in declared order.
  for (const d of manifest.derived ?? []) {
    scope.set(d.name, evalValue(d.value, scope));
  }

  // 4. Steps → facts.
  const facts: PlannedFact[] = [];
  for (const step of manifest.steps) {
    if (!guardHolds(step.when, scope)) continue;
    if ('createTopic' in step) {
      const s = step.createTopic;
      facts.push({
        kind: 'createTopic',
        topicID: evalString(s.topicID, scope, `${manifest.id} createTopic.topicID`),
        topicKind: s.topicKind,
        ...(s.renderMode !== undefined ? { renderMode: s.renderMode } : {}),
        ...(s.title !== undefined
          ? { title: evalString(s.title, scope, `${manifest.id} createTopic.title`) }
          : {}),
        ...(s.description !== undefined ? { description: s.description } : {}),
        ...(s.tags !== undefined ? { tags: s.tags } : {}),
      });
    } else if ('declareProcessor' in step) {
      const s = step.declareProcessor;
      facts.push({
        kind: 'registerProcess',
        name: s.name,
        processRef: `process:${s.processKind}:${s.name}`,
        processKind: s.processKind,
        attachTo: evalString(s.attachTo, scope, `${manifest.id} declareProcessor.attachTo`),
        config: evalTemplate(s.config, scope) as Record<string, unknown>,
      });
    } else if ('storeSecret' in step) {
      const s = step.storeSecret;
      const value = scope.get(s.fromParam);
      if (isBlank(value)) continue; // optional secret not supplied
      facts.push({
        kind: 'writeSecret',
        key: evalString(s.key, scope, `${manifest.id} storeSecret.key`),
        value: String(value),
      });
    } else {
      throw new Error(
        `procedure '${manifest.id}' has an unrecognized step ${JSON.stringify(step)}`,
      );
    }
  }
  return { ok: true, facts };
}

/**
 * The open gaps for a partially-supplied values map — the wizard's
 * "what do I still need" read. Same rules as planProcedure step 2.
 */
export function procedureGaps(
  manifest: ProcedureManifest,
  values: Record<string, unknown>,
): ProcedureGap[] {
  const gaps: ProcedureGap[] = [];
  for (const p of manifest.params) {
    const v = resolveParamValue(p, values[p.name]);
    if (v === undefined && !p.optional) {
      gaps.push({
        name: p.name,
        kind: p.type.kind,
        ...(p.label !== undefined ? { label: p.label } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.secret ? { secret: true } : {}),
        ...(p.ui !== undefined ? { ui: p.ui } : {}),
      });
    }
  }
  return gaps;
}

/**
 * Evaluate ONE declareProcessor step's config template under new values —
 * the edit-side read (settings panes re-derive a processor's config from
 * form values without re-running the install). Returns null when the
 * step's guard does not hold or the step name is unknown (caller decides).
 * Required-param gaps throw here (an edit form always has a full model).
 */
export function planProcessorConfig(
  manifest: ProcedureManifest,
  stepName: string,
  values: Record<string, unknown>,
): Record<string, unknown> | null {
  lintSecretFlow(manifest);
  const scope = new Scope();
  for (const p of manifest.params) scope.declare_(p.name);
  for (const p of manifest.params) {
    const v = resolveParamValue(p, values[p.name]);
    if (v === undefined) {
      if (!p.optional) {
        throw new Error(
          `procedure '${manifest.id}' param '${p.name}' required for config of '${stepName}'`,
        );
      }
      continue;
    }
    const result = check(p.type, v);
    if (!result.ok) {
      throw new Error(
        `procedure '${manifest.id}' param '${p.name}' invalid: ${JSON.stringify(result)}`,
      );
    }
    scope.set(p.name, v);
  }
  for (const d of manifest.derived ?? []) {
    scope.set(d.name, evalValue(d.value, scope));
  }
  for (const step of manifest.steps) {
    if (!('declareProcessor' in step)) continue;
    if (step.declareProcessor.name !== stepName) continue;
    if (!guardHolds(step.when, scope)) return null;
    return evalTemplate(step.declareProcessor.config, scope) as Record<string, unknown>;
  }
  return null;
}

// ─── Secret-flow lint ────────────────────────────────────────────────────

function lintSecretFlow(manifest: ProcedureManifest): void {
  const secretParams = new Set(
    manifest.params.filter((p) => p.secret).map((p) => p.name),
  );
  if (secretParams.size === 0) return;

  const offending = new Set<string>();
  const checkRefs = (refs: Set<string>, where: string): void => {
    for (const r of refs) {
      if (secretParams.has(r)) offending.add(`${r} in ${where}`);
    }
  };
  // Derivations may not read secrets (they feed non-secret sinks).
  for (const d of manifest.derived ?? []) {
    const refs = new Set<string>();
    collectValueRefs(d.value, refs);
    checkRefs(refs, `derived '${d.name}'`);
  }
  for (const step of manifest.steps) {
    if ('createTopic' in step) {
      const refs = new Set<string>();
      collectValueRefs(step.createTopic.topicID, refs);
      if (step.createTopic.title) collectValueRefs(step.createTopic.title, refs);
      checkRefs(refs, 'createTopic');
    } else if ('declareProcessor' in step) {
      const refs = new Set<string>();
      collectValueRefs(step.declareProcessor.attachTo, refs);
      collectParamRefs(step.declareProcessor.config, refs);
      checkRefs(refs, `declareProcessor '${step.declareProcessor.name}'`);
    }
    // storeSecret is the one legal sink (fromParam, not a template).
  }
  if (offending.size > 0) {
    throw new Error(
      `procedure '${manifest.id}' leaks secret params outside storeSecret: ${[...offending].join('; ')}`,
    );
  }
}
