/**
 * agent-loop.ts (v2) — the LLM-operates-the-environment loop, on THE kernel.
 *
 * Deletion-ledger stage 2 (2026-07-17): supersedes sequenceutils'
 * v1 agent loop. One turn:
 *
 *   1. FRAME    hoistCatalog(seq) — the typed capability catalog — plus
 *               hoist(seq) — concrete state. One rendering, LLM flavor.
 *   2. LLM      injected LLMCall (provider-agnostic, ft-text in/out).
 *   3. EXECUTE  receiveCalls(seq, response) — assignments, calls against
 *               registered impls, definitions-as-data. Errors are typed.
 *   4. CONVERGE errors re-inject into the next prompt; the loop ends
 *               when the LLM applies nothing new and nothing errored,
 *               or on maxTurns.
 *
 * The convergence signal differs from v1 deliberately: v1 counted
 * unfilled schema gaps (the workspace-suspension model); here the loop
 * is OPERATIONAL — the model acts until it has nothing further to do.
 */

import { hoist } from '../src/hoist';
import { hoistCatalog } from '../src/hoist';
import { receiveCalls, type CallOutcome } from './receive-calls';
import type { Sequence } from './sequence';

export type LLMCall = (
  callId: string,
  input: { messages: { role: string; content: string }[]; model?: string; max_tokens?: number },
  tokensEstimate?: number,
) => Promise<{ ok: boolean; response?: unknown; error?: string }>;

export type TurnRecord = {
  turn: number;
  prompt: string;
  response: string;
  outcomes: CallOutcome[];
  errors: string[];
};

export type LoopResult = {
  turns: TurnRecord[];
  /** Why the loop ended: the model converged (nothing applied, no
   *  errors), the turn budget ran out, or the LLM call itself failed. */
  ended: 'converged' | 'budget' | 'llm-error';
};

const SYSTEM_PROMPT =
  'You operate a typed environment. The user message shows the CATALOG — ' +
  'callable functions as `name { params }` grouped in `pkg = { … }` blocks, ' +
  'with named types like `type XInput = { … }` — and the current STATE as ' +
  '`path = value` lines.\n' +
  'Reply with ONLY ft statements, one per line, no prose and no code fences:\n' +
  '  x = pkg.name({ param: "value" })     call a function, bind its result\n' +
  '  y = "literal"                         bind a value\n' +
  '  f = (a: string) -> [ r = g({ x: a }) ]   define a new function\n' +
  'Later statements can reference earlier binds by name.\n' +
  'When there is nothing further to do, reply with exactly: done';

function extractStatements(response: string): string {
  // Tolerate fenced replies despite the instruction; strip fences and a
  // terminal `done`.
  const defenced = response.replace(/```[a-z]*\n?/g, '').replace(/```/g, '');
  return defenced
    .split('\n')
    .filter((l) => l.trim().toLowerCase() !== 'done')
    .join('\n')
    .trim();
}

function contentOf(response: unknown): string {
  if (typeof response === 'string') return response;
  const r = response as { content?: unknown; text?: unknown; message?: { content?: unknown } };
  if (typeof r?.content === 'string') return r.content;
  if (typeof r?.text === 'string') return r.text;
  if (typeof r?.message?.content === 'string') return r.message.content;
  if (Array.isArray(r?.content)) {
    return (r.content as { text?: string }[]).map((b) => b?.text ?? '').join('\n');
  }
  return JSON.stringify(response ?? '');
}

export async function agentTick(
  seq: Sequence,
  llm: LLMCall,
  turn: number,
  priorErrors: string[] = [],
): Promise<TurnRecord | { llmError: string }> {
  const catalog = hoistCatalog(seq).text;
  const state = hoist(seq, { depth: 4 }).text.trim();
  const errorBlock = priorErrors.length
    ? '\n\n-- Errors from your previous statements (correct these):\n' +
      priorErrors.map((e) => `--   ${e}`).join('\n')
    : '';
  const prompt = [catalog, state].filter(Boolean).join('\n\n') + errorBlock;

  const result = await llm(
    `agent_t${turn}`,
    { messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }] },
    Math.ceil(prompt.length / 4) + 200,
  );
  if (!result.ok) return { llmError: result.error ?? 'llm call failed' };

  const response = contentOf(result.response);
  const source = extractStatements(response);
  const { outcomes, errors } = source
    ? await receiveCalls(seq, source)
    : { outcomes: [], errors: [] };
  return { turn, prompt, response, outcomes, errors };
}

export async function agentLoop(
  seq: Sequence,
  llm: LLMCall,
  opts: { maxTurns?: number } = {},
): Promise<LoopResult> {
  const maxTurns = opts.maxTurns ?? 8;
  const turns: TurnRecord[] = [];
  let priorErrors: string[] = [];
  for (let t = 1; t <= maxTurns; t++) {
    const r = await agentTick(seq, llm, t, priorErrors);
    if ('llmError' in r) return { turns, ended: 'llm-error' };
    turns.push(r);
    if (r.outcomes.length === 0 && r.errors.length === 0) {
      return { turns, ended: 'converged' };
    }
    priorErrors = r.errors;
  }
  return { turns, ended: 'budget' };
}
