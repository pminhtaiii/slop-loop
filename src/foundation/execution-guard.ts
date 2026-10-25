import { validateRepositoryExecutionReceiptV02 } from '../contracts/foundation/uc03/attempt-v02.ts';
import { validateRepositoryClaimV02 } from './repository-claim-lifecycle.ts';
import { normalizeCommandResult } from './repository-command-outcome.ts';
/**
 * UC-03 Phase 5 - Execution Guard Foundation (T022 Authoritative SUT)
 *
 * Owned path: src/foundation/execution-guard.ts
 * Feature: specs/001-verified-code-repair
 *
 * SUT for ExecutionGuard composing:
 * - Deterministic pre-dispatch envelope, isolation, and limits validation.
 * - UC-05 approval classification and policy enforcement (no reimplementation).
 * - UC-04 atomic multi-budget reservation, CAS state transitions, and settlement.
 * - Isolated repository execution via RepositoryPort / RepositoryPortV02.
 *
 * T022 Status: Authoritative v0.2 ExecutionGuardV02 surface with source-compatible v0.1 ExecutionGuard.
 */

import type {
  ExecutionGuard,
  ExecutionGuardV02,
  ExecutionGuardResultV02,
  RepositoryAdmissionContextV02,
  StatePortV02,
  RepositoryPortV02,
  PortProvenance,
  NormalizedAction,
  TaskState,
  EnvelopeOutcome,
  StatePort,
  ApprovalPort,
  RepositoryPort,
  TelemetryPort,
  CommandView,
  ApplyPatchAction,
  RunCommandAction,
} from '../contracts/foundation/uc03.ts';
import {
  computeCanonicalSha256,
  computeActionDigest,
  isCanonicalRelativePath,
  isProtectedPath,
  validateNormalizedAction,
  validateTaskState,
} from '../contracts/foundation/uc03.ts';
import { validateRepositoryAdmissionV02 as validateRepositoryAdmissionRecordV02 } from '../contracts/foundation/uc03/admission-v02/repository.ts';

export type {
  ExecutionGuardV02,
  ExecutionGuardResultV02,
  RepositoryAdmissionContextV02,
  StatePortV02,
  RepositoryPortV02,
};

export interface ExecutionGuardPorts {
  readonly statePort: StatePort;
  readonly approvalPort: ApprovalPort;
  readonly repositoryPort: RepositoryPort;
  readonly telemetryPort?: TelemetryPort | undefined;
}

export interface ExecutionGuardConfig {
  readonly provenance?: PortProvenance | undefined;
  readonly commandView?: CommandView | undefined;
  readonly defaultTimeoutMs?: number | undefined;
}

export interface ExecutionGuardOptions {
  readonly ports: ExecutionGuardPorts;
  readonly config?: ExecutionGuardConfig | undefined;
}

export interface ExecutionGuardResult {
  readonly outcome: EnvelopeOutcome;
  readonly result?: unknown;
  readonly reason?: string | undefined;
}

/* ------------------------------------------------------------------
 * Additive v0.2 Ports, Config, Options, and Types (T059 / T022)
 * ------------------------------------------------------------------ */

export interface ExecutionGuardPortsV02 {
  readonly statePort: ExecutionGuardStatePortV02;
  readonly approvalPort?: ApprovalPort | undefined;
  readonly repositoryPort: ExecutionGuardRepositoryPortV02;
  readonly telemetryPort?: TelemetryPort | undefined;
}

/** Guard-local adapter marker only; it does not grant admission or approval authority. */
export interface ExecutionGuardStatePortV02 extends StatePortV02 {
  readonly executionGuardApiVersion: '0.2.0';
}

/** Guard-local adapter marker only; it does not grant admission or approval authority. */
export interface ExecutionGuardRepositoryPortV02 extends RepositoryPortV02 {
  readonly executionGuardApiVersion: '0.2.0';
}

export interface ExecutionGuardConfigV02 {
  readonly provenance?: PortProvenance | undefined;
  readonly commandView?: CommandView | undefined;
  readonly defaultTimeoutMs?: number | undefined;
}

export interface ExecutionGuardOptionsV02 {
  readonly ports: ExecutionGuardPortsV02;
  readonly config?: ExecutionGuardConfigV02 | undefined;
}

interface ExecutionGuardOptionsFor<
  TPorts extends ExecutionGuardPorts | ExecutionGuardPortsV02,
> {
  readonly ports: TPorts;
  readonly config?: ExecutionGuardConfig | ExecutionGuardConfigV02 | undefined;
};

