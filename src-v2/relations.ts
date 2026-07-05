/**
 * relations.ts (v2) — THE two budget/threshold relations, defined once.
 *
 * A budget is the type relation `value ≤ limit` expressed as the
 * sequence type `number ∧ max(limit)` and evaluated by `check` — never
 * a hand-rolled `>`. `reachedMin` is the dual (`value ≥ threshold`,
 * `number ∧ min(threshold)`); every firing law is an instance of it.
 * There is no budget object behind either — only the relation over the
 * accumulating value and its declared limit.
 *
 * Moved here from observatory's constraint-relation.ts (2026-07-05, the
 * one-evaluator-at-the-edge closure): the desktop gate, the firing
 * laws, and the deployed topic-service admission gate all consume THIS
 * definition — one relation, three tiers, zero twins.
 *
 * Fail-CLOSED: a non-finite value or limit denies. `check` is fail-open
 * on NaN (`NaN > limit` is false, so `max` doesn't gap), so the
 * admission policy lives here in the relation, not in the comparator.
 * `max`/`min` are inclusive (`value === limit` satisfies) — the same
 * boundary the fieldtype evaluator had; seam 1 (PR #41) proved parity
 * over the exhaustive sweep before that path was deleted.
 */

import { createType, max, min } from '../src/type';
import { check } from '../src/compose';

export function withinMax(value: number, limit: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(limit)) return false;
  return check(createType('number', [max(limit)]), value).ok;
}

export function reachedMin(value: number, threshold: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
  return check(createType('number', [min(threshold)]), value).ok;
}
