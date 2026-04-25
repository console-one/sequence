/**
 * blueprint.test.ts — Blueprint + Gaps reader + Kit primitives.
 *
 * A blueprint is a Sequence scope with typed gaps the user fills via a
 * form UI. No TS API drives the fill — the UI reads
 * _readers.{name}.gaps (a structured array of gap records), renders a
 * form per type.kind, and posts seq.insert() writes back. The blueprint
 * derives `complete` automatically.
 *
 * A kit adds narrative ordering over a blueprint's gaps: which to ask
 * first, descriptions, reuse hints. current_gap and progress are derived.
 */

import { Sequence } from '../sequence';
import {
  createType, property, pattern, min, max,
} from '../../src/type';
import {
  installBlueprint, installBlueprintGapsReader, installKit,
  installBlueprintOutput, installAgentPrompt, installCommitment,
  flushPending,
  type GapEntry,
} from '../stdlib';

const str = () => createType('string');

describe('Blueprint — typed gaps as type state', () => {
  it('installBlueprint mounts gap cells + complete derivation', () => {
    const s = new Sequence();
    installBlueprint(s, 'github', {
      description: 'Configure a GitHub connection',
      gaps: [
        { name: 'apiKey', type: createType('string', [pattern('^ghp_.+')]),
          description: 'Personal access token' },
        { name: 'org', type: str(), description: 'Organization (e.g. console-one)' },
        { name: 'repo', type: str(), description: 'Repository name' },
      ],
    });
    expect(s.get('_blueprints.github.description')).toBe('Configure a GitHub connection');
    expect(s.get('_blueprints.github.gap_names')).toEqual(['apiKey', 'org', 'repo']);
    // Gaps are type-only cells.
    expect(s.typeAt('_blueprints.github.gaps.apiKey')?.kind).toBe('string');
    expect(s.get('_blueprints.github.gaps.apiKey')).toBeUndefined();
    // complete = false initially.
    expect(s.get('_blueprints.github.complete')).toBe(false);
  });

  it('filling a gap re-derives complete', () => {
    const s = new Sequence();
    installBlueprint(s, 'github', {
      description: 'GitHub',
      gaps: [
        { name: 'apiKey', type: str() },
        { name: 'org', type: str() },
      ],
    });
    expect(s.get('_blueprints.github.complete')).toBe(false);
    s.insert({ path: '_blueprints.github.gaps.apiKey', value: 'ghp_xxx' });
    expect(s.get('_blueprints.github.complete')).toBe(false);
    s.insert({ path: '_blueprints.github.gaps.org', value: 'console-one' });
    expect(s.get('_blueprints.github.complete')).toBe(true);
  });
});

describe('Gaps reader — form-renderable projection', () => {
  it('emits structured gap entries with kind + description + filled state', () => {
    const s = new Sequence();
    installBlueprint(s, 'github', {
      description: 'GitHub',
      gaps: [
        { name: 'apiKey', type: createType('string', [pattern('^ghp_.+')]),
          description: 'Personal access token',
          reuseFrom: 'const.github_token' },
        { name: 'org', type: str(), description: 'Organization' },
        { name: 'port', type: createType('number', [min(1), max(65535)]),
          description: 'HTTP port' },
      ],
    });
    installBlueprintGapsReader(s, 'github_form', 'github');

    const gaps = s.get('_readers.github_form.gaps') as GapEntry[];
    expect(Array.isArray(gaps)).toBe(true);
    expect(gaps).toHaveLength(3);

    const apiKey = gaps.find(g => g.name === 'apiKey')!;
    expect(apiKey.kind).toBe('string');
    expect(apiKey.description).toBe('Personal access token');
    expect(apiKey.filled).toBe(false);
    expect(apiKey.pattern).toBe('^ghp_.+');
    expect(apiKey.reuseFrom).toBe('const.github_token');

    const port = gaps.find(g => g.name === 'port')!;
    expect(port.kind).toBe('number');
    expect(port.range).toEqual({ min: 1, max: 65535 });

    const org = gaps.find(g => g.name === 'org')!;
    expect(org.kind).toBe('string');
    expect(org.description).toBe('Organization');
    expect(org.pattern).toBeUndefined();
  });

  it('object-kind gap exposes nested property shape for nested forms', () => {
    const s = new Sequence();
    installBlueprint(s, 'api', {
      description: 'API',
      gaps: [{
        name: 'headers',
        type: createType('object', [
          property('Authorization', str(), false),
          property('X-Trace-Id', str(), true),
        ]),
        description: 'HTTP headers',
      }],
    });
    installBlueprintGapsReader(s, 'api_form', 'api');
    const gaps = s.get('_readers.api_form.gaps') as GapEntry[];
    const headers = gaps[0];
    expect(headers.kind).toBe('object');
    expect(headers.properties).toEqual([
      { name: 'Authorization', kind: 'string', optional: false },
      { name: 'X-Trace-Id', kind: 'string', optional: true },
    ]);
  });

  it('filling a gap re-derives the reader — filled flag flips + currentValue surfaces', () => {
    const s = new Sequence();
    installBlueprint(s, 'github', {
      description: 'GitHub',
      gaps: [
        { name: 'apiKey', type: str() },
        { name: 'org', type: str() },
      ],
    });
    installBlueprintGapsReader(s, 'github_form', 'github');

    let gaps = s.get('_readers.github_form.gaps') as GapEntry[];
    expect(gaps.every(g => !g.filled)).toBe(true);

    s.insert({ path: '_blueprints.github.gaps.apiKey', value: 'ghp_secret' });

    gaps = s.get('_readers.github_form.gaps') as GapEntry[];
    const apiKey = gaps.find(g => g.name === 'apiKey')!;
    expect(apiKey.filled).toBe(true);
    expect(apiKey.currentValue).toBe('ghp_secret');
    expect(gaps.find(g => g.name === 'org')!.filled).toBe(false);
  });
});

