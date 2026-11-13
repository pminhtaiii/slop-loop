import type { ConsoleApprovalPort } from '../runtime/console-server.ts';
import { ID, type EvaluationService, type ServiceFailure, type ServiceResult } from '../runtime/evaluation-service.ts';
import { sanitizeText } from '../foundation/telemetry.ts';
import type { EvaluateCliResult } from './evaluate.ts';

/** The same owner/service surfaces used by the console; argv supplies claims, never authority. */
export interface EvaluationControlBindings {
  readonly service: Pick<EvaluationService, 'getExperiment' | 'issueDirection' | 'continueExperiment'>;
  readonly approval?: Pick<ConsoleApprovalPort, 'decide'> | undefined;
}

type Command = 'status' | 'decision' | 'direction' | 'continue';
const FLAGS: Readonly<Record<Command, readonly string[]>> = {
  status: ['--experiment', '--host'],
  decision: ['--experiment', '--presentation', '--version', '--choice', '--idempotency-key', '--host'],
  direction: ['--experiment', '--kind', '--task-version', '--control-version', '--decision', '--feedback', '--idempotency-key', '--host'],
  continue: ['--experiment', '--version', '--direction', '--idempotency-key', '--host'],
};
const FAILURE_EXIT: Readonly<Record<ServiceFailure, number>> = { 'invalid-input': 2, 'not-found': 2, conflict: 3, busy: 3, blocked: 4 };
const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/u;
const HOST_REFERENCE = /^[^\u0000-\u001f]{1,1024}$/u;

export function isEvaluationControlCommand(value: string | undefined): value is Command {
  return value === 'status' || value === 'decision' || value === 'direction' || value === 'continue';
}

type Request = Readonly<{ command: Command; input: Readonly<Record<string, unknown>>; experimentId: string; hostPath?: string | undefined }>;
const safeId = (value: string | undefined): string | undefined => (value !== undefined && ID.test(value) ? value : undefined);
const version = (value: string | undefined): number | undefined => (value !== undefined && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined);

function parse(args: readonly string[]): Request | undefined {
  const command = args[0];
  if (!isEvaluationControlCommand(command)) return undefined;
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index],
      value = args[index + 1];
    if (!flag || value === undefined || value.startsWith('--') || !FLAGS[command].includes(flag) || values.has(flag)) return undefined;
    values.set(flag, value);
  }
  const hostPath = values.get('--host');
  if (hostPath !== undefined && (!HOST_REFERENCE.test(hostPath) || hostPath.trim() === '')) return undefined;
  const experimentId = safeId(values.get('--experiment'));
  if (!experimentId) return undefined;
  if (command === 'status') return { command, experimentId, input: {}, ...(hostPath === undefined ? {} : { hostPath }) };
  const idempotencyKey = safeId(values.get('--idempotency-key'));
  if (!idempotencyKey) return undefined;
  if (command === 'decision') {
    const presentationDigest = values.get('--presentation'),
      decision = values.get('--choice');
    const expectedVersion = version(values.get('--version'));
    if (!presentationDigest || !DIGEST.test(presentationDigest) || expectedVersion === undefined || (decision !== 'approve' && decision !== 'reject')) return undefined;
    return { command, experimentId, input: { experimentId, presentationDigest, expectedVersion, decision, idempotencyKey }, ...(hostPath === undefined ? {} : { hostPath }) };
  }
  if (command === 'continue') {
    const expectedVersion = version(values.get('--version')),
      directionRef = safeId(values.get('--direction'));
    if (expectedVersion === undefined || !directionRef) return undefined;
    return { command, experimentId, input: { id: experimentId, expectedVersion, directionRef, idempotencyKey }, ...(hostPath === undefined ? {} : { hostPath }) };
  }
  const kind = values.get('--kind'),
    expectedTaskVersion = version(values.get('--task-version')),
    expectedControlVersion = version(values.get('--control-version'));
  const decisionRef = values.get('--decision'),
    feedback = values.get('--feedback');
  if ((kind !== 'resume' && kind !== 'revise' && kind !== 'end') || expectedTaskVersion === undefined || expectedControlVersion === undefined) return undefined;
  if (decisionRef !== undefined && !safeId(decisionRef)) return undefined;
  if (feedback !== undefined && (!feedback.trim() || Buffer.byteLength(feedback, 'utf8') > 4096)) return undefined;
  return {
    command,
    experimentId,
    ...(hostPath === undefined ? {} : { hostPath }),
    input: {
      id: experimentId,
      kind,
      expectedTaskVersion,
      expectedControlVersion,
      idempotencyKey,
      ...(decisionRef === undefined ? {} : { decisionRef }),
      ...(feedback === undefined ? {} : { feedback }),
    },
  };
}

