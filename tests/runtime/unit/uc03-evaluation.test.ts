/**
 * UC-03 Verified Code Repair - Evaluation and Comparison Tests
 * Owned path: tests/runtime/unit/uc03-evaluation.test.ts
 * Feature: specs/001-verified-code-repair
 * Task: T027 (evaluation and comparison infrastructure)
 *
 * Requirements & Acceptance:
 * - Manifest C01–C17 covers all required cases from contracts/acceptance.md.
 * - Comprehensive JSON validation rejecting malformed cases, digests, and provenance.
 * - Fake injected driver enables test-driven evaluation development before T026.
 * - Real mode refuses before dispatch; mock mode can never report real-verified.
 * - Nonzero exit for required fail/error/not-run.
 * - Host-private grading stays host-private; no execution on unrestricted host.
 * - Two-run comparison detects improvements, regressions, digest stability, and metrics deltas.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  validateEvaluationManifest,
  validateEvaluationReport,
  computeSha256,
  runEvaluation,
  executeMockPrivateGrading,
  type EvaluationCaseSpec,
  type EvaluationDriverContext,
  type EvaluationDriver,
  type CaseResult,
} from '../../../eval/uc03/runner.ts';
import {
  compareEvaluations,
  runComparison,
} from '../../../eval/uc03/compare.ts';

const REPO_ROOT = resolve(process.cwd());
const MANIFEST_PATH = join(REPO_ROOT, 'eval', 'uc03', 'manifest.json');
const PRIVATE_GRADER_PATH = join(REPO_ROOT, 'eval', 'uc03', 'private', 'grader.json');

/* ==================================================================
 * Section 1: Manifest C01–C17 Validation
 * ================================================================== */

test('manifest: C01-C17 manifest exists and passes schema validation', () => {
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const manifest = validateEvaluationManifest(parsed);

  assert.equal(manifest.suite, 'uc03');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.cases.length, 17, 'Must have exactly 17 cases');

  const expectedIds = Array.from({ length: 17 }, (_, i) => `C${String(i + 1).padStart(2, '0')}`);
  const actualIds = manifest.cases.map((c) => c.caseId);
  assert.deepEqual(actualIds, expectedIds, 'Cases must be C01 through C17 in exact order');

  for (const c of manifest.cases) {
    assert.ok(c.name.length > 0, `${c.caseId} must have name`);
    assert.ok(c.description.length > 0, `${c.caseId} must have description`);
    assert.equal(c.required, true, `${c.caseId} must be required`);
    assert.ok(c.requirements.length > 0, `${c.caseId} must list requirements`);
    assert.ok(
      ['COMPLETED', 'INCOMPLETE', 'IMPLEMENTED_UNVERIFIED', 'FAILED'].includes(c.expectedOutcome),
      `${c.caseId} has valid expectedOutcome`
    );
  }
});

test('manifest: does not leak host-private grading answers or secrets', () => {
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  assert.ok(!raw.includes('private_tests'), 'Manifest must not leak private test files');
  assert.ok(!raw.includes('test_hidden_verification'), 'Manifest must not leak hidden test names');
  assert.ok(!raw.includes('sk-'), 'Manifest must not contain API keys');
  assert.ok(!raw.includes('MARKER_SECRET'), 'Manifest must not contain secret markers');
});

test('manifest: rejects malformed manifest objects', () => {
  assert.throws(() => validateEvaluationManifest(null), /Invalid manifest/);
  assert.throws(() => validateEvaluationManifest({}), /Invalid manifest/);
  assert.throws(() => validateEvaluationManifest({ suite: 'wrong', version: '0.1.0', cases: [] }), /Invalid manifest/);
  assert.throws(() => validateEvaluationManifest({ suite: 'uc03', version: '0.1.0', cases: 'not-array' }), /Invalid manifest/);
  assert.throws(
    () =>
      validateEvaluationManifest({
        suite: 'uc03',
        version: '0.1.0',
        cases: [{ caseId: 'C01' }], // missing required fields
      }),
    /Invalid manifest/
  );
  assert.throws(
    () =>
      validateEvaluationManifest({
        suite: 'uc03',
        version: '0.1.0',
        cases: [
          {
            caseId: 'C01',
            name: 'dup',
            description: 'd',
            category: 'cat',
            required: true,
            expectedOutcome: 'COMPLETED',
            requirements: ['FR-001'],
          },
          {
            caseId: 'C01', // duplicate ID
            name: 'dup',
            description: 'd',
            category: 'cat',
            required: true,
            expectedOutcome: 'COMPLETED',
            requirements: ['FR-001'],
          },
        ],
      }),
    /Invalid manifest/
  );
});

