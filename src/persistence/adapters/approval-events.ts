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
import { DEFAULT_POLICY_PROFILE, isSafeId, makeFailure, makeResponse, taskDir, writeJsonAtomic } from './approval-types.ts';

const validateStoredEvent = (input: unknown) => validateDecisionEvent(input, DEFAULT_POLICY_PROFILE);

export function readEvents(
  storageDir: string,
  taskId: string
): StoreResponse<readonly DecisionEvent[]> {
  if (!isSafeId(taskId)) return makeFailure<readonly DecisionEvent[]>('unknown', 1, 'denied', 'invalid-id');
  const filePath = join(taskDir(storageDir, taskId), 'events.json');
  if (!existsSync(filePath)) return makeResponse({ taskId, version: 1 }, 'ok', 'empty-events', []);

  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!Array.isArray(raw)) return makeFailure<readonly DecisionEvent[]>(taskId, 1, 'unavailable', 'read-error');
    const validated: DecisionEvent[] = [];
    for (const ev of raw) {
      const res = validateStoredEvent(ev);
      if (!res.ok) return makeFailure<readonly DecisionEvent[]>(taskId, 1, 'denied', 'invalid-stored-event');
      if (res.value.taskId !== taskId) return makeFailure<readonly DecisionEvent[]>(taskId, 1, 'denied', 'task-id-mismatch');
      validated.push(res.value);
    }
    return makeResponse({ taskId, version: 1 }, 'ok', 'events-loaded', validated);
  } catch {
    return makeFailure<readonly DecisionEvent[]>(taskId, 1, 'unavailable', 'read-error');
  }
}

export function appendEvents(
  storageDir: string,
  taskId: string,
  events: readonly unknown[] | undefined,
  profile: PolicyProfile
): EventAppendResult {
  if (events === undefined) return { ok: true, status: 'skipped' };
  const accepted: DecisionEvent[] = [];
  for (const event of events) {
    const valid = validateDecisionEvent(event, profile);
    if (!valid.ok) return { ok: false, error: 'denied', reason: 'invalid-event' };
    if (valid.value.taskId !== taskId) {
      return { ok: false, error: 'denied', reason: 'task-id-mismatch' };
    }
    accepted.push(valid.value);
  }
  if (accepted.length === 0) return { ok: true, status: 'skipped' };

  const res = readEvents(storageDir, taskId);
  if (res.safe.outcome !== 'ok' || !res.value) {
    return { ok: false, error: 'unavailable', reason: 'events-unavailable' };
  }

  const merged = [...res.value];
  let changed = false;
  let idempotent = false;
  for (const event of accepted) {
    const existing = merged.find((entry) => entry.eventId === event.eventId);
    if (existing === undefined) {
      merged.push(event);
      changed = true;
    } else if (isDeepStrictEqual(existing, event)) idempotent = true;
    else return { ok: false, error: 'conflict', reason: 'event-conflict' };
  }
  if (!changed) return { ok: true, status: idempotent ? 'idempotent' : 'skipped' };

  writeJsonAtomic(join(taskDir(storageDir, taskId), 'events.json'), merged);
  return { ok: true, status: 'appended' };
}

export function appendEvent(
  storageDir: string,
  taskId: string,
  event: unknown,
  profile: PolicyProfile
): EventAppendResult {
  return appendEvents(storageDir, taskId, event === undefined ? undefined : [event], profile);
}
