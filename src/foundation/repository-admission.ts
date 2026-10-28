import {
  computeActionDigest,
  computeCanonicalSha256,
  validateNormalizedAction,
} from '../contracts/foundation/uc03.ts';
import { validateRepositoryAdmissionV02 } from '../contracts/foundation/uc03/v02/admission/repository.ts';
import {
  validateExecutionLimits,
} from '../contracts/foundation/uc03.ts';
import type { ApplyPatchAction, CheckDefinition, CommandView, ExecutionLimits, RunCommandAction, ValidationError } from '../contracts/foundation/uc03/v01/types.ts';
import { validateCheckDefinition } from '../contracts/foundation/uc03/v01/validation/intake/limits.ts';
import type {
  RepositoryAdmissionContextV02,
} from '../contracts/foundation/uc03/v02/ports.ts';

export interface BoundPatchAdmission {
  readonly context: RepositoryAdmissionContextV02;
  readonly patch: ApplyPatchAction;
  readonly baseRevision: string;
}

export interface RepositoryCommandResourcePolicy {
  readonly isolationProfileRef: string;
  readonly limits: ExecutionLimits;
}

export interface BoundCommandAdmission {
  readonly context: RepositoryAdmissionContextV02;
  readonly action: RunCommandAction;
}

export function snapshotRepositoryAdmission(
  input: unknown,
  expectedActionKind: 'apply_patch' | 'run_command',
): RepositoryAdmissionContextV02 {
  const result = validateRepositoryAdmissionV02(input);
  if (!result.ok) {
    throw new Error(`INVALID_ADMISSION_CONTEXT: ${result.errors.map((error) => error.code).join(',')}`);
  }
  if (result.value.action.kind !== expectedActionKind) {
    throw new Error(`INVALID_ADMISSION_CONTEXT: Expected action kind '${expectedActionKind}'`);
  }

  const context = structuredClone(result.value);
  deepFreeze(context);
  return context;
}

export function dockerCommandView(context: RepositoryAdmissionContextV02): CommandView {
  const view = context.commandView;
  if (!view) throw new Error('COMMAND_VIEW_REQUIRED: Admitted command view is required');
  return {
    viewId: view.viewId,
    viewDigest: view.viewDigest,
    taskId: view.taskId,
    workspaceId: view.workspaceId,
    canonicalRevisionDigest: view.canonicalRevision,
    admittedFiles: view.admittedFiles,
    exclusionsPolicyVersion: view.exclusionsPolicyVersion,
    scratchIdentity: view.scratchIdentity,
    mountedReadOnly: view.mountedReadOnly,
  };
}

export function bindCommandToAdmission(
  input: unknown,
  context: RepositoryAdmissionContextV02,
): BoundCommandAdmission {
  const actionResult = validateNormalizedAction(input);
  if (!actionResult.ok || actionResult.value.kind !== 'run_command') {
    throw new Error(`INVALID_COMMAND: ${actionResult.ok ? 'Expected run_command action' : actionResult.errors.map((error) => error.code).join(',')}`);
  }
  if (context.action.kind !== 'run_command' ||
    computeActionDigest(actionResult.value) !== context.actionDigest ||
    computeActionDigest(context.action) !== context.actionDigest) {
    throw new Error('COMMAND_ADMISSION_MISMATCH: Submitted action does not match the admitted command');
  }
  const action = Object.freeze({ ...actionResult.value, argv: Object.freeze([...actionResult.value.argv]) });
  return { context, action };
}

export function bindCheckToAdmission(
  input: unknown,
  context: RepositoryAdmissionContextV02,
): CheckDefinition {
  const errors: ValidationError[] = [];
  const check = validateCheckDefinition(input, 'check', errors);
  if (!check || errors.length > 0) {
    throw new Error(`INVALID_CHECK: ${errors.map((error) => error.code).join(',')}`);
  }
  if (context.action.kind !== 'run_command' || !context.checkId || context.checkId !== check.checkId ||
    context.action.executable !== check.executable ||
    context.action.argv.length !== check.argv.length ||
    context.action.argv.some((argument, index) => argument !== check.argv[index]) ||
    context.action.workingDirectory !== check.workingDirectory) {
    throw new Error('CHECK_ADMISSION_MISMATCH: Requested check does not match the admitted command');
  }
  return Object.freeze({ ...check, argv: Object.freeze([...check.argv]) });
}

