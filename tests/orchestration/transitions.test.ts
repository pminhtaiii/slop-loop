import { describe, expect, it } from "vitest";

import { createTask } from "../../src/orchestration/task.js";
import { admitTask } from "../support/admission.js";
import { runTaskEvent } from "../../src/orchestration/runner.js";
import { advanceTask, finishTask } from "../../src/orchestration/transitions.js";

describe("trusted task transitions", () => {
  it("rejects a budget handoff that contradicts its exhaustion evidence", () => {
    const admitted = admitTask(
      createTask({ taskId: "handoff-evidence", objective: "Explain build", mode: "Ask" }),
      0,
    );
    const answering = advanceTask(advanceTask(admitted, "INSPECTING"), "ANSWERING");
    const failed = finishTask(answering, {
      state: "FAILED",
      reason: "BUDGET_EXHAUSTED",
      evidence: { resource: "MODEL_TURNS", limit: 60, observed: 60, attempted: 61 },
      handoff: {
        exhaustedBudget: "TOOL_ATTEMPTS",
        limit: 120,
        observed: 60,
        objective: "Explain build",
        completedActions: [],
        changedPaths: [],
        verification: "NOT_RUN",
        blockers: [],
        stopReason: "MODEL_TURNS limit reached",
        remainingSteps: ["Review handoff"],
      },
    });
    expect(failed.outcome?.reason).toBe("INVALID_TRANSITION");
  });

  it("follows the Ask and Edit paths after admission", () => {
    const ask = admitTask(
      createTask({ taskId: "ask-1", objective: "Explain the build", mode: "Ask" }),
      0,
    );
    expect(advanceTask(advanceTask(ask, "INSPECTING"), "ANSWERING").state).toBe("ANSWERING");

    const edit = admitTask(
      createTask({ taskId: "edit-1", objective: "Fix the build", mode: "Edit" }),
      0,
    );
    const waiting = advanceTask(
      advanceTask(advanceTask(edit, "INSPECTING"), "PLANNING"),
      "WAITING_FOR_FILE_PERMISSION",
    );
    expect(waiting.state).toBe("WAITING_FOR_FILE_PERMISSION");
  });

  it("fails a trusted illegal jump without entering its target", () => {
    const received = createTask({
      taskId: "edit-2",
      objective: "Fix the build",
      mode: "Edit",
    });

    const failed = advanceTask(received, "IMPLEMENTING");

    expect(failed.state).toBe("FAILED");
    expect(failed.outcome).toMatchObject({
      state: "FAILED",
      reason: "INVALID_TRANSITION",
    });
    expect(received.state).toBe("RECEIVED");
  });

  it("cannot enter an Edit state while the current mode is Ask", () => {
    const ask = admitTask(
      createTask({ taskId: "ask-2", objective: "Explain the build", mode: "Ask" }),
      0,
    );
    const inspecting = advanceTask(ask, "INSPECTING");

    expect(advanceTask(inspecting, "PLANNING").outcome?.reason).toBe("INVALID_TRANSITION");
  });

  it("keeps an Edit task at the permission gate when a mode switch is requested", () => {
    const admitted = admitTask(
      createTask({ taskId: "switch-1", objective: "Fix the build", mode: "Edit" }),
      0,
    );
    const waiting = advanceTask(
      advanceTask(advanceTask(admitted, "INSPECTING"), "PLANNING"),
      "WAITING_FOR_FILE_PERMISSION",
    );

    const refused = runTaskEvent(waiting, { kind: "MODE_CHANGE", mode: "Ask" }, 1_000);
    expect(refused.task).toMatchObject({
      taskId: "switch-1",
      objective: "Fix the build",
      mode: "Edit",
      state: "WAITING_FOR_FILE_PERMISSION",
    });
    expect(refused.status).toBe("ACTION_REJECTED");
    expect(refused.task.usage.modelTurns).toBe(0);
  });

  it("does not let an Ask task with change intent enter the Edit path", () => {
    const admitted = admitTask(
      createTask({
        taskId: "switch-2",
        objective: "Investigate and fix the build",
        mode: "Ask",
        intent: "CHANGE",
      }),
      0,
    );
    const answering = advanceTask(advanceTask(admitted, "INSPECTING"), "ANSWERING");
    const refused = runTaskEvent(answering, { kind: "MODE_CHANGE", mode: "Edit" }, 1_000);
    expect(refused.task.mode).toBe("Ask");
    expect(refused.task.state).toBe("ANSWERING");
    expect(advanceTask(refused.task, "PLANNING").outcome?.reason).toBe("INVALID_TRANSITION");

    const completed = finishTask(answering, { state: "COMPLETED", reason: "ANSWERED" });
    expect(runTaskEvent(completed, { kind: "MODE_CHANGE", mode: "Edit" }, 2_000).task).toBe(
      completed,
    );
  });

  it("does not turn an explanation-only task into an Edit task", () => {
    const admitted = admitTask(
      createTask({ taskId: "explain-only", objective: "Explain the build", mode: "Ask" }),
      0,
    );
    const answering = advanceTask(advanceTask(admitted, "INSPECTING"), "ANSWERING");

    expect(answering.intent).toBe("INFORMATIONAL");
    const refused = runTaskEvent(answering, { kind: "MODE_CHANGE", mode: "Edit" }, 1_000);
    expect(refused.status).toBe("ACTION_REJECTED");
    expect(refused.task.mode).toBe("Ask");
  });

  it("cannot enter REPAIRING without an explicit budgeted retry", () => {
    const admitted = admitTask(
      createTask({ taskId: "repair-guard", objective: "Fix the build", mode: "Edit" }),
      0,
    );
    let task = admitted;
    for (const target of [
      "INSPECTING",
      "PLANNING",
      "WAITING_FOR_FILE_PERMISSION",
      "IMPLEMENTING",
      "SANDBOX_READY",
      "VERIFYING",
    ] as const) {
      task = advanceTask(task, target);
    }
    const reviewing = runTaskEvent(task, { kind: "VERIFICATION_RESULT", passed: true }, 1_000).task;
    expect(reviewing.state).toBe("REVIEWING");

    const bypass = advanceTask(reviewing, "REPAIRING");
    expect(bypass.state).toBe("FAILED");
    expect(bypass.outcome?.reason).toBe("INVALID_TRANSITION");
    expect(reviewing.usage.retries).toBe(0);
  });
});
