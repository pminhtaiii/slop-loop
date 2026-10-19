import type { ApprovalBinding, ValidationError, ValidationResult } from '../contracts/uc03.ts';
import { parseApprovalBinding } from '../contracts/uc03.ts';

export const UC05_APPROVAL_SCHEMA_VERSION = 'uc05-approval/0.1-draft' as const;

export interface ApprovalTaskControl {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly version: number;
  readonly epoch: number;
  readonly mode: 'runnable' | 'waiting' | 'rejected' | 'recovery-blocked' | 'ended';
  readonly pendingDecisionId: string | null;
  readonly continuationRef: string | null;
  readonly reasonCode: string;
  readonly outstandingClaimRefs: readonly string[];
}

export interface ApprovalRequestRecord {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly binding: ApprovalBinding;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly createdRunId: string;
  readonly continuationRef: string;
  readonly requestVersion: number;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly configId: string;
  readonly configVersion: string;
  readonly actionRef: string;
  readonly actionDigest: string;
  readonly presentationDigest: string;
  readonly createdAt: string;
  readonly submissionKey: string;
}

export interface TrustedOperatorIdentity {
  readonly actorId: string;
  readonly channelRef: string;
  readonly provenance: 'real';
}

export interface HumanResolution {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly responseKey: string;
  readonly expectedRequestVersion: number;
  readonly operatorChannelRef: string;
  readonly decision: 'approved' | 'rejected';
  readonly safeReasonCode: string;
  readonly decidedAt: string;
  readonly eventId: string;
}

export interface HumanResolutionValidationContext {
  readonly expectedDecisionId: string;
  readonly expectedRequestVersion: number;
  readonly trustedOperator: unknown;
  readonly existingTerminalResolution?: unknown;
}

export interface BindingAssessment {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly assessmentId: string;
  readonly decisionId: string;
  readonly checkedTaskVersion: number;
  readonly checkedEpoch: number;
  readonly trustedContextDigest: string;
  readonly status: 'valid' | 'stale' | 'denied';
  readonly reasonCodes: readonly string[];
  readonly checkedAt: string;
}

export interface BindingAssessmentValidationContext {
  readonly expectedDecisionId: string;
  readonly expectedTaskVersion: number;
  readonly expectedEpoch: number;
  readonly trustedContextDigest: string;
}

export interface DeveloperDirection {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly directionId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly expectedEpoch: number;
  readonly direction: 'resume' | 'revise' | 'end';
  readonly safeScopeRef: string;
  readonly responseKey: string;
  readonly createdAt: string;
}

export interface DeveloperDirectionValidationContext {
  readonly expectedTaskId: string;
  readonly expectedVersion: number;
  readonly expectedEpoch: number;
  readonly trustedOperator: unknown;
}

export interface PolicyIdentity {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly configId: string;
  readonly configVersion: string;
}

export interface DispatchClaim {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly claimId: string;
  readonly actionId: string;
  readonly taskId: string;
  readonly expectedControlVersion: number;
  readonly expectedEpoch: number;
  readonly repositoryStateDigest: string;
  readonly policyIdentity: PolicyIdentity;
  readonly decisionRefs: readonly string[];
  readonly reservationRefs: readonly string[];
  readonly phase: 'claimed' | 'dispatched' | 'observed' | 'uncertain' | 'reconciled';
  readonly resultRef: string | null;
}

export interface PolicyCommandRule {
  readonly ruleId: string;
  readonly executableRef: string;
  readonly argvPrefix: readonly string[];
  readonly workingDirectoryRef: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface PolicyProfile {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly profileId: 'uc05-local-v1';
  readonly profileVersion: string;
  readonly policyIdentity: PolicyIdentity;
  readonly supportedActionKinds: readonly ('run_command' | 'apply_patch' | 'approve_fix_plan')[];
  readonly commandRules: readonly PolicyCommandRule[];
  readonly sensitivePaths: readonly string[];
  readonly patchBreadth: { readonly maxFiles: number; readonly maxAddedDeletedLines: number };
  readonly maxActionBytes: number;
  readonly maxArgvEntries: number;
  readonly maxArgvEntryBytes: number;
  readonly maxPresentationPageBytes: number;
  readonly maxPresentationPages: number;
  readonly maxPresentationTotalBytes: number;
  readonly maxEventBytes: number;
  readonly operationDeadlineMs: number;
  readonly maxMutationAttempts: number;
  readonly diagnosticRules: {
    readonly maxBytes: number;
    readonly redactSecrets: true;
    readonly allowRawArtifacts: false;
    readonly retainUnresolvedDecisions: true;
  };
}

export interface SafePresentation {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly requestVersion: number;
  readonly bindingFingerprint: string;
  readonly elements: {
    readonly action: string;
    readonly necessity: string;
    readonly targets: readonly string[];
    readonly consequences: string;
    readonly verificationStatus: string;
  };
  readonly inspectionRef: string;
  readonly presentationDigest: string;
  readonly page: {
    readonly pageNumber: number;
    readonly pageCount: number;
    readonly pageBytes: number;
    readonly totalBytes: number;
    readonly truncated: boolean;
  };
}

export type SafeOperationOutcome = 'ok' | 'pending' | 'paused' | 'denied' | 'invalid' | 'conflict' | 'stale' | 'unavailable' | 'uncertain';
export type SafeNextAction = 'none' | 'inspect' | 'decide' | 'resume' | 'revise' | 'end' | 'retry-read' | 'reconcile';

export interface SafeResult {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly outcome: SafeOperationOutcome;
  readonly safeReasonCode: string;
  readonly taskId: string;
  readonly decisionId: string | null;
  readonly controlVersion: number;
  readonly requestVersion: number | null;
  readonly eventRef: string | null;
  readonly safeNextAction: SafeNextAction;
}

export type DecisionEventType =
  | 'approval-request-created'
  | 'human-resolution-recorded'
  | 'binding-assessed'
  | 'developer-direction-recorded'
  | 'dispatch-claim-created'
  | 'dispatch-effect-observed'
  | 'dispatch-uncertain'
  | 'claim-reconciled';

export interface DecisionEvent {
  readonly schemaVersion: typeof UC05_APPROVAL_SCHEMA_VERSION;
  readonly eventId: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly decisionId: string | null;
  readonly directionId: string | null;
  readonly claimId: string | null;
  readonly type: DecisionEventType;
  readonly outcome: SafeOperationOutcome;
  readonly policyRef: PolicyIdentity;
  readonly safeReasonCode: string;
  readonly timestamp: string;
}

const TASK_CONTROL_KEYS = [
  'schemaVersion',
  'taskId',
  'repositoryId',
  'workspaceId',
  'version',
  'epoch',
  'mode',
  'pendingDecisionId',
  'continuationRef',
  'reasonCode',
  'outstandingClaimRefs',
] as const;

const TASK_CONTROL_MODES = ['runnable', 'waiting', 'rejected', 'recovery-blocked', 'ended'] as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/;

/** Accept plain records with enumerable string data properties, rejecting accessors and exotic prototypes. */
function isRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    return Reflect.ownKeys(input).every((key) => {
      if (typeof key !== 'string') return false;
      const descriptor = descriptors[key];
      return descriptor !== undefined && descriptor.enumerable === true && 'value' in descriptor;
    });
  } catch {
    return false;
  }
}