/* ==================================================================
 * Section 2: Mock Evaluation with Fake Injected Driver
 * ================================================================== */

function createFakeDriver(overrides?: Partial<Record<string, Partial<CaseResult>>>): {
  executeCase(spec: EvaluationCaseSpec, context: EvaluationDriverContext): Promise<CaseResult>;
} {
  return {
    async executeCase(spec: EvaluationCaseSpec, context: EvaluationDriverContext): Promise<CaseResult> {
      const override = overrides?.[spec.caseId];
      const status = override?.status ?? 'pass';
      return {
        caseId: spec.caseId,
        useCase: 'UC-03',
        contractVersion: '0.1.0',
        taskId: override?.taskId ?? `task-${spec.caseId.toLowerCase()}`,
        runId: `run-${spec.caseId.toLowerCase()}`,
        mode: context.mode,
        status,
        expectedOutcome: spec.expectedOutcome,
        actualOutcome: override?.actualOutcome ?? spec.expectedOutcome,
        timing: { startMs: 1000, endMs: 1100, durationMs: 100 },
        usage: { tokensConsumed: 500, costUsd: 0.01, replanCount: 0 },
        digests: {
          manifestDigest: context.manifestDigest,
          configDigest: context.configDigest,
        },
        sideEffectObserved: false,
        limitations: [],
        ...override,
      };
    },
  };
}

function createMockPrivateGrading(overrides: {
  readonly admission?: (request: Record<string, unknown>) => unknown;
  readonly result?: (request: Record<string, unknown>) => unknown;
  readonly finalSnapshot?: unknown;
  readonly profile?: unknown;
  readonly isolationAuthority?: unknown;
} = {}) {
  const graderPayload = { marker: 'MARKER_PRIVATE_GRADER_PAYLOAD' };
  const finalSnapshot = overrides.finalSnapshot ?? {
    snapshotId: 'snapshot-final-17',
    digest: computeSha256('final snapshot'),
  };
  const profile = overrides.profile ?? {
    profileId: 'profile-isolated-test',
    digest: computeSha256('mock isolation profile'),
    bounds: { timeoutMs: 1000, maxCpuMs: 800, maxOutputBytes: 4096, maxMemoryBytes: 67_108_864, maxProcesses: 2 },
  };
  let admissionCalls = 0;
  let executorCalls = 0;
  let admittedRequest: Record<string, unknown> | undefined;
  const executor = {
    executorId: 'fake-isolated-executor',
    execute(request: Record<string, unknown>): unknown {
      executorCalls++;
      if (overrides.result) return overrides.result(request);
      return {
        finalSnapshot: request['finalSnapshot'],
        profile: request['profile'],
        executorId: request['executorId'],
        status: 'pass',
        actualOutcome: 'COMPLETED',
        durationMs: 12,
        cpuMs: 8,
        outputBytes: 128,
      };
    },
  };
  const isolationAuthority = overrides.isolationAuthority ?? {
    admit(request: Record<string, unknown>): unknown {
      admissionCalls++;
      admittedRequest = request;
      if (overrides.admission) return overrides.admission(request);
      return {
        kind: 'injected-mock-isolation-admission',
        finalSnapshot: request['finalSnapshot'],
        profile: request['profile'],
        executorId: request['executorId'],
        admissionId: 'admission-c17-test',
      };
    },
  };
  return {
    boundary: { finalSnapshot, profile, graderPayload, isolationAuthority, executor },
    graderPayload,
    executor,
    get admissionCalls(): number { return admissionCalls; },
    get executorCalls(): number { return executorCalls; },
    get admittedRequest(): Record<string, unknown> | undefined { return admittedRequest; },
  };
}

test('runner: injected fake driver remains infrastructure evidence and leaves private grading not-run', async () => {
  const driver = createFakeDriver();
  const report = await runEvaluation({
    suite: 'uc03',
    mode: 'mock',
    manifestPath: MANIFEST_PATH,
    driver,
  });

  assert.equal(report.suite, 'uc03');
  assert.equal(report.mode, 'mock');
  assert.equal(report.cases.length, 17);
  assert.equal(report.summary.totalCases, 17);
  assert.equal(report.summary.passedCases, 16);
  assert.equal(report.summary.failedCases, 0);
  assert.equal(report.summary.errorCases, 0);
  assert.equal(report.summary.notRunCases, 1);
  assert.equal(report.summary.requiredFailuresOrNotRun, 1);
  assert.equal(report.summary.successRate, 16 / 17);
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.exitCode, 1);
  assert.equal(report.cases.find((result) => result.caseId === 'C17')?.status, 'not-run');
  assert.ok(report.limitations.some((value) => value.includes('do not establish UC-03 workflow evidence')));

  // In mock mode, isRealVerified MUST ALWAYS BE FALSE
  assert.equal(report.isRealVerified, false, 'Mock mode can never report real-verified');

  // Validate the generated report against validateEvaluationReport
  const validated = validateEvaluationReport(report);
  assert.equal(validated.suite, 'uc03');
});

