import type { ValidationError, ValidationResult } from '../../foundation/uc03.ts';
import type { DecisionEvent, DecisionEventType, SafeNextAction, SafeOperationOutcome, SafePresentation, SafeResult } from './types.ts';
import { validatePolicyProfile } from './policy-validator.ts';
import { validatePolicyIdentity } from './claim-validator.ts';
import { SAFE_RELATIVE_PATH_PATTERN, addError, invalidObject, isBoundedDenseArray, isIdentifier, isRecord, rejectUnknownKeys, validateBoundedText, validateDigest, validateId, validatePositiveInteger, validateSchemaVersion, validateTimestamp } from './validation.ts';

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

/* =========================================================================
 * UC-05 v0.2.0 Receipt Types, Digest Helpers, and Validators (T043 RED)
 * ========================================================================= */
