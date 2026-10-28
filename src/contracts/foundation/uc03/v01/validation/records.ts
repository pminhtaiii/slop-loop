/** Workspace, run, activity, and delivery record validation. */

import { isCanonicalRelativePath, isProtectedPath } from '../../identity.ts';
import type { ActivityEvent, Delivery, DeliveryValidationContext, Run, TaskWorkspace, TaskWorkspaceValidationContext, ValidationError, ValidationResult } from '../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonNegativeInteger, validateStringArray } from './common.ts';
import { validateProviderUsage } from './provider.ts';
import { validateTaskOutcome } from './state.ts';

export function validateTaskWorkspace(
  input: unknown,
  context?: TaskWorkspaceValidationContext,
  path = 'taskWorkspace'
): ValidationResult<TaskWorkspace> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = [
    'taskId',
    'workspaceId',
    'containerImageDigest',
    'repoVolumeId',
    'scratchVolumeId',
    'expectedRepoState',
  ];
  rejectUnknownKeys(input, allowedKeys, path, errors);
  for (const field of ['expectedRepoState']) {
    if (input[field] === undefined) errors.push({ path: `${path}.${field}`, message: `${path}.${field} is required`, code: 'REQUIRED_FIELD' });
  }

  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    errors.push({
      path: `${path}.taskId`,
      message: `${path}.taskId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.workspaceId !== 'string' || input.workspaceId.trim().length === 0) {
    errors.push({
      path: `${path}.workspaceId`,
      message: `${path}.workspaceId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.containerImageDigest !== 'string' || input.containerImageDigest.trim().length === 0) {
    errors.push({
      path: `${path}.containerImageDigest`,
      message: `${path}.containerImageDigest must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.repoVolumeId !== 'string' || input.repoVolumeId.trim().length === 0) {
    errors.push({
      path: `${path}.repoVolumeId`,
      message: `${path}.repoVolumeId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.scratchVolumeId !== 'string' || input.scratchVolumeId.trim().length === 0) {
    errors.push({
      path: `${path}.scratchVolumeId`,
      message: `${path}.scratchVolumeId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.expectedRepoState !== undefined && (typeof input.expectedRepoState !== 'string' || input.expectedRepoState.trim().length === 0)) {
    errors.push({
      path: `${path}.expectedRepoState`,
      message: `${path}.expectedRepoState must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (context !== undefined) {
    if (context.expectedTaskId !== undefined && input.taskId !== context.expectedTaskId) {
      errors.push({
        path: `${path}.taskId`,
        message: `Task ID mismatch: expected ${context.expectedTaskId}, got ${input.taskId}`,
        code: 'TASK_ID_MISMATCH',
      });
    }
    if (context.expectedWorkspaceId !== undefined && input.workspaceId !== context.expectedWorkspaceId) {
      errors.push({
        path: `${path}.workspaceId`,
        message: `Workspace ID mismatch: expected ${context.expectedWorkspaceId}, got ${input.workspaceId}`,
        code: 'WORKSPACE_ID_MISMATCH',
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as TaskWorkspace };
}

export function validateRun(input: unknown, path = 'run'): ValidationResult<Run> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = ['runId', 'taskId', 'startTime', 'endTime', 'totalUsage', 'outcome'];
  rejectUnknownKeys(input, allowedKeys, path, errors);

  if (typeof input.runId !== 'string' || input.runId.trim().length === 0) {
    errors.push({
      path: `${path}.runId`,
      message: `${path}.runId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    errors.push({
      path: `${path}.taskId`,
      message: `${path}.taskId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.startTime !== 'string' || Number.isNaN(Date.parse(input.startTime))) {
    errors.push({
      path: `${path}.startTime`,
      message: `${path}.startTime must be a valid ISO 8601 date string`,
      code: 'INVALID_TIMESTAMP',
    });
  }

  if (input.endTime !== undefined && (typeof input.endTime !== 'string' || Number.isNaN(Date.parse(input.endTime)))) {
    errors.push({
      path: `${path}.endTime`,
      message: `${path}.endTime must be a valid ISO 8601 date string`,
      code: 'INVALID_TIMESTAMP',
    });
  }

  if (input.totalUsage !== undefined) {
    const usageRes = validateProviderUsage(input.totalUsage);
    if (!usageRes.ok) {
      errors.push(...usageRes.errors);
    }
  }

  if (input.outcome !== undefined) {
    const outcomeRes = validateTaskOutcome(input.outcome);
    if (!outcomeRes.ok) {
      errors.push(...outcomeRes.errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as Run };
}

export function validateActivityEvent(input: unknown, path = 'activityEvent'): ValidationResult<ActivityEvent> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = [
    'eventId',
    'taskId',
    'runId',
    'timestamp',
    'node',
    'actionType',
    'outcome',
    'durationMs',
    'evidenceRefs',
  ];
  rejectUnknownKeys(input, allowedKeys, path, errors);
  for (const field of ['outcome', 'durationMs', 'evidenceRefs']) {
    if (input[field] === undefined) errors.push({ path: `${path}.${field}`, message: `${path}.${field} is required`, code: 'REQUIRED_FIELD' });
  }

  if (typeof input.eventId !== 'string' || input.eventId.trim().length === 0) {
    errors.push({
      path: `${path}.eventId`,
      message: `${path}.eventId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    errors.push({
      path: `${path}.taskId`,
      message: `${path}.taskId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.runId !== 'string' || input.runId.trim().length === 0) {
    errors.push({
      path: `${path}.runId`,
      message: `${path}.runId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.timestamp !== 'string' || Number.isNaN(Date.parse(input.timestamp))) {
    errors.push({
      path: `${path}.timestamp`,
      message: `${path}.timestamp must be a valid ISO 8601 date string`,
      code: 'INVALID_TIMESTAMP',
    });
  }

  if (typeof input.node !== 'string' || input.node.trim().length === 0) {
    errors.push({
      path: `${path}.node`,
      message: `${path}.node must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.actionType !== 'string' || input.actionType.trim().length === 0) {
    errors.push({
      path: `${path}.actionType`,
      message: `${path}.actionType must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.outcome !== undefined && (typeof input.outcome !== 'string' || input.outcome.trim().length === 0)) {
    errors.push({
      path: `${path}.outcome`,
      message: `${path}.outcome must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.durationMs !== undefined) {
    validateNonNegativeInteger(input.durationMs, `${path}.durationMs`, errors);
  }

  if (input.evidenceRefs !== undefined) {
    validateStringArray(input.evidenceRefs, `${path}.evidenceRefs`, errors, { allowEmpty: true });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as ActivityEvent };
}

export function validateDelivery(
  input: unknown,
  context?: DeliveryValidationContext,
  path = 'delivery'
): ValidationResult<Delivery> {
  const errors: ValidationError[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }] };
  }

  const allowedKeys = [
    'taskId',
    'runId',
    'outcome',
    'diffDigest',
    'changedFiles',
    'baselineRef',
    'verificationRefs',
    'reviewRef',
    'limitations',
    'safeNextAction',
  ];
  rejectUnknownKeys(input, allowedKeys, path, errors);
  for (const field of ['diffDigest', 'changedFiles', 'baselineRef', 'verificationRefs', 'reviewRef', 'limitations', 'safeNextAction']) {
    if (input[field] === undefined) errors.push({ path: `${path}.${field}`, message: `${path}.${field} is required`, code: 'REQUIRED_FIELD' });
  }

  if (typeof input.taskId !== 'string' || input.taskId.trim().length === 0) {
    errors.push({
      path: `${path}.taskId`,
      message: `${path}.taskId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (typeof input.runId !== 'string' || input.runId.trim().length === 0) {
    errors.push({
      path: `${path}.runId`,
      message: `${path}.runId must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  const outcomeRes = validateTaskOutcome(input.outcome);
  if (!outcomeRes.ok) {
    errors.push(...outcomeRes.errors);
  }

  if (input.diffDigest !== undefined && (typeof input.diffDigest !== 'string' || input.diffDigest.trim().length === 0)) {
    errors.push({
      path: `${path}.diffDigest`,
      message: `${path}.diffDigest must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.changedFiles !== undefined) {
    if (!Array.isArray(input.changedFiles)) {
      errors.push({
        path: `${path}.changedFiles`,
        message: `${path}.changedFiles must be an array of paths`,
        code: 'INVALID_TYPE',
      });
    } else {
      if (input.outcome === 'COMPLETED' && input.changedFiles.length === 0) {
        errors.push({
          path: `${path}.changedFiles`,
          message: `${path}.changedFiles cannot be empty for COMPLETED outcome`,
          code: 'ARRAY_EMPTY',
        });
      }
      for (let i = 0; i < input.changedFiles.length; i++) {
        const file = input.changedFiles[i];
        if (typeof file !== 'string' || !isCanonicalRelativePath(file) || isProtectedPath(file)) {
          errors.push({
            path: `${path}.changedFiles[${i}]`,
            message: `${path}.changedFiles[${i}] must be a canonical non-protected repository-relative path`,
            code: 'INVALID_CANONICAL_PATH',
          });
        }
      }
    }
  }

  if (input.baselineRef !== undefined && (typeof input.baselineRef !== 'string' || input.baselineRef.trim().length === 0)) {
    errors.push({
      path: `${path}.baselineRef`,
      message: `${path}.baselineRef must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.verificationRefs !== undefined) {
    if (!Array.isArray(input.verificationRefs)) {
      errors.push({
        path: `${path}.verificationRefs`,
        message: `${path}.verificationRefs must be an array of strings`,
        code: 'INVALID_TYPE',
      });
    } else {
      if (input.outcome === 'COMPLETED' && input.verificationRefs.length === 0) {
        errors.push({
          path: `${path}.verificationRefs`,
          message: `${path}.verificationRefs cannot be empty for COMPLETED outcome`,
          code: 'ARRAY_EMPTY',
        });
      }
      for (let i = 0; i < input.verificationRefs.length; i++) {
        const ref = input.verificationRefs[i];
        if (typeof ref !== 'string' || ref.trim().length === 0) {
          errors.push({
            path: `${path}.verificationRefs[${i}]`,
            message: `${path}.verificationRefs[${i}] must be a non-empty string`,
            code: 'INVALID_STRING',
          });
        }
      }
    }
  }

  if (input.reviewRef !== undefined && (typeof input.reviewRef !== 'string' || input.reviewRef.trim().length === 0)) {
    errors.push({
      path: `${path}.reviewRef`,
      message: `${path}.reviewRef must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (input.limitations !== undefined) {
    validateStringArray(input.limitations, `${path}.limitations`, errors, { allowEmpty: true });
  }

  if (input.safeNextAction !== undefined && (typeof input.safeNextAction !== 'string' || input.safeNextAction.trim().length === 0)) {
    errors.push({
      path: `${path}.safeNextAction`,
      message: `${path}.safeNextAction must be a non-empty string`,
      code: 'INVALID_STRING',
    });
  }

  if (context !== undefined) {
    if (context.expectedDiffDigest !== undefined && input.diffDigest !== context.expectedDiffDigest) errors.push({ path: 'diffDigest', message: 'Expected identity mismatch', code: 'IDENTITY_MISMATCH' });
    if (context.expectedBaselineRef !== undefined && input.baselineRef !== context.expectedBaselineRef) errors.push({ path: 'baselineRef', message: 'Expected identity mismatch', code: 'IDENTITY_MISMATCH' });
    if (context.expectedReviewRef !== undefined && input.reviewRef !== context.expectedReviewRef) errors.push({ path: 'reviewRef', message: 'Expected identity mismatch', code: 'IDENTITY_MISMATCH' });
    if (context.expectedTaskId !== undefined && input.taskId !== context.expectedTaskId) {
      errors.push({
        path: `${path}.taskId`,
        message: `Task ID mismatch: expected ${context.expectedTaskId}, got ${input.taskId}`,
        code: 'TASK_ID_MISMATCH',
      });
    }
    if (context.expectedRunId !== undefined && input.runId !== context.expectedRunId) {
      errors.push({
        path: `${path}.runId`,
        message: `Run ID mismatch: expected ${context.expectedRunId}, got ${input.runId}`,
        code: 'RUN_ID_MISMATCH',
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: input as unknown as Delivery };
}
