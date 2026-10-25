import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  type BugTask,
  type ApprovalBinding,
  type ApprovalPort,
  type TaskState,
  type RepositoryPort,
  type CheckDefinition,
  type CheckResult,
  type Baseline,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  investigateBaseline,
  prepareFixPlanAndApproval,
  computeTestProtectionDigest,
  type TrustedHostPort,
  type TrustedHostExpectedContext,
  type TrustedHostSnapshot,
  type TrustedTestFileSnapshot,
  type InvestigationConfigPort,
} from '../../../src/uc03/investigation.ts';
import {
  createFixtureBugTask,
  createFixtureCheckDefinition,
  createFixtureTaskState,
} from '../support/uc03/port-fixtures.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { MemoryStatePort, MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import {
  createTestExecutorIdentityV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestAdmissionTaskStateV02,
} from '../support/uc03/state-fixtures.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';

interface CompleteBaselineCandidate {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly acceptanceCriteria: readonly string[];
  readonly criteriaDigest: string;
  readonly requiredChecks: readonly CheckDefinition[];
  readonly expectedPassingCheckIds: readonly string[];
  readonly reproductionCheckId: string;
  readonly expectedTestFiles: readonly string[];
  readonly repositorySnapshotDigest: string;
  readonly checkSetDigest: string;
  readonly reproductionFailureSignature: string;
  readonly checkResults: readonly CheckResult[];
  readonly testProtectionDigest: string;
}

interface BaselineEvidenceWriteRequest {
  readonly content: CompleteBaselineCandidate;
  readonly contentDigest: string;
}

interface BaselineEvidenceAcknowledgement {
  readonly evidenceId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly contentDigest: string;
  readonly repositorySnapshotDigest: string;
  readonly criteriaDigest: string;
  readonly checkSetDigest: string;
  readonly testProtectionDigest: string;
  readonly reproductionCheckId: string;
  readonly expectedPassingCheckIds: readonly string[];
  readonly expectedTestFiles: readonly string[];
  readonly requiredCheckIds: readonly string[];
}

function createBaselineCandidate(
  task: BugTask = createFixtureBugTask(),
  workspaceId = 'workspace-uc03-test'
): CompleteBaselineCandidate {
  const requiredChecks = task.requiredChecks.map((check) => ({ ...check, argv: [...check.argv] }));
  const reproductionCheck = requiredChecks.find((check) => check.purpose === 'reproduction');
  assert.ok(reproductionCheck);
  return {
    taskId: task.taskId,
    workspaceId,
    repositoryId: task.repositoryId,
    acceptanceCriteria: [...task.acceptanceCriteria],
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    requiredChecks,
    expectedPassingCheckIds: requiredChecks
      .filter((check) => check.checkId !== reproductionCheck.checkId)
      .map((check) => check.checkId),
    reproductionCheckId: reproductionCheck.checkId,
    expectedTestFiles: ['tests/test_calculator.py'],
    repositorySnapshotDigest: task.initialRevisionDigest,
    checkSetDigest: computeCheckSetDigest(requiredChecks),
    reproductionFailureSignature: 'ZeroDivisionError: division by zero',
    checkResults: requiredChecks.map((check) => ({
      checkId: check.checkId,
      outcome: check.checkId === reproductionCheck.checkId ? 'fail' : 'pass',
      ...(check.checkId === reproductionCheck.checkId
        ? { outputExcerpt: 'ZeroDivisionError: division by zero' }
        : {}),
      durationMs: 20,
    })),
    testProtectionDigest: computeTestProtectionDigest([
      { path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' },
    ]),
  };
}

function createStateForBaselineCandidate(
  task: BugTask,
  candidate: CompleteBaselineCandidate
): TaskState {
  return createFixtureTaskState({
    taskId: candidate.taskId,
    workspaceId: candidate.workspaceId,
    repositoryId: candidate.repositoryId,
    repositoryRevisionDigest: candidate.repositorySnapshotDigest,
    acceptanceCriteria: candidate.acceptanceCriteria,
    requiredCheckIds: candidate.requiredChecks.map((check) => check.checkId),
    taskContext: task,
    node: 'Investigate',
    evidenceRefs: [],
  });
}

function createBaselineEvidenceWriter(options?: {
  readonly events?: string[] | undefined;
  readonly evidenceId?: string | undefined;
  readonly acknowledgement?: Partial<BaselineEvidenceAcknowledgement> | undefined;
  readonly throwError?: boolean | undefined;
}): {
  readonly writer: {
    persistBaselineEvidence(
      request: BaselineEvidenceWriteRequest
    ): Promise<BaselineEvidenceAcknowledgement>;
  };
  readonly requests: BaselineEvidenceWriteRequest[];
} {
  const requests: BaselineEvidenceWriteRequest[] = [];
  return {
    requests,
    writer: {
      async persistBaselineEvidence(request) {
        requests.push(structuredClone(request));
        options?.events?.push('evidence');
        if (options?.throwError) throw new Error('durable evidence consumer unavailable');
        const { content } = request;
        return {
          evidenceId: options?.evidenceId ?? 'uc04://baseline/task-calc-001/1',
          taskId: content.taskId,
          workspaceId: content.workspaceId,
          repositoryId: content.repositoryId,
          contentDigest: request.contentDigest,
          repositorySnapshotDigest: content.repositorySnapshotDigest,
          criteriaDigest: content.criteriaDigest,
          checkSetDigest: content.checkSetDigest,
          testProtectionDigest: content.testProtectionDigest,
          reproductionCheckId: content.reproductionCheckId,
          expectedPassingCheckIds: content.expectedPassingCheckIds,
          expectedTestFiles: content.expectedTestFiles,
          requiredCheckIds: content.requiredChecks.map((check) => check.checkId),
          ...options?.acknowledgement,
        };
      },
    },
  };
}

function observeStatePort(port: MemoryStatePort, events: string[]): MemoryStatePort {
  return new Proxy(port, {
    get(target, property, receiver) {
      if (property === 'transition') {
        return async (state: TaskState, expectedVersion: number) => {
          events.push('state-transition');
          if (state.node === 'Patch') {
            const tc = (target as unknown as { transitionContexts: Record<number, unknown> }).transitionContexts;
            if (tc && !tc[state.stateVersion] && state.plan) {
              const evidenceRefs = state.plan.evidenceRefs ?? (state.plan.baselineRef ? [state.plan.baselineRef] : []);
              const action = {
                actionId: state.activeDecisionId ?? '',
                kind: 'approve_fix_plan' as const,
                planVersion: state.plan.planVersion,
                strategyDigest: state.plan.strategyDigest,
                diagnosisEvidenceRefs: evidenceRefs,
                checkSetDigest: state.plan.checkSetDigest,
              };
              const actionDigest = computeCanonicalSha256(action);
              const binding = {
                decisionId: state.activeDecisionId ?? '',
                actionKind: 'fix_plan' as const,
                normalizedActionDigest: actionDigest,
                taskId: state.taskId,
                workspaceId: state.workspaceId,
                repositoryRevisionDigest: state.repositoryRevisionDigest,
                policyId: state.taskContext?.configId ?? '',
                policyVersion: state.taskContext?.configVersion ?? '',
                planVersion: state.plan.planVersion,
                strategyDigest: state.plan.strategyDigest,
                baselineRef: state.plan.baselineRef ?? '',
                evidenceRefs: evidenceRefs,
                criteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
                checkSetDigest: state.plan.checkSetDigest,
                status: 'approved' as const,
              };
              const freshness = {
                currentTaskId: state.taskId,
                currentWorkspaceId: state.workspaceId,
                currentRepositoryRevisionDigest: state.repositoryRevisionDigest,
                currentPolicyId: state.taskContext?.configId ?? '',
                currentPolicyVersion: state.taskContext?.configVersion ?? '',
                currentNormalizedActionDigest: actionDigest,
                currentPlanVersion: state.plan.planVersion,
                currentStrategyDigest: state.plan.strategyDigest,
                currentBaselineRef: state.plan.baselineRef ?? '',
                currentEvidenceRefs: evidenceRefs,
                currentCriteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
                currentCheckSetDigest: state.plan.checkSetDigest,
              };
              tc[state.stateVersion] = { approval: { binding, freshness } };
            }
          }
          return target.transition(state, expectedVersion);
        };
      }
      if (property === 'checkpoint') {
        return async (state: TaskState) => {
          events.push('checkpoint');
          return target.checkpoint(state);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) as unknown : value;
    },
  });
}

function createPendingApprovalPort(events: string[]): {
  readonly port: ApprovalPort;
  readonly requests: ApprovalBinding[];
} {
  const requests: ApprovalBinding[] = [];
  return {
    requests,
    port: {
      provenance: 'mock',
      async classify() {
        return 'APPROVAL_REQUIRED';
      },
      async requestDecision(binding) {
        events.push('approval');
        requests.push(structuredClone(binding));
        return { ...binding, status: 'pending', reason: 'awaiting explicit human decision' };
      },
      async validateBinding() {
        return false;
      },
      async resolve() {
        throw new Error('No decision is scripted');
      },
    },
  };
}

class FakeTrustedHostPort implements TrustedHostPort {
  readonly snapshotClaims: TrustedHostExpectedContext;
  currentRevision: string;
  testFiles: TrustedTestFileSnapshot[];
  readonly options?: {
    readonly checkSetDigest?: string | undefined;
    readonly expectedTestFiles?: readonly string[] | undefined;
    readonly onSnapshot?: (() => void) | undefined;
  } | undefined;

  constructor(
    task: BugTask,
    currentRevision: string,
    testFiles: TrustedTestFileSnapshot[],
    options?: {
      readonly checkSetDigest?: string | undefined;
      readonly expectedTestFiles?: readonly string[] | undefined;
      readonly onSnapshot?: (() => void) | undefined;
    } | undefined
  ) {
    const checkSetDigest =
      options?.checkSetDigest ??
      computeCheckSetDigest(task.requiredChecks);
    this.currentRevision = currentRevision;
    this.testFiles = testFiles;
    this.options = options;
    this.snapshotClaims = {
      taskId: task.taskId,
      workspaceId: 'workspace-uc03-test',
      repositoryId: task.repositoryId,
      revisionDigest: task.initialRevisionDigest,
      criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
      checkSetDigest,
      expectedTestFiles: options?.expectedTestFiles ?? testFiles.map((file) => file.path),
    };
  }

  async loadSnapshot(): Promise<TrustedHostSnapshot> {
    if (this.options?.onSnapshot) {
      this.options.onSnapshot();
    }
    const expectedTestFiles =
      this.options?.expectedTestFiles ?? this.snapshotClaims.expectedTestFiles;

    return {
      taskId: this.snapshotClaims.taskId,
      workspaceId: this.snapshotClaims.workspaceId,
      repositoryId: this.snapshotClaims.repositoryId,
      currentRevision: this.currentRevision,
      checkSetDigest: this.snapshotClaims.checkSetDigest,
      testFiles: this.testFiles,
      expectedTestFiles,
    };
  }
}

function createValidHostPort(
  task: BugTask,
  testFiles?: TrustedTestFileSnapshot[] | undefined,
  options?: {
    readonly checkSetDigest?: string | undefined;
    readonly expectedTestFiles?: readonly string[] | undefined;
    readonly onSnapshot?: (() => void) | undefined;
  } | undefined
): FakeTrustedHostPort {
  const files = testFiles ?? [
    {
      path: 'tests/test_calculator.py',
      content:
        'import pytest\nfrom src.calculator import Calculator\n\ndef test_divide_zero():\n    calc = Calculator()\n    calc.divide(10, 0)\n',
    },
  ];
  return new FakeTrustedHostPort(
    task,
    task.initialRevisionDigest,
    files,
    {
      checkSetDigest:
        options?.checkSetDigest ??
        computeCheckSetDigest(task.requiredChecks),
      expectedTestFiles:
        options?.expectedTestFiles ?? files.map((f) => f.path),
      onSnapshot: options?.onSnapshot,
    }
  );
}

function createBoundHostPort(
  task: BugTask,
  options?: {
    readonly producerClaims?: Partial<TrustedHostExpectedContext> | undefined;
    readonly snapshot?: Partial<TrustedHostSnapshot> | undefined;
    readonly testFiles?: readonly TrustedTestFileSnapshot[] | undefined;
  } | undefined
): TrustedHostPort {
  const testFiles = options?.testFiles ?? [
    { path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' },
  ];
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  const expectedTestFiles = testFiles.map((file) => file.path);
  const producerClaims: TrustedHostExpectedContext = {
    taskId: task.taskId,
    workspaceId: 'workspace-uc03-test',
    repositoryId: task.repositoryId,
    revisionDigest: task.initialRevisionDigest,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest,
    expectedTestFiles,
    ...options?.producerClaims,
  };
  const snapshot: TrustedHostSnapshot = {
    taskId: producerClaims.taskId,
    workspaceId: producerClaims.workspaceId,
    repositoryId: producerClaims.repositoryId,
    currentRevision: producerClaims.revisionDigest,
    checkSetDigest: producerClaims.checkSetDigest,
    expectedTestFiles: producerClaims.expectedTestFiles,
    testFiles,
    ...options?.snapshot,
  };

  return {
    loadSnapshot: async () => snapshot,
  };
}

function createTrustedAdmissionContext(
  task: BugTask,
  expectedTestFiles: readonly string[] = ['tests/test_calculator.py'],
  overrides?: Partial<TrustedHostExpectedContext>
): TrustedHostExpectedContext {
  return {
    taskId: task.taskId,
    workspaceId: 'workspace-uc03-test',
    repositoryId: task.repositoryId,
    revisionDigest: task.initialRevisionDigest,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    expectedTestFiles: [...expectedTestFiles],
    ...overrides,
  };
}

function investigateWithTestContext(
  task: BugTask,
  repository: RepositoryPort,
  hostAuthority: TrustedHostPort,
  expectedTestFiles?: readonly string[]
) {
  return investigateBaseline(
    task,
    repository,
    hostAuthority,
    createTrustedAdmissionContext(task, expectedTestFiles)
  );
}

function createCanonicalRepositoryStub(options?: {
  readonly onRunTests?: ((check: CheckDefinition) => CheckResult) | undefined;
} | undefined): { repository: RepositoryPort; getRunTestsCalls: () => number } {
  let runTestsCalls = 0;
  const repository: RepositoryPort = {
    provenance: 'mock',
    async listDir() {
      return [];
    },
    async readFile() {
      throw new Error('Not implemented in canonical stub');
    },
    async searchCode() {
      return [];
    },
    async applyPatch() {
      return { applied: false, newRevisionDigest: '' };
    },
    async runCommand() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async runTests(check: CheckDefinition): Promise<CheckResult> {
      runTestsCalls++;
      if (options?.onRunTests) {
        return options.onRunTests(check);
      }
      return {
        checkId: check.checkId,
        outcome: 'fail',
        outputExcerpt: 'ZeroDivisionError: division by zero',
        durationMs: 40,
      };
    },
    async inspectDiff() {
      return { diff: '', diffDigest: '', changedFiles: [] };
    },
  };
  return { repository, getRunTestsCalls: () => runTestsCalls };
}

test('investigation authority: producer-controlled context cannot replace independently supplied host facts', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();
  const producerExpectedContext: TrustedHostExpectedContext = {
    taskId: task.taskId,
    workspaceId: 'workspace-uc03-test',
    repositoryId: task.repositoryId,
    revisionDigest: task.initialRevisionDigest,
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    expectedTestFiles: ['tests/test_calculator.py'],
  };
  const forgedSnapshot: TrustedHostSnapshot = {
    taskId: producerExpectedContext.taskId,
    workspaceId: producerExpectedContext.workspaceId,
    repositoryId: producerExpectedContext.repositoryId,
    currentRevision: producerExpectedContext.revisionDigest,
    checkSetDigest: producerExpectedContext.checkSetDigest,
    expectedTestFiles: [...producerExpectedContext.expectedTestFiles],
    testFiles: [{ path: 'tests/test_calculator.py', content: 'def test_calc(): pass\\n' }],
  };
  const producer = {
    expectedContext: producerExpectedContext,
    loadSnapshot: async () => forgedSnapshot,
  };
  const independentlyMeasuredContext: TrustedHostExpectedContext = {
    taskId: task.taskId,
    workspaceId: 'workspace-uc03-test',
    repositoryId: task.repositoryId,
    revisionDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    criteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    expectedTestFiles: ['tests/test_calculator.py', 'tests/test_other.py'],
  };

  const result = await investigateBaseline(
    task,
    repoStub.repository,
    producer,
    independentlyMeasuredContext
  );

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.equal(
    repoStub.getRunTestsCalls(),
    0,
    'producer-authored revision, check-set, and incomplete inventory claims must not admit tests'
  );
});

test('test protection authority: different test bytes with same path yield different digests', () => {
  const fileA: TrustedTestFileSnapshot = {
    path: 'tests/test_calculator.py',
    content: 'def test_divide(): pass\n',
  };
  const fileB: TrustedTestFileSnapshot = {
    path: 'tests/test_calculator.py',
    content: 'def test_divide(): assert 1 == 1\n',
  };

  const digestA = computeTestProtectionDigest([fileA]);
  const digestB = computeTestProtectionDigest([fileB]);

  assert.match(digestA, /^sha256:[a-f0-9]{64}$/);
  assert.match(digestB, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(
    digestA,
    digestB,
    'different file content must yield distinct protection digests'
  );
});

test('test protection authority: distinct invalid UTF-8 byte sequences with same path yield different digests', () => {
  // Test raw byte preservation without lossy utf8 string conversion
  const invalidUtf8FF = new Uint8Array([0xff, 0xfe, 0xfd]);
  const invalidUtf8FE = new Uint8Array([0xfe, 0xfd, 0xfc]);

  const fileFF: TrustedTestFileSnapshot = {
    path: 'tests/test_binary.py',
    content: invalidUtf8FF,
  };
  const fileFE: TrustedTestFileSnapshot = {
    path: 'tests/test_binary.py',
    content: invalidUtf8FE,
  };

  const digestFF = computeTestProtectionDigest([fileFF]);
  const digestFE = computeTestProtectionDigest([fileFE]);

  assert.notEqual(
    digestFF,
    digestFE,
    'distinct byte sequences 0xff and 0xfe must not collide to the same digest'
  );
});

test('investigation authority: canonical RepositoryPort stub (no extras) with forged caller facts denies without running tests or requesting approval', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();

  // Untrusted caller passes forged facts (plain object with plausible digest and testFiles, lacking loadSnapshot)
  const forgedCallerFacts = {
    repositorySnapshotDigest: task.initialRevisionDigest,
    testFiles: [
      {
        path: 'tests/test_calculator.py',
        content: 'def test_divide_zero(): pass\n',
      },
    ],
  } as unknown as TrustedHostPort;

  const result = await investigateWithTestContext(task, repoStub.repository, forgedCallerFacts);

  assert.equal(result.status, 'error');
  assert.match(
    result.reason ?? '',
    /missing trusted host authority|explicit TrustedHostPort/i
  );
  assert.equal(result.baseline, undefined);
  assert.equal(
    repoStub.getRunTestsCalls(),
    0,
    'zero runTests executions permitted when trusted host port is missing'
  );

  // Attempting plan preparation without a valid baseline must produce zero approval requests
  const state: TaskState = createFixtureTaskState({
    node: 'Investigate',
    taskContext: task,
  });
  const ports = {
    repository: repoStub.repository,
    state: new MemoryStatePort({ initialTaskState: state }),
    approval: new ScriptedApprovalPort(),
  };

  const dummyBaseline = createBaselineCandidate(task);

  const planResult = await prepareFixPlanAndApproval(state, dummyBaseline, ports, {
    diagnosis: 'Zero division bug',
    strategy: 'Add guard check',
    // Missing suspectedCauseLocations and scopedChanges
  });

  assert.equal(planResult.outcome, 'rejected');
  assert.equal(
    ports.approval.getRecordedBindings().length,
    0,
    'zero approval requests recorded when authority facts or plan scope are rejected'
  );
});

test('investigation authority: valid separately supplied admission context admits a snapshot producer', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();
  const hostPort = createValidHostPort(task);
  const trustedContext = createTrustedAdmissionContext(task);

  const result = await investigateBaseline(task, repoStub.repository, hostPort, trustedContext);

  assert.equal(result.status, 'reproduced');
  assert.ok(result.baseline !== undefined, 'baseline must be recorded');
  assert.equal(
    result.baseline?.repositorySnapshotDigest,
    task.initialRevisionDigest,
    'snapshot digest must match host authority'
  );
  assert.equal(
    result.baseline?.testProtectionDigest,
    computeTestProtectionDigest(hostPort.testFiles),
    'test protection digest must match host test byte digest'
  );
  assert.equal(result.baseline?.checkResults[0]?.outcome, 'fail');
  assert.ok(
    repoStub.getRunTestsCalls() >= 1,
    'runTests must be executed under valid explicit host port authority'
  );
});

test('investigation authority: missing trusted host authority fails closed with 0 runTests', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();

  // Call investigateBaseline without authority
  const result = await investigateBaseline(task, repoStub.repository);

  assert.equal(result.status, 'error');
  assert.match(
    result.reason ?? '',
    /missing trusted host authority|explicit TrustedHostPort/i
  );
  assert.equal(result.baseline, undefined);
  assert.equal(
    repoStub.getRunTestsCalls(),
    0,
    'zero runTests executions when authority is omitted'
  );
});

