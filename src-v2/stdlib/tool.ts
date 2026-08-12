import {
  type Constraint, type Type, createType, param, returns, impl, derived,
} from '../../src/type';
import {
  type Sequence,
} from '../sequence';
import { bumpVersion } from './render';

// ═══════════════════════════════════════════════════════════════════════
// installTool — mount a typed callable cell, bump the tools registry
// version so the derived 1.2 section re-computes.
// ═══════════════════════════════════════════════════════════════════════

export function installTool(
  seq: Sequence,
  path: string,
  config: {
    inputType: Type;
    outputType: Type;
    impl: (input: any) => unknown;
    description?: string;
    claims?: Constraint[];
    source?: { id: string; displayName?: string };
  },
): void {
  seq.impls.set(path, config.impl);
  const fnType = createType('fn', [
    param(config.inputType),
    returns(config.outputType),
    impl(path),
    ...(config.claims ?? []),
  ]);
  seq.insert({ path, type: fnType });
  if (config.description) {
    seq.insert({ path: `${path}._description`, value: config.description });
  }
  if (config.source) {
    seq.insert({ path: `${path}._source.id`, value: config.source.id });
    if (config.source.displayName) {
      seq.insert({ path: `${path}._source.displayName`, value: config.source.displayName });
    }
  }
  bumpVersion(seq, '_prompt.registry.tools_version');
}

