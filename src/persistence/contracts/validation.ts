import type { ValidationError } from './types.ts';

export function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export function checkStr(errors: ValidationError[], val: unknown, path: string, message: string, code: string): void {
  if (typeof val !== 'string' || !val.trim()) errors.push({ path, message, code });
}

export function checkNum(errors: ValidationError[], val: unknown, path: string, message: string, code: string, min = 0): void {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < min) errors.push({ path, message, code });
}

export function checkInt(errors: ValidationError[], val: unknown, path: string, message: string, code: string, min = 1): void {
  if (typeof val !== 'number' || !Number.isInteger(val) || val < min) errors.push({ path, message, code });
}

export function checkStringArray(errors: ValidationError[], arr: unknown, path: string, name: string, code: string): void {
  if (!Array.isArray(arr)) {
    errors.push({ path, message: `${name} must be an array`, code });
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== 'string' || !arr[i].trim()) {
      errors.push({ path: `${path}[${i}]`, message: `${name} items must be non-empty strings`, code });
    }
  }
}

