import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ApprovalStore, StoreResponse } from '../../approvals/service-data.ts';
import {
  type ApprovalRequestRecord,
  type ApprovalTaskControl,
  type DecisionEvent,
  type DeveloperDirection,
  type HumanResolution,
  UC05_APPROVAL_SCHEMA_VERSION,
  validateApprovalRequestRecord,
  validateApprovalTaskControl,
  validateDeveloperDirection,
  validateHumanResolution,
} from '../../contracts/approvals/contracts.ts';
import type { DurableStore } from '../store.ts';

import {
  type DurableApprovalStoreOptions,
  type StoredHistory,
  type StorePayload,
  isSafeId,
  makeFailure,
  makeResponse,
} from './approval-types.ts';

export class DurableApprovalStore implements ApprovalStore {
  readonly provenance = 'mock' as const;
  private readonly storageDir: string;
  readonly durableStore?: DurableStore | undefined;

  constructor(options: DurableApprovalStoreOptions) {
    this.storageDir = options.storageDir;
    this.durableStore = options.durableStore;
    mkdirSync(this.storageDir, { recursive: true });
  }

  private taskDir = (taskId: string) => join(this.storageDir, 'tasks', taskId, 'approvals');
  private decisionDir = (dId: string) => join(this.storageDir, 'decisions', dId);

  loadTaskControl(taskId: string): StoreResponse<ApprovalTaskControl> {
    if (!isSafeId(taskId)) return makeFailure<ApprovalTaskControl>('unknown', 1, 'denied', 'invalid-id');
    const filePath = join(this.taskDir(taskId), 'control.json');
    if (!existsSync(filePath)) {
      const defaultControl: ApprovalTaskControl = {
        schemaVersion: UC05_APPROVAL_SCHEMA_VERSION,
        taskId,
        repositoryId: 'default-repo',
        workspaceId: 'default-ws',
        version: 1,
        epoch: 1,
        mode: 'runnable',
        pendingDecisionId: null,
        continuationRef: null,
        reasonCode: 'initial-runnable',
        outstandingClaimRefs: [],
      };
      this.writeJson(filePath, defaultControl);
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

  readRequest(decisionId: string): StoreResponse<ApprovalRequestRecord> {
    if (!isSafeId(decisionId)) return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-id', decisionId);
    const filePath = join(this.decisionDir(decisionId), 'request.json');
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

  readHistory(taskId: string): StoreResponse<StoredHistory> {
    if (!isSafeId(taskId)) return makeFailure<StoredHistory>('unknown', 1, 'denied', 'invalid-id');
    const filePath = join(this.taskDir(taskId), 'history.json');
    if (!existsSync(filePath)) {
      return makeResponse({ taskId, version: 1 }, 'ok', 'empty-history', { resolutions: [], directions: [], assessments: [], claims: [] });
    }

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return makeFailure<StoredHistory>(taskId, 1, 'unavailable', 'read-error');
      const checkArr = (v: unknown) => {
        if (v === undefined) return [];
        if (!Array.isArray(v)) throw new Error('malformed');
        return v;
      };
      return makeResponse({ taskId, version: 1 }, 'ok', 'history-loaded', {
        resolutions: checkArr((raw as Record<string, unknown>).resolutions),
        directions: checkArr((raw as Record<string, unknown>).directions),
        assessments: checkArr((raw as Record<string, unknown>).assessments),
        claims: checkArr((raw as Record<string, unknown>).claims),
      });
    } catch {
      return makeFailure<StoredHistory>(taskId, 1, 'unavailable', 'read-error');
    }
  }

  readEvents(taskId: string): StoreResponse<readonly DecisionEvent[]> {
    if (!isSafeId(taskId)) return makeFailure<readonly DecisionEvent[]>('unknown', 1, 'denied', 'invalid-id');
    const filePath = join(this.taskDir(taskId), 'events.json');
    if (!existsSync(filePath)) return makeResponse({ taskId, version: 1 }, 'ok', 'empty-events', []);

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!Array.isArray(raw)) return makeFailure<readonly DecisionEvent[]>(taskId, 1, 'unavailable', 'read-error');
      return makeResponse({ taskId, version: 1 }, 'ok', 'events-loaded', raw);
    } catch {
      return makeFailure<readonly DecisionEvent[]>(taskId, 1, 'unavailable', 'read-error');
    }
  }

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
    if (existsSync(join(this.decisionDir(request.decisionId), 'request.json'))) {
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

    this.writeJson(join(this.decisionDir(request.decisionId), 'request.json'), request);
    if (!this.appendEvent(request.taskId, payload.event)) {
      rmSync(join(this.decisionDir(request.decisionId), 'request.json'), { force: true });
      return makeFailure<ApprovalRequestRecord>(request.taskId, currentControl.version, 'unavailable', 'events-unavailable', request.decisionId);
    }
    this.writeJson(join(this.taskDir(request.taskId), 'control.json'), updatedControl);

    return makeResponse(updatedControl, 'ok', 'pending-created', request, request.decisionId, request.requestVersion);
  }

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