export function commandExecutionLimits(
  context: RepositoryAdmissionContextV02,
  policy: RepositoryCommandResourcePolicy,
): ExecutionLimits {
  const bounds = context.finiteBounds;
  if (!bounds || !('timeoutMs' in bounds) || !context.commandView ||
    bounds.isolationProfileRef !== context.commandView.isolationProfileRef ||
    bounds.isolationProfileRef !== policy.isolationProfileRef) {
    throw new Error('COMMAND_RESOURCE_POLICY_MISMATCH: Required command bounds and trusted profile must match');
  }
  const trusted = validateExecutionLimits(policy.limits);
  if (!trusted.ok) {
    throw new Error(`COMMAND_RESOURCE_POLICY_INVALID: ${trusted.errors.map((error) => error.code).join(',')}`);
  }
  const timeoutMs = Math.min(bounds.timeoutMs, trusted.value.timeoutMs);
  const maxCpuCores = bounds.maxCpuSeconds === undefined
    ? trusted.value.maxCpuCores
    // A CPU-time budget over the wall-time deadline becomes a safe average core cap.
    : Math.min(trusted.value.maxCpuCores, bounds.maxCpuSeconds * 1000 / timeoutMs);
  const limits: ExecutionLimits = {
    timeoutMs,
    maxOutputBytes: Math.min(bounds.maxOutputBytes, trusted.value.maxOutputBytes),
    maxCpuCores,
    maxMemoryBytes: Math.min(bounds.maxMemoryBytes ?? trusted.value.maxMemoryBytes, trusted.value.maxMemoryBytes),
    maxPids: Math.min(bounds.maxProcessCount ?? trusted.value.maxPids, trusted.value.maxPids),
  };
  const validation = validateExecutionLimits(limits);
  if (!validation.ok) {
    throw new Error(`COMMAND_RESOURCE_POLICY_INVALID: ${validation.errors.map((error) => error.code).join(',')}`);
  }
  return validation.value;
}

export function bindPatchToAdmission(
  input: unknown,
  context: RepositoryAdmissionContextV02,
): BoundPatchAdmission {
  const action = validateNormalizedAction(input);
  if (!action.ok || action.value.kind !== 'apply_patch') {
    throw new Error(`INVALID_PATCH: ${action.ok ? 'Expected apply_patch action' : action.errors.map((error) => error.code).join(',')}`);
  }
  if (context.action.kind !== 'apply_patch' || !context.baseRevision || !context.targetPaths || !context.patchDigest) {
    throw new Error('PATCH_ADMISSION_MISMATCH: Patch admission binding is incomplete');
  }

  const patch = Object.freeze({
    ...action.value,
    targetPaths: Object.freeze([...action.value.targetPaths]),
  });
  const bounds = context.finiteBounds;
  if (!bounds || !('maxPatchBytes' in bounds)) {
    throw new Error('PATCH_BOUNDS_REQUIRED: Finite patch bounds are required');
  }
  if (
    computeActionDigest(patch) !== context.actionDigest ||
    computeActionDigest(context.action) !== context.actionDigest ||
    patch.baseRevisionDigest !== context.baseRevision ||
    context.baseRevision !== context.canonicalRevision ||
    patch.targetPaths.length !== context.targetPaths.length ||
    patch.targetPaths.some((path, index) => path !== context.targetPaths?.[index]) ||
    computeCanonicalSha256(patch.patchContent) !== context.patchDigest ||
    new TextEncoder().encode(patch.patchContent).length > bounds.maxPatchBytes ||
    patch.targetPaths.length > bounds.maxChangedPaths
  ) {
    throw new Error('PATCH_ADMISSION_MISMATCH: Submitted patch does not match the admitted action and bounds');
  }

  return { context, patch, baseRevision: context.baseRevision };
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}
