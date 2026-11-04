/**
 * Bounded coder generation (runtime-evaluation/1, T007).
 *
 * One strict JSON proposal per model turn; inspect actions are the only tool
 * effects and go through the injected RepositoryPort after validation.
 * Owned path: src/uc03/agent.ts
 */

import {
  computeCanonicalSha256,
  computeRequestContentDigest,
  validateCheckResult,
  validateProviderAdmissionV02,
  validateProviderRequest,
  type BugTask,
  type CheckDefinition,
  type ModelPortResult,
  type ModelPortV02,
  type ProviderRequest,
  type RepositoryAdmissionContextV02,
  type RepositoryPort,
  type RepositoryPortV02,
  type SourceEvidence,
  type TaskNode,
  type TaskState,
} from '../contracts/foundation/uc03.ts';
import type { ExecutionGuardReadCapability } from '../foundation/repository-types.ts';
import { parseUnifiedDiff } from '../foundation/reviewer.ts';
import { parseCoderProposal } from './agent-proposal.ts';
import type {
  CoderAgent,
  CoderAgentOptions,
  CoderAgentV02,
  CoderBudget,
  CoderCounters,
  CoderProposal,
  CoderToolResult,
  CoderTurnInputV02,
  CoderTurnResult,
  CoderTurnResultV02,
  UC03CoderAdmission,
} from './agent-types.ts';
import { currentPlanBindingDigest } from './graph-validation.ts';
import type { TrustedHostExpectedContext } from './investigation-types.ts';

export * from './agent-types.ts';
export { parseCoderProposal } from './agent-proposal.ts';

const WAITING_NODES: ReadonlySet<TaskNode> = new Set(['NeedsInfo', 'AwaitPlan', 'AwaitFeedback']);
const TERMINAL_NODES: ReadonlySet<TaskNode> = new Set(['Deliver', 'Incomplete']);

type Dispatch = { readonly ok: true; readonly tool: CoderToolResult } | { readonly ok: false; readonly reason: string };

async function dispatchInspect(task: BugTask, repository: RepositoryPort, proposal: Extract<CoderProposal, { kind: 'inspect' }>): Promise<Dispatch> {
  if (proposal.operation === 'list_dir') {
    return { ok: true, tool: { kind: 'list-dir', path: proposal.args.path, entries: await repository.listDir(proposal.args.path) } };
  }
  if (proposal.operation === 'read_file') {
    return { ok: true, tool: { kind: 'read-file', evidence: await repository.readFile(proposal.args.path) } };
  }
  if (proposal.operation === 'search_code') {
    return { ok: true, tool: { kind: 'search-code', evidence: await repository.searchCode(proposal.args.query) } };
  }
  const check = task.requiredChecks.find(candidate => candidate.checkId === proposal.args.checkId);
  if (check === undefined) return { ok: false, reason: 'CHECK_NOT_CONFIGURED' };
  return { ok: true, tool: { kind: 'run-check', checkId: check.checkId, result: await repository.runTests(check) } };
}

/** Host-side binding to the exact observed state; returns a safe refusal code or null. */
function bindProposal(task: BugTask, state: TaskState, evidence: readonly SourceEvidence[], proposal: CoderProposal): string | null {
  if (proposal.kind === 'inspect') {
    return proposal.operation === 'run_check' && !task.requiredChecks.some(check => check.checkId === proposal.args.checkId) ? 'CHECK_NOT_CONFIGURED' : null;
  }
  if (proposal.kind !== 'propose-patch') {
    const knownRefs = new Set([...state.evidenceRefs, ...evidence.map(item => item.path)]);
    return proposal.evidenceRefs.some(ref => !knownRefs.has(ref)) ? 'EVIDENCE_NOT_BOUND' : null;
  }
  const plan = state.plan;
  if (plan === undefined) return 'PATCH_WITHOUT_PLAN';
  if (proposal.approvedPlanRef !== plan.strategyDigest && proposal.approvedPlanRef !== plan.decisionRef) return 'PLAN_REF_MISMATCH';
  const changed = parseUnifiedDiff(proposal.diff);
  if (changed === null) return 'DIFF_NOT_UNIFIED';
  const changedPaths = Object.keys(changed);
  if (changedPaths.length !== proposal.targetPaths.length || changedPaths.some(path => !proposal.targetPaths.includes(path))) return 'PATCH_PATH_MISMATCH';
  return proposal.targetPaths.every(path => plan.scopedChanges.includes(path)) ? null : 'PATCH_OUTSIDE_PLAN_SCOPE';
}