/** Accept standard arrays within the length cap, rejecting holes, accessors and extra properties. */
function isBoundedDenseArray(input: unknown, maxLength: number): input is unknown[] {
  if (!Array.isArray(input)) return false;
  try {
    if (Object.getPrototypeOf(input) !== Array.prototype || input.length > maxLength) return false;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(input)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length) return false;
      const descriptor = descriptors[key];
      if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) return false;
    }
    for (let index = 0; index < input.length; index += 1) {
      if (descriptors[String(index)] === undefined) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Append a structured validation failure at the supplied field path. */
function addError(errors: ValidationError[], path: string, code: string, message: string): void {
  errors.push({ path, code, message });
}

/** Accumulate errors for properties outside the record's explicit schema. */
function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: ValidationError[]
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) addError(errors, path ? `${path}.${key}` : key, 'UNKNOWN_PROPERTY', `Unknown property: ${key}`);
  }
}

/** Require a string containing at least one non-whitespace character. */
function hasNonEmptyString(input: unknown): input is string {
  return typeof input === 'string' && input.trim().length > 0;
}

/** Recognize bounded identifiers using the approval contract's ASCII vocabulary. */
function isIdentifier(input: unknown): input is string {
  return typeof input === 'string' && IDENTIFIER_PATTERN.test(input);
}

/** Accumulate an error when a field is not a bounded contract identifier. */
function validateId(input: unknown, path: string, errors: ValidationError[]): void {
  if (!isIdentifier(input)) addError(errors, path, 'INVALID_ID', `${path} must be a bounded identifier`);
}

/** Accumulate an error unless a numeric bound is a positive safe integer. */
function validatePositiveInteger(input: unknown, path: string, errors: ValidationError[]): void {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) {
    addError(errors, path, 'INVALID_BOUND', `${path} must be a finite positive safe integer`);
  }
}

/** Require the canonical sha256 prefix followed by 64 lowercase hexadecimal digits. */
function validateDigest(input: unknown, path: string, errors: ValidationError[]): void {
  if (typeof input !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input)) {
    addError(errors, path, 'INVALID_DIGEST', `${path} must be a canonical SHA-256 digest`);
  }
}

/** Validate ISO-8601 timestamps with an explicit timezone and a real calendar date. */
function validateTimestamp(input: unknown, path: string, errors: ValidationError[]): void {
  const match = typeof input === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(input)
    : null;
  const year = match?.[1] === undefined ? undefined : Number(match[1]);
  const month = match?.[2] === undefined ? undefined : Number(match[2]);
  const day = match?.[3] === undefined ? undefined : Number(match[3]);
  const hour = match?.[4] === undefined ? undefined : Number(match[4]);
  const minute = match?.[5] === undefined ? undefined : Number(match[5]);
  const second = match?.[6] === undefined ? undefined : Number(match[6]);
  const offsetHour = match?.[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match?.[9] === undefined ? 0 : Number(match[9]);
  const validCalendarDate = year !== undefined && month !== undefined && day !== undefined && (() => {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  })();
  if (
    match === null || !validCalendarDate || hour === undefined || hour > 23 || minute === undefined || minute > 59 ||
    second === undefined || second > 59 || offsetHour > 23 || offsetMinute > 59 ||
    typeof input !== 'string' || Number.isNaN(Date.parse(input))
  ) {
    addError(errors, path, 'INVALID_TIMESTAMP', `${path} must be an ISO-8601 timestamp with an explicit timezone`);
  }
}

/** Reject records whose schema version differs from the current UC-05 draft. */
function validateSchemaVersion(input: Record<string, unknown>, errors: ValidationError[]): void {
  if (input['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION) {
    addError(errors, 'schemaVersion', 'INVALID_SCHEMA_VERSION', `schemaVersion must equal ${UC05_APPROVAL_SCHEMA_VERSION}`);
  }
}

/** Validate up to 128 unique identifiers in a dense array, optionally requiring an entry. */
function validateIdArray(input: unknown, path: string, errors: ValidationError[], allowEmpty = true): void {
  if (!isBoundedDenseArray(input, 128)) {
    addError(errors, path, 'INVALID_TYPE', `${path} must be a bounded dense array`);
    return;
  }
  if (!allowEmpty && input.length === 0) addError(errors, path, 'EMPTY_ARRAY', `${path} must not be empty`);
  const seen = new Set<string>();
  input.forEach((value: unknown, index: number) => {
    if (!isIdentifier(value)) addError(errors, `${path}[${index}]`, 'INVALID_ID', `${path}[${index}] must be a bounded identifier`);
    else if (seen.has(value)) addError(errors, `${path}[${index}]`, 'DUPLICATE_ID', `${path} must not contain duplicate identifiers`);
    else seen.add(value);
  });
}

/** Create the standard validation failure for a value that is not a plain record. */
function invalidObject(path: string): ValidationError[] {
  return [{ path, message: `${path} must be a plain object`, code: 'INVALID_TYPE' }];
}

/** Validate task-control fields and consistency between the hold mode and pending decision references. */
export function validateApprovalTaskControl(input: unknown): ValidationResult<ApprovalTaskControl> {
  const path = 'approvalTaskControl';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, TASK_CONTROL_KEYS, path, errors);
  validateSchemaVersion(input, errors);
  validateId(input['taskId'], `${path}.taskId`, errors);
  validateId(input['repositoryId'], `${path}.repositoryId`, errors);
  validateId(input['workspaceId'], `${path}.workspaceId`, errors);
  validatePositiveInteger(input['version'], `${path}.version`, errors);
  validatePositiveInteger(input['epoch'], `${path}.epoch`, errors);
  if (!TASK_CONTROL_MODES.includes(input['mode'] as typeof TASK_CONTROL_MODES[number])) {
    addError(errors, `${path}.mode`, 'INVALID_MODE', 'mode is not a supported task-control state');
  }
  for (const field of ['pendingDecisionId', 'continuationRef'] as const) {
    const value = input[field];
    if (value !== null && !isIdentifier(value)) addError(errors, `${path}.${field}`, 'INVALID_ID', `${path}.${field} must be null or a bounded identifier`);
  }
  validateId(input['reasonCode'], `${path}.reasonCode`, errors);
  validateIdArray(input['outstandingClaimRefs'], `${path}.outstandingClaimRefs`, errors);

  if (input['mode'] === 'waiting' && (input['pendingDecisionId'] === null || input['continuationRef'] === null)) {
    addError(errors, path, 'INCOMPLETE_PENDING_CONTROL', 'waiting control requires a pending decision and continuation reference');
  }
  if (input['mode'] !== 'waiting' && input['mode'] !== 'recovery-blocked' && input['pendingDecisionId'] !== null) {
    addError(errors, `${path}.pendingDecisionId`, 'INCOMPATIBLE_STATE', 'only waiting or recovery-blocked control may retain a pending decision');
  }
  if (input['mode'] === 'recovery-blocked' && input['pendingDecisionId'] !== null && input['continuationRef'] === null) {
    addError(errors, `${path}.continuationRef`, 'INCOMPLETE_PENDING_CONTROL', 'a retained pending decision requires its continuation reference');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as ApprovalTaskControl };
}

const APPROVAL_REQUEST_KEYS = [
  'schemaVersion', 'decisionId', 'binding', 'taskId', 'repositoryId', 'workspaceId', 'createdRunId',
  'continuationRef', 'requestVersion', 'policyId', 'policyVersion', 'configId', 'configVersion',
  'actionRef', 'actionDigest', 'presentationDigest', 'createdAt', 'submissionKey',
] as const;

/** Validate a new pending request and its identity and digest agreement with the canonical binding. */
export function validateApprovalRequestRecord(input: unknown): ValidationResult<ApprovalRequestRecord> {
  const path = 'approvalRequestRecord';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, APPROVAL_REQUEST_KEYS, path, errors);
  validateSchemaVersion(input, errors);
  for (const field of [
    'decisionId', 'taskId', 'repositoryId', 'workspaceId', 'createdRunId', 'continuationRef',
    'policyId', 'policyVersion', 'configId', 'configVersion', 'actionRef', 'submissionKey',
  ] as const) validateId(input[field], `${path}.${field}`, errors);
  validatePositiveInteger(input['requestVersion'], `${path}.requestVersion`, errors);
  validateDigest(input['actionDigest'], `${path}.actionDigest`, errors);
  validateDigest(input['presentationDigest'], `${path}.presentationDigest`, errors);
  validateTimestamp(input['createdAt'], `${path}.createdAt`, errors);

  const parsedBinding = isRecord(input['binding'])
    ? parseApprovalBinding(input['binding'])
    : { ok: false as const, errors: [{ path: 'approvalBinding', message: 'binding must be a plain object', code: 'INVALID_TYPE' }] };
  if (!parsedBinding.ok) {
    for (const error of parsedBinding.errors) errors.push({ ...error, path: `${path}.binding.${error.path}` });
  } else {
    const binding = parsedBinding.value;
    if (binding.status !== 'pending') addError(errors, `${path}.binding.status`, 'PENDING_ONLY', 'new approval requests must contain a pending binding');
    if (binding.reason !== undefined) addError(errors, `${path}.binding.reason`, 'INCOMPATIBLE_PENDING_FIELD', 'new pending bindings cannot contain a terminal decision reason');
    validateDigest(binding.normalizedActionDigest, `${path}.binding.normalizedActionDigest`, errors);
    validateDigest(binding.repositoryRevisionDigest, `${path}.binding.repositoryRevisionDigest`, errors);
    for (const [field, value] of [
      ['decisionId', binding.decisionId], ['taskId', binding.taskId], ['workspaceId', binding.workspaceId],
      ['policyId', binding.policyId], ['policyVersion', binding.policyVersion],
    ] as const) {
      if (input[field] !== value) addError(errors, `${path}.${field}`, 'IDENTITY_MISMATCH', `${field} must match the canonical approval binding`);
    }
    if (input['actionDigest'] !== binding.normalizedActionDigest) addError(errors, `${path}.actionDigest`, 'IDENTITY_MISMATCH', 'actionDigest must match the canonical approval binding');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as ApprovalRequestRecord };
}

