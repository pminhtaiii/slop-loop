/**
 * Per-run runaway stop and call usage reporting for the DeepSeek transport (T049).
 *
 * A call is charged its admitted maxima before dispatch, so an uncertain call never counts as
 * zero; only a 2xx response with parsed usage replaces the provisional charge. There is no
 * economic cap: the cost is a labelled estimate and is never used to block a call.
 *
 * Owned path: src/foundation/run-usage-limit.ts
 */

import type { ProviderUsage } from '../contracts/foundation/uc03.ts';

export interface RunUsageLimits {
  readonly totalModelCalls: number;
  readonly perRunInputTokens: number;
  readonly perRunOutputTokens: number;
}

export interface RunCallAdmission {
  readonly taskId: string;
  readonly runId: string;
  readonly callId: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

/** The task/run/call identity a charge and its report are keyed by. */
export type CallUsageIdentity = Pick<RunCallAdmission, 'taskId' | 'runId' | 'callId'>;

export interface RunUsageCounters {
  readonly taskId: string;
  readonly runId: string;
  readonly calls: number;
  readonly inputTokensCharged: number;
  readonly outputTokensCharged: number;
}

/** CallUsageReport: tokens or `unknown`, plus a cost that is only an estimate. */
export interface CallUsageReport {
  readonly callId: string;
  readonly inputTokens: number | 'unknown';
  readonly outputTokens: number | 'unknown';
  readonly costUsd: number | 'unknown';
  readonly costLabel: 'estimate-unverified' | 'unknown';
}

export interface RunUsageLimiter {
  /** True when the call may dispatch; a false result must be denied before `fetch`. */
  admit(call: RunCallAdmission): boolean;
  /** Replaces the provisional charge only when observed usage was parsed from a 2xx response. */
  settle(call: RunCallAdmission, usage?: ProviderUsage | undefined): void;
  /** The report for one call of one run; the identity is the same one that keys its charge. */
  reportFor(call: CallUsageIdentity): CallUsageReport | undefined;
  countersFor(taskId: string, runId: string): RunUsageCounters | undefined;
}

interface Charge {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface RunCounters {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function createRunUsageLimiter(limits: RunUsageLimits): RunUsageLimiter {
  const candidate: Partial<RunUsageLimits> = typeof limits === 'object' && limits !== null ? limits : {};
  const { totalModelCalls, perRunInputTokens, perRunOutputTokens } = candidate;
  if (!isPositiveInteger(totalModelCalls) || !isPositiveInteger(perRunInputTokens) || !isPositiveInteger(perRunOutputTokens)) {
    throw new Error('INVALID_RUN_LIMITS: run limits must be finite positive integers');
  }
  const runs = new Map<string, RunCounters>();
  const charges = new Map<string, Charge & { readonly key: string }>();
  const reports = new Map<string, CallUsageReport>();

  const keyOf = (taskId: string, runId: string): string => JSON.stringify([taskId, runId]);
  // A charge and its report belong to one run, so a call id reused by another run never settles or reports it.
  const chargeKeyOf = (call: CallUsageIdentity): string => JSON.stringify([call.taskId, call.runId, call.callId]);
  const unknownReport = (callId: string): CallUsageReport => ({ callId, inputTokens: 'unknown', outputTokens: 'unknown', costUsd: 'unknown', costLabel: 'unknown' });

  return {
    admit(call) {
      if (typeof call.taskId !== 'string' || !call.taskId || typeof call.runId !== 'string' || !call.runId) return false;
      if (!isTokenCount(call.maxInputTokens) || !isTokenCount(call.maxOutputTokens)) return false;
      const key = keyOf(call.taskId, call.runId);
      const counters = runs.get(key) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
      if (counters.calls >= totalModelCalls) return false;
      if (counters.inputTokens + call.maxInputTokens > perRunInputTokens) return false;
      if (counters.outputTokens + call.maxOutputTokens > perRunOutputTokens) return false;
      runs.set(key, { calls: counters.calls + 1, inputTokens: counters.inputTokens + call.maxInputTokens, outputTokens: counters.outputTokens + call.maxOutputTokens });
      charges.set(chargeKeyOf(call), { key, inputTokens: call.maxInputTokens, outputTokens: call.maxOutputTokens });
      reports.set(chargeKeyOf(call), unknownReport(call.callId));
      return true;
    },
    settle(call, usage) {
      const chargeKey = chargeKeyOf(call);
      const charge = charges.get(chargeKey);
      if (charge === undefined) return;
      charges.delete(chargeKey);
      if (usage === undefined) return;
      const counters = runs.get(charge.key);
      if (counters !== undefined) {
        runs.set(charge.key, {
          ...counters,
          inputTokens: counters.inputTokens - charge.inputTokens + usage.inputTokens,
          outputTokens: counters.outputTokens - charge.outputTokens + usage.outputTokens,
        });
      }
      reports.set(chargeKey, { callId: call.callId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd, costLabel: 'estimate-unverified' });
    },
    reportFor(call) {
      return reports.get(chargeKeyOf(call));
    },
    countersFor(taskId, runId) {
      const counters = runs.get(keyOf(taskId, runId));
      return counters === undefined ? undefined : { taskId, runId, calls: counters.calls, inputTokensCharged: counters.inputTokens, outputTokensCharged: counters.outputTokens };
    },
  };
}
