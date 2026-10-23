import { computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import type { CheckDefinition, CheckResult } from '../contracts/foundation/uc03.ts';
import { validateAttemptReceiptV02 } from '../contracts/foundation/uc03/attempt-v02.ts';
import type {
  AttemptReceiptV02,
  ClaimReceiptV02,
  ExecutorIdentityV02,
  RepositoryAdmissionContextV02,
  StatePortV02,
} from '../contracts/foundation/uc03/ports-v02.ts';
import type { ControlledRepositoryToolsOptions } from './repository-types.ts';
import type { ExecutionLimits, RunCommandAction } from '../contracts/foundation/uc03/types.ts';
import {
  dockerCommandView,
} from './repository-admission.ts';
import type {
  DockerWorkspaceManager,
  StructuredCommandExecutor,
  StructuredExecutionResult,
  WorkspaceLease,
} from './docker-workspace.ts';
import {
  bindCheckToAdmission,
  bindCommandToAdmission,
  commandExecutionLimits,
  snapshotRepositoryAdmission,
} from './repository-admission.ts';

const CLAIM_KEYS = [
  'claimId', 'claimDigest', 'taskId', 'runId', 'subjectKind', 'planApplicability',
  'preClaimTaskStateVersion', 'preClaimControlVersion', 'postClaimControlVersion',
  'epoch', 'status', 'reservationRefs',
] as const;

export async function beginRepositoryAttempt(
  statePort: StatePortV02,
  context: RepositoryAdmissionContextV02,
  executorIdentity: ExecutorIdentityV02,
  isRepairPatch: boolean,
  beforeBeginAttempt: () => void,
): Promise<AttemptReceiptV02> {
  return (await beginRepositoryAttemptWithClaim(
    statePort,
    context,
    executorIdentity,
    isRepairPatch,
    beforeBeginAttempt,
  )).attempt;
}

export async function beginRepositoryAttemptWithClaim(
  statePort: StatePortV02,
  context: RepositoryAdmissionContextV02,
  executorIdentity: ExecutorIdentityV02,
  isRepairPatch: boolean,
  beforeBeginAttempt: () => void,
): Promise<{ readonly claim: ClaimReceiptV02; readonly attempt: AttemptReceiptV02 }> {
  const claimInput: unknown = await statePort.claim(context);
  const claim = validateClaim(claimInput, context);
  if (!claim) throw new Error('CLAIM_DENIED: StatePort returned a mismatched repository claim');

  beforeBeginAttempt();
  const attemptInput: unknown = await statePort.beginAttempt(claim.claimId, executorIdentity);
  const result = validateAttemptReceiptV02(attemptInput, {
    expectedTaskId: context.taskId,
    expectedClaimId: claim.claimId,
    isRepairPatch,
  });
  if (!result.ok || !matchesAttempt(result.value, claim, executorIdentity)) {
    throw new Error('BEGIN_ATTEMPT_DENIED: StatePort returned a mismatched attempt receipt');
  }
  return { claim, attempt: result.value };
}

export function assertCurrentPatchFence(
  lease: WorkspaceLease,
  workspaceId: string,
  currentGeneration: number,
  receiverGeneration: number,
): void {
  if (lease.kind !== 'write' || lease.workspaceId !== workspaceId ||
    !Number.isSafeInteger(currentGeneration) || currentGeneration <= 0 ||
    lease.fencingGeneration !== currentGeneration || receiverGeneration !== currentGeneration) {
    throw new Error('FENCED_EXECUTOR: Patch receiver is stale at the invocation boundary');
  }
}

export interface PatchReceiverResult {
  readonly applied: boolean;
  readonly newRevisionDigest: string;
}

export function isPatchReceiverResult(input: unknown): input is PatchReceiverResult {
  if (!isPlainRecord(input) || Object.keys(input).length !== 2 ||
    !Object.hasOwn(input, 'applied') || !Object.hasOwn(input, 'newRevisionDigest')) return false;
  return typeof input['applied'] === 'boolean' && typeof input['newRevisionDigest'] === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(input['newRevisionDigest']);
}

export async function executeAdmittedCommand(options: {
  readonly manager: DockerWorkspaceManager;
  readonly commandExecutor: StructuredCommandExecutor;
  readonly statePort: StatePortV02;
  readonly context: RepositoryAdmissionContextV02;
  readonly action: RunCommandAction;
  readonly limits: ExecutionLimits;
  readonly adapterIdentity: string;
  readonly processIncarnation: string;
  readonly fencingGeneration: number;
}): Promise<StructuredExecutionResult> {
  const { manager, commandExecutor, statePort, context, action } = options;
  const lease = await manager.acquireReadLease(context.workspaceId, context.canonicalRevision);
  try {
    const identity: ExecutorIdentityV02 = {
      adapterIdentity: commandExecutor.getAdapterIdentity(),
      processIncarnation: commandExecutor.getProcessIncarnation(),
      fencingGeneration: commandExecutor.getFencingGeneration(),
      payloadDigest: context.actionDigest,
    };
    assertCommandFence(manager, commandExecutor, lease, context.workspaceId, identity,
      options.adapterIdentity, options.processIncarnation, options.fencingGeneration);

    const activeView = manager.getActiveCommandView(context.workspaceId);
    const admittedView = context.commandView;
    if (!activeView || !admittedView || activeView.viewId !== admittedView.viewId ||
      activeView.viewDigest !== admittedView.viewDigest ||
      activeView.canonicalRevisionDigest !== admittedView.canonicalRevision ||
      activeView.taskId !== admittedView.taskId || activeView.workspaceId !== admittedView.workspaceId) {
      throw new Error('STALE_COMMAND_VIEW: Active command view does not match the admitted view');
    }

    const attempt = await beginRepositoryAttempt(
      statePort,
      context,
      identity,
      false,
      () => assertCommandFence(manager, commandExecutor, lease, context.workspaceId, identity,
        options.adapterIdentity, options.processIncarnation, options.fencingGeneration),
    );
    assertCommandFence(manager, commandExecutor, lease, context.workspaceId, identity,
      options.adapterIdentity, options.processIncarnation, options.fencingGeneration);
    return await commandExecutor.execute({
      workspaceId: context.workspaceId,
      action,
      limits: options.limits,
      view: dockerCommandView(context),
      attempt,
      context,
    });
  } finally {
    await lease.release();
  }
}

function assertCommandFence(
  manager: DockerWorkspaceManager,
  commandExecutor: StructuredCommandExecutor,
  lease: WorkspaceLease,
  workspaceId: string,
  identity: ExecutorIdentityV02,
  adapterIdentity: string,
  processIncarnation: string,
  receiverGeneration: number,
): void {
  const currentGeneration = manager.getFencingGeneration(workspaceId);
  if (lease.kind !== 'read' || lease.workspaceId !== workspaceId ||
    !Number.isSafeInteger(currentGeneration) || currentGeneration <= 0 ||
    lease.fencingGeneration !== currentGeneration || receiverGeneration !== currentGeneration ||
    commandExecutor.getFencingGeneration() !== currentGeneration ||
    identity.adapterIdentity !== adapterIdentity || identity.adapterIdentity !== commandExecutor.getAdapterIdentity() ||
    identity.processIncarnation !== processIncarnation || identity.processIncarnation !== commandExecutor.getProcessIncarnation() ||
    identity.fencingGeneration !== currentGeneration) {
    throw new Error('FENCED_EXECUTOR: Command receiver is stale at the invocation boundary');
  }
}

export function matchesAttemptIdentity(
  attempt: AttemptReceiptV02,
  expected: ExecutorIdentityV02,
): boolean {
  return matchesIdentity(attempt.executorIdentity, expected);
}

export function matchesIdentity(
  actual: ExecutorIdentityV02,
  expected: ExecutorIdentityV02,
): boolean {
  return actual.adapterIdentity === expected.adapterIdentity &&
    actual.processIncarnation === expected.processIncarnation &&
    actual.fencingGeneration === expected.fencingGeneration &&
    actual.payloadDigest === expected.payloadDigest;
}

function validateClaim(
  input: unknown,
  context: RepositoryAdmissionContextV02,
): ClaimReceiptV02 | null {
  if (!isPlainRecord(input) || Object.keys(input).length !== CLAIM_KEYS.length ||
    !CLAIM_KEYS.every((key) => Object.hasOwn(input, key))) return null;
  if (context.subjectKind !== 'repository-action' ||
    typeof input['claimId'] !== 'string' || !input['claimId'].trim() ||
    typeof input['claimDigest'] !== 'string' ||
    input['taskId'] !== context.taskId || input['runId'] !== context.runId ||
    input['subjectKind'] !== context.subjectKind || input['planApplicability'] !== context.planApplicability ||
    input['preClaimTaskStateVersion'] !== context.expectedTaskStateVersion ||
    input['preClaimControlVersion'] !== context.expectedControlVersion ||
    input['postClaimControlVersion'] !== context.expectedControlVersion + 1 ||
    input['epoch'] !== context.expectedEpoch || input['status'] !== 'claimed' ||
    !sameStrings(input['reservationRefs'], context.reservationRefs) ||
    input['claimDigest'] !== computeCanonicalSha256({ ...input, claimDigest: undefined })) return null;

  // The exact field and digest checks above establish the canonical receipt shape.
  return input as unknown as ClaimReceiptV02;
}

function matchesAttempt(
  attempt: AttemptReceiptV02,
  claim: ClaimReceiptV02,
  executorIdentity: ExecutorIdentityV02,
): boolean {
  return attempt.claimId === claim.claimId && attempt.taskId === claim.taskId &&
    attempt.epoch === claim.epoch && attempt.preAttemptTaskStateVersion === claim.preClaimTaskStateVersion &&
    attempt.preAttemptControlVersion === claim.postClaimControlVersion &&
    attempt.postBeginControlVersion === claim.postClaimControlVersion + 1 &&
    matchesIdentity(attempt.executorIdentity, executorIdentity);
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function sameStrings(input: unknown, expected: readonly string[]): boolean {
  return Array.isArray(input) && input.length === expected.length &&
    input.every((value, index) => value === expected[index]);
}

export class RepositoryCommandReceiver {
  private readonly options: ControlledRepositoryToolsOptions;
  private fencingGeneration: number;

  constructor(options: ControlledRepositoryToolsOptions) {
    this.options = options;
    this.fencingGeneration = options.fencingGeneration ?? options.commandExecutor?.getFencingGeneration?.() ?? 0;
  }

  setFencingGeneration(generation: number): void {
    this.fencingGeneration = generation;
    this.options.commandExecutor?.setFencingGeneration(generation);
  }

  async runCommand(
    action: RunCommandAction,
    context?: RepositoryAdmissionContextV02,
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    if (!context) throw new Error('NOT_IMPLEMENTED: runCommand without v0.2 context is not implemented in v0.1 compatibility slice');
    const admitted = bindCommandToAdmission(action, snapshotRepositoryAdmission(context, 'run_command'));
    if (this.options.neutralStub) throw new Error('NEUTRAL_RECEIVER_STUB: Positive execution not implemented in T049 neutral stub');
    const { workspaceManager, statePort, commandExecutor, trustedCommandResourcePolicy } = this.options;
    if (!workspaceManager) throw new Error('WORKSPACE_GATE_REQUIRED: A workspace manager is required for command execution');
    if (!statePort) throw new Error('STATE_PORT_REQUIRED: StatePortV02 is required for repository receiver execution');
    if (!commandExecutor) throw new Error('COMMAND_EXECUTOR_REQUIRED: StructuredCommandExecutor is required for runCommand');
    if (!trustedCommandResourcePolicy) throw new Error('COMMAND_RESOURCE_POLICY_REQUIRED: Trusted finite command limits are required');
    const adapterIdentity = this.options.adapterIdentity ?? commandExecutor.getAdapterIdentity?.() ?? '';
    const processIncarnation = this.options.processIncarnation ?? commandExecutor.getProcessIncarnation?.() ?? '';
    if (!adapterIdentity || !processIncarnation || !Number.isSafeInteger(this.fencingGeneration) || this.fencingGeneration <= 0) {
      throw new Error('EXECUTOR_IDENTITY_REQUIRED: Command execution requires a configured adapter incarnation and fencing generation');
    }
    const result = await executeAdmittedCommand({
      manager: workspaceManager,
      commandExecutor,
      statePort,
      context: admitted.context,
      action: admitted.action,
      limits: commandExecutionLimits(admitted.context, trustedCommandResourcePolicy),
      adapterIdentity,
      processIncarnation,
      fencingGeneration: this.fencingGeneration,
    });
    if (result.timedOut || result.outcome === 'timeout') throw new Error('COMMAND_TIMED_OUT: Command did not complete within its admitted timeout');
    if (result.exitCode === null || result.outcome === 'error') throw new Error('COMMAND_EXIT_CODE_UNAVAILABLE: Command did not return an observed exit code');
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async runTests(check: CheckDefinition, context?: RepositoryAdmissionContextV02): Promise<CheckResult> {
    if (!context) throw new Error('NOT_IMPLEMENTED: runTests without v0.2 context is not implemented in v0.1 compatibility slice');
    const admittedContext = snapshotRepositoryAdmission(context, 'run_command');
    const admittedCheck = bindCheckToAdmission(check, admittedContext);
    const admittedCommand = bindCommandToAdmission(admittedContext.action, admittedContext);
    if (this.options.neutralStub) throw new Error('NEUTRAL_RECEIVER_STUB: Positive execution not implemented in T049 neutral stub');
    const { workspaceManager, statePort, commandExecutor, trustedCommandResourcePolicy } = this.options;
    if (!workspaceManager) throw new Error('WORKSPACE_GATE_REQUIRED: A workspace manager is required for test execution');
    if (!statePort) throw new Error('STATE_PORT_REQUIRED: StatePortV02 is required for repository receiver execution');
    if (!commandExecutor) throw new Error('COMMAND_EXECUTOR_REQUIRED: StructuredCommandExecutor is required for runTests');
    if (!trustedCommandResourcePolicy) throw new Error('COMMAND_RESOURCE_POLICY_REQUIRED: Trusted finite command limits are required');
    const adapterIdentity = this.options.adapterIdentity ?? commandExecutor.getAdapterIdentity?.() ?? '';
    const processIncarnation = this.options.processIncarnation ?? commandExecutor.getProcessIncarnation?.() ?? '';
    if (!adapterIdentity || !processIncarnation || !Number.isSafeInteger(this.fencingGeneration) || this.fencingGeneration <= 0) {
      throw new Error('EXECUTOR_IDENTITY_REQUIRED: Test execution requires a configured adapter incarnation and fencing generation');
    }
    const result = await executeAdmittedCommand({
      manager: workspaceManager,
      commandExecutor,
      statePort,
      context: admittedContext,
      action: admittedCommand.action,
      limits: commandExecutionLimits(admittedContext, trustedCommandResourcePolicy),
      adapterIdentity,
      processIncarnation,
      fencingGeneration: this.fencingGeneration,
    });
    const outcome = result.timedOut || result.outcome === 'timeout'
      ? 'timeout'
      : result.exitCode === null || result.outcome === 'error'
        ? 'error'
        : result.outcome === 'success' && result.exitCode === 0
          ? 'pass'
          : 'fail';
    return {
      checkId: admittedCheck.checkId,
      outcome,
      outputExcerpt: result.stdout || result.stderr,
      durationMs: result.durationMs,
    };
  }
}
