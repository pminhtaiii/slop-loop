import { z } from "zod";

export interface TaskBudget {
  readonly maxAgentSteps: number;
  readonly maxRetries: number;
  readonly maxTaskSeconds: number;
}

export interface TaskUsage {
  readonly agentSteps: number;
  readonly retries: number;
}

export interface BudgetExhaustion {
  readonly resource: "AGENT_STEPS" | "RETRIES" | "TASK_TIME";
  readonly limit: number;
  readonly observed: number;
  readonly attempted: number;
}

export type BudgetDecision =
  | { readonly allowed: true; readonly usage: Readonly<TaskUsage> }
  | { readonly allowed: false; readonly evidence: Readonly<BudgetExhaustion> };

const budgetSchema = z.strictObject({
  maxAgentSteps: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  maxTaskSeconds: z.number().int().positive(),
});

export const DEFAULT_TASK_BUDGET: Readonly<TaskBudget> = Object.freeze({
  maxAgentSteps: 30,
  maxRetries: 3,
  maxTaskSeconds: 900,
});

export function validateTaskBudget(value: unknown): Readonly<TaskBudget> {
  return Object.freeze(budgetSchema.parse(value));
}

export function consumeAgentStep(budget: TaskBudget, usage: TaskUsage): BudgetDecision {
  const attempted = usage.agentSteps + 1;
  if (attempted > budget.maxAgentSteps) {
    return {
      allowed: false,
      evidence: Object.freeze({
        resource: "AGENT_STEPS",
        limit: budget.maxAgentSteps,
        observed: usage.agentSteps,
        attempted,
      }),
    };
  }
  return {
    allowed: true,
    usage: Object.freeze({ agentSteps: attempted, retries: usage.retries }),
  };
}

export function consumeRetry(budget: TaskBudget, usage: TaskUsage): BudgetDecision {
  const attempted = usage.retries + 1;
  if (attempted > budget.maxRetries) {
    return {
      allowed: false,
      evidence: Object.freeze({
        resource: "RETRIES",
        limit: budget.maxRetries,
        observed: usage.retries,
        attempted,
      }),
    };
  }
  return {
    allowed: true,
    usage: Object.freeze({ agentSteps: usage.agentSteps, retries: attempted }),
  };
}

export function checkTaskDeadline(
  budget: TaskBudget,
  admittedAt: number,
  now: number,
): Readonly<BudgetExhaustion> | null {
  if (!Number.isFinite(now) || now < admittedAt) {
    throw new Error("Task clock moved backwards or is invalid");
  }
  const elapsedSeconds = (now - admittedAt) / 1_000;
  if (elapsedSeconds < budget.maxTaskSeconds) return null;
  return Object.freeze({
    resource: "TASK_TIME",
    limit: budget.maxTaskSeconds,
    observed: elapsedSeconds,
    attempted: elapsedSeconds,
  });
}
