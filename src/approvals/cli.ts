import type { ApprovalService } from './service.ts';
import { ApprovalServiceError } from './service.ts';
import type { SafeOperationOutcome } from '../contracts/approvals/contracts.ts';
import { pathToFileURL } from 'node:url';
import { containsProtectedContent } from '../foundation/repository-tools.ts';
export interface CliResult { readonly exitCode: number; readonly output: string }

const flags: Readonly<Record<string, readonly string[]>> = {
  list: ['task'], history: ['task', 'page'], show: ['task', 'request'], inspect: ['task', 'request', 'page'],
  decide: ['task', 'request', 'task-version', 'request-version', 'presentation-digest', 'decision', 'response-key'],
  control: ['task', 'task-version', 'direction', 'response-key'],
};
function exitCode(outcome: SafeOperationOutcome): number {
  if (outcome === 'ok') return 0;
  if (outcome === 'invalid') return 2;
  if (outcome === 'denied') return 4;
  if (outcome === 'unavailable' || outcome === 'uncertain') return 5;
  return 3;
}
function result(outcome: SafeOperationOutcome, value?: unknown, recordedDecision = false): CliResult {
  const recorded = outcome === 'ok' || (outcome === 'paused' && recordedDecision);
  const output = JSON.stringify({ schemaVersion: 'uc05-approval/0.1-draft', outcome, safeReasonCode: recorded ? 'approval-cli-recorded' : 'approval-cli-denied', ...(value === undefined ? {} : { value }) });
  if (Buffer.byteLength(output) > 65536 || containsProtectedContent(output)) return result('invalid');
  return { exitCode: recorded ? 0 : exitCode(outcome), output };
}
/** Structured arguments only; every command names the task and cannot select composition. */
export async function runApprovalCli(argv: readonly string[], service?: ApprovalService): Promise<CliResult> {
  try {
    if (!Array.isArray(argv) || argv.length > 15 || !argv.every(value => typeof value === 'string' && value.length <= 256 && !/[\u0000-\u0020\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value))) return result('invalid');
    const command = argv[0];
    const required = command !== undefined && Object.hasOwn(flags, command) ? flags[command] : undefined;
    if (!required || argv.length !== 1 + 2 * required.length) return result('invalid');
    const parsed = new Map<string, string>();
    for (let index = 1; index < argv.length; index += 2) {
      const flag = argv[index];
      const value = argv[index + 1];
      if (!flag?.startsWith('--') || value === undefined || !required.includes(flag.slice(2)) || parsed.has(flag.slice(2))) return result('invalid');
      parsed.set(flag.slice(2), value);
    }
    if (!required.every(key => parsed.has(key))) return result('invalid');
    const taskId = parsed.get('task') ?? '';
    const decisionId = parsed.get('request') ?? '';
    const id = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/.test(value);
    if (!id(taskId) || (command !== 'list' && command !== 'history' && command !== 'control' && !id(decisionId))) return result('invalid');
    const integer = (key: string): number => {
      const value = parsed.get(key) ?? '';
      return /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : 0;
    };
    if ((command === 'inspect' || command === 'history') && integer('page') === 0) return result('invalid');
    if (command === 'decide' && (integer('task-version') === 0 || integer('request-version') === 0 ||
      !/^sha256:[0-9a-f]{64}$/.test(parsed.get('presentation-digest') ?? '') ||
      !['approve', 'reject'].includes(parsed.get('decision') ?? '') || !id(parsed.get('response-key') ?? ''))) return result('invalid');
    if (command === 'control' && (integer('task-version') === 0 || !['resume', 'revise', 'end'].includes(parsed.get('direction') ?? '') || !id(parsed.get('response-key') ?? ''))) return result('invalid');
    if (!service) return result('unavailable');
    if (command === 'list') return result('ok', await service.list(taskId));
    if (command === 'history') return result('ok', await service.history(taskId, integer('page')));
    if (command === 'show') return result('ok', await service.show(taskId, decisionId));
    if (command === 'inspect') return result('ok', await service.inspect(taskId, decisionId, integer('page')));
    if (command === 'control') {
      const response = await service.control({ taskId, taskVersion: integer('task-version'), direction: parsed.get('direction'), responseKey: parsed.get('response-key') });
      return result(response.outcome, response, response.safeReasonCode === 'direction-recorded');
    }
    const response = await service.decide({ taskId, decisionId, taskVersion: integer('task-version'), requestVersion: integer('request-version'), presentationDigest: parsed.get('presentation-digest'), decision: parsed.get('decision'), responseKey: parsed.get('response-key') });
    // A recorded rejection exits successfully; its retained task hold is in the safe metadata.
    return result(response.outcome, response, response.safeReasonCode === 'decision-recorded');
  } catch (error) {
    return result(error instanceof ApprovalServiceError ? error.outcome : 'unavailable');
  }
}

// The executable is deliberately unconfigured. Hosts inject dependencies into runApprovalCli.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const response = await runApprovalCli(process.argv.slice(2));
  process.stdout.write(response.output + '\n');
  process.exitCode = response.exitCode;
}
