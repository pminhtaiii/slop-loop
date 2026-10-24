import type { TaskState, CompactSummary } from './contracts.ts';
import type { DurableStore } from './store.ts';
import { validateCompactSummary } from './contracts.ts';

export function compactContext(task: TaskState): CompactSummary {
  const completedSteps = task.plan
    .filter((s) => s.status === 'done')
    .map((s) => `${s.title}: ${s.description} (files: ${s.changedFiles?.join(', ') || 'none'})`);

  const activeStep = task.plan[task.currentStepIndex];
  const activeTitle = activeStep ? activeStep.title : 'None';
  const currentState = activeStep
    ? `Status: ${task.status}, CurrentStep: [${task.currentStepIndex}] ${activeStep.id} (${activeTitle})`
    : `Status: ${task.status}, CurrentStep: None`;
  const nextAction = task.nextAction || (activeStep ? `Proceed with step ${activeTitle}` : 'Awaiting next action');

  const summary: CompactSummary = {
    taskId: task.taskId,
    sourceStateVersion: task.stateVersion,
    goal: task.goal,
    constraints: [...task.constraints],
    completedWork: completedSteps,
    currentState,
    openRisks: [...task.openRisks],
    nextAction,
  };

  const val = validateCompactSummary(summary);
  if (!val.ok) {
    throw new Error(`Failed to validate generated compact summary: ${val.errors.map((e) => e.message).join(', ')}`);
  }

  return summary;
}

export function formatCompactSummaryMarkdown(summary: CompactSummary): string {
  return [
    '# Compacted Task Context',
    `## Goal\n${summary.goal}`,
    `## Constraints\n${summary.constraints.map((c) => `- ${c}`).join('\n') || '- None'}`,
    `## Completed Work\n${summary.completedWork.map((w) => `- ${w}`).join('\n') || '- No steps completed yet'}`,
    `## Current State\n- ${summary.currentState}`,
    `## Open Risks\n${summary.openRisks.map((r) => `- ${r}`).join('\n') || '- None recorded'}`,
    `## Next Action\n${summary.nextAction}`,
  ].join('\n\n');
}

export interface TaskStatusReport {
  readonly taskId: string;
  readonly status: string;
  readonly stateVersion: number;
  readonly goal: string;
  readonly completedStepCount: number;
  readonly totalStepCount: number;
  readonly isDeliberatelyPaused: boolean;
  readonly nextAction: string;
  readonly openRisks: readonly string[];
}

export async function inspectTaskStatus(store: DurableStore, taskId: string): Promise<TaskStatusReport | null> {
  const task = await store.loadTask(taskId);
  if (!task) return null;

  const pauseRecord = await store.loadPauseRecord(taskId);
  const completedCount = task.plan.filter((s) => s.status === 'done').length;

  return {
    taskId: task.taskId,
    status: task.status,
    stateVersion: task.stateVersion,
    goal: task.goal,
    completedStepCount: completedCount,
    totalStepCount: task.plan.length,
    isDeliberatelyPaused: pauseRecord?.active ?? false,
    nextAction: task.nextAction,
    openRisks: [...task.openRisks],
  };
}
