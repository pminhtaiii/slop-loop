import type {
  ApplyPatchAction,
  BugTask,
  CheckDefinition,
  CheckResult,
  RepositoryExecutionReceiptV02,
  RepositoryCommandResultV02,
  RepositoryPatchResultV02,
  RepositoryPort,
  RepositoryPortV02,
  RepositoryAdmissionContextV02,
  TaskState,
  RunCommandAction,
} from '../../../../src/contracts/foundation/uc03.ts';
import { validateAttemptOutcomeReceiptV02 } from '../../../../src/contracts/foundation/uc03.ts';
import { beginRepositoryAttemptWithClaim } from '../../../../src/foundation/repository-receiver.ts';
import { createFixtureExecutorIdentityV02, createFixtureTaskState } from './port-fixtures.ts';
import type { FakeRepositoryPort } from './fake-repository.ts';
import { createTestRepositoryOutcomeReceiptV02 } from './state-fixtures.ts';
import type { MemoryStatePortV02 } from './memory-state.ts';
import { createTestAdmissionLedgers } from './state-fixtures.ts';

function createRouteLedgers(configId: string, task: BugTask) {
  const resources = [
    ['timeoutMs', 30_000, 'ms'],
    ['maxOutputBytes', 65_536, 'bytes'],
    ['maxCpuSeconds', 10, 'seconds'],
    ['maxMemoryBytes', 536_870_912, 'bytes'],
    ['maxProcessCount', 5, 'count'],
  ] as const;
  return [
    ...createTestAdmissionLedgers(configId).map((ledger) => ledger.scope === 'task' && ledger.kind === 'repair'
      ? { ...ledger, limit: task.budgetLimits.maxRepairAttempts }
      : ledger),
    ...(['task', 'run'] as const).flatMap((scope) => resources.map(([kind, limit, unit]) => ({
      scope,
      kind,
      limit: limit * 10,
      consumed: 0,
      reservations: [],
      unit,
      configurationId: configId,
      version: 1,
    }))),
  ];
}

export function createGraphTaskState(
  task: BugTask,
  overrides: Partial<TaskState> = {},
): TaskState {
  return createFixtureTaskState({
    taskId: task.taskId,
    runId: 'run-graph-001',
    workspaceId: 'workspace-graph-001',
    repositoryId: task.repositoryId,
    repositoryRevisionDigest: task.initialRevisionDigest,
    goal: task.goal,
    observedBehavior: task.observedBehavior,
    expectedBehavior: task.expectedBehavior,
    reproduction: task.reproduction,
    acceptanceCriteria: task.acceptanceCriteria,
    constraints: task.constraints,
    requiredCheckIds: task.requiredChecks.map((check) => check.checkId),
    taskContext: task,
    evidenceRefs: [],
    budgetLedgers: createRouteLedgers(task.configId, task),
    ...overrides,
  });
}

export async function seedGraphTaskState(
  statePort: MemoryStatePortV02,
  state: TaskState,
): Promise<void> {
  await statePort.getUnderlying().transition(state, 0);
}

/** Routes mock patches through the same owner receipt protocol as approved-plan transitions. */
export function createGraphRepositoryPort(
  repository: FakeRepositoryPort,
  statePort: MemoryStatePortV02,
  onPatchFailure?: (reason: string) => void,
): RepositoryPort & RepositoryPortV02 & { readonly executionGuardApiVersion: '0.2.0' } {
  return new GraphRepositoryPort(repository, statePort, onPatchFailure);
}

class GraphRepositoryPort implements RepositoryPort, RepositoryPortV02 {
  readonly provenance = 'mock' as const;
  readonly executionGuardApiVersion = '0.2.0' as const;
  private readonly repository: FakeRepositoryPort;
  private readonly statePort: MemoryStatePortV02;
  private readonly onPatchFailure: ((reason: string) => void) | undefined;

  constructor(
    repository: FakeRepositoryPort,
    statePort: MemoryStatePortV02,
    onPatchFailure?: (reason: string) => void,
  ) {
    this.repository = repository;
    this.statePort = statePort;
    this.onPatchFailure = onPatchFailure;
  }

  listDir(directory: string) { return this.repository.listDir(directory); }
  readFile(filePath: string) { return this.repository.readFile(filePath); }
  searchCode(query: string) { return this.repository.searchCode(query); }
  inspectDiff(revision: string) { return this.repository.inspectDiff(revision); }

  runCommand(action: RunCommandAction): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  runCommand(action: RunCommandAction, context: RepositoryAdmissionContextV02): Promise<RepositoryCommandResultV02>;
  runCommand(action: RunCommandAction, context?: RepositoryAdmissionContextV02) {
    return context ? this.repository.runCommand(action, context) : this.repository.runCommand(action);
  }

  runTests(check: CheckDefinition, context?: RepositoryAdmissionContextV02): Promise<CheckResult> {
    return context ? this.repository.runTests(check, context) : this.repository.runTests(check);
  }

  applyPatch(action: ApplyPatchAction): Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }>;
  applyPatch(action: ApplyPatchAction, context: RepositoryAdmissionContextV02): Promise<RepositoryPatchResultV02>;
  async applyPatch(action: ApplyPatchAction, context?: RepositoryAdmissionContextV02) {
    if (!context) return this.repository.applyPatch(action);
    try {
      const executor = createFixtureExecutorIdentityV02({ payloadDigest: context.actionDigest });
      const { claim, attempt } = await beginRepositoryAttemptWithClaim(this.statePort, context, executor, true, () => undefined);
      const effect = await this.repository.applyPatch(action);
      if (!effect.applied) throw new Error('Mock patch was refused at the receiver boundary');
      const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, context, {
        receiptId: `repository-outcome-${attempt.attemptId}`,
        observedResultRevisionDigest: effect.newRevisionDigest,
        proposedEffects: {
          taskTransition: { kind: 'transition', fromNode: 'Patch', toNode: 'Verify' },
          revision: { kind: 'advance', revisionDigest: effect.newRevisionDigest },
          invalidatedEvidence: [],
          accounting: { disposition: 'settle', reservationRefs: [...claim.reservationRefs] },
        },
      });
      const settlement = await this.statePort.recordOutcome(outcome);
      if (!isSettledOutcome(settlement)) {
        const current = await this.statePort.loadTask(context.taskId);
        const journal = this.statePort.getJournalSnapshot();
        const validation = current && validateAttemptOutcomeReceiptV02(outcome, {
          trustedAdmission: context,
          trustedClaim: claim,
          trustedAttempt: attempt,
          currentClaimStatus: 'attempting',
          currentTaskStateVersion: current.stateVersion,
          currentControlVersion: journal.controlVersion,
          currentEpoch: journal.epoch,
        });
        const errors = validation && !validation.ok ? validation.errors.map((item) => item.message).join('; ') : '';
        throw new Error(`Owner did not settle the mock patch outcome (${settlement.outcome}:${settlement.receiptId})${errors ? `: ${errors}` : ''}`);
      }
      if (settlement.receiptId !== outcome.receiptId) throw new Error('Owner settled a different mock patch outcome receipt');
      const executionReceipt: RepositoryExecutionReceiptV02 = { claim, attempt, outcome, settlement };
      return { ...effect, executionReceipt };
    } catch (error: unknown) {
      this.onPatchFailure?.(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

function isSettledOutcome(
  result: Awaited<ReturnType<MemoryStatePortV02['recordOutcome']>>,
): result is typeof result & { readonly outcome: 'settled' } {
  return result.outcome === 'settled';
}
