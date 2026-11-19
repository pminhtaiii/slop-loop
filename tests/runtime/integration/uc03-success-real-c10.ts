/**
 * The C10 zero-dispatch witness (real-tier contract §(e)–(f) T028; UC-03 T028 C10).
 *
 * C10 asks for the real coder-provider accounting behaviour, not a repair verdict: a call over the
 * per-run limit makes no dispatch, while the durable pre-network reservation and observed-usage
 * settlement are recorded. This module drives the *bound* production model port — never a
 * reconstruction of its transport — and reports only what the owner journal, the fetch counter and
 * the real transport's own verdict observed (SPEC-W5-104, SPEC-W5-203).
 *
 * The bound port reports every post-claim refusal as `PROVIDER_OUTCOME_PENDING`, so the port's verdict
 * cannot name the limiter. The witness therefore observes the real transport's `execute` result for
 * each request (restored afterwards): a limiter refusal is the transport's own `RUN_USAGE_LIMIT_REACHED`
 * denial, recorded together with the claims already durable when the transport was entered.
 *
 * `judgeC10` is the one predicate the runner and the checker both apply, so they cannot disagree.
 */
import type { BugTask, ModelPortV02, ProviderAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import type { HostModelTransport, HostModelTransportPayload } from '../../../src/foundation/model.ts';

import { C10_WITNESS_SCHEMA, SAFE_ID, type ArtifactBinding, type AttemptIdentity, type C10BudgetCallFacts, type C10CallFacts, type C10WitnessBody } from './uc03-success-real-record.ts';
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

/** The owner journal as the witness reads it: claim ids and the outcome kind of each receipt. */
export interface JournalView {
  readonly claims: readonly string[];
  readonly outcomes: readonly Readonly<{ receiptId: string; outcome: string }>[];
}

/** What the witness needs: the bound port and transport, the counters it observes, and the identity it is bound to. */
export interface C10WitnessInput {
  readonly port: Pick<ModelPortV02, 'propose'>;
  /** The transport the bound port dispatches through; only its result is observed. */
  readonly transport: HostModelTransport;
  /** Total fetches observed so far; the witness compares before and after each call. */
  readonly fetches: () => number;
  readonly journal: () => JournalView;
  readonly control: () => ControlHead;
  readonly task: BugTask;
  /** The task state per call: the owner advances it, so it is re-read rather than cached. */
  readonly state: () => Promise<TaskState>;
  readonly identity: AttemptIdentity;
  readonly campaignId: string;
  readonly binding: ArtifactBinding;
  readonly ceiling: RunCeiling;
  readonly generation: number;
  readonly commandViewDigest: null;
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

/** The journal the owner reports, reduced to the ids and outcome kinds the witness compares. */
export function journalViewOf(snapshot: unknown): JournalView {
  const journal = (typeof snapshot === 'object' && snapshot !== null ? snapshot : {}) as { readonly claims?: readonly { readonly claimId?: unknown }[]; readonly outcomes?: readonly { readonly receiptId?: unknown; readonly outcome?: unknown }[] };
  return {
    claims: (journal.claims ?? []).map(claim => String(claim.claimId)),
    outcomes: (journal.outcomes ?? []).map(entry => ({ receiptId: String(entry.receiptId), outcome: String(entry.outcome) })),
  };
}

/** The refusal reason a transport reports, reduced to its leading bounded code. */
function boundedReason(reason: unknown): string | null {
  const [head] = (typeof reason === 'string' ? reason : '').split(':');
  return head && /^[A-Z][A-Z0-9_]{0,63}$/u.test(head) ? head : null;
}

type Sighting = NonNullable<C10CallFacts['transport']>;

const activeTransports = new WeakSet<HostModelTransport>();

/**
 * Observes the real transport's verdict per provider request id. The wrapper forwards every call
 * unchanged and records the verdict, the claims durable when the transport was entered and the fetch
 * count at that moment; `restore` puts the original back. Enforces exclusive observation per transport
 * (STD-W5-304), refusing concurrent witnesses before mutation.
 */
function observeTransport(transport: HostModelTransport, journal: () => JournalView, fetches: () => number): { readonly seen: ReadonlyMap<string, Sighting>; readonly restore: () => void } {
  if (activeTransports.has(transport)) {
    throw new Error('C10_TRANSPORT_EXCLUSIVE: Transport is already under observation by an active C10 witness');
  }
  activeTransports.add(transport);
  const seen = new Map<string, Sighting>();
  const original = transport.execute;
  const target = transport as { execute: HostModelTransport['execute'] };
  let restored = false;
  target.execute = async (payload: HostModelTransportPayload) => {
    const claimsAtTransport = journal().claims.length;
    const fetchesAtTransport = fetches();
    const result = await original.call(transport, payload);
    const verdict = typeof result === 'object' && result !== null ? (result as { outcome?: unknown; reason?: unknown }) : {};
    // A transport result without an `outcome` is the observed proposal shape.
    seen.set(payload.request.providerRequestId, {
      outcome: typeof verdict.outcome === 'string' ? verdict.outcome : 'observed',
      reasonCode: boundedReason(verdict.reason),
      claimsAtTransport,
      fetchesAtTransport,
    });
    return result;
  };
  return {
    seen,
    restore: () => {
      if (!restored) {
        restored = true;
        target.execute = original;
        activeTransports.delete(transport);
      }
    },
  };
}

/** One call: the admission, the port's verdict and every counter around it. */
async function observeCall(input: C10WitnessInput, seen: ReadonlyMap<string, Sighting>, requestId: string, bounds: Bounds): Promise<C10CallFacts> {
  const state = await input.state();
  const context: ProviderAdmissionContextV02 = providerContext(state, input.task, input.control(), 'coder', requestId, input.generation, bounds);
  const journalBefore = input.journal();
  const fetchesBefore = input.fetches();
  const result = await input.port.propose(state, [], context.providerRequest, context);
  const fetchesAfter = input.fetches();
  const journalAfter = input.journal();
  const knownOutcomes = new Set(journalBefore.outcomes.map(entry => entry.receiptId));
  const usage = result.outcome === 'observed' ? result.observedUsage : undefined;
  return {
    requestId,
    declared: { maxInputTokens: bounds.maxInputTokens, maxOutputTokens: bounds.maxOutputTokens },
    fetchesBefore,
    fetchesAfter,
    portOutcome: result.outcome,
    transport: seen.get(requestId) ?? null,
    claims: { before: journalBefore.claims.length, after: journalAfter.claims.length },
    outcomes: {
      before: journalBefore.outcomes.length,
      after: journalAfter.outcomes.length,
      recorded: journalAfter.outcomes.filter(entry => !knownOutcomes.has(entry.receiptId)).map(entry => entry.outcome),
    },
    observedUsage: usage === undefined ? null : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  };
}

/** Observes one task budget refusal call; the claim must be refused by the owner before transport. */
async function observeBudgetCall(input: C10WitnessInput, requestId: string, kind: 'absent' | 'exhausted', bounds: Bounds): Promise<C10BudgetCallFacts> {
  const state = await input.state();
  const context: ProviderAdmissionContextV02 = providerContext(state, input.task, input.control(), 'coder', requestId, input.generation, bounds);
  const journalBefore = input.journal();
  const fetchesBefore = input.fetches();
  const result = await input.port.propose(state, [], context.providerRequest, context);
  const fetchesAfter = input.fetches();
  const journalAfter = input.journal();
  const knownOutcomes = new Set(journalBefore.outcomes.map(entry => entry.receiptId));
  const tokensLedger = state.budgetLedgers?.find(entry => entry.kind === 'tokens');
  const reserved = tokensLedger?.reservations.reduce((sum, res) => sum + res.amount, 0) ?? 0;
  return {
    requestId,
    kind,
    declared: { maxInputTokens: bounds.maxInputTokens, maxOutputTokens: bounds.maxOutputTokens, maxBillableTokens: bounds.maxBillableTokens },
    budgetRefs: context.budgetRefs,
    reservationRef: context.requestReservationReceipt ?? context.budgetRefs[0] ?? `res-${requestId}`,
    ledger: {
      limit: input.task.budgetLimits.maxTokens,
      consumedBefore: tokensLedger?.consumed ?? 0,
      reservedBefore: reserved,
      consumedAfter: tokensLedger?.consumed ?? 0,
      reservedAfter: reserved,
    },
    requestedBillable: bounds.maxBillableTokens,
    fetchesBefore,
    fetchesAfter,
    portOutcome: result.outcome,
    refusal: boundedReason(result.reason) ?? 'CLAIM_DENIED',
    transport: null,
    claims: { before: journalBefore.claims.length, after: journalAfter.claims.length },
    outcomes: {
      before: journalBefore.outcomes.length,
      after: journalAfter.outcomes.length,
      recorded: journalAfter.outcomes.filter(entry => !knownOutcomes.has(entry.receiptId)).map(entry => entry.outcome),
    },
  };
}

/**
 * Runs the witness and returns the artifact body. It asserts nothing: every fact is returned and
 * `judgeC10` judges. The allowed call settles observed usage; the oversized call must be refused by
 * the run limiter before `fetch`.
 */
export async function runC10Witness(input: C10WitnessInput): Promise<C10WitnessBody> {
  const observer = observeTransport(input.transport, input.journal, input.fetches);
  let allowed: C10CallFacts;
  let refused: C10CallFacts;
  let absent: C10BudgetCallFacts;
  let exhausted: C10BudgetCallFacts;
  const budgetBounds: Bounds = {
    maxInputTokens: input.task.budgetLimits.maxTokens + 1,
    maxOutputTokens: 1,
    maxBillableTokens: input.task.budgetLimits.maxTokens + 2,
    maxCostUsd: 1,
  };
  try {
    absent = await observeBudgetCall(input, 'c10-budget-absent', 'absent', budgetBounds);
    allowed = await observeCall(input, observer.seen, 'c10-allowed', ALLOWED);
    exhausted = await observeBudgetCall(input, 'c10-budget-exhausted', 'exhausted', budgetBounds);
    refused = await observeCall(input, observer.seen, 'c10-oversized', oversized(input.ceiling));
  } finally {
    observer.restore();
  }
  return Object.freeze({
    schema: C10_WITNESS_SCHEMA,
    campaignId: input.campaignId,
    caseId: 'C10',
    attempt: 1,
    binding: input.binding,
    finalSnapshotDigest: null,
    identity: input.identity,
    provider: Object.freeze({ providerId: 'provider-deepseek', modelId: input.binding.model, configId: input.task.configId, configVersion: input.task.configVersion }),
    limits: Object.freeze({
      totalModelCalls: input.ceiling.totalModelCalls,
      perRunInputTokens: input.ceiling.perRunInputTokens,
      perRunOutputTokens: input.ceiling.perRunOutputTokens,
      budgetRefs: Object.freeze([]),
    }),
    calls: Object.freeze({ allowed, refused }),
    budgets: Object.freeze({ absent, exhausted }),
    commandViewDigest: input.commandViewDigest,
    commandViewScope: 'not-applicable-provider-only' as const,
    disclosure: `the allowed call dispatched ${allowed.fetchesAfter - allowed.fetchesBefore} fetch(es); the over-limit call dispatched ${refused.fetchesAfter - refused.fetchesBefore}.`,
  });
}

/** The reservation the owner must have made durable before the transport was entered. */
const durableBeforeTransport = (call: C10CallFacts): boolean => call.claims.after - call.claims.before === 1 && call.transport !== null && call.transport.claimsAtTransport === call.claims.after;

/**
 * The C10 predicate (real-tier §(f)): the allowed call reserved before the network, dispatched once
 * and settled observed usage; the call over the per-run limit was refused by the limiter itself with
 * zero dispatch for that call. Returns the first failing reason code, or `undefined` for a pass.
 */
export function judgeC10(body: C10WitnessBody): string | undefined {
  if (!body.budgets) return 'c10-budgets-missing';
  const { absent, exhausted } = body.budgets;
  if (!absent || !exhausted) return 'c10-budgets-missing';
  if (absent.kind !== 'absent' || exhausted.kind !== 'exhausted') return 'c10-budgets-invalid';
  if (absent.fetchesAfter !== absent.fetchesBefore) return 'c10-budget-absent-dispatched';
  if (absent.transport !== null || absent.refusal !== 'CLAIM_DENIED') return 'c10-budget-absent-not-denied';
  if (exhausted.fetchesAfter !== exhausted.fetchesBefore) return 'c10-budget-exhausted-dispatched';
  if (exhausted.transport !== null || exhausted.refusal !== 'CLAIM_DENIED') return 'c10-budget-exhausted-not-denied';

  const { allowed, refused } = body.calls;
  if (allowed.requestId === refused.requestId) return 'c10-requests-not-distinct';
  if (allowed.portOutcome !== 'observed' || allowed.transport?.outcome !== 'observed') return 'c10-allowed-not-observed';
  if (allowed.fetchesAfter - allowed.fetchesBefore !== 1) return 'c10-allowed-dispatch-count';
  if (!durableBeforeTransport(allowed)) return 'c10-allowed-no-reservation';
  if (allowed.observedUsage === null) return 'c10-allowed-usage-unobserved';
  if (allowed.outcomes.recorded.length !== 1 || allowed.outcomes.recorded[0] !== 'observed') return 'c10-allowed-not-settled';
  if (refused.declared.maxInputTokens <= body.limits.perRunInputTokens) return 'c10-refused-not-over-limit';
  if (refused.fetchesAfter !== refused.fetchesBefore) return 'c10-refused-dispatched';
  if (refused.portOutcome === 'observed') return 'c10-refused-observed';
  if (refused.transport === null || refused.transport.outcome !== 'denied' || refused.transport.reasonCode !== 'RUN_USAGE_LIMIT_REACHED') return 'c10-refusal-not-limiter';
  if (refused.transport.fetchesAtTransport !== refused.fetchesBefore) return 'c10-refused-dispatched';
  if (!durableBeforeTransport(refused)) return 'c10-refused-no-reservation';
  if (refused.outcomes.recorded.includes('observed')) return 'c10-refused-settled-observed';
  return undefined;
}

type Raw = Record<string, unknown>;
const isRaw = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function parseCall(value: unknown): C10CallFacts | undefined {
  if (!isRaw(value) || typeof value['requestId'] !== 'string' || !SAFE_ID.test(value['requestId']) || typeof value['portOutcome'] !== 'string') return undefined;
  const { declared, claims, outcomes, transport, observedUsage } = value;
  if (!isRaw(declared) || !count(declared['maxInputTokens']) || !count(declared['maxOutputTokens'])) return undefined;
  if (!count(value['fetchesBefore']) || !count(value['fetchesAfter'])) return undefined;
  if (!isRaw(claims) || !count(claims['before']) || !count(claims['after'])) return undefined;
  if (!isRaw(outcomes) || !count(outcomes['before']) || !count(outcomes['after']) || !Array.isArray(outcomes['recorded']) || !outcomes['recorded'].every(kind => typeof kind === 'string')) return undefined;
  if (transport !== null && (!isRaw(transport) || typeof transport['outcome'] !== 'string' || !(transport['reasonCode'] === null || typeof transport['reasonCode'] === 'string') || !count(transport['claimsAtTransport']) || !count(transport['fetchesAtTransport']))) return undefined;
  if (observedUsage !== null && (!isRaw(observedUsage) || !count(observedUsage['inputTokens']) || !count(observedUsage['outputTokens']))) return undefined;
  return value as unknown as C10CallFacts;
}

function parseBudgetCall(value: unknown): C10BudgetCallFacts | undefined {
  if (!isRaw(value) || typeof value['requestId'] !== 'string' || !SAFE_ID.test(value['requestId'])) return undefined;
  if (value['kind'] !== 'absent' && value['kind'] !== 'exhausted') return undefined;
  if (value['transport'] !== null || typeof value['refusal'] !== 'string') return undefined;
  if (!count(value['fetchesBefore']) || !count(value['fetchesAfter'])) return undefined;
  return value as unknown as C10BudgetCallFacts;
}

/** A retained witness is untrusted input: an unknown shape is `undefined`, never judged. */
export function parseC10(value: unknown): C10WitnessBody | undefined {
  if (!isRaw(value) || value['schema'] !== C10_WITNESS_SCHEMA) return undefined;
  const { limits, calls } = value;
  if (!isRaw(limits) || !count(limits['totalModelCalls']) || !count(limits['perRunInputTokens']) || !count(limits['perRunOutputTokens'])) return undefined;
  if (!isRaw(calls)) return undefined;
  const allowed = parseCall(calls['allowed']);
  const refused = parseCall(calls['refused']);
  if (allowed === undefined || refused === undefined) return undefined;
  const budgets = value['budgets'];
  if (!isRaw(budgets)) return undefined;
  const absent = parseBudgetCall(budgets['absent']);
  const exhausted = parseBudgetCall(budgets['exhausted']);
  return absent === undefined || exhausted === undefined ? undefined : (value as unknown as C10WitnessBody);
}

/**
 * Publishes the run authority the bound provider's claims bind to, through the owner's own public
 * control path. The seeded head carries generation 1 on the task-bound port only; the shared port the
 * model ports use reads the persisted head, so the witness raises it to `generation` first.
 */
export async function publishRunAuthority(owner: { publishAuthority(input: unknown): Promise<unknown> }, task: BugTask, generation: number): Promise<boolean> {
  const receipt = await owner.publishAuthority({
    authorityRef: { policyId: task.configId, policyVersion: task.configVersion, configId: task.configId, configVersion: task.configVersion, issuerKeyRef: `host-${task.configId}`, decisionAuthorityGeneration: generation },
  });
  return typeof receipt === 'object' && receipt !== null && (receipt as { status?: unknown }).status === 'published';
}
