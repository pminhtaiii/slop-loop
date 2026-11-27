/** Real-tier console control helpers: reads current owner versions and validates direction requests. */

import type { BugTask, TaskNode, TaskState } from '../contracts/foundation/uc03.ts';
import type { ConsoleApprovalPort } from './console-server.ts';
import type { ExperimentControlVersions, ServiceControlReceipt } from './evaluation-service-types.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';

const DIRECTION_NODES: ReadonlySet<TaskNode> = new Set(['NeedsInfo', 'AwaitPlan', 'Verify', 'AwaitFeedback']);

export const INVALID_CONTROL_RECEIPT: ServiceControlReceipt = Object.freeze({ receiptRef: '', kind: 'resume', taskId: '', controlVersion: -1 });

export interface RecordedRealDirection {
  readonly receipt: ServiceControlReceipt;
  readonly taskVersion: number;
}

export interface RealConsoleSession {
  readonly task: BugTask;
  readonly statePort: RealTierAssembly['components']['statePort'];
  readonly approvalService: ReturnType<RealTierAssembly['owners']['taskOwners']>['approvalService'];
  readonly approvalConsole: ConsoleApprovalPort;
  readonly directionsByRef: Map<string, RecordedRealDirection>;
  directionsIssued: number;
  lastControlVersion: number;
  terminal: boolean;
  cleanupCopy: () => void;
}

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
  if (node === 'NeedsInfo' || node === 'AwaitPlan' || node === 'Verify') return kind === 'resume';
  if (node === 'AwaitFeedback') return (kind === 'revise' || kind === 'end') && (decRef === undefined || decRef === planDecRef);
  return false;
}

/** Reads required task and control versions directly from owner state when a direction can be issued. */
export async function readRealConsoleControlVersions(session: RealConsoleSession | undefined): Promise<ExperimentControlVersions | null> {
  if (!session) return null;
  const [ownerState, listed] = await Promise.all([session.statePort.loadTask(session.task.taskId), session.approvalService.list(session.task.taskId)]);
  if (!ownerState || listed.control.mode === 'waiting' || !DIRECTION_NODES.has(ownerState.node)) return null;
  return Object.freeze({
    taskVersion: ownerState.stateVersion,
    controlVersion: Math.max(listed.control.version, session.lastControlVersion),
  });
}
