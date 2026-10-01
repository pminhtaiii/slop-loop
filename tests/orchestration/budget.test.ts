import { describe, expect, it } from "vitest";

import {
  EMPTY_TASK_USAGE,
  consumeModelTurn,
  consumeRetry,
  consumeToolAttempt,
  createTaskBudget,
  recordActiveWork,
} from "../../src/orchestration/budget.js";
import { createTask } from "../../src/orchestration/task.js";
import { admitTask } from "../support/admission.js";

describe("task budgets", () => {
  it("admits a sealed fixed Small profile with separate work capacities", () => {
    const admitted = admitTask(
      createTask({ taskId: "small", objective: "Inspect the repository", mode: "Ask" }),
      0,
      "Small",
    );
    expect(admitted.state).toBe("ADMITTED");
    expect(admitted.budget).toMatchObject({
      initialProfile: "Small",
      activeProfile: "Small",
      maxModelTurns: 30,
      maxToolAttempts: 60,
      maxRetries: 3,
      maxActiveWorkSeconds: 1_800,
    });
    expect(admitted.usage).toMatchObject({ modelTurns: 0, toolAttempts: 0, retries: 0 });
    expect(Object.isFrozen(admitted.budget?.promotionSchedule)).toBe(true);
  });

  it("defaults to Medium and rejects model-supplied numeric limits", () => {
    const received = createTask({
      taskId: "default",
      objective: "Inspect the repository",
      mode: "Ask",
    });
    expect(admitTask(received, 0).budget).toMatchObject({
      initialProfile: "Medium",
      maxModelTurns: 60,
      maxToolAttempts: 120,
      maxRetries: 5,
    });
    expect(admitTask(received, 0, { maxModelTurns: 10_000 }).outcome?.reason).toBe(
      "INTERNAL_ERROR",
    );
    expect(() => createTaskBudget("Unlimited")).toThrow();
  });

  it("promotes only when the next model turn exceeds capacity, without resetting usage", () => {
    let budget = createTaskBudget("Small");
    let usage = EMPTY_TASK_USAGE;
    for (let turn = 1; turn <= 120; turn += 1) {
      const decision = consumeModelTurn(budget, usage);
      expect(decision.allowed).toBe(true);
      if (!decision.allowed) throw new Error("Expected capacity through turn 120");
      budget = decision.budget;
      usage = decision.usage;
      if (turn === 30) expect(budget.activeProfile).toBe("Small");
      if (turn === 31) expect(budget.activeProfile).toBe("Medium");
      if (turn === 61) expect(budget.activeProfile).toBe("Large");
    }
    expect(usage.modelTurns).toBe(120);
    expect(usage.toolAttempts).toBe(0);
    expect(consumeModelTurn(budget, usage)).toEqual({
      allowed: false,
      evidence: { resource: "MODEL_TURNS", limit: 120, observed: 120, attempted: 121 },
    });
  });

  it("counts dispatched tool attempts separately and caps Large at 240", () => {
    let budget = createTaskBudget("Small");
    let usage = EMPTY_TASK_USAGE;
    for (let attempt = 1; attempt <= 240; attempt += 1) {
      const decision = consumeToolAttempt(budget, usage);
      expect(decision.allowed).toBe(true);
      if (!decision.allowed) throw new Error("Expected capacity through attempt 240");
      budget = decision.budget;
      usage = decision.usage;
      if (attempt === 60) expect(budget.activeProfile).toBe("Small");
      if (attempt === 61) expect(budget.activeProfile).toBe("Medium");
      if (attempt === 121) expect(budget.activeProfile).toBe("Large");
    }
    expect(usage.modelTurns).toBe(0);
    expect(consumeToolAttempt(budget, usage)).toEqual({
      allowed: false,
      evidence: { resource: "TOOL_ATTEMPTS", limit: 240, observed: 240, attempted: 241 },
    });
  });

  it("shares the initial retry ceiling after a capacity promotion", () => {
    let budget = createTaskBudget("Small");
    let usage = EMPTY_TASK_USAGE;
    for (let turn = 0; turn < 31; turn += 1) {
      const decision = consumeModelTurn(budget, usage);
      if (!decision.allowed) throw new Error("Expected promotion");
      budget = decision.budget;
      usage = decision.usage;
    }
    expect(budget.activeProfile).toBe("Medium");
    expect(budget.maxRetries).toBe(3);
    for (const reason of ["MODEL_RECOVERY", "DENIAL_RECOVERY", "VERIFICATION_REPAIR"] as const) {
      const decision = consumeRetry(budget, usage, reason);
      if (!decision.allowed) throw new Error("Expected a remaining retry");
      usage = decision.usage;
    }
    expect(usage.retryReasons).toEqual([
      "MODEL_RECOVERY",
      "DENIAL_RECOVERY",
      "VERIFICATION_REPAIR",
    ]);
    expect(consumeRetry(budget, usage, "DENIAL_RECOVERY")).toEqual({
      allowed: false,
      evidence: { resource: "RETRIES", limit: 3, observed: 3, attempted: 4 },
    });
  });

  it("expires at 30 minutes of active work without promoting", () => {
    const budget = createTaskBudget("Small");
    const before = recordActiveWork(budget, EMPTY_TASK_USAGE, 1_799_999);
    expect(before.allowed).toBe(true);
    if (!before.allowed) throw new Error("Expected time below deadline");
    expect(before.budget.activeProfile).toBe("Small");
    expect(recordActiveWork(budget, before.usage, 1)).toEqual({
      allowed: false,
      evidence: {
        resource: "ACTIVE_WORK_TIME",
        limit: 1_800,
        observed: 1_800,
        attempted: 1_800,
      },
    });
  });
});
