/**
 * procedure.test.ts — planProcedure: the standalone pure evaluator for
 * procedures-as-declared-data (DSL PROGRAM seam 4).
 *
 * The reference manifest mirrors the observatory-publisher shape (the
 * first real consumer): conditional source-topic creation, derived
 * naming, unit-scaled params, an optional secret routed only to
 * storeSecret.
 */

import {
  planProcedure,
  procedureGaps,
  planProcessorConfig,
  type ProcedureManifest,
} from '../procedure';
import { createType } from '../../src/type';

const str = () => createType('string');
const num = () => createType('number');
const bool = () => createType('boolean');

const publisherish: ProcedureManifest = {
  id: 'pub',
  version: '1.0.0',
  title: 'Publisher',
  params: [
    { name: 'root', type: str(), default: '~/x' },
    { name: 'instanceName', type: str(), optional: true },
    { name: 'existingSource', type: str(), optional: true },
    { name: 'directive', type: str() }, // REQUIRED — the gap case
    { name: 'idleMinutes', type: num(), default: 10, scale: 60_000 },
    { name: 'callBudget', type: num(), default: 50.4, round: true },
    { name: 'backfill', type: bool(), default: true },
    { name: 'token', type: str(), optional: true, secret: true },
  ],
  derived: [
    {
      name: 'rawName',
      value: { coalesce: [{ param: 'instanceName' }, { lit: 'claude-jsonl' }] },
    },
    {
      name: 'rawTopic',
      value: {
        coalesce: [
          { param: 'existingSource' },
          { join: [{ lit: 'raw/' }, { param: 'rawName' }] },
        ],
      },
    },
    {
      name: 'narrativeTopic',
      value: {
        join: [
          { lit: 'narratives/' },
          { stripPrefix: [{ param: 'rawTopic' }, 'raw/'] },
        ],
      },
    },
  ],
  steps: [
    {
      when: { absent: 'existingSource' },
      createTopic: {
        topicID: { param: 'rawTopic' },
        topicKind: 'claude-jsonl',
        renderMode: 'feed',
        title: { join: [{ lit: 'Raw — ' }, { param: 'rawName' }] },
        tags: ['raw'],
      },
    },
    {
      when: { absent: 'existingSource' },
      declareProcessor: {
        name: 'watcher',
        processKind: 'claude-transcript-watcher',
        attachTo: { param: 'rawTopic' },
        config: {
          root: { param: 'root' },
          backfill: { param: 'backfill' },
          idleFinalizeMs: { param: 'idleMinutes' },
        },
      },
    },
    {
      createTopic: {
        topicID: { param: 'narrativeTopic' },
        topicKind: 'narrative',
        renderMode: 'feed',
      },
    },
    {
      declareProcessor: {
        name: 'summarizer',
        processKind: 'summarizer',
        attachTo: { param: 'narrativeTopic' },
        config: {
          sourceTopic: { param: 'rawTopic' },
          directive: { param: 'directive' },
          callBudget: { param: 'callBudget' },
          fixed: 'literal-passthrough',
        },
      },
    },
    {
      when: { present: 'token' },
      storeSecret: { key: { lit: 'claude.oauthToken' }, fromParam: 'token' },
    },
  ],
};

