import type { ApprovalService } from './service.ts';
import { ApprovalServiceError } from './service.ts';
import type { SafeOperationOutcome } from '../contracts/approvals/contracts.ts';
import { UC05_APPROVAL_SCHEMA_VERSION_V02 } from '../contracts/approvals/contracts.ts';
import { pathToFileURL } from 'node:url';
import { containsProtectedContent } from '../foundation/repository-tools.ts';
import { isBoundedSafeDataV02, validateSafePresentationV02 } from './presentation.ts';

export interface CliResult { readonly exitCode: number; readonly output: string }

export interface ApprovalCliServiceV02 {
  readonly cliSchemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION_V02;
  readonly presentationProfileV02: unknown;
  listV02(taskId: string): Promise<unknown>;
  historyV02(taskId: string, page: number): Promise<unknown>;
  showV02(taskId: string, decisionId: string): Promise<unknown>;
  inspectV02(taskId: string, decisionId: string, page: number): Promise<unknown>;
  decideV02(input: unknown): Promise<unknown>;
  controlV02(input: unknown): Promise<unknown>;
}

const flags: Readonly<Record<string, readonly string[]>> = {
  list: ['task'], history: ['task', 'page'], show: ['task', 'request'], inspect: ['task', 'request', 'page'],
  decide: ['task', 'request', 'task-version', 'request-version', 'presentation-digest', 'decision', 'response-key'],
  control: ['task', 'task-version', 'direction', 'response-key'],
  'compat-show': ['task', 'request'],
  'compat-inspect': ['task', 'request', 'page'],
  'compat-history': ['task', 'page'],
};
const SAFE_OUTCOMES: readonly SafeOperationOutcome[] = [
  'ok', 'pending', 'paused', 'denied', 'invalid', 'conflict', 'stale', 'unavailable', 'uncertain',
];
type CliSchemaVersion = 'uc05-approval/0.1-draft' | typeof UC05_APPROVAL_SCHEMA_VERSION_V02;
interface ParsedArguments {
  readonly command: string;
  readonly parsed: ReadonlyMap<string, string>;
  readonly taskId: string;
  readonly decisionId: string;
  integer(key: string): number;
}
type ParseResult = { readonly ok: true; readonly value: ParsedArguments } | { readonly ok: false; readonly response: CliResult };

function exitCode(outcome: SafeOperationOutcome): number {
  if (outcome === 'ok') return 0;
  if (outcome === 'invalid') return 2;
  if (outcome === 'denied') return 4;
  if (outcome === 'unavailable' || outcome === 'uncertain') return 5;
  return 3;
}

function result(outcome: SafeOperationOutcome, value?: unknown, recordedDecision = false, schemaVersion: CliSchemaVersion = 'uc05-approval/0.1-draft'): CliResult {
  const recorded = outcome === 'ok' || (outcome === 'paused' && recordedDecision);
  const output = JSON.stringify({ schemaVersion, outcome, safeReasonCode: recorded ? 'approval-cli-recorded' : 'approval-cli-denied', ...(value === undefined ? {} : { value }) });
  if (Buffer.byteLength(output) > 65536 || containsProtectedContent(output)) return result('invalid', undefined, false, schemaVersion);
  return { exitCode: recorded ? 0 : exitCode(outcome), output };
}

function parseArguments(argv: readonly string[], schemaVersion: CliSchemaVersion, allowCompatibility: boolean): ParseResult {
  if (!Array.isArray(argv) || argv.length > 15 || !argv.every(value => typeof value === 'string' && value.length <= 256 && !/[\u0000-\u0020\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value))) {
    return { ok: false, response: result('invalid', undefined, false, schemaVersion) };
  }
  const command = argv[0];
  const required = command !== undefined && Object.hasOwn(flags, command) ? flags[command] : undefined;
  if (!required || argv.length !== 1 + 2 * required.length || (!allowCompatibility && command?.startsWith('compat-'))) {
    return { ok: false, response: result('invalid', undefined, false, schemaVersion) };
  }
  const parsed = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || !required.includes(flag.slice(2)) || parsed.has(flag.slice(2))) {
      return { ok: false, response: result('invalid', undefined, false, schemaVersion) };
    }
    parsed.set(flag.slice(2), value);
  }
  if (!required.every(key => parsed.has(key))) return { ok: false, response: result('invalid', undefined, false, schemaVersion) };
  const taskId = parsed.get('task') ?? '';
  const decisionId = parsed.get('request') ?? '';
  const id = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/.test(value);
  if (!id(taskId) || (command !== 'list' && command !== 'history' && command !== 'compat-history' && command !== 'control' && !id(decisionId))) {
    return { ok: false, response: result('invalid', undefined, false, schemaVersion) };
  }
  const integer = (key: string): number => {
    const value = parsed.get(key) ?? '';
    return /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : 0;
  };
  if ((command === 'inspect' || command === 'compat-inspect' || command === 'history' || command === 'compat-history') && integer('page') === 0) {
    return { ok: false, response: result('invalid', undefined, false, schemaVersion) };
  }
  if (command === 'decide' && (integer('task-version') === 0 || integer('request-version') === 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(parsed.get('presentation-digest') ?? '') ||
    !['approve', 'reject'].includes(parsed.get('decision') ?? '') || !id(parsed.get('response-key') ?? ''))) {
    return { ok: false, response: result('invalid', undefined, false, schemaVersion) };
  }
  if (command === 'control' && (integer('task-version') === 0 || !['resume', 'revise', 'end'].includes(parsed.get('direction') ?? '') || !id(parsed.get('response-key') ?? ''))) {
    return { ok: false, response: result('invalid', undefined, false, schemaVersion) };
  }
  return { ok: true, value: { command, parsed, taskId, decisionId, integer } };
}

