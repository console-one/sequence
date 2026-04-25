/**
 * agent-prompt.test.ts — AGENT_PROMPT_FRAME from a v2 Sequence, entirely
 * as type state. No TS API produces the text — the consumer reads
 * `seq.get('_prompt.agent')` and the derive chain computes it.
 *
 * Every section is an addressable cell. Overrides, renderer replacements,
 * and analysis all happen by writing to / reading from paths on seq.
 */

import { Sequence } from '../sequence';
import {
  createType, property, param, returns, element,
  identity, preserves, temporal, add,
} from '../../src/type';
import {
  installAgentPrompt, installTool,
} from '../stdlib';

const str = () => createType('string');
const num = () => createType('number');

function obj(props: Array<[string, ReturnType<typeof str>, boolean?]>) {
  return createType('object', props.map(([k, t, opt]) => property(k, t, !!opt)));
}

function arrOf(t: ReturnType<typeof str>) {
  return createType('array', [element(t)]);
}

function makeSeqWithTools(): Sequence {
  const s = new Sequence();
  installAgentPrompt(s);

  // Shared domain types used by multiple tools so the hoister dedups them.
  const PullRequest = obj([
    ['id', str()], ['title', str()], ['state', str()],
    ['author', str()], ['created_at', str()],
  ]);
  const Issue = obj([
    ['id', str()], ['title', str()], ['state', str()], ['labels', arrOf(str())],
  ]);
  const FetchInput = obj([
    ['owner', str()], ['repo', str()], ['state', str(), true],
  ]);

  installTool(s, 'github.fetch_pull_requests', {
    description: 'List pull requests on a repository.',
    inputType: FetchInput,
    outputType: arrOf(PullRequest),
    impl: async () => [],
    source: { id: 'github', displayName: 'github' },
    claims: [
      preserves('owner', 'owner'),
      identity('repo', 'repo'),
      temporal('gt', '_rt', add('_rt.input', 200)),
      temporal('lt', '_rt', add('_rt.input', 60_000)),
    ],
  });

  installTool(s, 'github.fetch_issues', {
    description: 'List issues on a repository.',
    inputType: FetchInput,
    outputType: arrOf(Issue),
    impl: async () => [],
    source: { id: 'github', displayName: 'github' },
    claims: [
      identity('repo', 'repo'),
      temporal('gt', '_rt', add('_rt.input', 180)),
    ],
  });

  const Task = obj([
    ['id', str()], ['title', str()], ['status', str()], ['priority', str()],
  ]);
  const BoardQuery = obj([['board', str()]]);
  const CreateInput = obj([
    ['board', str()], ['title', str()], ['description', str(), true],
  ]);

  installTool(s, 'jira.fetch_tasks', {
    description: 'List Jira tasks on a board.',
    inputType: BoardQuery,
    outputType: arrOf(Task),
    impl: async () => [],
    source: { id: 'jira', displayName: 'jira' },
    claims: [
      identity('board', 'board'),
      temporal('gt', '_rt', add('_rt.input', 400)),
    ],
  });

  installTool(s, 'jira.create_task', {
    description: 'Create a new Jira task.',
    inputType: CreateInput,
    outputType: Task,
    impl: async () => ({} as any),
    source: { id: 'jira', displayName: 'jira' },
    claims: [
      identity('title', 'title'),
      temporal('gt', '_rt', add('_rt.input', 600)),
    ],
  });

  // Agent identity state. Each write re-derives the prompt.
  s.insert({ path: '_agent.id', value: 'agent-demo' });
  s.insert({ path: '_agent.moment', value: 4 });
  s.insert({ path: '_agent.model', value: 'CLAUDE 4.x INFERENCE' });
  s.insert({ path: '_agent.locks', value: [
    '  LOCAL_WORKSPACE/processes/chat/HEAD  from (14:30 - 14:45)  (version: v-3)',
    '  LOCAL_WORKSPACE/agents/agent-demo/HEAD  from (14:00 - 14:45)  (version: v-7)',
  ].join('\n') });
  s.insert({ path: '_agent.tasks', value: [
    '  task-1.1: Fetch open PRs for console-one/lens-desktop, summarize blockers',
    '  task-1.2: Create Jira tickets for issues blocking release (deadline: 2d)',
  ].join('\n') });

  return s;
}

