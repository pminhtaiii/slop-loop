import { sanitizeText } from '../../src/foundation/telemetry.ts';
import { boundedText } from '../../src/uc03/report/sanitize.ts';
import { exitCodeFor, suiteAcceptanceFor } from './results.ts';
import {
  EVALUATION_CASE_IDS,
  WORKFLOW_EVALUATION_VERSION,
  type EvaluationCaseId,
  type EvaluationOutcome,
  type WorkflowBlock,
  type WorkflowCaseResult,
  type WorkflowDriver,
  type WorkflowEffects,
  type WorkflowEvaluationOptions,
  type WorkflowEvaluationReport,
  type WorkflowGrade,
  type WorkflowLifecycle,
  type WorkflowObservation,
  type WorkflowReason,
  type WorkflowTier,
  type WorkflowUsage,
  type WorkflowWait,
} from './types.ts';
import { OUTCOMES, invalidWorkflow, invalidWorkflowOptions, isEvaluationCaseId, isRecord, reportText, validText } from './validation-primitives.ts';
import { DEFAULT_MANIFEST_DIGEST } from './validation-legacy.ts';

export { invalidWorkflow, invalidWorkflowOptions } from './validation-primitives.ts';

const WORKFLOW_LIFECYCLES = new Set<string>([...OUTCOMES, 'waiting-approval', 'waiting-info', 'not-observed']);
const WORKFLOW_EFFECTS = new Set<string>(['none', 'observed', 'uncertain']);
const WORKFLOW_USAGES = new Set<string>(['observed', 'uncertain', 'unavailable']);
const WORKFLOW_GRADES = new Set<string>(['pass', 'fail', 'not-run']);
const WORKFLOW_WAITS = new Set<string>(['waiting-approval', 'waiting-info']);
const WORKFLOW_BLOCKS = new Set<string>(['prerequisite-unavailable', 'busy', 'reconciliation-required']);
const WORKFLOW_REASONS = new Set<string>([
  'criteria-satisfied',
  'expected-wait-satisfied',
  'criteria-violation',
  'unresolved-wait',
  'unpinned-criteria',
  'real-execution-unavailable',
  'driver-unavailable',
  'invalid-observation',
  'not-selected',
  'private-grading',
  ...WORKFLOW_BLOCKS,
]);
const WORKFLOW_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WORKFLOW_DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/u;
/** Every reason that leaves a case without a verdict, including blocks (never dispatched); a graded case must never carry one. */
const NOT_RUN_REASONS = new Set<string>([
  'unpinned-criteria',
  'unresolved-wait',
  'real-execution-unavailable',
  'driver-unavailable',
  'invalid-observation',
  'not-selected',
  'private-grading',
  ...WORKFLOW_BLOCKS,
]);

function workflowIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !WORKFLOW_IDENTIFIER.test(value) || sanitizeText(value) !== value) invalidWorkflow();
  return value;
}

function workflowDigest(value: unknown): string {
  if (typeof value !== 'string' || !WORKFLOW_DIGEST.test(value)) invalidWorkflow();
  return value;
}

function workflowText(value: unknown, maxBytes: number): string {
  if (!validText(value, maxBytes) || boundedText(value, maxBytes) !== value) invalidWorkflow();
  return value;
}

function workflowList(value: unknown, max: number, item: (entry: unknown, index: number) => string): readonly string[] {
  if (!Array.isArray(value) || value.length > max) invalidWorkflow();
  return value.map(item);
}

const observationKeys = [
  'repositoryId',
  'taskId',
  'runId',
  'returnedModel',
  'graderDigest',
  'initialRepositoryDigest',
  'workflowOutcome',
  'expectedWait',
  'blocked',
  'effects',
  'usage',
  'diagnostic',
  'artifacts',
  'limitations',
] as const;

function optionalIdentifier(value: unknown): string | null {
  return value === null ? null : workflowIdentifier(value);
}

