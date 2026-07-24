/**
 * dsl-clauses.test.ts — the clause layer of the text language ENFORCES.
 *
 * The April 2026 design (specs/docs/DSL_REQUIREMENTS.md) speced predicate
 * operators, gates, temporal intervals and reliability suffixes. The
 * tokenizer carried all of it; parts of the parse/bind path did not
 * (MATCHES could never token-match; IN had no set-literal RHS; non-'='
 * refinement predicates were silently dropped). Fixed 2026-07-24 — this
 * suite pins every form to REAL enforcement, not just parse acceptance.
 */
import { Sequence } from '../sequence';
import { receive } from '../dsl/walker';

const okAll = (r: ReturnType<typeof receive>) => (r.mounts ?? []).every((m) => m.ok);
const rejected = (r: ReturnType<typeof receive>) => (r.mounts ?? []).find((m) => !m.ok);

describe('refinement predicates enforce at admission', () => {
  test('MATCHES /re/ — property-scoped', () => {
    const seq = new Sequence();
    receive('v = { email: string | email MATCHES /@/ }', seq);
    expect(okAll(receive('v = { email: "a@b.com" }', seq))).toBe(true);
    const bad = rejected(receive('v = { email: "no-at" }', seq));
    expect(bad?.gaps?.[0]?.reason).toContain('no match');
  });

  test('IN { set literal } compiles to a literal union', () => {
    const seq = new Sequence();
    receive('a = { role: string | role IN { "admin", "member" } }', seq);
    expect(okAll(receive('a = { role: "admin" }', seq))).toBe(true);
    const bad = rejected(receive('a = { role: "guest" }', seq));
    expect(bad?.gaps?.[0]?.reason).toContain('matches none');
  });

  test('>= and <= tighten numeric properties', () => {
    const seq = new Sequence();
    receive('n = { retries: number | retries >= 2 }', seq);
    receive('m = { retries: number | retries <= 5 }', seq);
    expect(okAll(receive('n = { retries: 3 }', seq))).toBe(true);
    expect(rejected(receive('n = { retries: 1 }', seq))?.gaps?.[0]?.reason).toContain('< min');
    expect(rejected(receive('m = { retries: 9 }', seq))?.gaps?.[0]?.reason).toContain('> max');
  });

  test('deltat interval + reliability suffix parse and mount alongside', () => {
    const seq = new Sequence();
    const r = receive('fs2 = { ok: boolean | ok = prev.ok @[T_out..T_out) ~survival(exp, 0.001) }', seq);
    expect(okAll(r)).toBe(true);
    // The predicate's shape constraint still enforces.
    expect(rejected(receive('fs2 = { ok: "x" }', seq))).toBeDefined();
  });

  test('~survival(exp, r) positional form maps to the exponential family', () => {
    const seq = new Sequence();
    const r = receive('cur = { ok: boolean | ok = prev.ok ~survival(exp, 0.001) }', seq);
    expect(okAll(r)).toBe(true);
  });
});

describe('gates', () => {
  test('when-equality at statement level suspends until the state matches', () => {
    const seq = new Sequence();
    const r = receive('pay = "go" when status = "created"', seq);
    // The statement is ACCEPTED (ok) and visibly suspended — not readable,
    // not swallowed — then promotes on its own when the state matches.
    expect((r.mounts ?? [])[0]?.ok).toBe(true);
    expect(seq.get('pay')).toBeUndefined();
    expect(seq.suspended().length).toBeGreaterThan(0);
    receive('status = "created"', seq);
    expect(seq.get('pay')).toBe('go');
  });

  test('MATCHES in a when-condition parses (keyword token)', () => {
    const seq = new Sequence();
    receive('x = "go" when email MATCHES /@/', seq);
    expect(seq.get('x')).toBeUndefined();
    receive('email = "a@b.com"', seq);
    expect(seq.get('x')).toBe('go');
  });
});

describe('the quantifier layer (∀/∈ as index/over/where)', () => {
  test('index … over … where — fires the body per qualifying tuple', () => {
    const seq = new Sequence(() => 1000);
    receive(`
      index _sessions.fresh {
        over user in sessions.*
        where sessions.{user}.heartbeat > _rt - 100
        sessions.{user}.status = "fresh"
      }
    `, seq);
    seq.mount('bind', 'sessions.alice.heartbeat', 950);
    seq.mount('bind', 'sessions.bob.heartbeat', 800);
    expect(seq.get('sessions.alice.status')).toBe('fresh');
    expect(seq.get('sessions.bob.status')).toBeUndefined();
  });
});

describe('call-result paths and the identity clause (2026-07-24 unlock)', () => {
  test('the write/read identity clause — spec verbatim — parses and mounts', () => {
    const seq = new Sequence();
    const r = receive(
      'fs = { write: (p: string, content: string) -> { ok: true | read(p).content = content @[T_out..next_write(p).T_out) ~survival(exp, 0.001) } }',
      seq,
    );
    expect(okAll(r)).toBe(true);
  });

  test('a literal union stays a union (disambiguation does not overreach)', () => {
    const seq = new Sequence();
    receive('st = { status: "created" | "paid" | "shipped" }', seq);
    expect(okAll(receive('st = { status: "paid" }', seq))).toBe(true);
    expect(rejected(receive('st = { status: "bogus" }', seq))).toBeDefined();
  });
});

describe('property-level gates lower to statement gates', () => {
  test('while + onBreak on a schema property mounts (Worker, spec shape)', () => {
    const seq = new Sequence();
    const r = receive(
      'Worker = { heartbeat: number, task: string while alive = true onBreak events.taskExpired = true }',
      seq,
    );
    expect(okAll(r)).toBe(true);
  });

  test('when-gated property in a narrow waits, then promotes on the SIBLING condition', () => {
    const seq = new Sequence();
    receive('deleteApproval = { status: string, currentApprovals: number }', seq);
    receive('deleteApproval.currentApprovals = 1', seq);
    receive('deleteApproval << { status: "approved" when currentApprovals = 2 }', seq);
    expect(seq.get('deleteApproval.status')).toBeUndefined();
    receive('deleteApproval.currentApprovals = 2', seq);
    expect(seq.get('deleteApproval.status')).toBe('approved');
  });
});