const HUMAN_RESOLUTION_KEYS = [
  'schemaVersion', 'decisionId', 'responseKey', 'expectedRequestVersion', 'operatorChannelRef',
  'decision', 'safeReasonCode', 'decidedAt', 'eventId',
] as const;
const TRUSTED_OPERATOR_KEYS = ['actorId', 'channelRef', 'provenance'] as const;

/** Require explicit actor and channel identifiers with real host provenance. */
function validateTrustedOperator(input: unknown, errors: ValidationError[]): void {
  if (!isRecord(input)) {
    addError(errors, 'context.trustedOperator', 'MISSING_TRUSTED_IDENTITY', 'trusted operator identity is required');
    return;
  }
  rejectUnknownKeys(input, TRUSTED_OPERATOR_KEYS, 'context.trustedOperator', errors);
  validateId(input['actorId'], 'context.trustedOperator.actorId', errors);
  validateId(input['channelRef'], 'context.trustedOperator.channelRef', errors);
  if (input['provenance'] !== 'real') addError(errors, 'context.trustedOperator.provenance', 'UNTRUSTED_PROVENANCE', 'operator identity must come from a real trusted host channel');
}

/** Validate one terminal response against the trusted request version and operator channel. */
function validateHumanResolutionRecord(input: unknown, context: HumanResolutionValidationContext): ValidationResult<HumanResolution> {
  const path = 'humanResolution';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, HUMAN_RESOLUTION_KEYS, path, errors);
  validateSchemaVersion(input, errors);
  for (const field of ['decisionId', 'responseKey', 'operatorChannelRef', 'safeReasonCode', 'eventId'] as const) {
    validateId(input[field], `${path}.${field}`, errors);
  }
  validatePositiveInteger(input['expectedRequestVersion'], `${path}.expectedRequestVersion`, errors);
  validateTimestamp(input['decidedAt'], `${path}.decidedAt`, errors);
  if (input['decision'] !== 'approved' && input['decision'] !== 'rejected') {
    addError(errors, `${path}.decision`, 'INVALID_DECISION', 'decision must be approved or rejected');
  }
  validateId(context.expectedDecisionId, 'context.expectedDecisionId', errors);
  validatePositiveInteger(context.expectedRequestVersion, 'context.expectedRequestVersion', errors);
  validateTrustedOperator(context.trustedOperator, errors);
  if (input['decisionId'] !== context.expectedDecisionId) addError(errors, `${path}.decisionId`, 'IDENTITY_MISMATCH', 'decisionId must match the trusted pending request');
  if (input['expectedRequestVersion'] !== context.expectedRequestVersion) addError(errors, `${path}.expectedRequestVersion`, 'VERSION_MISMATCH', 'request version must match the current trusted request');
  if (isRecord(context.trustedOperator) && input['operatorChannelRef'] !== context.trustedOperator['channelRef']) {
    addError(errors, `${path}.operatorChannelRef`, 'IDENTITY_MISMATCH', 'operator channel must match the trusted host channel');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as HumanResolution };
}

