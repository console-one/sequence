/**
 * render.ts — The one function. Cluster → Score → Rank → Budget → Hoist.
 *
 * Used for: UI rendering, LLM prompting, memory management, compaction.
 * Same function, different reader constraints. The Sequence re-hoists itself
 * through this after every mount.
 */

import { type Type, constraintsOf } from '../type';
import { type Sequence, type Projection } from '../sequence';

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

export type ReaderConfig = {
  /** Max items (paths/clusters) to include in output. */
  maxItems: number;
  /** Max depth to expand within each cluster. */
  maxDepth: number;
  /** Preference weights — keys match signal names. */
  weights: Record<string, number>;
  /** Learned priors per cluster shape — updated from interaction observations. */
  priors: Map<string, { alpha: number; beta: number }>;
};

export type Cluster = {
  id: string;
  paths: string[];
  gapCount: number;
  concretePaths: number;
  totalPaths: number;
  avgConcreteness: number;
  nearConcreteGaps: number;    // gaps at concreteness 0.7+
  crossClusterDeps: number;    // deps pointing outside this cluster
  internalDeps: number;        // deps within this cluster
  nearestDeadline: number;     // earliest temporal constraint
  shape: string;               // encoded structural fingerprint
};

export type ScoredCluster = {
  cluster: Cluster;
  score: number;
  signals: Record<string, number>;
};

export type RenderResult = {
  text: string;
  clusters: ScoredCluster[];
  evicted: string[];           // paths that were below budget cutoff
  expandTokens: string[];
};

// ═══════════════════════════════════════════════════════════════════════
// THE ONE FUNCTION
// ═══════════════════════════════════════════════════════════════════════

/**
 * Render the Sequence's state for a specific reader.
 * Same function for UI, LLM prompt, memory management, compaction.
 */
export function renderForReader(seq: Sequence, reader: ReaderConfig): RenderResult {
  // 1. Cluster: group paths by dependency connectivity
  const clusters = computeClusters(seq);

  // 2. Score: composite score from signals × weights
  const scored = clusters.map(cluster => scoreCluster(cluster, seq, reader));

  // 3. Rank: sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // 4. Budget: fill reader capacity, track what's evicted
  const { selected, evicted } = budgetSelect(scored, reader.maxItems);

  // 5. Hoist: render each selected cluster as ft text
  const expandTokens: string[] = [];
  const lines: string[] = [];

  for (const s of selected) {
    lines.push(`-- [cluster: ${s.cluster.id}] score=${s.score.toFixed(2)} gaps=${s.cluster.gapCount} concrete=${s.cluster.avgConcreteness.toFixed(2)}`);
    for (const path of s.cluster.paths) {
      const value = seq.get(path);
      const type = seq.typeAt(path);
      if (value !== undefined) {
        lines.push(`${path} = ${renderValue(value)}`);
      } else if (type) {
        lines.push(`${path} = ${renderType(type)}`);
      }
    }
    lines.push('');
  }

  // Evicted clusters become expansion tokens
  if (evicted.length > 0) {
    const evictedPaths: string[] = [];
    for (const s of evicted) {
      const token = `evicted.${s.cluster.id}`;
      expandTokens.push(token);
      lines.push(`[[ ${token} : ${s.cluster.paths.length} paths, ${s.cluster.gapCount} gaps, score=${s.score.toFixed(2)} ]]`);
      evictedPaths.push(...s.cluster.paths);
    }
    return { text: lines.join('\n'), clusters: scored, evicted: evictedPaths, expandTokens };
  }

  return { text: lines.join('\n'), clusters: scored, evicted: [], expandTokens };
}

// ═══════════════════════════════════════════════════════════════════════
// CLUSTER COMPUTATION — group paths by dependency connectivity
// ═══════════════════════════════════════════════════════════════════════

function computeClusters(seq: Sequence): Cluster[] {
  const proj = seq.projection;
  const allPaths = new Set<string>();

  // Collect all non-internal paths
  for (const [path] of seq.iterateValues()) {
    if (!path.startsWith('_')) allPaths.add(path.split('.')[0]);
  }
  for (const [path] of seq.iterateTypes()) {
    if (!path.startsWith('_')) allPaths.add(path.split('.')[0]);
  }

  // Build adjacency from depIndex
  const adj = new Map<string, Set<string>>();
  for (const path of allPaths) {
    if (!adj.has(path)) adj.set(path, new Set());
  }
  for (const [source, deps] of proj.depIndex) {
    const srcRoot = source.split('.')[0];
    for (const dep of deps) {
      const depRoot = dep.split('.')[0];
      if (srcRoot !== depRoot && allPaths.has(srcRoot) && allPaths.has(depRoot)) {
        if (!adj.has(srcRoot)) adj.set(srcRoot, new Set());
        if (!adj.has(depRoot)) adj.set(depRoot, new Set());
        adj.get(srcRoot)!.add(depRoot);
        adj.get(depRoot)!.add(srcRoot);
      }
    }
  }

  // Connected components via BFS
  const visited = new Set<string>();
  const clusters: Cluster[] = [];

  for (const path of allPaths) {
    if (visited.has(path)) continue;
    const component: string[] = [];
    const queue = [path];
    while (queue.length > 0) {
      const p = queue.shift()!;
      if (visited.has(p)) continue;
      visited.add(p);
      component.push(p);
      const neighbors = adj.get(p);
      if (neighbors) for (const n of neighbors) {
        if (!visited.has(n)) queue.push(n);
      }
    }

    // Expand each root path to include all sub-paths
    const expandedPaths: string[] = [];
    for (const root of component) {
      expandedPaths.push(root);
      const subKeys = seq.keys(root);
      for (const sk of subKeys) expandedPaths.push(`${root}.${sk}`);
    }

    clusters.push(buildCluster(component.join('+'), expandedPaths, seq, allPaths));
  }

  // Singletons without deps are their own cluster (already handled)
  return clusters;
}