test('runner: admitted mock grading uses the separate executor and keeps C17 non-real', async () => {
  const mockGrading = createMockPrivateGrading();
  let driverCalls = 0;
  let driverContext: unknown;

  const report = await runEvaluation({
    mode: 'mock',
    manifestPath: MANIFEST_PATH,
    cases: ['C01', 'C17'],
    driver: {
      executeCase(spec: EvaluationCaseSpec, context: EvaluationDriverContext): unknown {
        driverCalls++;
        driverContext = context;
        return createFakeDriver().executeCase(spec, context);
      },
    },
    mockPrivateGrading: mockGrading.boundary,
  });

  assert.equal(mockGrading.admissionCalls, 1);
  assert.equal(mockGrading.executorCalls, 1);
  assert.equal(driverCalls, 1, 'The ordinary driver handles C01 only');
  assert.ok(typeof driverContext === 'object' && driverContext !== null);
  assert.equal(Object.hasOwn(driverContext, 'graderPayload'), false);
  assert.ok(!JSON.stringify(driverContext).includes(mockGrading.graderPayload.marker));
  assert.equal('graderPayload' in (mockGrading.admittedRequest ?? {}), false);
  assert.equal(mockGrading.admittedRequest?.['executorId'], mockGrading.executor.executorId);
  const c17 = report.cases.find((result) => result.caseId === 'C17');
  assert.equal(c17?.status, 'not-run');
  assert.ok(c17?.limitations.some((value) => value.includes('mock grading boundary')));
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.exitCode, 1);
  assert.equal(report.isRealVerified, false);
  assert.ok(!JSON.stringify(report).includes(mockGrading.graderPayload.marker));
});

test('grading: returns bounded metadata tied to the exact admitted snapshot and profile', async () => {
  const mockGrading = createMockPrivateGrading();
  const result = await executeMockPrivateGrading(mockGrading.boundary);

  assert.ok(result !== undefined);
  assert.equal(result.finalSnapshot.snapshotId, 'snapshot-final-17');
  assert.equal(result.finalSnapshot.digest, computeSha256('final snapshot'));
  assert.equal(result.profile.profileId, 'profile-isolated-test');
  assert.equal(result.executorId, mockGrading.executor.executorId);
  assert.equal(result.status, 'pass');
  assert.equal(result.durationMs, 12);
  assert.equal(result.outputBytes, 128);
  assert.equal(Object.hasOwn(result, 'cpuMs'), false);
  assert.ok(!JSON.stringify(result).includes(mockGrading.graderPayload.marker));
});

test('grading: refuses missing or mismatched admission before executor invocation', async () => {
  const wrongSnapshot = createMockPrivateGrading({
    admission: (request) => ({
      kind: 'injected-mock-isolation-admission',
      finalSnapshot: { snapshotId: 'snapshot-stale', digest: computeSha256('stale') },
      profile: request['profile'],
      executorId: request['executorId'],
      admissionId: 'admission-stale',
    }),
  });
  const wrongProfile = createMockPrivateGrading({
    admission: (request) => ({
      kind: 'injected-mock-isolation-admission',
      finalSnapshot: request['finalSnapshot'],
      profile: { profileId: 'profile-wrong', digest: computeSha256('wrong'), bounds: {} },
      executorId: request['executorId'],
      admissionId: 'admission-wrong-profile',
    }),
  });
  const wrongExecutor = createMockPrivateGrading({
    admission: (request) => ({
      kind: 'injected-mock-isolation-admission',
      finalSnapshot: request['finalSnapshot'],
      profile: request['profile'],
      executorId: 'different-executor',
      admissionId: 'admission-wrong-executor',
    }),
  });
  const selfAssertedBoolean = createMockPrivateGrading({ admission: () => true });
  const missingAuthority = createMockPrivateGrading();
  const invalidCases = [
    wrongSnapshot,
    wrongProfile,
    wrongExecutor,
    selfAssertedBoolean,
    { ...missingAuthority, boundary: { ...missingAuthority.boundary, isolationAuthority: undefined } },
  ];

  for (const mockGrading of invalidCases) {
    assert.equal(await executeMockPrivateGrading(mockGrading.boundary), undefined);
    assert.equal(mockGrading.executorCalls, 0);
  }
  assert.equal(wrongSnapshot.admissionCalls, 1);
  assert.equal(wrongProfile.admissionCalls, 1);
  assert.equal(wrongExecutor.admissionCalls, 1);
  assert.equal(selfAssertedBoolean.admissionCalls, 1);
  assert.equal(missingAuthority.admissionCalls, 0);
});

