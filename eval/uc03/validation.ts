import { createHash } from 'node:crypto';
import defaultManifest from './manifest.json' with { type: 'json' };
import { sanitizeText } from '../../src/foundation/telemetry.ts';
import { boundedText, safeMetadata } from '../../src/uc03/report/sanitize.ts';
import { parseSummary, summarizeCases } from './results.ts';
import {
  EVALUATION_CASE_IDS,
  C17_NOT_RUN_LIMITATION,
  UC03_CONTRACT_VERSION,
  type CaseResult,
  type CaseStatus,
  type ActualOutcome,
  type EvaluationCaseContext,
  type EvaluationCaseId,
  type EvaluationDriver,
  type EvaluationManifest,
  type EvaluationOutcome,
  type EvaluationReport,
  type RunEvaluationOptions,
} from './types.ts';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OUTCOMES = new Set<string>(['COMPLETED', 'INCOMPLETE', 'IMPLEMENTED_UNVERIFIED', 'FAILED']);
const ACTUAL_OUTCOMES = new Set<string>([
  ...OUTCOMES,
  'NOT_RUN',
  'REFUSED_BEFORE_DISPATCH',
  'DRIVER_ERROR',
  'DRIVER_RESULT_INVALID',
]);
const STATUSES = new Set<string>(['pass', 'fail', 'error', 'not-run']);
const CASE_ID_SET = new Set<string>(EVALUATION_CASE_IDS);

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidManifest(): never {
  throw new Error('Invalid manifest');
}

function invalidOptions(): never {
  throw new Error('Invalid evaluation options');
}

function invalidDriverResult(): never {
  throw new Error('Invalid evaluation driver result');
}

function invalidReport(): never {
  throw new Error('Invalid evaluation report');
}

function validText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes && sanitizeText(value) === value;
}

function manifestField(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function isEvaluationCaseId(value: unknown): value is EvaluationCaseId {
  return typeof value === 'string' && CASE_ID_SET.has(value);
}

function isEvaluationOutcome(value: unknown): value is EvaluationOutcome {
  return typeof value === 'string' && OUTCOMES.has(value);
}

function isCaseStatus(value: unknown): value is CaseStatus {
  return typeof value === 'string' && STATUSES.has(value);
}

function isActualOutcome(value: unknown): value is ActualOutcome {
  return typeof value === 'string' && ACTUAL_OUTCOMES.has(value);
}

function parseManifest(value: unknown): EvaluationManifest {
  if (!isRecord(value) || value['suite'] !== 'uc03' || value['version'] !== '0.1.0') invalidManifest();
  const description = value['description'];
  if (!manifestField(description, 512) || !Array.isArray(value['cases']) || value['cases'].length !== EVALUATION_CASE_IDS.length) invalidManifest();

  const cases = value['cases'].map((entry: unknown, index: number): EvaluationManifest['cases'][number] => {
    const expectedCaseId = EVALUATION_CASE_IDS[index];
    if (!expectedCaseId || !isRecord(entry) || entry['caseId'] !== expectedCaseId) invalidManifest();
    const name = entry['name'];
    const caseDescription = entry['description'];
    const category = entry['category'];
    const expectedOutcome = entry['expectedOutcome'];
    if (!manifestField(name, 512) || !manifestField(caseDescription, 512) || !manifestField(category, 128)) invalidManifest();
    if (entry['required'] !== true || !isEvaluationOutcome(expectedOutcome)) invalidManifest();
    if (!Array.isArray(entry['requirements']) || entry['requirements'].length === 0 || entry['requirements'].length > 16) invalidManifest();
    const requirements = entry['requirements'].map((requirement: unknown): string => {
      if (typeof requirement !== 'string' || !/^(FR|SC)-\d{3}$/.test(requirement)) invalidManifest();
      return requirement;
    });
    const hiddenGraderId = entry['hiddenGraderId'];
    if (expectedCaseId === 'C17' && hiddenGraderId !== 'grade-c17-hidden-reproduction') invalidManifest();
    if (expectedCaseId !== 'C17' && hiddenGraderId !== undefined) invalidManifest();

    return {
      caseId: expectedCaseId,
      name,
      description: caseDescription,
      category,
      required: true,
      expectedOutcome,
      requirements,
      ...(expectedCaseId === 'C17' ? { hiddenGraderId: 'grade-c17-hidden-reproduction' } : {}),
    };
  });

  return { suite: 'uc03', version: '0.1.0', description, cases };
}

const CANONICAL_MANIFEST = parseManifest(defaultManifest);

export function validateEvaluationManifest(data: unknown): EvaluationManifest {
  try {
    const manifest = parseManifest(data);
    if (JSON.stringify(manifest) !== JSON.stringify(CANONICAL_MANIFEST)) invalidManifest();
    return manifest;
  } catch {
    return invalidManifest();
  }
}

export function computeSha256(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

export const DEFAULT_MANIFEST_DIGEST = computeSha256(JSON.stringify(CANONICAL_MANIFEST));

function isEvaluationDriver(value: unknown): value is EvaluationDriver {
  return isRecord(value) && typeof value['executeCase'] === 'function';
}

function optionalPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 512 || sanitizeText(value) !== value) invalidOptions();
  return value;
}

