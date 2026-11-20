/**
 * T052 — UC-03 T025 approval-gating proof, real-container half (real-tier contract §(f) T025 row).
 *
 * Repeats the two edit rows from `uc03-approvals.test.ts` with real containers: an approved action
 * decision reaches exactly one disposable container run that writes the patch bytes, and a rejected
 * decision reaches none. The gate is the production one — the UC-04 durable store, the UC-05 approval
 * service over it, the v0.2 execution guard and the production patch receiver — driven by an operator
 * profile, not by a mock or by `ScriptedApprovalPort`. Every decision here is explicit.
 *
 * Not a `*.test.ts` file on purpose: the CI globs never run it, so no CI lane needs Docker.
 *
 * Exit codes: 0 pass, 1 fail, 3 not-run. No profile, credential, image or daemon is `not-run`, never
 * a pass. `--self-check` scores a deliberately failed row through the same path and exits 1.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalServiceError, createApprovalService, type ApprovalService, type ApprovalServiceV02 } from '../../../src/approvals/service.ts';
import { computePlanBindingDigest } from '../../../src/approvals/plan-binding.ts';
import { computeActionDigest, computeCanonicalSha256, computeCheckSetDigest, CONTRACT_VERSION } from '../../../src/contracts/foundation/uc03.ts';
import type { validateStateTransition } from '../../../src/contracts/foundation/uc03.ts';
import type { ApplyPatchAction, ApprovalBinding, BugTask, FixPlan, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { randomUUID } from 'node:crypto';
import { computeActionDecisionReceiptDigest, computePolicyEvaluationReceiptDigest } from '../../../src/contracts/approvals/contracts.ts';
import type { ActionDecisionReceipt, PolicyEvaluationReceipt } from '../../../src/contracts/approvals/contracts.ts';
import { computeWorkspaceVolumeIds, DockerWorkspaceManager, type DockerLifecycleController } from '../../../src/foundation/docker-workspace.ts';
import { structuredSpawn } from '../../../src/foundation/docker-spawn.ts';
import { createExecutionGuardV02 } from '../../../src/foundation/execution-guard.ts';
import { createRepositoryReceiverV02 } from '../../../src/foundation/repository-tools.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { isSupportedSnapshotPlatform } from '../../../src/runtime/trusted-host-snapshot.ts';
import { createHostAssembly, type RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { createHostActionContext, type HostActionContext } from '../../../src/runtime/host-action-context.ts';
import { seedLedgers } from '../../../src/runtime/real-tier-task-seed.ts';
import { DEFAULT_POLICY_PROFILE } from '../../../src/persistence/adapters/approval-types.ts';
import { DurableApprovalStore } from '../../../src/persistence/adapters/approval-store-adapter.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { DurableStore } from '../../../src/persistence/store.ts';

const PROBE_NONCE = randomUUID().slice(0, 8);
const TASK_ID = 'task-t052-probe';
const RUN_ID = `run-t052-probe-${PROBE_NONCE}`;
const WORKSPACE_ID = `workspace-t052-probe-${PROBE_NONCE}`;
const REPOSITORY_ID = 'repo-t052-probe';
const PLAN_DECISION = 'dec-plan-t052-probe';
const PATCH_DECISION = 'dec-patch-t052-probe';
const CONFIG = { configId: 'config-t052-probe', configVersion: '1.0.0' };
const POLICY = { policyId: CONFIG.configId, policyVersion: CONFIG.configVersion, configId: CONFIG.configId, configVersion: CONFIG.configVersion };
const PROFILE = { ...DEFAULT_POLICY_PROFILE, profileVersion: 'real-tier-2026-11-17', policyIdentity: POLICY };
const AUTHORITY = { ...POLICY, issuerKeyRef: `host-${CONFIG.configId}`, decisionAuthorityGeneration: 1 };
const SOURCE = 'def divide(a, b):\n    return a / b\n';
const PATCHED = 'def divide(a, b):\n    if b == 0:\n        raise ValueError("divisor")\n    return a / b\n';
const PATCH_TEXT = '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1,2 +1,4 @@\n def divide(a, b):\n+    if b == 0:\n+        raise ValueError("divisor")\n     return a / b\n';
const TEST_SOURCE = 'from src.calculator import divide\n\n\ndef test_divide():\n    assert divide(10, 2) == 5\n';

// shortcut: applies a single hunk from line 1 and ignores @@ offsets, enough for PATCH_TEXT; use a real patch tool for multi-hunk patches.
function applyUnifiedDiff(source: string, diffText: string): string {
  const orig = source.split(/\r?\n/);
  const hunkLines = diffText.split(/\r?\n/).filter(l => (l.startsWith(' ') || l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'));
  const out: string[] = [];
  let origIdx = 0;
  for (const hl of hunkLines) {
    const tag = hl[0];
    const line = hl.slice(1);
    if (tag === ' ' || tag === '-') {
      // A context or removed line that does not match the file means this is not the admitted patch for it.
      const nextOrig = orig[origIdx++];
      if (nextOrig !== line) throw new Error(`PATCH_CONTEXT_MISMATCH at line ${origIdx}`);
      if (tag === ' ') out.push(nextOrig);
    } else if (tag === '+') {
      out.push(line);
    }
  }
  while (origIdx < orig.length) {
    const nextOrig = orig[origIdx++];
    if (nextOrig !== undefined) out.push(nextOrig);
  }
  return out.join('\n');
}

async function releaseWorkspaceVolumes(controller: DockerLifecycleController, taskId: string, workspaceId: string): Promise<void> {
  const { repoVolumeId, scratchVolumeId } = computeWorkspaceVolumeIds(taskId, workspaceId);
  const failures: unknown[] = [];
  for (const volumeId of [repoVolumeId, scratchVolumeId]) {
    try {
      if (await controller.hasVolume(volumeId)) await controller.removeVolume(volumeId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  } else if (failures.length > 1) {
    throw new AggregateError(failures, `Failed to release workspace volumes for ${taskId}/${workspaceId}`);
  }
}

async function cleanupScenario(controller: DockerLifecycleController, taskId: string, workspaceId: string, hostCleanup: () => void): Promise<void> {
  let dockerError: unknown;
  let hostError: unknown;
  try {
    await releaseWorkspaceVolumes(controller, taskId, workspaceId);
  } catch (error) {
    dockerError = error;
  } finally {
    try {
      hostCleanup();
    } catch (error) {
      hostError = error;
    }
  }
  if (dockerError !== undefined && hostError !== undefined) {
    throw new AggregateError([dockerError, hostError], 'Scenario cleanup failed for both Docker volumes and host files');
  }
  if (dockerError !== undefined) throw dockerError;
  if (hostError !== undefined) throw hostError;
}

interface Row {
  readonly case: string;
  readonly ok: boolean;
  readonly detail?: unknown;
}

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const outPath = outIndex >= 0 ? argv[outIndex + 1] : undefined;
const selfCheck = argv.includes('--self-check');

function emit(status: 'pass' | 'fail' | 'not-run', payload: Record<string, unknown>): void {
  const text = JSON.stringify({ task: 'T052', status, ...payload }, null, 2);
  if (outPath !== undefined && outPath !== '') {
    mkdirSync(join(outPath, '..'), { recursive: true });
    writeFileSync(outPath, `${text}\n`, 'utf8');
  }
  console.log(text);
}

function report(rows: readonly Row[], evidence: Record<string, unknown>): void {
  const failed = rows.filter(entry => !entry.ok).map(entry => entry.case);
  emit(failed.length === 0 ? 'pass' : 'fail', { rows, failed, ...evidence });
  process.exitCode = failed.length === 0 ? 0 : 1;
}

const row = (caseName: string, ok: boolean, detail?: unknown): Row => ({ case: caseName, ok, detail });

interface RejectedResult {
  readonly outcome: string;
  readonly reason?: string | undefined;
  readonly containerAttempts: number;
  readonly sourceChanged: boolean;
  readonly stateChanged: boolean;
}

/** The guard's text when an APPROVAL_REQUIRED receipt arrives with no approved action decision behind it. */
const MISSING_DECISION = 'APPROVAL_REQUIRED requires ActionDecisionReceipt';

