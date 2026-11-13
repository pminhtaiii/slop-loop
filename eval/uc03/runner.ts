import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runRegisteredEvaluation, isAdmittedRealExecutionAdmission, SHARED_EVALUATION_VERSION, type SharedEvaluationOptions, type SharedEvaluationReport } from '../shared.ts';
export { registerEvaluation, issueRealExecutionAdmission, isAdmittedRealExecutionAdmission, SHARED_EVALUATION_VERSION } from '../shared.ts';
export type { SharedEvaluationOptions, SharedEvaluationReport, RegisteredEvaluation, RealExecutionAdmission, RealExecutionBinding, SharedSelection, SharedCaseResult } from '../shared.ts';
import defaultManifest from './manifest.json' with { type: 'json' };
import {
  DEFAULT_MANIFEST_DIGEST,
  computeSha256,
  validateEvaluationManifest,
  validateEvaluationOptions,
  validateEvaluationReport,
  validateDriverCaseResult,
  validateWorkflowEvaluationOptions,
  validateWorkflowEvaluationReport,
  validateWorkflowObservation,
} from './validation.ts';
import { createEvaluationReport, createWorkflowEvaluationReport, driverErrorCase, notRunCase, notRunWorkflowCase, workflowCaseResult } from './results.ts';
import { workflowEvidenceDecision } from './workflow-evidence.ts';
import { executeMockPrivateGrading } from './grading.ts';
import {
  C17_NOT_RUN_LIMITATION,
  WORKFLOW_EVALUATION_VERSION,
  type EvaluationCaseContext,
  type EvaluationDriverContext,
  type EvaluationReport,
  type RunEvaluationOptions,
  type WorkflowBinding,
  type WorkflowCaseContext,
  type WorkflowCaseResult,
  type WorkflowEvaluationOptions,
  type WorkflowEvaluationReport,
} from './types.ts';

export {
  computeSha256,
  validateEvaluationManifest,
  validateEvaluationOptions,
  validateEvaluationReport,
  validateWorkflowEvaluationOptions,
  validateWorkflowEvaluationReport,
  validateWorkflowObservation,
} from './validation.ts';
export { executeMockPrivateGrading } from './grading.ts';
export type {
  ActualOutcome,
  CaseDigests,
  CaseResult,
  CaseStatus,
  CaseTiming,
  CaseUsage,
  EvaluationCaseId,
  EvaluationCaseSpec,
  EvaluationDriver,
  EvaluationDriverContext,
  EvaluationGraderExecutionRequest,
  EvaluationGraderExecutor,
  EvaluationGradingAdmission,
  EvaluationGradingAdmissionRequest,
  EvaluationGradingBounds,
  EvaluationGradingProfile,
  EvaluationIsolationAuthority,
  EvaluationManifest,
  EvaluationMode,
  EvaluationOutcome,
  EvaluationReport,
  EvaluationSnapshotIdentity,
  MockPrivateGradingBoundary,
  EvaluationSummary,
  SafeEvaluationGradingResult,
  RunEvaluationOptions,
  WorkflowBinding,
  WorkflowBlock,
  WorkflowCaseContext,
  WorkflowCaseResult,
  WorkflowEffects,
  WorkflowEvaluationOptions,
  WorkflowEvaluationReport,
  WorkflowGrade,
  WorkflowLifecycle,
  WorkflowObservation,
  WorkflowReason,
  WorkflowSelectionResult,
  WorkflowSuiteAcceptance,
  WorkflowTier,
  WorkflowUsage,
  WorkflowWait,
} from './types.ts';

const DEFAULT_CONFIG_DIGEST = computeSha256('uc03-config-unconfigured');

function readManifest(options: RunEvaluationOptions): string {
  const manifestPath = options.manifestPath ? resolve(options.manifestPath) : fileURLToPath(new URL('./manifest.json', import.meta.url));
  if (!existsSync(manifestPath)) {
    if (options.manifestPath) throw new Error('Evaluation manifest not found');
    return JSON.stringify(defaultManifest);
  }
  try {
    return readFileSync(manifestPath, 'utf8');
  } catch {
    throw new Error('Evaluation manifest could not be read');
  }
}

