/** Operator CLI over the uc03 workflow evaluation. Trusted binding comes from the host, never argv. */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runEvaluation } from '../../eval/uc03/runner.ts';
import type { RealExecutionAdmission } from '../../eval/shared-types.ts';
import { WORKFLOW_EVALUATION_VERSION, type WorkflowDriver, type WorkflowEvaluationOptions, type WorkflowEvaluationReport } from '../../eval/uc03/types.ts';
import { prepareUC03Host, type UC03HostInputs, type UC03HostPins, type UC03HostReadiness } from '../runtime/uc03-host-bootstrap.ts';
import { UC03_PRODUCTION_COMPONENTS_V02, type UC03ProductionComponentV02 } from '../uc03/graph-types-v02.ts';
import { isEvaluationControlBindings, isEvaluationControlCommand, parseEvaluationControlArgs, runEvaluationControlCli, type EvaluationControlBindings } from './evaluate-control.ts';

export interface EvaluateCliResult {
  readonly exitCode: number;
  readonly output: string;
}

/** Host-supplied adapter wiring. Pins and identity come from the host-only configuration file. */
export type HostAssembly = Omit<UC03HostInputs, 'pins' | 'identity'>;

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

/** A host-only configuration file. It resolves references; it never carries authority. */
export interface HostConfiguration {
  readonly identity: Readonly<Record<string, string>>;
  readonly pins: UC03HostPins;
  readonly profileDigest: string;
  readonly configDigest: string;
  readonly pricingDigest: string;
  readonly requestedModel: string;
  readonly adapterVersions: readonly string[];
  /** Reference to an operator-supplied assembly module. A path, never a port, fact or credential. */
  readonly assembly?: string | undefined;
}

export type HostConfigurationLoad = Readonly<{ ok: true; value: HostConfiguration }> | Readonly<{ ok: false; error: EvaluateCliResult }>;

/** What the operator's assembly module contributes: the host wiring and an optional route binding. */
export type HostAssemblyResolution = Readonly<{ host: HostAssembly; production?: HostProduction | undefined; control?: EvaluationControlBindings | undefined }>;

/** The one name an assembly module must export. It is a factory, so the module decides its own wiring. */
const ASSEMBLY_FACTORY = 'createHostAssembly';

const HOST_KEYS = new Set(['profileId', 'profileDigest', 'configDigest', 'pricingDigest', 'requestedModel', 'adapterVersions', 'contractVersion', 'revisions', 'assembly']);
const CREDENTIAL = /credential|secret|token|password|api[-_]?key/iu;
const IDENTIFIER = /^[A-Za-z0-9._:/@-]{1,256}$/u;
const REVISION = /^[a-f0-9]{40,64}$/u;
/** A path, not a value: bounded and control-character-free, and it may contain Windows separators. */
const REFERENCE = /^[^\u0000-\u001f]{1,1024}$/u;

type HostProduction = (ready: UC03HostReady) => WorkflowDriver;

/**
 * Read the operator configuration. An unknown key is how a port, a policy fact or a credential
 * would arrive, so the whole file is refused instead — and no value is ever echoed back.
 */
