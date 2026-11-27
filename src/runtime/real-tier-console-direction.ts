/** Control direction gating and resolution helpers for the real-tier evaluation console. */
import type { BugTask, TaskState } from '../contracts/foundation/uc03.ts';
import type { TrustedReplanDirection } from '../uc03/repair-types.ts';
import type { ClarificationEndReceipt, ClarificationResumeReceipt, EvaluationDirectionResolutionInput, ClarificationResumeResolutionInput } from './evaluation-graph.ts';
import type { ServiceControlReceipt } from './evaluation-service-types.ts';

export interface RecordedDirection {
  readonly receipt: ServiceControlReceipt;
  readonly taskVersion: number;
}

export interface RealConsoleDirectionSession {
  readonly task: BugTask;
  readonly directionsByRef: Map<string, RecordedDirection>;
  terminal: boolean;
  readonly cleanupCopy: () => void;
}

export const INVALID_RECEIPT: ServiceControlReceipt = Object.freeze({ receiptRef: '', kind: 'resume', taskId: '', controlVersion: -1 });

export function validRealConsoleDirection(
  kind: 'resume' | 'revise' | 'end',
  node: TaskState['node'],
  approvalMode: string,
  expectedCtrl: number,
  expCtrlVer: number,
  expTaskVer: number,
  stateVer: number,
  issued: number,
  planDecRef: string | undefined,
  decRef: string | undefined,
): boolean {
  if (approvalMode === 'waiting') return false;
  const initNeeds = node === 'NeedsInfo' && issued === 0;
  const ctrlOk = initNeeds ? expCtrlVer === expectedCtrl || expCtrlVer === 0 : expCtrlVer === expectedCtrl;
  const taskOk = expTaskVer === stateVer || expTaskVer === expectedCtrl || (initNeeds && expTaskVer === 0);
  if (!ctrlOk || !taskOk) return false;
  if (node === 'NeedsInfo') return kind === 'resume' || kind === 'end';
  if (node === 'AwaitPlan' || node === 'Verify') return kind === 'resume';
  if (node === 'AwaitFeedback') return (kind === 'revise' || kind === 'end') && (decRef === undefined || decRef === planDecRef);
  return false;
}

export function hasPendingEndDirection(session: RealConsoleDirectionSession, taskVersion: number): boolean {
  for (const recorded of session.directionsByRef.values()) {
    if (recorded.receipt.kind === 'end' && recorded.taskVersion === taskVersion) return true;
  }
  return false;
}

export function resolveRealConsoleDirection(
  sessions: ReadonlyMap<string, RealConsoleDirectionSession>,
  allowRevise: boolean,
  input: EvaluationDirectionResolutionInput,
): TrustedReplanDirection | undefined {
  const { experimentId, currentState, direction } = input;
  if (direction === null) return undefined;
  const session = sessions.get(experimentId);
  if (!session || session.terminal) return undefined;
  const recorded = session.directionsByRef.get(direction.receiptRef);
  if (!recorded || recorded.receipt.controlVersion !== direction.controlVersion || recorded.taskVersion !== currentState.stateVersion) return undefined;
  if (currentState.node !== 'AwaitFeedback' || !currentState.plan?.decisionRef || (recorded.receipt.kind !== 'end' && (!allowRevise || recorded.receipt.kind !== 'revise'))) {
    return undefined;
  }
  return {
    directive: recorded.receipt.kind === 'end' ? 'terminate' : 'revise',
    taskId: currentState.taskId,
    workspaceId: currentState.workspaceId,
    repositoryRevisionDigest: currentState.repositoryRevisionDigest,
    stateVersion: currentState.stateVersion,
    planVersion: currentState.planVersion,
    rejectedDecisionId: currentState.plan.decisionRef,
    strategyDigest: currentState.plan.strategyDigest,
  };
}

export function resolveRealConsoleClarificationResume(sessions: ReadonlyMap<string, RealConsoleDirectionSession>, input: ClarificationResumeResolutionInput): ClarificationResumeReceipt | undefined {
  const { experimentId, currentState, direction, answer, expectedAnswerDigest } = input;
  if (!direction || currentState.node !== 'NeedsInfo') return undefined;
  const session = sessions.get(experimentId);
  if (!session || session.terminal) return undefined;
  const recorded = session.directionsByRef.get(direction.receiptRef);
  if (!recorded || recorded.receipt.kind !== 'resume' || recorded.receipt.controlVersion !== direction.controlVersion || recorded.taskVersion !== currentState.stateVersion) {
    return undefined;
  }
  return {
    receiptRef: direction.receiptRef,
    controlVersion: direction.controlVersion,
    taskId: currentState.taskId,
    runId: currentState.runId,
    workspaceId: currentState.workspaceId,
    stateVersion: currentState.stateVersion,
    questionId: answer.questionId,
    questionDigest: answer.questionDigest,
    answerDigest: expectedAnswerDigest,
  };
}

/** Validates an operator `end` receipt at `NeedsInfo` and retires the session copy before returning. */
export function resolveRealConsoleClarificationEnd(sessions: ReadonlyMap<string, RealConsoleDirectionSession>, input: EvaluationDirectionResolutionInput): ClarificationEndReceipt | undefined {
  const { experimentId, currentState, direction } = input;
  if (!direction || direction.kind !== 'end' || currentState.node !== 'NeedsInfo') return undefined;
  const session = sessions.get(experimentId);
  if (!session || session.terminal) return undefined;
  const recorded = session.directionsByRef.get(direction.receiptRef);
  if (!recorded || recorded.receipt.kind !== 'end' || recorded.receipt.controlVersion !== direction.controlVersion || recorded.taskVersion !== currentState.stateVersion) {
    return undefined;
  }
  session.terminal = true;
  session.cleanupCopy();
  return {
    receiptRef: direction.receiptRef,
    controlVersion: direction.controlVersion,
    taskId: currentState.taskId,
    runId: currentState.runId,
    workspaceId: currentState.workspaceId,
    stateVersion: currentState.stateVersion,
  };
}
