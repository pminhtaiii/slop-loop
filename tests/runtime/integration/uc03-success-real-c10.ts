/**
 * The C10 zero-dispatch witness (real-tier contract §(e)–(f) T028; UC-03 T028 C10).
 *
 * C10 asks for the real coder-provider accounting behaviour, not a repair verdict: a call over the
 * per-run ceiling makes no dispatch, while the durable pre-network reservation and observed-usage
 * settlement are recorded. This module drives the *bound* production model port — never a
 * reconstruction of its transport — and reports only what the owner journal and the injected fetch
 * counter observed (SPEC-W5-104).
 *
 * Two calls on one run: a small allowed call that reserves before dispatch and settles its observed
 * usage, then a call whose admitted input ceiling exceeds the whole per-run token budget. The task's
 * own token ledger is sized to admit that reservation, so the only refusal left is the transport's
 * run limiter, which refuses after admission and before `fetch`.
 */
import type { BugTask, ModelPortV02, ProviderAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';

import { C10_WITNESS_SCHEMA, type AttemptIdentity, type C10WitnessBody } from './uc03-success-real-record.ts';
import { providerContext } from './uc03-success-real-provider.ts';

/** The run ceiling the profile pins; the oversized call exceeds its token half. */
export interface RunCeiling {
  readonly totalModelCalls: number;
  readonly perRunInputTokens: number;
  readonly perRunOutputTokens: number;
}

/** The live control head each claim binds to; the owner increments it, so the witness re-reads it. */
export interface ControlHead {
  readonly controlVersion: number;
  readonly epoch: number;
}

/** What the witness needs: the bound port, the counters it observes, and the identity it is bound to. */
export interface C10WitnessInput {
  readonly port: Pick<ModelPortV02, 'propose'>;
  /** Total fetches observed so far; the witness compares before and after each call. */
  readonly fetches: () => number;
  /** Journal counts and control head, as the owner reports them at the moment asked. */
  readonly journal: () => Readonly<{ claims: number; attempts: number; outcomes: number }>;
  readonly control: () => ControlHead;
  readonly task: BugTask;
  /** The task state per call: the owner advances it, so it is re-read rather than cached. */
  readonly state: () => Promise<TaskState>;
  readonly identity: AttemptIdentity;
  readonly ceiling: RunCeiling;
  readonly generation: number;
  readonly commandViewDigest: string | null;
}

/** Token/cost maxima one call declares. */
interface Bounds {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxBillableTokens: number;
  readonly maxCostUsd: number;
}

/**
 * The allowed call: generous maxima so the transport's own admissibility check (which needs the
 * billable bound to cover the whole prompt) passes, and small enough to settle near real usage.
 */
const ALLOWED: Bounds = { maxInputTokens: 16_384, maxOutputTokens: 1_024, maxBillableTokens: 32_768, maxCostUsd: 1 };

/**
 * The refused call: its admitted input ceiling is one token above the whole per-run input budget, so
 * the run limiter refuses it. Its billable ceiling still covers input+output, so the request itself
 * validates and the refusal is the limiter, not the contract.
 */
function oversized(ceiling: RunCeiling): Bounds {
  const maxInputTokens = ceiling.perRunInputTokens + 1;
  const maxOutputTokens = 1;
  return { maxInputTokens, maxOutputTokens, maxBillableTokens: maxInputTokens + maxOutputTokens, maxCostUsd: 1 };
}

/** The response an allowed call settles: one JSON text block and parsed usage. */
export function allowedProviderResponse(modelId: string): Response {
  return new Response(JSON.stringify({ id: 'msg-c10-allowed', model: modelId, content: [{ type: 'text', text: '{"status":"accepted"}' }], usage: { input_tokens: 12, output_tokens: 4 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A call that binds to the current head with a stable id, so each claim is independent. */
async function callAt(input: C10WitnessInput, id: string, bounds: Bounds): Promise<{ context: ProviderAdmissionContextV02; state: TaskState }> {
  const state = await input.state();
  return { context: providerContext(state, input.task, input.control(), 'coder', id, input.generation, bounds), state };
}

/**
 * Runs the witness and returns the artifact body. It asserts nothing: every fact is returned and the
 * caller judges. `refusals` counts calls whose outcome was not `observed`.
 */
export async function runC10Witness(input: C10WitnessInput): Promise<C10WitnessBody> {
  const journalBefore = input.journal();
  const fetchesBefore = input.fetches();

  // (1) The allowed call: the claim reserves before dispatch, then the observed usage settles it.
  const allowed = await callAt(input, 'c10-allowed', ALLOWED);
  await input.port.propose(allowed.state, [], allowed.context.providerRequest, allowed.context);
  const fetchesAtCeiling = input.fetches();

  // (2) The oversized call: the run limiter refuses it after admission and before `fetch`.
  const over = await callAt(input, 'c10-oversized', oversized(input.ceiling));
  const refused = await input.port.propose(over.state, [], over.context.providerRequest, over.context);
  const fetchesAfter = input.fetches();
  const journalAfter = input.journal();

  return Object.freeze({
    schema: C10_WITNESS_SCHEMA,
    campaignId: '',
    caseId: 'C10',
    attempt: 1,
    identity: input.identity,
    provider: Object.freeze({ providerId: 'provider-deepseek', modelId: over.context.providerRequest.modelId, configId: input.task.configId, configVersion: input.task.configVersion }),
    limits: Object.freeze({
      totalModelCalls: input.ceiling.totalModelCalls,
      perRunInputTokens: input.ceiling.perRunInputTokens,
      perRunOutputTokens: input.ceiling.perRunOutputTokens,
      budgetRefs: Object.freeze([...over.context.budgetRefs]),
    }),
    dispatch: Object.freeze({
      fetchesBefore,
      fetchesAfter,
      refusals: refused.outcome === 'observed' ? 0 : 1,
      reason: refused.outcome === 'observed' ? null : boundedReason(refused),
    }),
    journal: Object.freeze({
      claimsBefore: journalBefore.claims,
      claimsAfter: journalAfter.claims,
      outcomesBefore: journalBefore.outcomes,
      outcomesAfter: journalAfter.outcomes,
    }),
    commandViewDigest: input.commandViewDigest,
    disclosure: `the allowed call dispatched ${fetchesAtCeiling - fetchesBefore} fetch(es); the over-ceiling call added ${fetchesAfter - fetchesAtCeiling}.`,
  });
}

/** The refusal reason the model port reports, reduced to its leading bounded code. */
function boundedReason(result: { readonly reason?: unknown }): string | null {
  const reason = typeof result.reason === 'string' ? result.reason : '';
  const [head] = reason.split(':');
  return head && /^[A-Z][A-Z0-9_]{0,63}$/u.test(head) ? head : null;
}