describe('planProcedure — gaps, defaults, derivations, guards', () => {
  it('reports required params as gaps (not a throw)', () => {
    const r = planProcedure(publisherish, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.gaps.map((g) => g.name)).toEqual(['directive']);
      expect(r.gaps[0].kind).toBe('string');
    }
    expect(procedureGaps(publisherish, {}).map((g) => g.name)).toEqual([
      'directive',
    ]);
    expect(procedureGaps(publisherish, { directive: 'd' })).toEqual([]);
  });

  it('plans the fresh-source path: defaults, scaling, derived names, deterministic refs', () => {
    const r = planProcedure(publisherish, { directive: 'summarize' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [t1, p1, t2, p2, ...rest] = r.facts;
    expect(rest).toEqual([]); // no token → no writeSecret
    expect(t1).toMatchObject({
      kind: 'createTopic',
      topicID: 'raw/claude-jsonl',
      title: 'Raw — claude-jsonl',
    });
    expect(p1).toMatchObject({
      kind: 'registerProcess',
      name: 'watcher',
      processRef: 'process:claude-transcript-watcher:watcher',
      attachTo: 'raw/claude-jsonl',
      config: { root: '~/x', backfill: true, idleFinalizeMs: 600_000 },
    });
    expect(t2).toMatchObject({ kind: 'createTopic', topicID: 'narratives/claude-jsonl' });
    expect(p2).toMatchObject({
      kind: 'registerProcess',
      name: 'summarizer',
      config: {
        sourceTopic: 'raw/claude-jsonl',
        directive: 'summarize',
        callBudget: 50, // rounded
        fixed: 'literal-passthrough',
      },
    });
  });

  it('existing source skips watcher steps; instanceName renames; secret routes to writeSecret only', () => {
    const r = planProcedure(publisherish, {
      directive: 'd',
      existingSource: 'raw/team',
      token: 'sk-secret',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts.map((f) => f.kind)).toEqual([
      'createTopic',
      'registerProcess',
      'writeSecret',
    ]);
    expect(r.facts[0]).toMatchObject({ topicID: 'narratives/team' });
    expect(r.facts[2]).toMatchObject({
      kind: 'writeSecret',
      key: 'claude.oauthToken',
      value: 'sk-secret',
    });
    // The secret value appears NOWHERE except the writeSecret fact.
    const nonSecret = JSON.stringify(r.facts.slice(0, 2));
    expect(nonSecret.includes('sk-secret')).toBe(false);

    const named = planProcedure(publisherish, { directive: 'd', instanceName: 'proj' });
    expect(named.ok).toBe(true);
    if (named.ok) {
      expect(named.facts[0]).toMatchObject({ topicID: 'raw/proj' });
      expect(named.facts[2]).toMatchObject({ topicID: 'narratives/proj' });
    }
  });

  it('type validation is the real check(): wrong kinds throw named', () => {
    expect(() =>
      planProcedure(publisherish, { directive: 'd', idleMinutes: 'ten' }),
    ).toThrow(/param 'idleMinutes' invalid/);
  });

  it('a manifest leaking a secret param outside storeSecret fails loud', () => {
    const leaky: ProcedureManifest = {
      id: 'leak',
      version: '0',
      title: 'L',
      params: [{ name: 'tok', type: str(), secret: true }],
      steps: [
        {
          declareProcessor: {
            name: 'p',
            processKind: 'k',
            attachTo: { lit: 't' },
            config: { auth: { param: 'tok' } },
          },
        },
      ],
    };
    expect(() => planProcedure(leaky, { tok: 'v' })).toThrow(/leaks secret/);
  });

  it('unknown value combinators and unknown names fail loud (total vocabulary)', () => {
    const bad: ProcedureManifest = {
      id: 'bad',
      version: '0',
      title: 'B',
      params: [],
      steps: [
        {
          createTopic: {
            topicID: { param: 'nope' },
            topicKind: 'k',
          },
        },
      ],
    };
    expect(() => planProcedure(bad, {})).toThrow(/unknown name 'nope'/);
  });

  it('planProcessorConfig re-derives one step config for the edit pane; guarded-off returns null', () => {
    const cfg = planProcessorConfig(publisherish, 'summarizer', {
      directive: 'new directive',
      callBudget: 20,
    });
    expect(cfg).toMatchObject({ directive: 'new directive', callBudget: 20 });
    // watcher is guarded off when existingSource is present
    const off = planProcessorConfig(publisherish, 'watcher', {
      directive: 'd',
      existingSource: 'raw/team',
    });
    expect(off).toBeNull();
  });

  it('the manifest round-trips through JSON (serializable vocabulary — the index topic carries it)', () => {
    const cloned = JSON.parse(JSON.stringify(publisherish)) as ProcedureManifest;
    const a = planProcedure(cloned, { directive: 'd' });
    const b = planProcedure(publisherish, { directive: 'd' });
    expect(a).toEqual(b);
  });
});