function readConfigDigest(options: RunEvaluationOptions): string {
  if (options.mode === 'real' || !options.configPath) return DEFAULT_CONFIG_DIGEST;
  const configPath = resolve(options.configPath);
  if (!existsSync(configPath)) throw new Error('Evaluation configuration not found');
  try {
    return computeSha256(readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error('Evaluation configuration could not be read');
  }
}

function writeReport(outputPath: string | undefined, report: EvaluationReport): void {
  if (!outputPath) return;
  try {
    writeFileSync(resolve(outputPath), JSON.stringify(report, null, 2), 'utf8');
  } catch {
    throw new Error('Evaluation report could not be written');
  }
}

function caseContext(spec: EvaluationCaseContext['spec'], mode: EvaluationCaseContext['mode'], manifestDigest: string, configDigest: string): EvaluationCaseContext {
  return { spec, mode, manifestDigest, configDigest };
}

function driverContext(context: EvaluationCaseContext): EvaluationDriverContext {
  // Never forward RunEvaluationOptions across the coder/task-container boundary.
  return { ...context, suite: 'uc03' };
}

/** Real dispatch needs an internally issued receipt bound to exactly this run; nothing caller-built admits it. */
async function runWorkflowEvaluation(options: unknown): Promise<WorkflowEvaluationReport> {
  const request = validateWorkflowEvaluationOptions(options);
  const manifest = validateEvaluationManifest(defaultManifest);
  const scope = request.scope ?? 'catalog';
  const selected = new Set(request.cases ?? manifest.cases.map(item => item.caseId));
  const binding: WorkflowBinding = {
    tier: request.mode === 'real' ? 'real-integration' : 'controlled',
    profileDigest: request.profileDigest,
    configDigest: request.configDigest,
    pricingDigest: request.pricingDigest,
    adapterVersions: request.adapterVersions,
    requestedModel: request.requestedModel,
  };
  const admitted =
    request.mode === 'real' && isAdmittedRealExecutionAdmission(request.realAdmission, { ...binding, caseIds: manifest.cases.filter(item => selected.has(item.caseId)).map(item => item.caseId) });
  const cases: WorkflowCaseResult[] = [];

  // Unselected cases stay out of the report: selectionResult judges the selection, suiteAcceptance judges the catalog.
  for (const spec of manifest.cases.filter(item => selected.has(item.caseId))) {
    if (scope === 'exploratory') {
      cases.push(notRunWorkflowCase(spec, 'unpinned-criteria', 'Exploratory scope pins no criteria; the case is not graded.', binding));
    } else if (request.mode === 'real' && !admitted) {
      cases.push(notRunWorkflowCase(spec, 'real-execution-unavailable', 'Real execution was refused before dispatch: no valid capability receipt.', binding));
    } else if (spec.caseId === 'C17') {
      cases.push(notRunWorkflowCase(spec, 'private-grading', C17_NOT_RUN_LIMITATION, binding));
    } else if (!request.driver) {
      cases.push(notRunWorkflowCase(spec, 'driver-unavailable', 'No workflow case driver is configured.', binding));
    } else {
      const context: WorkflowCaseContext = { spec, mode: request.mode, manifestDigest: DEFAULT_MANIFEST_DIGEST, ...binding };
      let observation: unknown;
      try {
        observation = await request.driver.executeCase(spec, context);
      } catch {
        observation = undefined;
      }
      if (observation === undefined) {
        cases.push(notRunWorkflowCase(spec, 'invalid-observation', 'Workflow driver threw or returned nothing.', binding));
        continue;
      }
      try {
        const independentGrade = workflowEvidenceDecision(observation);
        cases.push(workflowCaseResult(spec, validateWorkflowObservation(observation), binding, independentGrade));
      } catch {
        cases.push(notRunWorkflowCase(spec, 'invalid-observation', 'Workflow driver returned an invalid observation.', binding));
      }
    }
  }

  return validateWorkflowEvaluationReport(
    createWorkflowEvaluationReport({
      mode: request.mode,
      binding,
      scope,
      manifestDigest: DEFAULT_MANIFEST_DIGEST,
      timestamp: request.timestamp ?? new Date().toISOString(),
      cases,
      limitations: [
        request.mode === 'real'
          ? 'Real results are not verified: no real execution evidence is established.'
          : 'Controlled-tier observations exercise the harness only; they do not establish workflow evidence.',
        C17_NOT_RUN_LIMITATION,
      ],
    }),
  );
}

export function runEvaluation(options: SharedEvaluationOptions): Promise<SharedEvaluationReport>;
export function runEvaluation(options: WorkflowEvaluationOptions): Promise<WorkflowEvaluationReport>;
export function runEvaluation(options: RunEvaluationOptions): Promise<EvaluationReport>;
export function runEvaluation(options: RunEvaluationOptions | SharedEvaluationOptions): Promise<EvaluationReport | SharedEvaluationReport>;
export function runEvaluation(options: unknown): Promise<EvaluationReport | SharedEvaluationReport | WorkflowEvaluationReport>;
export async function runEvaluation(options: unknown): Promise<EvaluationReport | SharedEvaluationReport | WorkflowEvaluationReport> {
  if (options && typeof options === 'object' && Object.getOwnPropertyDescriptor(options, 'contractVersion')?.value === SHARED_EVALUATION_VERSION) {
    return runRegisteredEvaluation(options);
  }
  // Tag dispatch before legacy validation: legacy options never reject an unknown contractVersion.
  if (options && typeof options === 'object' && Object.getOwnPropertyDescriptor(options, 'contractVersion')?.value === WORKFLOW_EVALUATION_VERSION) {
    return runWorkflowEvaluation(options);
  }
  const request = validateEvaluationOptions(options);
  const parsedManifest: unknown = (() => {
    try {
      return JSON.parse(readManifest(request));
    } catch {
      throw new Error('Evaluation manifest is invalid');
    }
  })();
  const manifest = validateEvaluationManifest(parsedManifest);
  const manifestDigest = computeSha256(JSON.stringify(manifest));
  const configDigest = readConfigDigest(request);
  const timestamp = new Date().toISOString();
  const selected = new Set(request.cases ?? manifest.cases.map(item => item.caseId));
  const patterns = request.customSecretPatterns ?? [];
  const cases = [];

  for (const spec of manifest.cases) {
    const context = caseContext(spec, request.mode, manifestDigest, configDigest);
    if (request.mode === 'real') {
      cases.push(notRunCase(context, 'real-refused'));
    } else if (!selected.has(spec.caseId)) {
      cases.push(notRunCase(context, 'not-selected'));
    } else if (spec.caseId === 'C17') {
      const gradingResult = await executeMockPrivateGrading(request.mockPrivateGrading);
      cases.push(notRunCase(context, gradingResult ? 'mock-grading-exercised' : 'private-grading'));
    } else if (!request.driver) {
      cases.push(notRunCase(context, 'no-driver'));
    } else {
      let rawResult: unknown;
      try {
        rawResult = await request.driver.executeCase(spec, driverContext(context));
      } catch {
        cases.push(driverErrorCase(context, 'driver-threw'));
        continue;
      }
      try {
        cases.push(validateDriverCaseResult(rawResult, context, patterns));
      } catch {
        cases.push(driverErrorCase(context, 'invalid-result'));
      }
    }
  }

  const report = validateEvaluationReport(
    createEvaluationReport({
      mode: request.mode,
      manifest,
      manifestDigest,
      configDigest,
      timestamp,
      cases,
      hasDriver: request.driver !== undefined,
    }),
  );
  writeReport(request.outputPath, report);
  return report;
}

export async function main(): Promise<void> {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        suite: { type: 'string', default: 'uc03' },
        mode: { type: 'string', default: 'real' },
        config: { type: 'string' },
        manifest: { type: 'string' },
        output: { type: 'string' },
        cases: { type: 'string' },
      },
      allowPositionals: false,
    });
    const cases = values.cases === undefined ? undefined : values.cases.trim().length === 0 ? [] : values.cases.split(',').map(value => value.trim());
    const request: unknown = {
      suite: values.suite,
      mode: values.mode,
      ...(values.config ? { configPath: values.config } : {}),
      ...(values.manifest ? { manifestPath: values.manifest } : {}),
      ...(values.output ? { outputPath: values.output } : {}),
      ...(cases !== undefined ? { cases } : {}),
    };
    const report = await runEvaluation(request);
    if ('selectionResult' in report) {
      console.log(`UC-03 Workflow Evaluation [${report.mode.toUpperCase()}]: Selected = ${report.selectionResult.outcome}, Suite = ${report.suiteAcceptance.outcome}, ExitCode = ${report.exitCode}`);
      process.exitCode = report.exitCode;
      return;
    }
    if (!('verdict' in report)) throw new Error('Evaluation report required');
    console.log(`UC-03 Evaluation [${report.mode.toUpperCase()}]: Verdict = ${report.verdict}, ExitCode = ${report.exitCode}`);
    console.log(`Cases: ${report.summary.passedCases}/${report.summary.totalCases} passed, ${report.summary.requiredFailuresOrNotRun} required failures/not-run`);
    process.exitCode = report.exitCode;
  } catch {
    console.error('UC-03 evaluation refused: invalid input or unavailable local artifact.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