test('grading: invalid bounds and unsafe or mismatched results stay not-run and expose no payload', async () => {
  const invalidBounds = createMockPrivateGrading({
    profile: {
      profileId: 'profile-unbounded-test',
      digest: computeSha256('unbounded profile'),
      bounds: { timeoutMs: 0, maxCpuMs: 0, maxOutputBytes: 4096, maxMemoryBytes: 67_108_864, maxProcesses: 2 },
    },
  });
  assert.equal(await executeMockPrivateGrading(invalidBounds.boundary), undefined);
  assert.equal(invalidBounds.admissionCalls, 0);
  assert.equal(invalidBounds.executorCalls, 0);

  const invalidResults = [
    { finalSnapshot: { snapshotId: 'snapshot-other', digest: computeSha256('other') } },
    { profile: { profileId: 'profile-other', digest: computeSha256('other'), bounds: {} } },
    { durationMs: 1001 },
    { cpuMs: 801 },
    { outputBytes: 4097 },
    { privateOutput: 'MARKER_PRIVATE_GRADER_RESULT' },
  ];
  for (const override of invalidResults) {
    const mockGrading = createMockPrivateGrading({
      result: (request) => ({
        finalSnapshot: request['finalSnapshot'],
        profile: request['profile'],
        executorId: request['executorId'],
        status: 'pass',
        actualOutcome: 'COMPLETED',
        durationMs: 12,
        cpuMs: 8,
        outputBytes: 128,
        ...override,
      }),
    });
    assert.equal(await executeMockPrivateGrading(mockGrading.boundary), undefined);
    assert.equal(mockGrading.executorCalls, 1);
  }

  const report = await runEvaluation({
    mode: 'mock',
    manifestPath: MANIFEST_PATH,
    cases: ['C17'],
    mockPrivateGrading: invalidBounds.boundary,
  });
  assert.equal(report.cases.find((result) => result.caseId === 'C17')?.status, 'not-run');
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.exitCode, 1);
  assert.equal(report.isRealVerified, false);
  assert.ok(!JSON.stringify(report).includes(invalidBounds.graderPayload.marker));
});

test('runner: resolves the default manifest when the current directory changes', async () => {
  const originalWorkingDirectory = process.cwd();
  try {
    process.chdir(tmpdir());
    const report = await runEvaluation({ mode: 'mock', driver: createFakeDriver() });
    assert.equal(report.summary.totalCases, 17);
  } finally {
    process.chdir(originalWorkingDirectory);
  }
});

test('runner: no configured driver yields honest not-run cases with zero measured usage', async () => {
  const report = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH });
  assert.equal(report.summary.passedCases, 0);
  assert.equal(report.summary.notRunCases, 17);
  assert.equal(report.summary.totalTokensConsumed, 0);
  assert.equal(report.summary.totalCostUsd, 0);
  assert.equal(report.summary.totalDurationMs, 0);
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.exitCode, 1);
  const c17 = report.cases.find((result) => result.caseId === 'C17');
  assert.equal(c17?.status, 'not-run');
  assert.equal(c17?.taskId, null);
  assert.equal(c17?.runId, null);
  assert.ok(report.limitations.some((value) => value.includes('C17 private grading was not run')));
});

test('runner: selected cases retain omitted required cases as not-run and reject invalid requests before dispatch', async () => {
  const selected = await runEvaluation({
    mode: 'mock',
    manifestPath: MANIFEST_PATH,
    cases: ['C01'],
    driver: createFakeDriver(),
  });
  assert.equal(selected.summary.totalCases, 17);
  assert.equal(selected.summary.passedCases, 1);
  assert.equal(selected.summary.notRunCases, 16);
  assert.equal(selected.summary.requiredFailuresOrNotRun, 16);
  assert.equal(selected.cases.find((result) => result.caseId === 'C02')?.status, 'not-run');

  let emptySelectionDriverCalls = 0;
  const emptySelection = await runEvaluation({
    mode: 'mock',
    manifestPath: MANIFEST_PATH,
    cases: [],
    driver: {
      executeCase(): unknown {
        emptySelectionDriverCalls++;
        return {};
      },
    },
  });
  assert.equal(emptySelection.summary.notRunCases, 17);
  assert.equal(emptySelection.exitCode, 1);
  assert.equal(emptySelectionDriverCalls, 0);

  let driverCalls = 0;
  const driver: EvaluationDriver = {
    executeCase(): unknown {
      driverCalls++;
      return {};
    },
  };
  const invalidRequests: readonly unknown[] = [
    { mode: 'mock', cases: ['C99'], driver },
    { mode: 'mock', cases: ['C01', 'C01'], driver },
    { mode: 'invalid', driver },
    { mode: 'mock', suite: 'uc01', driver },
  ];
  for (const request of invalidRequests) {
    await assert.rejects(() => runEvaluation(request), /Invalid evaluation options/);
  }
  assert.equal(driverCalls, 0);
});