test('investigation authority: stale host snapshot revision mismatch fails closed with 0 runTests', async () => {
  const task = createFixtureBugTask({
    initialRevisionDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  });
  const repoStub = createCanonicalRepositoryStub();

  // Host authority returns a different/stale revision than expected task revision
  const staleHostPort = new FakeTrustedHostPort(
    task,
    'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    [
      {
        path: 'tests/test_calculator.py',
        content: 'def test_divide(): pass\n',
      },
    ],
    {
      checkSetDigest: computeCheckSetDigest(task.requiredChecks),
      expectedTestFiles: ['tests/test_calculator.py'],
    }
  );

  const result = await investigateWithTestContext(task, repoStub.repository, staleHostPort);

  assert.equal(result.status, 'error');
  assert.match(result.reason ?? '', /snapshot revision binding mismatch/i);
  assert.equal(result.baseline, undefined);
  assert.equal(
    repoStub.getRunTestsCalls(),
    0,
    'zero runTests executions when host snapshot revision mismatches'
  );
});

test('investigation authority: incomplete test inventory in required checks argv fails closed with 0 runTests', async () => {
  const task = createFixtureBugTask({
    requiredChecks: [
      createFixtureCheckDefinition({
        checkId: 'check-pytest-reproduction',
        purpose: 'reproduction',
        argv: ['-q', 'tests/test_calculator.py'],
      }),
      createFixtureCheckDefinition({
        checkId: 'check-pytest-regression',
        purpose: 'regression',
        argv: ['-q', 'tests/test_extra.py'],
      }),
    ],
  });
  const repoStub = createCanonicalRepositoryStub();

  // Host authority only provides test_calculator.py, omitting test_extra.py
  const incompleteHostPort = new FakeTrustedHostPort(
    task,
    task.initialRevisionDigest,
    [
      {
        path: 'tests/test_calculator.py',
        content: 'def test_calc(): pass\n',
      },
    ],
    {
      checkSetDigest: computeCheckSetDigest(task.requiredChecks),
      expectedTestFiles: ['tests/test_calculator.py'],
    }
  );

  const result = await investigateWithTestContext(task, repoStub.repository, incompleteHostPort);

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.match(result.reason ?? '', /inventory/i);
  assert.equal(
    repoStub.getRunTestsCalls(),
    0,
    'zero runTests executions on incomplete inventory'
  );
});

test('investigation authority: host expected test files list mismatch fails closed with 0 runTests', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();

  // Host snapshot expectedTestFiles includes an unprovided test file
  const mismatchedHostPort = new FakeTrustedHostPort(
    task,
    task.initialRevisionDigest,
    [
      {
        path: 'tests/test_calculator.py',
        content: 'def test_calc(): pass\n',
      },
    ],
    {
      checkSetDigest: computeCheckSetDigest(task.requiredChecks),
      expectedTestFiles: ['tests/test_calculator.py', 'tests/test_unprovided.py'],
    }
  );

  const result = await investigateWithTestContext(
    task,
    repoStub.repository,
    mismatchedHostPort,
    ['tests/test_calculator.py', 'tests/test_unprovided.py']
  );

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.match(result.reason ?? '', /inventory.*(incomplete|mismatch)|count mismatch/i);
  assert.equal(
    repoStub.getRunTestsCalls(),
    0,
    'zero runTests executions on expectedTestFiles mismatch'
  );
});

test('investigation authority: detached immutable copy resists in-flight mutation during await (TOCTOU)', async () => {
  const task = createFixtureBugTask();
  const testContentOriginal = 'def test_alpha():\n    assert 1 == 1\n';
  const initialFiles: TrustedTestFileSnapshot[] = [
    {
      path: 'tests/test_calculator.py',
      content: new Uint8Array(Buffer.from(testContentOriginal, 'utf8')),
    },
  ];

  const expectedInitialProtectionDigest = computeTestProtectionDigest(initialFiles);
  const hostPort = createValidHostPort(task, initialFiles);

  // Canonical repository stub simulates async in-flight mutation during await
  const repoStub = createCanonicalRepositoryStub({
    onRunTests: () => {
      // In-flight mutation of host producer state while runTests is awaited
      const mutableContent = hostPort.testFiles[0]?.content;
      if (mutableContent instanceof Uint8Array) {
        mutableContent[0] = 0x99;
      }
      hostPort.currentRevision =
        'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
      return {
        checkId: 'check-pytest-reproduction',
        outcome: 'fail',
        outputExcerpt: 'ZeroDivisionError: division by zero',
        durationMs: 25,
      };
    },
  });

  const result = await investigateWithTestContext(task, repoStub.repository, hostPort);

  assert.equal(result.status, 'reproduced');
  assert.ok(result.baseline !== undefined, 'baseline must be recorded');
  // Baseline must retain the detached pre-await digest, NOT the mutated content
  assert.equal(
    result.baseline?.testProtectionDigest,
    expectedInitialProtectionDigest,
    'test protection digest must match pre-await detached facts'
  );
  assert.equal(
    result.baseline?.repositorySnapshotDigest,
    task.initialRevisionDigest,
    'snapshot digest must match pre-await detached facts'
  );
});

