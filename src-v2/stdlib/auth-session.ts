import {
  type Constraint, type Type, createType, impl, derived, indexSpec, bindFrom,
} from '../../src/type';
import {
  check,
} from '../../src/compose';
// DEFAULT import (not named): these are node-only auth helpers (HMAC session
// tokens). A *named* `import { createHmac } from 'crypto'` hard-fails browser
// bundlers (vite's node-builtin stub has no named exports), which dragged
// node:crypto into every browser consumer of this kernel. A default import
// builds everywhere — vite gives it a proxy that only throws IF accessed, and
// the browser never calls these fns — while node sees the real module. Keeps
// the kernel genuinely browser-safe with no signature/async change.
import nodeCrypto from 'crypto';
import {
  type Sequence,
} from '../sequence';
import { installTool } from './tool';

// ═══════════════════════════════════════════════════════════════════════
// WRITER-AUTHORITY ADMISSION (ported from v1 session-rules).
//
// Ported from v1 commit cf27d83 — sessions.* schema carried:
//   or(notExists('$instancePath.holder'),
//      eq('$instancePath.holder', '$author'),
//      eq('$instancePath.status', 'expired'))
// wrapped in a `law({ admission: true })`.
//
// v2 kernel doesn't yet resolve `$instancePath` or `$author` as template
// bindings inside built-in guards (eq / notExists operate on literal paths).
// Port the logic directly as a single registered guard per install —
// `writerAuthority_{id}` — that reads ctx.block.author and derives
// the instance path from the cell path via the owner-segment index.
//
// Behavior of the rule, matching v1:
//   (a) no holder set at instance — first claim allowed
//   (b) holder matches block.author — rightful writer
//   (c) session status is 'expired' — heartbeat lapsed, takeover allowed
//   (d) block came from a cascade (block.cause.ruleId present) — bypass
//       (v2 equivalent of v1's `systemInternal` flag; class-body mounts
//       and observation-emitted follow-ups are substrate transitions,
//       not user claims)
// Otherwise the write is rejected (block suspended).
//
// Usage:
//   installWriterAuthority(seq, { scope: 'sessions', ownerSegmentIndex: 1 });
//   // Now any write to sessions.alice.* requires block.author === 'alice'
//   // (or one of the takeover conditions).
// ═══════════════════════════════════════════════════════════════════════

export function installWriterAuthority(
  seq: Sequence,
  config: {
    /** Path prefix the rule scopes to (e.g. 'sessions'). */
    scope: string;
    /**
     * 0-based index of the segment that names the owner. For
     * `sessions.{user}.*` this is 1 (segment 0 is 'sessions', segment 1
     * is the user identity). The instance path is `segments[0..this+1].join('.')`.
     */
    ownerSegmentIndex: number;
    /** Optional explicit id; default derived from scope. */
    id?: string;
    /**
     * Optional — override the holder-path template. Default:
     * `${instancePath}.holder`. Supports the common case where the
     * owner record lives one level below the instance path.
     */
    holderField?: string;
    /**
     * Optional — override the status-path template. Default:
     * `${instancePath}.status`. Set to null to disable the
     * expired-session takeover condition.
     */
    statusField?: string | null;
  },
): void {
  const id = config.id ?? `writer_authority_${config.scope.replace(/\./g, '_')}`;
  const guardOp = `_writerAuthority_${id}`;
  const holderField = config.holderField ?? 'holder';
  const statusField = config.statusField === undefined ? 'status' : config.statusField;

  seq.guards.set(guardOp, (_c, s, ctx) => {
    const block = ctx.block;
    if (!block) return true;

    // v2's systemInternal equivalent — cascade-emitted blocks bypass.
    if (block.cause?.ruleId) return true;

    const path = ctx.cell.path;
    const segments = path.split('.');
    // Path too shallow to extract an instance — fail-open. This keeps the
    // rule from interfering with writes at the scope root itself.
    if (segments.length <= config.ownerSegmentIndex) return true;

    const instancePath = segments.slice(0, config.ownerSegmentIndex + 1).join('.');
    const author = block.author;

    // (a) no holder yet → first claim allowed
    const holderPath = `${instancePath}.${holderField}`;
    const holder = s.get(holderPath);
    if (holder === undefined) return true;

    // (b) rightful writer
    if (holder === author) return true;

    // (c) expired session → takeover allowed
    if (statusField !== null) {
      const status = s.get(`${instancePath}.${statusField}`);
      if (status === 'expired') return true;
    }

    return false;
  });

  seq.insert({
    path: `_rules.${id}`,
    rules: [{
      id,
      phase: 'admission',
      scope: config.scope,
      when: { op: guardOp, args: [] },
    }],
  });
}