function buildCluster(id: string, paths: string[], seq: Sequence, allPaths: Set<string>): Cluster {
  let gapCount = 0;
  let concretePaths = 0;
  let nearConcreteGaps = 0;
  let concreteSum = 0;
  let crossClusterDeps = 0;
  let internalDeps = 0;
  let nearestDeadline = Infinity;

  const pathSet = new Set(paths.map(p => p.split('.')[0]));

  for (const path of paths) {
    const value = seq.get(path);
    const type = seq.typeAt(path);
    const c = seq.concreteness(path);

    if (value !== undefined) {
      concretePaths++;
    } else if (type && type.kind !== 'any') {
      gapCount++;
      if (c >= 0.7) nearConcreteGaps++;
    }

    concreteSum += c;

    // Count deps
    const deps = seq.projection.depIndex.get(path);
    if (deps) for (const dep of deps) {
      const depRoot = dep.split('.')[0];
      if (pathSet.has(depRoot)) internalDeps++;
      else if (allPaths.has(depRoot)) crossClusterDeps++;
    }
  }

  // Nearest deadline from nextWake (simplified — could inspect while clauses)
  // For now use the Sequence's global nextWake as a proxy
  nearestDeadline = seq.nextWake();

  const shape = encodeShape(paths.length, gapCount, concretePaths, nearConcreteGaps, crossClusterDeps);

  return {
    id, paths, gapCount, concretePaths,
    totalPaths: paths.length,
    avgConcreteness: paths.length > 0 ? concreteSum / paths.length : 1,
    nearConcreteGaps, crossClusterDeps, internalDeps,
    nearestDeadline, shape,
  };
}

function encodeShape(total: number, gaps: number, concrete: number, nearConcrete: number, crossDeps: number): string {
  return `${total}p-${gaps}g-${concrete}c-${nearConcrete}nc-${crossDeps}xd`;
}

// ═══════════════════════════════════════════════════════════════════════
// SCORING — composite score from signals × weights
// ═══════════════════════════════════════════════════════════════════════

function scoreCluster(cluster: Cluster, seq: Sequence, reader: ReaderConfig): ScoredCluster {
  const w = reader.weights;

  const actionability = cluster.nearConcreteGaps / Math.max(cluster.gapCount, 1);
  const cascadeImpact = cluster.crossClusterDeps / Math.max(cluster.totalPaths, 1);
  const urgency = cluster.nearestDeadline < Infinity
    ? 1 / (1 + Math.max(0, cluster.nearestDeadline - seq.realtime) / 86400000)
    : 0;
  const coherence = cluster.internalDeps / Math.max(cluster.totalPaths, 1);

  // Learned boost from structural pattern
  const prior = reader.priors.get(cluster.shape) ?? { alpha: 1, beta: 1 };
  const learnedBoost = prior.alpha / (prior.alpha + prior.beta);

  const signals: Record<string, number> = { actionability, cascadeImpact, urgency, coherence, learnedBoost };

  const score =
    (w.actionability ?? 0) * actionability +
    (w.cascadeImpact ?? 0) * cascadeImpact +
    (w.urgency ?? 0) * urgency +
    (w.coherence ?? 0) * coherence +
    (w.learnedBoost ?? 0) * learnedBoost;

  return { cluster, score, signals };
}

// ═══════════════════════════════════════════════════════════════════════
// BUDGET SELECTION — fill capacity, track evictions
// ═══════════════════════════════════════════════════════════════════════

function budgetSelect(scored: ScoredCluster[], maxItems: number): { selected: ScoredCluster[]; evicted: ScoredCluster[] } {
  const selected: ScoredCluster[] = [];
  const evicted: ScoredCluster[] = [];
  let count = 0;

  for (const s of scored) {
    if (count + s.cluster.paths.length <= maxItems) {
      selected.push(s);
      count += s.cluster.paths.length;
    } else {
      evicted.push(s);
    }
  }

  return { selected, evicted };
}

// ═══════════════════════════════════════════════════════════════════════
// VALUE/TYPE RENDERING (ft syntax)
// ═══════════════════════════════════════════════════════════════════════

function renderValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([k, v]) => `${k}: ${renderValue(v)}`).join(', ')} }`;
  }
  return String(value);
}

function renderType(type: Type): string {
  switch (type.kind) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'null': return 'null';
    case 'any': return '[[ gap ]]';
    case 'never': return 'never';
    case 'object': {
      const props = constraintsOf(type, 'property');
      if (props.length === 0) return '{}';
      return `{ ${props.map(p => `${p.args[0]}${p.args[2] ? '?' : ''}: ${renderType(p.args[1] as Type)}`).join(', ')} }`;
    }
    case 'fn': return '(fn)';
    default: return type.kind;
  }
}
