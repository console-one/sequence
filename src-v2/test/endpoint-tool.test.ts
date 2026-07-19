/**
 * endpoint-tool.test.ts — the generic executor for endpoint()-qualified
 * fn types.
 *
 * The type IS the connector: address + HTTP shape + credential path
 * ride the constraints; installEndpointTool derives the impl from them.
 * http.fetch and auth.resolve are mocked to pin the fill / omission /
 * secret-confinement contract the office connector build proved live
 * (and which this executor replaces).
 */

import { Sequence } from '../sequence';
import { installEndpointTool } from '../tools';
import { createType, param, endpoint, auth, property } from '../../src/type';
import { FT } from '../../src/builder';

type FetchCall = { url: string; method?: string; headers?: Record<string, string>; body?: string };

/** A Sequence with a recording http.fetch mock. */
function harness(response: { status: number; body: string } = { status: 200, body: '{"ok":true}' }) {
  const seq = new Sequence();
  const calls: FetchCall[] = [];
  seq.impls.set('http.fetch', async (input: unknown) => {
    calls.push(input as FetchCall);
    return { ...response, headers: {} };
  });
  return { seq, calls };
}

/** An fn type qualified the way a stored connector fact is. */
function issueTool(headers?: Record<string, string>, body?: string) {
  return createType('fn', [
    param(FT.object({ owner: FT.string(), repo: FT.string(), 'page?': FT.number() })),
    endpoint('https://api.example.com/repos/{{arg.owner}}/{{arg.repo}}/issues', {
      method: body ? 'POST' : 'GET',
      ...(headers ? { headers } : {}),
      ...(body ? { body } : {}),
    }),
    auth('keys.example'),
  ]);
}

describe('installEndpointTool — the impl derives from the type', () => {
  test('fills {{arg.x}} into the url (URI-encoded) and calls with the declared method', async () => {
    const { seq, calls } = harness();
    installEndpointTool(seq, 'ex.issues', issueTool());
    const result = await seq.impls.get('ex.issues')!({ owner: 'a b', repo: 'r' });
    expect(calls[0].url).toBe('https://api.example.com/repos/a%20b/r/issues');
    expect(calls[0].method).toBe('GET');
    expect(result).toEqual({ ok: true });
  });

  test('required params are read off the param constraint; optional stays optional', async () => {
    const { seq } = harness();
    installEndpointTool(seq, 'ex.issues', issueTool());
    await expect(seq.impls.get('ex.issues')!({ owner: 'a' })).rejects.toThrow("param 'repo' is required");
    // page? absent is fine
    await expect(seq.impls.get('ex.issues')!({ owner: 'a', repo: 'r' })).resolves.toEqual({ ok: true });
  });

  test('auth.resolve binds the secret into {{secret}} headers', async () => {
    const { seq, calls } = harness();
    seq.impls.set('auth.resolve', async (input: unknown) => {
      expect((input as { path: string }).path).toBe('keys.example');
      return 'tok123';
    });
    installEndpointTool(seq, 'ex.issues', issueTool({ Authorization: 'Bearer {{secret}}', Accept: 'application/json' }));
    await seq.impls.get('ex.issues')!({ owner: 'a', repo: 'r' });
    expect(calls[0].headers).toEqual({ Authorization: 'Bearer tok123', Accept: 'application/json' });
  });

  test('no resolver → secret-referencing headers OMITTED (unauthenticated tier), others kept', async () => {
    const { seq, calls } = harness();
    installEndpointTool(seq, 'ex.issues', issueTool({ Authorization: 'Bearer {{secret}}', Accept: 'application/json' }));
    await seq.impls.get('ex.issues')!({ owner: 'a', repo: 'r' });
    expect(calls[0].headers).toEqual({ Accept: 'application/json' });
  });

  test('body templates JSON-encode args and NEVER receive the secret', async () => {
    const { seq, calls } = harness();
    seq.impls.set('auth.resolve', async () => 'tok123');
    installEndpointTool(
      seq,
      'ex.create',
      issueTool(undefined, '{"title": {{arg.owner}}, "n": {{arg.page}}, "secret": "{{secret}}"}'),
    );
    await seq.impls.get('ex.create')!({ owner: 'hello', repo: 'r', page: 7 });
    // string quoted, number raw, {{secret}} untouched in the body
    expect(calls[0].body).toBe('{"title": "hello", "n": 7, "secret": "{{secret}}"}');
    expect(calls[0].method).toBe('POST');
  });

  test('non-2xx throws path: METHOD → status; non-JSON body returns { body }', async () => {
    const bad = harness({ status: 404, body: 'nope' });
    installEndpointTool(bad.seq, 'ex.issues', issueTool());
    await expect(bad.seq.impls.get('ex.issues')!({ owner: 'a', repo: 'r' })).rejects.toThrow('ex.issues: GET → 404');

    const text = harness({ status: 200, body: 'plain text' });
    installEndpointTool(text.seq, 'ex.issues', issueTool());
    await expect(text.seq.impls.get('ex.issues')!({ owner: 'a', repo: 'r' })).resolves.toEqual({ body: 'plain text' });
  });

  test('a bare endpoint(url) stays valid: args [url], GET, no headers', async () => {
    const { seq, calls } = harness();
    const t = createType('fn', [
      param(FT.object({ 'q?': FT.string() })),
      endpoint('https://api.example.com/search?q={{arg.q}}'),
    ]);
    installEndpointTool(seq, 'ex.search', t);
    await seq.impls.get('ex.search')!({ q: 'x' });
    expect(calls[0]).toEqual({ url: 'https://api.example.com/search?q=x', method: 'GET' });
  });

  test('install refuses: no endpoint constraint; non-http scheme (mcp:// reserved)', () => {
    const { seq } = harness();
    expect(() => installEndpointTool(seq, 'ex.none', createType('fn', [param(FT.object({}))]))).toThrow(
      'carries no endpoint constraint',
    );
    expect(() =>
      installEndpointTool(seq, 'ex.mcp', createType('fn', [endpoint('mcp://calc' as string)])),
    ).toThrow('scheme unsupported');
  });

  test('the installed type is inserted at the path (property constraints intact)', () => {
    const { seq } = harness();
    installEndpointTool(seq, 'ex.issues', issueTool());
    const t = seq.typeAt('ex.issues');
    expect(t?.constraints?.some((c) => c.op === 'endpoint')).toBe(true);
    expect(t?.constraints?.some((c) => c.op === 'auth')).toBe(true);
  });
});

describe('endpoint() widening stays additive', () => {
  test('bare url keeps args [url]; opts appends', () => {
    expect(endpoint('https://x.y')).toEqual({ op: 'endpoint', args: ['https://x.y'] });
    expect(endpoint('https://x.y', { method: 'POST' })).toEqual({
      op: 'endpoint',
      args: ['https://x.y', { method: 'POST' }],
    });
  });

  test('property() optional flag is what the executor reads', () => {
    expect(property('k', FT.string(), true).args[2]).toBe(true);
  });
});
