import { describe, expect, it } from "vitest";

import {
  DEFAULT_TASK_BUDGET,
  checkTaskDeadline,
  consumeAgentStep,
  consumeRetry,
  validateTaskBudget,
} from "../../src/orchestration/budget.js";
import { admitTask, createTask } from "../../src/orchestration/task.js";
import { advanceTask } from "../../src/orchestration/transitions.js";

describe("task budgets", () => {
  it("freezes a trusted, finite budget at admission", () => {
    expect(DEFAULT_TASK_BUDGET).toEqual({
      maxAgentSteps: 30,
      maxRetries: 3,
      maxTaskSeconds: 900,
    });
    expect(() =>
      validateTaskBudget({ maxAgentSteps: 0, maxRetries: 3, maxTaskSeconds: 900 }),
    ).toThrow();
    expect(() =>
      validateTaskBudget({ maxAgentSteps: 30, maxRetries: -1, maxTaskSeconds: 900 }),
    ).toThrow();
    expect(() =>
      validateTaskBudget({
        maxAgentSteps: Number.POSITIVE_INFINITY,
        maxRetries: 3,
        maxTaskSeconds: 900,
      }),
    ).toThrow();

    const admitted = admitTask(
      createTask({ taskId: "bounded", objective: "Fix the build", mode: "Edit" }),
      0,
      { maxAgentSteps: 2, maxRetries: 1, maxTaskSeconds: 10 },
    );
    expect(admitted.budget).toEqual({
      maxAgentSteps: 2,
      maxRetries: 1,
      maxTaskSeconds: 10,
    });
    expect(Object.isFrozen(admitted.budget)).toBe(true);
  });

  it("allows the last step and rejects the next before execution", () => {
    const budget = validateTaskBudget({
      maxAgentSteps: 30,
      maxRetries: 3,
      maxTaskSeconds: 900,
    });
    const last = consumeAgentStep(budget, { agentSteps: 29, retries: 0 });
    expect(last).toEqual({
      allowed: true,
      usage: { agentSteps: 30, retries: 0 },
    });

    const exhausted = consumeAgentStep(budget, { agentSteps: 30, retries: 0 });
    expect(exhausted).toEqual({
      allowed: false,
      evidence: { resource: "AGENT_STEPS", limit: 30, observed: 30, attempted: 31 },
    });
  });

  it("permits three explicit retries and refuses a fourth", () => {
    const third = consumeRetry(DEFAULT_TASK_BUDGET, { agentSteps: 12, retries: 2 });
    expect(third).toEqual({ allowed: true, usage: { agentSteps: 12, retries: 3 } });
    expect(consumeRetry(DEFAULT_TASK_BUDGET, { agentSteps: 12, retries: 3 })).toEqual({
      allowed: false,
      evidence: { resource: "RETRIES", limit: 3, observed: 3, attempted: 4 },
    });
  });

  it("expires at 900 seconds even while waiting for permission", () => {
    const admitted = admitTask(
      createTask({ taskId: "waiting", objective: "Fix the build", mode: "Edit" }),
      1_000,
    );
    const waiting = advanceTask(
      advanceTask(advanceTask(admitted, "INSPECTING"), "PLANNING"),
      "WAITING_FOR_FILE_PERMISSION",
    );
    expect(waiting.state).toBe("WAITING_FOR_FILE_PERMISSION");
    expect(checkTaskDeadline(DEFAULT_TASK_BUDGET, 1_000, 900_999)).toBeNull();
    expect(checkTaskDeadline(DEFAULT_TASK_BUDGET, 1_000, 901_000)).toEqual({
      resource: "TASK_TIME",
      limit: 900,
      observed: 900,
      attempted: 900,
    });
  });
});
