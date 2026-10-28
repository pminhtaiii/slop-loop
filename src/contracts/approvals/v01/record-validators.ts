import type { ValidationError, ValidationResult } from '../../foundation/uc03.ts';
import { parseApprovalBinding } from '../../foundation/uc03.ts';
import type { ApprovalTaskControl, ApprovalRequestRecord, HumanResolutionValidationContext, HumanResolution, BindingAssessmentValidationContext, BindingAssessment, DeveloperDirectionValidationContext, DeveloperDirection } from './types.ts';
import { TASK_CONTROL_KEYS, TASK_CONTROL_MODES, addError, invalidObject, isIdentifier, isRecord, rejectUnknownKeys, validateDigest, validateId, validateIdArray, validatePositiveInteger, validateSchemaVersion, validateTimestamp } from './validation.ts';

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