describe('Kit — narrative ordering over a blueprint', () => {
  it('current_gap tracks the first unfilled gap in declared order', () => {
    const s = new Sequence();
    installBlueprint(s, 'github', {
      description: 'GitHub',
      gaps: [
        { name: 'apiKey', type: str() },
        { name: 'org', type: str() },
        { name: 'repo', type: str() },
      ],
    });
    installKit(s, 'github_onboarding', {
      blueprintId: 'github',
      order: ['org', 'repo', 'apiKey'],   // org first, then repo, then secret
      description: 'Guided GitHub setup — ask for public info first',
    });

    expect(s.get('_kits.github_onboarding.current_gap')).toBe('org');
    s.insert({ path: '_blueprints.github.gaps.org', value: 'console-one' });
    expect(s.get('_kits.github_onboarding.current_gap')).toBe('repo');
    s.insert({ path: '_blueprints.github.gaps.repo', value: 'lens-desktop' });
    expect(s.get('_kits.github_onboarding.current_gap')).toBe('apiKey');
    s.insert({ path: '_blueprints.github.gaps.apiKey', value: 'ghp_xxx' });
    expect(s.get('_kits.github_onboarding.current_gap')).toBeNull();
  });

  it('progress derives { filled, total } from gap cells', () => {
    const s = new Sequence();
    installBlueprint(s, 'github', {
      description: 'GitHub',
      gaps: [
        { name: 'apiKey', type: str() },
        { name: 'org', type: str() },
      ],
    });
    installKit(s, 'github_kit', {
      blueprintId: 'github',
      order: ['org', 'apiKey'],
    });
    expect(s.get('_kits.github_kit.progress')).toEqual({ filled: 0, total: 2 });
    s.insert({ path: '_blueprints.github.gaps.org', value: 'console-one' });
    expect(s.get('_kits.github_kit.progress')).toEqual({ filled: 1, total: 2 });
    s.insert({ path: '_blueprints.github.gaps.apiKey', value: 'ghp_xxx' });
    expect(s.get('_kits.github_kit.progress')).toEqual({ filled: 2, total: 2 });
  });

  it('two kits on one blueprint track independent orderings', () => {
    const s = new Sequence();
    installBlueprint(s, 'github', {
      description: 'GitHub',
      gaps: [
        { name: 'apiKey', type: str() },
        { name: 'org', type: str() },
      ],
    });
    installKit(s, 'secret_first', {
      blueprintId: 'github',
      order: ['apiKey', 'org'],
    });
    installKit(s, 'public_first', {
      blueprintId: 'github',
      order: ['org', 'apiKey'],
    });
    expect(s.get('_kits.secret_first.current_gap')).toBe('apiKey');
    expect(s.get('_kits.public_first.current_gap')).toBe('org');
    s.insert({ path: '_blueprints.github.gaps.apiKey', value: 'ghp_xxx' });
    expect(s.get('_kits.secret_first.current_gap')).toBe('org');
    expect(s.get('_kits.public_first.current_gap')).toBe('org');
  });
});

