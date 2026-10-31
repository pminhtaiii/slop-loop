import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { StoreResponse } from '../../approvals/service-data.ts';
import {
  type DecisionEvent,
  type PolicyProfile,
  validateDecisionEvent,
} from '../../contracts/approvals/contracts.ts';
import type { EventAppendResult } from './approval-types.ts';
import { isSafeId, makeFailure, makeResponse, taskDir, writeJsonAtomic } from './approval-types.ts';

export function readEvents(
  storageDir: string,
  taskId: string,
  profile: PolicyProfile
): StoreResponse<readonly DecisionEvent[]> {
  if (!isSafeId(taskId)) return makeFailure<readonly DecisionEvent[]>('unknown', 1, 'denied', 'invalid-id');
  const filePath = join(taskDir(storageDir, taskId), 'events.json');
  if (!existsSync(filePath)) return makeResponse({ taskId, version: 1 }, 'ok', 'empty-events', []);

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!Array.isArray(raw)) return makeFailure<readonly DecisionEvent[]>(taskId, 1, 'unavailable', 'read-error');
    const validated: DecisionEvent[] = [];
    for (const ev of raw) {
      const res = validateDecisionEvent(ev, profile);
      if (!res.ok) return makeFailure<readonly DecisionEvent[]>(taskId, 1, 'denied', 'invalid-stored-event');
      if (res.value.taskId !== taskId) return makeFailure<readonly DecisionEvent[]>(taskId, 1, 'denied', 'task-id-mismatch');
      validated.push(res.value);
    }
    return makeResponse({ taskId, version: 1 }, 'ok', 'events-loaded', validated);
  } catch {
    return makeFailure<readonly DecisionEvent[]>(taskId, 1, 'unavailable', 'read-error');
  }
}

export function appendEvent(
  storageDir: string,
  taskId: string,
  event: unknown,
  profile: PolicyProfile
): EventAppendResult {
  if (event === undefined) return { ok: true, status: 'skipped' };
  const valid = validateDecisionEvent(event, profile);
  if (!valid.ok) return { ok: false, error: 'denied', reason: 'invalid-event' };
  if (valid.value.taskId !== taskId) {
    return { ok: false, error: 'denied', reason: 'task-id-mismatch' };
  }

  const res = readEvents(storageDir, taskId, profile);
  if (res.safe.outcome !== 'ok' || !res.value) {
    return { ok: false, error: 'unavailable', reason: 'events-unavailable' };
  }

  const existing = res.value.find((e) => e.eventId === valid.value.eventId);
  if (existing !== undefined) {
    return isDeepStrictEqual(existing, valid.value)
      ? { ok: true, status: 'idempotent' }
      : { ok: false, error: 'conflict', reason: 'event-conflict' };
  }

  writeJsonAtomic(join(taskDir(storageDir, taskId), 'events.json'), [...res.value, valid.value]);
  return { ok: true, status: 'appended' };
}