    const currentControlRes = this.loadTaskControl(request.taskId);
    if (currentControlRes.safe.outcome !== 'ok' || !currentControlRes.value) {
      return makeFailure<HumanResolution>(request.taskId, 1, 'denied', 'control-unavailable', decisionId);
    }
    const currentControl = currentControlRes.value;

    if (currentControl.mode !== 'waiting') {
      return makeFailure<HumanResolution>(request.taskId, currentControl.version, 'conflict', 'task-not-waiting', decisionId);
    }
    if (currentControl.pendingDecisionId !== request.decisionId) {
      return makeFailure<HumanResolution>(request.taskId, currentControl.version, 'conflict', 'decision-not-pending', decisionId);
    }
    if (payload.expectedControlVersion !== undefined && currentControl.version !== payload.expectedControlVersion) {
      return makeFailure<HumanResolution>(request.taskId, currentControl.version, 'conflict', 'version-conflict', decisionId);
    }
    if (payload.expectedRequestVersion !== undefined && payload.expectedRequestVersion !== request.requestVersion) {
      return makeFailure<HumanResolution>(request.taskId, currentControl.version, 'conflict', 'request-version-conflict', decisionId, request.requestVersion);
    }
    if (!payload.trustedOperator) {
      return makeFailure<HumanResolution>(request.taskId, currentControl.version, 'denied', 'missing-trusted-operator', decisionId);
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

    if (!this.appendEvent(request.taskId, payload.event)) {
      return makeFailure<HumanResolution>(request.taskId, currentControl.version, 'unavailable', 'events-unavailable', decisionId);
    }
    this.writeJson(join(this.taskDir(request.taskId), 'history.json'), {
      ...historyRes.value,
      resolutions: [...historyRes.value.resolutions, resolution],
    });
    this.writeJson(join(this.taskDir(request.taskId), 'control.json'), updatedControl);

    return makeResponse(updatedControl, 'ok', 'pending-resolved', resolution, decisionId, request.requestVersion);
  }

