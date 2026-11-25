/**
 * Regression tests for real-tier campaign durable case state isolation (Feature 007 T054, #246).
 *
 * Proves:
 * 1. Default campaign assembly allocates campaign+case-specific durable state roots.
 * 2. C10 runs on its own fresh state after a completed revision-changing C01 without
 *    hitting task-revision-mismatch from C01's revised repository state.
 * 3. Prior C01 state remains intact and unchanged under its own case root.
 * 4. Successive campaign invocations use distinct roots and cannot load prior campaign state.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { computeCanonicalSha256, computeCommandViewDigest, type BugTask, type CommandView, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { computeFileDigest } from '../../../src/foundation/docker-workspace-policy.ts';
import type { RealTierEnvironment } from '../../../src/runtime/real-tier-profile.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import type { UC03WorkflowResult } from '../../../src/uc03/graph-types.ts';
import { parseWorkflowFinalTree, type DerivedWorkflowFacts, type FinalTreeBinding, type TrustedFinalTreeSnapshotPort } from '../../../eval/uc03/workflow-evidence-facts.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';

import { allowedProviderResponse } from './uc03-success-real-c10.ts';
import type { GraderCapability } from './uc03-success-real-grader.ts';
import { PINNED_RETURNED_MODEL } from './uc03-success-real-provider.ts';
import { runCampaign } from './uc03-success-real-run.ts';

const fixture = createScanFixture('t054-isolation-', 't054-isolation-digest-key');
const REV = 'e'.repeat(40);
const FILES = { 'src/calculator.py': 'def divide(a, b):\n    return a / b\n' } as const;
const DIFF = `sha256:${'c'.repeat(64)}`;
const FINAL_REVISION = `sha256:${'f'.repeat(64)}`;

const tempRoot = (label: string): string => mkdtempSync(join(tmpdir(), `t054-iso-${label}-`));

function taskOf(): BugTask {
  const initial = computeCanonicalSha256(
    Object.keys(FILES)
      .sort()
      .map(path => `${path}\0${computeFileDigest(FILES[path as keyof typeof FILES])}\n`)
      .join(''),
  );
  return {
    taskId: 'task-isolation-001',
    repositoryId: 'repo-isolation',
    initialRevisionDigest: initial,
    goal: 'Divide by zero must raise a domain error',
    observedBehavior: 'divide(1, 0) raises ZeroDivisionError',
    expectedBehavior: 'divide(1, 0) raises CalculationError',
    reproduction: 'python -m pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['divide(1, 0) raises CalculationError'],
    constraints: [],
    requiredChecks: [
      {
        checkId: 'check-1',
        executable: 'pytest',
        argv: ['-q', 'tests/test_calculator.py'],
        purpose: 'reproduction',
        workingDirectory: '/workspace/repo',
        timeoutMs: 30_000,
        maxOutputBytes: 1_048_576,
      },
    ],
    limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuCores: 2, maxMemoryBytes: 2_147_483_648, maxPids: 64 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 2_000_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-v1',
    configVersion: '1.0.0',
  };
}

function catalogEnv(): RealTierEnvironment {
  const task = taskOf();
  const dir = tempRoot('catalog');
  mkdirSync(join(dir, 'repository', 'src'), { recursive: true });
  for (const [path, content] of Object.entries(FILES)) writeFileSync(join(dir, 'repository', path), content, 'utf8');
  const document = JSON.stringify({ task, repositoryRoot: 'repository' });
  const fixturePath = join(dir, 'case.json');
  writeFileSync(fixturePath, document, 'utf8');
  const material = JSON.stringify({
    criteria: {
      digest: `sha256:${sha256Text('iso-criteria')}`,
      criteria: [
        { criterionId: 'criterion-C01', caseId: 'C01', predicate: 'repair-success', hiddenCheckId: 'hidden-C01' },
        { criterionId: 'criterion-C02', caseId: 'C02', predicate: 'clarification', hiddenCheckId: null },
      ],
    },
    profile: {
      profileId: 'iso-grader',
      digest: `sha256:${sha256Text('iso-profile')}`,
      bounds: { timeoutMs: 10_000, maxCpuMs: 5_000, maxOutputBytes: 65_536, maxMemoryBytes: 536_870_912, maxProcesses: 8 },
    },
    graderPayload: null,
  });
  const graderPath = join(dir, 'grader.json');
  writeFileSync(graderPath, material, 'utf8');
  const entry = (caseId: string) => ({
    catalogEntryId: `entry-${caseId}`,
    caseId,
    initialRepositoryDigest: task.initialRevisionDigest.replace(/^sha256:/u, ''),
    fixturePath,
    fixtureDigest: sha256Text(document),
    grader: { version: '1.0.0', digest: `sha256:${sha256Text(material)}`, path: graderPath },
  });
  const catalogPath = join(dir, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ catalog: [entry('C01'), entry('C02')] }), 'utf8');
  return fixture.envOf({ catalog: { path: catalogPath } });
}

const finalReport = {
  taskId: 'task-isolation-001',
  runId: 'run',
  repositoryId: 'repo-isolation',
  outcome: 'COMPLETED',
  isComplete: true,
  diff: { diffDigest: DIFF, changedFiles: ['src/calculator.py'] },
  evidence: { verificationRefs: ['ver-1'], reviewRef: 'rev-1', evidenceRefs: ['ev-1'] },
  limitations: [],
  failureReasons: [],
  safeNextAction: 'none',
  usage: { tokensConsumed: 120, costUsd: 0.01, replanCount: 0, perLedger: [] },
  milestones: [],
  generatedAt: '2026-11-24T00:00:00.000Z',
};

function capability(): GraderCapability {
  const finalTree: TrustedFinalTreeSnapshotPort = {
    freezeFinalTree: binding => ({ ...binding, snapshotId: 'full.tree.iso', complete: true as const, files: [{ path: 'src/calculator.py', content: 'fixed' }] }),
    recheckCurrentFinalTree: binding => ({ ...binding, snapshotId: 'full.tree.iso', complete: true as const, files: [{ path: 'src/calculator.py', content: 'fixed' }] }),
  };
  return {
    tier: 'controlled-tier',
    finalTree,
    isolationAuthority: {
      admit: request => ({ kind: 'injected-mock-isolation-admission', admissionId: sha256Text(`iso-${request.finalSnapshot.digest}`), ...request }),
    },
    executor: {
      executorId: 'iso-hidden-check',
      execute: request => ({
        checkId: request.checkId,
        finalSnapshot: request.finalSnapshot,
        profile: request.profile,
        executorId: request.executorId,
        status: 'pass',
        actualOutcome: 'COMPLETED',
        durationMs: 1,
        cpuMs: 1,
        outputBytes: 1,
      }),
    },
    deriveFacts: async input => {
      const final = input.result.executionEvidence?.finalState;
      if (final === undefined || final === null) return undefined;
      const binding: FinalTreeBinding = {
        taskId: final.taskId,
        runId: final.runId,
        workspaceId: final.workspaceId,
        repositoryId: final.repositoryId,
        initialRevisionDigest: input.task.initialRevisionDigest,
        finalRevisionDigest: final.repositoryRevisionDigest,
      };
      const parsed = parseWorkflowFinalTree(await finalTree.freezeFinalTree(binding), binding);
      if (parsed === undefined) return undefined;
      const diff = input.result.finalReport?.diff.diffDigest ?? null;
      const facts: DerivedWorkflowFacts = {
        snapshot: parsed.snapshot,
        evidence: {
          digest: `sha256:${sha256Text(`${input.caseId}:${parsed.snapshot.digest}`)}`,
          snapshotDigest: parsed.snapshot.digest,
          diffDigest: diff as string,
          baselineFailed: true,
          requiredChecksPassed: true,
          focusedCheckPassed: true,
          testsProtected: true,
          reviewAccepted: true,
          reviewedDiffDigest: diff,
          sentinelsUnchanged: true,
          speculativePatchApplied: false,
          stoppedBeforeEffect: false,
          completionWithheld: input.caseId === 'C02',
        },
      };
      return facts;
    },
  };
}

/**
 * Graph double:
 * C01 pauses for plan approval then completes with revised repository digest FINAL_REVISION,
 * persisting the revised task state directly to its store so a shared state root would leak it.
 * C02 pauses at NeedsInfo.
 */
