import { describe, expect, it } from "vitest";

import { admitTask, createTask } from "../../src/orchestration/task.js";
import type { TaskOutcome } from "../../src/orchestration/task.js";
import { runTaskEvent } from "../../src/orchestration/runner.js";
import { advanceTask, finishTask } from "../../src/orchestration/transitions.js";

describe("task admission", () => {
  it("keeps identity and objective stable when admitted", () => {
    const received = createTask({
      taskId: "task-1",
      objective: "Explain the failing build",
      mode: "Ask",
    });

    expect(received.state).toBe("RECEIVED");
    expect(received.outcome).toBeNull();

    const admitted = admitTask(received, 1_000);

    expect(admitted).toMatchObject({
      taskId: "task-1",
      objective: "Explain the failing build",
      mode: "Ask",
      state: "ADMITTED",
      admittedAt: 1_000,
      usage: { agentSteps: 0, retries: 0 },
      budget: { maxAgentSteps: 30, maxRetries: 3, maxTaskSeconds: 900 },
    });
    expect(received.state).toBe("RECEIVED");
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.budget)).toBe(true);
    expect(Object.isFrozen(admitted.usage)).toBe(true);
  });

  it("rejects empty or oversized task identity and objective", () => {
    expect(() => createTask({ taskId: "", objective: "Explain the build", mode: "Ask" })).toThrow();
    expect(() => createTask({ taskId: "task-1", objective: " ", mode: "Ask" })).toThrow();
    expect(() =>
      createTask({ taskId: "task-1", objective: "x".repeat(4_097), mode: "Edit" }),
    ).toThrow();
  });

  it("turns duplicate admission and invalid trusted inputs into typed outcomes", () => {
    const received = createTask({
      taskId: "admission-error",
      objective: "Explain the build",
      mode: "Ask",
    });
    const admitted = admitTask(received, 0);
    expect(admitTask(admitted, 1_000).outcome?.reason).toBe("INVALID_TRANSITION");
    expect(admitTask(received, Number.NaN).outcome?.reason).toBe("INTERNAL_ERROR");
    expect(
      admitTask(received, 0, {
        maxAgentSteps: 0,
        maxRetries: 3,
        maxTaskSeconds: 900,
      }).outcome?.reason,
    ).toBe("INTERNAL_ERROR");
  });
});

describe("terminal task sealing", () => {
  const outcomes: readonly TaskOutcome[] = [
    { state: "COMPLETED", reason: "ANSWERED" },
    { state: "FAILED", reason: "INTERNAL_ERROR" },
    { state: "BLOCKED", reason: "DEPENDENCY_UNAVAILABLE" },
    { state: "CANCELLED", reason: "CANCELLED_BY_DEVELOPER" },
  ];

  it.each(outcomes)("preserves $state against later work", (outcome) => {
    const received = createTask({
      taskId: `terminal-${outcome.state}`,
      objective: "Explain the build",
      mode: "Ask",
    });
    const answering = advanceTask(advanceTask(admitTask(received, 0), "INSPECTING"), "ANSWERING");
    const terminal = finishTask(answering, outcome);

    expect(terminal.state).toBe(outcome.state);
    expect(terminal.outcome).toMatchObject(outcome);
    expect(advanceTask(terminal, "PLANNING")).toBe(terminal);
    expect(finishTask(terminal, { state: "FAILED", reason: "INTERNAL_ERROR" })).toBe(terminal);
    expect(Object.isFrozen(terminal.outcome)).toBe(true);
  });
});

