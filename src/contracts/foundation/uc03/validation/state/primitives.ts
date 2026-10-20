/** Task envelope, node, outcome, step, and fix-plan validation. */

import type { EnvelopeOutcome, FixPlan, PlanStep, PlanStepStatus, TaskEnvelope, TaskNode, TaskOutcome, ValidationError, ValidationResult } from '../../types.ts';
import { CONTRACT_VERSION, ENVELOPE_OUTCOMES, PLAN_STEP_STATUSES, TASK_NODES, TASK_OUTCOMES } from '../../types.ts';
import { isPlainObject, rejectUnknownKeys, validateNonEmptyString, validateNonNegativeInteger, validatePositiveInteger } from '../common.ts';

const TASK_ENVELOPE_ALLOWED_KEYS = [
  'schemaVersion',
  'requestId',
  'taskId',
  'runId',
  'workspaceId',
  'expectedStateVersion',
  'repositoryRevisionDigest',
  'trustedConfigId',
] as const;

export function validateTaskEnvelope(input: unknown): ValidationResult<TaskEnvelope> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path: 'envelope', message: 'TaskEnvelope must be an object', code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, TASK_ENVELOPE_ALLOWED_KEYS, '', errors);

  const schemaVersion = validateNonEmptyString(input['schemaVersion'], 'schemaVersion', errors);
  if (schemaVersion && schemaVersion !== CONTRACT_VERSION) {
    errors.push({
      path: 'schemaVersion',
      message: `schemaVersion must match current contract version ${CONTRACT_VERSION}`,
      code: 'SCHEMA_VERSION_MISMATCH',
    });
  }

  const requestId = validateNonEmptyString(input['requestId'], 'requestId', errors);
  const taskId = validateNonEmptyString(input['taskId'], 'taskId', errors);
  const runId = validateNonEmptyString(input['runId'], 'runId', errors);
  const workspaceId = validateNonEmptyString(input['workspaceId'], 'workspaceId', errors);
  const expectedStateVersion = validateNonNegativeInteger(
    input['expectedStateVersion'],
    'expectedStateVersion',
    errors
  );
  const repositoryRevisionDigest = validateNonEmptyString(
    input['repositoryRevisionDigest'],
    'repositoryRevisionDigest',
    errors
  );
  const trustedConfigId = validateNonEmptyString(input['trustedConfigId'], 'trustedConfigId', errors);

  if (
    errors.length > 0 ||
    !schemaVersion ||
    schemaVersion !== CONTRACT_VERSION ||
    !requestId ||
    !taskId ||
    !runId ||
    !workspaceId ||
    expectedStateVersion === undefined ||
    !repositoryRevisionDigest ||
    !trustedConfigId
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      schemaVersion,
      requestId,
      taskId,
      runId,
      workspaceId,
      expectedStateVersion,
      repositoryRevisionDigest,
      trustedConfigId,
    },
  };
}

export function validateTaskNode(input: unknown): ValidationResult<TaskNode> {
  if (typeof input !== 'string') {
    return {
      ok: false,
      errors: [{ path: 'node', message: 'node must be a string', code: 'INVALID_TYPE' }],
    };
  }
  if (!TASK_NODES.includes(input as TaskNode)) {
    return {
      ok: false,
      errors: [
        {
          path: 'node',
          message: `node must be one of: ${TASK_NODES.join(', ')}`,
          code: 'INVALID_NODE',
        },
      ],
    };
  }
  return { ok: true, value: input as TaskNode };
}

export function validateTaskOutcome(input: unknown): ValidationResult<TaskOutcome> {
  if (typeof input !== 'string') {
    return {
      ok: false,
      errors: [{ path: 'outcome', message: 'TaskOutcome must be a string', code: 'INVALID_TYPE' }],
    };
  }
  if (!TASK_OUTCOMES.includes(input as TaskOutcome)) {
    return {
      ok: false,
      errors: [
        {
          path: 'outcome',
          message: `TaskOutcome must be one of: ${TASK_OUTCOMES.join(', ')}`,
          code: 'INVALID_OUTCOME',
        },
      ],
    };
  }
  return { ok: true, value: input as TaskOutcome };
}