test('runner: driver throws and malformed or semantically false pass results become safe errors', async () => {
  const throwing = await runEvaluation({
    mode: 'mock',
    manifestPath: MANIFEST_PATH,
    driver: {
      executeCase(): unknown {
        throw new Error('MARKER_SECRET_DRIVER_EXCEPTION');
      },
    },
  });
  assert.equal(throwing.cases[0]?.status, 'error');
  assert.equal(throwing.cases[0]?.actualOutcome, 'DRIVER_ERROR');
  assert.equal(throwing.cases[0]?.sideEffectObserved, null);
  assert.ok(!JSON.stringify(throwing).includes('MARKER_SECRET_DRIVER_EXCEPTION'));

  const malformed = await runEvaluation({
    mode: 'mock',
    manifestPath: MANIFEST_PATH,
    driver: createFakeDriver({
      C01: { timing: { startMs: 1000, endMs: 1100, durationMs: 999 } },
    }),
  });
  assert.equal(malformed.cases[0]?.status, 'error');
  assert.equal(malformed.cases[0]?.actualOutcome, 'DRIVER_RESULT_INVALID');

  const falsePass = await runEvaluation({
    mode: 'mock',
    manifestPath: MANIFEST_PATH,
    driver: createFakeDriver({ C01: { status: 'pass', actualOutcome: 'FAILED' } }),
  });
  assert.equal(falsePass.cases[0]?.status, 'error');
  assert.equal(falsePass.cases[0]?.actualOutcome, 'DRIVER_RESULT_INVALID');
});

test('runner: validateEvaluationReport rejects malformed report records', () => {
  assert.throws(() => validateEvaluationReport(null), /Invalid evaluation report/);
  assert.throws(() => validateEvaluationReport({}), /Invalid evaluation report/);
  assert.throws(() => validateEvaluationReport({ suite: 'other' }), /Invalid evaluation report/);
});

test('runner: rejects forged nested metrics, timing, digest, status, and provenance', async () => {
  const report = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, driver: createFakeDriver() });
  const malformedMetrics: unknown = {
    ...report,
    summary: { ...report.summary, totalTokensConsumed: Number.NaN },
  };
  const malformedTiming: unknown = {
    ...report,
    cases: report.cases.map((result, index) =>
      index === 0 ? { ...result, timing: { ...result.timing, durationMs: 999 } } : result
    ),
  };
  const malformedDigest: unknown = { ...report, manifestDigest: 'sha256:123' };
  const mismatchedCaseMode: unknown = {
    ...report,
    cases: report.cases.map((result, index) =>
      index === 0 ? { ...result, mode: 'real' } : result
    ),
  };
  const falsePass: unknown = {
    ...report,
    cases: report.cases.map((result, index) =>
      index === 0 ? { ...result, actualOutcome: 'FAILED' } : result
    ),
  };
  const duplicateCase: unknown = {
    ...report,
    cases: report.cases.map((result, index) =>
      index === 1 ? { ...result, caseId: 'C01' } : result
    ),
  };
  const mismatchDigest: unknown = {
    ...report,
    cases: report.cases.map((result, index) =>
      index === 0
        ? { ...result, digests: { ...result.digests, configDigest: computeSha256('forged config') } }
        : result
    ),
  };
  const duplicateIdentity: unknown = {
    ...report,
    cases: report.cases.map((result, index) =>
      index === 1
        ? { ...result, taskId: report.cases[0]?.taskId, runId: report.cases[0]?.runId }
        : result
    ),
  };
  const inconsistentSummary: unknown = {
    ...report,
    summary: { ...report.summary, passedCases: report.summary.passedCases + 1 },
  };
  const falseVerdict: unknown = { ...report, verdict: 'PASS', exitCode: 0 };
  const secretMetadata: unknown = {
    ...report,
    limitations: [...report.limitations, 'MARKER_SECRET_PERSISTED_REPORT'],
  };
  const oversizedMetadata: unknown = {
    ...report,
    limitations: ['x'.repeat(257)],
  };

  for (const malformed of [
    malformedMetrics,
    malformedTiming,
    malformedDigest,
    mismatchedCaseMode,
    falsePass,
    duplicateCase,
    mismatchDigest,
    duplicateIdentity,
    inconsistentSummary,
    falseVerdict,
    secretMetadata,
    oversizedMetadata,
  ]) {
    assert.throws(() => validateEvaluationReport(malformed), /Invalid evaluation report/);
  }
});

