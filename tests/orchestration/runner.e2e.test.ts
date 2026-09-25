import { describe, expect, it } from "vitest";

import { runTaskScript } from "../../src/orchestration/runner.js";
import { admitTask, createTask } from "../../src/orchestration/task.js";

describe("scripted task lifecycle", () => {
  it("completes an Ask task through admission, inspection and answering", () => {
    const initial = admitTask(
      createTask({ taskId: "ask-e2e", objective: "Explain the build", mode: "Ask" }),
      0,
    );
    const result = runTaskScript(initial, [
      { event: { kind: "TRUSTED_TRANSITION", target: "INSPECTING" }, now: 1_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "ANSWERING" }, now: 2_000 },
      { event: { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, now: 3_000 },
    ]);
    expect(result.results.map((item) => item.task.state)).toEqual([
      "INSPECTING",
      "ANSWERING",
      "COMPLETED",
    ]);
    expect(result.task.outcome?.reason).toBe("ANSWERED");
    expect(result.task.usage.agentSteps).toBe(3);
  });

  it("completes Edit only after permission stage, sandbox stage and verification", () => {
    const initial = admitTask(
      createTask({ taskId: "edit-e2e", objective: "Fix the build", mode: "Edit" }),
      0,
    );
    const result = runTaskScript(initial, [
      { event: { kind: "TRUSTED_TRANSITION", target: "INSPECTING" }, now: 1_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "PLANNING" }, now: 2_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "WAITING_FOR_FILE_PERMISSION" }, now: 3_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "IMPLEMENTING" }, now: 4_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "SANDBOX_READY" }, now: 5_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "VERIFYING" }, now: 6_000 },
      { event: { kind: "VERIFICATION_RESULT", passed: true }, now: 7_000 },
      { event: { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, now: 8_000 },
    ]);
    expect(result.results.map((item) => item.task.state)).toEqual([
      "INSPECTING",
      "PLANNING",
      "WAITING_FOR_FILE_PERMISSION",
      "IMPLEMENTING",
      "SANDBOX_READY",
      "VERIFYING",
      "REVIEWING",
      "COMPLETED",
    ]);
    expect(result.task.outcome).toMatchObject({ reason: "EDIT_VERIFIED", verification: "PASSED" });
  });

  it("ends a no-change Edit during inspection without invented verification", () => {
    const initial = admitTask(
      createTask({ taskId: "no-change-e2e", objective: "Fix if needed", mode: "Edit" }),
      0,
    );
    const result = runTaskScript(initial, [
      { event: { kind: "TRUSTED_TRANSITION", target: "INSPECTING" }, now: 1_000 },
      { event: { kind: "NO_CHANGE" }, now: 2_000 },
    ]);
    expect(result.task.state).toBe("COMPLETED");
    expect(result.task.outcome).toMatchObject({
      reason: "NO_CHANGE_NEEDED",
      verification: "NOT_RUN",
    });
    expect(result.results.map((item) => item.task.state)).toEqual(["INSPECTING", "COMPLETED"]);
  });

  it("reinspects after a mode pause and then follows the permission path", () => {
    const initial = admitTask(
      createTask({ taskId: "pause-e2e", objective: "Fix the build", mode: "Edit" }),
      0,
    );
    const result = runTaskScript(initial, [
      { event: { kind: "TRUSTED_TRANSITION", target: "INSPECTING" }, now: 1_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "PLANNING" }, now: 2_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "WAITING_FOR_FILE_PERMISSION" }, now: 3_000 },
      { event: { kind: "MODE_CHANGE", mode: "Ask" }, now: 4_000 },
      { event: { kind: "MODE_CHANGE", mode: "Edit" }, now: 5_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "PLANNING" }, now: 6_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "WAITING_FOR_FILE_PERMISSION" }, now: 7_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "IMPLEMENTING" }, now: 8_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "SANDBOX_READY" }, now: 9_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "VERIFYING" }, now: 10_000 },
      { event: { kind: "VERIFICATION_RESULT", passed: true }, now: 11_000 },
      { event: { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, now: 12_000 },
    ]);
    expect(result.results.map((item) => item.task.state).slice(3, 7)).toEqual([
      "PAUSED_FOR_MODE",
      "INSPECTING",
      "PLANNING",
      "WAITING_FOR_FILE_PERMISSION",
    ]);
    expect(result.task.state).toBe("COMPLETED");
  });

  it("terminates a repeated invalid proposal loop on its finite step budget", () => {
    const initial = admitTask(
      createTask({ taskId: "exhaust-e2e", objective: "Explain the build", mode: "Ask" }),
      0,
    );
    const result = runTaskScript(initial, [
      { event: { kind: "TRUSTED_TRANSITION", target: "INSPECTING" }, now: 1_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "ANSWERING" }, now: 2_000 },
      ...Array.from({ length: 30 }, () => ({
        event: { kind: "MODEL_PROPOSAL" as const, action: "PLAN" as const },
        now: 3_000,
      })),
    ]);
    expect(result.task.state).toBe("FAILED");
    expect(result.task.usage.agentSteps).toBe(30);
    expect(result.task.outcome).toMatchObject({
      reason: "BUDGET_EXHAUSTED",
      evidence: { resource: "AGENT_STEPS", observed: 30, attempted: 31 },
    });
    expect(result.results.length).toBe(31);
  });
});