/** Validates host-held driver output. Ports, credentials and grader payloads are rejected by exact-key enumeration. */
export function validateWorkflowObservation(data: unknown): WorkflowObservation {
  if (!isRecord(data) || Reflect.ownKeys(data).length !== observationKeys.length) invalidWorkflow();
  for (const key of observationKeys) if (!Object.hasOwn(data, key)) invalidWorkflow();
  const workflowOutcome = data['workflowOutcome'];
  const expectedWait = data['expectedWait'];
  const blocked = data['blocked'];
  const effects = data['effects'];
  const usage = data['usage'];
  if (typeof workflowOutcome !== 'string' || !WORKFLOW_LIFECYCLES.has(workflowOutcome)) invalidWorkflow();
  if (expectedWait !== null && (typeof expectedWait !== 'string' || !WORKFLOW_WAITS.has(expectedWait))) invalidWorkflow();
  if (blocked !== null && (typeof blocked !== 'string' || !WORKFLOW_BLOCKS.has(blocked))) invalidWorkflow();
  if (typeof effects !== 'string' || !WORKFLOW_EFFECTS.has(effects) || typeof usage !== 'string' || !WORKFLOW_USAGES.has(usage)) invalidWorkflow();
  return {
    repositoryId: optionalIdentifier(data['repositoryId']),
    taskId: optionalIdentifier(data['taskId']),
    runId: optionalIdentifier(data['runId']),
    returnedModel: optionalIdentifier(data['returnedModel']),
    graderDigest: data['graderDigest'] === null ? null : workflowDigest(data['graderDigest']),
    initialRepositoryDigest: data['initialRepositoryDigest'] === null ? null : workflowDigest(data['initialRepositoryDigest']),
    workflowOutcome: workflowOutcome as WorkflowLifecycle,
    expectedWait: expectedWait as WorkflowWait | null,
    blocked: blocked as WorkflowBlock | null,
    effects: effects as WorkflowEffects,
    usage: usage as WorkflowUsage,
    diagnostic: data['diagnostic'] === null ? null : workflowText(data['diagnostic'], 512),
    artifacts: workflowList(data['artifacts'], 16, entry => workflowText(entry, 256)),
    limitations: workflowList(data['limitations'], 16, entry => workflowText(entry, 256)),
  };
}

const workflowOptionKeys = new Set([
  'contractVersion',
  'suite',
  'mode',
  'scope',
  'cases',
  'profileDigest',
  'configDigest',
  'pricingDigest',
  'adapterVersions',
  'requestedModel',
  'realAdmission',
  'driver',
  'timestamp',
]);

function isWorkflowDriver(value: unknown): value is WorkflowDriver {
  return isRecord(value) && typeof value['executeCase'] === 'function';
}

function workflowDriver(value: unknown): WorkflowDriver | undefined {
  if (value === undefined) return undefined;
  if (!isWorkflowDriver(value)) invalidWorkflowOptions();
  return value;
}