test('runner: rejects malformed nested report metrics', () => {
  const manifest: unknown = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const manifestDigest = computeSha256(JSON.stringify(validateEvaluationManifest(manifest)));
  const malformedMetrics: unknown = {
    suite: 'uc03',
    contractVersion: '0.1.0',
    mode: 'mock',
    manifestDigest,
    configDigest: computeSha256('test configuration'),
    timestamp: '2026-10-26T00:00:00.000Z',
    isRealVerified: false,
    verdict: 'FAIL',
    exitCode: 1,
    summary: { totalTokensConsumed: Number.NaN },
    cases: [],
    limitations: [],
  };

  assert.throws(() => validateEvaluationReport(malformedMetrics), /Invalid evaluation report/);
});

test('runner: mock evaluation reports nonzero exit when required case fails or is not-run', async () => {
  const driver = createFakeDriver({
    C05: { status: 'fail', actualOutcome: 'FAILED' },
    C11: { status: 'not-run', actualOutcome: 'NOT_RUN' },
  });

  const report = await runEvaluation({
    suite: 'uc03',
    mode: 'mock',
    manifestPath: MANIFEST_PATH,
    driver,
  });

  assert.equal(report.summary.totalCases, 17);
  assert.equal(report.summary.passedCases, 14);
  assert.equal(report.summary.failedCases, 1);
  assert.equal(report.summary.notRunCases, 2);
  assert.equal(report.summary.requiredFailuresOrNotRun, 3);
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.exitCode, 1, 'Must exit nonzero for required failure or not-run');
  assert.equal(report.isRealVerified, false);
});

test('runner: real mode refuses before dispatch without real backend', async () => {
  let driverCalls = 0;
  const mockGrading = createMockPrivateGrading();
  const report = await runEvaluation({
    suite: 'uc03',
    mode: 'real',
    manifestPath: MANIFEST_PATH,
    driver: {
      executeCase(): unknown {
        driverCalls++;
        return {};
      },
    },
    mockPrivateGrading: mockGrading.boundary,
  });

  assert.equal(report.mode, 'real');
  assert.equal(report.verdict, 'REFUSED');
  assert.equal(report.exitCode, 1, 'Real mode must exit nonzero when backend is missing');
  assert.equal(report.isRealVerified, false, 'Real mode without backend cannot be verified');
  assert.equal(report.summary.notRunCases, 17, 'All cases must remain not-run');
  assert.equal(driverCalls, 0, 'Real mode must refuse before driver invocation');
  assert.equal(mockGrading.admissionCalls, 0, 'Real mode must refuse before grading admission');
  assert.equal(mockGrading.executorCalls, 0, 'Real mode must refuse before grader invocation');
  assert.ok(report.limitations.some((l) => l.includes('refused') || l.includes('Real mode')));
});

test('runner: sanitizes secrets from case outcomes and limitations', async () => {
  const markerSecret = 'MARKER_SECRET_TOKEN_XYZ';
  const baseDriver = createFakeDriver({
    C01: {
      limitations: [`Failed with secret: ${markerSecret}`],
      denialReason: `Denial due to ${markerSecret}`,
    },
    C02: { taskId: markerSecret },
    C04: { limitations: ['x'.repeat(4000)] },
  });
  const driver: EvaluationDriver = {
    async executeCase(spec, options): Promise<unknown> {
      const result = await baseDriver.executeCase(spec, options);
      return spec.caseId === 'C03' ? { ...result, actualOutcome: markerSecret } : result;
    },
  };

  const report = await runEvaluation({
    suite: 'uc03',
    mode: 'mock',
    manifestPath: MANIFEST_PATH,
    driver,
    customSecretPatterns: [markerSecret],
  });

  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(markerSecret), 'Report must not contain raw secret');
  assert.ok(serialized.includes('[REDACTED]'), 'Secret must be redacted in report');
  assert.equal(report.cases[1]?.status, 'error', 'Secret-bearing identity is refused');
  assert.equal(report.cases[2]?.status, 'error', 'Unknown secret-bearing outcome is refused');
  assert.ok(Buffer.byteLength(report.cases[3]?.limitations[0] ?? '', 'utf8') <= 256, 'Driver text is bounded');
});