export function validateEnvelopeOutcome(input: unknown): ValidationResult<EnvelopeOutcome> {
  if (typeof input !== 'string') {
    return {
      ok: false,
      errors: [
        {
          path: 'envelopeOutcome',
          message: 'EnvelopeOutcome must be a string',
          code: 'INVALID_TYPE',
        },
      ],
    };
  }
  if (!ENVELOPE_OUTCOMES.includes(input as EnvelopeOutcome)) {
    return {
      ok: false,
      errors: [
        {
          path: 'envelopeOutcome',
          message: `EnvelopeOutcome must be one of: ${ENVELOPE_OUTCOMES.join(', ')}`,
          code: 'INVALID_ENVELOPE_OUTCOME',
        },
      ],
    };
  }
  return { ok: true, value: input as EnvelopeOutcome };
}

const PLAN_STEP_ALLOWED_KEYS = [
  'stepId',
  'description',
  'status',
  'actionRefs',
  'evidenceRefs',
] as const;

export function validatePlanStep(input: unknown, path = 'planStep'): ValidationResult<PlanStep> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, PLAN_STEP_ALLOWED_KEYS, path, errors);

  const stepId = validateNonEmptyString(input['stepId'], `${path}.stepId`, errors);
  const description = validateNonEmptyString(input['description'], `${path}.description`, errors);

  const status = input['status'] as PlanStepStatus;
  if (!PLAN_STEP_STATUSES.includes(status)) {
    errors.push({
      path: `${path}.status`,
      message: `${path}.status must be one of: ${PLAN_STEP_STATUSES.join(', ')}`,
      code: 'INVALID_STEP_STATUS',
    });
  }

  if (!Array.isArray(input['actionRefs'])) {
    errors.push({
      path: `${path}.actionRefs`,
      message: `${path}.actionRefs must be an array of strings`,
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input['actionRefs'].length; i++) {
      if (typeof input['actionRefs'][i] !== 'string') {
        errors.push({
          path: `${path}.actionRefs[${i}]`,
          message: `${path}.actionRefs[${i}] must be a string`,
          code: 'INVALID_TYPE',
        });
      }
    }
  }

  if (!Array.isArray(input['evidenceRefs'])) {
    errors.push({
      path: `${path}.evidenceRefs`,
      message: `${path}.evidenceRefs must be an array of strings`,
      code: 'INVALID_TYPE',
    });
  } else {
    for (let i = 0; i < input['evidenceRefs'].length; i++) {
      if (typeof input['evidenceRefs'][i] !== 'string') {
        errors.push({
          path: `${path}.evidenceRefs[${i}]`,
          message: `${path}.evidenceRefs[${i}] must be a string`,
          code: 'INVALID_TYPE',
        });
      }
    }
  }

  if (
    errors.length > 0 ||
    !stepId ||
    !description ||
    !PLAN_STEP_STATUSES.includes(status) ||
    !Array.isArray(input['actionRefs']) ||
    !Array.isArray(input['evidenceRefs'])
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      stepId,
      description,
      status,
      actionRefs: input['actionRefs'] as readonly string[],
      evidenceRefs: input['evidenceRefs'] as readonly string[],
    },
  };
}

const FIX_PLAN_ALLOWED_KEYS = [
  'planVersion',
  'diagnosis',
  'suspectedCauseLocations',
  'evidenceRefs',
  'strategy',
  'scopedChanges',
  'checkSetDigest',
  'baselineRef',
  'strategyDigest',
  'decisionRef',
] as const;

