/** Thin UC-03 CLI. Configuration files never create runtime authority. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBugTask } from '../contracts/foundation/uc03.ts';
import { runUC03Graph, type UC03GraphPorts } from '../uc03/graph.ts';
import { runUC03GraphV02 } from '../uc03/graph-v02.ts';
import { loadHostConfiguration, prepareAssembly, readinessReport, resolveHostAssembly, type HostAssembly } from './evaluate.ts';

export interface CliResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface UC03CliOptions {
  readonly ports?: UC03GraphPorts | undefined;
  readonly allowMockInDev?: boolean | undefined;
  /** Production assembly. Only a host-supplied one can reach the v0.2 route. */
  readonly host?: HostAssembly | undefined;
}

interface ParsedArgs {
  readonly taskPath?: string | undefined;
  readonly configPath?: string | undefined;
  readonly hostPath?: string | undefined;
  readonly outputPath?: string | undefined;
  readonly command: 'run' | 'validate';
  readonly mode: 'production' | 'development';
}

function parseCliArgs(args: readonly string[]): ParsedArgs {
  let taskPath: string | undefined;
  let configPath: string | undefined;
  let hostPath: string | undefined;
  let outputPath: string | undefined;
  let command: 'run' | 'validate' = 'run';
  let mode: 'production' | 'development' = 'production';
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== '--task' && flag !== '--task-file' && flag !== '--config' && flag !== '--host' && flag !== '--output' && flag !== '--command' && flag !== '--mode') {
      throw new Error('UNKNOWN_ARGUMENT: unsupported option');
    }
    if (seen.has(flag)) throw new Error('DUPLICATE_ARGUMENT: option appears more than once');
    seen.add(flag);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT_VALUE: option requires a value');
    index += 1;

    if (flag === '--task' || flag === '--task-file') {
      if (taskPath !== undefined) throw new Error('DUPLICATE_ARGUMENT: task path provided more than once');
      taskPath = value;
    } else if (flag === '--config') configPath = value;
    else if (flag === '--host') hostPath = value;
    else if (flag === '--output') outputPath = value;
    else if (flag === '--command') {
      if (value !== 'run' && value !== 'validate') throw new Error('INVALID_COMMAND: unsupported command');
      command = value;
    } else {
      if (value !== 'production' && value !== 'development') throw new Error('INVALID_MODE: unsupported mode');
      mode = value;
    }
  }

  return { taskPath, configPath, hostPath, outputPath, command, mode };
}

function cliError(exitCode: number, code: string, message: string): CliResult {
  return { exitCode, output: JSON.stringify({ error: code, message }) };
}

function readJson(filePath: string, label: 'TASK' | 'CONFIG'): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: CliResult } {
  let content: string;
  try {
    content = fs.readFileSync(path.resolve(filePath), 'utf8');
  } catch {
    return { ok: false, error: cliError(2, `${label}_READ_ERROR`, `Unable to read ${label.toLowerCase()} JSON input`) };
  }
  try {
    const value: unknown = JSON.parse(content);
    return { ok: true, value };
  } catch {
    return { ok: false, error: cliError(2, `${label}_JSON_ERROR`, `${label.charAt(0)}${label.slice(1).toLowerCase()} JSON input is malformed`) };
  }
}

function writeOutput(filePath: string | undefined, output: string): CliResult | undefined {
  if (!filePath) return undefined;
  try {
    fs.writeFileSync(path.resolve(filePath), `${output}\n`, 'utf8');
    return undefined;
  } catch {
    return cliError(2, 'OUTPUT_WRITE_ERROR', 'Unable to write output file');
  }
}

