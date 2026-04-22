/**
 * vertical-prompts.test.ts — Validates that the FT system can express
 * prompt composition requirements. No new framework code — compositions
 * of existing primitives (Sequence, FT, compose, check).
 *
 * Each test maps to an acceptance criterion from impl/prompts/composition.md.
 */

import { FT } from '../builder';
import { Sequence } from '../sequence';
import { compose, check, typeSpecificity } from '../compose';
import { type Type, constraintsOf, literalValue } from '../type';

// ═══════════════════════════════════════════════════════════════════════
// HELPERS — prompt patterns built from existing primitives
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a prompt template as a Sequence where each segment is an independent
 * path under 'prompt.*'. Concrete segments have both schema + value.
 * Open segments have schema only (string type with optional length constraint).
 *
 * This models prompts as objects with named properties — each segment is an
 * independently addressable path with its own type, value, and gap status.
 * No new primitives needed: this is just mount('schema') + mount('bind').
 */
function createPromptTemplate(segments: { name: string; value?: string; type?: Type; budget?: number; mutations?: string[] }[]): Sequence {
  const seq = new Sequence();
  for (const s of segments) {
    // Schema for this segment — string with optional length constraint for budget
    const segType = s.type ?? (s.budget ? FT.string().length(0, s.budget) : FT.string());
    seq.mount('schema', `prompt.${s.name}`, segType);
    // If there's a concrete value, bind it
    if (s.value !== undefined) seq.mount('bind', `prompt.${s.name}`, s.value);
  }
  return seq;
}

/** Fork a prompt: read projection → create new Sequence → mount state. */
function forkPrompt(source: Sequence): Sequence {
  const fork = new Sequence();
  for (const [path, schema] of source.iterateTypes()) {
    fork.mount('schema', path, schema);
  }
  for (const [path, value] of source.iterateValues()) {
    if (path.startsWith('_')) continue; // skip internal paths
    fork.mount('bind', path, value);
  }
  for (const [path, policy] of source.projection.policies) {
    fork.mount('policy', path, policy);
  }
  return fork;
}

/** Count gaps (unfilled segments) in a prompt Sequence. */
function promptGaps(seq: Sequence): { path: string; type: Type }[] {
  return seq.obligations().filter(o => o.path.startsWith('prompt.'));
}

/** Compute prompt concreteness: filled segments / total segments. */
function promptConcreteness(seq: Sequence): number {
  // Count all prompt.* schemas (each is a segment)
  const segmentPaths: string[] = [];
  for (const [path] of seq.iterateTypes()) {
    if (path.startsWith('prompt.') && !path.includes('.', 7)) segmentPaths.push(path); // top-level prompt children only
  }
  if (segmentPaths.length === 0) return 1;
  let filled = 0;
  for (const path of segmentPaths) {
    if (seq.get(path) !== undefined) filled++;
  }
  return filled / segmentPaths.length;
}

// ═══════════════════════════════════════════════════════════════════════
// TESTS — each maps to an acceptance criterion
// ═══════════════════════════════════════════════════════════════════════