describe('End-to-end — UI fills blueprint through gaps reader', () => {
  it('simulates a three-step form: user reads next gap, submits value, repeats', () => {
    const s = new Sequence();
    installBlueprint(s, 'github', {
      description: 'GitHub',
      gaps: [
        { name: 'apiKey', type: str(), description: 'Personal access token' },
        { name: 'org', type: str(), description: 'Organization' },
        { name: 'repo', type: str(), description: 'Repository' },
      ],
    });
    installBlueprintGapsReader(s, 'github_form', 'github');
    installKit(s, 'guided', {
      blueprintId: 'github',
      order: ['org', 'repo', 'apiKey'],
    });

    // Simulated UI loop: read current_gap, render form for it, user submits, repeat.
    const userProvides: Record<string, string> = {
      org: 'console-one',
      repo: 'lens-desktop',
      apiKey: 'ghp_xxxxxxxxxxxx',
    };

    while (true) {
      const currentName = s.get('_kits.guided.current_gap');
      if (currentName === null) break;
      const gaps = s.get('_readers.github_form.gaps') as GapEntry[];
      const current = gaps.find(g => g.name === currentName)!;
      expect(current.filled).toBe(false);
      // UI would render the form per current.kind + description.
      // Simulate user submission:
      s.insert({ path: current.path, value: userProvides[currentName as string] });
    }

    expect(s.get('_blueprints.github.complete')).toBe(true);
    expect(s.get('_kits.guided.progress')).toEqual({ filled: 3, total: 3 });
    expect(s.get('_blueprints.github.gaps.apiKey')).toBe('ghp_xxxxxxxxxxxx');
  });
});