// ═══════════════════════════════════════════════════════════════════════
// SESSION LIFECYCLE (ported from v1 session-rules).
//
// Ported from v1 commit cf27d83. Four index_spec classes drive session
// status + holder release as pure type state — no setInterval, no tick
// scheduler, no TS iteration over sessions.*:
//
//   _sessions.active         — heartbeat within activeWindowMs   → status='active'
//   _sessions.idle           — between active and expiry windows → status='idle'
//   _sessions.expired        — heartbeat beyond expiryWindowMs   → status='expired'
//   _sessions.holderRelease  — holder's identity has a disconnectedAt
//                              fact → clear sessions.{user}.holder
//
// Re-projects on any `sessions.*` change OR any `_rt` advance. The
// fixpoint loop in indexSpecDriver handles propagation — when heartbeat
// updates or _rt advances, every session is re-classified and the
// correct class fires.
//
// The three status classes are mutually-exclusive by construction:
// each filter is disjoint in the age axis. A heartbeat age lands in
// exactly one bucket. Body idempotence via the kernel's compose
// same-value check means the class fires on every cascade but only
// actually writes when the status value changes.
//
// HolderRelease uses two-variable binding (user + holder) + a deref
// into the holder's identity path to read disconnectedAt. On the event
// the rule deletes sessions.{user}.holder (op:'delete' → invalidate),
// satisfying the writer-authority law's "no-holder" condition for the
// next claimant.
// ═══════════════════════════════════════════════════════════════════════

export interface SessionLifecycleConfig {
  /** Heartbeat fresher than this is 'active'. Default 30_000ms. */
  activeWindowMs?: number;
  /** Heartbeat older than this is 'expired'. Default 120_000ms. */
  expiryWindowMs?: number;
  /** Path prefix for session cells. Default 'sessions'. */
  sessionsPrefix?: string;
}

export function installSessionLifecycle(
  seq: Sequence,
  config: SessionLifecycleConfig = {},
): void {
  const activeWindowMs = config.activeWindowMs ?? 30_000;
  const expiryWindowMs = config.expiryWindowMs ?? 120_000;
  const prefix = config.sessionsPrefix ?? 'sessions';

  // SessionActive: heartbeat > (_rt - activeWindow)
  seq.insert({
    path: `_sessions.active`,
    type: createType('any', [
      indexSpec({
        indexedBy: ['user'],
        where: [
          bindFrom('user', `${prefix}.*`),
          { op: 'exists', args: [`user.heartbeat`] },
          { op: 'gt', args: [`user.heartbeat`, { op: '-', lhs: '_rt', rhs: activeWindowMs }] },
        ],
        body: [
          { op: 'bind', path: `${prefix}.{user}.status`, value: 'active' },
        ],
      }),
    ]),
  });

  // SessionIdle: (_rt - expiryWindow) < heartbeat <= (_rt - activeWindow)
  seq.insert({
    path: `_sessions.idle`,
    type: createType('any', [
      indexSpec({
        indexedBy: ['user'],
        where: [
          bindFrom('user', `${prefix}.*`),
          { op: 'exists', args: [`user.heartbeat`] },
          { op: 'lte', args: [`user.heartbeat`, { op: '-', lhs: '_rt', rhs: activeWindowMs }] },
          { op: 'gt', args: [`user.heartbeat`, { op: '-', lhs: '_rt', rhs: expiryWindowMs }] },
        ],
        body: [
          { op: 'bind', path: `${prefix}.{user}.status`, value: 'idle' },
        ],
      }),
    ]),
  });

  // SessionExpired: heartbeat <= (_rt - expiryWindow) — session is forfeit,
  // any new author can take over per writer-authority condition (c).
  seq.insert({
    path: `_sessions.expired`,
    type: createType('any', [
      indexSpec({
        indexedBy: ['user'],
        where: [
          bindFrom('user', `${prefix}.*`),
          { op: 'exists', args: [`user.heartbeat`] },
          { op: 'lte', args: [`user.heartbeat`, { op: '-', lhs: '_rt', rhs: expiryWindowMs }] },
        ],
        body: [
          { op: 'bind', path: `${prefix}.{user}.status`, value: 'expired' },
          { op: 'bind', path: `${prefix}.{user}.expiredAt`, value: { _deref: '_rt' } },
        ],
      }),
    ]),
  });
}


