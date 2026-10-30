import { isProtectedPayload } from "../foundation/telemetry.ts";
import type { Failure, Outcome, Usage } from "./contracts.ts";
import type { ReserveCeiling } from "./assess.ts";
import { priceUsage, type ProductionProfile } from "./production-profile.ts";

export class Stopped extends Error {
  readonly status: Failure; readonly code: string;
  constructor(status: Failure, code: string) { super('Assessment stopped'); this.status = status; this.code = code; }
}
export function stop(status: Failure, code: string): never { throw new Stopped(status, code); }
export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) stop('error', 'invalid-shared-output');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) stop('error', 'invalid-shared-output');
  }
  return value as Record<string, unknown>; // Every key above is a plain own data property.
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 512 || isProtectedPayload(value)) stop('error', 'invalid-shared-output');
  return value;
}
export function canonical(value: unknown, ancestors = new Set<object>(), depth = 0): string {
  if (depth > 32) stop('error', 'invalid-shared-output');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || ancestors.has(value)) stop('error', 'invalid-shared-output');
  ancestors.add(value); let result: string;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) stop('error', 'invalid-shared-output');
    const entries: string[] = [];
    for (let index = 0; index < value.length; index++) {
      const field = Object.getOwnPropertyDescriptor(value, String(index));
      if (!field?.enumerable || !('value' in field)) stop('error', 'invalid-shared-output');
      entries.push(canonical(field.value, ancestors, depth + 1));
    }
    result = `[${entries.join(',')}]`;
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) stop('error', 'invalid-shared-output');
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) stop('error', 'invalid-shared-output');
    result = `{${(keys as string[]).sort().map(key => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field?.enumerable || !('value' in field)) stop('error', 'invalid-shared-output');
      return `${JSON.stringify(key)}:${canonical(field.value, ancestors, depth + 1)}`;
    }).join(',')}}`;
  }
  ancestors.delete(value); return result;
}
export function sharedFailure(value: unknown): void {
  if (value && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'kind')?.value === 'failure') {
    const result = record(value, ['kind', 'status', 'reasonCode', 'eventRef']);
    const status = result.status;
    if (typeof status !== 'string' || !['invalid-input', 'denied', 'pending-approval', 'conflict', 'exhausted', 'timeout', 'uncertain', 'error'].includes(status)) stop('error', 'invalid-shared-output');
    const code = id(result.reasonCode); id(result.eventRef);
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/u.test(code)) stop('error', 'invalid-shared-output');
    stop(status as Failure, code); // Checked against the complete failure union above.
  }
}
export function failed(status: Failure, code: string, eventRef = 'telemetry-unavailable'): Outcome {
  return { status, reasonCode: code, safeMessage: 'Assessment could not be completed safely.', nextAction: 'Review the failure and trusted configuration before a new invocation.', eventRef };
}
export function observedUsage(raw: unknown, reservationRef: string, ceiling: ReserveCeiling, production?: ProductionProfile): Usage {
  const uncertain: Usage = { inputTokens: ceiling.inputTokens, outputTokens: ceiling.outputTokens, totalTokens: ceiling.totalTokens,
    costUnits: ceiling.costUnits, state: 'uncertain', reservationRef };
  try {
    const field: unknown = raw && typeof raw === 'object' ? Object.getOwnPropertyDescriptor(raw, 'usage')?.value : undefined;
    const value = record(field, ['inputTokens', 'outputTokens', 'totalTokens', 'costUnits', 'state', 'reservationRef']);
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'costUnits'] as const) {
      if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > ceiling[key]) return uncertain;
    }
    if (value.state !== 'settled' || value.reservationRef !== reservationRef || value.totalTokens !== Number(value.inputTokens) + Number(value.outputTokens)
      || value.costUnits !== (production ? priceUsage(production.pricing, Number(value.inputTokens), Number(value.outputTokens)) : value.totalTokens)) return uncertain;
    return value as Usage; // Closed usage fields, arithmetic, fixture pricing and binding checked above.
  } catch { return uncertain; }
}
export function clock(now: () => number): number {
  const result = now();
  if (!Number.isSafeInteger(result) || result < 0) stop('invalid-input', 'invalid-clock');
  return result;
}
export async function bounded(call: () => Promise<unknown>, timeoutMs: number): Promise<unknown> {
  if (timeoutMs <= 0) stop('timeout', 'deadline-exceeded');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(call), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Stopped('timeout', 'operation-timeout')), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

