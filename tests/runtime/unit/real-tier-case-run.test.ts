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

function writeClaim(dir: string, name: string, status: string, commandView: CommandView, claimId: string): void {
  writeFileSync(join(dir, name), JSON.stringify({ status, context: { subjectKind: 'repository-action', commandView }, receipt: { claimId } }), 'utf8');
}

function presentationTarget(decisionId: string, elements?: Record<string, unknown>): DecisionTarget {
  return {
    taskId: 'task-1',
    console: {
      presentation: async () => ({
        ok: true,
        value: {
          taskId: 'task-1',
          presentation: { decisionId, requestVersion: 1, presentationDigest: 'sha256:presentation-digest', ...(elements ? { elements } : {}) },
        },
      }),
      decide: async () => ({ ok: true, reasonCode: '' }),
    } as unknown as DecisionTarget['console'],
  };
}

test('finding 4683701580: command-view digest changes when nested admitted-file digest changes and is stable on key reordering', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'claim-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'claim-b-'));
  const dirC = mkdtempSync(join(tmpdir(), 'claim-c-'));
  try {
    writeClaim(dirA, 'claim.json', 'settled', sampleCommandViewA, 'claim-a');
    writeClaim(dirB, 'claim.json', 'settled', sampleCommandViewBReordered, 'claim-b');
    writeClaim(dirC, 'claim.json', 'settled', sampleCommandViewCDifferentAdmittedDigest, 'claim-c');

    const ids = { taskId: 'task-c01-001', workspaceId: 'ws-c01' };
    const resA = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dirA), ids, 'repo-1');
    const resB = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dirB), ids, 'repo-1');
    const resC = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dirC), ids, 'repo-1');

    assert.ok(resA.commandViewDigest, 'resA should have commandViewDigest');
    assert.ok(resB.commandViewDigest, 'resB should have commandViewDigest');
    assert.ok(resC.commandViewDigest, 'resC should have commandViewDigest');
    assert.strictEqual(resA.commandViewDigest, resB.commandViewDigest);
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
    writeClaim(dir, 'claim-unsettled.json', 'claimed', sampleCommandViewA, 'claim-unsettled');
    const ids = { taskId: 'task-c01-001', workspaceId: 'ws-c01' };
    const resUnsettled = findSettledCommandAdmission(createMockAssemblyWithClaimDir(dir), ids, 'repo-1');
    assert.strictEqual(resUnsettled.commandView, undefined, 'unsettled claim must be ignored');

    writeClaim(dir, 'claim-settled.json', 'settled', sampleCommandViewA, 'claim-settled-1');
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
  const io: OperatorIo = { write: line => written.push(line), read: async () => 'approve' };
  const decisionSource = createOperatorDecisionSource(io);

  assert.strictEqual(await decisionSource('C01', presentationTarget('dec-1')), undefined);
  assert.ok(
    written.some(line => line.includes('unexpected-shape')),
    'should report unexpected-shape when elements is missing',
  );

  written.length = 0;
  const malformed = { action: 'test', necessity: 'test necessity', targets: 'not-an-array', consequences: 'test consequences', verificationStatus: 'test verification' };
  assert.strictEqual(await decisionSource('C01', presentationTarget('dec-2', malformed)), undefined);
  assert.ok(
    written.some(line => line.includes('unexpected-shape')),
    'should report unexpected-shape when targets is not an array',
  );
});

