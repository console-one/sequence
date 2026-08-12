import {
  type Constraint, createType, impl,
} from '../../src/type';
import type { IStorage } from '../env/storage';
import {
  type Sequence,
} from '../sequence';
import { installTool } from './tool';

// ═══════════════════════════════════════════════════════════════════════
// installNodeStorage — mount an IStorage instance as substrate-native
// tool cells so the Sequence accesses persistence through the standard
// commitment machinery (and cross-sequence forwarding can transparently
// route storage ops to whichever node owns the disk).
//
// After installNodeStorage(seq, storage, { mountPath: 'storage' }):
//
//   tools.storage.read   { key: string } => { content: string }
//   tools.storage.write  { key: string, data: string } => {}
//   tools.storage.has    { key: string } => { present: boolean }
//   tools.storage.exists { key: string } => { present: boolean }
//   tools.storage.delete { key: string } => {}
//   tools.storage.list   { prefix: string } => { entries: string[] }
//   tools.storage.mkdir  { dir: string } => {}
//   tools.storage.append { key: string, data: string } => {}
//
// Tools surface in the AGENT_PROMPT_FRAME tools section automatically
// via installAgentPrompt's walker over fn-kind cells.
// ═══════════════════════════════════════════════════════════════════════

export function installNodeStorage(
  seq: Sequence,
  storage: IStorage,
  config: { mountPath?: string; sourceId?: string; sourceDisplay?: string } = {},
): void {
  const base = config.mountPath ?? 'tools.storage';
  const sourceId = config.sourceId ?? 'storage';
  const sourceDisplay = config.sourceDisplay ?? 'Storage';

  const stringInput = (field: string) =>
    createType('object', [
      { op: 'property', args: [field, createType('string'), false] } as Constraint,
    ]);
  const writeInput = createType('object', [
    { op: 'property', args: ['key', createType('string'), false] } as Constraint,
    { op: 'property', args: ['data', createType('string'), false] } as Constraint,
  ]);
  const stringOutput = (field: string) =>
    createType('object', [
      { op: 'property', args: [field, createType('string'), false] } as Constraint,
    ]);
  const boolOutput = (field: string) =>
    createType('object', [
      { op: 'property', args: [field, createType('boolean'), false] } as Constraint,
    ]);
  const arrayStringOutput = (field: string) =>
    createType('object', [
      { op: 'property', args: [field,
        createType('array', [
          { op: 'element', args: [createType('string')] } as Constraint,
        ]),
        false,
      ] } as Constraint,
    ]);
  const emptyOutput = createType('object');

  const src = { id: sourceId, displayName: sourceDisplay };

  installTool(seq, `${base}.read`, {
    description: 'Read a UTF-8 string from storage. Throws if missing.',
    inputType: stringInput('key'),
    outputType: stringOutput('content'),
    impl: async (input: any) => ({ content: await storage.read(input.key) }),
    source: src,
  });

  installTool(seq, `${base}.write`, {
    description: 'Write a UTF-8 string. Creates parent directories as needed.',
    inputType: writeInput,
    outputType: emptyOutput,
    impl: async (input: any) => { await storage.write(input.key, input.data); return {}; },
    source: src,
  });

  installTool(seq, `${base}.has`, {
    description: 'True iff a value exists at key (uncached stat).',
    inputType: stringInput('key'),
    outputType: boolOutput('present'),
    impl: async (input: any) => ({ present: await storage.has(input.key) }),
    source: src,
  });

  installTool(seq, `${base}.exists`, {
    description: 'True iff a value exists at key (cache-aware).',
    inputType: stringInput('key'),
    outputType: boolOutput('present'),
    impl: async (input: any) => ({ present: await storage.exists(input.key) }),
    source: src,
  });

  installTool(seq, `${base}.delete`, {
    description: 'Remove a key. No-op if missing.',
    inputType: stringInput('key'),
    outputType: emptyOutput,
    impl: async (input: any) => { await storage.delete(input.key); return {}; },
    source: src,
  });

  installTool(seq, `${base}.list`, {
    description: 'List the direct children of a directory key.',
    inputType: stringInput('prefix'),
    outputType: arrayStringOutput('entries'),
    impl: async (input: any) => ({ entries: await storage.list(input.prefix) }),
    source: src,
  });

  installTool(seq, `${base}.mkdir`, {
    description: 'Ensure a directory exists (recursive mkdir -p).',
    inputType: stringInput('dir'),
    outputType: emptyOutput,
    impl: async (input: any) => { await storage.mkdir(input.dir); return {}; },
    source: src,
  });

  installTool(seq, `${base}.append`, {
    description: 'Append to an existing file, creating parent dirs as needed.',
    inputType: writeInput,
    outputType: emptyOutput,
    impl: async (input: any) => { await storage.append(input.key, input.data); return {}; },
    source: src,
  });
}

