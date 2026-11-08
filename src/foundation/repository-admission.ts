import { computeActionDigest, computeCanonicalSha256, computeCommandViewDigest, validateNormalizedAction } from '../contracts/foundation/uc03.ts';
import { validateRepositoryAdmissionV02 } from '../contracts/foundation/uc03/v02/admission/repository.ts';
import { validateExecutionLimits } from '../contracts/foundation/uc03.ts';
import type { ApplyPatchAction, CheckDefinition, CommandView, ExecutionLimits, RunCommandAction, ValidationError } from '../contracts/foundation/uc03/v01/types.ts';
import { validateCheckDefinition } from '../contracts/foundation/uc03/v01/validation/intake/limits.ts';
import type { CommandViewV02, RepositoryAdmissionContextV02 } from '../contracts/foundation/uc03/v02/ports.ts';
import { isMeasuredCommandViewIsolation } from './docker-view-builder.ts';
import type { MeasuredCommandViewIsolation } from './docker-view-builder.ts';

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

export function snapshotRepositoryAdmission(input: unknown, expectedActionKind: 'apply_patch' | 'run_command'): RepositoryAdmissionContextV02 {
  const result = validateRepositoryAdmissionV02(input);
  if (!result.ok) {
    throw new Error(`INVALID_ADMISSION_CONTEXT: ${result.errors.map(error => error.code).join(',')}`);
  }
  if (result.value.action.kind !== expectedActionKind) {
    throw new Error(`INVALID_ADMISSION_CONTEXT: Expected action kind '${expectedActionKind}'`);
  }

  const context = structuredClone(result.value);
  deepFreeze(context);
  return context;
}

/**
 * Projects the admitted v0.2 view onto the v0.1 shape the Docker layer publishes and compares.
 * The digest is recomputed over that shape because it drops `isolationProfileRef` and renames
 * `canonicalRevision`; copying the v0.2 digest could never match a builder-published view.
 * Every field is already bound to the trusted context, so re-encoding them adds no trust.
 */
export function dockerCommandView(context: RepositoryAdmissionContextV02): CommandView {
  const view = context.commandView;
  if (!view) throw new Error('COMMAND_VIEW_REQUIRED: Admitted command view is required');
  const projected = {
    viewId: view.viewId,
    taskId: view.taskId,
    workspaceId: view.workspaceId,
    canonicalRevisionDigest: view.canonicalRevision,
    admittedFiles: view.admittedFiles,
    exclusionsPolicyVersion: view.exclusionsPolicyVersion,
    scratchIdentity: view.scratchIdentity,
    mountedReadOnly: view.mountedReadOnly,
  };
  return { ...projected, viewDigest: computeCommandViewDigest(projected) };
}

/**
 * Lifts the builder-published v0.1 view into v0.2; the digest is recomputed because the two key sets hash differently.
 *
 * §9: the isolation reference comes from the host-owned record the build issued for *this* view, not
 * from the caller. Four ordered refusals, so a genuine record cannot be replayed onto another view and
 * a mutated view cannot borrow its own measurement.
 */
export function admissionCommandView(view: CommandView, measured: MeasuredCommandViewIsolation): CommandViewV02 {
  if (!isMeasuredCommandViewIsolation(measured)) {
    throw new Error('ISOLATION_RECORD_UNMEASURED: Isolation profile reference must come from a host-measured build');
  }
  if (measured.viewId !== view.viewId) {
    throw new Error(`ISOLATION_RECORD_VIEW_MISMATCH: Record belongs to view '${measured.viewId}', not '${view.viewId}'`);
  }
  if (measured.viewDigest !== view.viewDigest) {
    throw new Error('ISOLATION_RECORD_DIGEST_MISMATCH: Record was issued for a different view digest');
  }
  if (computeCommandViewDigest(view) !== view.viewDigest) {
    throw new Error('ISOLATION_RECORD_VIEW_UNHASHED: Command view no longer hashes to its declared digest');
  }
  const projected = {
    viewId: view.viewId,
    taskId: view.taskId,
    workspaceId: view.workspaceId,
    canonicalRevision: view.canonicalRevisionDigest,
    admittedFiles: view.admittedFiles,
    exclusionsPolicyVersion: view.exclusionsPolicyVersion,
    scratchIdentity: view.scratchIdentity,
    mountedReadOnly: view.mountedReadOnly,
    isolationProfileRef: measured.isolationProfileRef,
  };
  // Same canonical hash as the v0.2 admission re-check, which also widens the v0.1-typed signature.
  return { ...projected, viewDigest: computeCommandViewDigest(projected as unknown as CommandView) };
}

