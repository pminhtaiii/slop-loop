import { types } from 'node:util';
import { validateBugTask } from '../contracts/foundation/uc03.ts';
import type { IntakeResult } from './input-types.ts';

class InvalidData extends Error {}
export function isInputRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Copy only bounded data properties before invoking canonical validators. */
export function snapshotInputData(input: unknown): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }> {
  let values = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function account(text: string): void {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > 1048576) throw new InvalidData();
  }
  function copy(value: unknown, depth: number): unknown {
    if (++values > 20000 || depth > 32) throw new InvalidData();
    if (value === undefined || value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { account(value); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) throw new InvalidData();
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new InvalidData();
      const items: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new InvalidData();
        items.push(copy(descriptor.value, depth + 1));
      }
      result = items;
    } else {
      if (!isInputRecord(value)) throw new InvalidData();
      const record: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') throw new InvalidData();
        account(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new InvalidData();
        Object.defineProperty(record, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      result = record;
    }
    ancestors.delete(value);
    return result;
  }
  try { return { ok: true, value: copy(input, 0) }; }
  catch (error) { if (error instanceof InvalidData) return { ok: false }; throw error; }
}

export function hasInputKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function missingValue(task: Record<string, unknown>, path: string): boolean {
  let value: unknown = task;
  for (const part of path.replace(/\[(\d+)\]/gu, '.$1').split('.')) {
    if (typeof value !== 'object' || value === null) return value === undefined;
    value = Object.getOwnPropertyDescriptor(value, part)?.value;
  }
  return value === undefined || typeof value === 'string' && !value.trim()
    || (path === 'acceptanceCriteria' || path === 'requiredChecks') && Array.isArray(value) && value.length === 0;
}

/** Shared supplied-task admission; input is already a detached data snapshot. */
export function validateTaskData(input: unknown): IntakeResult {
  const task = input === undefined ? {} : input;
  if (!isInputRecord(task)) return { status: 'invalid-input', reasonCode: 'invalid-task', path: 'task' };
  const parsed = validateBugTask(task);
  if (parsed.ok) return { status: 'accepted', task: parsed.value };
  const fields: string[] = [];
  for (const error of parsed.errors) {
    if (error.code === 'UNKNOWN_PROPERTY') return { status: 'invalid-input', reasonCode: 'invalid-task', path: 'task' };
    if (!missingValue(task, error.path)) return { status: 'invalid-input', reasonCode: 'invalid-task', path: error.path };
    if (!fields.includes(error.path)) fields.push(error.path);
  }
  return { status: 'needs-info', fields, questionIds: [] };
}