const STATE_PORT_V02_METHODS = [
  'loadTask', 'transition', 'claim', 'beginAttempt', 'recordOutcome',
  'reconcileObservedOutcome', 'reconcileUncertain', 'closeUnattemptedClaim', 'checkpoint', 'recover',
] as const;
const REPOSITORY_PORT_V02_METHODS = [
  'listDir', 'readFile', 'searchCode', 'applyPatch', 'runCommand', 'runTests', 'inspectDiff',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasGuardV02Marker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    const marker = Object.getOwnPropertyDescriptor(value, 'executionGuardApiVersion');
    return marker !== undefined && 'value' in marker && marker.value === '0.2.0';
  } catch {
    return false;
  }
}

function hasMethod(value: unknown, name: string): boolean {
  if (!isRecord(value)) return false;
  try {
    let current: object | null = value;
    while (current) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) return 'value' in descriptor && typeof descriptor.value === 'function';
      current = Object.getPrototypeOf(current);
    }
    return false;
  } catch {
    return false;
  }
}

function hasGuardV02Port(value: unknown, methods: readonly string[]): boolean {
  // The marker selects the adapter version; these descriptors only validate completeness without invoking ports.
  return hasGuardV02Marker(value) && methods.every((method) => hasMethod(value, method));
}

function isExecutionGuardPortsV02(value: unknown): value is ExecutionGuardPortsV02 {
  if (!isRecord(value)) return false;
  try {
    const state = Object.getOwnPropertyDescriptor(value, 'statePort');
    const repository = Object.getOwnPropertyDescriptor(value, 'repositoryPort');
    return state !== undefined && 'value' in state &&
      repository !== undefined && 'value' in repository &&
      hasGuardV02Port(state.value, STATE_PORT_V02_METHODS) &&
      hasGuardV02Port(repository.value, REPOSITORY_PORT_V02_METHODS);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------
 * ExecutionGuard / ExecutionGuardV02 Implementations
 * ------------------------------------------------------------------ */

export class AuthoritativeExecutionGuard<
  TPorts extends ExecutionGuardPorts | ExecutionGuardPortsV02 = ExecutionGuardPorts,
> implements ExecutionGuard {
  readonly provenance: PortProvenance;
  readonly ports: TPorts;
  readonly config?: ExecutionGuardConfig | ExecutionGuardConfigV02 | undefined;

  constructor(options: ExecutionGuardOptionsFor<TPorts>) {
    this.provenance = options.config?.provenance ?? 'mock';
    this.ports = options.ports;
    this.config = options.config;
  }

  async validateAndExecute(
    _action: NormalizedAction,
    _state: TaskState,
    context?: RepositoryAdmissionContextV02
  ): Promise<ExecutionGuardResultV02> {
    return context === undefined
      ? { outcome: 'denied', reason: 'ADMISSION_CONTEXT_REQUIRED: Admission context is required; v0.1 compatibility is no-dispatch' }
      : { outcome: 'denied', reason: 'V02_GUARD_REQUIRED: v0.1 guard is no-dispatch for v0.2 admission' };
  }

  protected async validateAndExecuteV02(
    this: AuthoritativeExecutionGuard<ExecutionGuardPortsV02>,
    action: NormalizedAction,
    state: TaskState,
    context: RepositoryAdmissionContextV02
  ): Promise<ExecutionGuardResultV02> {
    if (!isExecutionGuardPortsV02(this.ports)) {
      return { outcome: 'denied', reason: 'PORT_VERSION_MISMATCH: Guard requires marked v0.2 state and repository adapters' };
    }

    const validAction = validateNormalizedAction(action);
    if (!validAction.ok) {
      return {
        outcome: 'denied',
        reason: `INVALID_ACTION: ${validAction.errors.map((e) => e.message).join('; ')}`,
      };
    }

    const validState = validateTaskState(state);
    if (!validState.ok) {
      return {
        outcome: 'denied',
        reason: `INVALID_TASK_STATE: ${validState.errors.map((e) => e.message).join('; ')}`,
      };
    }

    if (
      !context ||
      typeof context !== 'object' ||
      context.schemaVersion !== '0.2.0' ||
      context.subjectKind !== 'repository-action'
    ) {
      return {
        outcome: 'denied',
        reason: 'INVALID_ADMISSION_CONTEXT: Context must be a 0.2.0 repository-action admission record',
      };
    }

    const validContext = validateRepositoryAdmissionRecordV02(context);
    if (!validContext.ok) {
      return {
        outcome: 'denied',
        reason: `INVALID_ADMISSION_CONTEXT: ${validContext.errors.map((e) => e.message).join('; ')}`,
      };
    }

    context = validContext.value;
    const computedActionDigest = computeActionDigest(action);
    if (
      context.actionDigest !== computedActionDigest ||
      computeActionDigest(context.action) !== computedActionDigest
    ) {
      return {
        outcome: 'denied',
        reason: 'ACTION_DIGEST_MISMATCH: Action digest does not match admission context',
      };
    }

    if (context.action.actionId !== action.actionId || context.action.kind !== action.kind) {
      return {
        outcome: 'denied',
        reason: 'ACTION_IDENTITY_MISMATCH: Action identity does not match admission context action',
      };
    }

    if (
      context.taskId !== state.taskId ||
      context.runId !== state.runId ||
      context.workspaceId !== state.workspaceId ||
      context.repositoryId !== state.repositoryId ||
      context.canonicalRevision !== state.repositoryRevisionDigest ||
      context.runnableNode !== state.node ||
      context.expectedTaskStateVersion !== state.stateVersion
    ) {
      return {
        outcome: 'denied',
        reason: 'STATE_CONTEXT_MISMATCH: Task state does not match admission context expectations',
      };
    }

    if (context.planApplicability === 'pre-plan-diagnostic') {
      if (state.node !== 'Investigate' || state.plan !== undefined || state.activeDecisionId !== undefined) {
        return {
          outcome: 'denied',
          reason: 'DIAGNOSTIC_STATE_VIOLATION: Pre-plan diagnostic check requires Investigate node without plan',
        };
      }
    } else if (context.planApplicability === 'approved-plan') {
      if (
        !state.plan ||
        state.plan.decisionRef !== context.planDecisionRef ||
        state.activeDecisionId !== context.planDecisionRef
      ) {
        return {
          outcome: 'denied',
          reason: 'APPROVED_PLAN_MISMATCH: Task state does not have the expected approved plan binding',
        };
      }
      const planDigest = computeCanonicalSha256({
        taskId: state.taskId,
        planVersion: state.plan.planVersion,
        strategyDigest: state.plan.strategyDigest,
        baselineRef: state.plan.baselineRef,
        evidenceRefs: state.plan.evidenceRefs,
        criteriaDigest: computeCanonicalSha256(state.acceptanceCriteria),
        checkSetDigest: state.plan.checkSetDigest,
        decisionRef: state.plan.decisionRef,
      });
      if (context.planBindingDigest !== planDigest) {
        return {
          outcome: 'denied',
          reason: 'PLAN_BINDING_MISMATCH: Plan binding digest does not match task state plan',
        };
      }
    }

    let currentState: TaskState | null;
    try {
      currentState = await this.ports.statePort.loadTask(state.taskId);
    } catch {
      return { outcome: 'denied', reason: 'AUTHORITATIVE_STATE_UNAVAILABLE: Authoritative state is unavailable' };
    }
    if (!currentState || !validateTaskState(currentState).ok) {
      return { outcome: 'denied', reason: 'AUTHORITATIVE_STATE_UNAVAILABLE: Authoritative state is unavailable or invalid' };
    }
    if (computeCanonicalSha256(currentState) !== computeCanonicalSha256(state)) {
      return { outcome: 'conflict', reason: 'STATE_CAS_CONFLICT: Supplied state differs from authoritative state' };
    }

    const pe = context.policyEvaluationReceipt;
    if (pe.result === 'FORBIDDEN') {
      return {
        outcome: 'denied',
        reason: 'FORBIDDEN_POLICY: Action is forbidden by policy evaluation receipt',
      };
    }
    if (pe.result === 'APPROVAL_REQUIRED') {
      const ad = context.actionDecisionReceipt;
      if (!ad) {
        return {
          outcome: 'pending-approval',
          reason: 'APPROVAL_REQUIRED: Action requires explicit approval decision',
        };
      }
      if (ad.status !== 'approved') {
        return {
          outcome: 'denied',
          reason: `ACTION_DECISION_DENIED: Action decision status is '${ad.status}'`,
        };
      }
      if (ad.actionDigest !== context.actionDigest || ad.evaluationReceiptRef !== pe.receiptId) {
        return {
          outcome: 'denied',
          reason: 'DECISION_RECEIPT_MISMATCH: Action decision receipt does not match policy evaluation or action',
        };
      }
    }

    if (action.kind === 'apply_patch') {
      const patch = action as ApplyPatchAction;
      if (
        context.baseRevision !== state.repositoryRevisionDigest ||
        patch.baseRevisionDigest !== state.repositoryRevisionDigest
      ) {
        return {
          outcome: 'denied',
          reason: 'BASE_REVISION_MISMATCH: Base revision does not match current repository revision',
        };
      }
      for (const target of patch.targetPaths) {
        if (!isCanonicalRelativePath(target)) {
          return {
            outcome: 'denied',
            reason: `WORKSPACE_ESCAPE: Target path '${target}' is not canonical`,
          };
        }
        if (isProtectedPath(target)) {
          return {
            outcome: 'denied',
            reason: `PROTECTED_PATH_FORBIDDEN: Target path '${target}' is protected`,
          };
        }
      }
    } else if (action.kind === 'run_command') {
      if (!context.commandView) {
        return {
          outcome: 'denied',
          reason: 'MISSING_COMMAND_VIEW: Command execution requires admitted commandView in context',
        };
      }
      if (context.commandView.canonicalRevision !== state.repositoryRevisionDigest) {
        return {
          outcome: 'denied',
          reason: 'COMMAND_VIEW_REVISION_DRIFT: Command view canonical revision does not match repository revision',
        };
      }
      if (context.commandView.mountedReadOnly !== true) {
        return {
          outcome: 'denied',
          reason: 'READONLY_REQUIRED: Command view must be mounted read-only',
        };
      }
    }

    try {
      let res: unknown;
      if (action.kind === 'apply_patch') {
        res = await this.ports.repositoryPort.applyPatch(
          action as ApplyPatchAction,
          context
        );
      } else if (action.kind === 'run_command') {
        res = await this.ports.repositoryPort.runCommand(
          action as RunCommandAction,
          context
        );
      } else {
        return {
          outcome: 'denied',
          reason: `UNSUPPORTED_ACTION_KIND: ${(action as NormalizedAction).kind}' is not supported`,
        };
      }

      if (!res || typeof res !== 'object' || !('executionReceipt' in res)) {
        return { outcome: 'uncertain-effect', reason: 'INVALID_EXECUTION_RECEIPT: Receiver omitted settled evidence' };
      }
      const receipt = validateRepositoryExecutionReceiptV02(res.executionReceipt, context);
      if (!receipt.ok || !validateRepositoryClaimV02(receipt.value.claim, context)) {
        return { outcome: 'uncertain-effect', reason: 'INVALID_EXECUTION_RECEIPT: Receiver handoff binding failed' };
      }
      if (action.kind === 'apply_patch') {
        if (!('applied' in res) || res.applied !== true || !('newRevisionDigest' in res) ||
          res.newRevisionDigest !== receipt.value.outcome.observedResultRevisionDigest) {
          return { outcome: 'uncertain-effect', reason: 'INVALID_PATCH_RESULT: Observed revision mismatch' };
        }
      } else {
        const normalized = normalizeCommandResult(res);
        const bounds = context.finiteBounds;
        if (!normalized || !bounds || !('timeoutMs' in bounds) ||
          Buffer.byteLength(normalized.stdout, 'utf8') + Buffer.byteLength(normalized.stderr, 'utf8') > bounds.maxOutputBytes ||
          normalized.exitCode === null || normalized.timedOut ||
          normalized.outcome === 'timeout' || normalized.outcome === 'error') {
          return { outcome: 'uncertain-effect', reason: 'INVALID_COMMAND_RESULT: No bounded observed command result' };
        }
        const digest = computeCanonicalSha256({ attemptId: receipt.value.attempt.attemptId,
          actionDigest: context.actionDigest, outcome: 'observed', observedResultDigest: normalized.digest });
        if (receipt.value.outcome.resultRef.digest !== digest ||
          receipt.value.outcome.resultRef.reference !== `command-result-${digest.slice(7)}`) {
          return { outcome: 'uncertain-effect', reason: 'INVALID_COMMAND_RESULT: Command output digest mismatch' };
        }
      }
      return { outcome: 'success', result: res, attemptId: receipt.value.attempt.attemptId };
    } catch {
      // Invocation may already have taken effect; only the receiver owns recovery.
      return { outcome: 'uncertain-effect', reason: 'RECEIVER_OUTCOME_UNVERIFIED: Receiver invocation requires recovery' };
    }
  }


}

export class AuthoritativeExecutionGuardV02
  extends AuthoritativeExecutionGuard<ExecutionGuardPortsV02>
  implements ExecutionGuardV02
{
  declare readonly ports: ExecutionGuardPortsV02;
  declare readonly config?: ExecutionGuardConfigV02 | undefined;

  override async validateAndExecute(
    action: NormalizedAction,
    state: TaskState,
    context?: RepositoryAdmissionContextV02
  ): Promise<ExecutionGuardResultV02> {
    return context === undefined
      ? { outcome: 'denied', reason: 'ADMISSION_CONTEXT_REQUIRED: Admission context is required; v0.2 dispatch is no-dispatch without context' }
      : this.validateAndExecuteV02(action, state, context);
  }
}

export function createExecutionGuard(
  options: ExecutionGuardOptions
): AuthoritativeExecutionGuard {
  return new AuthoritativeExecutionGuard(options);
}

export function createExecutionGuardV02(
  options: ExecutionGuardOptionsV02
): AuthoritativeExecutionGuardV02 {
  return new AuthoritativeExecutionGuardV02(options);
}
