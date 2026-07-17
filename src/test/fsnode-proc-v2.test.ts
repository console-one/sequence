/**
 * fsnode-proc-v2.test.ts — the real-filesystem + subprocess primitives.
 *
 * The transports the connector maps named MISSING (fs.watch/fs.tail/
 * proc.exec), decomposed honestly: list + tail + stat + exec. Tested
 * against a REAL temp directory and REAL subprocesses through the ft
 * language — no stubs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sequence } from '../../src-v2/sequence';
import { registerBaseTools } from '../../src-v2/tools';
import { receiveCalls } from '../../src-v2/receive-calls';
import { hoistCatalog } from '../hoist';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fsnode-'));
}

describe('fsnode.* real-filesystem primitives', () => {
  test('list enumerates by extension; tail advances an offset over appends', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a.jsonl'), '{"n":1}\n');
    fs.writeFileSync(path.join(dir, 'skip.txt'), 'nope\n');
    const seq = new Sequence();
    registerBaseTools(seq, { realFs: true });

    const r1 = await receiveCalls(seq, `l = fsnode.list({ dir: "${dir}", ext: ".jsonl" })`);
    expect(r1.errors).toEqual([]);
    expect((seq.get('l') as { files: string[] }).files).toEqual([path.join(dir, 'a.jsonl')]);

    // First tail reads the whole file and returns the new offset.
    const r2 = await receiveCalls(seq, `t = fsnode.tail({ path: "${path.join(dir, 'a.jsonl')}", offset: 0 })`);
    expect(r2.errors).toEqual([]);
    const t = seq.get('t') as { content: string; offset: number };
    expect(t.content).toBe('{"n":1}\n');

    // Append, then tail FROM the returned offset — only the new bytes.
    fs.appendFileSync(path.join(dir, 'a.jsonl'), '{"n":2}\n');
    const r3 = await receiveCalls(seq, `t2 = fsnode.tail({ path: "${path.join(dir, 'a.jsonl')}", offset: ${t.offset} })`);
    expect(r3.errors).toEqual([]);
    expect((seq.get('t2') as { content: string }).content).toBe('{"n":2}\n');
  });

  test('stat reports existence/size; missing file is exists:false, not a throw', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'x'), 'abcde');
    const seq = new Sequence();
    registerBaseTools(seq, { realFs: true });
    const r = await receiveCalls(seq, [
      `s = fsnode.stat({ path: "${path.join(dir, 'x')}" })`,
      `m = fsnode.stat({ path: "${path.join(dir, 'nope')}" })`,
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect(seq.get('s')).toMatchObject({ exists: true, size: 5 });
    expect(seq.get('m')).toMatchObject({ exists: false, size: 0 });
  });

  test('tail restarts when the file is truncated below the offset', async () => {
    const dir = tmp();
    const f = path.join(dir, 'rot.log');
    fs.writeFileSync(f, 'aaaaaaaaaa');
    const seq = new Sequence();
    registerBaseTools(seq, { realFs: true });
    fs.writeFileSync(f, 'bb'); // rotated: now smaller than offset 10
    const r = await receiveCalls(seq, `t = fsnode.tail({ path: "${f}", offset: 10 })`);
    expect(r.errors).toEqual([]);
    expect((seq.get('t') as { content: string }).content).toBe('bb');
  });
});

describe('proc.exec subprocess primitive', () => {
  test('runs a command and collects stdout/exit through the language', async () => {
    const seq = new Sequence();
    registerBaseTools(seq, { proc: true });
    const r = await receiveCalls(seq, `e = proc.exec({ cmd: "node", args: ["-e", "process.stdout.write('hi'+41+1)"] })`);
    expect(r.errors).toEqual([]);
    expect(seq.get('e')).toMatchObject({ stdout: 'hi411', code: 0 });
  });

  test('pipes stdin and surfaces a non-zero exit code (not a throw)', async () => {
    const seq = new Sequence();
    registerBaseTools(seq, { proc: true });
    const r = await receiveCalls(seq, [
      `echo = proc.exec({ cmd: "cat", stdin: "roundtrip" })`,
      `fail = proc.exec({ cmd: "node", args: ["-e", "process.exit(3)"] })`,
    ].join('\n'));
    expect(r.errors).toEqual([]);
    expect((seq.get('echo') as { stdout: string }).stdout).toBe('roundtrip');
    expect((seq.get('fail') as { code: number }).code).toBe(3);
  });

  test('opt-in: absent without realFs/proc flags (the grant is explicit)', () => {
    const seq = new Sequence();
    registerBaseTools(seq); // http + schedule only
    const frame = hoistCatalog(seq).text;
    expect(frame).not.toContain('fsnode');
    expect(frame).not.toContain('proc');
    expect(frame).toContain('http = {');
  });
});