function revisionChangingGraphDouble() {
  let fresh = 0;
  return async (task: BugTask, ports: { statePort: { loadTask: (id: string) => Promise<unknown> } }, _config: unknown, initial?: TaskState) => {
    const loaded = (initial ?? (await ports.statePort.loadTask(task.taskId))) as TaskState;
    if (initial !== undefined) {
      const store = (ports.statePort as unknown as { store?: { getClaimPath?: (taskId: string, claimId: string) => string } }).store;
      if (store?.getClaimPath) {
        const claimFile = store.getClaimPath(task.taskId, 'claim-cmd-c01');
        mkdirSync(dirname(claimFile), { recursive: true });
        const commandView: CommandView = {
          viewId: 'view-c01-1',
          viewDigest: `sha256:${'c'.repeat(64)}`,
          taskId: task.taskId,
          workspaceId: loaded.workspaceId ?? 'ws-c01',
          canonicalRevisionDigest: loaded.repositoryRevisionDigest ?? `sha256:${'0'.repeat(64)}`,
          admittedFiles: [],
          exclusionsPolicyVersion: '1.0.0',
          scratchIdentity: 'scratch-1',
          mountedReadOnly: true,
        };
        const viewDigest = computeCommandViewDigest(commandView);
        writeFileSync(
          claimFile,
          JSON.stringify({
            status: 'settled',
            context: { subjectKind: 'repository-action', commandView: { ...commandView, viewDigest }, action: { actionId: 'action-cmd-c01' } },
            receipt: { claimId: 'claim-cmd-c01' },
          }),
          'utf8',
        );

        // Persist C01's revised task state into the durable store
        const taskFile = join(dirname(claimFile), 'v02', 'task.json');
        mkdirSync(dirname(taskFile), { recursive: true });
        const revisedState = {
          ...loaded,
          node: 'Deliver',
          outcome: 'COMPLETED',
          repositoryRevisionDigest: FINAL_REVISION,
          stateVersion: loaded.stateVersion + 1,
        } as unknown as TaskState;
        writeFileSync(taskFile, JSON.stringify(revisedState, null, 2), 'utf8');
      }
      const state = { ...loaded, node: 'Deliver', outcome: 'COMPLETED', repositoryRevisionDigest: FINAL_REVISION } as unknown as TaskState;
      return { outcome: 'COMPLETED', state, finalReport, reasons: [], milestones: [], executionEvidence: { finalState: state } } as unknown as UC03WorkflowResult;
    }
    fresh += 1;
    if (fresh === 1) return { outcome: 'pending-approval', state: { ...loaded, node: 'AwaitPlan', activeDecisionId: 'decision-1' }, reasons: [], milestones: [] } as unknown as UC03WorkflowResult;
    const state = { ...loaded, node: 'NeedsInfo', repositoryRevisionDigest: FINAL_REVISION } as unknown as TaskState;
    return { outcome: 'needs-info', state, reasons: [], milestones: [], executionEvidence: { finalState: state } } as unknown as UC03WorkflowResult;
  };
}