  recordDirection(input: unknown): StoreResponse<DeveloperDirection> {
    if (!input || typeof input !== 'object') return makeFailure<DeveloperDirection>('unknown', 1, 'denied', 'invalid-input');

    const payload = input as StorePayload;

    const rawDir = payload.direction as Record<string, unknown> | undefined;
    const taskId = typeof rawDir?.['taskId'] === 'string' ? rawDir['taskId'] : '';

    const currentControlRes = this.loadTaskControl(taskId);
    if (currentControlRes.safe.outcome !== 'ok' || !currentControlRes.value) {
      return makeFailure<DeveloperDirection>(taskId, 1, 'denied', 'control-unavailable');
    }
    const currentControl = currentControlRes.value;

    if (currentControl.mode === 'ended' || currentControl.mode === 'rejected') {
      return makeFailure<DeveloperDirection>(taskId, currentControl.version, 'conflict', 'task-terminal');
    }
    if (payload.expectedControlVersion !== undefined && currentControl.version !== payload.expectedControlVersion) {
      return makeFailure<DeveloperDirection>(taskId, currentControl.version, 'conflict', 'version-conflict');
    }
    if (!payload.trustedOperator) return makeFailure<DeveloperDirection>(taskId, currentControl.version, 'denied', 'missing-trusted-operator');

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

    if (!this.appendEvent(direction.taskId, payload.event)) {
      return makeFailure<DeveloperDirection>(direction.taskId, currentControl.version, 'unavailable', 'events-unavailable');
    }
    this.writeJson(join(this.taskDir(direction.taskId), 'history.json'), {
      ...historyRes.value,
      directions: [...historyRes.value.directions, direction],
    });
    this.writeJson(join(this.taskDir(direction.taskId), 'control.json'), updatedControl);

    return makeResponse(updatedControl, 'ok', 'direction-recorded', direction);
  }

  replaceStalePending(input: unknown): StoreResponse<ApprovalRequestRecord> {
    if (!input || typeof input !== 'object') return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-input');

    const payload = input as StorePayload;

    const validReq = validateApprovalRequestRecord(payload.replacement);
    if (!validReq.ok) return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-replacement');
    const replacement = validReq.value;

    const controlRes = this.loadTaskControl(replacement.taskId);
    if (controlRes.safe.outcome !== 'ok' || !controlRes.value) {
      return makeFailure<ApprovalRequestRecord>(replacement.taskId, 1, 'denied', 'control-unavailable');
    }
    const currentControl = controlRes.value;

    if (currentControl.mode !== 'waiting' || currentControl.pendingDecisionId === null) {
      return makeFailure<ApprovalRequestRecord>(replacement.taskId, currentControl.version, 'conflict', 'no-pending-decision', replacement.decisionId);
    }
    if (
      replacement.decisionId === currentControl.pendingDecisionId ||
      existsSync(join(this.decisionDir(replacement.decisionId), 'request.json'))
    ) {
      return makeFailure<ApprovalRequestRecord>(replacement.taskId, currentControl.version, 'conflict', 'decision-id-in-use', replacement.decisionId);
    }
    if (payload.expectedControlVersion !== undefined && currentControl.version !== payload.expectedControlVersion) {
      return makeFailure<ApprovalRequestRecord>(replacement.taskId, currentControl.version, 'conflict', 'version-conflict', replacement.decisionId);
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

    this.writeJson(join(this.decisionDir(replacement.decisionId), 'request.json'), replacement);
    if (Array.isArray(payload.events)) {
      const eventsRes = this.readEvents(replacement.taskId);
      if (eventsRes.safe.outcome !== 'ok' || !eventsRes.value) {
        rmSync(join(this.decisionDir(replacement.decisionId), 'request.json'), { force: true });
        return makeFailure<ApprovalRequestRecord>(replacement.taskId, currentControl.version, 'unavailable', 'events-unavailable', replacement.decisionId);
      }
      const validEvents = payload.events.filter((e): e is DecisionEvent => Boolean(e && typeof e === 'object'));
      this.writeJson(join(this.taskDir(replacement.taskId), 'events.json'), [...eventsRes.value, ...validEvents]);
    }

    this.writeJson(join(this.taskDir(replacement.taskId), 'control.json'), updatedControl);

    return makeResponse(updatedControl, 'ok', 'stale-pending-replaced', replacement, replacement.decisionId, replacement.requestVersion);
  }

  private appendEvent(taskId: string, event: unknown): boolean {
    if (!event || typeof event !== 'object') return true;
    const res = this.readEvents(taskId);
    if (res.safe.outcome !== 'ok' || !res.value) return false;
    this.writeJson(join(this.taskDir(taskId), 'events.json'), [...res.value, event as DecisionEvent]);
    return true;
  }

  private writeJson(path: string, data: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, path);
  }
}