test('runner: private grader metadata records unrun status without claiming isolation', () => {
  const raw = readFileSync(PRIVATE_GRADER_PATH, 'utf8');
  assert.match(raw, /"configurationOnly": true/);
  assert.match(raw, /"executionStatus": "not-run"/);
  assert.match(raw, /"isolationStatus": "not-established"/);
  assert.match(raw, /"hostExecutionAllowed": false/);
  assert.doesNotMatch(raw, /"executable"|"argv"|"expectedExitCode"/);
});

/* ==================================================================
 * Section 3: Two-Run Comparison (compare.ts)
 * ================================================================== */

test('compare: identical fake-driver runs remain INCOMPLETE because C17 is not-run', async () => {
  const driver = createFakeDriver();
  const baseline = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, driver });
  const candidate = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, driver });

  const comparison = compareEvaluations(baseline, candidate);

  assert.equal(comparison.suite, 'uc03');
  assert.equal(comparison.verdict, 'INCOMPLETE');
  assert.equal(comparison.exitCode, 1);
  assert.equal(comparison.summary.totalCommon, 17);
  assert.equal(comparison.summary.regressionsCount, 0);
  assert.equal(comparison.summary.improvementsCount, 0);
  assert.equal(comparison.summary.stableCount, 17);
});

test('compare: required not-run cases keep an unchanged comparison nonzero', async () => {
  const baseline = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH });
  const candidate = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH });
  const comparison = compareEvaluations(baseline, candidate);

  assert.equal(comparison.verdict, 'INCOMPLETE');
  assert.equal(comparison.exitCode, 1);
});

test('compare: detects regressions and returns exit code 1', async () => {
  const baselineDriver = createFakeDriver();
  const candidateDriver = createFakeDriver({
    C01: { status: 'fail', actualOutcome: 'FAILED' },
  });

  const baseline = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, driver: baselineDriver });
  const candidate = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, driver: candidateDriver });

  const comparison = compareEvaluations(baseline, candidate);

  assert.equal(comparison.verdict, 'REGRESSED');
  assert.equal(comparison.exitCode, 1, 'Must exit nonzero on regression');
  assert.equal(comparison.summary.regressionsCount, 1);

  const c01Delta = comparison.cases.find((c) => c.caseId === 'C01');
  assert.ok(c01Delta !== undefined);
  assert.equal(c01Delta.baselineStatus, 'pass');
  assert.equal(c01Delta.candidateStatus, 'fail');
  assert.equal(c01Delta.transition, 'regressed');
});

test('compare: driver error to pass is an improvement in runner-produced reports', async () => {
  const successfulDriver = createFakeDriver();
  const errorDriver: EvaluationDriver = {
    async executeCase(spec, context) {
      if (spec.caseId === 'C01') throw new Error('simulated driver error');
      return successfulDriver.executeCase(spec, context);
    },
  };
  const baseline = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, driver: errorDriver });
  const candidate = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, driver: successfulDriver });

  assert.equal(baseline.cases[0]?.status, 'error');
  assert.equal(baseline.cases[0]?.taskId, null);
  assert.equal(candidate.cases[0]?.status, 'pass');
  assert.notEqual(candidate.cases[0]?.taskId, null);

  const comparison = compareEvaluations(baseline, candidate);
  const c01Delta = comparison.cases.find((result) => result.caseId === 'C01');
  assert.equal(comparison.summary.improvementsCount, 1);
  assert.equal(c01Delta?.transition, 'improved');

  const regression = compareEvaluations(candidate, baseline);
  const reverseC01Delta = regression.cases.find((result) => result.caseId === 'C01');
  assert.equal(regression.verdict, 'REGRESSED');
  assert.equal(regression.exitCode, 1);
  assert.equal(regression.summary.regressionsCount, 1);
  assert.equal(reverseC01Delta?.transition, 'regressed');
});

test('compare: reports improvements while required not-run cases keep the result incomplete', async () => {
  const baselineDriver = createFakeDriver({
    C03: { status: 'fail', actualOutcome: 'FAILED' },
  });
  const candidateDriver = createFakeDriver();

  const baseline = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, driver: baselineDriver });
  const candidate = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, driver: candidateDriver });

  const comparison = compareEvaluations(baseline, candidate);

  assert.equal(comparison.verdict, 'INCOMPLETE');
  assert.equal(comparison.exitCode, 1);
  assert.equal(comparison.summary.improvementsCount, 1);
  assert.equal(comparison.summary.regressionsCount, 0);

  const c03Delta = comparison.cases.find((c) => c.caseId === 'C03');
  assert.ok(c03Delta !== undefined);
  assert.equal(c03Delta.baselineStatus, 'fail');
  assert.equal(c03Delta.candidateStatus, 'pass');
  assert.equal(c03Delta.transition, 'improved');
});