test('investigation authority: caller mutation during snapshot await cannot widen detached admission facts', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();
  const trustedContext = createTrustedAdmissionContext(task);
  const mutableContext = trustedContext as unknown as {
    revisionDigest: string;
    checkSetDigest: string;
    expectedTestFiles: string[];
  };
  const forgedRevision = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const forgedCheckSet = 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const forgedSnapshot: TrustedHostSnapshot = {
    taskId: task.taskId,
    workspaceId: 'workspace-uc03-test',
    repositoryId: task.repositoryId,
    currentRevision: forgedRevision,
    checkSetDigest: forgedCheckSet,
    expectedTestFiles: ['tests/test_calculator.py', 'tests/test_extra.py'],
    testFiles: [
      { path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' },
      { path: 'tests/test_extra.py', content: 'def test_extra(): pass\n' },
    ],
  };
  let markSnapshotRequested!: () => void;
  let resolveSnapshot!: (snapshot: TrustedHostSnapshot) => void;
  const snapshotRequested = new Promise<void>((resolve) => {
    markSnapshotRequested = resolve;
  });
  const snapshotGate = new Promise<TrustedHostSnapshot>((resolve) => {
    resolveSnapshot = resolve;
  });
  const producer: TrustedHostPort = {
    loadSnapshot: () => {
      markSnapshotRequested();
      return snapshotGate;
    },
  };

  const pendingResult = investigateBaseline(
    task,
    repoStub.repository,
    producer,
    trustedContext
  );
  await snapshotRequested;
  mutableContext.revisionDigest = forgedRevision;
  mutableContext.checkSetDigest = forgedCheckSet;
  mutableContext.expectedTestFiles.push('tests/test_extra.py');
  resolveSnapshot(forgedSnapshot);

  const result = await pendingResult;

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.equal(
    repoStub.getRunTestsCalls(),
    0,
    'mutating the caller-owned context while loading a snapshot must not widen admission'
  );
});

test('investigation authority: producer mutates retained snapshot object revision during runTests await; baseline retains original validated revision', async () => {
  const task = createFixtureBugTask();
  const mutableSnapshot = {
    taskId: task.taskId,
    workspaceId: 'workspace-uc03-test',
    repositoryId: task.repositoryId,
    currentRevision: task.initialRevisionDigest,
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    testFiles: [
      {
        path: 'tests/test_calculator.py',
        content: 'def test_divide(): pass\n',
      },
    ],
    expectedTestFiles: ['tests/test_calculator.py'],
  };

  const hostAuthority: TrustedHostPort = {
    loadSnapshot: async () => mutableSnapshot as unknown as TrustedHostSnapshot,
  };

  const repoStub = createCanonicalRepositoryStub({
    onRunTests: () => {
      // Producer mutates the exact object returned by loadSnapshot during test await
      mutableSnapshot.currentRevision =
        'sha256:8888888888888888888888888888888888888888888888888888888888888888';
      return {
        checkId: 'check-pytest-reproduction',
        outcome: 'fail',
        outputExcerpt: 'ZeroDivisionError',
        durationMs: 15,
      };
    },
  });

  const result = await investigateWithTestContext(task, repoStub.repository, hostAuthority);

  assert.equal(result.status, 'reproduced');
  assert.ok(result.baseline !== undefined);
  assert.equal(
    result.baseline?.repositorySnapshotDigest,
    task.initialRevisionDigest,
    'baseline must retain original detached revision and ignore in-flight mutation of producer snapshot object'
  );
});

test('investigation authority: host snapshot omitting checkSetDigest denies before tests with 0 runTests', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();

  const incompleteHost: TrustedHostPort = {
    loadSnapshot: async () =>
      ({
        taskId: task.taskId,
        workspaceId: 'workspace-uc03-test',
        repositoryId: task.repositoryId,
        currentRevision: task.initialRevisionDigest,
        testFiles: [
          {
            path: 'tests/test_calculator.py',
            content: 'def test_calc(): pass\n',
          },
        ],
        expectedTestFiles: ['tests/test_calculator.py'],
      }) as unknown as TrustedHostSnapshot,
  };

  const result = await investigateWithTestContext(task, repoStub.repository, incompleteHost);

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.match(result.reason ?? '', /check-set binding is required/i);
  assert.equal(repoStub.getRunTestsCalls(), 0, 'zero runTests executions on missing check-set binding');
});

test('investigation authority: host snapshot omitting expectedTestFiles denies before tests with 0 runTests', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();

  const incompleteHost: TrustedHostPort = {
    loadSnapshot: async () =>
      ({
        taskId: task.taskId,
        workspaceId: 'workspace-uc03-test',
        repositoryId: task.repositoryId,
        currentRevision: task.initialRevisionDigest,
        testFiles: [
          {
            path: 'tests/test_calculator.py',
            content: 'def test_calc(): pass\n',
          },
        ],
        checkSetDigest: computeCheckSetDigest(task.requiredChecks),
      }) as unknown as TrustedHostSnapshot,
  };

  const result = await investigateWithTestContext(task, repoStub.repository, incompleteHost);

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.match(result.reason ?? '', /complete inventory binding is required/i);
  assert.equal(repoStub.getRunTestsCalls(), 0, 'zero runTests executions on missing expectedTestFiles');
});

test('investigation authority: snapshot with argv-only subset that omits another expected protected test denies before tests', async () => {
  const task = createFixtureBugTask({
    requiredChecks: [
      createFixtureCheckDefinition({
        checkId: 'check-pytest-reproduction',
        purpose: 'reproduction',
        argv: ['-q', 'tests/test_calculator.py'],
      }),
    ],
  });
  const repoStub = createCanonicalRepositoryStub();

  const argvOnlyHost: TrustedHostPort = {
    loadSnapshot: async () => ({
      taskId: task.taskId,
      workspaceId: 'workspace-uc03-test',
      repositoryId: task.repositoryId,
      currentRevision: task.initialRevisionDigest,
      checkSetDigest: computeCheckSetDigest(task.requiredChecks),
      testFiles: [
        {
          path: 'tests/test_calculator.py',
          content: 'def test_calc(): pass\n',
        },
      ],
      expectedTestFiles: ['tests/test_calculator.py', 'tests/test_extra_protected.py'],
    }),
  };

  const result = await investigateWithTestContext(
    task,
    repoStub.repository,
    argvOnlyHost,
    ['tests/test_calculator.py', 'tests/test_extra_protected.py']
  );

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.match(result.reason ?? '', /inventory/i);
  assert.equal(
    repoStub.getRunTestsCalls(),
    0,
    'zero runTests executions when snapshot is only an argv subset missing other expected protected tests'
  );
});

test('investigation authority: duplicate path in expectedTestFiles denies before tests with 0 runTests', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();

  const duplicateHost: TrustedHostPort = {
    loadSnapshot: async () => ({
      taskId: task.taskId,
      workspaceId: 'workspace-uc03-test',
      repositoryId: task.repositoryId,
      currentRevision: task.initialRevisionDigest,
      checkSetDigest: computeCheckSetDigest(task.requiredChecks),
      testFiles: [
        {
          path: 'tests/test_calculator.py',
          content: 'def test_calc(): pass\n',
        },
      ],
      expectedTestFiles: ['tests/test_calculator.py', 'tests/test_calculator.py'],
    }),
  };

  const result = await investigateWithTestContext(task, repoStub.repository, duplicateHost);

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.match(result.reason ?? '', /duplicate path/i);
  assert.equal(repoStub.getRunTestsCalls(), 0, 'zero runTests executions on duplicate expected test files');
});

test('investigation authority: host snapshot requires an independent trusted expected context', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();
  const hostAuthority = {
    loadSnapshot: async () => ({
      currentRevision: task.initialRevisionDigest,
      testFiles: [{ path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' }],
      expectedTestFiles: ['tests/test_calculator.py'],
    }),
  } as unknown as TrustedHostPort;

  const result = await Reflect.apply(investigateBaseline, undefined, [task, repoStub.repository, hostAuthority]);

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.match(result.reason ?? '', /separate trusted admission context/i);
  assert.equal(repoStub.getRunTestsCalls(), 0, 'zero runTests executions without trusted expected context');
});

test('investigation authority: trusted expected context binds current task, repository, revision, and check set', async () => {
  const task = createFixtureBugTask();
  const mismatches: {
    readonly name: string;
    readonly context: Partial<TrustedHostExpectedContext>;
  }[] = [
    { name: 'task', context: { taskId: 'other-task' } },
    { name: 'repository', context: { repositoryId: 'other-repository' } },
    {
      name: 'revision',
      context: { revisionDigest: 'sha256:9999999999999999999999999999999999999999999999999999999999999999' },
    },
    {
      name: 'check set',
      context: { checkSetDigest: 'sha256:9999999999999999999999999999999999999999999999999999999999999999' },
    },
  ];

  for (const mismatch of mismatches) {
    const repoStub = createCanonicalRepositoryStub();
    const result = await investigateBaseline(
      task,
      repoStub.repository,
      createBoundHostPort(task, { producerClaims: mismatch.context }),
      createTrustedAdmissionContext(task)
    );

    assert.equal(result.status, 'error', `${mismatch.name} mismatch must fail closed`);
    assert.equal(result.baseline, undefined, `${mismatch.name} mismatch must not produce a baseline`);
    assert.equal(repoStub.getRunTestsCalls(), 0, `${mismatch.name} mismatch must deny tests`);
  }
});

test('investigation authority: trusted expected criteria digest binds the accepted criteria', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();
  const hostPort = createValidHostPort(task);
  const trustedContext = createTrustedAdmissionContext(task, ['tests/test_calculator.py'], {
    criteriaDigest: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
  });

  const result = await investigateBaseline(task, repoStub.repository, hostPort, trustedContext);

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.equal(repoStub.getRunTestsCalls(), 0);
});

test('investigation authority: snapshot binds workspace and producer facts to the independent expected context', async () => {
  const task = createFixtureBugTask();
  const mismatches: {
    readonly name: string;
    readonly snapshot: Partial<TrustedHostSnapshot>;
  }[] = [
    { name: 'task', snapshot: { taskId: 'other-task' } },
    { name: 'workspace', snapshot: { workspaceId: 'other-workspace' } },
    { name: 'repository', snapshot: { repositoryId: 'other-repository' } },
    {
      name: 'check set',
      snapshot: { checkSetDigest: 'sha256:9999999999999999999999999999999999999999999999999999999999999999' },
    },
  ];

  for (const mismatch of mismatches) {
    const repoStub = createCanonicalRepositoryStub();
    const result = await investigateBaseline(
      task,
      repoStub.repository,
      createBoundHostPort(task, { snapshot: mismatch.snapshot }),
      createTrustedAdmissionContext(task)
    );

    assert.equal(result.status, 'error', `${mismatch.name} snapshot binding must fail closed`);
    assert.equal(result.baseline, undefined, `${mismatch.name} mismatch must not produce a baseline`);
    assert.equal(repoStub.getRunTestsCalls(), 0, `${mismatch.name} mismatch must deny tests`);
  }
});

test('investigation authority: producer cannot replace the independently expected complete test inventory with an argv subset', async () => {
  const task = createFixtureBugTask({
    requiredChecks: [
      createFixtureCheckDefinition({
        checkId: 'check-pytest-reproduction',
        purpose: 'reproduction',
        argv: ['-q', 'tests/test_calculator.py'],
      }),
    ],
  });
  const repoStub = createCanonicalRepositoryStub();
  const result = await investigateBaseline(
    task,
    repoStub.repository,
    createBoundHostPort(task, { snapshot: { expectedTestFiles: ['tests/test_calculator.py'] } }),
    createTrustedAdmissionContext(task, ['tests/test_calculator.py', 'tests/test_extra.py'])
  );

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.match(result.reason ?? '', /inventory|expected context/i);
  assert.equal(repoStub.getRunTestsCalls(), 0, 'zero runTests executions for a producer-reported argv subset');
});