/** Parse the complete control grammar before a host configuration or assembly module is loaded. */
export function parseEvaluationControlArgs(args: readonly string[]): Readonly<{ hostPath?: string | undefined }> | undefined {
  const request = parse(args);
  return request === undefined ? undefined : { ...(request.hostPath === undefined ? {} : { hostPath: request.hostPath }) };
}

/** Validate an operator assembly's control delivery without invoking any owner method. */
export function isEvaluationControlBindings(value: unknown): value is EvaluationControlBindings {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const service: unknown = Reflect.get(value, 'service');
    if (typeof service !== 'object' || service === null || Array.isArray(service)) return false;
    if (typeof Reflect.get(service, 'getExperiment') !== 'function' || typeof Reflect.get(service, 'issueDirection') !== 'function' || typeof Reflect.get(service, 'continueExperiment') !== 'function') return false;
    const approval: unknown = Reflect.get(value, 'approval');
    if (approval === undefined) return true;
    return typeof approval === 'object' && approval !== null && !Array.isArray(approval) && typeof Reflect.get(approval, 'decide') === 'function';
  } catch {
    return false;
  }
}

function refused(exitCode: number, error: string): EvaluateCliResult {
  return { exitCode, output: JSON.stringify({ error }) };
}

export async function runEvaluationControlCli(args: readonly string[], bindings: EvaluationControlBindings | undefined): Promise<EvaluateCliResult> {
  const request = parse(args);
  if (!request) return refused(2, 'INVALID_ARGUMENTS');
  if (!bindings || !isEvaluationControlBindings(bindings) || (request.command === 'decision' && !bindings.approval)) return refused(4, 'OPERATOR_CONTROL_UNAVAILABLE');
  try {
    let result: ServiceResult<unknown>;
    if (request.command === 'status') result = bindings.service.getExperiment(request.experimentId);
    else if (request.command === 'decision') {
      const approval = bindings.approval;
      if (!approval) return refused(4, 'OPERATOR_CONTROL_UNAVAILABLE');
      result = await approval.decide(request.input);
    } else if (request.command === 'direction') result = await bindings.service.issueDirection(request.input);
    else result = await bindings.service.continueExperiment(request.input);
    if (!result.ok) return refused(FAILURE_EXIT[result.status], /^[A-Za-z0-9_-]{1,128}$/u.test(result.reasonCode) ? result.reasonCode : 'OWNER_REFUSED');
    const output = sanitizeText(JSON.stringify({ ok: true, result: result.value }));
    if (Buffer.byteLength(output, 'utf8') > 64 * 1024)
      return { exitCode: 4, output: JSON.stringify({ error: 'OPERATOR_OUTPUT_UNAVAILABLE', effects: request.command === 'status' ? 'none' : 'observed' }) };
    return { exitCode: 0, output };
  } catch {
    // The owner may have committed before its reply was lost; the original key must be retained.
    return { exitCode: 4, output: JSON.stringify({ error: 'OPERATOR_OUTCOME_UNAVAILABLE', effects: request.command === 'status' ? 'none' : 'uncertain' }) };
  }
}
