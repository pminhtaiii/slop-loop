import {
  computeCanonicalSha256,
  computeRequestContentDigest,
  validateProviderAdmissionV02,
  validateProviderRequest,
  type BugTask,
  type ClaimReceiptV02,
  type ProviderAdmissionContextV02,
  type SourceEvidence,
  type TaskState,
} from '../contracts/foundation/uc03.ts';
import type { CoderProposal, CoderToolResult, CoderTurnInputV02, CoderTurnResult } from './agent.ts';
import type { UC03CoderAdmission, UC03GraphConfig } from './graph-types.ts';
import type { UC03GraphGenerationV02 } from './graph-types-v02.ts';
import { currentPlanBindingDigest, samePaths, trustedExpectedContext } from './graph-validation.ts';

const SUPPLIED_ANSWER_FIELD = { Investigate: 'planDetails', Patch: 'patchContent', Repair: 'repairPatch', AwaitFeedback: 'revisedPlan' } as const;

/**
 * The real profile must obtain its answers from the generation agent. A supplied answer alongside
 * `generation` is refused outright rather than silently preferred; with no supplied answer the
 * agent proposes one through an owner-issued coder admission.
 */
export function generationRefusal(config: UC03GraphConfig | undefined, node: keyof typeof SUPPLIED_ANSWER_FIELD): string | undefined {
  if (config?.mode !== 'production' || !config.generation) return undefined;
  const field = SUPPLIED_ANSWER_FIELD[node];
  if (config[field] !== undefined || (node === 'Patch' && Boolean(config.targetPaths?.length))) {
    return `REAL_PROFILE_SUPPLIED_ANSWER_REFUSED: ${node} takes no config.${field}; the generation agent must produce it`;
  }
  return undefined;
}

/** True when this route must obtain its answer from the model rather than the config. */
export function generates(config: UC03GraphConfig | undefined): config is UC03GraphConfig & { generation: NonNullable<UC03GraphConfig['generation']> } {
  return config?.mode === 'production' && config.generation !== undefined;
}

/** What the owner binds the coder request to: this task/run/state, this purpose, this evidence. */
export function coderContextDigest(task: BugTask, state: TaskState, purpose: CoderPurpose, evidence: readonly SourceEvidence[]): string {
  return computeCanonicalSha256({ taskId: task.taskId, runId: state.runId, stateVersion: state.stateVersion, purpose, evidence: evidence.map(item => item.path) });
}

export type CoderPurpose = 'propose-plan' | 'propose-patch' | 'propose-repair' | 'propose-replan';

export type CoderGeneration = { readonly ok: true; readonly proposal: CoderProposal; readonly tool?: CoderToolResult | undefined } | { readonly ok: false; readonly reason: string };

/**
 * Resolve the owner admission, validate it against the current state, reserve, then dispatch.
 * Every check happens before `agent.turn`, so a refused or mismatched admission never reaches the
 * model. The reservation is the owner's; this route never fabricates a request.
 */
export async function generate(config: UC03GraphConfig, task: BugTask, state: TaskState, purpose: CoderPurpose, evidence: readonly SourceEvidence[]): Promise<CoderGeneration> {
  const trusted = trustedExpectedContext(config, task, state);
  const source = config.coderAdmission;
  if (!trusted?.statePort || !source) return { ok: false, reason: 'REAL_PROFILE_GENERATION_UNWIRED: no owner-issued coder admission for this state' };

  const admission = typeof source === 'function' ? await source({ task, state, purpose, evidence }) : source;
  if (!admission) return { ok: false, reason: 'Owner did not issue a coder admission for the current task state' };

  const bound = coderAdmissionBinds(admission, task, state, purpose, evidence);
  if (!bound) return { ok: false, reason: 'Coder request or persisted admission does not bind the current task, run, state, and reservation' };

  const claim = await trusted.statePort.claim(admission.context);
  if (!validCoderClaim(claim, admission.context, state)) return { ok: false, reason: 'Owner budget protocol refused the coder allowance before dispatch' };

  const generation = config.generation;
  if (!generation) return { ok: false, reason: 'REAL_PROFILE_GENERATION_UNWIRED: generation is not configured for this route' };
  const turn: CoderTurnResult = await generation.agent.turn(task, state, evidence, admission.request);
  if (turn.outcome === 'proposal') return { ok: true, proposal: turn.proposal };
  // `waiting` is a human pause, not a failure; `invalid` carries a safe code and no model text.
  return { ok: false, reason: turn.outcome === 'waiting' ? `HUMAN_WAIT:${turn.reason}` : `REAL_PROFILE_GENERATION_INVALID: ${turn.reason}` };
}

function coderAdmissionBinds(admission: UC03CoderAdmission, task: BugTask, state: TaskState, purpose: CoderPurpose, evidence: readonly SourceEvidence[]): boolean {
  const requestValidation = validateProviderRequest(admission.request, {
    expectedTaskId: state.taskId,
    expectedRunId: state.runId,
    expectedRole: 'coder',
    expectedPurpose: purpose,
    expectedContextDigest: coderContextDigest(task, state, purpose, evidence),
    expectedProviderRequestId: admission.context.providerRequestId,
  });
  const admissionValidation = validateProviderAdmissionV02(admission.context, admission.trustedContext);
  return (
    requestValidation.ok &&
    admissionValidation.ok &&
    admission.context.providerRequestId === admission.request.providerRequestId &&
    admission.context.role === 'coder' &&
    admission.context.taskId === state.taskId &&
    admission.context.runId === state.runId &&
    admission.context.expectedTaskStateVersion === state.stateVersion &&
    computeCanonicalSha256(admission.context.providerRequest) === computeCanonicalSha256(admission.request) &&
    admission.context.requestContentDigest === computeRequestContentDigest(admission.request) &&
    admission.request.reservationRef === admission.context.requestReservationReceipt &&
    (purpose === 'propose-plan' ? admission.context.planApplicability === 'pre-plan-diagnostic' : planBindingMatches(admission.context, task, state))
  );
}

function planBindingMatches(context: ProviderAdmissionContextV02, task: BugTask, state: TaskState): boolean {
  return context.planApplicability === 'approved-plan' && context.planDecisionRef === state.plan?.decisionRef && context.planBindingDigest === currentPlanBindingDigest(task, state);
}

function validCoderClaim(claim: ClaimReceiptV02 | undefined, admission: ProviderAdmissionContextV02, state: TaskState): claim is ClaimReceiptV02 {
  return (
    !!claim &&
    claim.status === 'claimed' &&
    claim.subjectKind === 'provider-request' &&
    claim.taskId === state.taskId &&
    claim.runId === state.runId &&
    claim.preClaimTaskStateVersion === state.stateVersion &&
    samePaths(claim.reservationRefs, [admission.requestReservationReceipt, ...admission.budgetRefs])
  );
}

/**
 * v0.2 generation: no claim here. The model boundary (`ModelPortV02.propose`) alone reserves,
 * begins the attempt and records the outcome, so a claim on this side would be a second one.
 */
export async function generateV02(generation: UC03GraphGenerationV02, input: CoderTurnInputV02): Promise<CoderGeneration> {
  const turn = await generation.agent.turn(input);
  if (turn.outcome === 'proposal') return { ok: true, proposal: turn.proposal, tool: turn.tool };
  // `waiting` is a human pause, not a failure; other outcomes carry a safe code and no model text.
  return { ok: false, reason: turn.outcome === 'waiting' ? `HUMAN_WAIT:${turn.reason}` : `REAL_PROFILE_GENERATION_INVALID: ${turn.reason}` };
}