/** Compare every persisted resolution field to distinguish an identical retry from a conflict. */
function sameResolution(left: HumanResolution, right: HumanResolution): boolean {
  return HUMAN_RESOLUTION_KEYS.every((key) => left[key] === right[key]);
}

/** Validate a trusted human response, permitting identical retries and rejecting terminal conflicts. */
export function validateHumanResolution(
  input: unknown,
  context?: HumanResolutionValidationContext
): ValidationResult<HumanResolution> {
  if (context === undefined) {
    return { ok: false, errors: [{ path: 'context', message: 'trusted request and operator context are required', code: 'MISSING_TRUSTED_CONTEXT' }] };
  }
  if (!isRecord(context)) return { ok: false, errors: invalidObject('context') };
  const contextErrors: ValidationError[] = [];
  rejectUnknownKeys(context, ['expectedDecisionId', 'expectedRequestVersion', 'trustedOperator', 'existingTerminalResolution'], 'context', contextErrors);
  if (contextErrors.length > 0) return { ok: false, errors: contextErrors };
  const current = validateHumanResolutionRecord(input, context);
  if (!current.ok) return current;
  if (context.existingTerminalResolution === undefined) return current;

  const existing = validateHumanResolutionRecord(context.existingTerminalResolution, context);
  if (!existing.ok) {
    return { ok: false, errors: [...existing.errors, { path: 'context.existingTerminalResolution', message: 'existing terminal resolution is invalid', code: 'INVALID_EXISTING_RESOLUTION' }] };
  }
  if (!sameResolution(current.value, existing.value)) {
    return { ok: false, errors: [{ path: 'humanResolution', message: 'a conflicting terminal resolution already exists and is immutable', code: 'CONFLICTING_TERMINAL_RESOLUTION' }] };
  }
  return current;
}

const BINDING_ASSESSMENT_KEYS = [
  'schemaVersion', 'assessmentId', 'decisionId', 'checkedTaskVersion', 'checkedEpoch',
  'trustedContextDigest', 'status', 'reasonCodes', 'checkedAt',
] as const;

/** Validate assessment reasons and bind the record to the trusted decision, task version, epoch and context digest. */
export function validateBindingAssessment(
  input: unknown,
  context?: BindingAssessmentValidationContext
): ValidationResult<BindingAssessment> {
  const path = 'bindingAssessment';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, BINDING_ASSESSMENT_KEYS, path, errors);
  validateSchemaVersion(input, errors);
  validateId(input['assessmentId'], `${path}.assessmentId`, errors);
  validateId(input['decisionId'], `${path}.decisionId`, errors);
  validatePositiveInteger(input['checkedTaskVersion'], `${path}.checkedTaskVersion`, errors);
  validatePositiveInteger(input['checkedEpoch'], `${path}.checkedEpoch`, errors);
  validateDigest(input['trustedContextDigest'], `${path}.trustedContextDigest`, errors);
  validateTimestamp(input['checkedAt'], `${path}.checkedAt`, errors);
  const statuses = ['valid', 'stale', 'denied'] as const;
  if (!statuses.includes(input['status'] as typeof statuses[number])) addError(errors, `${path}.status`, 'INVALID_STATUS', 'status must be valid, stale, or denied');
  validateIdArray(input['reasonCodes'], `${path}.reasonCodes`, errors, true);
  if (input['status'] === 'valid' && Array.isArray(input['reasonCodes']) && input['reasonCodes'].length > 0) {
    addError(errors, `${path}.reasonCodes`, 'INCOMPATIBLE_STATUS', 'valid assessments cannot contain denial or staleness reasons');
  }
  if ((input['status'] === 'stale' || input['status'] === 'denied') && Array.isArray(input['reasonCodes']) && input['reasonCodes'].length === 0) {
    addError(errors, `${path}.reasonCodes`, 'MISSING_REASON', 'stale and denied assessments require a safe reason code');
  }
  if (context === undefined) {
    addError(errors, 'context', 'MISSING_TRUSTED_CONTEXT', 'fresh task, epoch, request, and context identity are required');
  } else if (!isRecord(context)) {
    addError(errors, 'context', 'INVALID_TYPE', 'assessment context must be a plain object');
  } else {
    rejectUnknownKeys(context, ['expectedDecisionId', 'expectedTaskVersion', 'expectedEpoch', 'trustedContextDigest'], 'context', errors);
    validateId(context.expectedDecisionId, 'context.expectedDecisionId', errors);
    validatePositiveInteger(context.expectedTaskVersion, 'context.expectedTaskVersion', errors);
    validatePositiveInteger(context.expectedEpoch, 'context.expectedEpoch', errors);
    validateDigest(context.trustedContextDigest, 'context.trustedContextDigest', errors);
    if (input['decisionId'] !== context.expectedDecisionId) addError(errors, `${path}.decisionId`, 'IDENTITY_MISMATCH', 'assessment must match the trusted decision identity');
    if (input['checkedTaskVersion'] !== context.expectedTaskVersion) addError(errors, `${path}.checkedTaskVersion`, 'VERSION_MISMATCH', 'assessment must match the current task version');
    if (input['checkedEpoch'] !== context.expectedEpoch) addError(errors, `${path}.checkedEpoch`, 'EPOCH_MISMATCH', 'assessment must match the current task epoch');
    if (input['trustedContextDigest'] !== context.trustedContextDigest) addError(errors, `${path}.trustedContextDigest`, 'IDENTITY_MISMATCH', 'assessment must bind the current trusted context digest');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as BindingAssessment };
}

const DEVELOPER_DIRECTION_KEYS = [
  'schemaVersion', 'directionId', 'taskId', 'expectedVersion', 'expectedEpoch', 'direction',
  'safeScopeRef', 'responseKey', 'createdAt',
] as const;

/** Validate resume, revise or end direction against trusted operator and current task context. */
export function validateDeveloperDirection(
  input: unknown,
  context?: DeveloperDirectionValidationContext
): ValidationResult<DeveloperDirection> {
  const path = 'developerDirection';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, DEVELOPER_DIRECTION_KEYS, path, errors);
  validateSchemaVersion(input, errors);
  for (const field of ['directionId', 'taskId', 'safeScopeRef', 'responseKey'] as const) validateId(input[field], `${path}.${field}`, errors);
  validatePositiveInteger(input['expectedVersion'], `${path}.expectedVersion`, errors);
  validatePositiveInteger(input['expectedEpoch'], `${path}.expectedEpoch`, errors);
  validateTimestamp(input['createdAt'], `${path}.createdAt`, errors);
  const directions = ['resume', 'revise', 'end'] as const;
  if (!directions.includes(input['direction'] as typeof directions[number])) addError(errors, `${path}.direction`, 'INVALID_DIRECTION', 'direction must be resume, revise, or end');

  if (context === undefined) addError(errors, 'context', 'MISSING_TRUSTED_CONTEXT', 'trusted CLI operator and current task identity are required');
  else if (!isRecord(context)) addError(errors, 'context', 'INVALID_TYPE', 'direction context must be a plain object');
  else {
    rejectUnknownKeys(context, ['expectedTaskId', 'expectedVersion', 'expectedEpoch', 'trustedOperator'], 'context', errors);
    validateId(context.expectedTaskId, 'context.expectedTaskId', errors);
    validatePositiveInteger(context.expectedVersion, 'context.expectedVersion', errors);
    validatePositiveInteger(context.expectedEpoch, 'context.expectedEpoch', errors);
    validateTrustedOperator(context.trustedOperator, errors);
    if (input['taskId'] !== context.expectedTaskId) addError(errors, `${path}.taskId`, 'IDENTITY_MISMATCH', 'direction must target the trusted task');
    if (input['expectedVersion'] !== context.expectedVersion) addError(errors, `${path}.expectedVersion`, 'VERSION_MISMATCH', 'direction must match the current task version');
    if (input['expectedEpoch'] !== context.expectedEpoch) addError(errors, `${path}.expectedEpoch`, 'EPOCH_MISMATCH', 'direction must match the current task epoch');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as DeveloperDirection };
}

