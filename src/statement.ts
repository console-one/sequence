/**
 * statement.ts — The primary durable form.
 *
 * A statement is IMMUTABLE once created. Status is set at creation
 * and never changed. State changes (invalidation, resume) are NEW
 * statements, not mutations to existing ones.
 *
 * Statements are grouped into BLOCKS. A block is the unit of tell:
 * all entries in a block are evaluated against the head at block start.
 * The block either applies entirely or suspends entirely (atomic).
 *
 * Cascade fires once after a block, not after each entry.
 */

import { type Constraint } from './type';

// ═══════════════════════════════════════════════════════════════════════
// STATEMENT
// ═══════════════════════════════════════════════════════════════════════

export type StatementOp =
  | 'bind'         // write a value at a path
  | 'delete'       // remove a value at a path
  | 'schema'       // set type constraint at a path
  | 'cap'          // register a capability
  | 'policy'       // set transition/interpolation policy
  | 'invalidate'   // invalidate a prior statement (by targetSeq)
  ;

export type Statement = {
  readonly seq: number;
  readonly time: number;
  readonly op: StatementOp;
  readonly path: string;
  readonly value: unknown;
  readonly blockSeq: number;         // which block this belongs to
  readonly status: 'applied' | 'suspended';  // IMMUTABLE. set once at creation.
};

// ═══════════════════════════════════════════════════════════════════════
// BLOCK — the unit of mount (atomic)
// ═══════════════════════════════════════════════════════════════════════

/** An entry in a mount block. */
export type MountEntry = {
  readonly op: StatementOp;
  readonly path: string;
  readonly value: unknown;
};


/** Options on a block (shared by all entries). */
export type BlockOpts = {
  readonly where?: readonly Constraint[];
  readonly while?: readonly Constraint[];
  readonly onBreakPath?: string;
  /** Identity of the actor that created this block (for audit/permissions). */
  readonly author?: string;
  /**
   * Concept label for the block. Used by backlinks and render-time
   * projections: when a .ft file is being rendered as the contents
   * of an in-process mount, its block carries a label referring to
   * the concept it backlinks to. Index constraints project labeled
   * whiles to build backlink sets without separate TypeScript
   * machinery.
   */
  readonly label?: string;
};

/** A block: the atomic unit stored in the sequence. */
export type Block = {
  readonly seq: number;              // block sequence number
  readonly time: number;
  readonly entries: readonly MountEntry[];
  readonly where?: readonly Constraint[];
  readonly while?: readonly Constraint[];
  readonly onBreakPath?: string;
  readonly status: 'applied' | 'suspended';  // IMMUTABLE
  /** Identity of the actor that created this block (for audit/permissions). */
  readonly author?: string;
  /** Concept label for the block. See BlockOpts.label. */
  readonly label?: string;
};

// ═══════════════════════════════════════════════════════════════════════
// REF — product-space addressing (path × sequence)
// ═══════════════════════════════════════════════════════════════════════

export type Ref = {
  readonly path: string;
  readonly seq?: number | 'current' | 'previous';
};

export function ref(path: string, seq?: number | 'current' | 'previous'): Ref {
  return seq !== undefined ? { path, seq } : { path };
}
