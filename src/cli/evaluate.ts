/** Operator CLI over the uc03 workflow evaluation. Trusted binding comes from the host, never argv. */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvaluation } from '../../eval/uc03/runner.ts';
import type { RealExecutionAdmission } from '../../eval/shared-types.ts';
import { WORKFLOW_EVALUATION_VERSION, type WorkflowDriver, type WorkflowEvaluationOptions, type WorkflowEvaluationReport } from '../../eval/uc03/types.ts';

export interface EvaluateCliResult {
  readonly exitCode: number;
  readonly output: string;
}

/** Host-supplied authority. Digests, adapter versions, model and driver never come from argv. */
export interface EvaluateCliOptions {
  readonly profileDigest: string;
  readonly configDigest: string;
  readonly pricingDigest: string;
  readonly adapterVersions: readonly string[];
  readonly requestedModel: string;
  readonly realAdmission?: RealExecutionAdmission | undefined;
  readonly driver?: WorkflowDriver | undefined;
}

interface ParsedArgs {
  readonly mode: 'mock' | 'real';
  readonly scope?: 'catalog' | 'exploratory' | undefined;
  readonly cases?: readonly string[] | undefined;
  readonly outputPath?: string | undefined;
}

const FLAGS = new Set(['--mode', '--scope', '--cases', '--output']);

function parseCliArgs(args: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !FLAGS.has(flag) || values.has(flag) || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    values.set(flag, value);
    index += 1;
  }

  const mode = values.get('--mode') ?? 'mock';
  if (mode !== 'mock' && mode !== 'real') throw new Error('INVALID_ARGUMENTS');
  const scope = values.get('--scope');
  if (scope !== undefined && scope !== 'catalog' && scope !== 'exploratory') throw new Error('INVALID_ARGUMENTS');
  const cases = values
    .get('--cases')
    ?.split(',')
    .map(value => value.trim() || undefined);
  if (cases?.some(value => value === undefined)) throw new Error('INVALID_ARGUMENTS');

  return { mode, scope, cases: cases as readonly string[] | undefined, outputPath: values.get('--output') };
}

function cliError(exitCode: number, code: string, message: string): EvaluateCliResult {
  return { exitCode, output: JSON.stringify({ error: code, message }) };
}

function writeOutput(filePath: string, output: string): EvaluateCliResult | undefined {
  try {
    writeFileSync(resolve(filePath), `${output}\n`, 'utf8');
    return undefined;
  } catch {
    return cliError(2, 'OUTPUT_WRITE_ERROR', 'Unable to write output file');
  }
}

/** The runner owns the exit code. A throw means the host binding was malformed: fixed exit 2, no exception text. */
async function run(parsed: ParsedArgs, options: EvaluateCliOptions): Promise<WorkflowEvaluationReport | EvaluateCliResult> {
  const request: WorkflowEvaluationOptions = {
    contractVersion: WORKFLOW_EVALUATION_VERSION,
    suite: 'uc03',
    mode: parsed.mode,
    scope: parsed.scope,
    cases: parsed.cases,
    profileDigest: options.profileDigest,
    configDigest: options.configDigest,
    pricingDigest: options.pricingDigest,
    adapterVersions: options.adapterVersions,
    requestedModel: options.requestedModel,
    realAdmission: options.realAdmission,
    driver: options.driver,
  };
  try {
    return await runEvaluation(request);
  } catch {
    return cliError(2, 'EVALUATION_REFUSED', 'Evaluation refused; exception details are not included');
  }
}

export async function runEvaluateCli(args: readonly string[], options: EvaluateCliOptions): Promise<EvaluateCliResult> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCliArgs(args);
  } catch {
    return cliError(2, 'INVALID_ARGUMENTS', 'Arguments are invalid');
  }

  const report = await run(parsed, options);
  if (!('selectionResult' in report)) return report;

  const output = JSON.stringify(report, null, 2);
  return (
    (parsed.outputPath ? writeOutput(parsed.outputPath, output) : undefined) ?? {
      exitCode: report.exitCode,
      output: `${output}\nUC-03 Workflow Evaluation [${report.mode.toUpperCase()}]: Selected = ${report.selectionResult.outcome}, Suite = ${report.suiteAcceptance.outcome}, ExitCode = ${report.exitCode}`,
    }
  );
}

function isDirectExecution(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && resolve(invokedPath) === resolve(fileURLToPath(import.meta.url));
}

/** argv cannot carry the trusted binding, so a direct shell invocation can only refuse. */
if (isDirectExecution()) {
  process.stderr.write('UC-03 evaluation requires host-supplied profile, config, pricing and model binding\n');
  process.exitCode = 2;
}
