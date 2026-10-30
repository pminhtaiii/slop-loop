import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runRegisteredEvaluation, SHARED_EVALUATION_VERSION, type SharedEvaluationOptions, type SharedEvaluationReport } from '../shared.ts';
export { registerEvaluation, SHARED_EVALUATION_VERSION } from '../shared.ts';
export type { SharedEvaluationOptions, SharedEvaluationReport, RegisteredEvaluation, SharedSelection, SharedCaseResult } from '../shared.ts';
import defaultManifest from './manifest.json' with { type: 'json' };
import {
  computeSha256,
  validateEvaluationManifest,
  validateEvaluationOptions,
  validateEvaluationReport,
  validateDriverCaseResult,
} from './validation.ts';
import {
  createEvaluationReport,
  driverErrorCase,
  notRunCase,
} from './results.ts';
import { executeMockPrivateGrading } from './grading.ts';
import type {
  EvaluationCaseContext,
  EvaluationDriverContext,
  EvaluationReport,
  RunEvaluationOptions,
} from './types.ts';

export {
  computeSha256,
  validateEvaluationManifest,
  validateEvaluationOptions,
  validateEvaluationReport,
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
} from './types.ts';

const DEFAULT_CONFIG_DIGEST = computeSha256('uc03-config-unconfigured');

function readManifest(options: RunEvaluationOptions): string {
  const manifestPath = options.manifestPath
    ? resolve(options.manifestPath)
    : fileURLToPath(new URL('./manifest.json', import.meta.url));
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

function caseContext(
  spec: EvaluationCaseContext['spec'],
  mode: EvaluationCaseContext['mode'],
  manifestDigest: string,
  configDigest: string,
): EvaluationCaseContext {
  return { spec, mode, manifestDigest, configDigest };
}

function driverContext(context: EvaluationCaseContext): EvaluationDriverContext {
  // Never forward RunEvaluationOptions across the coder/task-container boundary.
  return { ...context, suite: 'uc03' };
}

export function runEvaluation(options: SharedEvaluationOptions): Promise<SharedEvaluationReport>;
export function runEvaluation(options: unknown): Promise<EvaluationReport>;
export async function runEvaluation(options: unknown): Promise<EvaluationReport | SharedEvaluationReport> {
  if (options && typeof options === 'object'
    && Object.getOwnPropertyDescriptor(options, 'contractVersion')?.value === SHARED_EVALUATION_VERSION) {
    return runRegisteredEvaluation(options);
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
  const selected = new Set(request.cases ?? manifest.cases.map((item) => item.caseId));
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

  const report = validateEvaluationReport(createEvaluationReport({
    mode: request.mode,
    manifest,
    manifestDigest,
    configDigest,
    timestamp,
    cases,
    hasDriver: request.driver !== undefined,
  }));
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
    const cases = values.cases === undefined
      ? undefined
      : values.cases.trim().length === 0
        ? []
        : values.cases.split(',').map((value) => value.trim());
    const request: unknown = {
      suite: values.suite,
      mode: values.mode,
      ...(values.config ? { configPath: values.config } : {}),
      ...(values.manifest ? { manifestPath: values.manifest } : {}),
      ...(values.output ? { outputPath: values.output } : {}),
      ...(cases !== undefined ? { cases } : {}),
    };
    const report = await runEvaluation(request);
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