export function validateFixPlan(input: unknown, path = 'fixPlan'): ValidationResult<FixPlan> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      errors: [{ path, message: `${path} must be an object`, code: 'INVALID_TYPE' }],
    };
  }

  const errors: ValidationError[] = [];
  rejectUnknownKeys(input, FIX_PLAN_ALLOWED_KEYS, path, errors);

  const planVersion = validatePositiveInteger(input['planVersion'], `${path}.planVersion`, errors);
  const diagnosis = validateNonEmptyString(input['diagnosis'], `${path}.diagnosis`, errors);
  const strategy = validateNonEmptyString(input['strategy'], `${path}.strategy`, errors);
  const checkSetDigest = validateNonEmptyString(input['checkSetDigest'], `${path}.checkSetDigest`, errors);
  const baselineRef = validateNonEmptyString(input['baselineRef'], `${path}.baselineRef`, errors);
  const strategyDigest = validateNonEmptyString(input['strategyDigest'], `${path}.strategyDigest`, errors);

  let decisionRef: string | undefined;
  if (input['decisionRef'] !== undefined) {
    decisionRef = validateNonEmptyString(input['decisionRef'], `${path}.decisionRef`, errors);
  }

  if (!Array.isArray(input['suspectedCauseLocations'])) {
    errors.push({
      path: `${path}.suspectedCauseLocations`,
      message: `${path}.suspectedCauseLocations must be an array of location strings`,
      code: 'INVALID_TYPE',
    });
  } else if (input['suspectedCauseLocations'].length === 0) {
    errors.push({
      path: `${path}.suspectedCauseLocations`,
      message: `${path}.suspectedCauseLocations must contain at least one location`,
      code: 'EMPTY_CAUSE_LOCATIONS',
    });
  } else {
    for (let i = 0; i < input['suspectedCauseLocations'].length; i++) {
      validateNonEmptyString(input['suspectedCauseLocations'][i], `${path}.suspectedCauseLocations[${i}]`, errors);
    }
  }

  if (!Array.isArray(input['evidenceRefs'])) {
    errors.push({
      path: `${path}.evidenceRefs`,
      message: `${path}.evidenceRefs must be an array of evidence references`,
      code: 'INVALID_TYPE',
    });
  } else if (input['evidenceRefs'].length === 0) {
    errors.push({
      path: `${path}.evidenceRefs`,
      message: `${path}.evidenceRefs must contain at least one evidence reference`,
      code: 'EMPTY_EVIDENCE_REFS',
    });
  } else {
    for (let i = 0; i < input['evidenceRefs'].length; i++) {
      validateNonEmptyString(input['evidenceRefs'][i], `${path}.evidenceRefs[${i}]`, errors);
    }
  }

  if (!Array.isArray(input['scopedChanges'])) {
    errors.push({
      path: `${path}.scopedChanges`,
      message: `${path}.scopedChanges must be an array of file/module paths`,
      code: 'INVALID_TYPE',
    });
  } else if (input['scopedChanges'].length === 0) {
    errors.push({
      path: `${path}.scopedChanges`,
      message: `${path}.scopedChanges must contain at least one targeted path`,
      code: 'EMPTY_SCOPED_CHANGES',
    });
  } else {
    for (let i = 0; i < input['scopedChanges'].length; i++) {
      validateNonEmptyString(input['scopedChanges'][i], `${path}.scopedChanges[${i}]`, errors);
    }
  }

  if (
    errors.length > 0 ||
    planVersion === undefined ||
    !diagnosis ||
    !strategy ||
    !checkSetDigest ||
    !baselineRef ||
    !strategyDigest ||
    !Array.isArray(input['suspectedCauseLocations']) ||
    input['suspectedCauseLocations'].length === 0 ||
    !Array.isArray(input['evidenceRefs']) ||
    input['evidenceRefs'].length === 0 ||
    !Array.isArray(input['scopedChanges']) ||
    input['scopedChanges'].length === 0
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      planVersion,
      diagnosis,
      suspectedCauseLocations: input['suspectedCauseLocations'] as readonly string[],
      evidenceRefs: input['evidenceRefs'] as readonly string[],
      strategy,
      scopedChanges: input['scopedChanges'] as readonly string[],
      checkSetDigest,
      baselineRef,
      strategyDigest,
      ...(decisionRef !== undefined ? { decisionRef } : {}),
    },
  };
}
