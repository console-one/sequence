import {
  impl,
} from '../../src/type';
import {
  cdf,
} from '../../src/compose';
import {
  type Sequence,
} from '../sequence';
import { concretenessDistribution } from './concreteness';
import { walkPaths } from './behavioral';

// ═══════════════════════════════════════════════════════════════════════
// WORKING-SET RESCORE (ported from v1 sequence.ts::rescoreWorkingSet)
//
// Maintains observable working-set state at `_process.workingSet.*` so
// readers can decide what to surface and what to evict under a budget.
//
// Trigger: any change outside `_*` (skips substrate noise) plus changes
// to `_reader.*` (the budget itself). Skips `_process.workingSet.*` to
// avoid feedback. Custom policy: if `_process.evictionPolicy` is a
// registered impl, call it for `{kept, evicted, promoted}`. Default
// heuristic: score each path by concreteness × betweenness, where
// concreteness is `concretenessDistribution(seq, path).cdf(now+60s)`
// and betweenness is `1 + (in.ref + in.temporal) + (out.ref + out.temporal)`.
// Top `_reader.maxItems` are kept; the rest are evicted.
//
// Outputs at `_process.workingSet.{kept, evicted, promoted, nextLikely}`
// are observable state. Readers cascade from them naturally.
//
// Cost: O(N_cells) per non-internal change. Same caveat as
// `installBehavioralPredicates` and `installAutoWire` — fine for MVP,
// candidate for future indexing.
// ═══════════════════════════════════════════════════════════════════════

export function installWorkingSetRescore(seq: Sequence): void {
  const ruleId = '_working_set_rescore';
  let inRescore = false;

  seq.emitters.set(ruleId, (ctx) => {
    if (ctx.block.cause?.ruleId === ruleId) return [];
    if (inRescore) return [];
    const path = ctx.cell.path;
    // Skip internal paths except `_reader.*` (the budget knob).
    if (path.startsWith('_') && !path.startsWith('_reader.')) return [];

    const budget = seq.get('_reader.maxItems') as number | undefined;
    if (!budget || budget <= 0) return [];

    inRescore = true;
    try {
      // Custom policy override.
      const policyFn = seq.impls.get('_process.evictionPolicy');
      if (typeof policyFn === 'function') {
        try {
          const result = policyFn() as
            | { kept?: unknown[]; evicted?: unknown[]; promoted?: unknown[] }
            | undefined;
          if (result && typeof result === 'object') {
            return [
              { path: '_process.workingSet.kept', value: result.kept ?? [] },
              { path: '_process.workingSet.evicted', value: result.evicted ?? [] },
              { path: '_process.workingSet.promoted', value: result.promoted ?? [] },
            ];
          }
        } catch {
          // Fall through to default heuristic.
        }
      }

      // Default heuristic: score by concreteness × betweenness.
      const now = seq.now();
      const lookaheadT = now + 60_000;
      const scored: { path: string; score: number; reason: string }[] = [];

      walkPaths(seq, '', (p) => {
        if (p.startsWith('_')) return;
        const cell = seq.getCell(p);
        if (!cell) return;
        // Skip skeleton cells with neither value nor type — those are
        // intermediate path nodes auto-created during traversal, not
        // application data.
        if (cell.value === undefined && cell.type === undefined) return;
        const c = concretenessDistribution(seq, p).cdf(lookaheadT);
        const inEdges = (cell.in.ref?.size ?? 0) + (cell.in.temporal?.size ?? 0);
        const outEdges = (cell.out.ref?.size ?? 0) + (cell.out.temporal?.size ?? 0);
        const betweenness = 1 + inEdges + outEdges;
        const score = c * betweenness;
        scored.push({
          path: p,
          score,
          reason: `cdf(t+60s)=${c.toFixed(3)} betweenness=${betweenness}`,
        });
      });

      scored.sort((a, b) => b.score - a.score);
      const kept = scored.slice(0, budget);
      const evicted = scored.slice(budget);

      return [
        { path: '_process.workingSet.kept', value: kept.slice(0, 20) },
        { path: '_process.workingSet.evicted', value: evicted.slice(0, 20) },
        { path: '_process.workingSet.promoted', value: [] },
      ];
    } finally {
      inRescore = false;
    }
  });

  seq.insert({
    path: `_rules.${ruleId}`,
    rules: [{
      id: ruleId,
      phase: 'observation',
      scope: '',
      emit: ruleId,
    }],
  });
}

