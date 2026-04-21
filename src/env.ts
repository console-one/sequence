/**
 * env.ts — Load a Sequence from a clock and a snapshot.
 *
 * `loadEnv` is the single env boot path. Every environment
 * (Docker server, AWS Lambda, Unix local, browser) calls this
 * exact function to produce a Sequence. What differs between
 * environments is NOT the loader — it's the snapshot contents
 * (the root type mounted at boot) and the impl shims injected
 * as capabilities at known paths.
 *
 * The Sequence is typed at the root: every Sequence either
 * instantiates a class (user session, agent, env, server) or
 * represents a typed data range. Neither shape needs a TypeScript
 * wrapper around Sequence to add "running" behavior — lifecycle
 * (tick, sync, heartbeat, dispose) is mounted as laws/caps on
 * the root type, not wrapped around the kernel.
 */

import { Sequence, receive, type MountEntry } from './index';
import type { ImportResolver } from './dsl/walker';

export type EnvOpts = {
  /** ft text snapshots to mount in order (root type, bootstrap, workflows). */
  snapshots?: string[];
  /** Raw entries to replay from prior persistence. Replayed before snapshots. */
  entries?: MountEntry[];
  /** Import resolver for loading .ft files referenced from snapshots. */
  resolve?: ImportResolver;
  /**
   * Env-specific capability implementations to inject at known paths
   * after snapshots mount. The snapshot's class definitions reference
   * these paths declaratively; the loader plugs in the concrete
   * runtime (filesystem, scheduler, HTTP, storage) that each env
   * provides. A Unix client injects `fs.readFile`, `fs.writeFile`,
   * `schedule.every`, etc.; a Lambda env injects SQS/EventBridge-
   * backed equivalents; etc.
   */
  impls?: Record<string, Function>;
};

/**
 * Boot a Sequence with a clock, replay any persisted entries,
 * parse any ft text snapshots, and inject capability impls. Returns
 * a plain Sequence — no wrapper type. Callers talk to the sequence
 * directly via `receive()`, `hoist()`, and the kernel API.
 *
 * @param clock — time source (e.g., Date.now)
 * @param opts  — snapshots, entries, resolver, impl shims
 */
export function loadEnv(clock: () => number, opts?: EnvOpts): Sequence {
  const seq = new Sequence(clock);

  if (opts?.entries) {
    for (const entry of opts.entries) {
      seq.mount(entry.op, entry.path, entry.value);
    }
  }

  if (opts?.snapshots) {
    for (const ft of opts.snapshots) {
      receive(ft, seq, opts.resolve);
    }
  }

  if (opts?.impls) {
    for (const [path, impl] of Object.entries(opts.impls)) {
      seq.mount('cap', path, impl);
    }
  }

  return seq;
}