test('investigation authority: hostile snapshot ownKeys trap fails closed without leaking its error', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();
  const hostileSnapshot = new Proxy(
    {
      taskId: task.taskId,
      workspaceId: 'workspace-uc03-test',
      repositoryId: task.repositoryId,
      currentRevision: task.initialRevisionDigest,
      checkSetDigest: computeCheckSetDigest(task.requiredChecks),
      expectedTestFiles: ['tests/test_calculator.py'],
      testFiles: [{ path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' }],
    },
    {
      ownKeys() {
        throw new Error('HOSTILE_OWN_KEYS_SECRET_PAYLOAD');
      },
    }
  );
  const hostileHost = {
    loadSnapshot: async () => hostileSnapshot,
  } as unknown as TrustedHostPort;

  const result = await investigateWithTestContext(task, repoStub.repository, hostileHost);

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.ok(!result.reason?.includes('HOSTILE_OWN_KEYS_SECRET_PAYLOAD'));
  assert.equal(repoStub.getRunTestsCalls(), 0, 'zero runTests executions after hostile ownKeys trap');
});

test('investigation authority: hostile snapshot inventory proxy fails closed without leaking its error', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();
  const hostileInventory = new Proxy(['tests/test_calculator.py'], {
    get(target, property, receiver) {
      if (property === 'length') throw new Error('HOSTILE_INVENTORY_SECRET_PAYLOAD');
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const hostileHost = {
    loadSnapshot: async () => ({
      taskId: task.taskId,
      workspaceId: 'workspace-uc03-test',
      repositoryId: task.repositoryId,
      currentRevision: task.initialRevisionDigest,
      checkSetDigest: computeCheckSetDigest(task.requiredChecks),
      expectedTestFiles: hostileInventory,
      testFiles: [{ path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' }],
    }),
  } as unknown as TrustedHostPort;

  const result = await investigateWithTestContext(task, repoStub.repository, hostileHost);

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.ok(!result.reason?.includes('HOSTILE_INVENTORY_SECRET_PAYLOAD'));
  assert.equal(repoStub.getRunTestsCalls(), 0, 'zero runTests executions after hostile inventory proxy');
});

test('investigation authority: hostile throwing getter on hostAuthority.loadSnapshot fails closed without escaping raw text and 0 runTests', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();

  const hostileAuthority = {
    get loadSnapshot() {
      throw new Error('HOSTILE_LOAD_SNAPSHOT_GETTER_EXPLOIT_PAYLOAD');
    },
  } as unknown as TrustedHostPort;

  const result = await investigateWithTestContext(task, repoStub.repository, hostileAuthority);

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.ok(!result.reason?.includes('HOSTILE_LOAD_SNAPSHOT_GETTER_EXPLOIT_PAYLOAD'), 'no hostile raw text escaped');
  assert.equal(repoStub.getRunTestsCalls(), 0, 'zero runTests executions on throwing loadSnapshot getter');
});

test('investigation authority: hostile throwing nested getter on snapshot properties fails closed with 0 runTests', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();

  const hostileHost: TrustedHostPort = {
    loadSnapshot: async () => {
      const obj = {
        taskId: task.taskId,
        workspaceId: 'workspace-uc03-test',
        repositoryId: task.repositoryId,
        checkSetDigest: computeCheckSetDigest(task.requiredChecks),
        testFiles: [
          {
            path: 'tests/test_calculator.py',
            content: 'def test_calc(): pass\n',
          },
        ],
        expectedTestFiles: ['tests/test_calculator.py'],
      };
      Object.defineProperty(obj, 'currentRevision', {
        get() {
          throw new Error('HOSTILE_REVISION_GETTER_EXPLOIT_PAYLOAD');
        },
      });
      return obj as unknown as TrustedHostSnapshot;
    },
  };

  const result = await investigateWithTestContext(task, repoStub.repository, hostileHost);

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.ok(!result.reason?.includes('HOSTILE_REVISION_GETTER_EXPLOIT_PAYLOAD'), 'no hostile raw text escaped');
  assert.equal(repoStub.getRunTestsCalls(), 0, 'zero runTests executions on throwing nested getter');
});

test('investigation authority: hostile Proxy on testFiles entry fails closed with 0 runTests', async () => {
  const task = createFixtureBugTask();
  const repoStub = createCanonicalRepositoryStub();

  const hostileFile = new Proxy(
    { path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' },
    {
      get(target, prop) {
        if (prop === 'path') {
          throw new Error('HOSTILE_PROXY_PATH_GETTER');
        }
        return Reflect.get(target, prop);
      },
    }
  );

  const hostileHost: TrustedHostPort = {
    loadSnapshot: async () => ({
      taskId: task.taskId,
      workspaceId: 'workspace-uc03-test',
      repositoryId: task.repositoryId,
      currentRevision: task.initialRevisionDigest,
      checkSetDigest: computeCheckSetDigest(task.requiredChecks),
      testFiles: [hostileFile],
      expectedTestFiles: ['tests/test_calculator.py'],
    }),
  };

  const result = await investigateWithTestContext(task, repoStub.repository, hostileHost);

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.ok(!result.reason?.includes('HOSTILE_PROXY_PATH_GETTER'), 'no hostile raw text escaped');
  assert.equal(repoStub.getRunTestsCalls(), 0, 'zero runTests executions on hostile proxy');
});

test('investigation authority: deep raw byte copy preserves test bytes against producer buffer mutation after loadSnapshot', async () => {
  const task = createFixtureBugTask();
  const originalBytes = new Uint8Array([0x64, 0x65, 0x66, 0x20, 0x74, 0x65, 0x73, 0x74]); // "def test"
  const expectedProtectionDigest = computeTestProtectionDigest([
    {
      path: 'tests/test_calculator.py',
      content: originalBytes,
    },
  ]);

  const producerBytes = new Uint8Array(originalBytes);
  const hostPort: TrustedHostPort = {
    loadSnapshot: async () => ({
      taskId: task.taskId,
      workspaceId: 'workspace-uc03-test',
      repositoryId: task.repositoryId,
      currentRevision: task.initialRevisionDigest,
      checkSetDigest: computeCheckSetDigest(task.requiredChecks),
      testFiles: [
        {
          path: 'tests/test_calculator.py',
          content: producerBytes,
        },
      ],
      expectedTestFiles: ['tests/test_calculator.py'],
    }),
  };

  const repoStub = createCanonicalRepositoryStub({
    onRunTests: () => {
      // Producer mutates its buffer while tests are running
      producerBytes[0] = 0x00;
      return {
        checkId: 'check-pytest-reproduction',
        outcome: 'fail',
        outputExcerpt: 'ZeroDivisionError',
        durationMs: 20,
      };
    },
  });

  const result = await investigateWithTestContext(task, repoStub.repository, hostPort);

  assert.equal(result.status, 'reproduced');
  assert.ok(result.baseline !== undefined);
  assert.equal(
    result.baseline?.testProtectionDigest,
    expectedProtectionDigest,
    'test protection digest must match initial detached bytes, completely unaffected by in-place mutation of producer buffer'
  );
});

test('investigation: requires explicit reproduction purpose and refuses substring/first inference', async () => {
  const task = createFixtureBugTask({
    requiredChecks: [
      createFixtureCheckDefinition({
        checkId: 'check-reproduction-sub',
        purpose: 'regression', // checkId has reproduction but purpose is regression!
      }),
    ],
  });
  const hostPort = createValidHostPort(task);
  const repoStub = createCanonicalRepositoryStub();

  const result = await investigateWithTestContext(task, repoStub.repository, hostPort);

  assert.equal(result.status, 'error');
  assert.match(result.reason ?? '', /explicit purpose reproduction/i);
  assert.equal(result.baseline, undefined);
  assert.equal(repoStub.getRunTestsCalls(), 0);
});

test('investigation: works with FakeRepositoryPort when explicit TrustedHostPort is injected', async () => {
  const task = createFixtureBugTask();
  const hostPort = createValidHostPort(task);
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });
  repo.setTestResult('check-pytest-reproduction', {
    checkId: 'check-pytest-reproduction',
    outcome: 'fail',
    outputExcerpt: 'ZeroDivisionError: division by zero',
    durationMs: 35,
  });

  const result = await investigateWithTestContext(task, repo, hostPort);

  assert.equal(result.status, 'reproduced');
  assert.ok(result.baseline !== undefined, 'baseline must be recorded');
  assert.equal(result.baseline?.repositorySnapshotDigest, task.initialRevisionDigest);
  assert.equal(
    result.baseline?.testProtectionDigest,
    computeTestProtectionDigest(hostPort.testFiles)
  );
  assert.equal(result.baseline?.checkResults[0]?.outcome, 'fail');
});

test('investigation: admits only the complete explicit required check set', async () => {
  const task = createFixtureBugTask({
    requiredChecks: [
      createFixtureCheckDefinition(),
      createFixtureCheckDefinition({
        checkId: 'check-existing-regression',
        purpose: 'regression',
      }),
    ],
  });
  const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
  const hostPort = createValidHostPort(task, undefined, { checkSetDigest });
  const observedCheckIds: string[] = [];
  const repoStub = createCanonicalRepositoryStub({
    onRunTests(check) {
      observedCheckIds.push(check.checkId);
      return check.purpose === 'reproduction'
        ? { checkId: check.checkId, outcome: 'fail', outputExcerpt: 'ZeroDivisionError' }
        : { checkId: check.checkId, outcome: 'pass' };
    },
  });

  const result = await investigateWithTestContext(task, repoStub.repository, hostPort);

  assert.deepEqual(observedCheckIds, task.requiredChecks.map((check) => check.checkId));
  assert.equal(result.status, 'reproduced');
  assert.equal(result.baseline?.checkSetDigest, checkSetDigest);
  assert.equal(
    result.baseline && 'criteriaDigest' in result.baseline
      ? result.baseline.criteriaDigest
      : undefined,
    computeCanonicalSha256(task.acceptanceCriteria),
    'the candidate must bind the exact accepted criteria'
  );
  assert.equal(
    result.baseline && 'evidenceId' in result.baseline,
    false,
    'investigation candidates must not claim a durable reference before the evidence writer acknowledges it'
  );
});

test('investigation: previously passing required checks must pass for a baseline candidate', async () => {
  for (const outcome of ['fail', 'error', 'timeout', 'not-run'] as const) {
    const task = createFixtureBugTask({
      requiredChecks: [
        createFixtureCheckDefinition(),
        createFixtureCheckDefinition({
          checkId: 'check-existing-regression',
          purpose: 'regression',
        }),
      ],
    });
    const hostPort = createValidHostPort(task);
    const repoStub = createCanonicalRepositoryStub({
      onRunTests(check) {
        return check.purpose === 'reproduction'
          ? { checkId: check.checkId, outcome: 'fail', outputExcerpt: 'ZeroDivisionError' }
          : { checkId: check.checkId, outcome };
      },
    });

    const result = await investigateWithTestContext(task, repoStub.repository, hostPort);

    assert.notEqual(result.status, 'reproduced', `${outcome} regression result must not admit a baseline`);
    assert.equal(result.baseline, undefined, `${outcome} regression result must not produce a baseline candidate`);
    assert.equal(repoStub.getRunTestsCalls(), task.requiredChecks.length);
  }
});

test('investigation: runs the complete check set before returning non-reproducing', async () => {
  const task = createFixtureBugTask({
    requiredChecks: [
      createFixtureCheckDefinition(),
      createFixtureCheckDefinition({
        checkId: 'check-existing-regression',
        purpose: 'regression',
      }),
    ],
  });
  const hostPort = createValidHostPort(task);
  const observedCheckIds: string[] = [];
  const repoStub = createCanonicalRepositoryStub({
    onRunTests(check) {
      observedCheckIds.push(check.checkId);
      return { checkId: check.checkId, outcome: 'pass' };
    },
  });

  const result = await investigateWithTestContext(task, repoStub.repository, hostPort);

  assert.equal(result.status, 'non-reproducing');
  assert.equal(result.baseline, undefined);
  assert.deepEqual(observedCheckIds, task.requiredChecks.map((check) => check.checkId));
});

test('investigation: non-reproducing requires every previously passing check to pass', async () => {
  const task = createFixtureBugTask({
    requiredChecks: [
      createFixtureCheckDefinition({ checkId: 'check-repro', purpose: 'reproduction' }),
      createFixtureCheckDefinition({ checkId: 'check-existing-regression', purpose: 'regression' }),
    ],
  });
  const cases: readonly {
    readonly name: string;
    readonly outcome: CheckResult['outcome'];
    readonly expectedStatus: 'error' | 'non-reproducing';
  }[] = [
    { name: 'pass', outcome: 'pass', expectedStatus: 'non-reproducing' },
    { name: 'fail', outcome: 'fail', expectedStatus: 'error' },
    { name: 'timeout', outcome: 'timeout', expectedStatus: 'error' },
    { name: 'error', outcome: 'error', expectedStatus: 'error' },
    { name: 'not-run', outcome: 'not-run', expectedStatus: 'error' },
    { name: 'unknown', outcome: 'skipped' as CheckResult['outcome'], expectedStatus: 'error' },
  ];

  for (const testCase of cases) {
    const hostPort = createValidHostPort(task);
    const observedCheckIds: string[] = [];
    const repoStub = createCanonicalRepositoryStub({
      onRunTests(check) {
        observedCheckIds.push(check.checkId);
        return check.purpose === 'reproduction'
          ? { checkId: check.checkId, outcome: 'pass' }
          : { checkId: check.checkId, outcome: testCase.outcome };
      },
    });

    const result = await investigateWithTestContext(task, repoStub.repository, hostPort);

    assert.equal(result.status, testCase.expectedStatus, `${testCase.name} required check status`);
    assert.equal(result.baseline, undefined, `${testCase.name} required check cannot create a baseline`);
    assert.deepEqual(observedCheckIds, task.requiredChecks.map((check) => check.checkId));
  }
});

test('investigation: a thrown required check is recorded and does not omit later checks', async () => {
  const task = createFixtureBugTask({
    requiredChecks: [
      createFixtureCheckDefinition(),
      createFixtureCheckDefinition({ checkId: 'check-throws', purpose: 'regression' }),
      createFixtureCheckDefinition({ checkId: 'check-after-throw', purpose: 'compatibility' }),
    ],
  });
  const hostPort = createValidHostPort(task);
  const observedCheckIds: string[] = [];
  const repoStub = createCanonicalRepositoryStub({
    onRunTests(check) {
      observedCheckIds.push(check.checkId);
      if (check.checkId === 'check-throws') throw new Error('regression runner unavailable');
      return check.purpose === 'reproduction'
        ? { checkId: check.checkId, outcome: 'fail', outputExcerpt: 'ZeroDivisionError' }
        : { checkId: check.checkId, outcome: 'pass' };
    },
  });

  const result = await investigateWithTestContext(task, repoStub.repository, hostPort);

  assert.equal(result.status, 'error');
  assert.equal(result.baseline, undefined);
  assert.deepEqual(observedCheckIds, task.requiredChecks.map((check) => check.checkId));
});

test('plan preparation: persisted Baseline cannot substitute for a complete evidence candidate', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const baseline: Baseline = {
    evidenceId: 'persisted-baseline',
    repositorySnapshotDigest: candidate.repositorySnapshotDigest,
    checkSetDigest: candidate.checkSetDigest,
    reproductionFailureSignature: candidate.reproductionFailureSignature,
    checkResults: candidate.checkResults,
    testProtectionDigest: candidate.testProtectionDigest,
  };
  const ports = {
    repository: new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }),
    state: new MemoryStatePort({ initialTaskState: state }),
    approval: new ScriptedApprovalPort(),
  };

  // @ts-expect-error Persisted Baseline lacks the required candidate binding facts.
  const result = await prepareFixPlanAndApproval(state, baseline, ports);

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /candidate fields/i);
  assert.equal(ports.approval.getRecordedBindings().length, 0);
  assert.equal((await ports.state.loadTask(state.taskId))?.node, 'Investigate');
});