export function bindCommandToAdmission(input: unknown, context: RepositoryAdmissionContextV02): BoundCommandAdmission {
  const actionResult = validateNormalizedAction(input);
  if (!actionResult.ok || actionResult.value.kind !== 'run_command') {
    throw new Error(`INVALID_COMMAND: ${actionResult.ok ? 'Expected run_command action' : actionResult.errors.map(error => error.code).join(',')}`);
  }
  if (context.action.kind !== 'run_command' || computeActionDigest(actionResult.value) !== context.actionDigest || computeActionDigest(context.action) !== context.actionDigest) {
    throw new Error('COMMAND_ADMISSION_MISMATCH: Submitted action does not match the admitted command');
  }
  const action = Object.freeze({ ...actionResult.value, argv: Object.freeze([...actionResult.value.argv]) });
  return { context, action };
}

export function bindCheckToAdmission(input: unknown, context: RepositoryAdmissionContextV02): CheckDefinition {
  const errors: ValidationError[] = [];
  const check = validateCheckDefinition(input, 'check', errors);
  if (!check || errors.length > 0) {
    throw new Error(`INVALID_CHECK: ${errors.map(error => error.code).join(',')}`);
  }
  if (
    context.action.kind !== 'run_command' ||
    !context.checkId ||
    context.checkId !== check.checkId ||
    context.action.executable !== check.executable ||
    context.action.argv.length !== check.argv.length ||
    context.action.argv.some((argument, index) => argument !== check.argv[index]) ||
    context.action.workingDirectory !== check.workingDirectory
  ) {
    throw new Error('CHECK_ADMISSION_MISMATCH: Requested check does not match the admitted command');
  }
  return Object.freeze({ ...check, argv: Object.freeze([...check.argv]) });
}

export function commandExecutionLimits(context: RepositoryAdmissionContextV02, policy: RepositoryCommandResourcePolicy): ExecutionLimits {
  const bounds = context.finiteBounds;
  if (
    !bounds ||
    !('timeoutMs' in bounds) ||
    !context.commandView ||
    bounds.isolationProfileRef !== context.commandView.isolationProfileRef ||
    bounds.isolationProfileRef !== policy.isolationProfileRef
  ) {
    throw new Error('COMMAND_RESOURCE_POLICY_MISMATCH: Required command bounds and trusted profile must match');
  }
  const trusted = validateExecutionLimits(policy.limits);
  if (!trusted.ok) {
    throw new Error(`COMMAND_RESOURCE_POLICY_INVALID: ${trusted.errors.map(error => error.code).join(',')}`);
  }
  const timeoutMs = Math.min(bounds.timeoutMs, trusted.value.timeoutMs);
  const maxCpuCores =
    bounds.maxCpuSeconds === undefined
      ? trusted.value.maxCpuCores
      : // A CPU-time budget over the wall-time deadline becomes a safe average core cap.
        Math.min(trusted.value.maxCpuCores, (bounds.maxCpuSeconds * 1000) / timeoutMs);
  const limits: ExecutionLimits = {
    timeoutMs,
    maxOutputBytes: Math.min(bounds.maxOutputBytes, trusted.value.maxOutputBytes),
    maxCpuCores,
    maxMemoryBytes: Math.min(bounds.maxMemoryBytes ?? trusted.value.maxMemoryBytes, trusted.value.maxMemoryBytes),
    maxPids: Math.min(bounds.maxProcessCount ?? trusted.value.maxPids, trusted.value.maxPids),
  };
  const validation = validateExecutionLimits(limits);
  if (!validation.ok) {
    throw new Error(`COMMAND_RESOURCE_POLICY_INVALID: ${validation.errors.map(error => error.code).join(',')}`);
  }
  return validation.value;
}

export function bindPatchToAdmission(input: unknown, context: RepositoryAdmissionContextV02): BoundPatchAdmission {
  const action = validateNormalizedAction(input);
  if (!action.ok || action.value.kind !== 'apply_patch') {
    throw new Error(`INVALID_PATCH: ${action.ok ? 'Expected apply_patch action' : action.errors.map(error => error.code).join(',')}`);
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
