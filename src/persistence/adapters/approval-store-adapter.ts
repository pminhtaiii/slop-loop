import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalStore, StoreResponse } from '../../approvals/service-data.ts';
import {
  type ApprovalRequestRecord,
  type ApprovalTaskControl,
  type DecisionEvent,
  type DeveloperDirection,
  type HumanResolution,
  type PolicyProfile,
  validateApprovalRequestRecord,
  validateApprovalTaskControl,
  validateDecisionEvent,
  validateDeveloperDirection,
  validateHumanResolution,
  validatePolicyProfile,
} from '../../contracts/approvals/contracts.ts';
import type { DurableStore } from '../store.ts';

import {
  DEFAULT_POLICY_PROFILE,
  type DurableApprovalStoreOptions,
  type EventAppendResult,
  type StoredHistory,
  type StorePayload,
  checkDirectionPreconditions,
  checkReplacePreconditions,
  checkResolvePreconditions,
  decisionDir,
  isSafeId,
  makeFailure,
  makeInitialControl,
  makeResponse,
  parseStoredHistory,
  taskDir,
  writeJsonAtomic,
} from './approval-types.ts';
import { appendEvent, readEvents } from './approval-events.ts';

/** Durable file-backed approval store adapter implementing UC-05 contracts. */
export class DurableApprovalStore implements ApprovalStore {
  readonly provenance = 'mock' as const;
  private readonly storageDir: string;
  readonly durableStore?: DurableStore | undefined;
  readonly profile: PolicyProfile;

  /** Initializes DurableApprovalStore with isolated directory and policy profile. */
  constructor(options: DurableApprovalStoreOptions) {
    this.storageDir = options.storageDir;
    this.durableStore = options.durableStore;
    if (options.profile === undefined) {
      this.profile = DEFAULT_POLICY_PROFILE;
    } else {
      const profRes = validatePolicyProfile(options.profile);
      if (!profRes.ok) {
        const msg = profRes.errors.map((e) => e.message).join('; ');
        throw new Error(`Invalid policy profile: ${msg}`);
      }
      this.profile = profRes.value;
    }
    mkdirSync(this.storageDir, { recursive: true });
  }

