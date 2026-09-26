import { describe, expect, it } from "vitest";

import { admitTask, createTask } from "../../src/orchestration/task.js";
import type { TaskMode } from "../../src/orchestration/task.js";
import { runTaskEvent } from "../../src/orchestration/runner.js";
import { advanceTask, changeTaskMode, finishTask } from "../../src/orchestration/transitions.js";

describe("trusted task transitions", () => {
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

  it("pauses Edit and resumes through fresh inspection", () => {
    const admitted = admitTask(
      createTask({ taskId: "switch-1", objective: "Fix the build", mode: "Edit" }),
      0,
    );
    const waiting = advanceTask(
      advanceTask(advanceTask(admitted, "INSPECTING"), "PLANNING"),
      "WAITING_FOR_FILE_PERMISSION",
    );

    const paused = changeTaskMode(waiting, "Ask");
    expect(paused).toMatchObject({
      taskId: "switch-1",
      objective: "Fix the build",
      mode: "Ask",
      state: "PAUSED_FOR_MODE",
      pausedFrom: "WAITING_FOR_FILE_PERMISSION",
    });
    const resumed = changeTaskMode(paused, "Edit");
    expect(resumed.state).toBe("INSPECTING");
    expect(resumed.pausedFrom).toBeNull();
    expect(resumed.usage).toEqual(waiting.usage);
    expect(advanceTask(advanceTask(resumed, "PLANNING"), "WAITING_FOR_FILE_PERMISSION").state).toBe(
      "WAITING_FOR_FILE_PERMISSION",
    );
  });

  it("allows same-objective Ask to Edit but never revives a terminal task", () => {
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
    const edit = changeTaskMode(answering, "Edit");
    expect(edit.state).toBe("PLANNING");
    expect(edit.objective).toBe("Investigate and fix the build");

    const completed = finishTask(answering, { state: "COMPLETED", reason: "ANSWERED" });
    expect(changeTaskMode(completed, "Edit")).toBe(completed);
  });

  it("does not turn an explanation-only task into an Edit task", () => {
    const admitted = admitTask(
      createTask({ taskId: "explain-only", objective: "Explain the build", mode: "Ask" }),
      0,
    );
    const answering = advanceTask(advanceTask(admitted, "INSPECTING"), "ANSWERING");

    expect(answering.intent).toBe("INFORMATIONAL");
    expect(changeTaskMode(answering, "Edit")).toBe(answering);
    expect(changeTaskMode(answering, "Admin" as TaskMode)).toBe(answering);
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