test('plan preparation: missing diagnosis fails closed without fabricated default', async () => {
  const task = createFixtureBugTask();
  const baseline = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, baseline);

  const ports = {
    repository: new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }),
    state: new MemoryStatePort({ initialTaskState: state }),
    approval: new ScriptedApprovalPort(),
  };

  // planDetails missing diagnosis entirely
  const result = await prepareFixPlanAndApproval(state, baseline, ports, {
    strategy: 'Add guard check in divide method',
  });

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /diagnosis/i);
});

test('plan preparation: missing strategy fails closed without fabricated default', async () => {
  const task = createFixtureBugTask();
  const baseline = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, baseline);

  const ports = {
    repository: new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }),
    state: new MemoryStatePort({ initialTaskState: state }),
    approval: new ScriptedApprovalPort(),
  };

  // planDetails missing strategy entirely
  const result = await prepareFixPlanAndApproval(state, baseline, ports, {
    diagnosis: 'Zero division bug',
  });

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /missing.*strategy/i);
});

test('plan preparation: missing policy/config fails closed without fabricated default', async () => {
  const task = createFixtureBugTask({
    configId: undefined as unknown as string,
    configVersion: undefined as unknown as string,
  });
  const baseline = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, baseline);

  const ports = {
    repository: new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }),
    state: new MemoryStatePort(),
    approval: new ScriptedApprovalPort(),
  };

  const result = await prepareFixPlanAndApproval(state, baseline, ports, {
    diagnosis: 'Zero division bug',
    strategy: 'Add guard check',
  });

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /config/i);
});

test('plan preparation: missing suspected cause locations fails closed without fallback to calculator.py', async () => {
  const task = createFixtureBugTask({
    requiredChecks: [
      createFixtureCheckDefinition({
        argv: ['-q'], // no file path in argv
      }),
    ],
  });
  const baseline = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, baseline);

  const ports = {
    repository: new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }),
    state: new MemoryStatePort({ initialTaskState: state }),
    approval: new ScriptedApprovalPort(),
  };

  const result = await prepareFixPlanAndApproval(state, baseline, ports, {
    diagnosis: 'Zero division bug',
    strategy: 'Add guard check',
  });

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /suspected cause locations/i);
});

test('plan preparation: conventional test path in task context refuses to infer production source or scoped changes', async () => {
  // Check has argv pointing to tests/test_calculator.py
  const task = createFixtureBugTask({
    requiredChecks: [
      createFixtureCheckDefinition({
        argv: ['-q', 'tests/test_calculator.py'],
      }),
    ],
  });
  const baseline = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, baseline);

  const ports = {
    repository: new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }),
    state: new MemoryStatePort({ initialTaskState: state }),
    approval: new ScriptedApprovalPort(),
  };

  // Missing scopedChanges and suspectedCauseLocations (must NOT infer src/calculator.py)
  const resultMissingBoth = await prepareFixPlanAndApproval(state, baseline, ports, {
    diagnosis: 'Zero division bug',
    strategy: 'Add guard check',
  });

  assert.equal(resultMissingBoth.outcome, 'rejected');
  assert.match(resultMissingBoth.reason ?? '', /suspected cause locations|scoped changes/i);
  assert.equal(ports.approval.getRecordedBindings().length, 0, 'zero approval requests on missing cause/scope');

  // Provided suspectedCauseLocations but missing scopedChanges
  const resultMissingScope = await prepareFixPlanAndApproval(state, baseline, ports, {
    diagnosis: 'Zero division bug',
    strategy: 'Add guard check',
    suspectedCauseLocations: ['src/calculator.py'],
  });

  assert.equal(resultMissingScope.outcome, 'rejected');
  assert.match(resultMissingScope.reason ?? '', /scoped changes/i);
  assert.equal(ports.approval.getRecordedBindings().length, 0, 'zero approval requests on missing scopedChanges');
});

test('plan preparation: missing trusted evidence writer leaves state before AwaitPlan and makes zero approval requests', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const events: string[] = [];
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), events);
  const approval = createPendingApprovalPort(events);
  const result = await prepareFixPlanAndApproval(state, candidate, {
    repository: new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }),
    state: statePort,
    approval: approval.port,
  }, {
    diagnosis: 'Zero denominator reaches the division operation',
    strategy: 'Reject a zero denominator before division',
    suspectedCauseLocations: ['src/calculator.py'],
    scopedChanges: ['src/calculator.py'],
  });

  assert.equal(result.outcome, 'rejected');
  assert.equal((await statePort.loadTask(state.taskId))?.node, 'Investigate');
  assert.deepEqual(approval.requests, []);
  assert.deepEqual(events, []);
});

test('plan preparation: evidence acknowledgement precedes state CAS, checkpoint, and approval', async () => {
  const task = createFixtureBugTask({
    requiredChecks: [
      createFixtureCheckDefinition(),
      createFixtureCheckDefinition({
        checkId: 'check-existing-regression',
        purpose: 'regression',
      }),
    ],
  });
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const events: string[] = [];
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), events);
  const approval = createPendingApprovalPort(events);
  const evidence = createBaselineEvidenceWriter({
    events,
    evidenceId: 'uc04://baseline/task-calc-001/accepted-1',
  });

  const result = await prepareFixPlanAndApproval(state, candidate, {
    repository: new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }),
    state: statePort,
    approval: approval.port,
    baselineEvidenceWriter: evidence.writer,
  }, {
    diagnosis: 'Zero denominator reaches the division operation',
    strategy: 'Reject a zero denominator before division',
    suspectedCauseLocations: ['src/calculator.py'],
    scopedChanges: ['src/calculator.py'],
  });

  assert.equal(result.outcome, 'pending');
  assert.deepEqual(events, ['evidence', 'state-transition', 'checkpoint', 'approval']);
  assert.equal(result.plan?.baselineRef, 'uc04://baseline/task-calc-001/accepted-1');
  assert.equal(evidence.requests.length, 1);
  const request = evidence.requests[0];
  assert.ok(request);
  assert.equal(request.contentDigest, computeCanonicalSha256(request.content));
  assert.deepEqual(request.content.acceptanceCriteria, task.acceptanceCriteria);
  assert.deepEqual(request.content.requiredChecks, task.requiredChecks);
  assert.deepEqual(request.content.checkResults.map((check) => check.checkId),
    task.requiredChecks.map((check) => check.checkId));
  assert.equal(request.content.repositorySnapshotDigest, task.initialRevisionDigest);
  assert.equal(request.content.checkSetDigest, computeCheckSetDigest(task.requiredChecks));
  assert.equal(request.content.criteriaDigest, computeCanonicalSha256(task.acceptanceCriteria));
  assert.equal(request.content.taskId, state.taskId);
  assert.equal(request.content.workspaceId, state.workspaceId);
  assert.equal(request.content.repositoryId, state.repositoryId);
  assert.equal(request.content.testProtectionDigest, candidate.testProtectionDigest);
  assert.equal(request.content.reproductionCheckId, candidate.reproductionCheckId);
  assert.deepEqual(request.content.expectedPassingCheckIds, candidate.expectedPassingCheckIds);
  assert.deepEqual(request.content.expectedTestFiles, candidate.expectedTestFiles);
  assert.equal(approval.requests.length, 1);
});

test('plan preparation: caller evidence refs cannot omit the acknowledged baseline', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const callerEvidenceRef = 'uc04://diagnosis/task-calc-001/cause-1';
  const state = {
    ...createStateForBaselineCandidate(task, candidate),
    evidenceRefs: [callerEvidenceRef],
  };
  const events: string[] = [];
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), events);
  const approval = createPendingApprovalPort(events);
  const baselineRef = 'uc04://baseline/task-calc-001/accepted-1';
  const evidence = createBaselineEvidenceWriter({ events, evidenceId: baselineRef });

  const result = await prepareFixPlanAndApproval(state, candidate, {
    repository: new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }),
    state: statePort,
    approval: approval.port,
    baselineEvidenceWriter: evidence.writer,
  }, {
    diagnosis: 'Zero denominator reaches the division operation',
    strategy: 'Reject a zero denominator before division',
    suspectedCauseLocations: ['src/calculator.py'],
    scopedChanges: ['src/calculator.py'],
    evidenceRefs: [callerEvidenceRef],
  });

  assert.equal(result.outcome, 'pending');
  assert.equal(result.plan?.baselineRef, baselineRef);
  assert.deepEqual(result.plan?.evidenceRefs, [baselineRef, callerEvidenceRef]);
  assert.equal(approval.requests.length, 1);
  assert.equal(approval.requests[0]?.baselineRef, result.plan?.baselineRef);
  assert.deepEqual(approval.requests[0]?.evidenceRefs, [baselineRef, callerEvidenceRef]);
  assert.equal(events.join(','), 'evidence,state-transition,checkpoint,approval');
});

test('plan preparation: mismatched evidence acknowledgement fails before state or approval', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const events: string[] = [];
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), events);
  const approval = createPendingApprovalPort(events);
  const evidence = createBaselineEvidenceWriter({
    events,
    acknowledgement: {
      contentDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    },
  });

  const result = await prepareFixPlanAndApproval(state, candidate, {
    repository: new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }),
    state: statePort,
    approval: approval.port,
    baselineEvidenceWriter: evidence.writer,
  }, {
    diagnosis: 'Zero denominator reaches the division operation',
    strategy: 'Reject a zero denominator before division',
    suspectedCauseLocations: ['src/calculator.py'],
    scopedChanges: ['src/calculator.py'],
  });

  assert.equal(result.outcome, 'rejected');
  assert.equal((await statePort.loadTask(state.taskId))?.node, 'Investigate');
  assert.deepEqual(approval.requests, []);
  assert.deepEqual(events, ['evidence']);
});

test('plan preparation: evidence writer failure leaves state before AwaitPlan and makes zero approval requests', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const events: string[] = [];
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), events);
  const approval = createPendingApprovalPort(events);
  const evidence = createBaselineEvidenceWriter({ events, throwError: true });

  const result = await prepareFixPlanAndApproval(state, candidate, {
    repository: new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }),
    state: statePort,
    approval: approval.port,
    baselineEvidenceWriter: evidence.writer,
  }, {
    diagnosis: 'Zero denominator reaches the division operation',
    strategy: 'Reject a zero denominator before division',
    suspectedCauseLocations: ['src/calculator.py'],
    scopedChanges: ['src/calculator.py'],
  });

  assert.equal(result.outcome, 'rejected');
  assert.equal((await statePort.loadTask(state.taskId))?.node, 'Investigate');
  assert.deepEqual(approval.requests, []);
  assert.deepEqual(events, ['evidence']);
});

test('plan preparation: nonpassing or missing required checks cannot be persisted or reach AwaitPlan', async () => {
  const task = createFixtureBugTask({
    requiredChecks: [
      createFixtureCheckDefinition(),
      createFixtureCheckDefinition({
        checkId: 'check-existing-regression',
        purpose: 'regression',
      }),
    ],
  });
  const complete = createBaselineCandidate(task);
  const cases: readonly {
    readonly name: string;
    readonly candidate: CompleteBaselineCandidate;
  }[] = [
    ...(['fail', 'error', 'timeout', 'not-run'] as const).map((outcome) => ({
      name: outcome,
      candidate: {
        ...complete,
        checkResults: complete.checkResults.map((result) =>
          result.checkId === 'check-existing-regression' ? { ...result, outcome } : result
        ),
      },
    })),
    {
      name: 'missing',
      candidate: {
        ...complete,
        checkResults: complete.checkResults.filter(
          (result) => result.checkId !== 'check-existing-regression'
        ),
      },
    },
  ];

  for (const testCase of cases) {
    const state = createStateForBaselineCandidate(task, testCase.candidate);
    const events: string[] = [];
    const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), events);
    const approval = createPendingApprovalPort(events);
    const evidence = createBaselineEvidenceWriter({ events });
    const result = await prepareFixPlanAndApproval(state, testCase.candidate, {
      repository: new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest }),
      state: statePort,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    }, {
      diagnosis: 'Zero denominator reaches the division operation',
      strategy: 'Reject a zero denominator before division',
      suspectedCauseLocations: ['src/calculator.py'],
      scopedChanges: ['src/calculator.py'],
    });

    assert.equal(result.outcome, 'rejected', `${testCase.name} required check must reject the candidate`);
    assert.equal((await statePort.loadTask(state.taskId))?.node, 'Investigate');
    assert.equal(evidence.requests.length, 0, `${testCase.name} candidate must not be persisted`);
    assert.deepEqual(approval.requests, [], `${testCase.name} candidate must make zero approval requests`);
    assert.deepEqual(events, []);
  }
});
function createCustomApprovalPort(options?: {
  readonly events?: string[] | undefined;
  readonly handler?: (binding: ApprovalBinding) => Promise<ApprovalBinding> | ApprovalBinding;
  readonly throwError?: boolean | undefined;
  readonly defaultStatus?: 'pending' | 'approved' | 'rejected' | 'stale';
}): {
  readonly port: ApprovalPort;
  readonly requests: ApprovalBinding[];
} {
  const requests: ApprovalBinding[] = [];
  return {
    requests,
    port: {
      provenance: 'mock',
      async classify() {
        return 'APPROVAL_REQUIRED';
      },
      async requestDecision(binding: ApprovalBinding) {
        options?.events?.push('approval');
        requests.push(structuredClone(binding));
        if (options?.throwError) {
          throw new Error('Approval service unreachable');
        }
        if (options?.handler) {
          return options.handler(binding);
        }
        const status = options?.defaultStatus ?? 'pending';
        return {
          ...binding,
          status,
          ...(status === 'approved' ? {} : { reason: `explicit ${status} decision` }),
        };
      },
      async validateBinding() {
        return false;
      },
      async resolve() {
        throw new Error('No decision is scripted');
      },
    },
  };
}