// ═══════════════════════════════════════════════════════════════════════
// HOLDER RELEASE — clears `sessions.{user}.holder` when the identity
// currently holding has a `disconnectedAt` fact set. Pure event
// calculus: graceful disconnect → disconnectedAt mount → this class
// fires → holder cleared → writer-authority law admits next claimant.
//
// Ports v1's registerHolderRelease. Relies on the kernel + stdlib
// additions landed alongside installSessionLifecycle: gt/lt/arithmetic
// in indexSpec filters, op:'delete' → invalidate translation.
// ═══════════════════════════════════════════════════════════════════════

export function installHolderRelease(
  seq: Sequence,
  config: { sessionsPrefix?: string } = {},
): void {
  const prefix = config.sessionsPrefix ?? 'sessions';
  seq.insert({
    path: `_sessions.holderRelease`,
    type: createType('any', [
      indexSpec({
        indexedBy: ['user', 'holder'],
        where: [
          bindFrom('user', `${prefix}.*`),
          bindFrom('holder', `${prefix}.{user}.holder`),
          { op: 'exists', args: [`holder.disconnectedAt`] },
        ],
        body: [
          { op: 'delete', path: `${prefix}.{user}.holder` },
        ],
      }),
    ]),
  });
}


// ═══════════════════════════════════════════════════════════════════════
// SESSION AUTH TOKENS (ported from v1 auth.ts, commit 8183776).
//
// HMAC-SHA256 signed tokens asserting a user identity with an expiry.
// The secret lives at `id.server.token_secret` with `partition('id')` —
// type-level access control, not procedural gates. Mint and validate
// are pure functions that can be audited in isolation; `installAuthCaps`
// wires them onto a Sequence as fn-kind cells so invocations flow
// through the commitment machinery like any other tool.
//
// What this is NOT:
//   - OAuth / JWT interop. Token format is domain-specific JSON.
//   - A credential check. mintSessionToken SIGNS an asserted identity;
//     caller must have already validated credentials.
//   - Asymmetric. Same process mints and validates; HMAC suffices.
//     Federation (one node mints, another validates with shared key
//     OR ed25519 pub) is a swap-in at this primitive's boundary.
// ═══════════════════════════════════════════════════════════════════════

export interface SessionToken {
  user: string;
  expiresAt: number;
  signature: string;
}

export type AuthValidationResult =
  | { ok: true; user: string; expiresAt: number }
  | { ok: false; reason: 'malformed' | 'signature_mismatch' | 'expired' };

/** Unit-separator-delimited canonicalization so `|` or newline in a
 *  username can't smuggle an alternate canonical form past HMAC. */
function signAuthPayload(user: string, expiresAt: number, secret: string): string {
  return nodeCrypto.createHmac('sha256', secret)
    .update(`${user}${expiresAt}`)
    .digest('hex');
}

/** Mint a token asserting `user`'s identity through `expiresAt`.
 *  Caller has already validated credentials; this signs the assertion. */
export function mintSessionToken(
  user: string, expiresAt: number, secret: string,
): SessionToken {
  if (typeof user !== 'string' || user.length === 0) {
    throw new Error('mintSessionToken: user must be a non-empty string');
  }
  if (!Number.isFinite(expiresAt)) {
    throw new Error('mintSessionToken: expiresAt must be a finite number');
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('mintSessionToken: secret must be a non-empty string');
  }
  return {
    user,
    expiresAt,
    signature: signAuthPayload(user, expiresAt, secret),
  };
}

/** Validate a token. Returns the user if signature matches current
 *  secret AND token hasn't expired; else a reason the caller can
 *  branch on without distinguishing tamper from expiry externally. */
