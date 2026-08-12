import {
  type Type, constraintOf, createType, param, returns, impl, derived, properties,
} from '../../src/type';
import {
  covers,
} from '../../src/compose';
import {
  type Sequence,
} from '../sequence';
import { walkPaths } from './behavioral';

// ═══════════════════════════════════════════════════════════════════════
// AUTO-WIRE SINGLE-TOOL GAPS (ported from v1 sequence.ts::tryAutoWire)
//
// A gap whose required type is covered by EXACTLY ONE registered tool's
// output gains a `derived(toolPath, ...inputPaths)` constraint, so the
// existing cascade fills it automatically when the tool's required
// inputs are present.
//
// Ambiguous gaps (multiple tools cover the type) are NOT wired here —
// resolution belongs to a handler at a containing scope (session,
// process, outer Sequence). The kernel only wires the unambiguous
// sole-match cases.
//
// Preconditions for a gap to be wired:
//   - non-internal path (not under `_*`)
//   - non-fn kind (fns are tools, not gaps)
//   - no value yet (cell.value is undefined)
//   - no existing `derived` constraint on the schema
//
// Preconditions for a tool to be a wire candidate:
//   - kind === 'fn'
//   - registered in `seq.impls` (no impl → can't fire → don't wire)
//   - returns covers the gap's required type (`covers(gap, output)`)
//   - param type is non-object (v2's `computeDerived` calls
//     `fn(...args)` positionally; object-input tools need an explicit
//     packing primitive that this MVP doesn't provide. Object-input
//     auto-wire is a follow-up that requires either a kernel change
//     or a `pack` constraint in compose.)
//
// For a scalar-param tool (e.g. `(n: number) => n + 1`), auto-wire
// emits `derived(toolPath, propertyName)` where propertyName comes
// from `param`'s declared shape. The cascade reads
// `seq.get(propertyName)` and calls the impl with that value.
//
// Cost: O(N_types × N_tools) per type-mount. Acceptable for MVP; an
// index-driven optimization (output-type → tool index, gap-type-shape
// hash) is a future port.
// ═══════════════════════════════════════════════════════════════════════

export function installAutoWire(seq: Sequence): void {
  const ruleId = '_auto_wire';
  let inAutoWire = false;

  seq.emitters.set(ruleId, (ctx) => {
    if (ctx.block.cause?.ruleId === ruleId) return [];
    if (ctx.delta.kind !== 'type') return [];
    // Re-entrancy guard. Auto-wire emits via direct seq.insert() (see
    // below) to bypass same-frame `seen` filtering on the gap cell;
    // this flag prevents the resulting cascades from re-running the
    // wiring walk while we're still inside the original invocation.
    if (inAutoWire) return [];
    inAutoWire = true;

    try {
      // Walk all type-bearing cells once and bucket: gaps and tools.
      type ToolInfo = { path: string; outputType: Type; inputPaths: string[] };
      type GapInfo = { path: string; gapType: Type };
      const tools: ToolInfo[] = [];
      const gaps: GapInfo[] = [];

      walkPaths(seq, '', (p) => {
        if (p.startsWith('_')) return;
        const schema = seq.typeAt(p);
        if (!schema) return;

        if (schema.kind === 'fn') {
          if (!seq.impls.has(p)) return;
          const rc = constraintOf(schema, 'returns');
          const pc = constraintOf(schema, 'param');
          if (!rc || !pc) return;
          const outputType = rc.args[0] as Type;
          const paramType = pc.args[0] as Type;
          // Auto-wire only handles object-param tools — input paths come
          // from the param type's declared properties. Scalar-param tools
          // have no auto-wire convention (no property names to map paths to).
          if (paramType.kind !== 'object') return;
          const inputPaths = properties(paramType)
            .filter(prop => !prop.optional)
            .map(prop => prop.key);
          if (inputPaths.length === 0) return;
          tools.push({ path: p, outputType, inputPaths });
          return;
        }

        if (seq.get(p) !== undefined) return;
        if (constraintOf(schema, 'derived')) return;
        gaps.push({ path: p, gapType: schema });
      });

      if (tools.length === 0 || gaps.length === 0) return [];

      // Wire each single-match gap. v2's `computeDerived` calls the impl
      // positionally — `fn(seq.get(p1), seq.get(p2), ...)` — but the
      // tool's impl was declared against the OBJECT param type. We
      // register a per-wiring wrapper impl that packs the positional
      // args into the declared object shape, then forwards to the real
      // tool. The wrapper id is content-stable so re-mounting is
      // idempotent.
      for (const gap of gaps) {
        const matches = tools.filter(t => covers(gap.gapType, t.outputType));
        if (matches.length !== 1) continue;
        const m = matches[0];
        const realImpl = seq.impls.get(m.path);
        if (typeof realImpl !== 'function') continue;
        const wrapperId = `_auto_wire.wrappers.${
          gap.path.replace(/\./g, '_')
        }__via__${m.path.replace(/\./g, '_')}`;
        if (!seq.impls.has(wrapperId)) {
          const inputKeys = m.inputPaths.slice();
          seq.impls.set(wrapperId, (...args: unknown[]) => {
            const packed: Record<string, unknown> = {};
            inputKeys.forEach((k, i) => { packed[k] = args[i]; });
            return realImpl(packed);
          });
        }
        const newSchema = createType(gap.gapType.kind, [
          ...gap.gapType.constraints,
          derived(wrapperId, ...m.inputPaths),
        ]);
        seq.insert({ path: gap.path, type: newSchema });
      }
    } finally {
      inAutoWire = false;
    }

    return [];
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

