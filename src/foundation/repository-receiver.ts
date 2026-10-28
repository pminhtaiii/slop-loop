import type { CheckDefinition, CheckResult } from '../contracts/foundation/uc03.ts';
import { isApprovedPlanPatchV02, validateAttemptReceiptV02 } from '../contracts/foundation/uc03/v02/attempt.ts';
import type {
  RepositoryCommandResultV02,
  RepositoryExecutionReceiptV02,
  AttemptReceiptV02,
  ClaimReceiptV02,
  ExecutorIdentityV02,
  ReconciliationResultV02,
  RepositoryAdmissionContextV02,
  StatePortV02,
} from '../contracts/foundation/uc03/v02/ports.ts';
import type { ControlledRepositoryToolsOptions, RepositoryAttemptStartRecoveryResultV02 } from './repository-types.ts';
import type { ExecutionLimits, RunCommandAction } from '../contracts/foundation/uc03/v01/types.ts';
import {
  dockerCommandView,
} from './repository-admission.ts';
import {
  assertCurrentCommandFenceV02,
  matchesRepositoryAttemptV02,
  matchesRepositoryIdentityV02,
  validateRepositoryClaimV02,
} from './repository-claim-lifecycle.ts';
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
import { ClaimClosurePendingError, RepositoryAttemptStartPendingError, RepositoryClaimLifecycleV02 } from './repository-claim-lifecycle.ts';
import {
  createCommandOutcomeReceipt,
  normalizeCommandResult,
  RepositoryOutcomeRecoveryV02,
} from './repository-command-outcome.ts';
import { RepositoryAttemptStartRecoveryV02 } from './repository-attempt-start-recovery.ts';

const noopCallback = (): void => undefined;

export class CommandOutcomePendingError extends Error {
  readonly attemptId: string;

  constructor(attemptId: string) {
    super(`COMMAND_OUTCOME_PENDING: Command attempt '${attemptId}' is held for UC-04 settlement or recovery`);
    this.name = 'CommandOutcomePendingError';
    this.attemptId = attemptId;
  }
}

export async function beginRepositoryAttempt(
  statePort: StatePortV02,
  context: RepositoryAdmissionContextV02,
  executorIdentity: ExecutorIdentityV02,
  _isRepairPatch: boolean,
  beforeBeginAttempt: () => void,
): Promise<AttemptReceiptV02> {
  return (await beginRepositoryAttemptWithClaim(
    statePort,
    context,
    executorIdentity,
    _isRepairPatch,
    beforeBeginAttempt,
  )).attempt;
}