/**
 * The rejected row's predicate, scored over a result the real path produced: a rejected decision must
 * be refused by the guard for the missing approval itself, before any container, with the source bytes
 * and the complete task and journal unchanged. An unrelated refusal does not satisfy it.
 */
function rejectedRefused(result: RejectedResult): boolean {
  return result.outcome === 'denied' && result.reason?.includes(MISSING_DECISION) === true && result.containerAttempts === 0 && !result.sourceChanged && !result.stateChanged;
}

interface Domain {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly revision: string;
  /** Per-scenario, so the one shared assembly's workspace manager never sees a duplicate (SPEC-W5-109). */
  readonly workspaceId: string;
  readonly statePort: DurableStatePortV02;
  readonly service: ApprovalService & ApprovalServiceV02;
  readonly source: HostActionContext;
  readonly task: BugTask;
  readonly plan: FixPlan;
  readonly checkSetDigest: string;
  readonly planBindingDigest: string;
  readonly trustedTransitions: Record<number, NonNullable<Parameters<typeof validateStateTransition>[2]>['trusted']>;
  cleanup(): void;
}

/** What a scenario runs on: a workspace manager, the workspace profile it registers, and the one edit. */
interface Substrate {
  readonly manager: DockerWorkspaceManager;
  readonly profile: Parameters<DockerWorkspaceManager['createWorkspace']>[0]['profile'];
  readonly edit: (repositoryRoot: string, patch: ApplyPatchAction) => Promise<{ readonly exitCode: number | null; readonly stderr: string }>;
}

function realSubstrate(assembly: RealTierAssembly): Substrate {
  return {
    manager: assembly.workspaceManager,
    profile: {
      profileId: assembly.profile.image.label,
      image: assembly.profile.image.base,
      imageDigest: assembly.profile.image.imageId,
      user: assembly.profile.image.user,
      readOnlyRootFilesystem: true,
      network: 'none',
      limits: { timeoutMs: 30_000, maxMemoryBytes: assembly.profile.limits.memoryBytes, maxCpuCores: assembly.profile.limits.cpus, maxPids: assembly.profile.limits.processes },
      mounts: [],
    },
    edit: async (repositoryRoot, patch) => await applyPatchInContainer(assembly, repositoryRoot, patch),
  };
}

/** The Docker-free controller the `--red-proof` run registers workspaces on; it launches nothing. */
class InertController implements DockerLifecycleController {
  readonly provenance = 'mock' as const;
  private readonly volumes = new Set<string>();
  async createVolume(id: string): Promise<void> {
    this.volumes.add(id);
  }
  async hasVolume(id: string): Promise<boolean> {
    return this.volumes.has(id);
  }
  async removeVolume(id: string): Promise<void> {
    this.volumes.delete(id);
  }
}

/** The same guard, receiver and service over no daemon: the edit is the host write the container would make. */
function inertSubstrate(): Substrate {
  return {
    manager: new DockerWorkspaceManager({ controller: new InertController() }),
    profile: {
      profileId: 'uc03-pytest:real-tier',
      image: 'uc03-pytest:real-tier',
      imageDigest: 'sha256:' + '0'.repeat(64),
      user: '1000:1000',
      readOnlyRootFilesystem: true,
      network: 'none',
      limits: { timeoutMs: 30_000, maxMemoryBytes: 536_870_912, maxCpuCores: 1, maxPids: 64 },
      mounts: [],
    },
    edit: async (repositoryRoot, patch) => {
      const target = join(repositoryRoot, patch.targetPaths[0] ?? 'src/calculator.py');
      const orig = readFileSync(target, 'utf8');
      writeFileSync(target, applyUnifiedDiff(orig, patch.patchContent), 'utf8');
      return { exitCode: 0, stderr: '' };
    },
  };
}

function taskOf(revision: string): BugTask {
  return {
    taskId: TASK_ID,
    repositoryId: REPOSITORY_ID,
    initialRevisionDigest: revision,
    goal: 'Divide by zero must raise a domain error',
    observedBehavior: 'divide(1, 0) raises ZeroDivisionError',
    expectedBehavior: 'divide(1, 0) raises ValueError',
    reproduction: 'python -m pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['divide(1, 0) raises ValueError'],
    constraints: [],
    requiredChecks: [
      {
        checkId: 'check-1',
        executable: 'pytest',
        argv: ['-q', 'tests/test_calculator.py'],
        purpose: 'reproduction',
        workingDirectory: 'tests',
        timeoutMs: 30_000,
        maxOutputBytes: 1_048_576,
      },
    ],
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuCores: 1, maxMemoryBytes: 536_870_912, maxPids: 64 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 100_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: CONFIG.configId,
    configVersion: CONFIG.configVersion,
  };
}

