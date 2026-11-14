/** Strict CLI entry and lifetime for the trusted same-process console. */

import type { EvaluateCliResult, HostAssembly, HostAssemblyResolution, HostConfiguration, HostConfigurationLoad } from './evaluate.ts';
import { createEvaluationConsoleHost } from '../runtime/evaluation-console-host.ts';
import type { EvaluationConsoleFactory } from '../runtime/evaluation-console-host.ts';
import type { UC03ControlledHostReadiness, UC03HostReadiness } from '../runtime/uc03-host-bootstrap.ts';

export interface EvaluationConsoleCliDependencies {
  readonly loadConfiguration: (path: string) => HostConfigurationLoad;
  readonly resolveAssembly: (configuration: HostConfiguration) => Promise<HostAssemblyResolution | undefined>;
  readonly prepareAssembly: (host: HostAssembly, configuration: HostConfiguration) => UC03HostReadiness | UC03ControlledHostReadiness | undefined;
  readonly readinessReport: (readiness: UC03HostReadiness) => string;
}

const refused = (exitCode: number, error: string): EvaluateCliResult => ({ exitCode, output: JSON.stringify({ error }) });
const REFERENCE = /^[^\u0000-\u001f]{1,1024}$/u;

function hostPathOf(args: readonly string[]): string | undefined {
  if (args.length !== 3 || args[0] !== 'serve' || args[1] !== '--host') return undefined;
  const path = args[2];
  return path !== undefined && REFERENCE.test(path) && path.trim() !== '' ? path : undefined;
}

/** Parse fully before calling a host loader, assembly resolver or readiness capability. */
export async function runEvaluationConsoleCli(args: readonly string[], dependencies: EvaluationConsoleCliDependencies, directExecution: boolean): Promise<EvaluateCliResult> {
  const path = hostPathOf(args);
  if (path === undefined) return refused(2, 'INVALID_ARGUMENTS');
  const loaded = dependencies.loadConfiguration(path);
  if (!loaded.ok) return loaded.error;
  const resolved = await dependencies.resolveAssembly(loaded.value);
  if (!resolved?.console) return refused(4, 'HOST_CONSOLE_UNAVAILABLE');
  const readiness = dependencies.prepareAssembly(resolved.host, loaded.value);
  if (!readiness) return refused(4, 'HOST_CONSOLE_UNAVAILABLE');
  if (readiness.status !== 'ready') {
    return readiness.status === 'unavailable' ? { exitCode: 4, output: dependencies.readinessReport(readiness) } : refused(4, 'HOST_CONSOLE_UNAVAILABLE');
  }

  const started = await createEvaluationConsoleHost(readiness, loaded.value, resolved.console as EvaluationConsoleFactory);
  if (!started.ok) return refused(4, started.reasonCode);
  if (directExecution) installShutdown(started.host.close);
  return {
    exitCode: 0,
    output: JSON.stringify({ outcome: 'listening', host: started.host.address.host, port: started.host.address.port }),
    close: started.host.close,
  };
}

function installShutdown(close: () => Promise<void>): void {
  let closing: Promise<void> | undefined;
  const detach = (): void => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  };
  const shutdown = (): void => {
    if (closing) return;
    detach();
    closing = close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