const standardPlanDetails = {
  diagnosis: 'Zero denominator reaches the division operation',
  strategy: 'Reject a zero denominator before division',
  suspectedCauseLocations: ['src/calculator.py'],
  scopedChanges: ['src/calculator.py'],
};

test('plan preparation: valid approved decision transitions to Patch, checkpoints, and makes zero repo edits', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const events: string[] = [];
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), events);
  const approval = createCustomApprovalPort({
    events,
    defaultStatus: 'approved',
  });
  const evidence = createBaselineEvidenceWriter({ events });
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: statePort,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
      host: createBoundHostPort(task),
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'approved');
  assert.equal(result.state?.node, 'Patch');
  assert.equal(result.state?.stateVersion, state.stateVersion + 2);
  assert.equal(result.state?.nextAction, 'apply-patch');
  assert.equal(repo.patches.length, 0, 'zero production repo edits on approved plan preparation');
  const persisted = await statePort.loadTask(state.taskId);
  assert.equal(persisted?.node, 'Patch');
  assert.equal(persisted?.stateVersion, state.stateVersion + 2);
  assert.equal(events.join(','), 'evidence,state-transition,checkpoint,approval,state-transition,checkpoint');
});

test('plan preparation: approved decision with StatePort transition CAS throw never returns approved and makes zero repo edits', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const events: string[] = [];
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const throwingStatePort = new Proxy(memoryState, {
    get(target, prop, receiver) {
      if (prop === 'transition') {
        return async (s: TaskState, expectedVersion: number) => {
          events.push('state-transition');
          if (s.node === 'Patch') {
            throw new Error('CAS conflict: expected version mismatch on Patch transition');
          }
          return target.transition(s, expectedVersion);
        };
      }
      if (prop === 'checkpoint') {
        return async (s: TaskState) => {
          events.push('checkpoint');
          return target.checkpoint(s);
        };
      }
      const val = Reflect.get(target, prop, receiver) as unknown;
      return typeof val === 'function' ? val.bind(target) as unknown : val;
    },
  });

  const approval = createCustomApprovalPort({
    events,
    defaultStatus: 'approved',
  });
  const evidence = createBaselineEvidenceWriter({ events });
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: throwingStatePort,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
      host: createBoundHostPort(task),
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected', 'CAS failure must never report approved');
  assert.match(result.reason ?? '', /StatePort transition\/checkpoint to Patch failed/i);
  assert.equal(result.state?.node, 'AwaitPlan', 'state remains at AwaitPlan on transition failure');
  assert.equal(repo.patches.length, 0, 'zero production repo edits');
  const persisted = await memoryState.loadTask(state.taskId);
  assert.equal(persisted?.node, 'AwaitPlan');
});

test('plan preparation: approved decision with StatePort checkpoint throw never returns approved and makes zero repo edits', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const events: string[] = [];
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const throwingStatePort = new Proxy(memoryState, {
    get(target, prop, receiver) {
      if (prop === 'transition') {
        return async (s: TaskState, expectedVersion: number) => {
          events.push('state-transition');
          return target.transition(s, expectedVersion);
        };
      }
      if (prop === 'checkpoint') {
        return async (s: TaskState) => {
          events.push('checkpoint');
          if (s.node === 'Patch') {
            throw new Error('Disk full: durable checkpoint failed on Patch state');
          }
          return target.checkpoint(s);
        };
      }
      const val = Reflect.get(target, prop, receiver) as unknown;
      return typeof val === 'function' ? val.bind(target) as unknown : val;
    },
  });

  const approval = createCustomApprovalPort({
    events,
    defaultStatus: 'approved',
  });
  const evidence = createBaselineEvidenceWriter({ events });
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: throwingStatePort,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
      host: createBoundHostPort(task),
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected', 'checkpoint durability failure must never report approved');
  assert.match(result.reason ?? '', /StatePort transition\/checkpoint to Patch failed/i);
  assert.equal(result.state?.node, 'AwaitPlan', 'state remains at AwaitPlan on checkpoint failure');
  assert.equal(repo.patches.length, 0, 'zero production repo edits');
});

test('plan preparation: approved decision with forged planVersion fails admission and makes zero repo edits', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const events: string[] = [];
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), events);
  const approval = createCustomApprovalPort({
    events,
    handler(binding) {
      return {
        ...binding,
        status: 'approved',
        planVersion: binding.planVersion ? binding.planVersion + 10 : 99,
      };
    },
  });
  const evidence = createBaselineEvidenceWriter({ events });
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: statePort,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Approval binding validation failed/i);
  assert.equal(result.state?.node, 'AwaitPlan');
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: approved decision with forged strategyDigest fails admission and makes zero repo edits', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const events: string[] = [];
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), events);
  const approval = createCustomApprovalPort({
    events,
    handler(binding) {
      return {
        ...binding,
        status: 'approved',
        strategyDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      };
    },
  });
  const evidence = createBaselineEvidenceWriter({ events });
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: statePort,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Approval binding validation failed/i);
  assert.equal(result.state?.node, 'AwaitPlan');
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: approved decision with forged baselineRef fails admission and makes zero repo edits', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const events: string[] = [];
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), events);
  const approval = createCustomApprovalPort({
    events,
    handler(binding) {
      return {
        ...binding,
        status: 'approved',
        baselineRef: 'uc04://baseline/forged-ref',
      };
    },
  });
  const evidence = createBaselineEvidenceWriter({ events });
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: statePort,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Approval binding validation failed/i);
  assert.equal(result.state?.node, 'AwaitPlan');
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: approved decision with mismatched decisionId fails and makes zero repo edits', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const events: string[] = [];
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), events);
  const approval = createCustomApprovalPort({
    events,
    handler(binding) {
      return {
        ...binding,
        decisionId: 'dec-forged-999',
        status: 'approved',
      };
    },
  });
  const evidence = createBaselineEvidenceWriter({ events });
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: statePort,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Approval decisionId mismatch/i);
  assert.equal(result.state?.node, 'AwaitPlan');
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: state CAS version drift while approval await rejects decision and stays at AwaitPlan', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  let drifted = false;

  const stateProxy = new Proxy(memoryState, {
    get(target, prop, receiver) {
      if (prop === 'loadTask' && drifted) {
        return async (id: string) => {
          const loaded = await target.loadTask(id);
          return loaded ? { ...loaded, stateVersion: loaded.stateVersion + 1 } : null;
        };
      }
      const val = Reflect.get(target, prop, receiver) as unknown;
      return typeof val === 'function' ? val.bind(target) as unknown : val;
    },
  });

  const approval = createCustomApprovalPort({
    handler(binding) {
      drifted = true;
      return { ...binding, status: 'approved' };
    },
  });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: stateProxy,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /State CAS version drift detected/i);
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: state node drift while approval await rejects decision and stays at AwaitPlan', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  let drifted = false;

  const stateProxy = new Proxy(memoryState, {
    get(target, prop, receiver) {
      if (prop === 'loadTask' && drifted) {
        return async (id: string) => {
          const loaded = await target.loadTask(id);
          return loaded ? { ...loaded, node: 'Validate' } : null;
        };
      }
      const val = Reflect.get(target, prop, receiver) as unknown;
      return typeof val === 'function' ? val.bind(target) as unknown : val;
    },
  });

  const approval = createCustomApprovalPort({
    handler(binding) {
      drifted = true;
      return { ...binding, status: 'approved' };
    },
  });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: stateProxy,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /State node drift detected/i);
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: StatePort loadTask returning null after approval await fails closed', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  let hasTransitionedToAwaitPlan = false;

  const stateProxy = new Proxy(memoryState, {
    get(target, prop, receiver) {
      if (prop === 'loadTask' && hasTransitionedToAwaitPlan) {
        return async () => null;
      }
      if (prop === 'transition') {
        return async (s: TaskState, exp: number) => {
          if (s.node === 'AwaitPlan') hasTransitionedToAwaitPlan = true;
          return target.transition(s, exp);
        };
      }
      const val = Reflect.get(target, prop, receiver) as unknown;
      return typeof val === 'function' ? val.bind(target) as unknown : val;
    },
  });

  const approval = createCustomApprovalPort({ defaultStatus: 'approved' });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: stateProxy,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Authoritative state missing from StatePort/i);
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: StatePort loadTask throwing after approval await fails closed', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  let hasTransitionedToAwaitPlan = false;

  const stateProxy = new Proxy(memoryState, {
    get(target, prop, receiver) {
      if (prop === 'loadTask' && hasTransitionedToAwaitPlan) {
        return async () => {
          throw new Error('Database connection lost during state reload');
        };
      }
      if (prop === 'transition') {
        return async (s: TaskState, exp: number) => {
          if (s.node === 'AwaitPlan') hasTransitionedToAwaitPlan = true;
          return target.transition(s, exp);
        };
      }
      const val = Reflect.get(target, prop, receiver) as unknown;
      return typeof val === 'function' ? val.bind(target) as unknown : val;
    },
  });

  const approval = createCustomApprovalPort({ defaultStatus: 'approved' });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: stateProxy,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Authoritative StatePort reload failed/i);
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: repository revision drift via host snapshot reload while approval await rejects decision', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const approval = createCustomApprovalPort({ defaultStatus: 'approved' });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const host: TrustedHostPort = {
    loadSnapshot(req) {
      return {
        taskId: req.taskId,
        workspaceId: req.workspaceId,
        repositoryId: req.repositoryId,
        currentRevision: 'sha256:drifted_revision_999999999999999999999999999999999999999999',
        checkSetDigest: req.expectedCheckSetDigest,
        testFiles: [{ path: 'tests/test_calculator.py', content: 'test content' }],
        expectedTestFiles: req.expectedTestFiles,
      };
    },
  };

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: memoryState,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
      host,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Host repository revision drift detected/i);
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: config version drift via config port reload while approval await rejects decision', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const approval = createCustomApprovalPort({ defaultStatus: 'approved' });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const configPort: InvestigationConfigPort = {
    loadConfig() {
      return {
        configId: task.configId,
        configVersion: 'v2.0-drifted',
      };
    },
  };

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: memoryState,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
      config: configPort,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Config drift detected while awaiting approval/i);
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: config port loadConfig returning incomplete config fails closed', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const approval = createCustomApprovalPort({ defaultStatus: 'approved' });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const configPort: InvestigationConfigPort = {
    loadConfig() {
      return {
        configId: task.configId,
        configVersion: '',
      };
    },
  };

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: memoryState,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
      config: configPort,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Config port returned missing or incomplete config/i);
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: config port loadConfig throwing after approval await fails closed', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const approval = createCustomApprovalPort({ defaultStatus: 'approved' });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const configPort: InvestigationConfigPort = {
    loadConfig() {
      throw new Error('Config service connection failure');
    },
  };

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: memoryState,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
      config: configPort,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Config port reload failed/i);
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: forged pending decision with mismatched strategyDigest fails binding validation', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const approval = createCustomApprovalPort({
    handler(binding) {
      return {
        ...binding,
        status: 'pending',
        strategyDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      };
    },
  });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: memoryState,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Approval binding validation failed/i);
  assert.equal(repo.patches.length, 0);
  assert.equal((await memoryState.loadTask(state.taskId))?.node, 'AwaitPlan');
});

test('plan preparation: forged pending decision with unknown keys fails binding validation', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const approval = createCustomApprovalPort({
    handler(binding) {
      return {
        ...binding,
        status: 'pending',
        forgedExtraKey: 'unauthorized_injection',
      } as ApprovalBinding;
    },
  });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: memoryState,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Approval binding validation failed/i);
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: valid rejected decision transitions to AwaitFeedback with bumped stateVersion and zero repo edits', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const events: string[] = [];
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), events);
  const approval = createCustomApprovalPort({
    events,
    defaultStatus: 'rejected',
  });
  const evidence = createBaselineEvidenceWriter({ events });
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: statePort,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.equal(result.state?.node, 'AwaitFeedback');
  assert.equal(result.state?.nextAction, 'await-feedback');
  assert.equal(result.state?.stateVersion, state.stateVersion + 2);
  assert.equal(repo.patches.length, 0, 'zero production repo edits on rejected plan');
  const persisted = await statePort.loadTask(state.taskId);
  assert.equal(persisted?.node, 'AwaitFeedback');
  assert.equal(persisted?.stateVersion, state.stateVersion + 2);
  assert.equal(events.join(','), 'evidence,state-transition,checkpoint,approval,state-transition,checkpoint');
});

test('plan preparation: forged rejected decision with mismatched baselineRef fails binding validation and stays at AwaitPlan', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const approval = createCustomApprovalPort({
    handler(binding) {
      return {
        ...binding,
        status: 'rejected',
        baselineRef: 'uc04://baseline/forged-reject-ref',
      };
    },
  });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: memoryState,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Approval binding validation failed/i);
  assert.equal(repo.patches.length, 0);
  const persisted = await memoryState.loadTask(state.taskId);
  assert.equal(persisted?.node, 'AwaitPlan', 'forged rejection must not transition to AwaitFeedback');
});