export function validateEvaluationOptions(data: unknown): RunEvaluationOptions {
  try {
    if (!isRecord(data) || (data['suite'] !== undefined && data['suite'] !== 'uc03')) invalidOptions();
    const mode = data['mode'];
    if (mode !== 'mock' && mode !== 'real') invalidOptions();

    const suite = data['suite'] ?? 'uc03';
    if (suite !== 'uc03') invalidOptions();
    let cases: readonly string[] | undefined;
    const rawCases = data['cases'];
    if (rawCases !== undefined) {
      if (!Array.isArray(rawCases)) invalidOptions();
      const seen = new Set<string>();
      const selected = rawCases.map((value: unknown): string => {
        if (!isEvaluationCaseId(value) || seen.has(value)) invalidOptions();
        seen.add(value);
        return value;
      });
      cases = selected;
    }

    const rawPatterns = data['customSecretPatterns'];
    let customSecretPatterns: readonly string[] | undefined;
    if (rawPatterns !== undefined) {
      if (!Array.isArray(rawPatterns) || rawPatterns.length > 32) invalidOptions();
      customSecretPatterns = rawPatterns.map((pattern: unknown): string => {
        if (typeof pattern !== 'string' || pattern.length === 0 || Buffer.byteLength(pattern, 'utf8') > 256) invalidOptions();
        return pattern;
      });
    }

    const driver = data['driver'];
    if (driver !== undefined && !isEvaluationDriver(driver)) invalidOptions();
    const mockPrivateGrading = data['mockPrivateGrading'];
    const manifestPath = optionalPath(data['manifestPath']);
    const configPath = optionalPath(data['configPath']);
    const outputPath = optionalPath(data['outputPath']);
    return {
      suite: 'uc03',
      mode,
      ...(manifestPath ? { manifestPath } : {}),
      ...(configPath ? { configPath } : {}),
      ...(outputPath ? { outputPath } : {}),
      ...(cases ? { cases } : {}),
      ...(driver ? { driver } : {}),
      ...(mockPrivateGrading !== undefined ? { mockPrivateGrading } : {}),
      ...(customSecretPatterns ? { customSecretPatterns } : {}),
    };
  } catch {
    return invalidOptions();
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function reportText(value: unknown, maxBytes: number): string {
  if (!validText(value, maxBytes)) invalidReport();
  return value;
}

function driverText(value: unknown, maxBytes: number, patterns: readonly string[]): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 8192) invalidDriverResult();
  return boundedText(value, maxBytes, patterns);
}

function identifier(value: unknown, patterns: readonly string[], driverInput: boolean): string {
  let result: string;
  if (driverInput) {
    if (typeof value !== 'string') invalidDriverResult();
    try {
      result = safeMetadata(value, 'evaluation identity', patterns);
    } catch {
      return invalidDriverResult();
    }
  } else {
    result = reportText(value, 128);
    try {
      safeMetadata(result, 'evaluation identity');
    } catch {
      return invalidReport();
    }
  }
  if (!ID.test(result)) return driverInput ? invalidDriverResult() : invalidReport();
  return result;
}

function numberValue(value: unknown, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) invalidReport();
  return value;
}