/** One temp store, one temp repository, the seeded `AwaitPlan` task and the real UC-05 service. */
async function domain(scenario: string): Promise<Domain> {
  const root = mkdtempSync(join(tmpdir(), `uc03-approvals-probe-${scenario}-`));
  try {
    const workspaceId = `${WORKSPACE_ID}-${scenario}`;
    const repositoryRoot = join(root, 'repository');
    mkdirSync(join(repositoryRoot, 'src'), { recursive: true });
    mkdirSync(join(repositoryRoot, 'tests'), { recursive: true });
    writeFileSync(join(repositoryRoot, 'src/calculator.py'), SOURCE, 'utf8');
    writeFileSync(join(repositoryRoot, 'tests/test_calculator.py'), TEST_SOURCE, 'utf8');
    const filesystem = new WorkspaceFilesystemPort({ root: repositoryRoot });
    const revision = await filesystem.getCurrentRevisionDigest();
    const task = taskOf(revision);
    const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
    const plan: FixPlan = {
      planVersion: 1,
      diagnosis: 'The divisor is not guarded',
      suspectedCauseLocations: ['src/calculator.py:1'],
      evidenceRefs: ['evidence-baseline-t052-probe'],
      strategy: 'Reject a zero divisor before division',
      scopedChanges: ['src/calculator.py'],
      checkSetDigest,
      baselineRef: revision,
      strategyDigest: computeCanonicalSha256('Reject a zero divisor before division'),
      decisionRef: PLAN_DECISION,
    };
    const planBindingDigest = computePlanBindingDigest({
      taskId: TASK_ID,
      planVersion: plan.planVersion,
      strategyDigest: plan.strategyDigest,
      baselineRef: plan.baselineRef,
      evidenceRefs: plan.evidenceRefs,
      criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
      checkSetDigest,
      decisionRef: plan.decisionRef ?? '',
    });
    const trustedTransitions: Domain['trustedTransitions'] = {};
    const store = new DurableStore(join(root, 'store'));
    const statePort = new DurableStatePortV02({ store, taskId: TASK_ID, initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: AUTHORITY }, trustedTransitions });
    const approvals = new DurableApprovalStore({ storageDir: join(root, 'approvals'), durableStore: store, profile: PROFILE, provenance: 'real' });
    const source = createHostActionContext({ filesystem, workspaceId, repositoryId: REPOSITORY_ID, policyIdentity: POLICY, ttlMs: 600_000 });
    const context = {
      loadForAction: async (taskId: string, actionId: string) => {
        const observed = await source.observe(taskId, actionId);
        return { ...observed, freshness: planFreshness(task, plan, observed.facts.repositoryRevisionDigest, workspaceId, observed.action), runId: RUN_ID };
      },
      loadForDecision: async (decisionId: string) => context.loadForAction(TASK_ID, decisionId),
    };
    const service = createApprovalService({
      taskId: TASK_ID,
      profile: PROFILE,
      store: approvals,
      provenance: 'real',
      context,
      operator: { identity: { actorId: 'probe-driver-t052', channelRef: 'host-t052-probe', provenance: 'real' } },
      now: () => '2026-11-17T00:00:00.000Z',
    });
    await statePort.transition(
      {
        schemaVersion: CONTRACT_VERSION,
        stateVersion: 1,
        taskId: TASK_ID,
        runId: RUN_ID,
        workspaceId,
        repositoryId: REPOSITORY_ID,
        repositoryRevisionDigest: revision,
        goal: task.goal,
        observedBehavior: task.observedBehavior,
        expectedBehavior: task.expectedBehavior,
        reproduction: task.reproduction,
        acceptanceCriteria: task.acceptanceCriteria,
        constraints: task.constraints,
        requiredCheckIds: task.requiredChecks.map(check => check.checkId),
        taskContext: task,
        node: 'AwaitPlan',
        planVersion: plan.planVersion,
        replanCount: 0,
        plan,
        activeDecisionId: PLAN_DECISION,
        evidenceRefs: [...plan.evidenceRefs],
        changedPaths: [],
        risks: [],
        nextAction: 'await-plan-approval',
        budgetLedgers: seedLedgers(task),
      },
      0,
    );
    return {
      root,
      repositoryRoot,
      revision,
      workspaceId,
      statePort,
      service,
      source,
      task,
      plan,
      checkSetDigest,
      planBindingDigest,
      trustedTransitions,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function planFreshness(task: BugTask, plan: FixPlan, revision: string, workspaceId: string, observed: { readonly actionId: string; readonly kind: string }): Record<string, unknown> {
  const planAction =
    observed.kind === 'approve_fix_plan'
      ? {
          actionId: observed.actionId,
          kind: 'approve_fix_plan' as const,
          planVersion: plan.planVersion,
          strategyDigest: plan.strategyDigest,
          diagnosisEvidenceRefs: plan.evidenceRefs,
          checkSetDigest: plan.checkSetDigest,
        }
      : null;
  return {
    currentTaskId: TASK_ID,
    currentWorkspaceId: workspaceId,
    currentRepositoryRevisionDigest: revision,
    currentPolicyId: POLICY.policyId,
    currentPolicyVersion: POLICY.policyVersion,
    currentNormalizedActionDigest: planAction === null ? computeActionDigest(observed as never) : computeCanonicalSha256(planAction),
    currentPlanVersion: plan.planVersion,
    currentStrategyDigest: plan.strategyDigest,
    currentBaselineRef: plan.baselineRef,
    currentEvidenceRefs: [...plan.evidenceRefs],
    currentCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    currentCheckSetDigest: plan.checkSetDigest,
  };
}

const PLAN_ACTION = (d: Domain) => ({
  actionId: PLAN_DECISION,
  kind: 'approve_fix_plan' as const,
  planVersion: d.plan.planVersion,
  strategyDigest: d.plan.strategyDigest,
  diagnosisEvidenceRefs: d.plan.evidenceRefs,
  checkSetDigest: d.checkSetDigest,
});
const patchActionOf = (d: Domain): ApplyPatchAction => ({
  actionId: PATCH_DECISION,
  kind: 'apply_patch',
  patchContent: PATCH_TEXT,
  targetPaths: ['src/calculator.py'],
  baseRevisionDigest: d.revision,
});
const SAFETY = { workspaceContained: true, protectedContentAbsent: true, hiddenGradingAbsent: true, policyBypassAbsent: true, testsPreserved: true, commandSourceWritesAbsent: true, isolated: true };
const PLAN_ELEMENTS = {
  action: 'Approve the fix plan',
  necessity: 'Authorize the bounded repair',
  targets: ['src/calculator.py'],
  consequences: 'Approves one repair attempt',
  verificationStatus: 'Not executed',
};
const PATCH_ELEMENTS = {
  action: 'Apply the approved repair patch',
  necessity: 'Repair the divisor guard',
  targets: ['src/calculator.py'],
  consequences: 'Changes production code',
  verificationStatus: 'Not executed',
};
const POLICY_OPTIONS = { planApplicability: 'approved-plan' as const };

function planFacts(d: Domain): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    workspaceId: d.workspaceId,
    repositoryId: REPOSITORY_ID,
    repositoryRevisionDigest: d.revision,
    policyIdentity: POLICY,
    registeredActionDigest: computeActionDigest(PLAN_ACTION(d)),
    continuationRef: 'continuation-t052-probe',
    role: 'coder',
    safety: SAFETY,
    patch: null,
    command: null,
    plan: null,
  };
}