const POLICY_IDENTITY_KEYS = ['policyId', 'policyVersion', 'configId', 'configVersion'] as const;
const DISPATCH_CLAIM_KEYS = [
  'schemaVersion', 'claimId', 'actionId', 'taskId', 'expectedControlVersion', 'expectedEpoch',
  'repositoryStateDigest', 'policyIdentity', 'decisionRefs', 'reservationRefs', 'phase', 'resultRef',
] as const;

/** Require the exact policy and configuration identity fields with bounded identifier values. */
function validatePolicyIdentity(input: unknown, path: string, errors: ValidationError[]): void {
  if (!isRecord(input)) {
    addError(errors, path, 'INVALID_TYPE', `${path} must be an identity object`);
    return;
  }
  rejectUnknownKeys(input, POLICY_IDENTITY_KEYS, path, errors);
  for (const field of POLICY_IDENTITY_KEYS) validateId(input[field], `${path}.${field}`, errors);
}

/** Validate claim identity, reservations and lifecycle fields, including required outcome references. */
export function validateDispatchClaim(input: unknown): ValidationResult<DispatchClaim> {
  const path = 'dispatchClaim';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, DISPATCH_CLAIM_KEYS, path, errors);
  validateSchemaVersion(input, errors);
  for (const field of ['claimId', 'actionId', 'taskId'] as const) validateId(input[field], `${path}.${field}`, errors);
  validatePositiveInteger(input['expectedControlVersion'], `${path}.expectedControlVersion`, errors);
  validatePositiveInteger(input['expectedEpoch'], `${path}.expectedEpoch`, errors);
  validateDigest(input['repositoryStateDigest'], `${path}.repositoryStateDigest`, errors);
  validatePolicyIdentity(input['policyIdentity'], `${path}.policyIdentity`, errors);
  validateIdArray(input['decisionRefs'], `${path}.decisionRefs`, errors);
  validateIdArray(input['reservationRefs'], `${path}.reservationRefs`, errors, false);
  const phases = ['claimed', 'dispatched', 'observed', 'uncertain', 'reconciled'] as const;
  if (!phases.includes(input['phase'] as typeof phases[number])) addError(errors, `${path}.phase`, 'INVALID_PHASE', 'claim phase is not in the safe lifecycle vocabulary');
  if (input['resultRef'] !== null) validateId(input['resultRef'], `${path}.resultRef`, errors);
  if (['observed', 'uncertain', 'reconciled'].includes(String(input['phase'])) && input['resultRef'] === null) {
    addError(errors, `${path}.resultRef`, 'MISSING_RESULT_REFERENCE', 'post-dispatch claim phases require a result or reconciliation reference');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as DispatchClaim };
}

const POLICY_PROFILE_KEYS = [
  'schemaVersion', 'profileId', 'profileVersion', 'policyIdentity', 'supportedActionKinds', 'commandRules',
  'sensitivePaths', 'patchBreadth', 'maxActionBytes', 'maxArgvEntries', 'maxArgvEntryBytes',
  'maxPresentationPageBytes', 'maxPresentationPages', 'maxPresentationTotalBytes', 'maxEventBytes',
  'operationDeadlineMs', 'maxMutationAttempts', 'diagnosticRules',
] as const;
const COMMAND_RULE_KEYS = ['ruleId', 'executableRef', 'argvPrefix', 'workingDirectoryRef', 'timeoutMs', 'maxOutputBytes'] as const;
const PATCH_BREADTH_KEYS = ['maxFiles', 'maxAddedDeletedLines'] as const;
const DIAGNOSTIC_RULE_KEYS = ['maxBytes', 'redactSecrets', 'allowRawArtifacts', 'retainUnresolvedDecisions'] as const;
const ACTION_KINDS = ['run_command', 'apply_patch', 'approve_fix_plan'] as const;
const SAFE_RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.?($|\/))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const UC05_LOCAL_PROFILE_CAPS = Object.freeze({
  maxFiles: 8,
  maxAddedDeletedLines: 400,
  maxActionBytes: 65_536,
  maxArgvEntries: 32,
  maxArgvEntryBytes: 4_096,
  maxPresentationPageBytes: 8_192,
  maxPresentationPages: 3,
  maxPresentationTotalBytes: 24_576,
  maxEventBytes: 1_024,
  operationDeadlineMs: 2_000,
  maxMutationAttempts: 1,
});

/** Require nonempty UTF-8 text within the byte cap, excluding control and bidi formatting characters. */
function validateBoundedText(input: unknown, path: string, errors: ValidationError[], maxBytes: number): void {
  if (
    !hasNonEmptyString(input) ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(input) ||
    Buffer.byteLength(input, 'utf8') > maxBytes
  ) {
    addError(errors, path, 'INVALID_TEXT', `${path} must be nonempty bounded UTF-8 text without control characters`);
  }
}

/** Validate a positive safe integer and accumulate an error if it exceeds the local profile cap. */
function validateCappedBound(input: unknown, cap: number, path: string, errors: ValidationError[]): void {
  validatePositiveInteger(input, path, errors);
  if (typeof input === 'number' && Number.isSafeInteger(input) && input > cap) {
    addError(errors, path, 'PROFILE_CAP_EXCEEDED', `${path} cannot exceed the uc05-local-v1 test cap`);
  }
}

