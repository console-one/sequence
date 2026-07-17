/**
 * tools-agent-v2.test.ts — deletion-ledger stage 2: the base tools and
 * the agent loop run on v2.
 *
 * http.fetch is tested against a REAL local http server (no stubbed
 * transport); fs.* against a real Map-backed storage (storage is the
 * injected contract, not a fake of the tool); the agent loop against a
 * SCRIPTED LLM — exactly how the March build tested its loop; the
 * real-LLM run is the office-side demo and is claimed nowhere here.
 */

import http from 'node:http';
import { Sequence } from '../../src-v2/sequence';
import { registerBaseTools, type ToolStorage } from '../../src-v2/tools';
import { agentLoop, type LLMCall } from '../../src-v2/agent-loop';
import { receiveCalls } from '../../src-v2/receive-calls';
import { hoistCatalog } from '../hoist';

function memStorage(): ToolStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async read(k) { const v = data.get(k); if (v === undefined) throw new Error(`no key ${k}`); return v; },
    async write(k, c) { data.set(k, c); return c.length; },
    async exists(k) { return data.has(k); },
    async list(p) { return [...data.keys()].filter((k) => k.startsWith(p)); },
    async append(k, c) { data.set(k, (data.get(k) ?? '') + c); return c.length; },
  };
}

describe('v2 base tools', () => {
  test('http.fetch hits a real local server through the ft language', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`hello ${req.method} ${req.url}`);
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const seq = new Sequence();
      registerBaseTools(seq);
      const r = await receiveCalls(seq, `res = http.fetch({ url: "http://127.0.0.1:${port}/ping" })`);
      expect(r.errors).toEqual([]);
      const res = seq.get('res') as { status: number; body: string };
      expect(res.status).toBe(200);
      expect(res.body).toBe('hello GET /ping');
    } finally {
      server.close();
    }
  });

  test('fs.* round-trips through the injected storage', async () => {
    const seq = new Sequence();
    const storage = memStorage();
    registerBaseTools(seq, { storage });
    const r = await receiveCalls(seq, [
      'w = fs.write({ key: "notes/a", content: "alpha" })',
      'e = fs.exists({ key: "notes/a" })',
      'l = fs.list({ prefix: "notes/" })',
      'c = fs.read({ key: "notes/a" })',
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('e')).toEqual({ exists: true });
    expect(seq.get('l')).toEqual({ keys: ['notes/a'] });
    expect(seq.get('c')).toEqual({ content: 'alpha' });
  });

  test('schedule.at binds a pending deadline fact', async () => {
    const seq = new Sequence();
    registerBaseTools(seq);
    const r = await receiveCalls(seq, 's = schedule.at({ deadline: 1234567 })');
    expect(r.errors).toEqual([]);
    const id = (seq.get('s') as { id: string }).id;
    expect(seq.get(`_schedule.pending.${id}.deadline`)).toBe(1234567);
    expect(seq.get(`_schedule.pending.${id}.status`)).toBe('pending');
  });

  test('the tools are typed names — they render in the catalog frame', () => {
    const seq = new Sequence();
    registerBaseTools(seq, { storage: memStorage() });
    const frame = hoistCatalog(seq).text;
    expect(frame).toContain('http = {');
    // The long input correctly hoists to a named type…
    expect(frame).toContain('type HttpFetchInput = { url: string, method?: string');
    expect(frame).toMatch(/fetch HttpFetchInput/);
    // …and read/exists correctly SHARE their identical {key} shape.
    expect(frame).toContain('fs = {');
    expect(frame).toMatch(/read FsExistsInput/);
    expect(frame).toMatch(/at \{ deadline: number \}/);
  });
});

describe('v2 agent loop (scripted LLM — the March test shape)', () => {
  test('the model reads the frame, operates tools across turns, converges', async () => {
    const seq = new Sequence();
    registerBaseTools(seq, { storage: memStorage() });
    const prompts: string[] = [];
    const script = [
      'w = fs.write({ key: "plan/step1", content: "gathered" })',
      'r = fs.read({ key: "plan/step1" })',
      'done',
    ];
    let i = 0;
    const llm: LLMCall = async (_id, input) => {
      prompts.push(input.messages[1].content);
      return { ok: true, response: script[Math.min(i++, script.length - 1)] };
    };
    const result = await agentLoop(seq, llm, { maxTurns: 5 });
    expect(result.ended).toBe('converged');
    expect(result.turns).toHaveLength(3);
    expect(seq.get('r')).toEqual({ content: 'gathered' });
    // The prompt the model saw was the hoisted catalog, not a JSON dump.
    expect(prompts[0]).toContain('fs = {');
    // Turn 2's prompt shows turn 1's bound state (the loop is stateful):
    // the `w = {bytes}` bind from turn 1 renders in turn 2's state text.
    expect(prompts[1]).toMatch(/w = /);
  });

  test('errors re-inject and the model can correct', async () => {
    const seq = new Sequence();
    registerBaseTools(seq, { storage: memStorage() });
    const script = [
      'x = fs.read({ key: "missing" })',
      'y = fs.write({ key: "missing", content: "now present" })',
      'done',
    ];
    let i = 0;
    const seen: string[] = [];
    const llm: LLMCall = async (_id, input) => {
      seen.push(input.messages[1].content);
      return { ok: true, response: script[Math.min(i++, script.length - 1)] };
    };
    const result = await agentLoop(seq, llm, { maxTurns: 5 });
    expect(result.ended).toBe('converged');
    expect(result.turns[0].errors[0]).toContain('no key missing');
    // The correction prompt carried the error back to the model.
    expect(seen[1]).toContain('no key missing');
    expect(seq.get('y')).toEqual({ bytes: 11 });
  });
});