function planBindingOf(d: Domain): ApprovalBinding {
  return {
    decisionId: PLAN_DECISION,
    actionKind: 'fix_plan',
    normalizedActionDigest: computeCanonicalSha256(PLAN_ACTION(d)),
    taskId: TASK_ID,
    workspaceId: d.workspaceId,
    repositoryRevisionDigest: d.revision,
    policyId: POLICY.policyId,
    policyVersion: POLICY.policyVersion,
    planVersion: d.plan.planVersion,
    strategyDigest: d.plan.strategyDigest,
    baselineRef: d.plan.baselineRef,
    evidenceRefs: [...d.plan.evidenceRefs],
    criteriaDigest: computeCanonicalSha256(d.task.acceptanceCriteria),
    checkSetDigest: d.checkSetDigest,
    status: 'pending',
  };
}

function patchFacts(d: Domain, approvedPlan: ApprovalBinding, state?: TaskState): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    runId: RUN_ID,
    workspaceId: d.workspaceId,
    repositoryId: REPOSITORY_ID,
    repositoryRevisionDigest: d.revision,
    policyIdentity: POLICY,
    registeredActionDigest: computeActionDigest(patchActionOf(d)),
    continuationRef: 'continuation-t052-probe',
    role: 'coder',
    safety: SAFETY,
    patch: { fileCount: 1, addedDeletedLines: 3, dependencyChange: false, deletion: false, structuralChange: false, sensitiveConfiguration: true, productionCode: true },
    command: null,
    plan: { binding: approvedPlan, context: planFreshness(d.task, d.plan, d.revision, d.workspaceId, { actionId: PLAN_DECISION, kind: 'approve_fix_plan' }), materialChange: false, replanSlot: null },
    taskStateVersion: state?.stateVersion ?? 1,
    taskNode: state?.node ?? 'AwaitPlan',
    planApplicability: 'approved-plan',
    diagnosticPurpose: null,
    taskCriteriaDigest: null,
    checkSetDigest: d.checkSetDigest,
    testPath: null,
    checkId: null,
    planBindingDigest: d.planBindingDigest,
    planDecisionRef: PLAN_DECISION,
    providerRequest: null,
  };
}

function patchBindingOf(d: Domain): ApprovalBinding {
  return {
    decisionId: PATCH_DECISION,
    actionKind: 'action',
    normalizedActionDigest: computeActionDigest(patchActionOf(d)),
    taskId: TASK_ID,
    workspaceId: d.workspaceId,
    repositoryRevisionDigest: d.revision,
    policyId: POLICY.policyId,
    policyVersion: POLICY.policyVersion,
    status: 'pending',
  };
}

function admittedReceipt(receipt: PolicyEvaluationReceipt): Record<string, unknown> {
  const body = {
    receiptId: receipt.receiptId,
    actionDigest: receipt.actionDigest,
    freshnessContextDigest: receipt.freshnessContextDigest,
    policyId: receipt.policyId,
    policyVersion: receipt.policyVersion,
    configId: receipt.configId,
    configVersion: receipt.configVersion,
    decisionAuthorityGeneration: receipt.decisionAuthorityGeneration,
    result: receipt.result,
  };
  return { ...body, receiptDigest: computePolicyEvaluationReceiptDigest(body) };
}

/** The approved decision a service that did not enforce the rejection would have issued for this evaluation. */
function bypassDecisionFor(evaluation: PolicyEvaluationReceipt): ActionDecisionReceipt {
  return {
    decisionId: PATCH_DECISION,
    actionDigest: evaluation.actionDigest,
    evaluationReceiptRef: evaluation.receiptId,
    decisionAuthorityGeneration: evaluation.decisionAuthorityGeneration,
    status: 'approved',
  } as ActionDecisionReceipt;
}

function admittedDecision(receipt: ActionDecisionReceipt): Record<string, unknown> {
  const body = {
    decisionId: receipt.decisionId,
    actionDigest: receipt.actionDigest,
    evaluationReceiptRef: receipt.evaluationReceiptRef,
    decisionAuthorityGeneration: receipt.decisionAuthorityGeneration,
    status: 'approved' as const,
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
  };
  return { ...body, decisionDigest: computeActionDecisionReceiptDigest(body) };
}

function admissionContext(d: Domain, state: TaskState, receipts: { readonly pe: unknown; readonly ad?: unknown }): Record<string, unknown> {
  const action = patchActionOf(d);
  return {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'approved-plan',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: state.stateVersion,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 1,
    expectedEpoch: 1,
    taskId: TASK_ID,
    runId: RUN_ID,
    workspaceId: d.workspaceId,
    repositoryId: REPOSITORY_ID,
    runnableNode: state.node,
    canonicalRevision: d.revision,
    executionProfileId: 'uc03-pytest:real-tier',
    action,
    actionDigest: computeActionDigest(action),
    policyAuthorityRef: AUTHORITY,
    policyEvaluationReceipt: receipts.pe,
    ...(receipts.ad === undefined ? {} : { actionDecisionReceipt: receipts.ad }),
    planBindingDigest: d.planBindingDigest,
    planDecisionRef: PLAN_DECISION,
    baseRevision: d.revision,
    targetPaths: ['src/calculator.py'],
    patchDigest: computeCanonicalSha256(action.patchContent),
    finiteBounds: { maxPatchBytes: 4096, maxChangedPaths: 5 },
    reservationRefs: ['res-repair-t052-probe'],
  };
}

