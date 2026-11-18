/**
 * The owner-held execution profile of a v0.2 admission (real-tier contract §(a), host §1).
 *
 * A real Docker-built view carries the workspace's own scratch volume, the view builder's exclusions
 * version and the pinned task's limits — never the port's synthetic admission constants. So the
 * owner supplies its profile to the port it binds; a view that disagrees with it is still refused.
 *
 * Every row runs the real durable port over a temp store: no Docker, network or provider is reached.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeActionDigest, computeCanonicalSha256, computeClaimClosureDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { BugTask, ExecutorIdentityV02, RepositoryAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { computeWorkspaceVolumeIds } from '../../../src/foundation/docker-workspace-policy.ts';
import type { ExecutionProfileSourceV02, ExecutionProfileV02 } from '../../../src/persistence/adapters/state-port-v02-admission.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { seedTaskState } from '../../../src/runtime/real-tier-task-seed.ts';

const TASK = 'task-owner-profile-001';
const RUN = 'run-owner-profile-1';
const WORKSPACE = 'ws-owner-profile-1';
const REVISION = `sha256:${'a'.repeat(64)}`;
const ACTION_ID = 'act-diag-1';
/** The real view's scratch identity: the workspace's own volume, never a synthetic admission label. */
const SCRATCH = computeWorkspaceVolumeIds(TASK, WORKSPACE).scratchVolumeId;
const ISOLATION = 'uc03-pytest:real-tier';

const task: BugTask = {
  taskId: TASK,
  repositoryId: 'repo-calculator',
  initialRevisionDigest: REVISION,
  goal: 'Divide by zero must raise a domain error',
  observedBehavior: 'divide(1, 0) raises ZeroDivisionError',
  expectedBehavior: 'divide(1, 0) raises CalculationError',
  reproduction: 'python -m pytest -q tests/test_calculator.py',
  acceptanceCriteria: ['divide(1, 0) raises CalculationError'],
  constraints: [],
  requiredChecks: [
    { checkId: 'check-1', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], purpose: 'reproduction', workingDirectory: 'tests', timeoutMs: 30_000, maxOutputBytes: 1_048_576 },
  ],
  limits: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuCores: 2, maxMemoryBytes: 2_147_483_648, maxPids: 64 },
  budgetLimits: { maxReplanCount: 3, maxTokens: 100_000, maxCostUsd: 5, maxRepairAttempts: 2, maxReviewIterations: 2 },
  configId: 'config-v1',
  configVersion: '1.0.0',
};

/** What the tier binds: the same values the Docker-built view of this task carries. */
const OWNER_PROFILE: ExecutionProfileV02 = {
  isolationProfileRef: ISOLATION,
  exclusionsPolicyVersion: '0.1.0',
  scratchIdentity: SCRATCH,
  commandBounds: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuSeconds: 60, maxMemoryBytes: 2_147_483_648, maxProcessCount: 64 },
  patchBounds: { maxPatchBytes: 4096, maxChangedPaths: 5 },
};

/** The port's own constants, which the admission still applies when no owner profile is supplied. */
const CONSTANT_VIEW = {
  exclusionsPolicyVersion: 'exclusions-v1',
  scratchIdentity: 'scratch-admission-v02',
  bounds: { timeoutMs: 30_000, maxOutputBytes: 1_048_576, maxCpuSeconds: 120, maxMemoryBytes: 536_870_912, maxProcessCount: 64 },
} as const;

const AUTHORITY = {
  policyId: task.configId,
  policyVersion: task.configVersion,
  configId: task.configId,
  configVersion: task.configVersion,
  issuerKeyRef: 'host-config-v1',
  decisionAuthorityGeneration: 1,
};

interface ViewFacts {
  readonly exclusionsPolicyVersion: string;
  readonly scratchIdentity: string;
  readonly bounds: Readonly<Record<'timeoutMs' | 'maxOutputBytes' | 'maxCpuSeconds' | 'maxMemoryBytes' | 'maxProcessCount', number>>;
}

const REAL_VIEW: ViewFacts = { exclusionsPolicyVersion: OWNER_PROFILE.exclusionsPolicyVersion, scratchIdentity: SCRATCH, bounds: OWNER_PROFILE.commandBounds };

