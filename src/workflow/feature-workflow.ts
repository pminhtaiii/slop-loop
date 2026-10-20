import type { TaskState, PlanStep, ProviderUsage, ApprovalRequestBinding } from '../state/types.ts';
import type { DurableStore } from '../state/durable-store.ts';
import { StepStateMachine } from '../state/step-machine.ts';
import { BudgetTracker } from '../state/budget-tracker.ts';
import { reconcileAndResume, type ReconcileOptions } from '../state/reconciliation.ts';
import { pauseForApproval, resumeFromApproval, type HumanDecision } from './human-pause.ts';

export interface StepExecutorResult {
  readonly changedFiles?: readonly string[] | undefined;
  readonly verificationRef?: string | undefined;
  readonly usage?: ProviderUsage | undefined;
  readonly requiresApproval?: ApprovalRequestBinding | undefined;
}

export type StepHandler = (step: PlanStep, state: TaskState) => Promise<StepExecutorResult>;

export class FeatureWorkflowEngine {
  readonly store: DurableStore;
  readonly stepMachine: StepStateMachine;

  constructor(store: DurableStore) {
    this.store = store;
    this.stepMachine = new StepStateMachine();
  }

  async initTask(initialState: TaskState): Promise<TaskState> {
    await this.store.saveTask(initialState);
    await this.store.saveCheckpoint(initialState);
    return initialState;
  }

  async executeWorkflow(
    taskId: string,
    stepHandler: StepHandler,
    options: ReconcileOptions = {}
  ): Promise<TaskState> {
    let state = await reconcileAndResume(taskId, this.store, options);
    const budgetTracker = new BudgetTracker(state.budgetLedgers);

    while (state.status === 'running' && state.currentStepIndex < state.plan.length) {
      const currentStep = state.plan[state.currentStepIndex];
      if (!currentStep) break;

      // If already done, skip (defense in depth)
      if (currentStep.status === 'done') {
        state = {
          ...state,
          currentStepIndex: state.currentStepIndex + 1,
          status: state.currentStepIndex + 1 >= state.plan.length ? 'completed' : 'running',
        };
        continue;
      }

      // 1. Start Step
      state = this.stepMachine.startStep(state, currentStep.id);
      await this.store.saveCheckpoint(state);

      // 2. Execute step logic
      let result: StepExecutorResult;
      try {
        result = await stepHandler(currentStep, state);
      } catch (err) {
        state = this.stepMachine.failStep(state, currentStep.id, (err as Error).message);
        await this.store.saveCheckpoint(state);
        return state;
      }

      // Check if step requires human approval
      if (result.requiresApproval) {
        state = await pauseForApproval(state, result.requiresApproval, this.store);
        return state; // yield execution to await human approval
      }

      // Settle budget usage if any
      if (result.usage) {
        budgetTracker.reserve(currentStep.id, [
          { scope: 'task', kind: 'tokens', amount: result.usage.billableTokens ?? (result.usage.inputTokens + result.usage.outputTokens) },
          { scope: 'task', kind: 'cost', amount: result.usage.costUsd },
        ]);
        budgetTracker.settle(currentStep.id, result.usage);
        state = {
          ...state,
          budgetLedgers: budgetTracker.getLedgers(),
        };
      }

      // 3. Complete Step
      state = this.stepMachine.completeStep(state, currentStep.id, {
        changedFiles: result.changedFiles,
        verificationRef: result.verificationRef,
      });
      await this.store.saveCheckpoint(state);
    }

    return state;
  }

  async resumeWithApproval(taskId: string, decision: HumanDecision, options = {}): Promise<TaskState> {
    return await resumeFromApproval(taskId, decision, this.store, options);
  }
}
