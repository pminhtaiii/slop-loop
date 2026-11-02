/**
 * Bounded coder generation (runtime-evaluation/1, T007).
 *
 * One strict JSON proposal per model turn; inspect actions are the only tool
 * effects and go through the injected RepositoryPort after validation.
 * Owned path: src/uc03/agent.ts
 */

import type { BugTask, ModelPortResult, ProviderRequest, RepositoryPort, SourceEvidence, TaskNode, TaskState } from '../contracts/foundation/uc03.ts';
import { parseUnifiedDiff } from '../foundation/reviewer.ts';
import { parseCoderProposal } from './agent-proposal.ts';
import type { CoderAgent, CoderAgentOptions, CoderBudget, CoderCounters, CoderProposal, CoderToolResult, CoderTurnResult } from './agent-types.ts';

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
      if (WAITING_NODES.has(state.node)) return { outcome: 'waiting', reason: `HUMAN_WAIT:${state.node}`, counters: snapshot() };
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

      if (proposal.kind === 'propose-plan' && state.plan !== undefined) {
        const used = Math.max(counters.replans, state.replanCount);
        if (used >= budget.maxReplans) return invalid('REPLAN_BUDGET_EXHAUSTED');
        counters.replans = used + 1;
      }
      if (proposal.kind === 'propose-patch' && state.node === 'Repair') {
        if (counters.repairs >= budget.maxRepairs) return invalid('REPAIR_BUDGET_EXHAUSTED');
        counters.repairs += 1;
      }
      if (proposal.kind !== 'inspect') return { outcome: 'proposal', proposal, counters: snapshot() };

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