  /** Loads or initializes task control metadata. */
  loadTaskControl(taskId: string): StoreResponse<ApprovalTaskControl> {
    if (!isSafeId(taskId)) return makeFailure<ApprovalTaskControl>('unknown', 1, 'denied', 'invalid-id');
    const filePath = join(taskDir(this.storageDir, taskId), 'control.json');
    if (!existsSync(filePath)) {
      const defaultControl = makeInitialControl(taskId);
      writeJsonAtomic(filePath, defaultControl);
      return makeResponse(defaultControl, 'ok', 'initial-control-created', defaultControl);
    }

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      const validation = validateApprovalTaskControl(raw);
      if (!validation.ok) return makeFailure<ApprovalTaskControl>(taskId, 1, 'denied', 'invalid-stored-control');
      return makeResponse(validation.value, 'ok', 'task-control-loaded', validation.value);
    } catch {
      return makeFailure<ApprovalTaskControl>(taskId, 1, 'unavailable', 'read-error');
    }
  }

  private readTaskControl(taskId: string): StoreResponse<ApprovalTaskControl> {
    if (!isSafeId(taskId)) return makeFailure<ApprovalTaskControl>('unknown', 1, 'denied', 'invalid-id');
    const filePath = join(taskDir(this.storageDir, taskId), 'control.json');
    if (!existsSync(filePath)) return makeFailure<ApprovalTaskControl>(taskId, 1, 'denied', 'control-not-found');
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      const validation = validateApprovalTaskControl(raw);
      if (!validation.ok) return makeFailure<ApprovalTaskControl>(taskId, 1, 'denied', 'invalid-stored-control');
      return makeResponse(validation.value, 'ok', 'task-control-loaded', validation.value);
    } catch {
      return makeFailure<ApprovalTaskControl>(taskId, 1, 'unavailable', 'read-error');
    }
  }

  /** Reads an approval request record by decisionId. */
  readRequest(decisionId: string): StoreResponse<ApprovalRequestRecord> {
    if (!isSafeId(decisionId)) return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-id', decisionId);
    const filePath = join(decisionDir(this.storageDir, decisionId), 'request.json');
    if (!existsSync(filePath)) return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'request-not-found', decisionId);

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      const val = validateApprovalRequestRecord(raw);
      if (!val.ok) return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-stored-request', decisionId);
      const req = val.value;
      return makeResponse({ taskId: req.taskId, version: 1 }, 'ok', 'request-loaded', req, decisionId, req.requestVersion);
    } catch {
      return makeFailure<ApprovalRequestRecord>('unknown', 1, 'unavailable', 'read-error', decisionId);
    }
  }

  /** Reads resolution and direction history for a task. */
  readHistory(taskId: string): StoreResponse<StoredHistory> {
    if (!isSafeId(taskId)) return makeFailure<StoredHistory>('unknown', 1, 'denied', 'invalid-id');
    const filePath = join(taskDir(this.storageDir, taskId), 'history.json');
    if (!existsSync(filePath)) {
      return makeResponse({ taskId, version: 1 }, 'ok', 'empty-history', { resolutions: [], directions: [], assessments: [], claims: [] });
    }

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      return parseStoredHistory(raw, taskId);
    } catch {
      return makeFailure<StoredHistory>(taskId, 1, 'unavailable', 'read-error');
    }
  }

  /** Reads decision events for a task. */
  readEvents(taskId: string): StoreResponse<readonly DecisionEvent[]> {
    return readEvents(this.storageDir, taskId, this.profile);
  }

  /** Creates a pending approval request and transitions task to waiting mode. */
  createPendingAndPause(input: unknown): StoreResponse<ApprovalRequestRecord> {
    if (!input || typeof input !== 'object') return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-input');

    const payload = input as StorePayload;

    const validReq = validateApprovalRequestRecord(payload.request);
    if (!validReq.ok) return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-request');
    const request = validReq.value;

    const currentControlRes = this.loadTaskControl(request.taskId);
    if (currentControlRes.safe.outcome !== 'ok' || !currentControlRes.value) {
      return makeFailure<ApprovalRequestRecord>(request.taskId, 1, 'denied', 'control-unavailable');
    }
    const currentControl = currentControlRes.value;

    if (payload.expectedControlVersion !== undefined && currentControl.version !== payload.expectedControlVersion) {
      return makeFailure<ApprovalRequestRecord>(request.taskId, currentControl.version, 'conflict', 'version-conflict', request.decisionId);
    }
    if (currentControl.mode !== 'runnable') {
      return makeFailure<ApprovalRequestRecord>(request.taskId, currentControl.version, 'conflict', 'task-not-runnable', request.decisionId);
    }
    const decPath = decisionDir(this.storageDir, request.decisionId);
    if (existsSync(join(decPath, 'request.json'))) {
      return makeFailure<ApprovalRequestRecord>(request.taskId, currentControl.version, 'conflict', 'decision-id-in-use', request.decisionId);
    }

    const updatedControl: ApprovalTaskControl = {
      ...currentControl,
      version: currentControl.version + 1,
      epoch: currentControl.epoch + 1,
      mode: 'waiting',
      pendingDecisionId: request.decisionId,
      continuationRef: request.continuationRef,
      reasonCode: 'waiting-approval',
    };

    const reqPath = join(decPath, 'request.json');
    try {
      writeJsonAtomic(reqPath, request);
      const evRes = this.appendEvent(request.taskId, payload.event);
      if (!evRes.ok) {
        rmSync(reqPath, { force: true });
        return makeFailure<ApprovalRequestRecord>(request.taskId, currentControl.version, evRes.error, evRes.reason, request.decisionId);
      }
      writeJsonAtomic(join(taskDir(this.storageDir, request.taskId), 'control.json'), updatedControl);
    } catch {
      rmSync(reqPath, { force: true });
      return makeFailure<ApprovalRequestRecord>(request.taskId, currentControl.version, 'unavailable', 'storage-error', request.decisionId);
    }

    return makeResponse(updatedControl, 'ok', 'pending-created', request, request.decisionId, request.requestVersion);
  }

  /** Resolves a pending decision with trusted operator decision. */
  resolvePending(input: unknown): StoreResponse<HumanResolution> {
    if (!input || typeof input !== 'object') return makeFailure<HumanResolution>('unknown', 1, 'denied', 'invalid-input');

    const payload = input as StorePayload;

    const rawResponse = payload.trustedResponse as Record<string, unknown> | undefined;
    const decisionId = typeof rawResponse?.['decisionId'] === 'string' ? rawResponse['decisionId'] : '';

    const reqRes = this.readRequest(decisionId);
    if (reqRes.safe.outcome !== 'ok' || !reqRes.value) {
      return makeFailure<HumanResolution>('unknown', 1, 'denied', 'decision-not-found', decisionId);
    }
    const request = reqRes.value;

    const currentControlRes = this.readTaskControl(request.taskId);
    if (currentControlRes.safe.outcome !== 'ok' || !currentControlRes.value) {
      return makeFailure<HumanResolution>(request.taskId, 1, 'denied', 'control-unavailable', decisionId);
    }
    const currentControl = currentControlRes.value;

    const preErr = checkResolvePreconditions(currentControl, request, payload);
    if (preErr) {
      const outcome = preErr === 'missing-trusted-operator' ? 'denied' : 'conflict';
      return makeFailure<HumanResolution>(request.taskId, currentControl.version, outcome, preErr, decisionId, request.requestVersion);
    }

    const validResponse = validateHumanResolution(payload.trustedResponse, {
      expectedDecisionId: request.decisionId,
      expectedRequestVersion: request.requestVersion,
      trustedOperator: payload.trustedOperator,
    });
    if (!validResponse.ok) return makeFailure<HumanResolution>(request.taskId, currentControl.version, 'denied', 'invalid-resolution', decisionId);
    const resolution = validResponse.value;

    const historyRes = this.readHistory(request.taskId);
    if (historyRes.safe.outcome !== 'ok' || !historyRes.value) {
      return makeFailure<HumanResolution>(request.taskId, currentControl.version, 'unavailable', 'history-unavailable', decisionId);
    }

    const priorResolution = historyRes.value.resolutions.find((r) => r.decisionId === resolution.decisionId);
    if (priorResolution !== undefined && priorResolution.responseKey !== resolution.responseKey) {
      return makeFailure<HumanResolution>(request.taskId, currentControl.version, 'conflict', 'decision-not-pending', decisionId);
    }

    const nextMode = resolution.decision === 'approved' ? 'runnable' : 'rejected';
    const updatedControl: ApprovalTaskControl = {
      ...currentControl,
      version: currentControl.version + 1,
      epoch: currentControl.epoch + 1,
      mode: nextMode,
      pendingDecisionId: null,
      continuationRef: null,
      reasonCode: resolution.decision === 'approved' ? 'developer-approved' : 'developer-rejected',
    };

    if (priorResolution === undefined) {
      const evRes = this.appendEvent(request.taskId, payload.event);
      if (!evRes.ok) {
        return makeFailure<HumanResolution>(request.taskId, currentControl.version, evRes.error, evRes.reason, decisionId);
      }
      writeJsonAtomic(join(taskDir(this.storageDir, request.taskId), 'history.json'), {
        ...historyRes.value,
        resolutions: [...historyRes.value.resolutions, resolution],
      });
    }

    writeJsonAtomic(join(taskDir(this.storageDir, request.taskId), 'control.json'), updatedControl);

    return makeResponse(updatedControl, 'ok', priorResolution !== undefined ? 'already-resolved' : 'pending-resolved', resolution, decisionId, request.requestVersion);
  }

  /** Records an operator direction to pause, resume, or end task execution. */
  recordDirection(input: unknown): StoreResponse<DeveloperDirection> {
    if (!input || typeof input !== 'object') return makeFailure<DeveloperDirection>('unknown', 1, 'denied', 'invalid-input');

    const payload = input as StorePayload;

    const rawDir = payload.direction as Record<string, unknown> | undefined;
    const taskId = typeof rawDir?.['taskId'] === 'string' ? rawDir['taskId'] : '';
    if (!isSafeId(taskId)) return makeFailure<DeveloperDirection>('unknown', 1, 'denied', 'invalid-id');

    const controlReadRes = this.readTaskControl(taskId);
    let currentControl: ApprovalTaskControl;
    if (controlReadRes.safe.outcome === 'ok' && controlReadRes.value) {
      currentControl = controlReadRes.value;
    } else if (controlReadRes.safe.safeReasonCode === 'control-not-found') {
      currentControl = makeInitialControl(taskId);
    } else {
      return makeFailure<DeveloperDirection>(taskId, 1, controlReadRes.safe.outcome, controlReadRes.safe.safeReasonCode);
    }

    const preErr = checkDirectionPreconditions(currentControl, payload);
    if (preErr) {
      const outcome = preErr === 'missing-trusted-operator' ? 'denied' : 'conflict';
      return makeFailure<DeveloperDirection>(taskId, currentControl.version, outcome, preErr);
    }

    const validDir = validateDeveloperDirection(payload.direction, {
      expectedTaskId: taskId,
      expectedVersion: currentControl.version,
      expectedEpoch: currentControl.epoch,
      trustedOperator: payload.trustedOperator,
    });
    if (!validDir.ok) return makeFailure<DeveloperDirection>(taskId, currentControl.version, 'denied', 'invalid-direction');
    const direction = validDir.value;

    const historyRes = this.readHistory(direction.taskId);
    if (historyRes.safe.outcome !== 'ok' || !historyRes.value) {
      return makeFailure<DeveloperDirection>(taskId, currentControl.version, 'unavailable', 'history-unavailable');
    }

    const priorDirection = historyRes.value.directions.find((d) => d.directionId === direction.directionId);
    if (priorDirection !== undefined && priorDirection.responseKey !== direction.responseKey) {
      return makeFailure<DeveloperDirection>(direction.taskId, currentControl.version, 'conflict', 'invalid-direction');
    }

    const nextMode = direction.direction === 'end' ? 'ended' : 'runnable';
    const updatedControl: ApprovalTaskControl = {
      ...currentControl,
      version: currentControl.version + 1,
      epoch: currentControl.epoch + 1,
      mode: nextMode,
      pendingDecisionId: null,
      continuationRef: null,
      reasonCode: `direction-${direction.direction}`,
    };

    if (priorDirection === undefined) {
      const evRes = this.appendEvent(direction.taskId, payload.event);
      if (!evRes.ok) {
        return makeFailure<DeveloperDirection>(direction.taskId, currentControl.version, evRes.error, evRes.reason);
      }
      writeJsonAtomic(join(taskDir(this.storageDir, direction.taskId), 'history.json'), {
        ...historyRes.value,
        directions: [...historyRes.value.directions, direction],
      });
    }

    writeJsonAtomic(join(taskDir(this.storageDir, direction.taskId), 'control.json'), updatedControl);

    return makeResponse(updatedControl, 'ok', 'direction-recorded', direction);
  }

  /** Replaces a stale pending approval request with a refreshed request. */
  replaceStalePending(input: unknown): StoreResponse<ApprovalRequestRecord> {
    if (!input || typeof input !== 'object') return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-input');

    const payload = input as StorePayload;

    const validReq = validateApprovalRequestRecord(payload.replacement);
    if (!validReq.ok) return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-replacement');
    const replacement = validReq.value;

    const controlRes = this.readTaskControl(replacement.taskId);
    if (controlRes.safe.outcome !== 'ok' || !controlRes.value) {
      return makeFailure<ApprovalRequestRecord>(replacement.taskId, 1, 'denied', 'control-unavailable');
    }
    const currentControl = controlRes.value;

    const preErr = checkReplacePreconditions(currentControl, replacement, this.storageDir, payload);
    if (preErr) {
      return makeFailure<ApprovalRequestRecord>(replacement.taskId, currentControl.version, 'conflict', preErr, replacement.decisionId);
    }

    if (payload.events !== undefined) {
      if (!Array.isArray(payload.events)) {
        return makeFailure<ApprovalRequestRecord>(replacement.taskId, currentControl.version, 'denied', 'invalid-events', replacement.decisionId);
      }
      for (const ev of payload.events) {
        const valid = validateDecisionEvent(ev, this.profile);
        if (!valid.ok) {
          return makeFailure<ApprovalRequestRecord>(replacement.taskId, currentControl.version, 'denied', 'invalid-event', replacement.decisionId);
        }
      }
    }

    const updatedControl: ApprovalTaskControl = {
      ...currentControl,
      version: currentControl.version + 1,
      epoch: currentControl.epoch + 1,
      mode: 'waiting',
      pendingDecisionId: replacement.decisionId,
      continuationRef: replacement.continuationRef,
      reasonCode: 'stale-pending-replaced',
    };

    const repFile = join(decisionDir(this.storageDir, replacement.decisionId), 'request.json');
    try {
      writeJsonAtomic(repFile, replacement);
      if (Array.isArray(payload.events)) {
        for (const ev of payload.events) {
          const evRes = this.appendEvent(replacement.taskId, ev);
          if (!evRes.ok) {
            rmSync(repFile, { force: true });
            return makeFailure<ApprovalRequestRecord>(replacement.taskId, currentControl.version, evRes.error, evRes.reason, replacement.decisionId);
          }
        }
      }
      writeJsonAtomic(join(taskDir(this.storageDir, replacement.taskId), 'control.json'), updatedControl);
    } catch {
      rmSync(repFile, { force: true });
      return makeFailure<ApprovalRequestRecord>(replacement.taskId, currentControl.version, 'unavailable', 'storage-error', replacement.decisionId);
    }

    return makeResponse(updatedControl, 'ok', 'stale-pending-replaced', replacement, replacement.decisionId, replacement.requestVersion);
  }

  /** Appends a decision event to the task audit log. */
  appendEvent(taskId: string, event: unknown): EventAppendResult {
    return appendEvent(this.storageDir, taskId, event, this.profile);
  }
}
