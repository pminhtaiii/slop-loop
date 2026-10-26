import { computeCanonicalSha256, validateTaskState } from '../contracts/foundation/uc03.ts';
import { validateRepositoryAdmissionV02 as validateRepositoryAdmissionRecordV02 } from '../contracts/foundation/uc03/admission-v02/repository.ts';
import type {
  CheckDefinition,
  CheckResult,
  ExecutionGuardV02,
  RepositoryAdmissionContextV02,
  RepositoryPort,
  RepositoryPortV02,
  StatePortV02,
  TaskState,
} from '../contracts/foundation/uc03.ts';

function computeGuardedTaskStateDigest(state: TaskState): string {
  const stateWithoutAccounting = { ...state };
  delete stateWithoutAccounting.budgetLedgers;
  return computeCanonicalSha256(stateWithoutAccounting);
}

export type BaselineCheckRunResult =
  | { readonly status: 'checks'; readonly checkResults: CheckResult[] }
  | { readonly status: 'error'; readonly reason: string };

export async function runBaselineChecks(input: {
  readonly rawExpectedContext: unknown;
  readonly repository: RepositoryPort | RepositoryPortV02;
  readonly expectedTaskId: string;
  readonly expectedRevisionDigest: string;
  readonly criteriaDigest: string;
  readonly checkSetDigest: string;
  readonly requiredChecks: readonly CheckDefinition[];
}): Promise<BaselineCheckRunResult> {
  const {
    rawExpectedContext,
    repository,
    expectedTaskId,
    expectedRevisionDigest,
    criteriaDigest,
    checkSetDigest,
    requiredChecks,
  } = input;
  // Check if v0.2 guarded atomic admission is active
  const contextAdmission = (rawExpectedContext as Record<string, unknown> | undefined)?.admissionContext;
  const rawStatePort = (rawExpectedContext as Record<string, unknown> | undefined)?.statePort ??
    (repository as { statePort?: unknown })?.statePort;
  const rawExecutionGuard = (rawExpectedContext as Record<string, unknown> | undefined)?.executionGuard;
  const executionGuard = rawExecutionGuard && typeof rawExecutionGuard === 'object' &&
    typeof (rawExecutionGuard as { validateAndExecute?: unknown }).validateAndExecute === 'function'
    ? rawExecutionGuard as ExecutionGuardV02
    : undefined;
  const isV02 = Boolean(
    contextAdmission !== undefined ||
    rawExecutionGuard !== undefined ||
    (rawStatePort !== undefined && (repository as { executionGuardApiVersion?: string })?.executionGuardApiVersion === '0.2.0')
  );

  let admission: RepositoryAdmissionContextV02 | undefined;
  let initialGuardStateDigest: string | undefined;
  if (isV02) {
    if (!contextAdmission || typeof contextAdmission !== 'object') {
      return {
        status: 'error',
        reason: 'ADMISSION_DENIED: Missing or malformed admission context',
      };
    }
    const valAdmission = validateRepositoryAdmissionRecordV02(contextAdmission as RepositoryAdmissionContextV02);
    if (!valAdmission.ok) {
      return {
        status: 'error',
        reason: `ADMISSION_DENIED: ${valAdmission.errors.map((e) => e.message).join('; ')}`,
      };
    }
    admission = valAdmission.value;

    if (
      admission.planApplicability !== 'pre-plan-diagnostic' ||
      admission.runnableNode !== 'Investigate' ||
      admission.planDecisionRef !== undefined ||
      admission.planBindingDigest !== undefined ||
      admission.taskCriteriaDigest !== criteriaDigest ||
      admission.checkSetDigest !== checkSetDigest ||
      admission.taskId !== expectedTaskId ||
      admission.canonicalRevision !== expectedRevisionDigest
    ) {
      return {
        status: 'error',
        reason: 'ADMISSION_DENIED: Baseline pre-plan diagnostic admission mismatch',
      };
    }

    if (!executionGuard) {
      return { status: 'error', reason: 'ADMISSION_DENIED: ExecutionGuardV02 is required for v0.2 checks' };
    }
    if (!rawStatePort || typeof rawStatePort !== 'object') {
      return { status: 'error', reason: 'STATE_UNAVAILABLE: StatePortV02 is required for guarded checks' };
    }

    const journal = rawStatePort as Record<string, unknown>;
    if (typeof journal.getJournalSnapshot === 'function') {
      const snap = (journal.getJournalSnapshot as () => { mode?: string; activeClaimId?: string | null })() as {
        mode?: string;
        activeClaimId?: string | null;
      };
      if (snap?.mode && snap.mode !== 'runnable') {
        return {
          status: 'error',
          reason: 'TASK_PAUSED: Task is paused',
        };
      }
      if (snap?.activeClaimId !== null && snap?.activeClaimId !== undefined) {
        return {
          status: 'error',
          reason: 'CLAIM_ACTIVE: Task has an active open claim',
        };
      }
    }

    if (typeof journal.loadTask !== 'function') {
      return { status: 'error', reason: 'STATE_UNAVAILABLE: StatePortV02.loadTask is required for guarded checks' };
    }
    try {
      const loaded = await (journal.loadTask as (id: string) => Promise<TaskState | null>)(expectedTaskId);
      if (!loaded || !validateTaskState(loaded).ok) {
        return { status: 'error', reason: 'STATE_UNAVAILABLE: Authoritative task state unavailable or invalid' };
      }
      if (loaded.repositoryRevisionDigest !== expectedRevisionDigest) {
        return { status: 'error', reason: 'REVISION_DRIFT: Authoritative repository revision has drifted' };
      }
      initialGuardStateDigest = computeGuardedTaskStateDigest(loaded);
    } catch {
      return { status: 'error', reason: 'STATE_UNAVAILABLE: Authoritative task state unavailable' };
    }
  }

  // Run every explicitly required check once, even when one result fails or throws.
  const checkResults: CheckResult[] = [];
  for (const check of requiredChecks) {
    try {
      let rawResult: unknown;
      if (isV02 && admission) {
        const checkCtx: RepositoryAdmissionContextV02 = check.checkId === admission.checkId
          ? admission
          : {
              ...admission,
              checkId: check.checkId,
              action: {
                actionId: check.checkId,
                kind: 'run_command',
                executable: check.executable,
                argv: [...check.argv],
                workingDirectory: check.workingDirectory ?? 'tests',
                purpose: check.purpose,
              },
              actionDigest: computeCanonicalSha256({
                actionId: check.checkId,
                kind: 'run_command',
                executable: check.executable,
                argv: [...check.argv],
                workingDirectory: check.workingDirectory ?? 'tests',
                purpose: check.purpose,
              }),
            };
        const expectedAction = {
          actionId: check.checkId,
          kind: 'run_command' as const,
          executable: check.executable,
          argv: [...check.argv],
          workingDirectory: check.workingDirectory ?? 'tests',
          purpose: check.purpose,
        };
        if (computeCanonicalSha256(checkCtx.action) !== computeCanonicalSha256(expectedAction)) {
          rawResult = {
            checkId: check.checkId,
            outcome: 'error',
            outputExcerpt: 'ADMISSION_DENIED: Baseline admission action does not match the required check',
          };
        } else if (!executionGuard || !rawStatePort || typeof rawStatePort !== 'object') {
          rawResult = {
            checkId: check.checkId,
            outcome: 'error',
            outputExcerpt: 'ADMISSION_DENIED: Guarded baseline requires ExecutionGuardV02 and StatePortV02',
          };
        } else {
          const statePort = rawStatePort as StatePortV02;
          const currentState = await statePort.loadTask(expectedTaskId);
          if (!currentState || !validateTaskState(currentState).ok) {
            rawResult = {
              checkId: check.checkId,
              outcome: 'error',
              outputExcerpt: 'STATE_UNAVAILABLE: Authoritative task state unavailable or invalid',
            };
          } else {
            const guardResult = await executionGuard.validateAndExecute(checkCtx.action, currentState, checkCtx);
            if (guardResult.outcome !== 'success') {
              rawResult = {
                checkId: check.checkId,
                outcome: 'error',
                outputExcerpt: `ExecutionGuardV02 ${guardResult.outcome}: ${(guardResult.reason ?? '').slice(0, 512)}`,
              };
            } else if (!guardResult.result || typeof guardResult.result !== 'object') {
              rawResult = {
                checkId: check.checkId,
                outcome: 'error',
                outputExcerpt: 'ExecutionGuardV02 success omitted the observed command result',
              };
            } else {
              const commandResult = guardResult.result as Record<string, unknown>;
              const exitCode = commandResult.exitCode;
              const stdout = commandResult.stdout;
              const stderr = commandResult.stderr;
              if (!Number.isSafeInteger(exitCode) || typeof stdout !== 'string' || typeof stderr !== 'string') {
                rawResult = {
                  checkId: check.checkId,
                  outcome: 'error',
                  outputExcerpt: 'ExecutionGuardV02 success returned an invalid command result',
                };
              } else {
                rawResult = {
                  checkId: check.checkId,
                  outcome: exitCode === 0 ? 'pass' : 'fail',
                  outputExcerpt: stdout || stderr,
                  ...(typeof commandResult.durationMs === 'number' && Number.isFinite(commandResult.durationMs)
                    ? { durationMs: commandResult.durationMs }
                    : {}),
                };
              }
            }
          }
        }
      } else {
        rawResult = await (repository as RepositoryPort).runTests(check);
      }
      if (!rawResult || typeof rawResult !== 'object') {
        checkResults.push({
          checkId: check.checkId,
          outcome: 'error',
          outputExcerpt: 'Required check returned an invalid result',
        });
        continue;
      }

      const result = rawResult as Record<string, unknown>;
      const resultCheckId = result.checkId;
      const resultOutcome = result.outcome;
      const resultOutput = result.outputExcerpt;
      const resultDuration = result.durationMs;
      if (
        resultCheckId !== check.checkId ||
        !['pass', 'fail', 'timeout', 'error', 'not-run'].includes(resultOutcome as string)
      ) {
        checkResults.push({
          checkId: check.checkId,
          outcome: 'error',
          outputExcerpt: 'Required check returned a mismatched identity or invalid outcome',
        });
        continue;
      }

      checkResults.push({
        checkId: check.checkId,
        outcome: resultOutcome as CheckResult['outcome'],
        ...(typeof resultOutput === 'string' ? { outputExcerpt: resultOutput } : {}),
        ...(typeof resultDuration === 'number' && Number.isFinite(resultDuration)
          ? { durationMs: resultDuration }
          : {}),
      });
    } catch (err: unknown) {
      checkResults.push({
        checkId: check.checkId,
        outcome: 'error',
        outputExcerpt: `Required check execution threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (isV02) {
    try {
      const currentState = await (rawStatePort as StatePortV02).loadTask(expectedTaskId);
      if (!currentState || !initialGuardStateDigest ||
        computeGuardedTaskStateDigest(currentState) !== initialGuardStateDigest) {
        return {
          status: 'error',
          reason: 'REVISION_DRIFT: Authoritative task state changed during investigation',
        };
      }
    } catch {
      return {
        status: 'error',
        reason: 'STATE_UNAVAILABLE: Authoritative task state unavailable after investigation',
      };
    }
  }

  return { status: 'checks', checkResults };
}