/** Retain the legacy flag for existing callers; the admission defines progression. */
export async function beginRepositoryAttemptWithClaim(
  statePort: StatePortV02,
  context: RepositoryAdmissionContextV02,
  executorIdentity: ExecutorIdentityV02,
  _isRepairPatch: boolean,
  beforeBeginAttempt: () => void,
  onClaim: (claim: ClaimReceiptV02) => void = noopCallback,
  onBeginAttempt: () => void = noopCallback,
): Promise<{ readonly claim: ClaimReceiptV02; readonly attempt: AttemptReceiptV02 }> {
  const claimInput: unknown = await statePort.claim(context);
  const claim = validateRepositoryClaimV02(claimInput, context);
  if (!claim) throw new Error('CLAIM_DENIED: StatePort returned a mismatched repository claim');

  onClaim(claim);
  beforeBeginAttempt();
  onBeginAttempt();
  const attemptInput: unknown = await statePort.beginAttempt(claim.claimId, executorIdentity);
  const result = validateAttemptReceiptV02(attemptInput, {
    expectedTaskId: context.taskId,
    expectedClaimId: claim.claimId,
    isRepairPatch: isApprovedPlanPatchV02(context),
  });
  if (!result.ok || !matchesRepositoryAttemptV02(result.value, claim, executorIdentity)) {
    throw new Error('BEGIN_ATTEMPT_DENIED: StatePort returned a mismatched attempt receipt');
  }
  return { claim, attempt: attemptInput as AttemptReceiptV02 };
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
  readonly claimLifecycle: RepositoryClaimLifecycleV02;
  readonly outcomeRecovery: RepositoryOutcomeRecoveryV02;
  readonly attemptStartRecovery: RepositoryAttemptStartRecoveryV02;
}): Promise<StructuredExecutionResult & { readonly executionReceipt: RepositoryExecutionReceiptV02 }> {
  const { manager, commandExecutor, statePort, context, action } = options;
  const lease = await manager.acquireReadLease(context.workspaceId, context.canonicalRevision);
  let current: { readonly claim: ClaimReceiptV02; readonly attempt: AttemptReceiptV02 } | undefined;
  let claimed: ClaimReceiptV02 | undefined;
  let executorIdentity: ExecutorIdentityV02 | undefined;
  let attemptBeginStarted = false;
  let keepLease = false;
  try {
    const identity: ExecutorIdentityV02 = {
      adapterIdentity: commandExecutor.getAdapterIdentity(),
      processIncarnation: commandExecutor.getProcessIncarnation(),
      fencingGeneration: commandExecutor.getFencingGeneration(),
      payloadDigest: context.actionDigest,
    };
    executorIdentity = identity;
    assertCurrentCommandFenceV02(manager, commandExecutor, lease, context.workspaceId, identity,
      options.adapterIdentity, options.processIncarnation, options.fencingGeneration);

    const activeView = manager.getActiveCommandView(context.workspaceId);
    const admittedView = context.commandView;
    if (!activeView || !admittedView || activeView.viewId !== admittedView.viewId ||
      activeView.viewDigest !== admittedView.viewDigest ||
      activeView.canonicalRevisionDigest !== admittedView.canonicalRevision ||
      activeView.taskId !== admittedView.taskId || activeView.workspaceId !== admittedView.workspaceId) {
      throw new Error('STALE_COMMAND_VIEW: Active command view does not match the admitted view');
    }

    current = await beginRepositoryAttemptWithClaim(
      statePort,
      context,
      identity,
      false,
      () => assertCurrentCommandFenceV02(manager, commandExecutor, lease, context.workspaceId, identity,
        options.adapterIdentity, options.processIncarnation, options.fencingGeneration),
      (claim) => { claimed = claim; },
      () => { attemptBeginStarted = true; },
    );
    try {
      assertCurrentCommandFenceV02(manager, commandExecutor, lease, context.workspaceId, identity,
        options.adapterIdentity, options.processIncarnation, options.fencingGeneration);
      const result = await commandExecutor.execute({
        workspaceId: context.workspaceId,
        action,
        limits: options.limits,
        view: dockerCommandView(context),
        attempt: current.attempt,
        context,
      });
      const normalized = normalizeCommandResult(result);
      const outcome = createCommandOutcomeReceipt(
        current.claim,
        current.attempt,
        context,
        normalized ? 'observed' : 'uncertain',
        normalized ?? undefined,
      );
      const recorded = await options.outcomeRecovery.record(lease, context, current.claim, current.attempt, outcome);
      if (outcome.outcome === 'observed' && recorded.outcome === 'settled') return { ...result, executionReceipt: { claim: current.claim, attempt: current.attempt, outcome, settlement: recorded as typeof recorded & { readonly outcome: 'settled' } } };
      keepLease = true;
      throw new CommandOutcomePendingError(current.attempt.attemptId);
    } catch (error: unknown) {
      if (options.outcomeRecovery.hasPending(current.attempt.attemptId)) {
        keepLease = true;
        if (error instanceof CommandOutcomePendingError) throw error;
        throw new CommandOutcomePendingError(current.attempt.attemptId);
      }
      try {
        const uncertain = createCommandOutcomeReceipt(current.claim, current.attempt, context, 'uncertain');
        await options.outcomeRecovery.record(lease, context, current.claim, current.attempt, uncertain);
      } catch {
        // Keep the lease when execution or outcome recording may have committed without a trusted settlement.
      }
      keepLease = true;
      throw new CommandOutcomePendingError(current.attempt.attemptId);
    }
  } catch (error: unknown) {
    if (!current && claimed) {
      if (attemptBeginStarted) {
        keepLease = true;
        if (!executorIdentity) throw new Error('ATTEMPT_START_RECOVERY_IDENTITY_MISSING: Attempt start has no captured executor identity');
        const recoveryId = options.attemptStartRecovery.register(lease, context, claimed, executorIdentity, false);
        throw new RepositoryAttemptStartPendingError(claimed.claimId, recoveryId);
      }
      const closed = await options.claimLifecycle.closeUnattemptedClaim(lease, context, claimed, {
        adapterIdentity: commandExecutor.getAdapterIdentity(),
        processIncarnation: commandExecutor.getProcessIncarnation(),
        fencingGeneration: lease.fencingGeneration,
        payloadDigest: context.actionDigest,
      });
      if (!closed) {
        keepLease = true;
        throw new ClaimClosurePendingError(claimed.claimId);
      }
    }
    throw error;
  } finally {
    if (!keepLease && (!claimed || !options.claimLifecycle.hasPending(claimed.claimId)) &&
      (!current || !options.outcomeRecovery.hasPending(current.attempt.attemptId))) await lease.release();
  }
}

export function matchesAttemptIdentity(
  attempt: AttemptReceiptV02,
  expected: ExecutorIdentityV02,
): boolean {
  return matchesRepositoryIdentityV02(attempt.executorIdentity, expected);
}

