import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalStore, StoreResponse } from '../../approvals/service-data.ts';
import {
  type ApprovalRequestRecord,
  type ApprovalTaskControl,
  type BindingAssessment,
  type DecisionEvent,
  type DeveloperDirection,
  type DispatchClaim,
  type HumanResolution,
  type SafeOperationOutcome,
  type SafeResult,
  UC05_APPROVAL_SCHEMA_VERSION,
  validateApprovalRequestRecord,
  validateApprovalTaskControl,
  validateDeveloperDirection,
  validateHumanResolution,
} from '../../contracts/approvals/contracts.ts';
import type { DurableStore } from '../store.ts';

export interface DurableApprovalStoreOptions {
  readonly storageDir: string;
  readonly durableStore?: DurableStore | undefined;
}

interface StoredHistory {
  readonly resolutions: readonly HumanResolution[];
  readonly directions: readonly DeveloperDirection[];
  readonly assessments: readonly BindingAssessment[];
  readonly claims: readonly DispatchClaim[];
}

function makeResponse<T>(
  control: Pick<ApprovalTaskControl, 'taskId' | 'version'>,
  outcome: SafeOperationOutcome,
  safeReasonCode: string,
  value: T | null,
  decisionId: string | null = null,
  requestVersion: number | null = null,
  eventRef: string | null = null
): StoreResponse<T> {
  const safe: SafeResult = {
    schemaVersion: UC05_APPROVAL_SCHEMA_VERSION,
    outcome,
    safeReasonCode,
    taskId: control.taskId,
    decisionId,
    controlVersion: control.version,
    requestVersion,
    eventRef,
    safeNextAction: 'none',
  };
  return { safe, value };
}

function makeFailure<T>(
  taskId: string,
  version: number,
  outcome: SafeOperationOutcome,
  safeReasonCode: string,
  decisionId: string | null = null,
  requestVersion: number | null = null
): StoreResponse<T> {
  return makeResponse<T>({ taskId, version }, outcome, safeReasonCode, null, decisionId, requestVersion);
}

export class DurableApprovalStore implements ApprovalStore {
  readonly provenance = 'mock' as const;
  private readonly storageDir: string;
  readonly durableStore?: DurableStore | undefined;

  constructor(options: DurableApprovalStoreOptions) {
    this.storageDir = options.storageDir;
    this.durableStore = options.durableStore;
    mkdirSync(this.storageDir, { recursive: true });
  }

  private taskDir(taskId: string): string {
    const dir = join(this.storageDir, 'tasks', taskId, 'approvals');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private decisionDir(decisionId: string): string {
    const dir = join(this.storageDir, 'decisions', decisionId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  loadTaskControl(taskId: string): StoreResponse<ApprovalTaskControl> {
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
      if (!validation.ok) {
        return makeFailure<ApprovalTaskControl>(taskId, 1, 'denied', 'invalid-stored-control');
      }
      return makeResponse(validation.value, 'ok', 'task-control-loaded', validation.value);
    } catch {
      return makeFailure<ApprovalTaskControl>(taskId, 1, 'unavailable', 'read-error');
    }
  }

  readRequest(decisionId: string): StoreResponse<ApprovalRequestRecord> {
    const filePath = join(this.decisionDir(decisionId), 'request.json');
    if (!existsSync(filePath)) {
      return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'request-not-found', decisionId);
    }

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      const validation = validateApprovalRequestRecord(raw);
      if (!validation.ok) {
        return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-stored-request', decisionId);
      }
      const req = validation.value;
      return makeResponse(
        { taskId: req.taskId, version: 1 },
        'ok',
        'request-loaded',
        req,
        decisionId,
        req.requestVersion
      );
    } catch {
      return makeFailure<ApprovalRequestRecord>('unknown', 1, 'unavailable', 'read-error', decisionId);
    }
  }

