/**
 * Focused unit regressions for real-tier case execution and operator handling
 * (PR #260 CodeRabbit findings).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import type { BugTask, CommandView, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { resolveRealTierAssembly, type RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { createOperatorDecisionSource, type DecisionTarget, type OperatorIo } from '../../../src/runtime/real-tier-case-operator.ts';
import { abandonRealTierWorkingCopy, executeRealTierCase, findSettledCommandAdmission } from '../../../src/runtime/real-tier-case-run.ts';
import { REAL_TIER_DELIVERY_CONTRACT } from '../../../src/runtime/real-tier-owners.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import type { UC03WorkflowResult } from '../../../src/uc03/graph-types.ts';
import { buildCaseEvidence } from '../integration/uc03-success-real-run-cases.ts';
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';
import { createScanFixture } from './real-tier-scan-fixtures.ts';

function createMockAssemblyWithClaimDir(claimDir: string): RealTierAssembly {
  return {
    owners: {
      taskOwners: () => ({
        statePort: {
          store: {
            getClaimPath: (_taskId: string, claimId: string) => join(claimDir, `${claimId}.json`),
          },
        },
      }),
    },
  } as unknown as RealTierAssembly;
}

const sampleCommandViewA: CommandView = {
  viewId: 'view-c01-1',
  viewDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  taskId: 'task-c01-001',
  workspaceId: 'ws-c01',
  canonicalRevisionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  admittedFiles: [{ path: 'src/calc.py', digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' }],
  exclusionsPolicyVersion: '1.0.0',
  scratchIdentity: 'scratch-1',
  mountedReadOnly: true,
};

const sampleCommandViewBReordered: CommandView = {
  mountedReadOnly: true,
  scratchIdentity: 'scratch-1',
  exclusionsPolicyVersion: '1.0.0',
  admittedFiles: [{ digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111', path: 'src/calc.py' }],
  canonicalRevisionDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  workspaceId: 'ws-c01',
  taskId: 'task-c01-001',
  viewDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  viewId: 'view-c01-1',
};

const sampleCommandViewCDifferentAdmittedDigest: CommandView = {
  ...sampleCommandViewA,
  admittedFiles: [{ path: 'src/calc.py', digest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222' }],
};

test('finding 4683701580: command-view digest changes when nested admitted-file digest changes and is stable on key reordering', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'claim-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'claim-b-'));
  const dirC = mkdtempSync(join(tmpdir(), 'claim-c-'));

  try {
    writeFileSync(
      join(dirA, 'claim.json'),
      JSON.stringify({
        status: 'settled',
        context: { subjectKind: 'repository-action', commandView: sampleCommandViewA },
        receipt: { claimId: 'claim-a' },
      }),
      'utf8',
    );
    writeFileSync(
      join(dirB, 'claim.json'),
      JSON.stringify({
        status: 'settled',
        context: { subjectKind: 'repository-action', commandView: sampleCommandViewBReordered },
        receipt: { claimId: 'claim-b' },
      }),
      'utf8',
    );
    writeFileSync(
      join(dirC, 'claim.json'),
      JSON.stringify({
        status: 'settled',
        context: { subjectKind: 'repository-action', commandView: sampleCommandViewCDifferentAdmittedDigest },
        receipt: { claimId: 'claim-c' },
      }),
      'utf8',
    );

    const ids = { taskId: 'task-c01-001', workspaceId: 'ws-c01' };
    const resA = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dirA), ids, 'repo-1');
    const resB = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dirB), ids, 'repo-1');
    const resC = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dirC), ids, 'repo-1');

    assert.ok(resA.commandViewDigest, 'resA should have commandViewDigest');
    assert.ok(resB.commandViewDigest, 'resB should have commandViewDigest');
    assert.ok(resC.commandViewDigest, 'resC should have commandViewDigest');

    // Equivalent key-reordered view must produce identical digest
    assert.strictEqual(resA.commandViewDigest, resB.commandViewDigest);

    // Changing nested admitted-file digest must produce a different commandViewDigest
    assert.notStrictEqual(resA.commandViewDigest, resC.commandViewDigest);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(dirC, { recursive: true, force: true });
  }
});

test('finding 4683701594: findSettledCommandAdmission ignores unsettled claims and returns settled claims', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-settle-'));
  try {
    // 1. Unsettled claim (e.g. status === 'claimed') must be ignored
    writeFileSync(
      join(dir, 'claim-unsettled.json'),
      JSON.stringify({
        status: 'claimed',
        context: { subjectKind: 'repository-action', commandView: sampleCommandViewA },
        receipt: { claimId: 'claim-unsettled' },
      }),
      'utf8',
    );

    const ids = { taskId: 'task-c01-001', workspaceId: 'ws-c01' };
    const resUnsettled = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dir), ids, 'repo-1');
    assert.strictEqual(resUnsettled.commandView, undefined, 'unsettled claim must be ignored');

    // 2. Settled claim (status === 'settled') is returned
    writeFileSync(
      join(dir, 'claim-settled.json'),
      JSON.stringify({
        status: 'settled',
        context: { subjectKind: 'repository-action', commandView: sampleCommandViewA },
        receipt: { claimId: 'claim-settled-1' },
      }),
      'utf8',
    );

    // Remove the unsettled file so settled is the only candidate in directory
    rmSync(join(dir, 'claim-unsettled.json'), { force: true });
    const resSettled = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dir), ids, 'repo-1');
    assert.ok(resSettled.commandView, 'settled claim should be returned');
    assert.strictEqual(resSettled.commandAdmissionRef, 'claim-settled-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finding 4683701562: malformed presentation reports unexpected-shape without throwing', async () => {
  const written: string[] = [];
  const io: OperatorIo = {
    write: line => written.push(line),
    read: async () => 'approve',
  };
  const decisionSource = createOperatorDecisionSource(io);

  // Subcase 1: elements is missing
  const targetMissingElements: DecisionTarget = {
    taskId: 'task-1',
    console: {
      presentation: async () => ({
        ok: true,
        value: {
          taskId: 'task-1',
          presentation: {
            decisionId: 'dec-1',
            requestVersion: 1,
            presentationDigest: 'sha256:presentation-digest',
          },
        },
      }),
      decide: async () => ({ ok: true, reasonCode: '' }),
    } as unknown as DecisionTarget['console'],
  };

  const res1 = await decisionSource('C01', targetMissingElements);
  assert.strictEqual(res1, undefined);
  assert.ok(
    written.some(line => line.includes('unexpected-shape')),
    'should report unexpected-shape when elements is missing',
  );

  // Subcase 2: targets is not an array
  written.length = 0;
  const targetMalformedTargets: DecisionTarget = {
    taskId: 'task-1',
    console: {
      presentation: async () => ({
        ok: true,
        value: {
          taskId: 'task-1',
          presentation: {
            decisionId: 'dec-2',
            requestVersion: 1,
            presentationDigest: 'sha256:presentation-digest',
            elements: {
              action: 'test',
              necessity: 'test necessity',
              targets: 'not-an-array',
              consequences: 'test consequences',
              verificationStatus: 'test verification',
            },
          },
        },
      }),
      decide: async () => ({ ok: true, reasonCode: '' }),
    } as unknown as DecisionTarget['console'],
  };

  const res2 = await decisionSource('C01', targetMalformedTargets);
  assert.strictEqual(res2, undefined);
  assert.ok(
    written.some(line => line.includes('unexpected-shape')),
    'should report unexpected-shape when targets is not an array',
  );
});

test('finding 4683701653: C02 drops reportDigest while C01 keeps judged value', () => {
  const executionEvidence = {
    snapshot: { snapshotId: 'snap-1', digest: 'sha256:snap' },
    reportDigest: 'sha256:core-report-digest',
  };

  // C02 must not carry reportDigest, even if core execution produced it
  const c02Evidence = buildCaseEvidence('C02', executionEvidence, undefined);
  assert.strictEqual(c02Evidence.reportDigest, undefined, 'C02 evidence artifact must not gain reportDigest');

  // C01 must keep judged reportDigest
  const judgedReport = {
    facts: {
      present: true,
      reportDigest: 'sha256:judged-c16-report-digest',
    },
  };
  const c01Evidence = buildCaseEvidence('C01', executionEvidence, judgedReport as never);
  assert.strictEqual(c01Evidence.reportDigest, 'sha256:judged-c16-report-digest', 'C01 retains judged reportDigest');
});

async function createWorkingCopyFixture(tag: string) {
  const fixture = createScanFixture(`rtc-copy-${tag}-`, `rtc-copy-key-${tag}`);
  const root = mkdtempSync(join(tmpdir(), `rtc-cat-${tag}-`));
  const repoDir = join(root, 'repository');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  mkdirSync(join(repoDir, 'tests'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'calculator.py'), 'def divide(a, b):\n    return a / b\n', 'utf8');
  writeFileSync(join(repoDir, 'tests', 'test_calculator.py'), 'from src.calculator import divide\n\ndef test_div():\n    assert divide(4, 2) == 2\n', 'utf8');
  const initialDigest = await new WorkspaceFilesystemPort({ root: repoDir }).getCurrentRevisionDigest();
  const task: BugTask = {
    taskId: `task-copy-${tag}`,
    repositoryId: `repo-copy-${tag}`,
    initialRevisionDigest: initialDigest,
    goal: 'Fix division',
    observedBehavior: 'ZeroDivisionError',
    expectedBehavior: 'CalculationError',
    reproduction: 'pytest -q tests/test_calculator.py',
    acceptanceCriteria: ['Raises domain error'],
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
    budgetLimits: { maxReplanCount: 3, maxTokens: 200_000, maxCostUsd: 2, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-v1',
    configVersion: '1.0.0',
  };
  const doc = JSON.stringify({ task, repositoryRoot: 'repository' });
  const fixturePath = join(root, 'case.json');
  writeFileSync(fixturePath, doc, 'utf8');
  const catalogPath = join(root, 'catalog.json');
  writeFileSync(
    catalogPath,
    JSON.stringify({
      catalog: [
        {
          caseId: 'C01',
          initialRepositoryDigest: initialDigest.replace(/^sha256:/u, ''),
          fixturePath,
          fixtureDigest: sha256Text(doc),
        },
      ],
    }),
    'utf8',
  );
  const stateRoot = mkdtempSync(join(tmpdir(), `rtc-state-${tag}-`));
  const spawn = createVolumeSpawn();
  const rev = 'b'.repeat(40);
  const resolved = resolveRealTierAssembly({
    env: fixture.envOf({ catalog: { path: catalogPath } }),
    spawn: spawn.spawn,
    stateRoot,
    revision: rev,
  });
  assert.equal(resolved.status, 'assembly-ready');
  const assembly = resolved;
  const pins = {
    contractVersion: REAL_TIER_DELIVERY_CONTRACT,
    revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, rev])),
  };
  const identity = {
    profileId: 'profile-copy',
    profileDigest: assembly.metadata.profileDigest,
    configDigest: `sha256:${sha256Text('cfg')}`,
    pricingDigest: `sha256:${sha256Text('prc')}`,
  };
  return {
    assembly,
    pins,
    identity,
    cleanup: () => {
      rmSync(fixture.OUTSIDE, { recursive: true, force: true });
      rmSync(fixture.REPO, { recursive: true, force: true });
      rmSync(fixture.BASE, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}

test('AC7: core-owned working copy stays alive across approvalRequired pause, resumes cleanly, and is deleted on terminal return', async () => {
  const ctx = await createWorkingCopyFixture('resume');
  try {
    let phase: 'pause' | 'complete' = 'pause';
    const fakeRunGraph = (async task => {
      if (phase === 'pause') {
        return {
          outcome: 'pending-approval',
          state: { activeDecisionId: 'dec-plan', repositoryRevisionDigest: task.initialRevisionDigest } as unknown as TaskState,
          reasons: ['pending-approval'],
        } as unknown as UC03WorkflowResult;
      }
      return {
        outcome: 'COMPLETED',
        state: { repositoryRevisionDigest: task.initialRevisionDigest } as unknown as TaskState,
        reasons: [],
      } as unknown as UC03WorkflowResult;
    }) as NonNullable<Parameters<typeof executeRealTierCase>[0]['runGraph']>;

    const paused = await executeRealTierCase({
      assembly: ctx.assembly,
      caseId: 'C01',
      pins: ctx.pins,
      identity: ctx.identity,
      decideApproval: async () => undefined,
      runGraph: fakeRunGraph,
    });
    assert.equal(paused.status, 'task-bound', `paused failed with ${paused.reasonCode}`);
    assert.equal(paused.approvalRequired, true);
    assert.ok(paused.repositoryRoot);
    assert.equal(existsSync(paused.repositoryRoot), true, 'core-owned copy must survive approvalRequired pause');
    const coreCopyParent = dirname(paused.repositoryRoot);
    assert.equal(existsSync(coreCopyParent), true);

    phase = 'complete';
    const resumed = await executeRealTierCase({
      assembly: ctx.assembly,
      caseId: 'C01',
      pins: ctx.pins,
      identity: ctx.identity,
      decideApproval: async () => 'approve',
      runGraph: fakeRunGraph,
    });
    assert.equal(resumed.status, 'task-bound', `resume should not fail with ${resumed.reasonCode}`);
    assert.equal(resumed.repositoryRoot, paused.repositoryRoot);
    assert.equal(resumed.result?.outcome, 'COMPLETED');
    assert.equal(existsSync(paused.repositoryRoot), false, 'core-owned copy must be removed on terminal completion');
    assert.equal(existsSync(coreCopyParent), false);
  } finally {
    ctx.cleanup();
  }
});

test('AC7: abandonRealTierWorkingCopy releases a paused core-owned working copy exactly once', async () => {
  const ctx = await createWorkingCopyFixture('abandon');
  try {
    const fakeRunGraph = (async task =>
      ({
        outcome: 'pending-approval',
        state: { activeDecisionId: 'dec-plan', repositoryRevisionDigest: task.initialRevisionDigest } as unknown as TaskState,
        reasons: ['pending-approval'],
      }) as unknown as UC03WorkflowResult) as NonNullable<Parameters<typeof executeRealTierCase>[0]['runGraph']>;

    const paused = await executeRealTierCase({
      assembly: ctx.assembly,
      caseId: 'C01',
      pins: ctx.pins,
      identity: ctx.identity,
      decideApproval: async () => undefined,
      runGraph: fakeRunGraph,
    });
    assert.equal(paused.status, 'task-bound', `abandon paused failed with ${paused.reasonCode}`);
    assert.equal(paused.approvalRequired, true);
    assert.ok(paused.repositoryRoot);
    assert.equal(existsSync(paused.repositoryRoot), true);

    assert.equal(abandonRealTierWorkingCopy(ctx.assembly, 'C01'), true);
    assert.equal(existsSync(paused.repositoryRoot), false);
    assert.equal(existsSync(dirname(paused.repositoryRoot)), false);
    assert.equal(abandonRealTierWorkingCopy(ctx.assembly, 'C01'), false);
  } finally {
    ctx.cleanup();
  }
});

test('AC7: caller-owned workingCopyRoot survives both pause and terminal completion until caller cleans up', async () => {
  const ctx = await createWorkingCopyFixture('caller');
  const callerRoot = mkdtempSync(join(tmpdir(), 'rtc-caller-root-'));
  try {
    let phase: 'pause' | 'complete' = 'pause';
    const fakeRunGraph = (async task => {
      if (phase === 'pause') {
        return {
          outcome: 'pending-approval',
          state: { activeDecisionId: 'dec-plan', repositoryRevisionDigest: task.initialRevisionDigest } as unknown as TaskState,
          reasons: ['pending-approval'],
        } as unknown as UC03WorkflowResult;
      }
      return {
        outcome: 'COMPLETED',
        state: { repositoryRevisionDigest: task.initialRevisionDigest } as unknown as TaskState,
        reasons: [],
      } as unknown as UC03WorkflowResult;
    }) as NonNullable<Parameters<typeof executeRealTierCase>[0]['runGraph']>;

    const paused = await executeRealTierCase({
      assembly: ctx.assembly,
      caseId: 'C01',
      pins: ctx.pins,
      identity: ctx.identity,
      workingCopyRoot: callerRoot,
      decideApproval: async () => undefined,
      runGraph: fakeRunGraph,
    });
    assert.equal(paused.status, 'task-bound', `caller paused failed with ${paused.reasonCode}`);
    assert.equal(paused.approvalRequired, true);
    assert.ok(paused.repositoryRoot);
    assert.equal(existsSync(callerRoot), true);
    assert.equal(existsSync(paused.repositoryRoot), true);

    phase = 'complete';
    const resumed = await executeRealTierCase({
      assembly: ctx.assembly,
      caseId: 'C01',
      pins: ctx.pins,
      identity: ctx.identity,
      workingCopyRoot: callerRoot,
      decideApproval: async () => 'approve',
      runGraph: fakeRunGraph,
    });
    assert.equal(resumed.status, 'task-bound');
    assert.equal(resumed.repositoryRoot, paused.repositoryRoot);
    assert.equal(existsSync(callerRoot), true);
    assert.equal(existsSync(resumed.repositoryRoot), true);
  } finally {
    rmSync(callerRoot, { recursive: true, force: true });
    ctx.cleanup();
  }
});