const ACTION = { actionId: ACTION_ID, kind: 'run_command', executable: 'pytest', argv: ['-q', 'tests/test_calculator.py'], workingDirectory: 'tests', purpose: 'investigate' } as const;
const ACTION_DIGEST = computeActionDigest(ACTION);

/** A pre-plan diagnostic run_command admission over the view facts it names. */
function contextOf(view: ViewFacts): RepositoryAdmissionContextV02 {
  const { policyId, policyVersion, configId, configVersion, decisionAuthorityGeneration } = AUTHORITY;
  const receiptBody = {
    receiptId: `pe-${ACTION_ID}`,
    actionDigest: ACTION_DIGEST,
    freshnessContextDigest: computeCanonicalSha256({ freshness: ACTION_ID }),
    policyId,
    policyVersion,
    configId,
    configVersion,
    decisionAuthorityGeneration,
    result: 'ALLOWED' as const,
  };
  const commandView = {
    viewId: `view-${WORKSPACE}-${'a'.repeat(12)}`,
    taskId: TASK,
    workspaceId: WORKSPACE,
    canonicalRevision: REVISION,
    admittedFiles: [{ path: 'tests/test_calculator.py', digest: computeCanonicalSha256('test-file') }],
    exclusionsPolicyVersion: view.exclusionsPolicyVersion,
    scratchIdentity: view.scratchIdentity,
    mountedReadOnly: true as const,
    isolationProfileRef: ISOLATION,
  };
  return {
    schemaVersion: '0.2.0',
    subjectKind: 'repository-action',
    planApplicability: 'pre-plan-diagnostic',
    taskStateSchemaVersion: '0.2.0',
    expectedTaskStateVersion: 2,
    controlSchemaVersion: '0.2.0',
    expectedControlVersion: 1,
    expectedEpoch: 1,
    taskId: TASK,
    runId: RUN,
    workspaceId: WORKSPACE,
    repositoryId: task.repositoryId,
    runnableNode: 'Investigate',
    canonicalRevision: REVISION,
    executionProfileId: ISOLATION,
    action: ACTION,
    actionDigest: ACTION_DIGEST,
    policyAuthorityRef: AUTHORITY,
    policyEvaluationReceipt: { ...receiptBody, receiptDigest: computeCanonicalSha256(receiptBody) },
    commandView: { ...commandView, viewDigest: computeCanonicalSha256(commandView) },
    finiteBounds: { ...view.bounds, isolationProfileRef: ISOLATION },
    reservationRefs: ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].flatMap(kind => [`task-${kind}-${ACTION_ID}`, `run-${kind}-${ACTION_ID}`]),
    diagnosticPurpose: 'investigate',
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCanonicalSha256(task.requiredChecks),
    checkId: 'check-1',
    testPath: 'tests/test_calculator.py',
  } as unknown as RepositoryAdmissionContextV02;
}

/** One seeded task, moved to the pre-plan Investigate node a diagnostic admission expects. */
async function portFor(label: string, profile?: ExecutionProfileSourceV02): Promise<DurableStatePortV02> {
  const store = new DurableStore(join(mkdtempSync(join(tmpdir(), `owner-profile-${label}-`)), 'store'));
  const port = new DurableStatePortV02({
    store,
    initialControl: { controlVersion: 1, epoch: 1, mode: 'runnable', activeAuthorityRef: AUTHORITY },
    ...(profile === undefined ? {} : { executionProfile: profile }),
  });
  await port.transition(seedTaskState(task, { taskId: TASK, runId: RUN, workspaceId: WORKSPACE }), 0);
  const seeded = (await port.loadTask(TASK)) as TaskState;
  await port.transition({ ...seeded, node: 'Investigate', nextAction: 'propose-fix-plan', stateVersion: seeded.stateVersion + 1 }, seeded.stateVersion);
  return port;
}

const claimed = (claim: { readonly claimId: string }): string => claim.claimId;
const NEUTRAL = '';

test('(a) an owner-supplied profile admits the real view', async () => {
  const port = await portFor('a', OWNER_PROFILE);
  assert.equal(claimed(await port.claim(contextOf(REAL_VIEW))), `claim-${ACTION_ID}`);
});