  readHistory(taskId: string): StoreResponse<StoredHistory> {
    const filePath = join(this.taskDir(taskId), 'history.json');
    if (!existsSync(filePath)) {
      const empty: StoredHistory = { resolutions: [], directions: [], assessments: [], claims: [] };
      return makeResponse({ taskId, version: 1 }, 'ok', 'empty-history', empty);
    }

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      const history: StoredHistory = {
        resolutions: Array.isArray(raw.resolutions) ? raw.resolutions : [],
        directions: Array.isArray(raw.directions) ? raw.directions : [],
        assessments: Array.isArray(raw.assessments) ? raw.assessments : [],
        claims: Array.isArray(raw.claims) ? raw.claims : [],
      };
      return makeResponse({ taskId, version: 1 }, 'ok', 'history-loaded', history);
    } catch {
      return makeFailure<StoredHistory>(taskId, 1, 'unavailable', 'read-error');
    }
  }

  readEvents(taskId: string): StoreResponse<readonly DecisionEvent[]> {
    const filePath = join(this.taskDir(taskId), 'events.json');
    if (!existsSync(filePath)) {
      return makeResponse({ taskId, version: 1 }, 'ok', 'empty-events', []);
    }

    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      const events = Array.isArray(raw) ? raw : [];
      return makeResponse({ taskId, version: 1 }, 'ok', 'events-loaded', events);
    } catch {
      return makeFailure<readonly DecisionEvent[]>(taskId, 1, 'unavailable', 'read-error');
    }
  }

  createPendingAndPause(input: unknown): StoreResponse<ApprovalRequestRecord> {
    if (!input || typeof input !== 'object') {
      return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-input');
    }

    const payload = input as {
      readonly expectedControlVersion?: number;
      readonly request?: unknown;
      readonly event?: unknown;
    };

    const validRequest = validateApprovalRequestRecord(payload.request);
    if (!validRequest.ok) {
      return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-request');
    }
    const request = validRequest.value;

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
    this.writeJson(join(this.taskDir(request.taskId), 'control.json'), updatedControl);

    if (payload.event && typeof payload.event === 'object') {
      this.appendEvent(request.taskId, payload.event as DecisionEvent);
    }

    return makeResponse(updatedControl, 'ok', 'pending-created', request, request.decisionId, request.requestVersion);
  }

  resolvePending(input: unknown): StoreResponse<HumanResolution> {
    if (!input || typeof input !== 'object') {
      return makeFailure<HumanResolution>('unknown', 1, 'denied', 'invalid-input');
    }

    const payload = input as {
      readonly expectedControlVersion?: number;
      readonly expectedRequestVersion?: number;
      readonly trustedResponse?: unknown;
      readonly trustedOperator?: unknown;
      readonly event?: unknown;
    };

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

    if (payload.expectedControlVersion !== undefined && currentControl.version !== payload.expectedControlVersion) {
      return makeFailure<HumanResolution>(request.taskId, currentControl.version, 'conflict', 'version-conflict', decisionId);
    }

    const validResponse = validateHumanResolution(payload.trustedResponse, {
      expectedDecisionId: request.decisionId,
      expectedRequestVersion: request.requestVersion,
      trustedOperator: payload.trustedOperator ?? {
        actorId: 'developer-local',
        channelRef: 'channel-local',
        provenance: 'real',
      },
    });

    if (!validResponse.ok) {
      return makeFailure<HumanResolution>(request.taskId, currentControl.version, 'denied', 'invalid-resolution', decisionId);
    }
    const resolution = validResponse.value;

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

    this.writeJson(join(this.taskDir(request.taskId), 'control.json'), updatedControl);

    const historyRes = this.readHistory(request.taskId);
    const history = historyRes.value ?? { resolutions: [], directions: [], assessments: [], claims: [] };
    const updatedHistory: StoredHistory = {
      ...history,
      resolutions: [...history.resolutions, resolution],
    };
    this.writeJson(join(this.taskDir(request.taskId), 'history.json'), updatedHistory);

    if (payload.event && typeof payload.event === 'object') {
      this.appendEvent(request.taskId, payload.event as DecisionEvent);
    }

    return makeResponse(updatedControl, 'ok', 'pending-resolved', resolution, decisionId, request.requestVersion);
  }

  recordDirection(input: unknown): StoreResponse<DeveloperDirection> {
    if (!input || typeof input !== 'object') {
      return makeFailure<DeveloperDirection>('unknown', 1, 'denied', 'invalid-input');
    }

    const payload = input as {
      readonly expectedControlVersion?: number;
      readonly direction?: unknown;
      readonly event?: unknown;
    };

    const rawDir = payload.direction as Record<string, unknown> | undefined;
    const taskId = typeof rawDir?.['taskId'] === 'string' ? rawDir['taskId'] : '';

    const currentControlRes = this.loadTaskControl(taskId);
    if (currentControlRes.safe.outcome !== 'ok' || !currentControlRes.value) {
      return makeFailure<DeveloperDirection>(taskId, 1, 'denied', 'control-unavailable');
    }
    const currentControl = currentControlRes.value;

    if (payload.expectedControlVersion !== undefined && currentControl.version !== payload.expectedControlVersion) {
      return makeFailure<DeveloperDirection>(taskId, currentControl.version, 'conflict', 'version-conflict');
    }

    const validDir = validateDeveloperDirection(payload.direction, {
      expectedTaskId: taskId,
      expectedVersion: currentControl.version,
      expectedEpoch: currentControl.epoch,
      trustedOperator: { actorId: 'developer-local', channelRef: 'channel-local', provenance: 'real' },
    });

    if (!validDir.ok) {
      return makeFailure<DeveloperDirection>(taskId, currentControl.version, 'denied', 'invalid-direction');
    }
    const direction = validDir.value;

    const nextMode = direction.direction === 'end' ? 'ended' : 'runnable';
    const updatedControl: ApprovalTaskControl = {
      ...currentControl,
      version: currentControl.version + 1,
      epoch: currentControl.epoch + 1,
      mode: nextMode,
      reasonCode: `direction-${direction.direction}`,
    };

    this.writeJson(join(this.taskDir(direction.taskId), 'control.json'), updatedControl);

    const historyRes = this.readHistory(direction.taskId);
    const history = historyRes.value ?? { resolutions: [], directions: [], assessments: [], claims: [] };
    const updatedHistory: StoredHistory = {
      ...history,
      directions: [...history.directions, direction],
    };
    this.writeJson(join(this.taskDir(direction.taskId), 'history.json'), updatedHistory);

    if (payload.event && typeof payload.event === 'object') {
      this.appendEvent(direction.taskId, payload.event as DecisionEvent);
    }

    return makeResponse(updatedControl, 'ok', 'direction-recorded', direction);
  }

  replaceStalePending(input: unknown): StoreResponse<ApprovalRequestRecord> {
    if (!input || typeof input !== 'object') {
      return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-input');
    }

    const payload = input as {
      readonly expectedControlVersion?: number;
      readonly replacement?: unknown;
      readonly events?: readonly unknown[];
    };

    const validReq = validateApprovalRequestRecord(payload.replacement);
    if (!validReq.ok) {
      return makeFailure<ApprovalRequestRecord>('unknown', 1, 'denied', 'invalid-replacement');
    }
    const replacement = validReq.value;

    const controlRes = this.loadTaskControl(replacement.taskId);
    if (controlRes.safe.outcome !== 'ok' || !controlRes.value) {
      return makeFailure<ApprovalRequestRecord>(replacement.taskId, 1, 'denied', 'control-unavailable');
    }
    const currentControl = controlRes.value;

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
    this.writeJson(join(this.taskDir(replacement.taskId), 'control.json'), updatedControl);

    if (Array.isArray(payload.events)) {
      for (const ev of payload.events) {
        if (ev && typeof ev === 'object') {
          this.appendEvent(replacement.taskId, ev as DecisionEvent);
        }
      }
    }

    return makeResponse(
      updatedControl,
      'ok',
      'stale-pending-replaced',
      replacement,
      replacement.decisionId,
      replacement.requestVersion
    );
  }

  private appendEvent(taskId: string, event: DecisionEvent): void {
    const existing = this.readEvents(taskId).value ?? [];
    this.writeJson(join(this.taskDir(taskId), 'events.json'), [...existing, event]);
  }

  private writeJson(path: string, data: unknown): void {
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  }
}