function parseCase(data: unknown, context: EvaluationCaseContext, patterns: readonly string[], driverInput: boolean): CaseResult {
  const fail = driverInput ? invalidDriverResult : invalidReport;
  if (!isRecord(data)) return fail();
  if (data['caseId'] !== context.spec.caseId || data['useCase'] !== 'UC-03') return fail();
  if (data['contractVersion'] !== UC03_CONTRACT_VERSION || data['mode'] !== context.mode) return fail();
  if (data['expectedOutcome'] !== context.spec.expectedOutcome) return fail();

  const status = data['status'];
  const actualOutcome = data['actualOutcome'];
  if (!isCaseStatus(status) || !isActualOutcome(actualOutcome)) return fail();
  if (status === 'pass' && actualOutcome !== context.spec.expectedOutcome) return fail();
  if (status === 'error' && actualOutcome !== 'DRIVER_ERROR' && actualOutcome !== 'DRIVER_RESULT_INVALID') return fail();
  if (status === 'not-run' && actualOutcome !== 'NOT_RUN' && actualOutcome !== 'REFUSED_BEFORE_DISPATCH') return fail();

  const timing = data['timing'];
  if (!isRecord(timing)) return fail();
  const startMs = numberValue(timing['startMs']);
  const endMs = numberValue(timing['endMs']);
  const durationMs = numberValue(timing['durationMs']);
  if (endMs < startMs || endMs - startMs !== durationMs) return fail();

  const usage = data['usage'];
  if (!isRecord(usage)) return fail();
  const tokensConsumed = numberValue(usage['tokensConsumed'], true);
  const costUsd = numberValue(usage['costUsd']);
  const replanCount = usage['replanCount'] === undefined ? undefined : numberValue(usage['replanCount'], true);
  const repairAttempts = usage['repairAttempts'] === undefined ? undefined : numberValue(usage['repairAttempts'], true);
  const reviewIterations = usage['reviewIterations'] === undefined ? undefined : numberValue(usage['reviewIterations'], true);

  const digests = data['digests'];
  if (!isRecord(digests) || !isDigest(digests['manifestDigest']) || !isDigest(digests['configDigest'])) return fail();
  if (digests['manifestDigest'] !== context.manifestDigest || digests['configDigest'] !== context.configDigest) return fail();
  for (const key of ['repositoryDigest', 'diffDigest', 'evidenceDigest']) {
    const value = digests[key];
    if (value !== undefined && !isDigest(value)) return fail();
  }

  const rawLimitations = data['limitations'];
  if (!Array.isArray(rawLimitations) || rawLimitations.length > 16) return fail();
  const limitations = rawLimitations.map((value: unknown): string => {
    if (driverInput) return driverText(value, 256, patterns);
    const text = reportText(value, 256);
    if (boundedText(text, 256) !== text) return invalidReport();
    return text;
  });

  const rawDenial = data['denialReason'];
  let denialReason: string | undefined;
  if (rawDenial !== undefined) {
    if (driverInput) denialReason = driverText(rawDenial, 256, patterns);
    else {
      denialReason = reportText(rawDenial, 256);
      if (boundedText(denialReason, 256) !== denialReason) invalidReport();
    }
  }

  const sideEffectObserved = data['sideEffectObserved'];
  if (typeof sideEffectObserved !== 'boolean' && !(status === 'error' && sideEffectObserved === null)) return fail();
  const rawTaskId = data['taskId'];
  const rawRunId = data['runId'];
  let taskId: string | null;
  let runId: string | null;
  if (driverInput || (rawTaskId !== null && rawRunId !== null)) {
    taskId = identifier(rawTaskId, patterns, driverInput);
    runId = identifier(rawRunId, patterns, driverInput);
  } else {
    if (rawTaskId !== null || rawRunId !== null || (status !== 'not-run' && status !== 'error')) return fail();
    taskId = null;
    runId = null;
  }
  return {
    caseId: context.spec.caseId,
    useCase: 'UC-03',
    contractVersion: UC03_CONTRACT_VERSION,
    taskId,
    runId,
    mode: context.mode,
    status,
    expectedOutcome: context.spec.expectedOutcome,
    actualOutcome,
    timing: { startMs, endMs, durationMs },
    usage: {
      tokensConsumed,
      costUsd,
      ...(replanCount !== undefined ? { replanCount } : {}),
      ...(repairAttempts !== undefined ? { repairAttempts } : {}),
      ...(reviewIterations !== undefined ? { reviewIterations } : {}),
    },
    digests: {
      manifestDigest: context.manifestDigest,
      configDigest: context.configDigest,
      ...(isDigest(digests['repositoryDigest']) ? { repositoryDigest: digests['repositoryDigest'] } : {}),
      ...(isDigest(digests['diffDigest']) ? { diffDigest: digests['diffDigest'] } : {}),
      ...(isDigest(digests['evidenceDigest']) ? { evidenceDigest: digests['evidenceDigest'] } : {}),
    },
    ...(denialReason !== undefined ? { denialReason } : {}),
    sideEffectObserved,
    limitations,
  };
}