test('(a2) the profile source may derive its values from the owner-known task and workspace', async () => {
  const port = await portFor('a2', (taskId, workspaceId) => ({ ...OWNER_PROFILE, scratchIdentity: computeWorkspaceVolumeIds(taskId, workspaceId).scratchVolumeId }));
  assert.equal(claimed(await port.claim(contextOf(REAL_VIEW))), `claim-${ACTION_ID}`);
});

test('(b) a view that disagrees with the owner profile is refused', async () => {
  const port = await portFor('b', OWNER_PROFILE);
  const rows: readonly (readonly [string, ViewFacts])[] = [
    ['a foreign scratch volume', { ...REAL_VIEW, scratchIdentity: `vol-scratch-${'b'.repeat(64)}` }],
    ['bounds larger than the owner allows', { ...REAL_VIEW, bounds: { ...OWNER_PROFILE.commandBounds, maxMemoryBytes: 4_294_967_296 } }],
    ['another exclusions version', { ...REAL_VIEW, exclusionsPolicyVersion: 'exclusions-v1' }],
  ];
  for (const [label, view] of rows) assert.equal(claimed(await port.claim(contextOf(view))), NEUTRAL, label);
});

test('(b2) an owner profile naming another isolation refuses the view the context pins to it', async () => {
  // The view's own isolation is the context's, so an owner profile for another profile is not a match.
  const port = await portFor('b2', { ...OWNER_PROFILE, isolationProfileRef: 'another-isolation-profile' });
  assert.equal(claimed(await port.claim(contextOf(REAL_VIEW))), NEUTRAL);
});

test('(c) without a source the port keeps its own constants', async () => {
  const realPort = await portFor('c-real');
  assert.equal(claimed(await realPort.claim(contextOf(REAL_VIEW))), NEUTRAL, 'a real view is not admitted by the constants');
  const constantPort = await portFor('c-constant');
  assert.equal(claimed(await constantPort.claim(contextOf(CONSTANT_VIEW))), `claim-${ACTION_ID}`, 'the constant-matching fixture is still admitted');
});

test('(e) the claim resolves the profile once: a source that throws or drifts afterwards leaves no orphaned reservation', async () => {
  // The profile is resolved before the first reservation write and reused for the stored trusted
  // context. A second call would otherwise validate under one ceiling, store another (a claim the next
  // read calls corrupt) or throw after the reservations were written, blocking a retry forever.
  const sources: readonly (readonly [string, (calls: { n: number }) => ExecutionProfileV02])[] = [
    [
      'throws on the second call',
      () => {
        throw new Error('source moved');
      },
    ],
    ['reports a lower ceiling on the second call', () => ({ ...OWNER_PROFILE, commandBounds: { ...OWNER_PROFILE.commandBounds, maxMemoryBytes: 1 } })],
  ];
  for (const [label, later] of sources) {
    const calls = { n: 0 };
    const port = await portFor('e', () => (++calls.n === 1 ? OWNER_PROFILE : later(calls)));
    const receipt = await port.claim(contextOf(REAL_VIEW));
    assert.equal(claimed(receipt), `claim-${ACTION_ID}`, label);
    assert.equal(calls.n, 1, `${label}: the source is asked once`);
    // The stored claim still validates, and the same context replays the same receipt rather than
    // re-reserving: the reservations are held by a live claim, not left behind by a failed write.
    assert.equal((await port.readClaimState(`claim-${ACTION_ID}`))?.status, 'claimed', label);
    assert.equal(claimed(await port.claim(contextOf(REAL_VIEW))), `claim-${ACTION_ID}`, `${label}: replay is idempotent`);
  }
});