export function matchesIdentity(
  actual: ExecutorIdentityV02,
  expected: ExecutorIdentityV02,
): boolean {
  return matchesRepositoryIdentityV02(actual, expected);
}

export class RepositoryCommandReceiver {
  private readonly options: ControlledRepositoryToolsOptions;
  private readonly claimLifecycle: RepositoryClaimLifecycleV02;
  private readonly outcomeRecovery: RepositoryOutcomeRecoveryV02;
  private readonly attemptStartRecovery: RepositoryAttemptStartRecoveryV02;
  private fencingGeneration: number;

  constructor(options: ControlledRepositoryToolsOptions) {
    this.options = options;
    this.claimLifecycle = new RepositoryClaimLifecycleV02(options.unattemptedClaimClosureHandoff);
    this.outcomeRecovery = new RepositoryOutcomeRecoveryV02(options);
    this.attemptStartRecovery = new RepositoryAttemptStartRecoveryV02({
      statePort: options.statePort,
      handoff: options.attemptStartRecoveryHandoff,
      outcomes: this.outcomeRecovery,
      createUncertainOutcome: (claim, attempt, context) => createCommandOutcomeReceipt(claim, attempt, context, 'uncertain'),
    });
    this.fencingGeneration = options.fencingGeneration ?? options.commandExecutor?.getFencingGeneration?.() ?? 0;
  }

  setFencingGeneration(generation: number): void {
    this.fencingGeneration = generation;
    this.options.commandExecutor?.setFencingGeneration(generation);
  }

  async runCommand(
    action: RunCommandAction,
    context?: RepositoryAdmissionContextV02,
  ): Promise<RepositoryCommandResultV02> {
    if (!context) throw new Error('NOT_IMPLEMENTED: runCommand without v0.2 context is not implemented in v0.1 compatibility slice');
    const admitted = bindCommandToAdmission(action, snapshotRepositoryAdmission(context, 'run_command'));
    if (this.options.neutralStub) throw new Error('NEUTRAL_RECEIVER_STUB: Positive execution not implemented in T049 neutral stub');
    const { workspaceManager, statePort, commandExecutor, trustedCommandResourcePolicy } = this.options;
    if (!workspaceManager) throw new Error('WORKSPACE_GATE_REQUIRED: A workspace manager is required for command execution');
    if (!statePort) throw new Error('STATE_PORT_REQUIRED: StatePortV02 is required for repository receiver execution');
    if (!commandExecutor) throw new Error('COMMAND_EXECUTOR_REQUIRED: StructuredCommandExecutor is required for runCommand');
    if (!trustedCommandResourcePolicy) throw new Error('COMMAND_RESOURCE_POLICY_REQUIRED: Trusted finite command limits are required');
    if (!this.options.patchRecoveryHandoff) throw new Error('COMMAND_RECOVERY_REQUIRED: A typed UC-04 recovery handoff is required before command admission');
    this.claimLifecycle.requireClosureCapability();
    this.attemptStartRecovery.requireCapability();
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
      claimLifecycle: this.claimLifecycle,
      outcomeRecovery: this.outcomeRecovery,
      attemptStartRecovery: this.attemptStartRecovery,
    });
    if (result.timedOut || result.outcome === 'timeout') throw new Error('COMMAND_TIMED_OUT: Command did not complete within its admitted timeout');
    if (result.exitCode === null || result.outcome === 'error') throw new Error('COMMAND_EXIT_CODE_UNAVAILABLE: Command did not return an observed exit code');
    return { ...result, exitCode: result.exitCode };
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
    if (!this.options.patchRecoveryHandoff) throw new Error('COMMAND_RECOVERY_REQUIRED: A typed UC-04 recovery handoff is required before command admission');
    this.claimLifecycle.requireClosureCapability();
    this.attemptStartRecovery.requireCapability();
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
      claimLifecycle: this.claimLifecycle,
      outcomeRecovery: this.outcomeRecovery,
      attemptStartRecovery: this.attemptStartRecovery,
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

  async recoverCommandOutcome(attemptId: string): Promise<ReconciliationResultV02> {
    if (!this.outcomeRecovery.hasPending(attemptId)) throw new Error('COMMAND_RECOVERY_NOT_FOUND: No locally held command outcome matches this attempt');
    return await this.outcomeRecovery.recover(attemptId);
  }

  recoverUnattemptedClaim(claimId: string): Promise<boolean> {
    return this.claimLifecycle.recoverUnattemptedClaim(claimId);
  }

  hasPendingAttemptStart(recoveryId: string): boolean { return this.attemptStartRecovery.hasPending(recoveryId); }

  recoverAttemptStart(recoveryId: string): Promise<RepositoryAttemptStartRecoveryResultV02> {
    return this.attemptStartRecovery.recover(recoveryId);
  }
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
