/**
 * T061 — the owner-held execution profile a bound real-tier task's port admits views against.
 *
 * It is derived only from the pinned task and the owner-known workspace ids: the workspace's own
 * scratch volume, the view builder's default exclusions version and the task's limits. The limits are
 * read once, when the profile is pinned at bind time, so a caller mutating the returned task
 * afterwards cannot move the ceiling the owner later enforces (STD-W5-104).
 */
import type { BugTask } from '../contracts/foundation/uc03.ts';
import { computeWorkspaceVolumeIds } from '../foundation/docker-workspace-policy.ts';
import { DEFAULT_EXCLUSIONS_POLICY_VERSION } from '../foundation/docker-view-builder.ts';
import { ADMISSION_PROFILE_FACTS } from '../persistence/adapters/state-port-v02-admission.ts';
import type { ExecutionProfileV02 } from '../persistence/adapters/state-port-v02-admission.ts';
import type { SeededTaskIds } from './real-tier-task-seed.ts';

/** Every profile value except the scratch identity, which depends on the ids the port reads. */
export type PinnedExecutionProfileV02 = Omit<ExecutionProfileV02, 'scratchIdentity'>;

/** A `BugTask` pins no patch ceiling, so the port's own constants stand in. */
const TASK_PATCH_BOUNDS = ADMISSION_PROFILE_FACTS.patchBounds;

/** The task's limits, detached and frozen now: later mutation of the task cannot reach them. */
export function pinnedExecutionProfileOf(task: BugTask, isolationProfileRef: string): PinnedExecutionProfileV02 {
  const limits = { ...task.limits };
  return Object.freeze({
    isolationProfileRef,
    exclusionsPolicyVersion: DEFAULT_EXCLUSIONS_POLICY_VERSION,
    commandBounds: Object.freeze({
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
      maxCpuSeconds: Math.max(1, Math.ceil((limits.maxCpuCores * limits.timeoutMs) / 1000)),
      maxMemoryBytes: limits.maxMemoryBytes,
      maxProcessCount: limits.maxPids,
    }),
    patchBounds: TASK_PATCH_BOUNDS,
  });
}

/** The pinned profile bound to one task/workspace: its scratch volume is that workspace's own. */
export function boundExecutionProfileOf(pinned: PinnedExecutionProfileV02, ids: Pick<SeededTaskIds, 'taskId' | 'workspaceId'>): ExecutionProfileV02 {
  return { ...pinned, scratchIdentity: computeWorkspaceVolumeIds(ids.taskId, ids.workspaceId).scratchVolumeId };
}

/** The profile for a task pinned now, for the fixtures that hand a bound port an admission. */
export function executionProfileOf(task: BugTask, isolationProfileRef: string, ids: Pick<SeededTaskIds, 'taskId' | 'workspaceId'>): ExecutionProfileV02 {
  return boundExecutionProfileOf(pinnedExecutionProfileOf(task, isolationProfileRef), ids);
}
