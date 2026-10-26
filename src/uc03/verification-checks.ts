import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  validateTaskState,
  validateVerificationResult,
} from '../contracts/foundation/uc03.ts';
import { validateRepositoryAdmissionV02 as validateRepositoryAdmissionRecordV02 } from '../contracts/foundation/uc03/admission-v02/repository.ts';
import type {
  BugTask,
  RepositoryAdmissionContextV02,
  RepositoryPort,
  RepositoryPortV02,
  StatePortV02,
  TaskState,
  VerificationResult,
} from '../contracts/foundation/uc03.ts';
import type { VerificationExecutionContext } from './verification-types.ts';

function computeGuardedTaskStateDigest(state: TaskState): string {
  const stateWithoutAccounting = { ...state };
  delete stateWithoutAccounting.budgetLedgers;
  return computeCanonicalSha256(stateWithoutAccounting);
}

export async function executeVerificationChecks(
  task: BugTask,
  repository: RepositoryPort | RepositoryPortV02,
  context: VerificationExecutionContext
): Promise<readonly VerificationResult[]> {
  if (!task || !Array.isArray(task.requiredChecks)) {
    throw new Error('INVALID_TASK: BugTask requiredChecks must be an array');
  }
  if (!repository || typeof repository.runTests !== 'function') {
    throw new Error('INVALID_REPOSITORY: RepositoryPort runTests must be a function');
  }
  if (!context || typeof context !== 'object' || !context.runId || !context.repoDigest) {
    throw new Error('INVALID_CONTEXT: VerificationExecutionContext requires runId and repoDigest');
  }

  const rawAdmission = context.admissionContext;
  const rawStatePort = context.statePort ?? (repository as { statePort?: unknown })?.statePort;
  const isV02 = Boolean(
    rawAdmission !== undefined ||
    context.executionGuard !== undefined ||
    (rawStatePort !== undefined && (repository as { executionGuardApiVersion?: string })?.executionGuardApiVersion === '0.2.0')
  );

  let admissionDenied = false;
  let admissionDenialRef = 'admission-denied';
  let admission: RepositoryAdmissionContextV02 | undefined;
  let initialGuardStateDigest: string | undefined;

  if (isV02) {
    if (!rawAdmission || typeof rawAdmission !== 'object') {
      admissionDenied = true;
      admissionDenialRef = 'missing-admission-context';
    } else {
      const valAdmission = validateRepositoryAdmissionRecordV02(rawAdmission as RepositoryAdmissionContextV02);
      if (!valAdmission.ok) {
        admissionDenied = true;
        admissionDenialRef = 'invalid-admission-context';
      } else {
        admission = valAdmission.value;
      }
    }

    if (!admissionDenied && admission) {
      const checkSetDigest = computeCheckSetDigest(task.requiredChecks);
      const criteriaDigest = computeCanonicalSha256(task.acceptanceCriteria);
      if (
        admission.planApplicability !== 'approved-plan' ||
        admission.runnableNode !== 'Verify' ||
        !admission.planDecisionRef ||
        !admission.planBindingDigest ||
        admission.taskId !== task.taskId ||
        admission.runId !== context.runId ||
        admission.canonicalRevision !== context.repoDigest ||
        (admission.checkSetDigest && admission.checkSetDigest !== checkSetDigest) ||
        (admission.taskCriteriaDigest && admission.taskCriteriaDigest !== criteriaDigest)
      ) {
        admissionDenied = true;
        admissionDenialRef = 'admission-context-mismatch';
      }
    }

    if (!admissionDenied && (!context.executionGuard || typeof context.executionGuard.validateAndExecute !== 'function')) {
      admissionDenied = true;
      admissionDenialRef = 'execution-guard-unavailable';
    }

    if (!admissionDenied && rawStatePort && typeof rawStatePort === 'object') {
      const journal = rawStatePort as Record<string, unknown>;
      if (typeof journal.getJournalSnapshot === 'function') {
        const snap = (journal.getJournalSnapshot as () => { mode?: string; activeClaimId?: string | null })() as {
          mode?: string;
          activeClaimId?: string | null;
        };
        if (snap?.mode && snap.mode !== 'runnable') {
          admissionDenied = true;
          admissionDenialRef = 'task-paused';
        }
        if (snap?.activeClaimId !== null && snap?.activeClaimId !== undefined) {
          admissionDenied = true;
          admissionDenialRef = 'active-claim';
        }
      }
      if (!admissionDenied && typeof journal.loadTask === 'function') {
        try {
          const loaded = await (journal.loadTask as (id: string) => Promise<TaskState | null>)(task.taskId);
          if (!loaded || !validateTaskState(loaded).ok) {
            admissionDenied = true;
            admissionDenialRef = 'authoritative-state-unavailable';
          } else if ((loaded as { mode?: string }).mode && (loaded as { mode?: string }).mode !== 'runnable') {
            admissionDenied = true;
            admissionDenialRef = 'task-paused';
          } else if (loaded.repositoryRevisionDigest !== context.repoDigest) {
            admissionDenied = true;
            admissionDenialRef = 'authoritative-revision-drift';
          } else {
            initialGuardStateDigest = computeGuardedTaskStateDigest(loaded);
          }
        } catch {
          admissionDenied = true;
          admissionDenialRef = 'authoritative-state-unavailable';
        }
      } else if (!admissionDenied) {
        admissionDenied = true;
        admissionDenialRef = 'authoritative-state-unavailable';
      }
    } else if (!admissionDenied) {
      admissionDenied = true;
      admissionDenialRef = 'state-port-unavailable';
    }

    if (admissionDenied) {
      return Object.freeze(task.requiredChecks.map((check) => {
        const phase = check.purpose === 'reproduction' ? 'focused' : check.purpose;
        const prefix = context.actionIdPrefix ?? 'action-verify';
        const actionId = `${prefix}-${check.checkId}`;
        const evidenceId = `evidence-verif-${check.checkId}-${computeCanonicalSha256([
          context.runId,
          check.checkId,
          context.repoDigest,
          context.diffDigest ?? '',
        ])}`;
        return {
          evidenceId,
          taskId: task.taskId,
          runId: context.runId,
          actionId,
          phase,
          repoDigest: context.repoDigest,
          ...(context.diffDigest !== undefined ? { diffDigest: context.diffDigest } : {}),
          commandIdentity: `${check.executable} ${check.argv.join(' ')}`,
          outcome: 'error' as const,
          testedIds: [check.checkId],
          diagnosticRefs: [admissionDenialRef],
        };
      }));
    }
  }

  const results: VerificationResult[] = [];

  for (const check of task.requiredChecks) {
    const phase =
      check.purpose === 'reproduction' ? 'focused' : check.purpose;
    const prefix = context.actionIdPrefix ?? 'action-verify';
    const actionId = `${prefix}-${check.checkId}`;
    const evidenceId = `evidence-verif-${check.checkId}-${computeCanonicalSha256([
      context.runId,
      check.checkId,
      context.repoDigest,
      context.diffDigest ?? '',
    ])}`;

    let outcome: VerificationResult['outcome'] = 'error';
    let diagnosticRefs: string[] = [];

    try {
      let checkResult: unknown;
      if (isV02 && admission) {
        const checkCtx: RepositoryAdmissionContextV02 = check.checkId === admission.checkId
          ? admission
          : {
              ...admission,
              checkId: check.checkId,
              action: {
                actionId: `${prefix}-${check.checkId}`,
                kind: 'run_command',
                executable: check.executable,
                argv: [...check.argv],
                workingDirectory: check.workingDirectory ?? 'tests',
                purpose: check.purpose,
              },
              actionDigest: computeCanonicalSha256({
                actionId: `${prefix}-${check.checkId}`,
                kind: 'run_command',
                executable: check.executable,
                argv: [...check.argv],
                workingDirectory: check.workingDirectory ?? 'tests',
                purpose: check.purpose,
              }),
            };
        const expectedAction = {
          actionId: `${prefix}-${check.checkId}`,
          kind: 'run_command' as const,
          executable: check.executable,
          argv: [...check.argv],
          workingDirectory: check.workingDirectory ?? 'tests',
          purpose: check.purpose,
        };
        if (computeCanonicalSha256(checkCtx.action) !== computeCanonicalSha256(expectedAction)) {
          outcome = 'error';
          diagnosticRefs = ['admission-action-mismatch'];
        } else if (!context.executionGuard || !rawStatePort || typeof rawStatePort !== 'object') {
          outcome = 'error';
          diagnosticRefs = ['guard-or-state-port-unavailable'];
        } else {
          const statePort = rawStatePort as StatePortV02;
          const currentState = await statePort.loadTask(task.taskId);
          if (!currentState || !validateTaskState(currentState).ok) {
            outcome = 'error';
            diagnosticRefs = ['authoritative-state-unavailable'];
          } else {
            const guardResult = await context.executionGuard.validateAndExecute(checkCtx.action, currentState, checkCtx);
            diagnosticRefs = [`execution-guard:${guardResult.outcome}`];
            if (guardResult.outcome === 'success' && guardResult.result && typeof guardResult.result === 'object') {
              const commandResult = guardResult.result as Record<string, unknown>;
              if (Number.isSafeInteger(commandResult.exitCode) && typeof commandResult.stdout === 'string' &&
                typeof commandResult.stderr === 'string') {
                outcome = commandResult.exitCode === 0 ? 'pass' : 'fail';
              } else {
                outcome = 'error';
                diagnosticRefs.push('invalid-observed-command-result');
              }
            } else {
              outcome = 'error';
            }
          }
        }
      } else {
        checkResult = await (repository as RepositoryPort).runTests(check);
        if (
          checkResult &&
          typeof checkResult === 'object' &&
          'checkId' in checkResult &&
          checkResult.checkId === check.checkId &&
          'outcome' in checkResult &&
          typeof checkResult.outcome === 'string' &&
          ['pass', 'fail', 'timeout', 'error', 'not-run'].includes(checkResult.outcome)
        ) {
          outcome = checkResult.outcome as VerificationResult['outcome'];
        } else {
          outcome = 'error';
        }
      }
    } catch {
      outcome = 'error';
    }

    const verificationResult: VerificationResult = {
      evidenceId,
      taskId: task.taskId,
      runId: context.runId,
      actionId,
      phase,
      repoDigest: context.repoDigest,
      ...(context.diffDigest !== undefined
        ? { diffDigest: context.diffDigest }
        : {}),
      commandIdentity: `${check.executable} ${check.argv.join(' ')}`,
      outcome,
      testedIds: [check.checkId],
      diagnosticRefs,
    };

    const validRes = validateVerificationResult(verificationResult);
    if (!validRes.ok) {
      throw new Error(
        `INVALID_VERIFICATION_RESULT: ${validRes.errors.map((e) => e.message).join('; ')}`
      );
    }

    results.push(validRes.value);
  }

  let finalResults = results;
  if (isV02) {
    try {
      const currentState = await (rawStatePort as StatePortV02).loadTask(task.taskId);
      if (!currentState || !initialGuardStateDigest ||
        computeGuardedTaskStateDigest(currentState) !== initialGuardStateDigest) {
        finalResults = results.map((result) => ({
          ...result,
          outcome: 'error' as const,
          diagnosticRefs: [...result.diagnosticRefs, 'authoritative-state-drift'],
        }));
      }
    } catch {
      finalResults = results.map((result) => ({
        ...result,
        outcome: 'error' as const,
        diagnosticRefs: [...result.diagnosticRefs, 'authoritative-state-unavailable'],
      }));
    }
  }
  return Object.freeze(finalResults);
}

/**
 * Builds the trusted completion context required for StatePort transition to Deliver.
 */
