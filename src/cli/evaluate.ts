/** Operator CLI over the uc03 workflow evaluation. Trusted binding comes from the host, never argv. */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvaluation } from '../../eval/uc03/runner.ts';
import defaultManifest from '../../eval/uc03/manifest.json' with { type: 'json' };
import type { RealExecutionAdmission } from '../../eval/shared-types.ts';
import { WORKFLOW_EVALUATION_VERSION, type WorkflowDriver, type WorkflowEvaluationOptions, type WorkflowEvaluationReport } from '../../eval/uc03/types.ts';
import type { UC03HostReadiness } from '../runtime/uc03-host-bootstrap.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../uc03/graph-types-v02.ts';
import { isEvaluationControlCommand, parseEvaluationControlArgs, runEvaluationControlCli, type EvaluationControlBindings } from './evaluate-control.ts';
import { runEvaluationConsoleCli } from './evaluate-console.ts';
import {
  cliError,
  classifyPreflightResult,
  loadHostConfiguration,
  prepareAssembly,
  resolveHostAssembly,
  validateHostMetadata,
  type EvaluateCliResult,
  type HostAssembly,
  type HostAssemblyResolution,
  type HostConfiguration,
  type HostMetadata,
  type HostOperational,
  type HostProduction,
  type HostProductionContext,
  type HostProductionResult,
  type UC03HostReady,
} from './evaluate-host.ts';

// The host seam stays importable from here: `uc03.ts`, the console CLI and the CLI tests all bind it
// through this module, so the extraction to `evaluate-host.ts` is invisible to them.
export { loadHostConfiguration, prepareAssembly, resolveHostAssembly } from './evaluate-host.ts';
export type {
  EvaluateCliResult,
  HostAssembly,
  HostAssemblyResolution,
  HostConfiguration,
  HostConfigurationLoad,
  HostMetadata,
  HostProduction,
  HostProductionContext,
  HostProductionResult,
  UC03HostReady,
} from './evaluate-host.ts';

/** Host-supplied authority. Digests, adapter versions, model and driver never come from argv. */
export interface EvaluateCliOptions {
  readonly profileDigest: string;
  readonly configDigest: string;
  readonly pricingDigest: string;
  readonly adapterVersions: readonly string[];
  readonly requestedModel: string;
  readonly realAdmission?: RealExecutionAdmission | undefined;
  readonly driver?: WorkflowDriver | undefined;
  /** Production assembly. Its absence leaves the controlled programmatic path unchanged. */
  readonly host?: HostAssembly | undefined;
  /** Binds the assembled route to a driver. Only reached when `host` and a configuration path are given. */
  readonly production?: HostProduction | undefined;
  /** Trusted operator delivery; decisions and continuation retain existing owner authority. */
  readonly control?: EvaluationControlBindings | undefined;
}

interface ParsedArgs {
  readonly command: 'preflight' | 'run';
  readonly hostPath?: string | undefined;
  readonly mode: 'mock' | 'real';
  readonly scope?: 'catalog' | 'exploratory' | undefined;
  readonly cases?: readonly string[] | undefined;
  readonly outputPath?: string | undefined;
}

const FLAGS = new Set(['--mode', '--scope', '--cases', '--output', '--host']);
const COMMANDS = new Set(['preflight', 'run']);