test('compare: not-run and result transitions retain nonzero required-failure behavior', async () => {
  const notRun = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, cases: ['C01'] });
  const result = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, cases: ['C01'], driver: createFakeDriver() });

  assert.equal(notRun.cases[0]?.status, 'not-run');
  assert.equal(notRun.cases[0]?.taskId, null);
  assert.equal(result.cases[0]?.status, 'pass');
  assert.notEqual(result.cases[0]?.taskId, null);

  const improvement = compareEvaluations(notRun, result);
  const improvedC01 = improvement.cases.find((item) => item.caseId === 'C01');
  assert.equal(improvement.verdict, 'INCOMPLETE');
  assert.equal(improvement.exitCode, 1);
  assert.equal(improvedC01?.transition, 'improved');

  const regression = compareEvaluations(result, notRun);
  const regressedC01 = regression.cases.find((item) => item.caseId === 'C01');
  assert.equal(regression.verdict, 'REGRESSED');
  assert.equal(regression.exitCode, 1);
  assert.equal(regressedC01?.transition, 'regressed');
});

test('compare: rejects malformed reports before reading case metrics', async () => {
  const validReport = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, driver: createFakeDriver() });
  const mismatchedSuite: unknown = { ...validReport, suite: 'uc01' };
  const malformedCases: unknown = { ...validReport, cases: 'bad' };

  assert.throws(() => compareEvaluations(null, validReport), /Invalid evaluation report/);
  assert.throws(() => compareEvaluations(validReport, mismatchedSuite), /Invalid evaluation report/);
  assert.throws(() => compareEvaluations(validReport, malformedCases), /Invalid evaluation report/);
});

test('compare: refuses reports with different configuration or execution modes', async () => {
  const baseline = await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, driver: createFakeDriver() });
  const alternateConfigDigest = computeSha256('different evaluation configuration');
  const incompatibleConfig = {
    ...baseline,
    configDigest: alternateConfigDigest,
    cases: baseline.cases.map((result) => ({
      ...result,
      digests: { ...result.digests, configDigest: alternateConfigDigest },
    })),
  };
  const incompatibleTask = await runEvaluation({
    mode: 'mock',
    manifestPath: MANIFEST_PATH,
    driver: createFakeDriver({ C01: { taskId: 'task-different-c01' } }),
  });
  const realRun = await runEvaluation({ mode: 'real', manifestPath: MANIFEST_PATH });

  assert.throws(() => compareEvaluations(baseline, incompatibleConfig), /Incomparable/);
  assert.throws(() => compareEvaluations(baseline, incompatibleTask), /Incomparable/);
  assert.throws(() => compareEvaluations(baseline, realRun), /Incomparable/);
});

/* ==================================================================
 * Section 4: File Output and CLI Flow
 * ================================================================== */

test('runner: outputs valid JSON report file to specified output path', async () => {
  const outPath = join(REPO_ROOT, 'temp-run-test-output.json');
  try {
    const driver = createFakeDriver();
    const report = await runEvaluation({
      suite: 'uc03',
      mode: 'mock',
      manifestPath: MANIFEST_PATH,
      outputPath: outPath,
      driver,
    });

    assert.ok(existsSync(outPath), 'Output file must exist');
    const writtenRaw = readFileSync(outPath, 'utf8');
    const written = JSON.parse(writtenRaw);
    assert.equal(written.suite, 'uc03');
    assert.equal(written.cases.length, 17);
    assert.equal(written.verdict, report.verdict);
  } finally {
    if (existsSync(outPath)) {
      rmSync(outPath, { force: true });
    }
  }
});

test('compare: writes comparison report to outputPath', async () => {
  const baselinePath = join(REPO_ROOT, 'temp-base-compare.json');
  const candidatePath = join(REPO_ROOT, 'temp-cand-compare.json');
  const outPath = join(REPO_ROOT, 'temp-compare-result.json');

  try {
    const driver = createFakeDriver();
    await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, outputPath: baselinePath, driver });
    await runEvaluation({ mode: 'mock', manifestPath: MANIFEST_PATH, outputPath: candidatePath, driver });

    const comparison = await runComparison({
      baselinePath,
      candidatePath,
      outputPath: outPath,
    });

    assert.ok(existsSync(outPath));
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(written.verdict, 'INCOMPLETE');
    assert.equal(comparison.verdict, 'INCOMPLETE');
    assert.equal(comparison.exitCode, 1);
  } finally {
    if (existsSync(baselinePath)) rmSync(baselinePath, { force: true });
    if (existsSync(candidatePath)) rmSync(candidatePath, { force: true });
    if (existsSync(outPath)) rmSync(outPath, { force: true });
  }
});