export async function runUC03Cli(args: readonly string[], options?: UC03CliOptions): Promise<CliResult> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCliArgs(args);
  } catch {
    return cliError(2, 'INVALID_ARGUMENTS', 'Arguments are invalid');
  }
  if (!parsed.taskPath) return cliError(2, 'MISSING_TASK', '--task <path> is required');

  const taskFile = readJson(parsed.taskPath, 'TASK');
  if (!taskFile.ok) return taskFile.error;
  const validation = validateBugTask(taskFile.value);
  if (!validation.ok) {
    return {
      exitCode: 2,
      output: JSON.stringify({ error: 'INVALID_TASK_PAYLOAD', validationErrors: ['Task input failed schema validation'] }),
    };
  }

  if (parsed.command === 'validate') {
    const output = JSON.stringify({ outcome: 'ok', taskId: validation.value.taskId, goal: validation.value.goal, checkCount: validation.value.requiredChecks.length });
    return writeOutput(parsed.outputPath, output) ?? { exitCode: 0, output };
  }
  if (!parsed.configPath) return cliError(2, 'MISSING_CONFIG', '--config <path> is required for run');
  const configFile = readJson(parsed.configPath, 'CONFIG');
  if (!configFile.ok) return configFile.error;
  if (typeof configFile.value !== 'object' || configFile.value === null || Array.isArray(configFile.value)) {
    return cliError(2, 'INVALID_CONFIG', 'Configuration must be a JSON object');
  }
  if (!options?.ports && parsed.hostPath === undefined) {
    const kind = parsed.mode === 'production' ? 'unavailable-production-configuration' : 'unavailable-development-configuration';
    const output = JSON.stringify({
      outcome: kind,
      error: 'PORT_COMPOSITION_UNAVAILABLE: JSON configuration does not supply executable StatePort, repository, approval, reviewer, and trusted host authorities.',
    });
    return writeOutput(parsed.outputPath, output) ?? { exitCode: 5, output };
  }

  if (parsed.hostPath !== undefined) {
    // The same host-only loader and bootstrap the evaluation CLI uses; nothing here reads argv.
    const report = (payload: string): CliResult => ({ exitCode: 5, output: payload });
    const unavailable = (): CliResult => report(JSON.stringify({ outcome: 'unavailable-production-configuration', error: 'HOST_ASSEMBLY_UNAVAILABLE: no host assembly is configured' }));
    const loaded = loadHostConfiguration(parsed.hostPath);
    if (!loaded.ok) return loaded.error;
    const resolved = await resolveHostAssembly(loaded.value, options?.host);
    if (resolved === undefined) return unavailable();

    const readiness = prepareAssembly(resolved.host, loaded.value);
    if (readiness === undefined) return unavailable();
    if (readiness.status !== 'ready') return report(readinessReport(readiness));

    const result = await runUC03GraphV02(validation.value, readiness.ports, readiness.config);
    const exitCode = result.outcome === 'COMPLETED' && result.finalReport?.outcome === 'COMPLETED' && result.finalReport.isComplete ? 0 : 1;
    const output = JSON.stringify(result);
    return writeOutput(parsed.outputPath, output) ?? { exitCode, output };
  }
  if (!options?.ports) return cliError(5, 'PORT_COMPOSITION_UNAVAILABLE', 'Ports are unavailable');
  if (parsed.mode === 'development' && options.allowMockInDev !== true && options.ports.repositoryPort.provenance === 'mock') {
    return cliError(5, 'MOCK_MODE_REFUSED', 'Mock ports require explicit allowMockInDev in development mode');
  }

  try {
    const result = await runUC03Graph(validation.value, options.ports, { mode: parsed.mode });
    const exitCode = result.outcome === 'COMPLETED' && result.finalReport?.outcome === 'COMPLETED' && result.finalReport.isComplete ? 0 : 1;
    const output = JSON.stringify(result);
    return writeOutput(parsed.outputPath, output) ?? { exitCode, output };
  } catch {
    return cliError(1, 'UC03_RUN_FAILED', 'Run failed; exception details are not included');
  }
}

function isDirectExecution(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  void runUC03Cli(process.argv.slice(2))
    .then(result => {
      process.stdout.write(`${result.output}\n`);
      process.exitCode = result.exitCode;
    })
    .catch(() => {
      process.stderr.write('UC03 CLI failed; exception details are not included\n');
      process.exitCode = 1;
    });
}