describe("typed task outcomes", () => {
  it("permits a truthful early no-change Edit conclusion", () => {
    const admitted = admitTask(
      createTask({ taskId: "no-change", objective: "Fix if needed", mode: "Edit" }),
      0,
    );
    const planning = advanceTask(advanceTask(admitted, "INSPECTING"), "PLANNING");
    const completed = finishTask(planning, {
      state: "COMPLETED",
      reason: "NO_CHANGE_NEEDED",
    });
    expect(completed.state).toBe("COMPLETED");
    expect(completed.outcome).toMatchObject({
      reason: "NO_CHANGE_NEEDED",
      verification: "NOT_RUN",
    });
  });

  it("keeps failed verification distinct from a policy block", () => {
    const admitted = admitTask(
      createTask({ taskId: "failure", objective: "Fix the build", mode: "Edit" }),
      0,
    );
    const waiting = advanceTask(
      advanceTask(advanceTask(admitted, "INSPECTING"), "PLANNING"),
      "WAITING_FOR_FILE_PERMISSION",
    );
    expect(
      finishTask(waiting, { state: "FAILED", reason: "VERIFICATION_FAILED" }).outcome,
    ).toMatchObject({ state: "FAILED", reason: "INVALID_TRANSITION" });
    const verifying = advanceTask(
      advanceTask(advanceTask(waiting, "IMPLEMENTING"), "SANDBOX_READY"),
      "VERIFYING",
    );
    expect(
      finishTask(verifying, { state: "FAILED", reason: "VERIFICATION_FAILED" }).outcome,
    ).toMatchObject({ state: "FAILED", reason: "INVALID_TRANSITION" });
    const failedCheck = runTaskEvent(
      verifying,
      { kind: "VERIFICATION_RESULT", passed: false },
      1_000,
    ).task;
    expect(failedCheck.verification).toBe("FAILED");
    expect(
      finishTask(failedCheck, { state: "FAILED", reason: "VERIFICATION_FAILED" }).outcome,
    ).toMatchObject({ state: "FAILED", reason: "VERIFICATION_FAILED", verification: "FAILED" });
    expect(
      finishTask(waiting, { state: "BLOCKED", reason: "POLICY_DENIED" }).outcome,
    ).toMatchObject({ state: "BLOCKED", reason: "POLICY_DENIED" });
  });

  it("rejects a malformed terminal state and reason pair at runtime", () => {
    const admitted = admitTask(
      createTask({ taskId: "bad-outcome", objective: "Explain the build", mode: "Ask" }),
      0,
    );
    const answering = advanceTask(advanceTask(admitted, "INSPECTING"), "ANSWERING");
    const malformed = { state: "RECEIVED", reason: "ANSWERED" } as unknown as TaskOutcome;

    const failed = finishTask(answering, malformed);
    expect(failed.state).toBe("FAILED");
    expect(failed.outcome?.reason).toBe("INVALID_TRANSITION");
  });

  it("seals nested budget evidence with the terminal outcome", () => {
    const admitted = admitTask(
      createTask({ taskId: "sealed-evidence", objective: "Explain the build", mode: "Ask" }),
      0,
    );
    const answering = advanceTask(advanceTask(admitted, "INSPECTING"), "ANSWERING");
    const failed = finishTask(answering, {
      state: "FAILED",
      reason: "BUDGET_EXHAUSTED",
      evidence: { resource: "AGENT_STEPS", limit: 30, observed: 30, attempted: 31 },
    });
    if (failed.outcome?.reason !== "BUDGET_EXHAUSTED") throw new Error("Budget outcome missing");

    expect(Object.isFrozen(failed.outcome)).toBe(true);
    expect(Object.isFrozen(failed.outcome.evidence)).toBe(true);
  });

  it("rejects invented passing verification on an Ask answer", () => {
    const admitted = admitTask(
      createTask({ taskId: "ask-evidence", objective: "Explain the build", mode: "Ask" }),
      0,
    );
    const answering = advanceTask(advanceTask(admitted, "INSPECTING"), "ANSWERING");
    const forgedOutcome = {
      state: "COMPLETED",
      reason: "ANSWERED",
      verification: "PASSED",
    } as unknown as TaskOutcome;
    const invented = finishTask(answering, forgedOutcome);
    expect(invented.state).toBe("FAILED");
    expect(invented.outcome?.reason).toBe("INVALID_TRANSITION");
  });
});
