import type { ValidationError, ValidationResult } from '../types.ts';

export type SafeSnapshot = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

const UNSAFE_INPUT_ERROR: ValidationError = {
  path: 'input',
  message: 'Input cannot be safely inspected',
  code: 'UNSAFE_INPUT',
};

export function unsafeInputResult<T>(): ValidationResult<T> {
  return { ok: false, errors: [{ ...UNSAFE_INPUT_ERROR }] };
}

/** Copy plain data without invoking getters; proxy traps fail closed. */
export function safeSnapshot(input: unknown): SafeSnapshot {
  const active = new WeakSet<object>();
  const copies = new WeakMap<object, unknown>();
  let nodes = 0;

  function copy(value: unknown, depth: number): unknown {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new TypeError();
      return value;
    }
    if (depth > 64 || ++nodes > 10000) throw new RangeError();
    if (active.has(value)) throw new TypeError();
    const prior = copies.get(value);
    if (prior !== undefined) return prior;
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError();
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
        const length = lengthDescriptor?.value;
        if (!Number.isSafeInteger(length) || length < 0) throw new TypeError();
        const keys = Reflect.ownKeys(value);
        if (keys.length !== length + 1 || keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)))) throw new TypeError();
        const result: unknown[] = new Array(length);
        copies.set(value, result);
        for (let i = 0; i < length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
          result[i] = copy(descriptor.value, depth + 1);
        }
        return result;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      copies.set(value, result);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') throw new TypeError();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError();
        Object.defineProperty(result, key, {
          value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true,
        });
      }
      return result;
    } finally {
      active.delete(value);
    }
  }

  try {
    return { ok: true, value: copy(input, 0) };
  } catch {
    return { ok: false };
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const child = (value as Record<PropertyKey, unknown>)[key];
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function immutableResult<T>(result: ValidationResult<T>): ValidationResult<T> {
  const snapshot = safeSnapshot(result);
  if (!snapshot.ok) return deepFreeze(unsafeInputResult<T>());
  return deepFreeze(snapshot.value as ValidationResult<T>);
}

export function protectValidator<T, C = unknown>(
  validator: (input: unknown, context?: C) => ValidationResult<T>,
): (input: unknown, context?: C) => ValidationResult<T> {
  return (input, context) => {
    const inputCopy = safeSnapshot(input);
    const contextCopy = safeSnapshot(context);
    if (!inputCopy.ok || !contextCopy.ok) return immutableResult(unsafeInputResult<T>());
    try {
      return immutableResult(validator(inputCopy.value, contextCopy.value as C | undefined));
    } catch {
      return immutableResult(unsafeInputResult<T>());
    }
  };
}