export function validateWorkflowEvaluationOptions(data: unknown): WorkflowEvaluationOptions {
  if (!isRecord(data) || Reflect.ownKeys(data).some(key => typeof key !== 'string' || !workflowOptionKeys.has(key))) invalidWorkflowOptions();
  if (data['contractVersion'] !== WORKFLOW_EVALUATION_VERSION || (data['suite'] !== undefined && data['suite'] !== 'uc03')) invalidWorkflowOptions();
  const mode = data['mode'];
  if (mode !== 'mock' && mode !== 'real') invalidWorkflowOptions();
  const scope = data['scope'];
  if (scope !== undefined && scope !== 'catalog' && scope !== 'exploratory') invalidWorkflowOptions();
  // Exploratory scope pins no criteria, so a real tier there would grade nothing.
  if (scope === 'exploratory' && mode === 'real') invalidWorkflowOptions();
  let cases: readonly EvaluationCaseId[] | undefined;
  if (data['cases'] !== undefined) {
    if (!Array.isArray(data['cases']) || data['cases'].length === 0 || new Set(data['cases']).size !== data['cases'].length) invalidWorkflowOptions();
    cases = data['cases'].map((value: unknown): EvaluationCaseId => {
      if (!isEvaluationCaseId(value)) invalidWorkflowOptions();
      return value;
    });
  }
  const digestField = (key: string): string => {
    const value = data[key];
    if (typeof value !== 'string' || !WORKFLOW_DIGEST.test(value)) invalidWorkflowOptions();
    return value;
  };
  const adapterVersions = data['adapterVersions'];
  if (!Array.isArray(adapterVersions) || adapterVersions.length === 0 || adapterVersions.length > 16) invalidWorkflowOptions();
  const requestedModel = data['requestedModel'];
  if (typeof requestedModel !== 'string' || !validText(requestedModel, 128)) invalidWorkflowOptions();
  const rawAdmission = data['realAdmission'];
  let realAdmission: WorkflowEvaluationOptions['realAdmission'];
  if (rawAdmission !== undefined) {
    // Shape only, and the original object is kept: authority comes from the in-process receipt registry by identity.
    if (!isRecord(rawAdmission) || Reflect.ownKeys(rawAdmission).length !== 3) invalidWorkflowOptions();
    if (typeof rawAdmission['admissionId'] !== 'string' || !/^[a-f0-9]{64}$/u.test(rawAdmission['admissionId'])) invalidWorkflowOptions();
    realAdmission = rawAdmission as unknown as WorkflowEvaluationOptions['realAdmission'];
  }
  const driver = workflowDriver(data['driver']);
  const timestamp = data['timestamp'];
  if (timestamp !== undefined && (typeof timestamp !== 'string' || new Date(timestamp).toISOString() !== timestamp)) invalidWorkflowOptions();
  return {
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    suite: 'uc03',
    mode,
    scope: scope ?? 'catalog',
    ...(cases !== undefined ? { cases } : {}),
    profileDigest: digestField('profileDigest'),
    configDigest: digestField('configDigest'),
    pricingDigest: digestField('pricingDigest'),
    adapterVersions: adapterVersions.map((value: unknown): string => {
      // Same vocabulary as the report validator, so an unsupported version is refused before dispatch.
      if (typeof value !== 'string' || !WORKFLOW_IDENTIFIER.test(value) || sanitizeText(value) !== value) invalidWorkflowOptions();
      return value;
    }),
    requestedModel,
    ...(realAdmission !== undefined ? { realAdmission } : {}),
    ...(driver !== undefined ? { driver } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

const workflowCaseKeys = [
  'caseId',
  'repositoryId',
  'taskId',
  'runId',
  'requestedModel',
  'returnedModel',
  'tier',
  'profileDigest',
  'configDigest',
  'pricingDigest',
  'adapterVersions',
  'graderDigest',
  'initialRepositoryDigest',
  'workflowOutcome',
  'expectedOutcome',
  'grade',
  'gradeReason',
  'effects',
  'usage',
  'diagnostic',
  'artifacts',
  'limitations',
] as const;

function parseWorkflowCase(entry: unknown, tier: WorkflowTier, configDigest: string): WorkflowCaseResult {
  if (!isRecord(entry) || Reflect.ownKeys(entry).length !== workflowCaseKeys.length) invalidWorkflow();
  const caseId = entry['caseId'];
  if (!isEvaluationCaseId(caseId) || entry['tier'] !== tier || entry['configDigest'] !== configDigest) invalidWorkflow();
  const workflowOutcome = entry['workflowOutcome'];
  const grade = entry['grade'];
  const gradeReason = entry['gradeReason'];
  const effects = entry['effects'];
  const usage = entry['usage'];
  if (typeof workflowOutcome !== 'string' || !WORKFLOW_LIFECYCLES.has(workflowOutcome)) invalidWorkflow();
  // The pinned expectation is the only per-case criteria identity a report carries.
  if (typeof entry['expectedOutcome'] !== 'string' || !OUTCOMES.has(entry['expectedOutcome'])) invalidWorkflow();
  if (typeof grade !== 'string' || !WORKFLOW_GRADES.has(grade)) invalidWorkflow();
  if (typeof gradeReason !== 'string' || !WORKFLOW_REASONS.has(gradeReason)) invalidWorkflow();
  if (typeof effects !== 'string' || !WORKFLOW_EFFECTS.has(effects) || typeof usage !== 'string' || !WORKFLOW_USAGES.has(usage)) invalidWorkflow();
  // An unobserved workflow can never be graded; a not-run grade always names a reason for having no verdict.
  if (workflowOutcome === 'not-observed' && grade !== 'not-run') invalidWorkflow();
  if ((grade === 'not-run') !== NOT_RUN_REASONS.has(gradeReason)) invalidWorkflow();
  const adapterVersions = entry['adapterVersions'];
  if (!Array.isArray(adapterVersions) || adapterVersions.length > 16) invalidWorkflow();
  const requestedModel = entry['requestedModel'];
  if (typeof requestedModel !== 'string' || (requestedModel.length > 0 && !validText(requestedModel, 128))) invalidWorkflow();
  if (!WORKFLOW_DIGEST.test(String(entry['profileDigest'])) || !WORKFLOW_DIGEST.test(String(entry['pricingDigest']))) invalidWorkflow();
  return {
    caseId,
    repositoryId: optionalIdentifier(entry['repositoryId']),
    taskId: optionalIdentifier(entry['taskId']),
    runId: optionalIdentifier(entry['runId']),
    requestedModel,
    returnedModel: optionalIdentifier(entry['returnedModel']),
    tier,
    profileDigest: String(entry['profileDigest']),
    configDigest,
    pricingDigest: String(entry['pricingDigest']),
    adapterVersions: adapterVersions.map((value: unknown): string => workflowIdentifier(value)),
    graderDigest: entry['graderDigest'] === null ? null : workflowDigest(entry['graderDigest']),
    initialRepositoryDigest: entry['initialRepositoryDigest'] === null ? null : workflowDigest(entry['initialRepositoryDigest']),
    workflowOutcome: workflowOutcome as WorkflowLifecycle,
    expectedOutcome: entry['expectedOutcome'] as EvaluationOutcome,
    grade: grade as WorkflowGrade,
    gradeReason: gradeReason as WorkflowReason,
    effects: effects as WorkflowEffects,
    usage: usage as WorkflowUsage,
    diagnostic: entry['diagnostic'] === null ? null : workflowText(entry['diagnostic'], 512),
    artifacts: workflowList(entry['artifacts'], 16, value => workflowText(value, 256)),
    limitations: workflowList(entry['limitations'], 16, value => workflowText(value, 256)),
  };
}

/** Rejects an inconsistent report: counts, acceptance and exit code are re-derived, never trusted from the payload. */
function parseWorkflowEvaluationReport(data: unknown): WorkflowEvaluationReport {
  if (!isRecord(data) || data['suite'] !== 'uc03' || data['contractVersion'] !== WORKFLOW_EVALUATION_VERSION) invalidWorkflow();
  const mode = data['mode'];
  const tier = data['tier'];
  if ((mode !== 'mock' && mode !== 'real') || (tier !== 'controlled' && tier !== 'real-integration')) invalidWorkflow();
  if ((mode === 'mock') !== (tier === 'controlled')) invalidWorkflow();
  // Same digest vocabulary as the options: a caller-supplied digest may carry the sha256: prefix or be bare hex.
  if (data['isRealVerified'] !== false || data['manifestDigest'] !== DEFAULT_MANIFEST_DIGEST) invalidWorkflow();
  const configDigest = workflowDigest(data['configDigest']);
  const timestamp = reportText(data['timestamp'], 32);
  if (new Date(Date.parse(timestamp)).toISOString() !== timestamp) invalidWorkflow();
  if (!Array.isArray(data['cases']) || data['cases'].length === 0 || data['cases'].length > EVALUATION_CASE_IDS.length) invalidWorkflow();
  const cases = data['cases'].map((entry: unknown): WorkflowCaseResult => parseWorkflowCase(entry, tier, configDigest));
  if (new Set(cases.map(item => item.caseId)).size !== cases.length) invalidWorkflow();

  const selection = data['selectionResult'];
  const acceptance = data['suiteAcceptance'];
  if (!isRecord(selection) || !isRecord(acceptance)) invalidWorkflow();
  const passed = cases.filter(item => item.grade === 'pass').length;
  const failed = cases.filter(item => item.grade === 'fail').length;
  const incomplete = cases.filter(item => item.grade === 'not-run').length;
  const pendingWaits = cases.filter(item => item.gradeReason === 'unresolved-wait').map(item => item.caseId);
  const outcome = failed > 0 ? 'fail' : incomplete > 0 || pendingWaits.length > 0 ? 'incomplete' : 'pass';
  if (
    JSON.stringify(selection['selected']) !== JSON.stringify(cases.map(item => item.caseId)) ||
    selection['passed'] !== passed ||
    selection['failed'] !== failed ||
    selection['incomplete'] !== incomplete ||
    JSON.stringify(selection['pendingWaits']) !== JSON.stringify(pendingWaits) ||
    selection['outcome'] !== outcome
  )
    invalidWorkflow();
  const scope = acceptance['scope'];
  if (scope !== 'catalog' && scope !== 'exploratory') invalidWorkflow();
  if (JSON.stringify(acceptance) !== JSON.stringify(suiteAcceptanceFor(scope, passed, outcome))) invalidWorkflow();
  // Exploratory sources pin no criteria: every case stays ungraded and no acceptance can be claimed.
  if (scope === 'exploratory' && cases.some(item => item.grade !== 'not-run' || item.gradeReason !== 'unpinned-criteria')) invalidWorkflow();
  if (data['exitCode'] !== exitCodeFor(outcome, cases)) invalidWorkflow();

  const limitations = workflowList(data['limitations'], 16, value => workflowText(value, 256));
  return {
    suite: 'uc03',
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    mode,
    tier,
    manifestDigest: DEFAULT_MANIFEST_DIGEST,
    configDigest,
    timestamp,
    isRealVerified: false,
    selectionResult: { selected: cases.map(item => item.caseId), passed, failed, incomplete, pendingWaits, outcome },
    suiteAcceptance: suiteAcceptanceFor(scope, passed, outcome),
    exitCode: exitCodeFor(outcome, cases),
    cases,
    limitations,
  };
}

export function validateWorkflowEvaluationReport(data: unknown): WorkflowEvaluationReport {
  return parseWorkflowEvaluationReport(data);
}
