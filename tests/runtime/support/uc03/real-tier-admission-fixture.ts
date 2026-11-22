/** Shared fixture for the real-tier admission regression tests (PR #219 review). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeCanonicalSha256, computeCheckSetDigest, type BudgetLedger, type BugTask, type PolicyAuthorityRefV02, type TaskState } from '../../../../src/contracts/foundation/uc03.ts';
import type { TrustedOperatorIdentity } from '../../../../src/contracts/approvals/contracts.ts';
import { DurableStore } from '../../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../../src/persistence/adapters/state-port-v02-storage.ts';
import { bindIssuedDecision } from '../../../../src/persistence/adapters/state-port-v02-verification-records.ts';
import { buildDockerCommandView } from '../../../../src/foundation/docker-view-builder.ts';
import { computeFileDigest } from '../../../../src/foundation/docker-workspace.ts';
import type { RealTierAssembly } from '../../../../src/runtime/real-tier-assembly.ts';
import { seedLedgers, seedTaskState } from '../../../../src/runtime/real-tier-task-seed.ts';
import { createTestBugTask } from './state-fixtures.ts';

const baseTask = createTestBugTask({ taskId: 'task-admission-budgets-1', repositoryId: 'repo-admission-budgets-1' });
export const TASK: BugTask = {
  ...baseTask,
  acceptanceCriteria: ['divide(1, 0) raises ValueError'],
  requiredChecks: [
    {
      checkId: 'check-1',
      executable: 'pytest',
      argv: ['tests/test_calc.py'],
      purpose: 'reproduction',
      timeoutMs: 1000,
      maxOutputBytes: 4096,
    },
  ],
  budgetLimits: {
    maxReplanCount: 3,
    maxTokens: 100000,
    maxCostUsd: 10,
    maxRepairAttempts: 2,
    maxReviewIterations: 2,
  },
};

export const RUN_ID = 'run-admission-budgets-1';
export const WORKSPACE_ID = 'ws-admission-budgets-1';
export const REVISION = TASK.initialRevisionDigest;
export const DECISION_ID = 'dec-plan-001';
export const STRATEGY_DIGEST = `sha256:${'b'.repeat(64)}`;
export const BASELINE_REF = `uc04-baseline://${'a'.repeat(64)}`;
export const CHECK_SET_DIGEST = computeCheckSetDigest(TASK.requiredChecks);
const CRITERIA_DIGEST = computeCanonicalSha256(TASK.acceptanceCriteria);

export const POLICY: PolicyAuthorityRefV02 = {
  policyId: TASK.configId,
  policyVersion: TASK.configVersion,
  configId: TASK.configId,
  configVersion: TASK.configVersion,
  issuerKeyRef: `host-${TASK.configId}`,
  decisionAuthorityGeneration: 2,
};

export const OPERATOR: TrustedOperatorIdentity = {
  actorId: 'host-operator',
  channelRef: 'host-console',
  provenance: 'real',
};

export const PLAN = {
  planVersion: 1,
  diagnosis: 'unchecked',
  suspectedCauseLocations: ['src/calculator.py'],
  evidenceRefs: [BASELINE_REF],
  strategy: 'Zero check',
  scopedChanges: ['src/calculator.py'],
  checkSetDigest: CHECK_SET_DIGEST,
  baselineRef: BASELINE_REF,
  strategyDigest: STRATEGY_DIGEST,
  decisionRef: DECISION_ID,
} as const;

export function makeBinding(status: 'approved' | 'pending' | 'rejected', checkSetDigest = CHECK_SET_DIGEST, decisionId = DECISION_ID): Record<string, unknown> {
  return {
    actionId: decisionId,
    kind: 'approve_fix_plan' as const,
    planVersion: 1,
    strategyDigest: STRATEGY_DIGEST,
    diagnosisEvidenceRefs: [BASELINE_REF],
    checkSetDigest,
    taskId: TASK.taskId,
    workspaceId: WORKSPACE_ID,
    repositoryRevisionDigest: REVISION,
    policyId: POLICY.policyId,
    policyVersion: POLICY.policyVersion,
    baselineRef: BASELINE_REF,
    evidenceRefs: [BASELINE_REF],
    criteriaDigest: CRITERIA_DIGEST,
    status,
  };
}

const baseProfile = {
  provider: { providerId: 'deepseek', modelId: 'deepseek-chat', pricingId: 'p-1', limitsId: 'l-1', timeoutMs: 1000 },
  pricing: { inputRate: 1, outputRate: 2, cacheRate: 0, overheadRate: 0, denominator: 1000 },
  approvalPolicy: { profileVersion: '1' },
  executionPolicy: { limits: { providerTimeoutMs: 1000 } },
  image: { label: 'uc03-test-image' },
};

const CONTROLLER = {
  provenance: 'mock' as const,
  materializeView: async () => undefined,
  getCanonicalSnapshot: async () => ({
    canonicalRevisionDigest: REVISION,
    entries: [{ path: 'tests/test_calc.py', kind: 'regular' as const, content: 'def test(): pass', digest: computeFileDigest('def test(): pass') }],
    exclusionsPolicyVersion: '1',
  }),
};
const OPERATIONS = {
  getWorkspace: () => ({ taskId: TASK.taskId, workspaceId: WORKSPACE_ID, repoVolumeId: 'repo-1', scratchVolumeId: 's-1' }),
  getCanonicalRevision: () => REVISION,
  acquireReadLease: async () => ({ release: () => undefined }),
  invalidateViews: () => undefined,
  publishView: () => undefined,
};

export function makeAssembly(overrides?: { input?: number; output?: number }): RealTierAssembly {
  const inp = overrides?.input ?? 1000;
  const out = overrides?.output ?? 1000;
  return {
    status: 'assembly-ready',
    providerIdentity: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    profile: {
      ...baseProfile,
      limits: { inputTokensPerRequest: inp, outputTokensPerRequest: out, providerTimeoutMs: 1000, reviewerIterations: 2 },
      runLimits: { perRunInputTokens: inp, perRunOutputTokens: out, perRunCostUsd: 10 },
    } as unknown as RealTierAssembly['profile'],
    workspaceManager: {
      getFencingGeneration: () => 1,
      admitMeasuredCommandView: (params: unknown) => buildDockerCommandView(params as never, CONTROLLER as never, OPERATIONS as never),
    } as unknown as RealTierAssembly['workspaceManager'],
    executor: { getAdapterIdentity: () => 'adapter-1', getProcessIncarnation: () => 'proc-1', getFencingGeneration: () => 1 } as unknown as RealTierAssembly['executor'],
  } as unknown as RealTierAssembly;
}

export const TEST_DIFF = { diff: '--- a/src/c.py\n+++ b/src/c.py\n@@ -1 +1 @@\n-a\n+b\n', diffDigest: `sha256:${'e'.repeat(64)}`, changedFiles: ['src/c.py'] };

export interface Fixture {
  readonly port: DurableStatePortV02;
  readonly store: DurableStore;
  readonly stateStore: StatePortStore;
}

export async function createFixture(state: TaskState): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), 'reg-budgets-'));
  const store = new DurableStore(join(base, 'store'));
  const port = new DurableStatePortV02({
    store,
    taskId: TASK.taskId,
    approvalStorageDir: join(base, 'approvals'),
    trustedOperator: OPERATOR,
    initialControl: { controlVersion: 2, epoch: 1, mode: 'runnable', activeAuthorityRef: POLICY },
  });
  const stateStore = new StatePortStore(store);
  await stateStore.writeTask(TASK.taskId, state);
  await stateStore.writeControl(TASK.taskId, { controlVersion: 2, epoch: 1, mode: 'runnable', holdRef: null, holdEventDigest: null, activeAuthorityRef: POLICY, activeClaimId: null });

  const boundDecisionId = state.plan?.decisionRef ?? DECISION_ID;
  const planCheckSetDigest = state.plan?.checkSetDigest ?? CHECK_SET_DIGEST;
  const bound = makeBinding('approved', planCheckSetDigest, boundDecisionId);

  await bindIssuedDecision(stateStore, TASK.taskId, {
    decisionId: boundDecisionId,
    issuerKeyRef: POLICY.issuerKeyRef,
    decisionAuthorityGeneration: POLICY.decisionAuthorityGeneration,
    bindingDigest: computeCanonicalSha256(bound),
  });

  return { port, store, stateStore };
}

export function makeTaskState(node: 'Patch' | 'Review' | 'Verify', ledgers: readonly BudgetLedger[], task: BugTask = TASK): TaskState {
  const base = seedTaskState(task, { taskId: task.taskId, runId: RUN_ID, workspaceId: WORKSPACE_ID });
  return {
    ...base,
    node,
    plan: { ...PLAN, checkSetDigest: computeCheckSetDigest(task.requiredChecks) },
    approvalDecisionRefs: [DECISION_ID],
    budgetLedgers: ledgers,
  };
}

export const tokenLedgersWith = (remaining: number): BudgetLedger[] => seedLedgers(TASK).map(l => (l.kind === 'tokens' ? { ...l, limit: 1000 + remaining, consumed: 1000 } : l));
export const iterationLedgersWith = (consumed: number): BudgetLedger[] => seedLedgers(TASK).map(l => (l.kind === 'iteration' && l.scope === 'task' ? { ...l, limit: 2, consumed } : l));
