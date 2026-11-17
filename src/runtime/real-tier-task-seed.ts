/**
 * T061 — the one durable task seed (real-tier contract §(a) "Production task binding").
 *
 * The state carries exactly what the production admission path reads before any effect: the four
 * ledgers `src/uc03/replan-accounting.ts` requires, the run token/cost pair and the task iteration row
 * `providerSpecs` requires, and the task/run resource rows `repositoryResourceSpecs` requires. Every
 * limit is derived from the pinned `BugTask`; no constant from this module or a fixture supplies one.
 *
 * This module only shapes records. The binding writes them through `StatePortV02.transition(state, 0)`.
 */
import { CONTRACT_VERSION } from '../contracts/foundation/uc03.ts';
import type { BudgetLedger, BugTask, ExecutionLimits, TaskState } from '../contracts/foundation/uc03.ts';

export interface SeededTaskIds {
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
}

function ledger(scope: 'task' | 'run', kind: string, limit: number, unit: string, configurationId: string): BudgetLedger {
  return { scope, kind, limit, consumed: 0, reservations: [], unit, configurationId, version: 1 };
}

/** CPU seconds a command may burn: its core allowance over its own wall clock. */
function cpuSeconds(limits: ExecutionLimits): number {
  return Math.max(1, Math.ceil((limits.maxCpuCores * limits.timeoutMs) / 1000));
}

/** The full task-ledger set the real admission path reads, in the order `repositoryResourceSpecs` expects. */
export function seedLedgers(task: BugTask): readonly BudgetLedger[] {
  const budget = task.budgetLimits;
  const limits = task.limits;
  const configId = task.configId;
  // The resource rows are cumulative, and one command settles its whole per-command reservation, so the
  // limit is the per-command limit times every command the task may run: each required check at the
  // baseline, per repair attempt and per replan, plus one verification pass.
  const commands = Math.max(1, task.requiredChecks.length) * (1 + budget.maxRepairAttempts + budget.maxReplanCount + 1);
  const resources = [
    ['timeoutMs', limits.timeoutMs * commands, 'ms'],
    ['maxOutputBytes', limits.maxOutputBytes * commands, 'bytes'],
    ['maxCpuSeconds', cpuSeconds(limits) * commands, 'seconds'],
    ['maxMemoryBytes', limits.maxMemoryBytes * commands, 'bytes'],
    ['maxProcessCount', limits.maxPids * commands, 'count'],
  ] as const;
  return Object.freeze([
    // replan/repair/tokens/cost: `checkReplanAccounting` requires exactly one of each, at these limits.
    ledger('task', 'replan', budget.maxReplanCount, 'count', configId),
    ledger('task', 'repair', budget.maxRepairAttempts, 'count', configId),
    ledger('task', 'tokens', budget.maxTokens, 'count', configId),
    ledger('task', 'cost', budget.maxCostUsd, 'usd', configId),
    // `providerSpecs` also needs a run token/cost pair; the task budget bounds its run.
    ledger('run', 'tokens', budget.maxTokens, 'count', configId),
    ledger('run', 'cost', budget.maxCostUsd, 'usd', configId),
    // `reviewerIterationSpecs` needs exactly one task iteration row; the task review cap bounds it.
    ledger('task', 'iteration', budget.maxReviewIterations, 'count', configId),
    // `repositoryResourceSpecs` needs one task and one run row per configured finite resource bound.
    ...(['task', 'run'] as const).flatMap(scope => resources.map(([kind, limit, unit]) => ledger(scope, kind, limit, unit, configId))),
  ]);
}

/** The version-1 task record: `Validate`, no plan, no replans, the full ledger set. */
export function seedTaskState(task: BugTask, ids: SeededTaskIds): TaskState {
  return {
    schemaVersion: CONTRACT_VERSION,
    stateVersion: 1,
    taskId: ids.taskId,
    runId: ids.runId,
    workspaceId: ids.workspaceId,
    repositoryId: task.repositoryId,
    repositoryRevisionDigest: task.initialRevisionDigest,
    goal: task.goal,
    observedBehavior: task.observedBehavior,
    expectedBehavior: task.expectedBehavior,
    reproduction: task.reproduction,
    acceptanceCriteria: task.acceptanceCriteria,
    constraints: task.constraints,
    requiredCheckIds: task.requiredChecks.map(check => check.checkId),
    taskContext: task,
    node: 'Validate',
    planVersion: 1,
    replanCount: 0,
    changedPaths: [],
    evidenceRefs: [],
    risks: [],
    nextAction: 'validate-bug-context',
    budgetLedgers: seedLedgers(task),
  };
}
