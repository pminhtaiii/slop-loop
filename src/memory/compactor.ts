import type { TaskState } from '../state/types.ts';

export interface CompactedSummary {
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly completedWork: readonly string[];
  readonly currentState: {
    readonly status: string;
    readonly activeStepIndex: number;
    readonly activeStepTitle: string;
  };
  readonly openRisks: readonly string[];
  readonly nextAction: string;
  toMarkdown(): string;
}

export function compactContext(task: TaskState): CompactedSummary {
  const completedSteps = task.plan
    .filter((s) => s.status === 'done')
    .map((s) => `${s.title}: ${s.description} (files: ${s.changedFiles?.join(', ') || 'none'})`);

  const activeStep = task.plan[task.currentStepIndex];
  const activeTitle = activeStep ? activeStep.title : 'None';

  const goal = task.goal;
  const constraints = task.constraints;
  const openRisks = task.openRisks ?? [];
  const nextAction = task.nextAction ?? `Proceed with step ${activeTitle}`;

  const currentState = {
    status: task.status,
    activeStepIndex: task.currentStepIndex,
    activeStepTitle: activeTitle,
  };

  return {
    goal,
    constraints,
    completedWork: completedSteps,
    currentState,
    openRisks,
    nextAction,
    toMarkdown(): string {
      return [
        '# Compacted Task Context',
        `## Goal\n${goal}`,
        `## Constraints\n${constraints.map((c) => `- ${c}`).join('\n') || '- None'}`,
        `## Completed Work\n${completedSteps.map((w) => `- ${w}`).join('\n') || '- No steps completed yet'}`,
        `## Current State\n- Status: ${currentState.status}\n- Active Step: [${currentState.activeStepIndex}] ${currentState.activeStepTitle}`,
        `## Open Risks\n${openRisks.map((r) => `- ${r}`).join('\n') || '- None recorded'}`,
        `## Next Action\n${nextAction}`,
      ].join('\n\n');
    },
  };
}