describe('Prompt composition via Sequence operations', () => {

  // AC1 [R1, R2]: template with concrete and open segments as independent paths
  test('AC1: three-segment template — two concrete, one open', () => {
    const seq = createPromptTemplate([
      { name: 'prefix', value: 'This is a story lens system prompt.\n\nThe users request is: ' },
      { name: 'input' /* no value = open gap */ },
      { name: 'suffix', value: '\n\nThanks.' },
    ]);

    // Each segment is an independent path with its own schema
    expect(seq.typeAt('prompt.prefix')).toBeDefined();
    expect(seq.typeAt('prompt.input')).toBeDefined();
    expect(seq.typeAt('prompt.suffix')).toBeDefined();

    // Concrete segments have values
    expect(seq.get('prompt.prefix')).toBe('This is a story lens system prompt.\n\nThe users request is: ');
    expect(seq.get('prompt.suffix')).toBe('\n\nThanks.');
    // Open segment has no value
    expect(seq.get('prompt.input')).toBeUndefined();
  });

  // AC2 [R2]: gaps query lists open segments
  test('AC2: gap query returns the open input segment', () => {
    const seq = createPromptTemplate([
      { name: 'prefix', value: 'Hello ' },
      { name: 'input' },
      { name: 'suffix', value: '!' },
    ]);

    const gaps = promptGaps(seq);
    // The open segment shows up as an obligation
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    expect(gaps.some(g => g.path === 'prompt.input')).toBe(true);
  });

  // AC3 [R3, R5]: refine open segment into sub-segments → 4 new gaps
  test('AC3: refining input into sub-segments creates new gaps', () => {
    const seq = createPromptTemplate([
      { name: 'prefix', value: 'System prompt.\n\nRequest: ' },
      { name: 'input' },
      { name: 'suffix', value: '\n\nEnd.' },
    ]);

    // Refine 'input' by replacing it with 4 sub-path schemas
    // This is fork-style refinement: the single 'input' gap becomes 4 specific gaps
    seq.mount('schema', 'prompt.input.time', FT.string().length(0, 50));
    seq.mount('schema', 'prompt.input.history', FT.string().length(0, 2000));
    seq.mount('schema', 'prompt.input.tools', FT.string().length(0, 1500));
    seq.mount('schema', 'prompt.input.message', FT.string().length(0, 500));

    // Now we have 4 sub-gaps under prompt.input (plus the original prompt.input if still open)
    const gaps = seq.obligations();
    const inputSubGaps = gaps.filter(g => g.path.startsWith('prompt.input.'));
    expect(inputSubGaps.length).toBe(4);
    expect(inputSubGaps.map(g => g.path).sort()).toEqual([
      'prompt.input.history', 'prompt.input.message', 'prompt.input.time', 'prompt.input.tools',
    ]);
  });

  // AC4 [R4]: fork isolation — customizing a fork doesn't affect the base
  test('AC4: fork isolation', () => {
    const base = createPromptTemplate([
      { name: 'prefix', value: 'Base prompt: ' },
      { name: 'input' },
      { name: 'suffix', value: '.' },
    ]);

    // User A forks and customizes
    const userA = forkPrompt(base);
    userA.mount('bind', 'prompt.input', 'customized by A');

    // User B reads the base — should see the original
    expect(base.get('prompt.input')).toBeUndefined(); // still open
    expect(userA.get('prompt.input')).toBe('customized by A');

    // Base and fork are independent
    base.mount('bind', 'prompt.input', 'filled in base');
    expect(userA.get('prompt.input')).toBe('customized by A'); // unchanged
    expect(base.get('prompt.input')).toBe('filled in base');
  });

  // AC5 [R6]: concreteness tracking — partial
  test('AC5: concreteness reports fill ratio', () => {
    const seq = createPromptTemplate([
      { name: 'a', value: 'concrete' },
      { name: 'b', value: 'concrete' },
      { name: 'c', value: 'concrete' },
      { name: 'd' },
      { name: 'e' },
    ]);

    const c = promptConcreteness(seq);
    expect(c).toBeCloseTo(0.6); // 3 of 5 filled
  });

  // AC6 [R6]: concreteness at 100% when all segments filled
  test('AC6: full concreteness when all filled', () => {
    const seq = createPromptTemplate([
      { name: 'a', value: 'hello' },
      { name: 'b', value: 'world' },
    ]);

    expect(promptConcreteness(seq)).toBe(1.0);
  });

  // AC7 [R7]: segment budget enforcement via length constraint
  test('AC7: segment budget rejects oversized content', () => {
    const seq = new Sequence();
    seq.mount('schema', 'prompt.body', FT.string().length(0, 20));

    // Within budget — accepted
    const r1 = seq.mount('bind', 'prompt.body', 'short');
    expect(r1.ok).toBe(true);

    // Exceeds budget — schema length constraint rejects
    const r2 = seq.mount('bind', 'prompt.body', 'this string is way too long for the budget');
    expect(r2.ok).toBe(false);
  });

  // AC9 [R10]: unfilled gaps surface as blockers at runtime
  test('AC9: mounting prompt with gaps surfaces obligations', () => {
    const seq = createPromptTemplate([
      { name: 'system', value: 'You are a helpful assistant.' },
      { name: 'context' },
      { name: 'question' },
    ]);

    // Two unfilled gaps
    const gaps = promptGaps(seq);
    const gapPaths = gaps.map(g => g.path);
    expect(gapPaths).toEqual(expect.arrayContaining(['prompt.context', 'prompt.question']));

    // Fill one
    seq.mount('bind', 'prompt.context', 'Working on file X');
    const remainingGaps = promptGaps(seq);
    expect(remainingGaps.length).toBe(gaps.length - 1);
    expect(remainingGaps.some(g => g.path === 'prompt.question')).toBe(true);
  });

  // T3: chain of forks
  test('T3: chain of forks — each layer adds specificity', () => {
    // Base: general purpose prompt
    const base = createPromptTemplate([
      { name: 'system', value: 'You are an AI assistant.' },
      { name: 'context' },
      { name: 'task' },
    ]);

    // Layer 1: coding assistant (fills context pattern)
    const codingAssistant = forkPrompt(base);
    codingAssistant.mount('bind', 'prompt.context', 'You specialize in TypeScript.');

    // Layer 2: specific project (fills task)
    const projectAssistant = forkPrompt(codingAssistant);
    projectAssistant.mount('bind', 'prompt.task', 'Help the user with the FT system.');

    // Each layer is more concrete
    expect(promptConcreteness(base)).toBeCloseTo(1/3);
    expect(promptConcreteness(codingAssistant)).toBeCloseTo(2/3);
    expect(promptConcreteness(projectAssistant)).toBe(1.0);

    // Base is unchanged
    expect(base.get('prompt.context')).toBeUndefined();
    expect(base.get('prompt.task')).toBeUndefined();
  });

  // Refinement monotonicity: compose only tightens
  test('AR3: refinement is monotonic — compose only tightens', () => {
    const wide = FT.string();
    const narrow = FT.string().length(1, 100);
    const composed = compose(wide, narrow);
    // Composed type has the length constraint (tighter)
    expect(constraintsOf(composed, 'length').length).toBe(1);
    // Specificity increased (narrower = more specific)
    expect(typeSpecificity(composed)).toBeGreaterThan(typeSpecificity(wide));
  });

  // MountResult.changes tracks what happened
  test('changes track prompt fill progress', () => {
    const seq = createPromptTemplate([
      { name: 'a' },
      { name: 'b' },
    ]);

    const r = seq.mount('bind', 'prompt.a', 'filled');
    expect(r.changes).toBeDefined();
    const change = r.changes!.find(c => c.path === 'prompt.a');
    expect(change).toBeDefined();
    expect(change!.oldValue).toBeUndefined();
    expect(change!.newValue).toBe('filled');
    expect(change!.cause).toBe('direct');
  });
});
