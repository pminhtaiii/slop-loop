/** Real-tier console control and approval port helpers. */

import type { BugTask, TaskNode } from '../contracts/foundation/uc03.ts';
import type { ConsoleApprovalPort } from './console-server.ts';
import type { ExperimentControlVersions, ServiceControl, ServiceControlReceipt } from './evaluation-service-types.ts';
import { hasPendingEndDirection, INVALID_RECEIPT, validRealConsoleDirection, type RecordedDirection } from './real-tier-console-direction.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';

const DIRECTION_NODES: ReadonlySet<TaskNode> = new Set(['NeedsInfo', 'AwaitPlan', 'Verify', 'AwaitFeedback']);

export interface RealConsoleSession {
  readonly task: BugTask;
  readonly statePort: RealTierAssembly['components']['statePort'];
  readonly approvalService: ReturnType<RealTierAssembly['owners']['taskOwners']>['approvalService'];
  readonly approvalConsole: ConsoleApprovalPort;
  readonly directionsByRef: Map<string, RecordedDirection>;
  directionsIssued: number;
  lastControlVersion: number;
  terminal: boolean;
  cleanupCopy: () => void;
}

/** Reads required task and control versions directly from owner state when a direction can be issued. */
export async function readRealConsoleControlVersions(session: RealConsoleSession | undefined): Promise<ExperimentControlVersions | null> {
  if (!session || session.terminal) return null;
  const [ownerState, listed] = await Promise.all([session.statePort.loadTask(session.task.taskId), session.approvalService.list(session.task.taskId)]);
  if (!ownerState || listed.control.mode === 'waiting' || !DIRECTION_NODES.has(ownerState.node)) return null;
  return Object.freeze({
    taskVersion: ownerState.stateVersion,
    controlVersion: Math.max(listed.control.version, session.lastControlVersion),
  });
}

/** Builds the shared `ServiceControl` port backed by owner session state. */
export function createRealConsoleControl(sessions: ReadonlyMap<string, RealConsoleSession>, allowRevise: boolean): ServiceControl {
  let directionSeq = 0;
  return {
    versions: experimentId => readRealConsoleControlVersions(sessions.get(experimentId)),
    async issue(input) {
      if (input.kind === 'revise' && !allowRevise) return INVALID_RECEIPT;
      const session = sessions.get(input.experimentId);
      if (!session || session.terminal) return INVALID_RECEIPT;
      const [ownerState, listed] = await Promise.all([session.statePort.loadTask(session.task.taskId), session.approvalService.list(session.task.taskId)]);
      if (!ownerState) return INVALID_RECEIPT;
      if (input.kind === 'end' && hasPendingEndDirection(session, ownerState.stateVersion)) return INVALID_RECEIPT;

      const expectedCtrl = Math.max(listed.control.version, session.lastControlVersion);
      if (
        !validRealConsoleDirection(
          input.kind,
          ownerState.node,
          listed.control.mode,
          expectedCtrl,
          input.expectedControlVersion,
          input.expectedTaskVersion,
          ownerState.stateVersion,
          session.directionsIssued,
          ownerState.plan?.decisionRef,
          input.decisionRef,
        )
      ) {
        return INVALID_RECEIPT;
      }

      const nextVer = expectedCtrl + 1;
      const receipt: ServiceControlReceipt = Object.freeze({
        receiptRef: `real-dir-${session.task.taskId}-${++directionSeq}`,
        kind: input.kind,
        taskId: session.task.taskId,
        controlVersion: nextVer,
      });
      session.directionsIssued += 1;
      session.lastControlVersion = nextVer;
      session.directionsByRef.set(receipt.receiptRef, { receipt, taskVersion: ownerState.stateVersion });
      return receipt;
    },
  };
}

/** Builds the shared `ConsoleApprovalPort` routing approval presentation and decisions to active sessions. */
export function createRealConsoleApproval(sessions: ReadonlyMap<string, RealConsoleSession>): ConsoleApprovalPort {
  return {
    presentation(experimentId) {
      const session = sessions.get(experimentId);
      return session ? session.approvalConsole.presentation(experimentId) : { ok: false, status: 'not-found', reasonCode: 'UNKNOWN_EXPERIMENT' };
    },
    decide(input) {
      const expId = typeof input === 'object' && input !== null ? (input as Readonly<Record<string, unknown>>)['experimentId'] : undefined;
      if (typeof expId !== 'string') return { ok: false, status: 'invalid-input', reasonCode: 'INVALID_DECISION_REQUEST' };
      const session = sessions.get(expId);
      return session ? session.approvalConsole.decide(input) : { ok: false, status: 'not-found', reasonCode: 'UNKNOWN_EXPERIMENT' };
    },
  };
}
