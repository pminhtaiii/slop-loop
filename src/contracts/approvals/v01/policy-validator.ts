import type { ValidationError, ValidationResult } from '../../foundation/uc03.ts';
import type { PolicyProfile } from './types.ts';
import { validatePolicyIdentity } from './claim-validator.ts';
import { SAFE_RELATIVE_PATH_PATTERN, addError, invalidObject, isBoundedDenseArray, isRecord, rejectUnknownKeys, validateBoundedText, validateId, validatePositiveInteger, validateSchemaVersion } from './validation.ts';

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