/** Replan/repair accounting shared by both turns; a safe refusal code or null. */
function accountProposal(counters: { replans: number; repairs: number }, budget: CoderBudget, state: TaskState, proposal: CoderProposal): string | null {
  if (proposal.kind === 'propose-plan' && state.plan !== undefined) {
    const used = Math.max(counters.replans, state.replanCount);
    if (used >= budget.maxReplans) return 'REPLAN_BUDGET_EXHAUSTED';
    counters.replans = used + 1;
  }
  if (proposal.kind === 'propose-patch' && state.node === 'Repair') {
    if (counters.repairs >= budget.maxRepairs) return 'REPAIR_BUDGET_EXHAUSTED';
    counters.repairs += 1;
  }
  return null;
}

function assertBudget(budget: CoderBudget | undefined): CoderBudget {
  if (budget === undefined || budget === null || typeof budget !== 'object') throw new Error('INVALID_BUDGET: explicit finite limits are required');
  for (const key of ['maxModelCalls', 'maxActiveMs', 'maxRepairs', 'maxReplans'] as const) {
    const value = budget[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_BUDGET:${key} must be a non-negative safe integer`);
  }
  return budget;
}

export function createCoderAgent(options: CoderAgentOptions): CoderAgent {
  if (typeof options?.propose !== 'function') throw new Error('INVALID_PROPOSE: a model propose seam is required');
  if (typeof options.repository?.listDir !== 'function' || typeof options.repository.runTests !== 'function') throw new Error('INVALID_REPOSITORY: a RepositoryPort is required');
  const budget = assertBudget(options.budget);
  const now = options.now ?? ((): number => Date.now());
  const counters = { modelCalls: 0, modelOutputFailures: 0, repairs: 0, replans: 0, activeMs: 0 };
  const snapshot = (): CoderCounters => ({ ...counters });
  const invalid = (reason: string): CoderTurnResult => ({ outcome: 'invalid', reason, counters: snapshot() });
  const elapsed = (started: number): number => Math.max(0, now() - started);

  return {
    get counters() {
      return snapshot();
    },
    async turn(task: BugTask, state: TaskState, evidence: readonly SourceEvidence[], request: ProviderRequest): Promise<CoderTurnResult> {
      // A trusted revise direction resumes AwaitFeedback for exactly one replan proposal.
      const replanTurn = state.node === 'AwaitFeedback' && request.purpose === 'propose-replan';
      if (WAITING_NODES.has(state.node) && !replanTurn) return { outcome: 'waiting', reason: `HUMAN_WAIT:${state.node}`, counters: snapshot() };
      if (TERMINAL_NODES.has(state.node)) return invalid(`TERMINAL_NODE:${state.node}`);
      if (counters.modelCalls >= budget.maxModelCalls) return invalid('MODEL_CALL_BUDGET_EXHAUSTED');
      if (counters.activeMs >= budget.maxActiveMs) return invalid('ACTIVE_TIME_BUDGET_EXHAUSTED');

      const started = now();
      let result: ModelPortResult;
      counters.modelCalls += 1;
      try {
        result = await options.propose(state, evidence, request);
      } catch {
        counters.modelOutputFailures += 1;
        counters.activeMs += elapsed(started);
        return invalid('MODEL_ERROR');
      }
      counters.activeMs += elapsed(started);
      if (result?.outcome !== 'observed') {
        counters.modelOutputFailures += 1;
        return invalid(`MODEL_${String(result?.outcome ?? 'invalid').toUpperCase()}`);
      }

      const parsed = parseCoderProposal(result.result.proposal.content);
      if (!parsed.ok) {
        counters.modelOutputFailures += 1;
        return invalid(`PROPOSAL_INVALID:${parsed.errors[0]?.code ?? 'UNKNOWN'}`);
      }
      const proposal = parsed.value;
      const binding = bindProposal(task, state, evidence, proposal);
      if (binding !== null) {
        counters.modelOutputFailures += 1;
        return invalid(binding);
      }
      // Tool dispatch is the remaining effect; check the time bound before it, not after.
      if (counters.activeMs >= budget.maxActiveMs) return invalid('ACTIVE_TIME_BUDGET_EXHAUSTED');

      if (proposal.kind !== 'inspect') {
        const refusal = accountProposal(counters, budget, state, proposal);
        if (refusal !== null) return invalid(refusal);
        return { outcome: 'proposal', proposal, counters: snapshot() };
      }

      const dispatchStarted = now();
      let dispatched: Dispatch;
      try {
        dispatched = await dispatchInspect(task, options.repository, proposal);
      } catch {
        counters.activeMs += elapsed(dispatchStarted);
        return invalid('TOOL_ERROR');
      }
      counters.activeMs += elapsed(dispatchStarted);
      if (!dispatched.ok) return invalid(dispatched.reason);
      return { outcome: 'proposal', proposal, tool: dispatched.tool, counters: snapshot() };
    },
  };
}

export interface CoderAgentV02Options {
  readonly model: ModelPortV02;
  readonly repository: RepositoryPortV02;
  readonly budget: CoderBudget;
  /** When supplied, inspect reads are mediated by the host guard instead of hitting the repository directly. */
  readonly guardedRead?: ExecutionGuardReadCapability | undefined;
  /** Owner resolver for the exact run-check action; without it a run_check is refused before the repository is called. */
  readonly admissionContextForCheck?: TrustedHostExpectedContext['admissionContextForCheck'];
  readonly now?: (() => number) | undefined;
}

/**
 * Host-side binding of one owner-issued admission to this exact turn; a safe refusal code or null.
 * The request↔context pairing is what makes a substituted request detectable, and the trusted context
 * is what makes a forged admission detectable.
 */
export function coderAdmissionRefusal(admission: UC03CoderAdmission | undefined, input: CoderTurnInputV02): string | null {
  const { request, context, trustedContext } = (admission ?? {}) as Partial<UC03CoderAdmission>;
  if (request === undefined || context === undefined || trustedContext === undefined) return 'CODER_ADMISSION_MISSING';
  const admissionValidation = validateProviderAdmissionV02(context, trustedContext);
  if (!admissionValidation.ok) return `CODER_ADMISSION_INVALID:${admissionValidation.errors[0]?.code ?? 'UNKNOWN'}`;
  const requestValidation = validateProviderRequest(request, {
    expectedTaskId: input.state.taskId,
    expectedRunId: input.state.runId,
    expectedRole: 'coder',
    expectedPurpose: input.purpose,
    expectedProviderRequestId: context.providerRequestId,
  });
  if (!requestValidation.ok) return `CODER_ADMISSION_REQUEST_INVALID:${requestValidation.errors[0]?.code ?? 'UNKNOWN'}`;
  const approvedPlan = input.purpose !== 'propose-plan';
  if (
    context.taskId !== input.state.taskId ||
    context.runId !== input.state.runId ||
    context.role !== 'coder' ||
    context.expectedTaskStateVersion !== input.state.stateVersion ||
    computeCanonicalSha256(context.providerRequest) !== computeCanonicalSha256(request) ||
    context.requestContentDigest !== computeRequestContentDigest(request) ||
    request.reservationRef !== context.requestReservationReceipt ||
    (approvedPlan
      ? context.planApplicability !== 'approved-plan' || context.planDecisionRef !== input.state.plan?.decisionRef || context.planBindingDigest !== currentPlanBindingDigest(input.task, input.state)
      : context.planApplicability !== 'pre-plan-diagnostic')
  ) {
    return 'CODER_ADMISSION_NOT_BOUND';
  }
  return null;
}

/** The exact action the owner must have admitted for this check, matching every other v0.2 consumer. */
export function checkAction(check: CheckDefinition): RepositoryAdmissionContextV02['action'] {
  return { actionId: check.checkId, kind: 'run_command', executable: check.executable, argv: [...check.argv], workingDirectory: check.workingDirectory ?? 'tests', purpose: check.purpose };
}

export function createCoderAgentV02(options: CoderAgentV02Options): CoderAgentV02 {
  if (typeof options?.model?.propose !== 'function') throw new Error('INVALID_MODEL: a ModelPortV02 is required');
  if (typeof options.repository?.listDir !== 'function' || typeof options.repository.runTests !== 'function') throw new Error('INVALID_REPOSITORY: a RepositoryPortV02 is required');
  const budget = assertBudget(options.budget);
  const now = options.now ?? ((): number => Date.now());
  const counters = { modelCalls: 0, modelOutputFailures: 0, repairs: 0, replans: 0, activeMs: 0 };
  const snapshot = (): CoderCounters => ({ ...counters });
  const invalid = (reason: string): CoderTurnResultV02 => ({ outcome: 'invalid', reason, counters: snapshot() });
  const elapsed = (started: number): number => Math.max(0, now() - started);

  return {
    get counters() {
      return snapshot();
    },
    get provenance() {
      return options.model.provenance;
    },
    async turn(input: CoderTurnInputV02): Promise<CoderTurnResultV02> {
      const { task, state, evidence } = input;
      // A human pause short-circuits before admission: no new owner decision is needed to wait.
      if (WAITING_NODES.has(state.node)) return { outcome: 'waiting', reason: `HUMAN_WAIT:${state.node}`, counters: snapshot() };
      if (TERMINAL_NODES.has(state.node)) return invalid(`TERMINAL_NODE:${state.node}`);
      const admissionRefusal = coderAdmissionRefusal(input.admission, input);
      if (admissionRefusal !== null) return invalid(admissionRefusal);
      if (counters.modelCalls >= budget.maxModelCalls) return invalid('MODEL_CALL_BUDGET_EXHAUSTED');
      if (counters.activeMs >= budget.maxActiveMs) return invalid('ACTIVE_TIME_BUDGET_EXHAUSTED');

      const { admission } = input;
      const started = now();
      let result: Awaited<ReturnType<ModelPortV02['propose']>>;
      counters.modelCalls += 1;
      try {
        // The model boundary alone claims, begins the attempt and records the outcome.
        result = await options.model.propose(state, evidence, admission.request, admission.context);
      } catch {
        counters.modelOutputFailures += 1;
        counters.activeMs += elapsed(started);
        return invalid('MODEL_ERROR');
      }
      counters.activeMs += elapsed(started);
      if (result?.outcome === 'uncertain') {
        // Never replayed: the provider may have settled the reservation already.
        return { outcome: 'unavailable', reason: `MODEL_UNCERTAIN:${result.reason ?? 'UNKNOWN'}`, counters: snapshot() };
      }
      if (result?.outcome !== 'observed') {
        counters.modelOutputFailures += 1;
        return invalid(`MODEL_${String(result?.outcome ?? 'invalid').toUpperCase()}`);
      }
      const proposal = (result.result as { readonly proposal?: { readonly content?: unknown } } | undefined)?.proposal;
      const parsed = parseCoderProposal(proposal?.content as string);
      if (!parsed.ok) {
        counters.modelOutputFailures += 1;
        return invalid(`PROPOSAL_INVALID:${parsed.errors[0]?.code ?? 'UNKNOWN'}`);
      }
      const binding = bindProposal(task, state, evidence, parsed.value);
      if (binding !== null) {
        counters.modelOutputFailures += 1;
        return invalid(binding);
      }
      // Tool dispatch is the remaining effect; check the time bound before it, not after.
      if (counters.activeMs >= budget.maxActiveMs) return invalid('ACTIVE_TIME_BUDGET_EXHAUSTED');

      if (parsed.value.kind !== 'inspect') {
        const refusal = accountProposal(counters, budget, state, parsed.value);
        if (refusal !== null) return invalid(refusal);
        return { outcome: 'proposal', proposal: parsed.value, counters: snapshot() };
      }

      const dispatchStarted = now();
      let dispatched: DispatchV02;
      try {
        dispatched = await dispatchInspectV02(task, options, input, parsed.value);
      } catch {
        counters.activeMs += elapsed(dispatchStarted);
        return invalid('TOOL_ERROR');
      }
      counters.activeMs += elapsed(dispatchStarted);
      if (!dispatched.ok) return invalid(dispatched.reason);
      return { outcome: 'proposal', proposal: parsed.value, tool: dispatched.tool, counters: snapshot() };
    },
  };
}

type DispatchV02 = { readonly ok: true; readonly tool: CoderToolResult } | { readonly ok: false; readonly reason: string };

async function dispatchInspectV02(task: BugTask, options: CoderAgentV02Options, input: CoderTurnInputV02, proposal: Extract<CoderProposal, { kind: 'inspect' }>): Promise<DispatchV02> {
  const repository = options.repository;
  const guard = options.guardedRead;
  if (proposal.operation === 'list_dir') {
    const path = proposal.args.path;
    const entries = guard ? await guard.mediateRead({ kind: 'list', targetPath: path, execute: () => repository.listDir(path) }) : await repository.listDir(path);
    return { ok: true, tool: { kind: 'list-dir', path, entries } };
  }
  if (proposal.operation === 'read_file') {
    const path = proposal.args.path;
    const evidence = guard ? await guard.mediateRead({ kind: 'read', targetPath: path, execute: () => repository.readFile(path) }) : await repository.readFile(path);
    return { ok: true, tool: { kind: 'read-file', evidence } };
  }
  if (proposal.operation === 'search_code') {
    const query = proposal.args.query;
    const evidence = guard ? await guard.mediateRead({ kind: 'search', query, execute: () => repository.searchCode(query) }) : await repository.searchCode(query);
    return { ok: true, tool: { kind: 'search-code', evidence } };
  }
  const check = task.requiredChecks.find(candidate => candidate.checkId === proposal.args.checkId);
  if (check === undefined) return { ok: false, reason: 'CHECK_NOT_CONFIGURED' };
  // No owner admission for this exact action means no dispatch at all: the repository is not touched.
  const context = await options.admissionContextForCheck?.({ check, action: checkAction(check), currentState: input.state });
  if (context === undefined) return { ok: false, reason: 'CHECK_ADMISSION_REQUIRED' };
  const raw = await repository.runTests(check, context);
  // Repository adapters may return richer records; only the canonical check-result fields may leave.
  const validated = validateCheckResult({
    checkId: raw.checkId,
    outcome: raw.outcome,
    ...(typeof raw.outputExcerpt === 'string' ? { outputExcerpt: raw.outputExcerpt } : {}),
    ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
  });
  if (!validated.ok) return { ok: false, reason: `CHECK_RESULT_INVALID:${validated.errors[0]?.code ?? 'UNKNOWN'}` };
  return { ok: true, tool: { kind: 'run-check', checkId: check.checkId, result: validated.value } };
}