test('plan preparation: rejected decision with StatePort transition throw returns rejected and stays at AwaitPlan', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const throwingStatePort = new Proxy(memoryState, {
    get(target, prop, receiver) {
      if (prop === 'transition') {
        return async (s: TaskState, exp: number) => {
          if (s.node === 'AwaitFeedback') {
            throw new Error('CAS conflict on AwaitFeedback transition');
          }
          return target.transition(s, exp);
        };
      }
      const val = Reflect.get(target, prop, receiver) as unknown;
      return typeof val === 'function' ? val.bind(target) as unknown : val;
    },
  });

  const approval = createCustomApprovalPort({ defaultStatus: 'rejected' });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: throwingStatePort,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Failed transitioning to AwaitFeedback/i);
  assert.equal(result.state?.node, 'AwaitPlan');
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: stale decision status returns rejected and stays at AwaitPlan', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const approval = createCustomApprovalPort({
    defaultStatus: 'stale',
  });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: memoryState,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /stale/i);
  assert.equal(result.state?.node, 'AwaitPlan');
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: approval request throw returns rejected and stays at AwaitPlan', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const approval = createCustomApprovalPort({ throwError: true });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: memoryState,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Approval request failed/i);
  assert.equal(result.state?.node, 'AwaitPlan');
  assert.equal(repo.patches.length, 0);
});

/* ==================================================================
 * Section 9: Post-Approval Host Snapshot Revalidation & Evidence Provenance
 * ================================================================== */

test('plan preparation: approved decision with missing host port fails closed before Patch transition', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const approval = createCustomApprovalPort({ defaultStatus: 'approved' });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: memoryState,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
      // Omit host port intentionally!
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Missing HostPort loadSnapshot capability/i);
  assert.equal(result.state?.node, 'AwaitPlan');
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: approved decision with drifted host snapshot testProtectionDigest fails closed before Patch transition', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const memoryState = new MemoryStatePort({ initialTaskState: state });
  const approval = createCustomApprovalPort({ defaultStatus: 'approved' });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  // Host returns drifted test file content!
  const host: TrustedHostPort = {
    async loadSnapshot(req) {
      return {
        taskId: req.taskId,
        workspaceId: req.workspaceId,
        repositoryId: req.repositoryId,
        currentRevision: req.expectedRevisionDigest,
        checkSetDigest: req.expectedCheckSetDigest,
        expectedTestFiles: req.expectedTestFiles,
        testFiles: req.expectedTestFiles.map((p) => ({
          path: p,
          content: 'tampered test content while awaiting approval',
        })),
      };
    },
  };

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: memoryState,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
      host,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'rejected');
  assert.match(result.reason ?? '', /Host protected test files drift detected/i);
  assert.equal(result.state?.node, 'AwaitPlan');
  assert.equal(repo.patches.length, 0);
});

test('plan preparation: approved decision with valid host port transitions to Patch', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state = createStateForBaselineCandidate(task, candidate);
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), []);
  const approval = createCustomApprovalPort({ defaultStatus: 'approved' });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const host: TrustedHostPort = {
    async loadSnapshot(req) {
      return {
        taskId: req.taskId,
        workspaceId: req.workspaceId,
        repositoryId: req.repositoryId,
        currentRevision: req.expectedRevisionDigest,
        checkSetDigest: req.expectedCheckSetDigest,
        expectedTestFiles: req.expectedTestFiles,
        testFiles: [
          { path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' },
        ],
      };
    },
  };

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: statePort,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
      host,
    },
    standardPlanDetails
  );

  assert.equal(result.outcome, 'approved', result.reason);
  assert.equal(result.state?.node, 'Patch');
  assert.equal(result.state?.nextAction, 'apply-patch');
});

test('plan preparation: evidenceRefs with untrusted reference fails provenance check', async t => {
  for (const ref of ['untrusted-evidence-ref-without-provenance', 'uc04://diagnosis/task-calc-001/forged']) {
    await t.test(ref, async () => {
      const task = createFixtureBugTask();
      const candidate = createBaselineCandidate(task);
      const state = createStateForBaselineCandidate(task, candidate);
      const memoryState = new MemoryStatePort({ initialTaskState: state });
      const approval = createCustomApprovalPort({ defaultStatus: 'approved' });
      const evidence = createBaselineEvidenceWriter();
      const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

      const result = await prepareFixPlanAndApproval(
        state,
        candidate,
        {
          repository: repo,
          state: memoryState,
          approval: approval.port,
          baselineEvidenceWriter: evidence.writer,
        },
        {
          ...standardPlanDetails,
          evidenceRefs: [ref],
        }
      );

      assert.equal(result.outcome, 'rejected');
      assert.match(result.reason ?? '', /Untrusted or missing evidence reference/i);
      assert.equal(result.state?.node, 'Investigate');
      assert.equal(approval.requests.length, 0);
    });
  }
});

test('plan preparation: evidenceRefs with valid state provenance are deterministically ordered in plan, action, and binding', async () => {
  const task = createFixtureBugTask();
  const candidate = createBaselineCandidate(task);
  const state: TaskState = {
    ...createStateForBaselineCandidate(task, candidate),
    evidenceRefs: ['evidence-prior-z', 'evidence-prior-a'],
  };
  const statePort = observeStatePort(new MemoryStatePort({ initialTaskState: state }), []);
  const approval = createCustomApprovalPort({ defaultStatus: 'approved' });
  const evidence = createBaselineEvidenceWriter();
  const repo = new FakeRepositoryPort({ initialRevision: task.initialRevisionDigest });

  const host: TrustedHostPort = {
    async loadSnapshot(req) {
      return {
        taskId: req.taskId,
        workspaceId: req.workspaceId,
        repositoryId: req.repositoryId,
        currentRevision: req.expectedRevisionDigest,
        checkSetDigest: req.expectedCheckSetDigest,
        expectedTestFiles: req.expectedTestFiles,
        testFiles: [
          { path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' },
        ],
      };
    },
  };

  const result = await prepareFixPlanAndApproval(
    state,
    candidate,
    {
      repository: repo,
      state: statePort,
      approval: approval.port,
      baselineEvidenceWriter: evidence.writer,
      host,
    },
    {
      ...standardPlanDetails,
      // Provide extra refs in reverse alphabetical order
      evidenceRefs: ['evidence-prior-z', 'evidence-prior-a'],
    }
  );

  assert.equal(result.outcome, 'approved', result.reason);
  const acknowledgedBaselineRef = 'uc04://baseline/task-calc-001/1';
  const expectedEvidenceOrder = [acknowledgedBaselineRef, 'evidence-prior-a', 'evidence-prior-z'];
  assert.deepEqual(result.plan?.evidenceRefs, expectedEvidenceOrder);
  assert.deepEqual(result.binding?.evidenceRefs, expectedEvidenceOrder);
  assert.deepEqual(result.state?.plan?.evidenceRefs, expectedEvidenceOrder);
  assert.deepEqual(result.state?.evidenceRefs, ['evidence-prior-z', 'evidence-prior-a', acknowledgedBaselineRef]);
});

test('investigateBaseline: validates selectors only for direct and module pytest invocations', async t => {
  const invocations = [
    { executable: 'pytest', prefix: [] },
    { executable: 'py.test', prefix: [] },
    { executable: 'PYTEST.EXE', prefix: [] },
    { executable: 'C:\\venv\\Scripts\\Py.Test.exe', prefix: [] },
    { executable: '/venv/bin/pytest', prefix: [] },
    { executable: 'C:\\venv\\Scripts\\pytest', prefix: [] },
    { executable: 'python', prefix: ['-m', 'pytest'] },
    { executable: 'PYTHON.EXE', prefix: ['-m', 'pytest'] },
    { executable: '/usr/bin/python3.12', prefix: ['-m', 'pytest'] },
    { executable: 'C:\\Python\\Python3.13.exe', prefix: ['-m', 'pytest'] },
    { executable: '/usr/bin/python3', prefix: ['-m', 'pytest'] },
    { executable: 'C:\\Python\\python3', prefix: ['-m', 'pytest'] },
  ];
  for (const invocation of invocations) {
    for (const selector of ['tests/test_calculator.py::test_calc', '../secrets.py', 'tests/missing.py']) {
      await t.test(`${invocation.executable} ${selector}`, async () => {
        const reproduction = createFixtureCheckDefinition({
          executable: invocation.executable,
          argv: [...invocation.prefix, '-k', 'test_calc or test_other', selector],
        });
        const otherChecks = [
          { executable: 'git', argv: ['diff', '--check'], purpose: 'diff' as const },
          { executable: 'python3', argv: ['tools/compatibility.py'], purpose: 'compatibility' as const },
          { executable: 'ruff', argv: ['check', '.'], purpose: 'regression' as const },
        ].map((check, index) => createFixtureCheckDefinition({ ...check, checkId: `other-${index}` }));
        const task = createFixtureBugTask({ requiredChecks: [reproduction, ...otherChecks] });
        const repo = createCanonicalRepositoryStub({
          onRunTests: check => ({
            checkId: check.checkId,
            outcome: check.purpose === 'reproduction' ? 'fail' : 'pass',
            outputExcerpt: 'ZeroDivisionError: division by zero',
          }),
        });
        const result = await investigateWithTestContext(task, repo.repository, createBoundHostPort(task));
        if (selector === 'tests/test_calculator.py::test_calc') {
          assert.equal(result.status, 'reproduced', result.reason);
        } else {
          assert.equal(result.status, 'error');
          assert.match(result.reason ?? '', /Invalid or untrusted test selector|omits a test referenced/i);
          assert.equal(repo.getRunTestsCalls(), 0);
        }
      });
    }
  }
});

test('investigateBaseline: skips pytest option values while validating deselected selectors', async t => {
  const options = [
    '-p', 'no:cacheprovider', '-r', 'a', '--durations', '10', '--durations-min', '0.5',
    '--basetemp', '/tmp/pytest', '--confcutdir', '.', '--timeout', '10',
    '--cov-report', 'term-missing',
  ];
  for (const prefix of [[], ['-m', 'pytest']]) {
    for (const deselect of [
      [], ['--deselect', 'tests/test_calculator.py::test_other'],
      ['--deselect=tests/test_calculator.py::test_other'],
      ['--deselect', '../secrets.py'], ['--deselect=../secrets.py'],
      ['--deselect', '.env'], ['--deselect', '--invalid'], ['--deselect'],
    ]) {
      await t.test(`${prefix.join(' ')} ${deselect.join(' ')}`, async () => {
        const check = createFixtureCheckDefinition({
          executable: prefix.length === 0 ? 'pytest' : 'python3',
          argv: [...prefix, ...options, 'tests/test_calculator.py', ...deselect],
        });
        const task = createFixtureBugTask({ requiredChecks: [check] });
        const repo = createCanonicalRepositoryStub();
        const result = await investigateWithTestContext(task, repo.repository, createBoundHostPort(task));
        if (deselect.length === 0 || deselect.some(arg => arg.includes('tests/test_calculator.py'))) {
          assert.equal(result.status, 'reproduced', result.reason);
        } else {
          assert.equal(result.status, 'error');
          assert.match(result.reason ?? '', /Invalid or untrusted test selector/i);
          assert.equal(repo.getRunTestsCalls(), 0);
        }
      });
    }
  }
});

test('investigateBaseline: pytest node ID (tests/test_calculator.py::test_calc) is normalized and checked in inventory', async () => {
  const nodeCheck: CheckDefinition = {
    checkId: 'check-pytest-repro-node',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py::test_calc'],
    purpose: 'reproduction',
    workingDirectory: 'tests',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };
  const task = createFixtureBugTask({
    requiredChecks: [nodeCheck],
  });
  const repo = new FakeRepositoryPort({
    initialRevision: task.initialRevisionDigest,
    testResults: {
      'check-pytest-repro-node': {
        checkId: 'check-pytest-repro-node',
        outcome: 'fail',
        outputExcerpt: 'AssertionError',
      },
    },
  });
  const host = createBoundHostPort(task, {
    testFiles: [{ path: 'tests/test_calculator.py', content: 'def test_calc(): pass\n' }],
  });

  const result = await investigateWithTestContext(task, repo, host, ['tests/test_calculator.py']);
  assert.equal(result.status, 'reproduced');
  assert.ok(result.baseline);
  assert.equal(result.baseline.requiredChecks[0]?.checkId, 'check-pytest-repro-node');
});

test('investigateBaseline: path traversal in test selector strictly fails closed', async () => {
  const traversalCheck: CheckDefinition = {
    checkId: 'check-traversal',
    executable: 'pytest',
    argv: ['-q', 'tests/../secrets.py'],
    purpose: 'reproduction',
    workingDirectory: 'tests',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };
  const task = createFixtureBugTask({
    requiredChecks: [traversalCheck],
  });
  const repo = new FakeRepositoryPort({
    initialRevision: task.initialRevisionDigest,
  });
  const host = createBoundHostPort(task);

  const result = await investigateWithTestContext(task, repo, host);
  assert.equal(result.status, 'error');
});

test('testProtectionDigest: uses deterministic code-unit sort ordering covering uppercase/lowercase, punctuation, and Unicode paths', () => {
  // Test with paths covering uppercase/lowercase, punctuation, and Unicode characters
  const files: TrustedTestFileSnapshot[] = [
    { path: 'tests/_init_test.py', content: 'underscore' },
    { path: 'tests/-k_test.py', content: 'dash' },
    { path: 'tests/b/test_b.py', content: 'b' },
    { path: 'tests/Z/test_Z.py', content: 'Z' },
    { path: 'tests/a/test_a.py', content: 'a' },
    { path: 'tests/ü_test.py', content: 'unicode-umlaut' },
    { path: 'tests/日本語_test.py', content: 'unicode-cjk' },
  ];
  const digest1 = computeTestProtectionDigest(files);
  // Permuted order inputs (reverse and shuffled)
  const digest2 = computeTestProtectionDigest([...files].reverse());
  const [f0, f1, f2, f3, f4, f5, f6] = files;
  if (!f0 || !f1 || !f2 || !f3 || !f4 || !f5 || !f6) {
    throw new Error('Expected 7 files in fixture');
  }
  const digest3 = computeTestProtectionDigest([f3, f0, f6, f1, f4, f2, f5]);
  assert.equal(digest1, digest2, 'computeTestProtectionDigest must be order-invariant across reverse order');
  assert.equal(digest1, digest3, 'computeTestProtectionDigest must be order-invariant across permutations');
});

test('computeCheckSetDigest: deterministic code-unit sort ordering invariant across permutations', () => {
  const check1: CheckDefinition = {
    checkId: 'check-z-last',
    executable: 'pytest',
    argv: ['-q', 'tests/test_z.py'],
    purpose: 'regression',
    workingDirectory: 'tests',
  };
  const check2: CheckDefinition = {
    checkId: 'check-a-first',
    executable: 'pytest',
    argv: ['-q', 'tests/test_a.py'],
    purpose: 'reproduction',
    workingDirectory: 'tests',
  };
  const check3: CheckDefinition = {
    checkId: 'check-m-middle',
    executable: 'pytest',
    argv: ['-q', 'tests/test_m.py'],
    purpose: 'regression',
    workingDirectory: 'tests',
  };

  const digestForward = computeCheckSetDigest([check1, check2, check3]);
  const digestReverse = computeCheckSetDigest([check3, check2, check1]);
  const digestPermuted = computeCheckSetDigest([check2, check3, check1]);

  assert.equal(digestForward, digestReverse, 'computeCheckSetDigest must return identical hash regardless of array ordering');
  assert.equal(digestForward, digestPermuted, 'computeCheckSetDigest must be permutation invariant');
});

test('computeCheckSetDigest: changing check arguments or executable changes checkSetDigest and invalidates stale baseline', () => {
  const baseCheck: CheckDefinition = {
    checkId: 'check-test',
    executable: 'pytest',
    argv: ['-q', 'tests/test_calculator.py'],
    purpose: 'reproduction',
    workingDirectory: 'tests',
  };
  const baseDigest = computeCheckSetDigest([baseCheck]);

  const changedArgCheck: CheckDefinition = {
    ...baseCheck,
    argv: ['-q', '-v', 'tests/test_calculator.py'],
  };
  const changedArgDigest = computeCheckSetDigest([changedArgCheck]);
  assert.notEqual(baseDigest, changedArgDigest, 'Changed argv must alter checkSetDigest');

  const changedExeCheck: CheckDefinition = {
    ...baseCheck,
    executable: 'python -m pytest',
  };
  const changedExeDigest = computeCheckSetDigest([changedExeCheck]);
  assert.notEqual(baseDigest, changedExeDigest, 'Changed executable must alter checkSetDigest');

  const changedPurposeCheck: CheckDefinition = {
    ...baseCheck,
    purpose: 'regression',
  };
  const changedPurposeDigest = computeCheckSetDigest([changedPurposeCheck]);
  assert.notEqual(baseDigest, changedPurposeDigest, 'Changed purpose must alter checkSetDigest');
});

test('investigateBaseline: bare path traversal ".." in test selector strictly fails closed', async () => {
  const dotDotCheck: CheckDefinition = {
    checkId: 'check-dotdot',
    executable: 'pytest',
    argv: ['-q', '..'],
    purpose: 'reproduction',
    workingDirectory: 'tests',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };
  const task = createFixtureBugTask({
    requiredChecks: [dotDotCheck],
  });
  const repo = new FakeRepositoryPort({
    initialRevision: task.initialRevisionDigest,
  });
  const host = createBoundHostPort(task);

  const result = await investigateWithTestContext(task, repo, host);
  assert.equal(result.status, 'error');
  assert.match(result.reason ?? '', /Invalid or untrusted test selector/i);
});

test('investigateBaseline: positional argument that is not a test selector fails closed', async () => {
  const nonSelectorCheck: CheckDefinition = {
    checkId: 'check-non-selector',
    executable: 'pytest',
    argv: ['-q', 'unrecognized_token'],
    purpose: 'reproduction',
    workingDirectory: 'tests',
    timeoutMs: 30000,
    maxOutputBytes: 1048576,
  };
  const task = createFixtureBugTask({
    requiredChecks: [nonSelectorCheck],
  });
  const repo = new FakeRepositoryPort({
    initialRevision: task.initialRevisionDigest,
  });
  const host = createBoundHostPort(task);

  const result = await investigateWithTestContext(task, repo, host);
  assert.equal(result.status, 'error');
  assert.match(result.reason ?? '', /Invalid or untrusted test selector/i);
});

// =========================================================================
// SECTION: v0.2 Atomic Admission & Guarded Baseline Runs (T062 Behavioral RED)
// =========================================================================

test('v0.2 baseline admission: pre-plan diagnostic runTests admitted without plan decision (behavioral RED against pre-migration baseline caller)', async () => {
  const task = createFixtureBugTask();
  const reproCheck = task.requiredChecks.find((c) => c.purpose === 'reproduction')!;
  const action = {
    actionId: reproCheck.checkId,
    kind: 'run_command' as const,
    executable: reproCheck.executable,
    argv: [...reproCheck.argv],
    workingDirectory: reproCheck.workingDirectory ?? 'tests',
    purpose: reproCheck.purpose,
  };
  const admission = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-command-001'],
    runnableNode: 'Investigate',
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: reproCheck.purpose,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: reproCheck.checkId,
    testPath: 'tests/test_calculator.py',
    planBindingDigest: undefined,
    planDecisionRef: undefined,
  });
  const state = createTestAdmissionTaskStateV02(admission);
  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: admission.expectedControlVersion,
    initialEpoch: admission.expectedEpoch,
    initialAuthorityRef: admission.policyAuthorityRef,
  });

  const repo = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: admission.actionDigest }),
    testResults: {
      default: {
        checkId: reproCheck.checkId,
        outcome: 'fail',
        outputExcerpt: 'ZeroDivisionError: division by zero',
        durationMs: 40,
      },
    },
  });
  const hostPort = createBoundHostPort(task);
  const trustedContext = createTrustedAdmissionContext(task);

  await investigateBaseline(task, repo, hostPort, trustedContext);

  // Target v0.2 acceptance: Baseline runTests must be admitted through a StatePortV02 journal claim
  // and record an authoritative outcome receipt.
  const snapshot = journal.getJournalSnapshot();
  assert.ok(snapshot.claims.length > 0, 'Baseline runTests must be admitted through a StatePortV02 journal claim');
  assert.ok(snapshot.outcomes.length > 0, 'Authoritative outcome receipt must be recorded in StatePortV02 journal');
  assert.equal(snapshot.outcomes[0]?.outcome, 'observed', 'Outcome receipt must record observed check outcome');
  assert.ok(repo.v02Calls.length > 0, 'Receiver must record an admitted v0.2 call');
  const v02Call = repo.v02Calls[0];
  assert.equal(v02Call?.context.planApplicability, 'pre-plan-diagnostic', 'Context must carry pre-plan-diagnostic applicability');
  assert.equal(v02Call?.claim?.planApplicability, 'pre-plan-diagnostic', 'Claim must carry pre-plan-diagnostic applicability');
});

