import type { TaskState, PlanStep } from './types.ts';
import { validateTaskState } from '../contracts/uc04.ts';

export interface StepCompletionOptions {
  readonly changedFiles?: readonly string[] | undefined;
  readonly verificationRef?: string | undefined;
}

export class StepStateMachine {
  startStep(state: TaskState, stepId: string): TaskState {
    const stepIdx = state.plan.findIndex((s) => s.id === stepId);
    if (stepIdx === -1) {
      throw new Error(`Step not found in plan: ${stepId}`);
    }

    if (stepIdx !== state.currentStepIndex) {
      const expectedStep = state.plan[state.currentStepIndex]?.id ?? 'none';
      throw new Error(`Cannot start step ${stepId}; expected ${expectedStep}`);
    }

    const currentStep = state.plan[stepIdx];
    if (!currentStep) {
      throw new Error(`Step ${stepId} is missing`);
    }

    if (currentStep.status === 'done') {
      throw new Error(`Cannot start step ${stepId} with status done`);
    }

    const updatedStep: PlanStep = {
      id: currentStep.id,
      title: currentStep.title,
      description: currentStep.description,
      status: 'doing',
      startedAt: new Date().toISOString(),
      ...(currentStep.changedFiles ? { changedFiles: currentStep.changedFiles } : {}),
      ...(currentStep.verificationRef ? { verificationRef: currentStep.verificationRef } : {}),
    };

    const newPlan = [...state.plan];
    newPlan[stepIdx] = updatedStep;

    const nextState: TaskState = {
      ...state,
      plan: newPlan,
      status: 'running',
      stateVersion: state.stateVersion + 1,
    };

    const val = validateTaskState(nextState);
    if (!val.ok) throw new Error(`Invalid transition: ${val.errors.map((e) => e.message).join(', ')}`);
    return val.value;
  }

  completeStep(state: TaskState, stepId: string, options: StepCompletionOptions = {}): TaskState {
    const stepIdx = state.plan.findIndex((s) => s.id === stepId);
    if (stepIdx === -1) {
      throw new Error(`Step not found in plan: ${stepId}`);
    }

    const currentStep = state.plan[stepIdx];
    if (!currentStep) {
      throw new Error(`Step ${stepId} is missing`);
    }

    if (currentStep.status !== 'doing') {
      throw new Error(`Cannot complete step ${stepId} with status ${currentStep.status}`);
    }

    const updatedStep: PlanStep = {
      id: currentStep.id,
      title: currentStep.title,
      description: currentStep.description,
      status: 'done',
      completedAt: new Date().toISOString(),
      ...(currentStep.startedAt ? { startedAt: currentStep.startedAt } : {}),
      ...(options.changedFiles ? { changedFiles: options.changedFiles } : {}),
      ...(options.verificationRef ? { verificationRef: options.verificationRef } : {}),
    };

    const newPlan = [...state.plan];
    newPlan[stepIdx] = updatedStep;

    const allChangedFiles = Array.from(
      new Set([...state.changedFiles, ...(options.changedFiles ?? [])])
    );

    const isAllDone = newPlan.every((s) => s.status === 'done');
    const nextStepIndex = isAllDone ? stepIdx : stepIdx + 1;

    const nextState: TaskState = {
      ...state,
      plan: newPlan,
      changedFiles: allChangedFiles,
      currentStepIndex: nextStepIndex,
      status: isAllDone ? 'completed' : 'running',
      stateVersion: state.stateVersion + 1,
    };

    const val = validateTaskState(nextState);
    if (!val.ok) throw new Error(`Invalid transition: ${val.errors.map((e) => e.message).join(', ')}`);
    return val.value;
  }

  failStep(state: TaskState, stepId: string, errorMessage: string): TaskState {
    const stepIdx = state.plan.findIndex((s) => s.id === stepId);
    if (stepIdx === -1) {
      throw new Error(`Step not found in plan: ${stepId}`);
    }

    const currentStep = state.plan[stepIdx];
    if (!currentStep) {
      throw new Error(`Step ${stepId} is missing`);
    }

    const updatedStep: PlanStep = {
      id: currentStep.id,
      title: currentStep.title,
      description: currentStep.description,
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: errorMessage,
      ...(currentStep.startedAt ? { startedAt: currentStep.startedAt } : {}),
      ...(currentStep.changedFiles ? { changedFiles: currentStep.changedFiles } : {}),
    };

    const newPlan = [...state.plan];
    newPlan[stepIdx] = updatedStep;

    const nextState: TaskState = {
      ...state,
      plan: newPlan,
      status: 'failed',
      stateVersion: state.stateVersion + 1,
      openRisks: [...(state.openRisks ?? []), `Step ${stepId} failed: ${errorMessage}`],
    };

    const val = validateTaskState(nextState);
    if (!val.ok) throw new Error(`Invalid transition: ${val.errors.map((e) => e.message).join(', ')}`);
    return val.value;
  }
}