test('case state isolation: C10 succeeds after completed revision-changing C01 and prior C01 state remains unchanged', async () => {
  const baseStateRoot = tempRoot('base-state');
  const evidenceDir = tempRoot('evidence');
  let clockTime = 1_700_000_000_000;

  const result = await runCampaign({
    mode: 'campaign',
    spawn: createVolumeSpawn().spawn,
    env: catalogEnv(),
    repositoryRoot: tempRoot('repo'),
    evidenceDir,
    stateRoot: baseStateRoot,
    candidateSha: REV,
    clock: () => (clockTime += 1_000),
    preflight: async () => ({ ok: true, dockerServerVersion: '27.0.1', imageId: `sha256:${'a'.repeat(64)}` }),
    fetch: async () => allowedProviderResponse(PINNED_RETURNED_MODEL),
    runGraph: revisionChangingGraphDouble(),
    decideApproval: async () => 'approve',
    graderCapability: capability(),
  });

  // Verify C01 passed
  const c01Record = result.records.find(r => r.caseId === 'C01');
  assert.equal(c01Record?.outcome, 'pass', 'C01 should pass');

  // Verify C10 passed on its own fresh state rather than refusing with task-revision-mismatch
  const c10Record = result.records.find(r => r.caseId === 'C10');
  assert.equal(c10Record?.outcome, 'pass', 'C10 must pass without hitting task-revision-mismatch');
  assert.equal(c10Record?.reasonCode, undefined);

  // Verify case-specific roots were created
  const c01StateDir = join(baseStateRoot, result.campaignId, 'C01');
  const c10StateDir = join(baseStateRoot, result.campaignId, 'C10');
  assert.ok(existsSync(c01StateDir), 'C01 state directory must exist under campaign/case root');
  assert.ok(existsSync(c10StateDir), 'C10 state directory must exist under campaign/case root');

  // Verify C01 prior state remains intact with FINAL_REVISION under its own root
  const c01TaskFile = join(c01StateDir, 'store', 'claims', 'task-isolation-001', 'v02', 'task.json');
  assert.ok(existsSync(c01TaskFile), 'C01 task file must exist in C01 state root');
  const c01Persisted = JSON.parse(readFileSync(c01TaskFile, 'utf8')) as TaskState;
  assert.equal(c01Persisted.repositoryRevisionDigest, FINAL_REVISION, 'C01 state must retain FINAL_REVISION');
  assert.equal(c01Persisted.outcome, 'COMPLETED');

  // Successive invocation roots: run a second campaign and verify distinct roots
  const result2 = await runCampaign({
    mode: 'campaign',
    spawn: createVolumeSpawn().spawn,
    env: catalogEnv(),
    repositoryRoot: tempRoot('repo'),
    evidenceDir,
    stateRoot: baseStateRoot,
    candidateSha: REV,
    clock: () => (clockTime += 1_000),
    preflight: async () => ({ ok: true, dockerServerVersion: '27.0.1', imageId: `sha256:${'a'.repeat(64)}` }),
    fetch: async () => allowedProviderResponse(PINNED_RETURNED_MODEL),
    runGraph: revisionChangingGraphDouble(),
    decideApproval: async () => 'approve',
    graderCapability: capability(),
  });

  assert.notEqual(result.campaignId, result2.campaignId, 'Campaign IDs must be distinct');
  const c01StateDir2 = join(baseStateRoot, result2.campaignId, 'C01');
  assert.ok(existsSync(c01StateDir2), 'Campaign 2 C01 state directory must exist');
  assert.notEqual(c01StateDir, c01StateDir2, 'State directories for successive campaigns must be distinct');
});