export function validateDriverCaseResult(
  data: unknown,
  context: EvaluationCaseContext,
  customPatterns: readonly string[] = [],
): CaseResult {
  try {
    return parseCase(data, context, customPatterns, true);
  } catch {
    return invalidDriverResult();
  }
}

function parseEvaluationReport(data: unknown): EvaluationReport {
  if (!isRecord(data) || data['suite'] !== 'uc03') invalidReport();
  const mode = data['mode'];
  if (mode !== 'mock' && mode !== 'real') invalidReport();
  if (data['contractVersion'] !== UC03_CONTRACT_VERSION || data['isRealVerified'] !== false) invalidReport();
  if (!isDigest(data['manifestDigest']) || data['manifestDigest'] !== DEFAULT_MANIFEST_DIGEST || !isDigest(data['configDigest'])) invalidReport();
  const configDigest = data['configDigest'];

  const timestamp = reportText(data['timestamp'], 32);
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || new Date(timestampMs).toISOString() !== timestamp) invalidReport();
  const summary = parseSummary(data['summary']);
  if (!Array.isArray(data['cases']) || data['cases'].length !== CANONICAL_MANIFEST.cases.length) invalidReport();

  const cases = data['cases'].map((entry: unknown, index: number): CaseResult => {
    const spec = CANONICAL_MANIFEST.cases[index];
    if (!spec) invalidReport();
    const result = parseCase(entry, {
      spec,
      mode,
      manifestDigest: DEFAULT_MANIFEST_DIGEST,
      configDigest,
    }, [], false);
    if (result.caseId !== EVALUATION_CASE_IDS[index]) invalidReport();
    if (mode === 'real' && (result.status !== 'not-run' || result.actualOutcome !== 'REFUSED_BEFORE_DISPATCH')) invalidReport();
    if (mode === 'mock' && result.caseId === 'C17' && (result.status !== 'not-run' || result.actualOutcome !== 'NOT_RUN' || !result.limitations.includes(C17_NOT_RUN_LIMITATION))) invalidReport();
    return result;
  });
  const identities = new Set<string>();
  for (const result of cases) {
    if (result.taskId === null || result.runId === null) continue;
    const identity = `${result.taskId}\u0000${result.runId}`;
    if (identities.has(identity)) invalidReport();
    identities.add(identity);
  }

  const expectedSummary = summarizeCases(cases, CANONICAL_MANIFEST);
  if (JSON.stringify(summary) !== JSON.stringify(expectedSummary)) invalidReport();
  const verdict = data['verdict'];
  const exitCode = data['exitCode'];
  const expectedVerdict = mode === 'real' ? 'REFUSED' : summary.requiredFailuresOrNotRun > 0 ? 'FAIL' : 'PASS';
  const expectedExitCode = expectedVerdict === 'PASS' ? 0 : 1;
  if (verdict !== expectedVerdict || exitCode !== expectedExitCode) invalidReport();

  if (!Array.isArray(data['limitations']) || data['limitations'].length > 16) invalidReport();
  const limitations = data['limitations'].map((value: unknown): string => {
    const text = reportText(value, 256);
    if (boundedText(text, 256) !== text) invalidReport();
    return text;
  });
  if (!limitations.includes(C17_NOT_RUN_LIMITATION)) invalidReport();

  return {
    suite: 'uc03',
    contractVersion: UC03_CONTRACT_VERSION,
    mode,
    manifestDigest: DEFAULT_MANIFEST_DIGEST,
    configDigest,
    timestamp,
    isRealVerified: false,
    verdict: expectedVerdict,
    exitCode: expectedExitCode,
    summary,
    cases,
    limitations,
  };
}

export function validateEvaluationReport(data: unknown): EvaluationReport {
  try {
    return parseEvaluationReport(data);
  } catch {
    return invalidReport();
  }
}