export function loadHostConfiguration(filePath: string): HostConfigurationLoad {
  const refused = (code: string): HostConfigurationLoad => ({ ok: false, error: cliError(2, code, 'Host configuration was refused; values are not echoed') });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(filePath), 'utf8'));
  } catch {
    return refused('HOST_CONFIG_ERROR');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return refused('HOST_CONFIG_ERROR');
  const raw = parsed as Readonly<Record<string, unknown>>;
  if (Object.keys(raw).some(key => !HOST_KEYS.has(key))) return refused('HOST_CONFIG_UNSUPPORTED_FIELD');
  if (Object.entries(raw).some(([key, value]) => CREDENTIAL.test(key) || CREDENTIAL.test(typeof value === 'string' ? value : ''))) return refused('HOST_CONFIG_UNSAFE_FIELD');

  const { profileId, profileDigest, configDigest, pricingDigest, requestedModel, adapterVersions, contractVersion, revisions, assembly } = raw;
  const text = (value: unknown): string => (typeof value === 'string' && IDENTIFIER.test(value) ? value : '');
  const id = text(profileId);
  const profile = text(profileDigest);
  const config = text(configDigest);
  const pricing = text(pricingDigest);
  const model = text(requestedModel);
  const contract = text(contractVersion);
  if ([id, profile, config, pricing, model, contract].some(value => value === '')) return refused('HOST_CONFIG_INCOMPLETE');
  // A reference only: the path is resolved later and never echoed.
  if (assembly !== undefined && (typeof assembly !== 'string' || !REFERENCE.test(assembly) || assembly.trim() === '')) return refused('HOST_CONFIG_INCOMPLETE');
  if (!Array.isArray(adapterVersions) || adapterVersions.length === 0 || adapterVersions.length > 64 || adapterVersions.some(value => text(value) === '')) return refused('HOST_CONFIG_INCOMPLETE');
  if (adapterVersions.some(value => typeof value === 'string' && CREDENTIAL.test(value))) return refused('HOST_CONFIG_UNSAFE_FIELD');
  if (typeof revisions !== 'object' || revisions === null || Array.isArray(revisions)) return refused('HOST_CONFIG_INCOMPLETE');
  const pinned: Record<string, string> = {};
  for (const [component, revision] of Object.entries(revisions)) {
    if (!UC03_PRODUCTION_COMPONENTS_V02.includes(component as UC03ProductionComponentV02) || typeof revision !== 'string' || !REVISION.test(revision)) return refused('HOST_CONFIG_INCOMPLETE');
    pinned[component] = revision;
  }

  return {
    ok: true,
    value: Object.freeze({
      identity: Object.freeze({ profileId: id, profileDigest: profile, configDigest: config, pricingDigest: pricing }),
      pins: Object.freeze({ contractVersion: contract, revisions: Object.freeze(pinned) }),
      profileDigest: profile,
      configDigest: config,
      pricingDigest: pricing,
      requestedModel: model,
      adapterVersions: Object.freeze(adapterVersions as readonly string[]),
      ...(typeof assembly === 'string' ? { assembly } : {}),
    }),
  };
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

export type UC03HostReady = Extract<UC03HostReadiness, { status: 'ready' }>;

/**
 * Readiness as the contract allows it: component names, reason codes and the operator identity.
 * No path, no adapter instance, no delivered value — nothing here can leak a filesystem secret or
 * claim a capability the assembly did not establish.
 */
export function readinessReport(readiness: UC03HostReadiness): string {
  if (readiness.status === 'unavailable') {
    return JSON.stringify({
      outcome: 'unavailable',
      reasons: readiness.reasons.map(reason =>
        reason.kind === 'identity' ? { kind: 'identity', reasonCode: reason.reasonCode } : { kind: 'component', component: reason.component, reasonCode: reason.reasonCode },
      ),
    });
  }
  return JSON.stringify({ outcome: 'ready', components: [...UC03_PRODUCTION_COMPONENTS_V02], identity: readiness.identity });
}

/**
 * Resolve the operator's assembly reference. Every failure — absent file, throwing import, absent
 * factory, throwing factory, non-object result — collapses to the same named prerequisite gap, so no
 * exception text, path or imported value can reach the output.
 */
async function resolveAssembly(reference: string): Promise<HostAssemblyResolution | undefined> {
  try {
    // Trust: the host file is operator-owned, so a module path in it is an execution capability by
    // design; the loader keeps it a reference, never a port, fact or credential.
    // shortcut: the reference resolves against the process CWD, as `--host` already does, so a
    // relative path loads whatever sits there in the invocation directory; make it config-file-relative
    // (or require absolute) if operators keep host files away from the checkout.
    const module: unknown = await import(pathToFileURL(resolve(reference)).href);
    const factory: unknown = typeof module === 'object' && module !== null ? Reflect.get(module, ASSEMBLY_FACTORY) : undefined;
    if (typeof factory !== 'function') return undefined;
    const resolved: unknown = (factory as () => unknown)();
    if (typeof resolved !== 'object' || resolved === null) return undefined;
    const host: unknown = Reflect.get(resolved, 'host');
    const production: unknown = Reflect.get(resolved, 'production');
    const control: unknown = Reflect.get(resolved, 'control');
    if (typeof host !== 'object' || host === null) return undefined;
    if (production !== undefined && typeof production !== 'function') return undefined;
    if (control !== undefined && !isEvaluationControlBindings(control)) return undefined;
    return {
      host: host as HostAssembly,
      ...(production === undefined ? {} : { production: production as HostProduction }),
      ...(control === undefined ? {} : { control }),
    };
  } catch {
    return undefined;
  }
}

/**
 * The assembly the CLI will use: a caller-supplied one always wins, so an operator file reference can
 * never override the programmatic path; otherwise the file's own reference is resolved.
 */
export async function resolveHostAssembly(configuration: HostConfiguration, supplied?: HostAssembly | undefined): Promise<HostAssemblyResolution | undefined> {
  if (supplied !== undefined) return { host: supplied };
  return configuration.assembly === undefined ? undefined : resolveAssembly(configuration.assembly);
}

/**
 * Run the host bootstrap over an operator-supplied assembly. Host objects and nested deliveries may
 * carry throwing getters, so only this bounded assembly/bootstrap operation is translated to a gap.
 */
export function prepareAssembly(host: HostAssembly, configuration: HostConfiguration): UC03HostReadiness | undefined {
  try {
    return prepareUC03Host({ ...host, pins: configuration.pins, identity: configuration.identity });
  } catch {
    return undefined;
  }
}

type Assembled = Readonly<{ ok: true; readiness: UC03HostReady; configuration: HostConfiguration; production?: HostProduction | undefined }> | Readonly<{ ok: false; result: EvaluateCliResult }>;

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
  const production = options?.production ?? resolved.production;
  return { ok: true, readiness, configuration: loaded.value, ...(production === undefined ? {} : { production }) };
}

export async function runEvaluateCli(args: readonly string[], options?: EvaluateCliOptions): Promise<EvaluateCliResult> {
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

  // `preflight` stops at assembly: it must reach the bootstrap with zero task, approval or provider effect.
  if (parsed.command === 'preflight') {
    const assembled = await assemble(parsed, options);
    if (!assembled.ok) return assembled.result;
    const output = readinessReport(assembled.readiness);
    return (parsed.outputPath ? writeOutput(parsed.outputPath, output) : undefined) ?? { exitCode: 0, output };
  }

  if (parsed.hostPath !== undefined) {
    const assembled = await assemble(parsed, options);
    if (!assembled.ok) return assembled.result;
    const production = assembled.production;
    if (production === undefined) return cliError(4, 'HOST_ROUTE_UNAVAILABLE', 'No production route is configured');
    let driver: WorkflowDriver;
    try {
      driver = production(assembled.readiness);
    } catch {
      return cliError(4, 'HOST_ROUTE_UNAVAILABLE', 'No production route is configured');
    }
    const bound: EvaluateCliOptions = { ...options, ...assembled.configuration, driver };
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