function approvalCliServiceV02(service: ApprovalService | ApprovalCliServiceV02 | undefined): service is ApprovalCliServiceV02 {
  if (!service || typeof service !== 'object') return false;
  try {
    const candidate = service as unknown as Record<string, unknown>;
    return candidate['cliSchemaVersion'] === UC05_APPROVAL_SCHEMA_VERSION_V02 &&
      ['listV02', 'historyV02', 'showV02', 'inspectV02', 'decideV02', 'controlV02'].every(key => typeof candidate[key] === 'function');
  } catch {
    return false;
  }
}

function validVersionedCliReadV02(value: unknown, profile: unknown, requirePresentation: boolean): boolean {
  if (!isBoundedSafeDataV02(value) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const root = value as Record<string, unknown>;
    if (root['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION_V02) return false;
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 65536 || containsProtectedContent(serialized)) return false;
    let hasPresentation = false;
    let malformed = false;
    const visit = (current: unknown, field?: string): void => {
      if (malformed) return;
      if (typeof current === 'string') {
        if (field === 'content') {
          try { visit(JSON.parse(current)); } catch { /* A non-JSON detail page remains opaque text. */ }
        }
        return;
      }
      if (Array.isArray(current)) {
        current.forEach(item => visit(item));
        return;
      }
      if (!current || typeof current !== 'object') return;
      const record = current as Record<string, unknown>;
      if (Object.hasOwn(record, 'schemaVersion') && record['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION_V02) {
        malformed = true;
        return;
      }
      if (Object.hasOwn(record, 'subjectKind') || Object.hasOwn(record, 'planApplicability')) {
        const checked = validateSafePresentationV02(record, profile);
        if (!checked.ok) malformed = true;
        else hasPresentation = true;
        return;
      }
      for (const [key, nested] of Object.entries(record)) visit(nested, key);
    };
    visit(value);
    return !malformed && (!requirePresentation || hasPresentation);
  } catch {
    return false;
  }
}

function validVersionedCollectionV02(value: unknown, profile: unknown, collection: 'items' | 'records'): boolean {
  if (!validVersionedCliReadV02(value, profile, false)) return false;
  const entries = (value as Record<string, unknown>)[collection];
  return Array.isArray(entries) && entries.every(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return record['schemaVersion'] === UC05_APPROVAL_SCHEMA_VERSION_V02 && validVersionedCliReadV02(record, profile, false);
  });
}

function versionedMutationResultV02(value: unknown): { readonly outcome: SafeOperationOutcome; readonly safeReasonCode?: string } | undefined {
  if (!isBoundedSafeDataV02(value) || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const record = value as Record<string, unknown>;
    if (record['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION_V02 ||
      !SAFE_OUTCOMES.includes(record['outcome'] as SafeOperationOutcome)) return undefined;
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 65536 || containsProtectedContent(serialized)) return undefined;
    return { outcome: record['outcome'] as SafeOperationOutcome, ...(typeof record['safeReasonCode'] === 'string' ? { safeReasonCode: record['safeReasonCode'] } : {}) };
  } catch {
    return undefined;
  }
}

/** Structured v0.1 arguments; compatibility reads are explicit and have no mutation command. */
export async function runApprovalCli(argv: readonly string[], service?: ApprovalService): Promise<CliResult> {
  try {
    const parsed = parseArguments(argv, 'uc05-approval/0.1-draft', true);
    if (!parsed.ok) return parsed.response;
    const { command, parsed: args, taskId, decisionId, integer } = parsed.value;
    if (!service) return result('unavailable');
    if (command === 'list') return result('ok', await service.list(taskId));
    if (command === 'history') return result('ok', await service.history(taskId, integer('page')));
    if (command === 'show') return result('ok', await service.show(taskId, decisionId));
    if (command === 'inspect') return result('ok', await service.inspect(taskId, decisionId, integer('page')));
    if (command === 'compat-show') return result('ok', await service.show(taskId, decisionId), false, 'uc05-approval/0.1-draft');
    if (command === 'compat-inspect') return result('ok', await service.inspect(taskId, decisionId, integer('page')), false, 'uc05-approval/0.1-draft');
    if (command === 'compat-history') return result('ok', await service.history(taskId, integer('page')), false, 'uc05-approval/0.1-draft');
    if (command === 'control') {
      const response = await service.control({ taskId, taskVersion: integer('task-version'), direction: args.get('direction'), responseKey: args.get('response-key') });
      return result(response.outcome, response, response.safeReasonCode === 'direction-recorded');
    }
    const response = await service.decide({ taskId, decisionId, taskVersion: integer('task-version'), requestVersion: integer('request-version'), presentationDigest: args.get('presentation-digest'), decision: args.get('decision'), responseKey: args.get('response-key') });
    return result(response.outcome, response, response.safeReasonCode === 'decision-recorded');
  } catch (error) {
    return result(error instanceof ApprovalServiceError ? error.outcome : 'unavailable');
  }
}

/** V0.2 dispatch requires its own service capability and branch-validated returned views. */
export async function runApprovalCliV02(argv: readonly string[], service?: ApprovalService | ApprovalCliServiceV02): Promise<CliResult> {
  const schemaVersion = UC05_APPROVAL_SCHEMA_VERSION_V02;
  try {
    const parsed = parseArguments(argv, schemaVersion, false);
    if (!parsed.ok) return parsed.response;
    const { command, parsed: args, taskId, decisionId, integer } = parsed.value;
    if (!approvalCliServiceV02(service)) return result('unavailable', undefined, false, schemaVersion);
    const profile = service.presentationProfileV02;
    if (command === 'list' || command === 'history') {
      const value = command === 'list'
        ? await service.listV02(taskId)
        : await service.historyV02(taskId, integer('page'));
      return validVersionedCollectionV02(value, profile, command === 'list' ? 'items' : 'records')
        ? result('ok', value, false, schemaVersion)
        : result('unavailable', undefined, false, schemaVersion);
    }
    if (command === 'show' || command === 'inspect') {
      const value = command === 'show'
        ? await service.showV02(taskId, decisionId)
        : await service.inspectV02(taskId, decisionId, integer('page'));
      return validVersionedCliReadV02(value, profile, true)
        ? result('ok', value, false, schemaVersion)
        : result('unavailable', undefined, false, schemaVersion);
    }
    if (command === 'decide') {
      const view = await service.showV02(taskId, decisionId);
      const checked = validateSafePresentationV02(view, profile);
      if (!checked.ok || !validVersionedCliReadV02(view, profile, true) || checked.value.decisionId !== decisionId ||
        checked.value.requestVersion !== integer('request-version') || checked.value.presentationDigest !== args.get('presentation-digest')) {
        return result('unavailable', undefined, false, schemaVersion);
      }
      const response = await service.decideV02({
        taskId, decisionId, taskVersion: integer('task-version'), requestVersion: integer('request-version'),
        presentationDigest: args.get('presentation-digest'), decision: args.get('decision'), responseKey: args.get('response-key'),
      });
      const outcome = versionedMutationResultV02(response);
      return outcome
        ? result(outcome.outcome, response, outcome.safeReasonCode === 'decision-recorded', schemaVersion)
        : result('unavailable', undefined, false, schemaVersion);
    }
    if (command === 'control') {
      const current = await service.listV02(taskId);
      if (!validVersionedCollectionV02(current, profile, 'items')) return result('unavailable', undefined, false, schemaVersion);
      const response = await service.controlV02({
        taskId, taskVersion: integer('task-version'), direction: args.get('direction'), responseKey: args.get('response-key'),
      });
      const outcome = versionedMutationResultV02(response);
      return outcome
        ? result(outcome.outcome, response, outcome.safeReasonCode === 'direction-recorded', schemaVersion)
        : result('unavailable', undefined, false, schemaVersion);
    }
    return result('invalid', undefined, false, schemaVersion);
  } catch (error) {
    return result(error instanceof ApprovalServiceError ? error.outcome : 'unavailable', undefined, false, schemaVersion);
  }
}

// The executable is deliberately unconfigured. Hosts inject dependencies into runApprovalCli.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const response = await runApprovalCli(process.argv.slice(2));
  process.stdout.write(response.output + '\n');
  process.exitCode = response.exitCode;
}