function parseCliArgs(args: readonly string[]): ParsedArgs {
  // A bare leading word is the command from the quickstart grammar; everything else is a flag pair.
  const command = args[0] !== undefined && COMMANDS.has(args[0]) ? (args[0] as 'preflight' | 'run') : 'run';
  const rest = command === 'run' && args[0] !== 'run' ? args : args.slice(1);
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
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

  const hostPath = values.get('--host');
  if (command === 'preflight' && hostPath === undefined) throw new Error('INVALID_ARGUMENTS');

  return { command, hostPath, mode, scope, cases: cases as readonly string[] | undefined, outputPath: values.get('--output') };
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

/**
 * Readiness as the contract allows it: component names, reason codes and the operator identity.
 * No path, no adapter instance, no delivered value — nothing here can leak a filesystem secret or
 * claim a capability the assembly did not establish.
 */
export function readinessReport(readiness: UC03HostReadiness, observed?: HostObservation | undefined): string {
  if (readiness.status === 'unavailable') {
    return JSON.stringify({
      outcome: 'unavailable',
      reasons: readiness.reasons.map(reason =>
        reason.kind === 'identity' ? { kind: 'identity', reasonCode: reason.reasonCode } : { kind: 'component', component: reason.component, reasonCode: reason.reasonCode },
      ),
    });
  }
  const ready = { outcome: 'ready', components: [...UC03_PRODUCTION_COMPONENTS_V02], identity: readiness.identity };
  if (observed === undefined) return JSON.stringify(ready);
  // `operational` is present only once a preflight ran: a metadata-only assembly claims nothing more.
  const { metadata, operational } = observed;
  return JSON.stringify({ ...ready, assembly: 'ready', ...(operational === undefined ? {} : { operational }), metadata });
}

/** The §(i) members the CLI validated; `operational` is absent when the assembly ships no preflight. */
type HostObservation = Readonly<{ metadata: HostMetadata; operational?: HostOperational | undefined }>;

type Assembled =
  | Readonly<{
      ok: true;
      readiness: UC03HostReady;
      configuration: HostConfiguration;
      production?: HostProduction | undefined;
      observed?: HostObservation | undefined;
    }>
  | Readonly<{ ok: false; result: EvaluateCliResult }>;

/**
 * §(i) checks in contract order: the metadata projection is validated as a whole, the host file's
 * requested model must be the one the profile pinned, then the operational preflight runs. All three
 * happen after `prepareAssembly` and before any task, provider or command effect.
 */
async function observe(
  resolved: HostAssemblyResolution,
  configuration: HostConfiguration,
): Promise<Readonly<{ ok: true; observed?: HostObservation | undefined }> | Readonly<{ ok: false; result: EvaluateCliResult }>> {
  if (resolved.metadata === undefined) return { ok: true };
  const metadata = validateHostMetadata(resolved.metadata);
  if (metadata === undefined) return { ok: false, result: cliError(4, 'HOST_METADATA_INVALID', 'Host metadata was refused; values are not echoed') };
  if (configuration.requestedModel !== metadata.model) return { ok: false, result: cliError(4, 'HOST_MODEL_MISMATCH', 'The requested model does not match the pinned profile') };
  const preflight = resolved.preflight;
  if (preflight === undefined) return { ok: true, observed: { metadata } };
  // A preflight that throws is the same refusal as one that reports a dead daemon, and its result is
  // untrusted host output: only the allowlisted variants are projected, never a field of the rest.
  // The `then` keeps a synchronous throw inside the same path as a rejected promise.
  const probed = await Promise.resolve()
    .then(() => preflight())
    .catch(() => undefined);
  return { ok: true, observed: { metadata, operational: classifyPreflightResult(probed) } };
}

/** Assemble the production route from the host file; an absent assembly is a gap, never a fallback. */
async function assemble(parsed: ParsedArgs, options: EvaluateCliOptions | undefined): Promise<Assembled> {
  if (parsed.hostPath === undefined) return { ok: false, result: cliError(4, 'HOST_CONFIGURATION_REQUIRED', 'A host configuration path is required') };
  const loaded = loadHostConfiguration(parsed.hostPath);
  if (!loaded.ok) return { ok: false, result: loaded.error };

  const resolved = await resolveHostAssembly(loaded.value, options?.host);
  if (resolved === undefined) return { ok: false, result: cliError(4, 'HOST_ASSEMBLY_UNAVAILABLE', 'No host assembly is configured') };
  const readiness = prepareAssembly(resolved.host, loaded.value);
  if (readiness === undefined) return { ok: false, result: cliError(4, 'HOST_ASSEMBLY_UNAVAILABLE', 'No host assembly is configured') };
  if (readiness.status !== 'ready') return { ok: false, result: { exitCode: 4, output: readinessReport(readiness) } };
  const checked = await observe(resolved, loaded.value);
  if (!checked.ok) return { ok: false, result: checked.result };
  // A failed preflight is reported in the readiness shape it belongs to, and nothing is allocated.
  if (checked.observed?.operational !== undefined && checked.observed.operational !== 'ready') {
    return { ok: false, result: { exitCode: 4, output: readinessReport(readiness, checked.observed) } };
  }
  const production = options?.production ?? resolved.production;
  return { ok: true, readiness, configuration: loaded.value, ...(production === undefined ? {} : { production }), ...(checked.observed === undefined ? {} : { observed: checked.observed }) };
}

export async function runEvaluateCli(args: readonly string[], options?: EvaluateCliOptions): Promise<EvaluateCliResult> {
  if (args[0] === 'serve') {
    return runEvaluationConsoleCli(
      args,
      {
        loadConfiguration: loadHostConfiguration,
        resolveAssembly: configuration => resolveHostAssembly(configuration),
        prepareAssembly,
        readinessReport,
      },
      isDirectExecution(),
    );
  }
  if (isEvaluationControlCommand(args[0])) {
    const parsedControl = parseEvaluationControlArgs(args);
    if (parsedControl === undefined) return runEvaluationControlCli(args, undefined);
    if (options?.control !== undefined) return runEvaluationControlCli(args, options.control);
    if (parsedControl.hostPath === undefined) return runEvaluationControlCli(args, undefined);
    const loaded = loadHostConfiguration(parsedControl.hostPath);
    if (!loaded.ok) return loaded.error;
    const resolved = await resolveHostAssembly(loaded.value);
    return runEvaluationControlCli(args, resolved?.control);
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseCliArgs(args);
  } catch {
    return cliError(2, 'INVALID_ARGUMENTS', 'Arguments are invalid');
  }

  // `preflight` stops at assembly and observation: zero task, approval or provider effect either way.
  if (parsed.command === 'preflight') {
    const assembled = await assemble(parsed, options);
    if (!assembled.ok) return assembled.result;
    // `assemble` already refused a failed observation, so reaching here means operational is ready.
    const output = readinessReport(assembled.readiness, assembled.observed);
    return (parsed.outputPath ? writeOutput(parsed.outputPath, output) : undefined) ?? { exitCode: 0, output };
  }

  if (parsed.hostPath !== undefined) {
    const assembled = await assemble(parsed, options);
    if (!assembled.ok) return assembled.result;
    const production = assembled.production;
    if (production === undefined) return cliError(4, 'HOST_ROUTE_UNAVAILABLE', 'No production route is configured');
    const selected = new Set(parsed.cases ?? defaultManifest.cases.map(item => item.caseId));
    const caseIds = defaultManifest.cases.filter(item => selected.has(item.caseId)).map(item => item.caseId);
    const cfg = assembled.configuration;
    const context: HostProductionContext = {
      mode: parsed.mode,
      binding: {
        profileDigest: cfg.profileDigest,
        configDigest: cfg.configDigest,
        pricingDigest: cfg.pricingDigest,
        adapterVersions: cfg.adapterVersions,
        requestedModel: cfg.requestedModel,
      },
      caseIds,
      pins: cfg.pins,
    };
    let produced: HostProductionResult;
    try {
      produced = production(assembled.readiness, context);
    } catch {
      return cliError(4, 'HOST_ROUTE_UNAVAILABLE', 'No production route is configured');
    }
    const isEnvelope = (value: HostProductionResult): value is Exclude<HostProductionResult, WorkflowDriver> =>
      typeof value === 'object' && value !== null && 'driver' in value && !('executeCase' in value);
    const driver = isEnvelope(produced) ? produced.driver : produced;
    const realAdmission = isEnvelope(produced) ? (options?.realAdmission ?? produced.realAdmission) : options?.realAdmission;
    const bound: EvaluateCliOptions = {
      ...options,
      ...cfg,
      driver,
      ...(realAdmission === undefined ? {} : { realAdmission }),
    };
    const report = await run(parsed, bound);
    return finish(parsed, report);
  }

  if (options === undefined) return cliError(4, 'HOST_ASSEMBLY_UNAVAILABLE', 'No host assembly is configured');
  const report = await run(parsed, options);
  return finish(parsed, report);
}

function finish(parsed: ParsedArgs, report: WorkflowEvaluationReport | EvaluateCliResult): EvaluateCliResult {
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

/** Parse operator references normally; absent host deliveries remain an explicit prerequisite gap. */
if (isDirectExecution()) {
  void runEvaluateCli(process.argv.slice(2))
    .then(result => {
      process.stdout.write(`${result.output}\n`);
      process.exitCode = result.exitCode;
    })
    .catch(() => {
      process.stderr.write('Evaluation CLI failed; exception details are not included\n');
      process.exitCode = 1;
    });
}
