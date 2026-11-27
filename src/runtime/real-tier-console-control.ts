/** Real-tier console control helpers: reads current owner versions. */

import type { BugTask, TaskNode } from '../contracts/foundation/uc03.ts';
import type { ConsoleApprovalPort } from './console-server.ts';
import type { ExperimentControlVersions } from './evaluation-service-types.ts';
import type { RecordedDirection } from './real-tier-console-direction.ts';
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