/** Validate the test-only uc05-local-v1 profile, enforcing finite caps and explicit safety rules. */
export function validatePolicyProfile(input: unknown): ValidationResult<PolicyProfile> {
  const path = 'policyProfile';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, POLICY_PROFILE_KEYS, path, errors);
  validateSchemaVersion(input, errors);
  if (input['profileId'] !== 'uc05-local-v1') addError(errors, `${path}.profileId`, 'UNSUPPORTED_PROFILE', 'only the explicit test-only uc05-local-v1 profile is validated in this phase');
  validateId(input['profileVersion'], `${path}.profileVersion`, errors);
  validatePolicyIdentity(input['policyIdentity'], `${path}.policyIdentity`, errors);

  const actionKinds = input['supportedActionKinds'];
  if (!isBoundedDenseArray(actionKinds, ACTION_KINDS.length) || actionKinds.length === 0) addError(errors, `${path}.supportedActionKinds`, 'MISSING_ACTION_RULES', 'at least one supported action kind must be explicit in a bounded dense array');
  else {
    const seenActions = new Set<string>();
    actionKinds.forEach((kind: unknown, index: number) => {
      if (typeof kind !== 'string' || !ACTION_KINDS.includes(kind as typeof ACTION_KINDS[number])) addError(errors, `${path}.supportedActionKinds[${index}]`, 'UNSUPPORTED_ACTION', 'action kind is not in the canonical action vocabulary');
      else if (seenActions.has(kind)) addError(errors, `${path}.supportedActionKinds[${index}]`, 'DUPLICATE_ACTION', 'supported action kinds must be unique');
      else seenActions.add(kind);
    });
  }

  const positiveCaps: readonly [keyof typeof UC05_LOCAL_PROFILE_CAPS, string][] = [
    ['maxActionBytes', 'maxActionBytes'], ['maxArgvEntries', 'maxArgvEntries'], ['maxArgvEntryBytes', 'maxArgvEntryBytes'],
    ['maxPresentationPageBytes', 'maxPresentationPageBytes'], ['maxPresentationPages', 'maxPresentationPages'],
    ['maxPresentationTotalBytes', 'maxPresentationTotalBytes'], ['maxEventBytes', 'maxEventBytes'],
    ['operationDeadlineMs', 'operationDeadlineMs'], ['maxMutationAttempts', 'maxMutationAttempts'],
  ];
  for (const [capKey, field] of positiveCaps) validateCappedBound(input[field], UC05_LOCAL_PROFILE_CAPS[capKey], `${path}.${field}`, errors);

  if (!isRecord(input['patchBreadth'])) addError(errors, `${path}.patchBreadth`, 'INVALID_TYPE', 'patchBreadth must be an explicit object');
  else {
    rejectUnknownKeys(input['patchBreadth'], PATCH_BREADTH_KEYS, `${path}.patchBreadth`, errors);
    for (const field of PATCH_BREADTH_KEYS) {
      const cap = field === 'maxFiles' ? UC05_LOCAL_PROFILE_CAPS.maxFiles : UC05_LOCAL_PROFILE_CAPS.maxAddedDeletedLines;
      validateCappedBound(input['patchBreadth'][field], cap, `${path}.patchBreadth.${field}`, errors);
    }
  }

  const sensitivePaths = input['sensitivePaths'];
  if (!isBoundedDenseArray(sensitivePaths, 64) || sensitivePaths.length === 0) {
    addError(errors, `${path}.sensitivePaths`, 'INVALID_PATH_RULES', 'sensitivePaths must be a nonempty bounded dense array');
  } else {
    const seenPaths = new Set<string>();
    sensitivePaths.forEach((entry: unknown, index: number) => {
      if (typeof entry !== 'string' || !SAFE_RELATIVE_PATH_PATTERN.test(entry)) addError(errors, `${path}.sensitivePaths[${index}]`, 'INVALID_PATH', 'sensitive path must be a canonical repository-relative path');
      else if (seenPaths.has(entry)) addError(errors, `${path}.sensitivePaths[${index}]`, 'DUPLICATE_PATH', 'sensitive paths must be unique');
      else seenPaths.add(entry);
    });
  }

  const commandRules = input['commandRules'];
  if (!isBoundedDenseArray(commandRules, 32)) addError(errors, `${path}.commandRules`, 'INVALID_COMMAND_RULES', 'commandRules must be a bounded dense array');
  else {
    const seenRules = new Set<string>();
    commandRules.forEach((entry: unknown, index: number) => {
      const rulePath = `${path}.commandRules[${index}]`;
      if (!isRecord(entry)) {
        addError(errors, rulePath, 'INVALID_TYPE', `${rulePath} must be an object`);
        return;
      }
      rejectUnknownKeys(entry, COMMAND_RULE_KEYS, rulePath, errors);
      validateId(entry['ruleId'], `${rulePath}.ruleId`, errors);
      validateBoundedText(entry['executableRef'], `${rulePath}.executableRef`, errors, 128);
      if (typeof entry['executableRef'] === 'string' && !/^[A-Za-z0-9._-]+$/.test(entry['executableRef'])) {
        addError(errors, `${rulePath}.executableRef`, 'INVALID_EXECUTABLE_REF', 'executableRef must name one executable without shell syntax');
      }
      validateId(entry['workingDirectoryRef'], `${rulePath}.workingDirectoryRef`, errors);
      validatePositiveInteger(entry['timeoutMs'], `${rulePath}.timeoutMs`, errors);
      validatePositiveInteger(entry['maxOutputBytes'], `${rulePath}.maxOutputBytes`, errors);
      const argvPrefix = entry['argvPrefix'];
      if (!isBoundedDenseArray(argvPrefix, 32)) addError(errors, `${rulePath}.argvPrefix`, 'INVALID_ARGV', 'argvPrefix must be a bounded dense array of argument tokens');
      else argvPrefix.forEach((token: unknown, tokenIndex: number) => {
        validateBoundedText(token, `${rulePath}.argvPrefix[${tokenIndex}]`, errors, 4_096);
        if (typeof token === 'string' && /[;&|<>`$\n\r]/u.test(token)) addError(errors, `${rulePath}.argvPrefix[${tokenIndex}]`, 'UNSUPPORTED_SHELL_SYNTAX', 'argument rules cannot contain shell evaluation or chaining syntax');
      });
      if (typeof entry['ruleId'] === 'string') {
        if (seenRules.has(entry['ruleId'])) addError(errors, `${rulePath}.ruleId`, 'DUPLICATE_RULE', 'command rule identifiers must be unique');
        seenRules.add(entry['ruleId']);
      }
      if (typeof entry['timeoutMs'] === 'number' && typeof input['operationDeadlineMs'] === 'number' && entry['timeoutMs'] > input['operationDeadlineMs']) {
        addError(errors, `${rulePath}.timeoutMs`, 'DEADLINE_EXCEEDED', 'command timeout cannot exceed the configured operation deadline');
      }
      if (typeof entry['maxOutputBytes'] === 'number' && typeof input['maxActionBytes'] === 'number' && entry['maxOutputBytes'] > input['maxActionBytes']) {
        addError(errors, `${rulePath}.maxOutputBytes`, 'OUTPUT_BOUND_EXCEEDED', 'command output cannot exceed the configured action byte bound');
      }
    });
    if (isBoundedDenseArray(actionKinds, ACTION_KINDS.length) && actionKinds.includes('run_command') && commandRules.length === 0) {
      addError(errors, `${path}.commandRules`, 'MISSING_COMMAND_RULES', 'run_command requires at least one explicit command rule');
    }
  }

  const diagnosticRules = input['diagnosticRules'];
  if (!isRecord(diagnosticRules)) addError(errors, `${path}.diagnosticRules`, 'MISSING_DIAGNOSTIC_RULES', 'diagnostic rules are required');
  else {
    rejectUnknownKeys(diagnosticRules, DIAGNOSTIC_RULE_KEYS, `${path}.diagnosticRules`, errors);
    validatePositiveInteger(diagnosticRules['maxBytes'], `${path}.diagnosticRules.maxBytes`, errors);
    if (typeof input['maxEventBytes'] === 'number' && typeof diagnosticRules['maxBytes'] === 'number' && diagnosticRules['maxBytes'] > input['maxEventBytes']) {
      addError(errors, `${path}.diagnosticRules.maxBytes`, 'EVENT_BOUND_EXCEEDED', 'diagnostic bound cannot exceed maxEventBytes');
    }
    if (diagnosticRules['redactSecrets'] !== true) addError(errors, `${path}.diagnosticRules.redactSecrets`, 'UNSAFE_DIAGNOSTICS', 'secret redaction must be enabled');
    if (diagnosticRules['allowRawArtifacts'] !== false) addError(errors, `${path}.diagnosticRules.allowRawArtifacts`, 'UNSAFE_DIAGNOSTICS', 'raw artifacts cannot enter diagnostics');
    if (diagnosticRules['retainUnresolvedDecisions'] !== true) addError(errors, `${path}.diagnosticRules.retainUnresolvedDecisions`, 'UNSAFE_RETENTION', 'unresolved decisions must be retained');
  }

  if (
    typeof input['maxPresentationPageBytes'] === 'number' && Number.isSafeInteger(input['maxPresentationPageBytes']) &&
    typeof input['maxPresentationPages'] === 'number' && Number.isSafeInteger(input['maxPresentationPages']) &&
    typeof input['maxPresentationTotalBytes'] === 'number' && Number.isSafeInteger(input['maxPresentationTotalBytes']) &&
    input['maxPresentationTotalBytes'] > input['maxPresentationPageBytes'] * input['maxPresentationPages']
  ) addError(errors, `${path}.maxPresentationTotalBytes`, 'INCONSISTENT_PRESENTATION_BOUNDS', 'total presentation bytes cannot exceed page bytes times page count');

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as PolicyProfile };
}

const SAFE_PRESENTATION_KEYS = [
  'schemaVersion', 'decisionId', 'requestVersion', 'bindingFingerprint', 'elements', 'inspectionRef',
  'presentationDigest', 'page',
] as const;
const PRESENTATION_ELEMENT_KEYS = ['action', 'necessity', 'targets', 'consequences', 'verificationStatus'] as const;
const PRESENTATION_PAGE_KEYS = ['pageNumber', 'pageCount', 'pageBytes', 'totalBytes', 'truncated'] as const;

/** Validate decision elements and page metadata against the profile's text, path and byte limits. */
export function validateSafePresentation(input: unknown, profile: unknown): ValidationResult<SafePresentation> {
  const path = 'safePresentation';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, SAFE_PRESENTATION_KEYS, path, errors);
  validateSchemaVersion(input, errors);
  validateId(input['decisionId'], `${path}.decisionId`, errors);
  validatePositiveInteger(input['requestVersion'], `${path}.requestVersion`, errors);
  validateDigest(input['bindingFingerprint'], `${path}.bindingFingerprint`, errors);
  validateId(input['inspectionRef'], `${path}.inspectionRef`, errors);
  validateDigest(input['presentationDigest'], `${path}.presentationDigest`, errors);

  const profileResult = validatePolicyProfile(profile);
  if (!profileResult.ok) errors.push(...profileResult.errors.map((error) => ({ ...error, path: `profile.${error.path}` })));
  const pageByteCap = profileResult.ok ? profileResult.value.maxPresentationPageBytes : 0;
  const totalByteCap = profileResult.ok ? profileResult.value.maxPresentationTotalBytes : 0;
  const pageCountCap = profileResult.ok ? profileResult.value.maxPresentationPages : 0;

  const elements = input['elements'];
  if (!isRecord(elements)) addError(errors, `${path}.elements`, 'INVALID_TYPE', 'all five decision elements are required');
  else {
    rejectUnknownKeys(elements, PRESENTATION_ELEMENT_KEYS, `${path}.elements`, errors);
    for (const field of ['action', 'necessity', 'consequences', 'verificationStatus'] as const) {
      validateBoundedText(elements[field], `${path}.elements.${field}`, errors, pageByteCap);
    }
    const targets = elements['targets'];
    if (!isBoundedDenseArray(targets, 32) || targets.length === 0) addError(errors, `${path}.elements.targets`, 'INVALID_TARGETS', 'targets must be a nonempty bounded dense array');
    else targets.forEach((target: unknown, index: number) => {
      validateBoundedText(target, `${path}.elements.targets[${index}]`, errors, pageByteCap);
      if (typeof target === 'string' && !SAFE_RELATIVE_PATH_PATTERN.test(target)) addError(errors, `${path}.elements.targets[${index}]`, 'INVALID_TARGET', 'presentation target must be a canonical relative path');
    });
  }

  const page = input['page'];
  if (!isRecord(page)) addError(errors, `${path}.page`, 'INVALID_TYPE', 'page metadata is required');
  else {
    rejectUnknownKeys(page, PRESENTATION_PAGE_KEYS, `${path}.page`, errors);
    for (const field of ['pageNumber', 'pageCount', 'pageBytes', 'totalBytes'] as const) validatePositiveInteger(page[field], `${path}.page.${field}`, errors);
    if (typeof page['truncated'] !== 'boolean') addError(errors, `${path}.page.truncated`, 'INVALID_TYPE', 'truncated must be boolean');
    if (typeof page['pageCount'] === 'number' && page['pageCount'] > pageCountCap) addError(errors, `${path}.page.pageCount`, 'PAGE_COUNT_EXCEEDED', 'page count exceeds the profile bound');
    if (typeof page['pageNumber'] === 'number' && typeof page['pageCount'] === 'number' && page['pageNumber'] > page['pageCount']) {
      addError(errors, `${path}.page.pageNumber`, 'INVALID_PAGE', 'pageNumber cannot exceed pageCount');
    }
    if (typeof page['pageBytes'] === 'number' && page['pageBytes'] > pageByteCap) addError(errors, `${path}.page.pageBytes`, 'PAGE_SIZE_EXCEEDED', 'page bytes exceed the profile bound');
    if (typeof page['totalBytes'] === 'number' && page['totalBytes'] > totalByteCap) addError(errors, `${path}.page.totalBytes`, 'PRESENTATION_SIZE_EXCEEDED', 'total inspectable bytes exceed the profile bound');
    if (typeof page['pageBytes'] === 'number' && typeof page['totalBytes'] === 'number' && page['pageBytes'] > page['totalBytes']) {
      addError(errors, `${path}.page.totalBytes`, 'INVALID_PAGE_SIZE', 'total bytes cannot be less than the current page bytes');
    }
    if (isRecord(elements)) {
      try {
        const actualPageBytes = Buffer.byteLength(JSON.stringify(elements), 'utf8');
        if (typeof page['pageBytes'] === 'number' && page['pageBytes'] < actualPageBytes) {
          addError(errors, `${path}.page.pageBytes`, 'BYTE_COUNT_UNDEREPORTED', 'page byte count cannot understate its UTF-8 decision elements');
        }
      } catch {
        addError(errors, `${path}.elements`, 'INVALID_SERIALIZATION', 'decision elements must be safely serializable');
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as SafePresentation };
}

const SAFE_OUTCOMES: readonly SafeOperationOutcome[] = [
  'ok', 'pending', 'paused', 'denied', 'invalid', 'conflict', 'stale', 'unavailable', 'uncertain',
];
const SAFE_NEXT_ACTIONS: readonly SafeNextAction[] = ['none', 'inspect', 'decide', 'resume', 'revise', 'end', 'retry-read', 'reconcile'];
const SAFE_RESULT_KEYS = [
  'schemaVersion', 'outcome', 'safeReasonCode', 'taskId', 'decisionId', 'controlVersion',
  'requestVersion', 'eventRef', 'safeNextAction',
] as const;
const DECISION_EVENT_KEYS = [
  'schemaVersion', 'eventId', 'taskId', 'runId', 'decisionId', 'directionId', 'claimId',
  'type', 'outcome', 'policyRef', 'safeReasonCode', 'timestamp',
] as const;
const DECISION_EVENT_TYPES: readonly DecisionEventType[] = [
  'approval-request-created', 'human-resolution-recorded', 'binding-assessed', 'developer-direction-recorded',
  'dispatch-claim-created', 'dispatch-effect-observed', 'dispatch-uncertain', 'claim-reconciled',
];

/** Validate safe outcome metadata and require paired decision identity and request version fields. */
export function validateSafeResult(input: unknown): ValidationResult<SafeResult> {
  const path = 'safeResult';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, SAFE_RESULT_KEYS, path, errors);
  validateSchemaVersion(input, errors);
  if (!SAFE_OUTCOMES.includes(input['outcome'] as SafeOperationOutcome)) addError(errors, `${path}.outcome`, 'INVALID_OUTCOME', 'outcome is outside the finite safe-result vocabulary');
  validateId(input['safeReasonCode'], `${path}.safeReasonCode`, errors);
  validateId(input['taskId'], `${path}.taskId`, errors);
  if (input['decisionId'] !== null) validateId(input['decisionId'], `${path}.decisionId`, errors);
  validatePositiveInteger(input['controlVersion'], `${path}.controlVersion`, errors);
  if (input['requestVersion'] !== null) validatePositiveInteger(input['requestVersion'], `${path}.requestVersion`, errors);
  if (input['eventRef'] !== null) validateId(input['eventRef'], `${path}.eventRef`, errors);
  if (!SAFE_NEXT_ACTIONS.includes(input['safeNextAction'] as SafeNextAction)) addError(errors, `${path}.safeNextAction`, 'INVALID_NEXT_ACTION', 'safeNextAction is outside the finite safe vocabulary');
  if ((input['decisionId'] === null) !== (input['requestVersion'] === null)) {
    addError(errors, path, 'INCOMPLETE_REQUEST_IDENTITY', 'decisionId and requestVersion must both be present or both be null');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as SafeResult };
}

/** Validate audit event vocabulary, required references and the profile's serialized event byte cap. */
export function validateDecisionEvent(input: unknown, profile: unknown): ValidationResult<DecisionEvent> {
  const path = 'decisionEvent';
  if (!isRecord(input)) return { ok: false, errors: invalidObject(path) };
  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, DECISION_EVENT_KEYS, path, errors);
  validateSchemaVersion(input, errors);
  validateId(input['eventId'], `${path}.eventId`, errors);
  validateId(input['taskId'], `${path}.taskId`, errors);
  for (const field of ['runId', 'decisionId', 'directionId', 'claimId'] as const) {
    if (input[field] !== null) validateId(input[field], `${path}.${field}`, errors);
  }
  if (!DECISION_EVENT_TYPES.includes(input['type'] as DecisionEventType)) addError(errors, `${path}.type`, 'INVALID_EVENT_TYPE', 'event type is not in the safe audit vocabulary');
  if (!SAFE_OUTCOMES.includes(input['outcome'] as SafeOperationOutcome)) addError(errors, `${path}.outcome`, 'INVALID_OUTCOME', 'event outcome cannot grant authority');
  validatePolicyIdentity(input['policyRef'], `${path}.policyRef`, errors);
  validateId(input['safeReasonCode'], `${path}.safeReasonCode`, errors);
  validateTimestamp(input['timestamp'], `${path}.timestamp`, errors);

  const type = input['type'];
  const referenceRequirements: Readonly<Record<string, 'decisionId' | 'directionId' | 'claimId'>> = {
    'approval-request-created': 'decisionId',
    'human-resolution-recorded': 'decisionId',
    'binding-assessed': 'decisionId',
    'developer-direction-recorded': 'directionId',
    'dispatch-claim-created': 'claimId',
    'dispatch-effect-observed': 'claimId',
    'dispatch-uncertain': 'claimId',
    'claim-reconciled': 'claimId',
  };
  const requiredReference = typeof type === 'string' ? referenceRequirements[type] : undefined;
  if (requiredReference !== undefined && !isIdentifier(input[requiredReference])) {
    addError(errors, `${path}.${requiredReference}`, 'MISSING_EVENT_REFERENCE', `${type} requires its matching identity reference`);
  }
  for (const field of ['decisionId', 'directionId', 'claimId'] as const) {
    if (requiredReference !== field && input[field] !== null) addError(errors, `${path}.${field}`, 'INCOMPATIBLE_EVENT_REFERENCE', `${field} does not apply to this event type`);
  }

  const profileResult = validatePolicyProfile(profile);
  if (!profileResult.ok) errors.push(...profileResult.errors.map((error) => ({ ...error, path: `profile.${error.path}` })));
  else {
    try {
      const bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
      if (bytes > profileResult.value.maxEventBytes) addError(errors, path, 'EVENT_SIZE_EXCEEDED', 'serialized event exceeds the configured byte bound');
    } catch {
      addError(errors, path, 'INVALID_SERIALIZATION', 'event must be safely serializable');
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input as unknown as DecisionEvent };
}
