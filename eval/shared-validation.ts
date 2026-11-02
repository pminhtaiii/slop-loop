import { isProtectedPayload } from '../src/foundation/telemetry.ts';

export const executionLevels = new Set(['contract', 'mock-behavior', 'real-integration', 'model-quality', 'project']);
const digest = /^[a-f0-9]{64}$/u;
const name = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/u;
export function fail(): never {
  throw new Error('Invalid shared evaluation contract');
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
  }
  return value as Record<string, unknown>; // Exact own data properties checked above.
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !name.test(value) || isProtectedPayload(value)) fail();
  return value;
}
export function sha(value: unknown): string {
  if (typeof value !== 'string' || !digest.test(value)) fail();
  return value;
}
export function member(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}
export function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 256 || Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !('value' in property)) fail();
  }
  return value;
}