describe('AGENT_PROMPT_FRAME is type state on a v2 Sequence', () => {
  it('seq.get("_prompt.agent") returns the full rendered frame', () => {
    const s = makeSeqWithTools();
    const prompt = s.get('_prompt.agent') as string;
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(500);
    expect(prompt).toMatch(/^-- 1\.0: WELCOME BACK agent-demo \(to your 4th MOMENT\)/m);
    expect(prompt).toMatch(/^-- 1\.1: agent-demo's VALUES$/m);
    expect(prompt).toMatch(/^-- 1\.2: TYPES AND TOOLS AND TASKS$/m);
    expect(prompt).toMatch(/^-- 1\.3: TASKS$/m);
    expect(prompt).toMatch(/^-- 1\.4: RESPONSE$/m);
  });

  it('sections are individually addressable cells', () => {
    const s = makeSeqWithTools();
    expect(s.get('_prompt.sections.1_0')).toMatch(/WELCOME BACK agent-demo/);
    expect(s.get('_prompt.sections.1_1')).toMatch(/agent-demo's VALUES/);
    expect(s.get('_prompt.sections.1_2')).toMatch(/TYPES AND TOOLS AND TASKS/);
    expect(s.get('_prompt.sections.1_3')).toMatch(/task-1\.1: Fetch open PRs/);
    expect(s.get('_prompt.sections.1_4')).toMatch(/RESPONSE/);
  });

  it('tools section hoists shared object types globally', () => {
    const s = makeSeqWithTools();
    s.insert({ path: '_agent.focus', value: ['github'] });
    const tools = s.get('_prompt.sections.1_2') as string;
    // Hoisted preamble.
    expect(tools).toContain('HOISTED TYPE PREAMBLE');
    expect(tools).toMatch(/^type T\d+ = \{/m);
    // Tool signatures reference hoisted names.
    expect(tools).toMatch(/=> \[\.\.\.T\d+\]/);
    // Group wrapper (no [id] redundancy).
    expect(tools).toMatch(/^github = \{/m);
    // Tool descriptions appear when focused.
    expect(tools).toContain('// List pull requests on a repository.');
  });

  it('claims on fn types render as pipe-delimited suffix lines', () => {
    const s = makeSeqWithTools();
    s.insert({ path: '_agent.focus', value: ['github'] });
    const tools = s.get('_prompt.sections.1_2') as string;
    // identity('repo','repo') → `output.repo ≡ input.repo`
    expect(tools).toMatch(/\|\s*output\.repo ≡ input\.repo/);
    // preserves('owner','owner')
    expect(tools).toMatch(/\|\s*preserves\(input\.owner\)/);
    // temporal('gt','_rt',{add:['_rt.input',200]})
    expect(tools).toMatch(/\|\s*_rt > _rt\.input \+ 200ms/);
    // temporal('lt','_rt',{add:['_rt.input',60000]})
    expect(tools).toMatch(/\|\s*_rt < _rt\.input \+ 60000ms/);
  });

  it('writing _agent.focus re-derives the prompt', () => {
    const s = makeSeqWithTools();
    const before = s.get('_prompt.agent') as string;
    expect(before).toMatch(/\[\[ 2 tools compressed — focus\({name:"jira"}\)/);
    s.insert({ path: '_agent.focus', value: ['jira'] });
    const after = s.get('_prompt.agent') as string;
    expect(after).toMatch(/jira — jira: fetch_tasks, create_task \(2 tools, descriptions on\)/);
    // github now compressed instead.
    expect(after).toMatch(/\[\[ 2 tools compressed — focus\({name:"github"}\)/);
  });

  it('writing _agent.dismissed removes a group from the prompt', () => {
    const s = makeSeqWithTools();
    s.insert({ path: '_agent.dismissed', value: ['jira'] });
    const prompt = s.get('_prompt.agent') as string;
    expect(prompt).not.toMatch(/^jira = \{/m);
    expect(prompt).toMatch(/^github = \{/m);
  });

  it('installing another tool invalidates + re-derives the tools section', () => {
    const s = makeSeqWithTools();
    const v1 = s.get('_prompt.registry.tools_version') as number;
    installTool(s, 'github.search_code', {
      description: 'Search GitHub code.',
      inputType: obj([['q', str()], ['limit', num(), true]]),
      outputType: obj([['matches', arrOf(obj([['path', str()], ['line', num()]]))]]),
      impl: async () => ({ matches: [] }),
      source: { id: 'github', displayName: 'github' },
    });
    const v2 = s.get('_prompt.registry.tools_version') as number;
    expect(v2).toBe(v1 + 1);
    s.insert({ path: '_agent.focus', value: ['github'] });
    const tools = s.get('_prompt.sections.1_2') as string;
    expect(tools).toContain('search_code');
    expect(tools).toMatch(/github .+ \(3 tools/);
  });

  it('section renderers are replaceable by swapping seq.impls', () => {
    const s = makeSeqWithTools();
    const stock = s.get('_prompt.sections.1_1') as string;
    expect(stock).toContain("agent-demo's VALUES");
    s.impls.set('_prompt.kernel.render_1_1',
      (agentId: string, _values: string) => `-- 1.1: ${agentId}'s CUSTOM VALUES\n\nWhatever I want.`);
    // Bump boot_version so the section re-derives (dep not directly tied to the
    // impl, so we trigger via a known dep).
    s.insert({ path: '_agent.values', value: 'new values text' });
    const customized = s.get('_prompt.sections.1_1') as string;
    expect(customized).toContain("agent-demo's CUSTOM VALUES");
  });

  it('FULL PROMPT SMOKE — prints the rendered frame', () => {
    const s = makeSeqWithTools();
    s.insert({ path: '_agent.focus', value: ['github'] });
    const prompt = s.get('_prompt.agent') as string;
    // eslint-disable-next-line no-console
    console.log('\n══════════════ AGENT_PROMPT_FRAME from v2 Sequence ══════════════\n');
    // eslint-disable-next-line no-console
    console.log(prompt);
    // eslint-disable-next-line no-console
    console.log('\n═════════════════════════════════════════════════════════════════\n');
    expect(prompt).toContain('-- 1.0');
    expect(prompt).toContain('-- 1.4');
  });
});