test('v0.2 baseline admission: zero repository test effects when task has open claim (behavioral RED against pre-migration baseline caller)', async () => {
  const task = createFixtureBugTask();
  const reproCheck = task.requiredChecks.find((c) => c.purpose === 'reproduction')!;
  const action = {
    actionId: reproCheck.checkId,
    kind: 'run_command' as const,
    executable: reproCheck.executable,
    argv: [...reproCheck.argv],
    workingDirectory: reproCheck.workingDirectory ?? 'tests',
    purpose: reproCheck.purpose,
  };
  const admission = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-command-001'],
    runnableNode: 'Investigate',
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: reproCheck.purpose,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: reproCheck.checkId,
    testPath: 'tests/test_calculator.py',
    planBindingDigest: undefined,
    planDecisionRef: undefined,
  });
  const initial = createTestAdmissionTaskStateV02(admission);
  const state = {
    ...initial,
    budgetLedgers: [
      ...(initial.budgetLedgers ?? []),
      {
        scope: 'task' as const,
        kind: 'timeoutMs' as const,
        limit: 60000,
        consumed: 0,
        reservations: [],
        unit: 'count' as const,
        configurationId: 'config-v1',
        version: 1,
      },
    ],
  };
  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: admission.expectedControlVersion,
    initialEpoch: admission.expectedEpoch,
    initialAuthorityRef: admission.policyAuthorityRef,
  });

  // Open an unresolved claim on the task
  const openClaim = await journal.claim(admission);
  assert.ok(openClaim.claimId, 'Open claim must have valid claimId');
  assert.equal(journal.getJournalSnapshot().activeClaimId, openClaim.claimId);

  const repo = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: admission.actionDigest }),
    testResults: {
      default: {
        checkId: reproCheck.checkId,
        outcome: 'fail',
        outputExcerpt: 'ZeroDivisionError: division by zero',
        durationMs: 40,
      },
    },
  });
  const hostPort = createBoundHostPort(task);
  const trustedContext = createTrustedAdmissionContext(task);

  await investigateBaseline(task, repo, hostPort, trustedContext);

  // Target v0.2 acceptance: An open claim blocks any new runTests effect and yields zero repository test effects.
  assert.equal(
    repo.tests.length,
    0,
    'Open claim must block baseline runTests and yield zero repository test effects'
  );
});

test('v0.2 baseline admission: zero repository test effects when task is paused (behavioral RED against pre-migration baseline caller)', async () => {
  const task = createFixtureBugTask();
  const reproCheck = task.requiredChecks.find((c) => c.purpose === 'reproduction')!;
  const action = {
    actionId: reproCheck.checkId,
    kind: 'run_command' as const,
    executable: reproCheck.executable,
    argv: [...reproCheck.argv],
    workingDirectory: reproCheck.workingDirectory ?? 'tests',
    purpose: reproCheck.purpose,
  };
  const admission = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-command-001'],
    runnableNode: 'Investigate',
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: reproCheck.purpose,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: reproCheck.checkId,
    testPath: 'tests/test_calculator.py',
    planBindingDigest: undefined,
    planDecisionRef: undefined,
  });
  const state = createTestAdmissionTaskStateV02(admission);
  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: admission.expectedControlVersion,
    initialEpoch: admission.expectedEpoch,
    initialMode: 'paused',
    initialAuthorityRef: admission.policyAuthorityRef,
  });

  const repo = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: admission.actionDigest }),
    testResults: {
      default: {
        checkId: reproCheck.checkId,
        outcome: 'fail',
        outputExcerpt: 'ZeroDivisionError: division by zero',
        durationMs: 40,
      },
    },
  });
  const hostPort = createBoundHostPort(task);
  const trustedContext = createTrustedAdmissionContext(task);

  await investigateBaseline(task, repo, hostPort, trustedContext);

  // Target v0.2 acceptance: Paused task must block baseline runTests and yield zero repository test effects.
  assert.equal(
    repo.tests.length,
    0,
    'Paused task must block baseline runTests and yield zero repository test effects'
  );
});

test('v0.2 baseline admission: zero repository test effects on missing or malformed admission context (behavioral RED against pre-migration baseline caller)', async () => {
  const task = createFixtureBugTask();
  const reproCheck = task.requiredChecks.find((c) => c.purpose === 'reproduction')!;
  const action = {
    actionId: reproCheck.checkId,
    kind: 'run_command' as const,
    executable: reproCheck.executable,
    argv: [...reproCheck.argv],
    workingDirectory: reproCheck.workingDirectory ?? 'tests',
    purpose: reproCheck.purpose,
  };
  const admission = createTestRepositoryCommandAdmissionContextV02({
    action,
    reservationRefs: ['res-command-001'],
    runnableNode: 'Investigate',
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: reproCheck.purpose,
    taskCriteriaDigest: computeCanonicalSha256(task.acceptanceCriteria),
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    checkId: reproCheck.checkId,
    testPath: 'tests/test_calculator.py',
    planBindingDigest: undefined,
    planDecisionRef: undefined,
  });
  const state = createTestAdmissionTaskStateV02(admission);
  const journal = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: admission.expectedControlVersion,
    initialEpoch: admission.expectedEpoch,
    initialAuthorityRef: admission.policyAuthorityRef,
  });

  const repo = new FakeRepositoryPort({
    statePort: journal,
    executorIdentity: createTestExecutorIdentityV02({ payloadDigest: admission.actionDigest }),
    testResults: {
      default: {
        checkId: reproCheck.checkId,
        outcome: 'fail',
        outputExcerpt: 'ZeroDivisionError: division by zero',
        durationMs: 40,
      },
    },
  });
  const hostPort = createBoundHostPort(task);
  const trustedContext = createTrustedAdmissionContext(task);

  await investigateBaseline(task, repo, hostPort, trustedContext);

  // Target v0.2 acceptance: Baseline caller must supply valid v0.2 admission context to RepositoryPortV02.
  assert.ok(
    repo.v02Calls.length > 0,
    'Baseline runTests caller must supply valid v0.2 admission context to the repository receiver'
  );
});