test('(d) the later gates re-read the admission under the same profile', async () => {
  const recipient: ExecutorIdentityV02 = { adapterIdentity: 'adapter-owner-profile', processIncarnation: 'proc-owner-profile', fencingGeneration: 1, payloadDigest: ACTION_DIGEST };

  // The attempt gate: a claimed real-view admission still begins its attempt.
  const attemptPort = await portFor('d-attempt', OWNER_PROFILE);
  const attemptClaim = await attemptPort.claim(contextOf(REAL_VIEW));
  assert.equal(claimed(attemptClaim), `claim-${ACTION_ID}`);
  assert.equal((await attemptPort.beginAttempt(attemptClaim.claimId, recipient)).attemptId, `att-${attemptClaim.claimId}`);

  // The closure gate: a pause and a fence, then the same store through a port without the source.
  const port = await portFor('d-close', OWNER_PROFILE);
  const claim = await port.claim(contextOf(REAL_VIEW));
  assert.equal(claimed(claim), `claim-${ACTION_ID}`);
  const holdRef = 'pause-event-1';
  assert.equal(await port.setTaskControl(TASK, 'paused', holdRef), true);
  const fence = await port.fenceClaimRecipient(claim.claimId, recipient);
  assert.notEqual(fence, null);
  if (fence === null) return;
  const body = {
    receiptId: 'closure-act-diag-1',
    claimId: claim.claimId,
    taskId: TASK,
    reason: holdRef,
    fencedExecutorIdentity: fence.fencedExecutorIdentity,
    unconsumedReservations: [...claim.reservationRefs],
  };
  const receipt = { ...body, receiptDigest: computeClaimClosureDigest(body) };

  const constantPort = new DurableStatePortV02({ store: port.store });
  // The reservation was held under the claim's own admission, which pinned the profile: a port without
  // that source (or one whose source changed) must still be able to release it.
  assert.deepEqual(await constantPort.closeUnattemptedClaim(receipt), { closed: true, receiptId: receipt.receiptId });
});

test('(f) a profile source that drifts or throws after the claim cannot strand the held reservation', async () => {
  const recipient: ExecutorIdentityV02 = { adapterIdentity: 'adapter-owner-profile', processIncarnation: 'proc-owner-profile', fencingGeneration: 1, payloadDigest: ACTION_DIGEST };
  const later: readonly (readonly [string, () => ExecutionProfileV02])[] = [
    [
      'throws',
      () => {
        throw new Error('source moved');
      },
    ],
    ['reports a lower ceiling', () => ({ ...OWNER_PROFILE, commandBounds: { ...OWNER_PROFILE.commandBounds, maxMemoryBytes: 1 } })],
  ];
  for (const [label, drifted] of later) {
    // The attempt gate still begins: admission pinned the profile, so later drift is not re-admitted.
    const calls = { n: 0 };
    const attemptPort = await portFor(`f-attempt-${label.replaceAll(' ', '-')}`, () => (++calls.n === 1 ? OWNER_PROFILE : drifted()));
    const attemptClaim = await attemptPort.claim(contextOf(REAL_VIEW));
    assert.equal(claimed(attemptClaim), `claim-${ACTION_ID}`, label);
    assert.equal((await attemptPort.beginAttempt(attemptClaim.claimId, recipient)).attemptId, `att-${attemptClaim.claimId}`, `${label}: the attempt uses the admission-bound profile`);

    // The closure gate releases the held reservation instead of orphaning it.
    const closeCalls = { n: 0 };
    const port = await portFor(`f-close-${label.replaceAll(' ', '-')}`, () => (++closeCalls.n === 1 ? OWNER_PROFILE : drifted()));
    const claim = await port.claim(contextOf(REAL_VIEW));
    assert.equal(claimed(claim), `claim-${ACTION_ID}`, label);
    const holdRef = `pause-event-${label.replaceAll(' ', '-')}`;
    assert.equal(await port.setTaskControl(TASK, 'paused', holdRef), true);
    const fence = await port.fenceClaimRecipient(claim.claimId, recipient);
    assert.ok(fence, label);
    const body = {
      receiptId: `closure-${label.replaceAll(' ', '-')}`,
      claimId: claim.claimId,
      taskId: TASK,
      reason: holdRef,
      fencedExecutorIdentity: fence.fencedExecutorIdentity,
      unconsumedReservations: [...claim.reservationRefs],
    };
    assert.deepEqual(
      await port.closeUnattemptedClaim({ ...body, receiptDigest: computeClaimClosureDigest(body) }),
      { closed: true, receiptId: body.receiptId },
      `${label}: the release path stays usable`,
    );
    const released = (await port.loadTask(TASK)) as TaskState;
    const held = (released.budgetLedgers ?? []).flatMap(ledger => ledger.reservations);
    assert.deepEqual(held, [], `${label}: no reservation is left held`);
    assert.equal(
      (released.budgetLedgers ?? []).reduce((sum, ledger) => sum + ledger.consumed, 0),
      0,
      `${label}: no usage is charged`,
    );
  }
});
