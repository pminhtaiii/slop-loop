/**
 * Production console approval port (T046) over the actual UC-05 approval service.
 *
 * It owns no policy: it resolves an experiment to its owner task, reads the owner's current
 * pending presentation, and forwards only an operator-submitted decision. Refusals stay the
 * service's own; this module only translates them into the console's `ServiceResult` union.
 */
import type { SafeOperationOutcome } from '../contracts/approvals/contracts.ts';
import { ApprovalServiceError, type ApprovalService } from '../approvals/service.ts';
import type { ConsoleApprovalPort } from './console-server.ts';
import { fail, ok, type ServiceFailure, type ServiceResult } from './evaluation-service.ts';

/** Experiment to owner task id; `undefined` when the experiment has no task. */
export type ConsoleTaskResolver = (experimentId: string) => string | undefined | Promise<string | undefined>;

const FAILURE: Readonly<Record<SafeOperationOutcome, ServiceFailure>> = {
  ok: 'conflict',
  pending: 'conflict',
  paused: 'conflict',
  denied: 'blocked',
  invalid: 'invalid-input',
  conflict: 'conflict',
  stale: 'conflict',
  unavailable: 'busy',
  uncertain: 'busy',
};
const REQUEST_KEYS = ['experimentId', 'idempotencyKey', 'presentationDigest', 'expectedVersion', 'decision'] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^(?:sha256:)?([a-f0-9]{64})$/u;

interface DecisionRequest {
  readonly experimentId: string;
  readonly responseKey: string;
  readonly presentationDigest: string;
  readonly requestVersion: number;
  readonly decision: 'approve' | 'reject';
}

/** Exact operator body; anything else leaves the service uncalled. */
function decisionRequest(input: unknown): DecisionRequest | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return undefined;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== REQUEST_KEYS.length || !REQUEST_KEYS.every(key => Object.hasOwn(record, key))) return undefined;
  const { experimentId, idempotencyKey, presentationDigest, expectedVersion, decision } = record;
  if (typeof experimentId !== 'string' || !ID.test(experimentId)) return undefined;
  if (typeof idempotencyKey !== 'string' || !ID.test(idempotencyKey)) return undefined;
  const digest = typeof presentationDigest === 'string' ? DIGEST.exec(presentationDigest)?.[1] : undefined;
  if (digest === undefined || typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return undefined;
  if (decision !== 'approve' && decision !== 'reject') return undefined;
  return { experimentId, responseKey: idempotencyKey, presentationDigest: `sha256:${digest}`, requestVersion: expectedVersion, decision };
}

function refusal(error: unknown): ServiceResult<never> {
  return error instanceof ApprovalServiceError ? fail(FAILURE[error.outcome], error.reasonCode) : fail('blocked', 'APPROVAL_UNAVAILABLE');
}

/**
 * Builds the console port over a real approval service. `presentation` reads the pending
 * `service.show` view for the experiment's task; `decide` forwards the operator's digest,
 * version, choice and key with the host-resolved task and control version. The service keeps
 * its own stale, duplicate and binding refusals, so no decision is recorded without input.
 */
export function createConsoleApprovalPort(service: ApprovalService, resolveTask: ConsoleTaskResolver): ConsoleApprovalPort {
  // The service names a decision only while it is pending, so remember the last one it presented;
  // that is what lets a replay reach the service's own duplicate refusal.
  // shortcut: the memory is per process, so a duplicate key after a console restart answers
  // NO_PENDING_APPROVAL; upgrade by reading the resolution by responseKey from `service.history`.
  const presented = new Map<string, string>();
  const taskOf = async (experimentId: string): Promise<string | undefined> => (ID.test(experimentId) ? resolveTask(experimentId) : undefined);

  return {
    async presentation(experimentId) {
      const taskId = await taskOf(experimentId);
      if (taskId === undefined) return fail('not-found', 'UNKNOWN_EXPERIMENT');
      try {
        const { decisionId } = await service.list(taskId);
        if (decisionId === null) return fail('not-found', 'NO_PENDING_APPROVAL');
        const view = await service.show(taskId, decisionId);
        presented.set(experimentId, decisionId);
        return ok({ taskId, ...view });
      } catch (error) {
        return refusal(error);
      }
    },
    async decide(input) {
      const request = decisionRequest(input);
      if (request === undefined) return fail('invalid-input', 'INVALID_DECISION_REQUEST');
      const taskId = await taskOf(request.experimentId);
      if (taskId === undefined) return fail('not-found', 'UNKNOWN_EXPERIMENT');
      try {
        const { control, decisionId } = await service.list(taskId);
        const decisionRef = decisionId ?? presented.get(request.experimentId);
        if (decisionRef === undefined) return fail('not-found', 'NO_PENDING_APPROVAL');
        const result = await service.decide({
          taskId,
          decisionId: decisionRef,
          taskVersion: control.version,
          requestVersion: request.requestVersion,
          presentationDigest: request.presentationDigest,
          decision: request.decision,
          responseKey: request.responseKey,
        });
        if (result.eventRef === null) return fail(FAILURE[result.outcome], result.safeReasonCode);
        presented.set(request.experimentId, decisionRef);
        return ok(result);
      } catch (error) {
        // An unexpected failure may follow a committed decision; let the CLI report it as uncertain.
        if (!(error instanceof ApprovalServiceError)) throw error;
        return refusal(error);
      }
    },
  };
}
