import { hasInputKeys, isInputRecord, snapshotInputData, validateTaskData } from './input-data.ts';
import type { IntakeResult } from './input-types.ts';
export { receiveUc01Assessment } from './input-uc01.ts';
export { RECEIVER_CONTRACT_VERSION } from './input-types.ts';
export type { IntakeResult, IntakeSource } from './input-types.ts';

export function receiveBugTask(input: unknown): IntakeResult {
  const snapshot = snapshotInputData(input);
  if (!snapshot.ok || !isInputRecord(snapshot.value) || !hasInputKeys(snapshot.value, ['task', 'materialAmbiguities'])) {
    return { status: 'invalid-input', reasonCode: 'invalid-envelope', path: 'input' };
  }
  const value = snapshot.value;
  const ambiguities = value['materialAmbiguities'];
  if (ambiguities !== undefined && (!Array.isArray(ambiguities) || ambiguities.some(item => typeof item !== 'string' || !item.trim()))) {
    return { status: 'invalid-input', reasonCode: 'invalid-ambiguity', path: 'materialAmbiguities' };
  }
  const task = validateTaskData(value['task']);
  if (task.status !== 'accepted' && task.status !== 'needs-info') return task;
  if (Array.isArray(ambiguities) && ambiguities.length) {
    return { status: 'needs-info', fields: [...(task.status === 'needs-info' ? task.fields : []), 'materialAmbiguities'], questionIds: [] };
  }
  return task;
}