test('finding 4683701653: C02 drops reportDigest while C01 keeps judged value', () => {
  const executionEvidence = { snapshot: { snapshotId: 'snap-1', digest: 'sha256:snap' }, reportDigest: 'sha256:core-report-digest' };
  const c02Evidence = buildCaseEvidence('C02', executionEvidence, undefined);
  assert.strictEqual(c02Evidence.reportDigest, undefined, 'C02 evidence artifact must not gain reportDigest');

  const judgedReport = { facts: { present: true, reportDigest: 'sha256:judged-c16-report-digest' } };
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
  writeFileSync(catalogPath, JSON.stringify({ catalog: [{ caseId: 'C01', initialRepositoryDigest: initialDigest.replace(/^sha256:/u, ''), fixturePath, fixtureDigest: sha256Text(doc) }] }), 'utf8');
  const stateRoot = mkdtempSync(join(tmpdir(), `rtc-state-${tag}-`));
  const spawn = createVolumeSpawn();
  const rev = 'b'.repeat(40);
  const resolved = resolveRealTierAssembly({ env: fixture.envOf({ catalog: { path: catalogPath } }), spawn: spawn.spawn, stateRoot, revision: rev });
  assert.equal(resolved.status, 'assembly-ready');
  const pins = { contractVersion: REAL_TIER_DELIVERY_CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, rev])) };
  const identity = { profileId: 'profile-copy', profileDigest: resolved.metadata.profileDigest, configDigest: `sha256:${sha256Text('cfg')}`, pricingDigest: `sha256:${sha256Text('prc')}` };
  return {
    assembly: resolved,
    pins,
    identity,
    cleanup: () => {
      for (const dir of [fixture.OUTSIDE, fixture.REPO, fixture.BASE, root, stateRoot]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

type CopyCtx = Awaited<ReturnType<typeof createWorkingCopyFixture>>;
type RunCaseOpts = Partial<Parameters<typeof executeRealTierCase>[0]>;

async function withFixture(tag: string, fn: (ctx: CopyCtx) => Promise<void>): Promise<void> {
  const ctx = await createWorkingCopyFixture(tag);
  try {
    await fn(ctx);
  } finally {
    ctx.cleanup();
  }
}

const runCase = (ctx: CopyCtx, extra: RunCaseOpts) => executeRealTierCase({ assembly: ctx.assembly, caseId: 'C01', pins: ctx.pins, identity: ctx.identity, ...extra });

const pend = (decisionId: string) => ({ outcome: 'pending-approval', decisionId });

function makeRunGraph(steps: readonly { readonly outcome: string; readonly decisionId?: string }[]): NonNullable<RunCaseOpts['runGraph']> {
  let index = 0;
  return (async task => {
    const step = steps[Math.min(index++, steps.length - 1)] ?? { outcome: 'COMPLETED' };
    return {
      outcome: step.outcome,
      state: { ...(step.decisionId ? { activeDecisionId: step.decisionId } : {}), repositoryRevisionDigest: task.initialRevisionDigest } as unknown as TaskState,
      reasons: step.outcome === 'pending-approval' ? ['pending-approval'] : [],
    } as unknown as UC03WorkflowResult;
  }) as NonNullable<RunCaseOpts['runGraph']>;
}

const makePhaseGraph = (getPhase: () => 'pause' | 'complete'): NonNullable<RunCaseOpts['runGraph']> =>
  (async (task, ports, config) => makeRunGraph([getPhase() === 'pause' ? pend('dec-plan') : { outcome: 'COMPLETED' }])(task, ports, config)) as NonNullable<RunCaseOpts['runGraph']>;

function assertPaused(paused: Awaited<ReturnType<typeof executeRealTierCase>>, expectedDecisionId?: string): string {
  assert.equal(paused.status, 'task-bound', `paused failed with ${paused.reasonCode}`);
  assert.equal(paused.approvalRequired, true);
  assert.ok(paused.task && paused.ports?.repositoryPort && paused.ports?.statePort && paused.accounting);
  assert.equal(paused.result?.outcome, 'pending-approval');
  if (expectedDecisionId !== undefined) assert.equal(paused.result?.state?.activeDecisionId, expectedDecisionId);
  assert.equal(paused.gradeOutcome, undefined);
  assert.ok(paused.repositoryRoot);
  return paused.repositoryRoot;
}

function assertRejected(ctx: CopyCtx, res: Awaited<ReturnType<typeof executeRealTierCase>>, decided: 'approve' | 'reject'): void {
  assert.equal(res.status, 'task-bound');
  assert.equal(res.approvalRequired, undefined);
  assert.equal(res.approval?.decided, decided);
  assert.equal(res.result?.outcome, 'pending-approval');
  assert.ok(res.repositoryRoot);
  assert.equal(existsSync(res.repositoryRoot), false, 'reject must release core copy');
  assert.equal(abandonRealTierWorkingCopy(ctx.assembly, 'C01'), false);
}

test('AC7: core-owned working copy stays alive across approvalRequired pause, resumes cleanly, and is deleted on terminal return', () =>
  withFixture('resume', async ctx => {
    let phase: 'pause' | 'complete' = 'pause';
    const fakeRunGraph = makePhaseGraph(() => phase);
    const paused = await runCase(ctx, { decideApproval: async () => undefined, runGraph: fakeRunGraph });
    const pausedRoot = assertPaused(paused, 'dec-plan');
    assert.equal(existsSync(pausedRoot), true, 'core-owned copy must survive approvalRequired pause');
    const coreCopyParent = dirname(pausedRoot);
    assert.equal(existsSync(coreCopyParent), true);

    phase = 'complete';
    const resumed = await runCase(ctx, { decideApproval: async () => 'approve', runGraph: fakeRunGraph });
    assert.equal(resumed.status, 'task-bound', `resume should not fail with ${resumed.reasonCode}`);
    assert.equal(resumed.repositoryRoot, pausedRoot);
    assert.equal(resumed.result?.outcome, 'COMPLETED');
    assert.equal(existsSync(pausedRoot), false, 'core-owned copy must be removed on terminal completion');
    assert.equal(existsSync(coreCopyParent), false);
  }));

test('AC7: abandonRealTierWorkingCopy releases a paused core-owned working copy exactly once', () =>
  withFixture('abandon', async ctx => {
    const paused = await runCase(ctx, { decideApproval: async () => undefined, runGraph: makeRunGraph([pend('dec-plan')]) });
    const pausedRoot = assertPaused(paused, 'dec-plan');
    assert.equal(existsSync(pausedRoot), true);
    assert.equal(abandonRealTierWorkingCopy(ctx.assembly, 'C01'), true);
    assert.equal(existsSync(pausedRoot), false);
    assert.equal(existsSync(dirname(pausedRoot)), false);
    assert.equal(abandonRealTierWorkingCopy(ctx.assembly, 'C01'), false);
  }));

test('AC7: caller-owned workingCopyRoot survives both pause and terminal completion until caller cleans up', () =>
  withFixture('caller', async ctx => {
    const callerRoot = mkdtempSync(join(tmpdir(), 'rtc-caller-root-'));
    try {
      let phase: 'pause' | 'complete' = 'pause';
      const fakeRunGraph = makePhaseGraph(() => phase);
      const paused = await runCase(ctx, { workingCopyRoot: callerRoot, decideApproval: async () => undefined, runGraph: fakeRunGraph });
      const pausedRoot = assertPaused(paused, 'dec-plan');
      assert.equal(existsSync(callerRoot), true);
      assert.equal(existsSync(pausedRoot), true);

      phase = 'complete';
      const resumed = await runCase(ctx, { workingCopyRoot: callerRoot, decideApproval: async () => 'approve', runGraph: fakeRunGraph });
      assert.equal(resumed.status, 'task-bound');
      assert.equal(resumed.repositoryRoot, pausedRoot);
      assert.equal(existsSync(callerRoot), true);
      assert.equal(existsSync(pausedRoot), true);
    } finally {
      rmSync(callerRoot, { recursive: true, force: true });
    }
  }));

test('finding 4690270271: exhausting maxApprovalPauses retains core copy until abandon or terminal completion', async () => {
  await withFixture('maxpauses-abandon', async ctx => {
    const paused1 = await runCase(ctx, { maxApprovalPauses: 1, decideApproval: async () => 'approve', runGraph: makeRunGraph([pend('dec-plan'), pend('dec-verify')]) });
    const root1 = assertPaused(paused1, 'dec-verify');
    assert.equal(existsSync(root1), true);

    const paused2 = await runCase(ctx, { decideApproval: async () => undefined, runGraph: makeRunGraph([pend('dec-verify')]) });
    assert.equal(assertPaused(paused2, 'dec-verify'), root1, 'resumed call must reuse retained copy');
    assert.equal(existsSync(root1), true);
    assert.equal(abandonRealTierWorkingCopy(ctx.assembly, 'C01'), true);
    assert.equal(existsSync(root1), false);
    assert.equal(abandonRealTierWorkingCopy(ctx.assembly, 'C01'), false);
  });

  await withFixture('maxpauses-term', async ctx => {
    const paused = await runCase(ctx, { maxApprovalPauses: 1, decideApproval: async () => 'approve', runGraph: makeRunGraph([pend('dec-plan'), pend('dec-verify')]) });
    const root2 = assertPaused(paused, 'dec-verify');
    const done = await runCase(ctx, { decideApproval: async () => 'approve', runGraph: makeRunGraph([pend('dec-verify'), { outcome: 'COMPLETED' }]) });
    assert.equal(done.repositoryRoot, root2);
    assert.equal(done.result?.outcome, 'COMPLETED');
    assert.equal(existsSync(root2), false, 'terminal outcome must release retained core copy');
  });
});

test('finding 4690270271: clarificationHold while pending-approval pauses without deciding and retains core copy', () =>
  withFixture('clarify-hold', async ctx => {
    let decideCalls = 0;
    const paused = await runCase(ctx, {
      clarificationHold: () => true,
      decideApproval: async () => {
        decideCalls += 1;
        return 'approve';
      },
      runGraph: makeRunGraph([pend('dec-plan')]),
    });
    assert.equal(decideCalls, 0);
    const root = assertPaused(paused, 'dec-plan');
    assert.equal(existsSync(root), true);
    assert.equal(abandonRealTierWorkingCopy(ctx.assembly, 'C01'), true);
    assert.equal(existsSync(root), false);
  }));

test('finding 4690270271: reject at first or subsequent pause leaves reject behavior unchanged and releases core copy', async () => {
  await withFixture('reject-1', async ctx => {
    assertRejected(ctx, await runCase(ctx, { decideApproval: async () => 'reject', runGraph: makeRunGraph([pend('dec-plan')]) }), 'reject');
  });

  await withFixture('reject-2', async ctx => {
    const decisions: ('approve' | 'reject')[] = ['approve', 'reject'];
    let idx = 0;
    assertRejected(ctx, await runCase(ctx, { decideApproval: async () => decisions[idx++], runGraph: makeRunGraph([pend('dec-plan'), pend('dec-verify')]) }), 'approve');
  });
});