export function validateSessionToken(
  token: unknown, secret: string, now: number = Date.now(),
): AuthValidationResult {
  if (
    !token ||
    typeof token !== 'object' ||
    typeof (token as any).user !== 'string' ||
    typeof (token as any).expiresAt !== 'number' ||
    typeof (token as any).signature !== 'string'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const t = token as SessionToken;
  const expected = signAuthPayload(t.user, t.expiresAt, secret);
  let sigMatch = false;
  try {
    sigMatch = nodeCrypto.timingSafeEqual(
      Buffer.from(t.signature, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    sigMatch = false;
  }
  if (!sigMatch) return { ok: false, reason: 'signature_mismatch' };
  if (t.expiresAt <= now) return { ok: false, reason: 'expired' };
  return { ok: true, user: t.user, expiresAt: t.expiresAt };
}

/** Fresh 64-byte (512-bit) random secret, hex-encoded. */
export function generateTokenSecret(): string {
  return nodeCrypto.randomBytes(64).toString('hex');
}

// ─── CAPABILITY WIRING ──────────────────────────────────────────────

export interface AuthCapsConfig {
  /** Explicit secret. Tests needing determinism pass one in;
   *  production boot omits this and a fresh random secret is
   *  generated at install time. */
  secret?: string;
}

export function installAuthCaps(
  seq: Sequence, config: AuthCapsConfig = {},
): { secret: string } {
  const secret = config.secret ?? generateTokenSecret();

  // Secret in the identity partition. Type constraint carries the
  // partition declaration (type.ts `partition('id')`). The schema
  // goes first so the partition is known at value-mount time.
  seq.insert({
    path: 'id.server.token_secret',
    type: createType('string', [{ op: 'partition', args: ['id'] } as Constraint]),
  });
  seq.insert({ path: 'id.server.token_secret', value: secret });

  // mint cap — closures over seq so secret rotation (future) flows
  // through without re-mounting.
  installTool(seq, 'auth.mintSessionToken', {
    description: 'Sign a session token for a user identity.',
    inputType: createType('object', [
      { op: 'property', args: ['user', createType('string'), false] } as Constraint,
      { op: 'property', args: ['expiresAt', createType('number'), false] } as Constraint,
    ]),
    outputType: createType('object', [
      { op: 'property', args: ['user', createType('string'), false] } as Constraint,
      { op: 'property', args: ['expiresAt', createType('number'), false] } as Constraint,
      { op: 'property', args: ['signature', createType('string'), false] } as Constraint,
    ]),
    impl: (input: any) => {
      const s = seq.get('id.server.token_secret') as string;
      return mintSessionToken(input.user, input.expiresAt, s);
    },
  });

  // validate cap — reads clock from seq._rt (not wall time) so fake
  // clocks and snapshot replays get consistent expiry behavior.
  installTool(seq, 'auth.validateSessionToken', {
    description: 'Verify a session token and return the asserted user.',
    inputType: createType('object', [
      { op: 'property', args: ['token', createType('any'), false] } as Constraint,
    ]),
    outputType: createType('object'),
    impl: (input: any) => {
      const s = seq.get('id.server.token_secret') as string;
      const now = (seq.get('_rt') as number | undefined) ?? Date.now();
      return validateSessionToken(input.token, s, now);
    },
  });

  return { secret };
}


// ═══════════════════════════════════════════════════════════════════════
// STAMP SESSION TOKEN — port of v1's stampSessionToken helper.
//
// Called by the connect-handshake layer: given a validated token and
// the current connection's identity path, record the binding on the
// user's session cell. Writer-authority law then uses this record to
// admit subsequent writes from that connection.
// ═══════════════════════════════════════════════════════════════════════

export function stampSessionToken(
  seq: Sequence,
  config: {
    token: SessionToken;
    identityPath: string;
    sessionsPrefix?: string;
  },
): AuthValidationResult {
  const prefix = config.sessionsPrefix ?? 'sessions';
  const secret = seq.get('id.server.token_secret') as string | undefined;
  if (!secret) {
    return { ok: false, reason: 'malformed' };
  }
  const now = (seq.get('_rt') as number | undefined) ?? Date.now();
  const result = validateSessionToken(config.token, secret, now);
  if (!result.ok) return result;

  // Stamp session fields as the connection's identity path — the
  // same value going into `holder`. Writer-authority compares the
  // author to the holder literally, so subsequent writes from this
  // same connection (same identityPath in block.author) pass.
  // This matches v1's pattern: authors ARE identity paths, not
  // user names.
  const author = config.identityPath;
  seq.insert({
    path: `${prefix}.${result.user}.user`,
    value: result.user,
    author,
  });
  seq.insert({
    path: `${prefix}.${result.user}.holder`,
    value: config.identityPath,
    author,
  });
  seq.insert({
    path: `${prefix}.${result.user}.tokenExpiry`,
    value: result.expiresAt,
    author,
  });
  return result;
}

