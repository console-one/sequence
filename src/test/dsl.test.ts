/**
 * dsl.test.ts — Tests for the behavioral type DSL.
 * Tokenizer → Parser → Compiler → mount operations.
 */

import { tokenize } from '../dsl/tokenizer';
import { parse } from '../dsl/parser';
import { receive } from '../dsl/walker';
import { Sequence } from '../sequence';
import { hoist } from '../hoist';
import { extractFtBlocks, extractFt } from '../dsl/extract';

describe('DSL Tokenizer', () => {

  test('tokenizes assignment', () => {
    const tokens = tokenize('x = string');
    expect(tokens.map(t => t.kind)).toEqual(['IDENT', 'ASSIGN', 'IDENT', 'EOF']);
  });

  test('tokenizes narrow operator', () => {
    const tokens = tokenize('x << "hello"');
    expect(tokens.map(t => t.kind)).toEqual(['IDENT', 'NARROW', 'STRING', 'EOF']);
    expect(tokens[2].value).toBe('hello');
  });

  test('tokenizes object type', () => {
    const tokens = tokenize('{ name: string, age?: number }');
    const kinds = tokens.map(t => t.kind);
    expect(kinds).toEqual([
      'LBRACE', 'IDENT', 'COLON', 'IDENT', 'COMMA',
      'IDENT', 'QUESTION', 'COLON', 'IDENT', 'RBRACE', 'EOF',
    ]);
  });

  test('tokenizes function type with arrow', () => {
    const tokens = tokenize('(p: string) -> { content: string }');
    expect(tokens.some(t => t.kind === 'ARROW')).toBe(true);
  });

  test('tokenizes regex pattern', () => {
    const tokens = tokenize('string /^[a-z]+$/');
    expect(tokens[1].kind).toBe('REGEX');
    expect(tokens[1].value).toBe('^[a-z]+$');
  });

  test('tokenizes number range', () => {
    const tokens = tokenize('number 0..100');
    const kinds = tokens.map(t => t.kind);
    expect(kinds).toEqual(['IDENT', 'NUMBER', 'DOTDOT', 'NUMBER', 'EOF']);
  });

  test('tokenizes refinement pipe', () => {
    const tokens = tokenize('{ size: number | size = byteLength(content) }');
    expect(tokens.some(t => t.kind === 'PIPE')).toBe(true);
  });

  test('tokenizes temporal scope', () => {
    const tokens = tokenize('@[T_out..next_write(p).T_out)');
    expect(tokens[0].kind).toBe('AT');
    expect(tokens[1].kind).toBe('LBRACKET');
  });

  test('tokenizes tilde (probability)', () => {
    const tokens = tokenize('~survival(exp, 0.001)');
    expect(tokens[0].kind).toBe('TILDE');
  });

  test('tokenizes variable binding', () => {
    const tokens = tokenize('write($path, $body)');
    expect(tokens.filter(t => t.kind === 'VARIABLE').map(t => t.value)).toEqual(['path', 'body']);
  });

  test('tokenizes union', () => {
    const tokens = tokenize('"active" | "inactive"');
    expect(tokens.map(t => t.kind)).toEqual(['STRING', 'PIPE', 'STRING', 'EOF']);
  });

  test('tokenizes intersection', () => {
    const tokens = tokenize('FileSystem & WriteReadIdentity');
    expect(tokens.map(t => t.kind)).toEqual(['IDENT', 'AMPERSAND', 'IDENT', 'EOF']);
  });

  test('tokenizes keywords', () => {
    const tokens = tokenize('delete x when y EXISTS while z EXISTS');
    const kinds = tokens.map(t => t.kind);
    expect(kinds).toEqual(['DELETE', 'IDENT', 'WHEN', 'IDENT', 'EXISTS', 'WHILE', 'IDENT', 'EXISTS', 'EOF']);
  });

  test('tokenizes comments (preserves them)', () => {
    const tokens = tokenize('x = string -- this is a comment\ny = number');
    const kinds = tokens.filter(t => t.kind !== 'EOF').map(t => t.kind);
    expect(kinds).toEqual([
      'IDENT', 'ASSIGN', 'IDENT', 'COMMENT', 'IDENT', 'ASSIGN', 'IDENT',
    ]);
    expect(tokens.find(t => t.kind === 'COMMENT')!.value).toBe('this is a comment');
  });

  test('tokenizes forall', () => {
    const tokens = tokenize('forall k : keys(changes) . query(table)');
    expect(tokens[0].kind).toBe('FORALL');
  });

  test('tokenizes cap and policy', () => {
    const tokens = tokenize('cap FileSystem.read');
    expect(tokens.map(t => t.kind)).toEqual(['CAP', 'IDENT', 'DOT', 'IDENT', 'EOF']);
  });

  test('tokenizes import/export', () => {
    const tokens = tokenize('import fs from "./contractlike/fs"');
    expect(tokens.map(t => t.kind)).toEqual(['IMPORT', 'IDENT', 'FROM', 'STRING', 'EOF']);
  });

  test('tokenizes let', () => {
    const tokens = tokenize('let $x = 42');
    expect(tokens.map(t => t.kind)).toEqual(['LET', 'VARIABLE', 'ASSIGN', 'NUMBER', 'EOF']);
  });

  test('tokenizes full FileSystem definition', () => {
    const source = `
      FileSystem = {
        read: (p: string /^[/]//, encoding?: string) -> { content: string, size: number >= 0 },
        write: (p: string /^[/]//, content: string) -> { ok: true | read(p).content = content @[T_out..next_write(p).T_out) ~survival(exp, 0.001) }
      }
    `;
    const tokens = tokenize(source);
    expect(tokens[tokens.length - 1].kind).toBe('EOF');
    expect(tokens.some(t => t.kind === 'ASSIGN')).toBe(true);
    expect(tokens.some(t => t.kind === 'ARROW')).toBe(true);
    expect(tokens.some(t => t.kind === 'PIPE')).toBe(true);
    expect(tokens.some(t => t.kind === 'AT')).toBe(true);
    expect(tokens.some(t => t.kind === 'TILDE')).toBe(true);
  });

  test('string literal escape sequences resolve to their characters', () => {
    // Caught regression: a typed newline that round-tripped through
    // ft text was lost. The editor escaped it to `\n` (backslash-n)
    // on send; the tokenizer used to take the next char literally,
    // so `\n` became 'n' and the newline disappeared. The kernel's
    // wire format needs proper escape handling.
    const cases: Array<[string, string]> = [
      ['"foo\\nbar"', 'foo\nbar'],   // \n → newline
      ['"a\\tb"',     'a\tb'],        // \t → tab
      ['"x\\\\y"',    'x\\y'],        // \\ → backslash
      ['"q\\"r"',     'q"r'],         // \" → quote
    ];
    for (const [src, expected] of cases) {
      const tokens = tokenize(src);
      const stringTokens = tokens.filter(t => t.kind === 'STRING');
      expect(stringTokens.length).toBe(1);
      expect(stringTokens[0].value).toBe(expected);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PARSER
// ═══════════════════════════════════════════════════════════════════════

describe('DSL Parser', () => {

  test('parses simple assignment', () => {
    const stmts = parse('x = string');
    expect(stmts.length).toBe(1);
    expect(stmts[0].kind).toBe('assign');
    expect((stmts[0] as any).path).toBe('x');
    expect((stmts[0] as any).value.kind).toBe('primitive');
    expect((stmts[0] as any).value.base).toBe('string');
  });

  test('parses narrow', () => {
    const stmts = parse('x << "hello"');
    expect(stmts[0].kind).toBe('narrow');
    expect((stmts[0] as any).value.kind).toBe('literal');
    expect((stmts[0] as any).value.value).toBe('hello');
  });

  test('parses object type', () => {
    const stmts = parse('x = { name: string, age?: number }');
    const obj = (stmts[0] as any).value;
    expect(obj.kind).toBe('object');
    expect(obj.properties.length).toBe(2);
    expect(obj.properties[0].key).toBe('name');
    expect(obj.properties[0].optional).toBe(false);
    expect(obj.properties[1].key).toBe('age');
    expect(obj.properties[1].optional).toBe(true);
  });

  test('parses number with range', () => {
    const stmts = parse('x = number 0..100');
    const prim = (stmts[0] as any).value;
    expect(prim.kind).toBe('primitive');
    expect(prim.base).toBe('number');
    expect(prim.constraints[0].op).toBe('range');
    expect(prim.constraints[0].lo).toBe(0);
    expect(prim.constraints[0].hi).toBe(100);
  });

  test('parses string with pattern', () => {
    const stmts = parse('x = string /^[a-z]+$/');
    const prim = (stmts[0] as any).value;
    expect(prim.kind).toBe('primitive');
    expect(prim.constraints[0].op).toBe('pattern');
    expect(prim.constraints[0].value).toBe('^[a-z]+$');
  });

  test('parses delete', () => {
    const stmts = parse('delete x');
    expect(stmts[0].kind).toBe('delete');
  });

  test('parses cap', () => {
    const stmts = parse('cap Worker.heartbeat');
    expect(stmts[0].kind).toBe('cap');
    expect((stmts[0] as any).path).toBe('Worker.heartbeat');
  });

  test('parses import/export', () => {
    const stmts = parse('import fs from "./contractlike/fs"');
    expect(stmts[0].kind).toBe('import');
    expect((stmts[0] as any).name).toBe('fs');
    expect((stmts[0] as any).from).toBe('./contractlike/fs');
  });

  test('parses when modifier', () => {
    const stmts = parse('x = "ready" when auth EXISTS');
    expect((stmts[0] as any).modifiers.when).toBeDefined();
    expect((stmts[0] as any).modifiers.when[0].kind).toBe('exists');
  });

  test('parses while modifier', () => {
    const stmts = parse('x = "alive" while heartbeat EXISTS');
    expect((stmts[0] as any).modifiers.while).toBeDefined();
    expect((stmts[0] as any).modifiers.while[0].kind).toBe('exists');
  });

  test('parses intersection', () => {
    const stmts = parse('x = A & B');
    const val = (stmts[0] as any).value;
    expect(val.kind).toBe('intersection');
    expect(val.members.length).toBe(2);
  });

  test('parses union of literals', () => {
    const stmts = parse('x = "active" | "inactive"');
    const val = (stmts[0] as any).value;
    expect(val.kind).toBe('union');
    expect(val.branches.length).toBe(2);
  });

  test('parses policy', () => {
    const stmts = parse('policy metrics: { transition: "add" }');
    expect(stmts[0].kind).toBe('policy');
    expect((stmts[0] as any).spec.transition).toBe('add');
  });

  test('parses block with import and export', () => {
    const stmts = parse(`
      x = {
        import a from "./path"
        b = number
        export a & b
      }
    `);
    expect(stmts[0].kind).toBe('assign');
    const block = (stmts[0] as any).value;
    expect(block.kind).toBe('block');
    expect(block.statements.length).toBe(3);
    expect(block.statements[0].kind).toBe('import');
    expect(block.statements[1].kind).toBe('assign');
    expect(block.statements[2].kind).toBe('export');
  });

  test('parses worker heartbeat example', () => {
    const stmts = parse(`
      Worker = {
        heartbeat: number,
        livenessWindow: number,
        alive: boolean
      }
      worker1 = Worker
      worker1 << { livenessWindow: 5000 }
      worker1 << { heartbeat: 42 }
    `);
    expect(stmts.length).toBe(4);
    expect(stmts[0].kind).toBe('assign');
    expect(stmts[1].kind).toBe('assign');
    expect(stmts[2].kind).toBe('narrow');
    expect(stmts[3].kind).toBe('narrow');
  });

  test('parses multiple statements', () => {
    const stmts = parse('x = string; y = number; z = boolean');
    expect(stmts.length).toBe(3);
  });

  test('parses by modifier', () => {
    const stmts = parse('x = "config" by "admin"');
    expect((stmts[0] as any).modifiers.author).toBe('admin');
  });

  test('parses expansion token', () => {
    const stmts = parse('x = [[ expand: write signature ]]');
    const val = (stmts[0] as any).value;
    expect(val.kind).toBe('expansion');
    expect(val.label).toBe('expand');
    expect(val.description).toBe('write signature');
  });

  test('parses expansion token without label', () => {
    const stmts = parse('x = [[ some unresolved type ]]');
    const val = (stmts[0] as any).value;
    expect(val.kind).toBe('expansion');
    expect(val.description).toBe('some unresolved type');
  });

  test('parses object with expansion stubs', () => {
    const stmts = parse(`
      FileSystem = {
        read: (p: string) -> { content: string },
        write: [[ expand: write with behavioral predicates ]],
        list: [[ expand: list signature ]]
      }
    `);
    const obj = (stmts[0] as any).value;
    expect(obj.kind).toBe('object');
    expect(obj.properties[0].key).toBe('read');
    expect(obj.properties[0].value.kind).toBe('function');
    expect(obj.properties[1].key).toBe('write');
    expect(obj.properties[1].value.kind).toBe('expansion');
    expect(obj.properties[2].key).toBe('list');
    expect(obj.properties[2].value.kind).toBe('expansion');
  });

  test('parses prev', () => {
    const stmts = parse('x = prev.count');
    const val = (stmts[0] as any).value;
    expect(val.kind).toBe('prev');
    expect(val.path).toBe('count');
  });

  test('parses bare prev', () => {
    const stmts = parse('x = prev');
    const val = (stmts[0] as any).value;
    expect(val.kind).toBe('prev');
    expect(val.path).toBeUndefined();
  });

  test('tokenizes expansion token', () => {
    const tokens = tokenize('[[ expand: some description ]]');
    expect(tokens[0].kind).toBe('EXPANSION');
    expect(tokens[0].value).toBe('expand: some description');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// END-TO-END: ft text → Sequence state
// ═══════════════════════════════════════════════════════════════════════

describe('ft text → Sequence (end-to-end)', () => {

  test('assign string type creates schema', () => {
    const seq = new Sequence();
    receive('x = string', seq);
    expect(seq.typeAt('x')).toBeDefined();
    expect(seq.typeAt('x')!.kind).toBe('string');
  });

  test('assign literal creates schema + bind', () => {
    const seq = new Sequence();
    receive('x = "hello"', seq);
    expect(seq.get('x')).toBe('hello');
  });

  test('assign object with concrete values', () => {
    const seq = new Sequence();
    receive('config = { host: "localhost", port: 5432 }', seq);
    expect(seq.get('config')).toEqual({ host: 'localhost', port: 5432 });
  });

  test('narrow tightens existing type', () => {
    const seq = new Sequence();
    receive('x = string', seq);
    receive('x << "hello"', seq);
    expect(seq.get('x')).toBe('hello');
  });

  test('schema without value creates obligation', () => {
    const seq = new Sequence();
    receive('profile = { name: string, email: string }', seq);
    const obs = seq.obligations();
    expect(obs.length).toBeGreaterThan(0);
  });

  test('delete removes value', () => {
    const seq = new Sequence();
    receive('x = "hello"', seq);
    expect(seq.get('x')).toBe('hello');
    receive('delete x', seq);
    expect(seq.get('x')).toBeUndefined();
  });

  test('cap registers capability', () => {
    const seq = new Sequence();
    receive('cap Worker.heartbeat', seq);
    expect(seq.projection.capabilities.has('Worker.heartbeat')).toBe(true);
  });

  test('when modifier creates where clause', () => {
    const seq = new Sequence();
    const result = receive('x = "ready" when auth EXISTS', seq);
    // auth doesn't exist, so the mount suspends
    expect(seq.get('x')).toBeUndefined();
    expect(seq.suspended().length).toBeGreaterThan(0);
  });

  test('when + resume: providing dependency resumes', () => {
    const seq = new Sequence();
    receive('x = "ready" when auth EXISTS', seq);
    expect(seq.get('x')).toBeUndefined();
    receive('auth = "valid"', seq);
    expect(seq.get('x')).toBe('ready');
  });

  test('expansion token creates any-typed obligation', () => {
    const seq = new Sequence();
    receive('details = [[ expand: implementation details ]]', seq);
    const t = seq.typeAt('details');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('any');
  });

  test('comments preserved in walk result', () => {
    const seq = new Sequence();
    const result = receive('-- this is context\nx = "hello"', seq);
    expect(result.comments.length).toBe(1);
    expect(result.comments[0].text).toBe('this is context');
    expect(seq.get('x')).toBe('hello');
  });

  test('narrow with concrete object properties', () => {
    const seq = new Sequence();
    // Direct sub-path bind (no narrow, just assign)
    receive('x.a = 42', seq);
    expect(seq.get('x.a')).toBe(42);
  });

  test('narrow adds concrete values via sub-path binds', () => {
    const seq = new Sequence();
    // Schema at worker level, values at sub-paths — this is how << works
    receive('worker.heartbeat = number', seq);
    receive('worker.livenessWindow = number', seq);
    receive('worker.livenessWindow << 5000', seq);
    receive('worker.heartbeat << 42', seq);
    expect(seq.get('worker.livenessWindow')).toBe(5000);
    expect(seq.get('worker.heartbeat')).toBe(42);
  });

  test('policy mount', () => {
    const seq = new Sequence();
    receive('policy audit: { compact: "preserve" }', seq);
    expect(seq.projection.policies.has('audit')).toBe(true);
  });

  test('number with range constraint', () => {
    const seq = new Sequence();
    receive('port = number 1..65535', seq);
    const t = seq.typeAt('port');
    expect(t).toBeDefined();
    expect(t!.kind).toBe('number');
    const r = seq.mount('bind', 'port', 80);
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// HOIST → FT TEXT (emit side)
// ═══════════════════════════════════════════════════════════════════════

describe('Hoist emits ft syntax', () => {

  test('emits concrete values as assignments', () => {
    const seq = new Sequence();
    seq.mount('bind', 'name', 'alice');
    seq.mount('bind', 'age', 30);
    const result = hoist(seq);
    expect(result.text).toContain('name = "alice"');
    expect(result.text).toContain('age = 30');
  });

  test('schemas without values are invisible (empty is not a gap)', () => {
    const seq = new Sequence();
    seq.mount('schema', 'email', { kind: 'string', constraints: [] });
    const result = hoist(seq);
    expect(result.text).not.toContain('email');
  });

  test('emits expansion tokens for compressed sections', () => {
    const seq = new Sequence();
    seq.mount('bind', 'config.host', 'localhost');
    seq.mount('bind', 'config.port', 5432);
    seq.mount('bind', 'config.db.name', 'mydb');
    seq.mount('bind', 'config.db.pool', 10);
    const result = hoist(seq, { depth: 1 });
    expect(result.text).toContain('[[');
    expect(result.expandTokens.length).toBeGreaterThan(0);
  });

  test('only blocking gaps are shown (unresolved refs, pending derived)', () => {
    const seq = new Sequence();
    // Schema without value — NOT a blocking gap, should not appear
    seq.mount('schema', 'email', { kind: 'string', constraints: [] });
    // Unresolved ref — IS a blocking gap
    seq.mount('schema', 'derived.val', { kind: 'string', constraints: [{ op: 'ref', args: ['missing.source'] }] });
    const result = hoist(seq);
    expect(result.text).not.toContain('email');
    expect(result.text).toContain('ref(missing.source)');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MARKDOWN EXTRACTOR
// ═══════════════════════════════════════════════════════════════════════

describe('Markdown ft block extractor', () => {

  test('extracts single ft block', () => {
    const md = '# Title\n\nSome text.\n\n```ft\nx = string\ny = number\n```\n\nMore text.';
    const blocks = extractFtBlocks(md);
    expect(blocks.length).toBe(1);
    expect(blocks[0].content).toBe('x = string\ny = number');
  });

  test('extracts multiple ft blocks', () => {
    const md = '```ft\na = 1\n```\n\nMiddle.\n\n```ft\nb = 2\n```';
    const blocks = extractFtBlocks(md);
    expect(blocks.length).toBe(2);
    expect(blocks[0].content).toBe('a = 1');
    expect(blocks[1].content).toBe('b = 2');
  });

  test('extracts and concatenates', () => {
    const md = '```ft\na = 1\n```\n\n```ft\nb = 2\n```';
    const ft = extractFt(md);
    expect(ft).toBe('a = 1\nb = 2');
  });

  test('ignores non-ft code blocks', () => {
    const md = '```typescript\nconst x = 1;\n```\n\n```ft\ny = string\n```';
    const blocks = extractFtBlocks(md);
    expect(blocks.length).toBe(1);
    expect(blocks[0].content).toBe('y = string');
  });

  test('preserves indentation', () => {
    const md = '```ft\n  Worker = {\n    heartbeat: number\n  }\n```';
    const blocks = extractFtBlocks(md);
    expect(blocks[0].content).toContain('  Worker');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ROUND-TRIP: ft text → Sequence → ft text
// ═══════════════════════════════════════════════════════════════════════

describe('Round-trip: receive → emit', () => {

  test('round-trips concrete values', () => {
    const seq = new Sequence();
    receive('host = "localhost"', seq);
    receive('port = 5432', seq);

    const emitted = hoist(seq);
    expect(emitted.text).toContain('host = "localhost"');
    expect(emitted.text).toContain('port = 5432');

    // Parse the emitted text back into a new Sequence
    const seq2 = new Sequence();
    receive(emitted.text, seq2);
    expect(seq2.get('host')).toBe('localhost');
    expect(seq2.get('port')).toBe(5432);
  });

  test('round-trips from markdown document', () => {
    const md = `
# Config Spec

The server needs host and port.

\`\`\`ft
host = "localhost"
port = 8080
\`\`\`

And a database name.

\`\`\`ft
db = "myapp"
\`\`\`
`;
    // Extract → parse → mount
    const ft = extractFt(md);
    const seq = new Sequence();
    receive(ft, seq);
    expect(seq.get('host')).toBe('localhost');
    expect(seq.get('port')).toBe(8080);
    expect(seq.get('db')).toBe('myapp');

    // Hoist back → parse → mount into new Sequence
    const emitted = hoist(seq);
    const seq2 = new Sequence();
    receive(emitted.text, seq2);
    expect(seq2.get('host')).toBe('localhost');
    expect(seq2.get('port')).toBe(8080);
    expect(seq2.get('db')).toBe('myapp');
  });
});