/**
 * One disposable container performs the approved edit: it writes the patched bytes into the bound
 * host repository and prints the checksum, so the revision the receiver verifies is a real container
 * effect. Its argv and exit code are the evidence this row retains.
 */
async function applyPatchInContainer(assembly: RealTierAssembly, repositoryRoot: string, patch: ApplyPatchAction): Promise<{ argv: readonly string[]; exitCode: number | null; stderr: string }> {
  const targetRel = patch.targetPaths[0] ?? 'src/calculator.py';
  const script = [
    'import base64,sys',
    'diff = base64.b64decode(sys.argv[1]).decode("utf-8")',
    'target = sys.argv[2]',
    'path = f"/workspace/repo/{target}"',
    'with open(path, "r", encoding="utf-8", newline="") as f:',
    '    orig = f.read().splitlines(keepends=True)',
    'hunk = [l for l in diff.splitlines(keepends=True) if l.startswith((" ", "+", "-")) and not l.startswith(("+++", "---"))]',
    'out, idx = [], 0',
    'for l in hunk:',
    '    if l[0] in " -":',
    '        if idx >= len(orig) or orig[idx] != l[1:]: sys.exit("PATCH_CONTEXT_MISMATCH")',
    '        if l[0] == " ": out.append(orig[idx])',
    '        idx += 1',
    '    elif l[0] == "+": out.append(l[1:])',
    'while idx < len(orig): out.append(orig[idx]); idx += 1',
    'with open(path, "w", encoding="utf-8", newline="") as f:',
    '    f.writelines(out)',
  ].join('\n');
  const dockerArgv = [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--platform=${assembly.profile.image.platform}`,
    `--user=${assembly.profile.image.user}`,
    `--cpus=${assembly.profile.limits.cpus}`,
    `--memory=${assembly.profile.limits.memoryBytes}`,
    `--pids-limit=${assembly.profile.limits.processes}`,
    `--mount=type=bind,source=${repositoryRoot},target=/workspace/repo`,
    assembly.metadata.imageId,
    'python3',
    '-c',
    script,
    Buffer.from(patch.patchContent, 'utf8').toString('base64'),
    targetRel,
  ];
  const result = await structuredSpawn('docker', dockerArgv, { timeoutMs: 60_000, maxOutputBytes: 64 * 1024 });
  return { argv: dockerArgv, exitCode: result.exitCode, stderr: result.stderr.slice(0, 200) };
}

interface InventoryComparison {
  readonly ok: boolean;
  readonly created: readonly string[];
  readonly deleted: readonly string[];
  readonly modified: readonly string[];
  readonly targetMatchesExpected: boolean;
}

function snapshotRepository(root: string): Map<string, string> {
  const inventory = new Map<string, string>();
  function walk(current: string, rel: string): void {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        inventory.set(relPath.replaceAll('\\', '/'), readFileSync(fullPath, 'utf8'));
      } else {
        // A symlink or other non-file entry is still a change to the tree, so it must show in the inventory.
        inventory.set(relPath.replaceAll('\\', '/'), entry.isSymbolicLink() ? `symlink:${readlinkSync(fullPath)}` : 'non-file-entry');
      }
    }
  }
  walk(root, '');
  return inventory;
}

function compareRepositoryInventories(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, expectedPath: string, expectedContent: string): InventoryComparison {
  const created: string[] = [];
  const deleted: string[] = [];
  const modified: string[] = [];

  for (const [path, content] of after.entries()) {
    if (!before.has(path)) {
      created.push(path);
    } else if (before.get(path) !== content) {
      modified.push(path);
    }
  }

  for (const path of before.keys()) {
    if (!after.has(path)) {
      deleted.push(path);
    }
  }

  const targetMatchesExpected = after.get(expectedPath) === expectedContent;
  const ok = created.length === 0 && deleted.length === 0 && modified.length === 1 && modified[0] === expectedPath && targetMatchesExpected;

  return {
    ok,
    created,
    deleted,
    modified,
    targetMatchesExpected,
  };
}

/**
 * The approved and rejected edit rows over the real service, the real v0.2 guard, the production
 * patch receiver and one disposable container per approved edit. A rejected decision reaches none.
 */
async function runApprovalRows(assembly: RealTierAssembly): Promise<{ rows: readonly Row[]; evidence: Record<string, unknown> }> {
  const rows: Row[] = [];
  const substrate = realSubstrate(assembly);
  const rejected = await rejectedScenario(substrate, 'rejected', false);
  rows.push(...rejected.rows);
  const approved = await approvedRow(substrate);
  rows.push(...approved.rows);
  return {
    rows,
    evidence: {
      decisions: rejected.decisions + approved.decisions,
      rejectedExitCodes: rejected.exitCodes,
      approvedExitCodes: approved.exitCodes,
      rejectedContainerAttempts: rejected.containerAttempts,
      approvedContainerAttempts: approved.containerAttempts,
      imageId: assembly.metadata.imageId,
    },
  };
}

/**
 * The rejected row in its own fresh task/store: an explicit rejection, then the same guarded receiver
 * the approved row uses. The guard refuses before the receiver, so the container counter stays zero and
 * the source bytes are unchanged; the receiver's `patchReceiver` is the only place a byte could change.
 *
 * `bypass` exists only for `--red-proof`: it presents the approved decision receipt a service that did
 * not enforce the rejection would have minted, so the same predicate is scored over a result in which
 * enforcement is absent.
 */
async function rejectedScenario(
  substrate: Substrate,
  scenario: string,
  bypass: boolean,
): Promise<{ rows: Row[]; decisions: number; exitCodes: (number | null)[]; containerAttempts: number; result: RejectedResult }> {
  const d = await domain(scenario);
  const rows: Row[] = [];
  const exitCodes: (number | null)[] = [];
  let decisions = 0;
  let harness: Awaited<ReturnType<typeof guardedHarness>> | undefined;
  let result: RejectedResult = { outcome: 'not-run', containerAttempts: 0, sourceChanged: false, stateChanged: false };
  let scenarioError: unknown;
  try {
    harness = await guardedHarness(substrate, d, exitCodes);
    await d.source.register({ action: PLAN_ACTION(d), facts: planFacts(d), elements: PLAN_ELEMENTS });
    await d.service.requestDecision(planBindingOf(d));
    const planView = await d.service.show(TASK_ID, PLAN_DECISION);
    const planDecisionResponse = 'approve-plan-t052-probe-rej';
    const planDecision = await d.service.decide({
      taskId: TASK_ID,
      decisionId: PLAN_DECISION,
      taskVersion: planView.control.version,
      requestVersion: 1,
      presentationDigest: planView.presentation.presentationDigest,
      decision: 'approve',
      responseKey: planDecisionResponse,
    });
    assert.equal(planDecision.outcome, 'ok', JSON.stringify(planDecision));
    decisions += 1;
    const approvedPlan = await d.service.resolve(PLAN_DECISION);
    const patchState = await enterPatch(d, approvedPlan, PLAN_DECISION);
    const patchAction = patchActionOf(d);
    await d.source.register({ action: patchAction, facts: patchFacts(d, approvedPlan, patchState), elements: PATCH_ELEMENTS });
    const evaluation = await d.service.evaluatePolicy(patchAction, { ...POLICY_OPTIONS, planBindingDigest: d.planBindingDigest, planDecisionRef: PLAN_DECISION });
    const pending = await d.service.requestDecision(patchBindingOf(d));
    rows.push(row('T025 the patch action starts as a pending decision', pending.status === 'pending', pending.status));

    const pendingView = await d.service.show(TASK_ID, PATCH_DECISION);
    const rejectPatchResponse = 'reject-patch-t052-probe';
    const rejection = await d.service.decide({
      taskId: TASK_ID,
      decisionId: PATCH_DECISION,
      taskVersion: pendingView.control.version,
      requestVersion: 1,
      presentationDigest: pendingView.presentation.presentationDigest,
      decision: 'reject',
      responseKey: rejectPatchResponse,
    });
    decisions += 1;
    rows.push(row('T025 rejected: the explicit rejection is recorded', rejection.outcome === 'ok', rejection.outcome));
    rows.push(row('T025 rejected: continuation reads the rejected decision', (await d.service.resolve(PATCH_DECISION)).status === 'rejected'));
    const issuanceRefused = await d.service.issueActionDecision(PATCH_DECISION, evaluation.receiptId).then(
      () => false,
      (error: unknown) => error instanceof ApprovalServiceError,
    );
    rows.push(row('T025 rejected: receipt issuance is refused for a rejected decision', issuanceRefused));

    // A second, conflicting decision on the same request is refused by the service, not by this probe.
    const lateDecisionResponse = 'approve-late-t052-probe';
    const conflicting = await d.service
      .decide({
        taskId: TASK_ID,
        decisionId: PATCH_DECISION,
        taskVersion: pendingView.control.version,
        requestVersion: 1,
        presentationDigest: pendingView.presentation.presentationDigest,
        decision: 'approve',
        responseKey: lateDecisionResponse,
      })
      .then(
        () => 'recorded',
        (error: unknown) => (error instanceof ApprovalServiceError ? error.outcome : 'unexpected'),
      );
    rows.push(row('T025 rejected: a conflicting late approval is refused as a conflict', conflicting === 'conflict', conflicting));

    // The same guarded receiver operation the approved row uses: an APPROVAL_REQUIRED receipt with no
    // approved decision must be refused before the receiver, leaving the source bytes and counter untouched.
    const before = await new WorkspaceFilesystemPort({ root: d.repositoryRoot }).getCurrentRevisionDigest();
    const stateBefore = await harness.fingerprint();
    const refused = await harness.dispatch(bypass ? { pe: admittedReceipt(evaluation), ad: admittedDecision(bypassDecisionFor(evaluation)) } : { pe: admittedReceipt(evaluation) });
    const after = await new WorkspaceFilesystemPort({ root: d.repositoryRoot }).getCurrentRevisionDigest();
    result = {
      outcome: refused.outcome,
      reason: refused.reason,
      containerAttempts: harness.containerAttempts(),
      sourceChanged: before !== after,
      stateChanged: stateBefore !== (await harness.fingerprint()),
    };
    rows.push(row('T025 rejected: the real guard refuses for the missing approval before any container and leaves source, task and journal unchanged', rejectedRefused(result), result));
  } catch (error) {
    scenarioError = error;
  } finally {
    let cleanupError: unknown;
    try {
      await cleanupScenario(substrate.manager.getController(), TASK_ID, d.workspaceId, () => d.cleanup());
    } catch (error) {
      cleanupError = error;
    }
    if (scenarioError !== undefined && cleanupError !== undefined) {
      throw new AggregateError([scenarioError, cleanupError], 'Scenario and cleanup failed');
    }
    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }
  return { rows, decisions, exitCodes, containerAttempts: harness?.containerAttempts() ?? 0, result };
}

/**
 * The approved row in its own fresh task/store: an explicit approval, then the container edit is
 * performed *inside* the receiver's `patchReceiver` (after the guard admits and the receiver begins
 * the attempt), so no source byte changes before admission.
 */
async function approvedRow(substrate: Substrate): Promise<{ rows: Row[]; decisions: number; exitCodes: (number | null)[]; containerAttempts: number }> {
  const d = await domain('approved');
  const rows: Row[] = [];
  const exitCodes: (number | null)[] = [];
  let decisions = 0;
  let harness: Awaited<ReturnType<typeof guardedHarness>> | undefined;
  let scenarioError: unknown;
  try {
    harness = await guardedHarness(substrate, d, exitCodes);
    await d.source.register({ action: PLAN_ACTION(d), facts: planFacts(d), elements: PLAN_ELEMENTS });
    await d.service.requestDecision(planBindingOf(d));
    const planView = await d.service.show(TASK_ID, PLAN_DECISION);
    const approvedPlanResponse = 'approve-plan-t052-probe-app';
    const planDecision = await d.service.decide({
      taskId: TASK_ID,
      decisionId: PLAN_DECISION,
      taskVersion: planView.control.version,
      requestVersion: 1,
      presentationDigest: planView.presentation.presentationDigest,
      decision: 'approve',
      responseKey: approvedPlanResponse,
    });
    assert.equal(planDecision.outcome, 'ok', JSON.stringify(planDecision));
    decisions += 1;
    const approvedPlan = await d.service.resolve(PLAN_DECISION);
    const patchState = await enterPatch(d, approvedPlan, PLAN_DECISION);

    const approvedAction = patchActionOf(d);
    await d.source.register({ action: approvedAction, facts: patchFacts(d, approvedPlan, patchState), elements: PATCH_ELEMENTS });
    const pending = await d.service.requestDecision(patchBindingOf(d));
    rows.push(row('T025 approved: the patch action starts as a pending decision', pending.status === 'pending', pending.status));
    const approvedView = await d.service.show(TASK_ID, PATCH_DECISION);
    const approvedPatchResponse = 'approve-patch-t052-probe';
    const approvalDecision = await d.service.decide({
      taskId: TASK_ID,
      decisionId: PATCH_DECISION,
      taskVersion: approvedView.control.version,
      requestVersion: 1,
      presentationDigest: approvedView.presentation.presentationDigest,
      decision: 'approve',
      responseKey: approvedPatchResponse,
    });
    decisions += 1;
    rows.push(row('T025 approved: the explicit approval is recorded', approvalDecision.outcome === 'ok', approvalDecision.outcome));
    const evaluation = await d.service.evaluatePolicy(approvedAction, { ...POLICY_OPTIONS, planBindingDigest: d.planBindingDigest, planDecisionRef: PLAN_DECISION });
    const decisionReceipt = await d.service.issueActionDecision(PATCH_DECISION, evaluation.receiptId);

    // The source equals its original bytes right up to the moment the guard admits and the receiver runs.
    const beforeInventory = snapshotRepository(d.repositoryRoot);
    const before = await new WorkspaceFilesystemPort({ root: d.repositoryRoot }).getCurrentRevisionDigest();
    rows.push(row('T025 approved: no source byte changes before admission', before === d.revision, { before, revision: d.revision }));

    const applied = await harness.dispatch({ pe: admittedReceipt(evaluation), ad: admittedDecision(decisionReceipt) });
    rows.push(row('T025 approved: the real guard settles exactly one patch', applied.outcome === 'success', { outcome: applied.outcome, reason: (applied as { reason?: string }).reason }));
    rows.push(row('T025 approved: exactly one container run performs the edit', exitCodes.length === 1 && exitCodes[0] === 0, { runs: exitCodes.length, exitCode: exitCodes[0] }));
    const after = await new WorkspaceFilesystemPort({ root: d.repositoryRoot }).getCurrentRevisionDigest();
    const afterInventory = snapshotRepository(d.repositoryRoot);
    const comparison = compareRepositoryInventories(beforeInventory, afterInventory, 'src/calculator.py', PATCHED);
    const patchMatches = after !== before && comparison.ok;
    rows.push(row('T025 approved: the edit landed only after admission', patchMatches, { before, after, comparison }));
  } catch (error) {
    scenarioError = error;
  } finally {
    let cleanupError: unknown;
    try {
      await cleanupScenario(substrate.manager.getController(), TASK_ID, d.workspaceId, () => d.cleanup());
    } catch (error) {
      cleanupError = error;
    }
    if (scenarioError !== undefined && cleanupError !== undefined) {
      throw new AggregateError([scenarioError, cleanupError], 'Scenario and cleanup failed');
    }
    if (scenarioError !== undefined) {
      throw scenarioError;
    }
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  }
  return { rows, decisions, exitCodes, containerAttempts: harness?.containerAttempts() ?? 0 };
}

/** The owner's `AwaitPlan -> Patch` transition after an explicit plan approval. */
async function enterPatch(d: Awaited<ReturnType<typeof domain>>, approvedPlan: ApprovalBinding, decisionId: string): Promise<TaskState> {
  const current = (await d.statePort.loadTask(TASK_ID)) as TaskState;
  const next: TaskState = { ...current, stateVersion: current.stateVersion + 1, node: 'Patch', nextAction: 'apply-patch' };
  d.trustedTransitions[next.stateVersion] = {
    approval: { binding: approvedPlan, freshness: planFreshness(d.task, d.plan, d.revision, d.workspaceId, { actionId: decisionId, kind: 'approve_fix_plan' }) },
  };
  await d.statePort.transition(next, current.stateVersion);
  return next;
}

/** The production guard/receiver over one domain, counting container attempts at the receiver. */
async function guardedHarness(
  substrate: Substrate,
  d: Awaited<ReturnType<typeof domain>>,
  exitCodes: (number | null)[],
): Promise<{
  dispatch(receipts: { readonly pe: unknown; readonly ad?: unknown }): Promise<{ readonly outcome: string; readonly reason?: string | undefined }>;
  containerAttempts: () => number;
  fingerprint: () => Promise<string>;
}> {
  const filesystem = new WorkspaceFilesystemPort({ root: d.repositoryRoot });
  const manager = substrate.manager;
  try {
    await manager.createWorkspace({ taskId: TASK_ID, workspaceId: d.workspaceId, initialRevisionDigest: d.revision, profile: substrate.profile });
  } catch (error) {
    try {
      await releaseWorkspaceVolumes(manager.getController(), TASK_ID, d.workspaceId);
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], 'Workspace creation and volume release failed');
    }
    throw error;
  }
  let attempts = 0;
  const receiver = createRepositoryReceiverV02({
    guardCapability: { provenance: 'real', capabilityId: `read-${TASK_ID}`, workspaceId: d.workspaceId, taskId: TASK_ID, mediateRead: async operation => await operation.execute() },
    fsPort: filesystem,
    limits: { maxExcerptBytes: 65_536, maxResultCount: 32 },
    expectedRevisionDigest: d.revision,
    provenance: 'real',
    workspaceRoot: d.repositoryRoot,
    statePort: d.statePort,
    workspaceManager: manager,
    adapterIdentity: `probe-adapter-${TASK_ID}`,
    processIncarnation: `probe-incarnation-${TASK_ID}`,
    fencingGeneration: 1,
    patchRecoveryHandoff: {
      prepare: async () => {
        throw new Error('Unexpected recovery for an observed patch');
      },
    },
    attemptStartRecoveryHandoff: {
      queryAttemptStart: async () => {
        throw new Error('Unexpected attempt-start recovery');
      },
    },
    unattemptedClaimClosureHandoff: {
      closeUnattemptedClaim: async () => {
        throw new Error('Unexpected claim closure');
      },
    },
    // The container edit runs here, after the guard admitted and the receiver began the attempt. The
    // bytes never change before this closure is reached, so a later refusal leaves the tree untouched.
    patchReceiver: async (admittedPatch: ApplyPatchAction) => {
      attempts += 1;
      const container = await substrate.edit(d.repositoryRoot, admittedPatch);
      exitCodes.push(container.exitCode);
      assert.equal(container.exitCode, 0, `container edit failed: ${container.stderr}`);
      const next = await filesystem.getCurrentRevisionDigest();
      manager.setCanonicalRevision(d.workspaceId, next);
      return { applied: true, newRevisionDigest: next };
    },
  });
  const guard = createExecutionGuardV02({ ports: { statePort: d.statePort, approvalPort: d.service, repositoryPort: receiver }, config: { provenance: 'real' } });
  return {
    containerAttempts: () => attempts,
    fingerprint: async () => computeCanonicalSha256({ task: await d.statePort.loadTask(TASK_ID), journal: d.statePort.getJournalSnapshot(TASK_ID) }),
    dispatch: async receipts => {
      const state = (await d.statePort.loadTask(TASK_ID)) as TaskState;
      return guard
        .validateAndExecute(patchActionOf(d), state, admissionContext(d, state, receipts) as never)
        .catch((error: unknown) => ({ outcome: 'denied', reason: error instanceof Error ? error.message : String(error) }));
    },
  };
}

/**
 * The rejected predicate over two results the real service, guard and receiver produced, on a Docker-free
 * substrate. The first is an ordinary rejection. The witness presents the approved decision a service that
 * did not enforce the rejection would have issued, so the same real path lands the edit: the predicate
 * must score that false, and this run exits nonzero by design. Removing enforcement from the guard turns
 * the first row red too, which a hand-built result could never do.
 */
async function redProof(): Promise<void> {
  const enforced = await rejectedScenario(inertSubstrate(), 'red-enforced', false);
  const bypassed = await rejectedScenario(inertSubstrate(), 'red-bypassed', true);
  if (!rejectedRefused(enforced.result)) {
    emit('fail', { failed: ['red-enforced-row-failed'], detail: `Enforced rejection did not behave as expected: ${JSON.stringify(enforced.result)}` });
    process.exitCode = 1;
    return;
  }
  const witnessLandedEdit = bypassed.result.outcome === 'success' && bypassed.result.containerAttempts === 1 && bypassed.result.sourceChanged;
  if (!witnessLandedEdit) {
    emit('fail', { failed: ['red-witness-row-failed'], detail: `Witness did not land edit as expected: ${JSON.stringify(bypassed.result)}` });
    process.exitCode = 1;
    return;
  }
  const beforeBaseline = new Map([
    ['src/calculator.py', SOURCE],
    ['tests/test_calculator.py', TEST_SOURCE],
  ]);
  const extraFileAfter = new Map([
    ['src/calculator.py', PATCHED],
    ['tests/test_calculator.py', TEST_SOURCE],
    ['src/extra.py', '# unauthorized created file\n'],
  ]);
  const extraFileCheck = compareRepositoryInventories(beforeBaseline, extraFileAfter, 'src/calculator.py', PATCHED);
  if (extraFileCheck.ok) {
    emit('fail', { failed: ['red-inventory-extra-file-failed'], detail: 'Inventory comparison unexpectedly passed with an extra created file' });
    process.exitCode = 1;
    return;
  }
  report(
    [
      row('RED-PROOF a rejection through the real guard is refused for the missing approval (must pass)', rejectedRefused(enforced.result), enforced.result),
      row('RED-PROOF WITNESS a rejection whose enforcement is bypassed lands the edit and must score false (this row must fail)', rejectedRefused(bypassed.result), bypassed.result),
      row('RED-PROOF WITNESS an extra created file fails repository inventory comparison (this row must fail)', extraFileCheck.ok, extraFileCheck),
    ],
    { redProof: true, note: 'exits nonzero by design: witness rows show predicates reject invalid results' },
  );
}

async function main(): Promise<void> {
  if (selfCheck) {
    report([row('SELF-CHECK deliberate red row', false, 'a failed row must never pass')], { selfCheck: true });
    return;
  }
  if (argv.includes('--red-proof')) {
    await redProof();
    return;
  }
  const created = createHostAssembly({
    fetch: (async () => {
      throw new Error('the T052 approval probe makes no model calls');
    }) as typeof globalThis.fetch,
  });
  if (!('host' in created)) {
    emit('not-run', { reason: created.reasonCode, path: created.path, detail: 'operator profile unavailable; see real-tier contract §(d)' });
    process.exitCode = 3;
    return;
  }
  const { assembly, metadata, preflight } = created;
  if (!isSupportedSnapshotPlatform(process.platform)) {
    emit('not-run', { reason: 'host-platform-unsupported', platform: process.platform, imageId: metadata.imageId });
    process.exitCode = 3;
    return;
  }
  const ready = await preflight();
  if (!ready.ok) {
    emit('not-run', { reason: ready.reasonCode, imageId: metadata.imageId, detail: 'Docker daemon or pinned image unavailable' });
    process.exitCode = 3;
    return;
  }
  if (typeof process.getuid === 'function') {
    const configuredUid = Number.parseInt(assembly.profile.image.user.split(':')[0] ?? '', 10);
    if (!Number.isNaN(configuredUid) && process.getuid() !== configuredUid) {
      emit('not-run', {
        reason: 'operator-container-uid-mismatch',
        imageId: metadata.imageId,
        detail: `Host operator UID ${process.getuid()} does not match configured container user ${assembly.profile.image.user}`,
      });
      process.exitCode = 3;
      return;
    }
  }
  let outcome: { rows: readonly Row[]; evidence: Record<string, unknown> };
  try {
    outcome = await runApprovalRows(assembly);
  } catch (error) {
    emit('fail', { failed: ['probe'], detail: error instanceof Error ? error.message.slice(0, 400) : 'probe failed' });
    process.exitCode = 1;
    return;
  }
  report(outcome.rows, {
    ...outcome.evidence,
    imageBase: assembly.profile.image.base,
    platform: assembly.profile.image.platform,
    deliveryRevision: assembly.revision,
    profileDigest: assembly.metadata.profileDigest,
    dockerServerVersion: ready.dockerServerVersion,
  });
}

await main();