describe('Blueprint output — completion mounts the fn-kind tool cell', () => {
  it('tool cell does not exist before blueprint completes', () => {
    const s = new Sequence();
    installCommitment(s);
    installBlueprint(s, 'github', {
      description: 'GitHub',
      gaps: [
        { name: 'apiKey', type: str() },
        { name: 'org', type: str() },
      ],
    });
    installBlueprintOutput(s, 'github', {
      toolPath: 'tools.github.fetch_pulls',
      inputType: createType('object', [property('state', str(), true)]),
      outputType: createType('array'),
      impl: async () => [],
    });
    // No tool cell type mounted yet.
    expect(s.typeAt('tools.github.fetch_pulls')).toBeUndefined();
  });

  it('tool cell materializes when the last gap is filled', () => {
    const s = new Sequence();
    installCommitment(s);
    installBlueprint(s, 'github', {
      description: 'GitHub',
      gaps: [
        { name: 'apiKey', type: str() },
        { name: 'org', type: str() },
      ],
    });
    installBlueprintOutput(s, 'github', {
      toolPath: 'tools.github.fetch_pulls',
      description: 'List pull requests',
      source: { id: 'github', displayName: 'github' },
      inputType: createType('object', [property('state', str(), true)]),
      outputType: createType('array'),
      impl: async () => [],
    });
    s.insert({ path: '_blueprints.github.gaps.apiKey', value: 'ghp_xxx' });
    expect(s.typeAt('tools.github.fetch_pulls')).toBeUndefined();
    s.insert({ path: '_blueprints.github.gaps.org', value: 'console-one' });
    // Reading complete triggers its auto-expand; the observation rule
    // on `complete` fires during the derive cascade and mounts the
    // tool.
    expect(s.get('_blueprints.github.complete')).toBe(true);
    const toolType = s.typeAt('tools.github.fetch_pulls');
    expect(toolType?.kind).toBe('fn');
    expect(s.get('tools.github.fetch_pulls._description')).toBe('List pull requests');
    expect(s.get('tools.github.fetch_pulls._source.id')).toBe('github');
  });

  it('invoking the materialized tool runs the impl with current gap values', async () => {
    const s = new Sequence();
    installCommitment(s);
    installBlueprint(s, 'github', {
      description: 'GitHub',
      gaps: [
        { name: 'apiKey', type: str() },
        { name: 'org', type: str() },
        { name: 'repo', type: str() },
      ],
    });
    installBlueprintOutput(s, 'github', {
      toolPath: 'tools.github.fetch_pulls',
      inputType: createType('object', [property('state', str(), true)]),
      outputType: createType('object', [
        property('url', str()),
        property('auth', str()),
        property('state', str()),
      ]),
      impl: async (input: any, gaps) => ({
        url: `https://api.github.com/repos/${gaps.org}/${gaps.repo}/pulls`,
        auth: `token ${gaps.apiKey}`,
        state: input?.state ?? 'open',
      }),
    });
    s.insert({ path: '_blueprints.github.gaps.apiKey', value: 'ghp_aaa' });
    s.insert({ path: '_blueprints.github.gaps.org', value: 'console-one' });
    s.insert({ path: '_blueprints.github.gaps.repo', value: 'lens-desktop' });
    // Force the derive cascade so the tool mounts.
    expect(s.get('_blueprints.github.complete')).toBe(true);
    expect(s.typeAt('tools.github.fetch_pulls')?.kind).toBe('fn');

    // Invoke: write input at the tool path → commitment elects →
    // impl runs closure over gaps → result lands at toolPath.result.
    s.insert({
      path: 'tools.github.fetch_pulls',
      value: { state: 'closed' },
    });
    await flushPending(s);
    expect(s.get('tools.github.fetch_pulls.result')).toEqual({
      url: 'https://api.github.com/repos/console-one/lens-desktop/pulls',
      auth: 'token ghp_aaa',
      state: 'closed',
    });
  });

  it('gap edits after mount are visible to subsequent tool invocations', async () => {
    const s = new Sequence();
    installCommitment(s);
    installBlueprint(s, 'svc', {
      description: 'Service',
      gaps: [{ name: 'apiKey', type: str() }],
    });
    installBlueprintOutput(s, 'svc', {
      toolPath: 'tools.svc.call',
      inputType: createType('object'),
      outputType: createType('object', [property('auth', str())]),
      impl: (_input, gaps) => ({ auth: `Bearer ${gaps.apiKey}` }),
    });
    s.insert({ path: '_blueprints.svc.gaps.apiKey', value: 'v1' });
    expect(s.get('_blueprints.svc.complete')).toBe(true);

    s.insert({ path: 'tools.svc.call', value: {} });
    await flushPending(s);
    expect(s.get('tools.svc.call.result')).toEqual({ auth: 'Bearer v1' });

    // Rotate the key — gap write re-bumps blueprint version but the
    // tool cell was already mounted; impl closure reads the fresh value.
    s.insert({ path: '_blueprints.svc.gaps.apiKey', value: 'v2' });
    s.insert({ path: 'tools.svc.call', value: {} });
    await flushPending(s);
    expect(s.get('tools.svc.call.result')).toEqual({ auth: 'Bearer v2' });
  });

  it('materialized tool appears in AGENT_PROMPT_FRAME section 1.2', () => {
    const s = new Sequence();
    installCommitment(s);
    installAgentPrompt(s);
    installBlueprint(s, 'github', {
      description: 'GitHub',
      gaps: [{ name: 'apiKey', type: str() }, { name: 'org', type: str() }],
    });
    installBlueprintOutput(s, 'github', {
      toolPath: 'tools.github.fetch_pulls',
      description: 'List pull requests',
      source: { id: 'github', displayName: 'github' },
      inputType: createType('object', [property('state', str(), true)]),
      outputType: createType('array'),
      impl: async () => [],
    });

    // Before completion: 1.2 renders no github group.
    let tools = s.get('_prompt.sections.1_2') as string;
    expect(tools).not.toMatch(/^github\s*=\s*\{/m);

    // Complete the blueprint.
    s.insert({ path: '_blueprints.github.gaps.apiKey', value: 'ghp_xxx' });
    s.insert({ path: '_blueprints.github.gaps.org', value: 'console-one' });
    expect(s.get('_blueprints.github.complete')).toBe(true);

    // After completion: 1.2 picks up the newly-mounted tool.
    tools = s.get('_prompt.sections.1_2') as string;
    expect(tools).toMatch(/^github\s*=\s*\{/m);
    expect(tools).toContain('fetch_pulls');
  });
});
