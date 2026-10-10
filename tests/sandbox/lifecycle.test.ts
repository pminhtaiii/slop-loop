import { describe, expect, it } from "vitest";

import { SandboxGateway } from "../../src/sandbox/gateway.js";
import { DEFAULT_SANDBOX_LIMITS } from "../../src/sandbox/config.js";
import { createTaskBudget } from "../../src/orchestration/budget.js";
import { TaskState, createTask } from "../../src/orchestration/task.js";
import { TaskCheckoutSlot, TaskRunner, runTaskEvent } from "../../src/orchestration/runner.js";
import type { SandboxBackend } from "../../src/sandbox/types.js";

describe("stale image task lifecycle", () => {
  it("maps a missing image to preparation required", async () => {
    const backend: SandboxBackend = {
      readiness: () =>
        Promise.resolve({ status: "BLOCKED" as const, reason: "PREPARATION_REQUIRED" as const }),
      executeCheck: () => Promise.reject(new Error("not reached")),
    };
    const gateway = new SandboxGateway(backend, DEFAULT_SANDBOX_LIMITS);

    await expect(
      gateway.readiness({
        imageId: "sha256:" + "a".repeat(64),
        fingerprint: "fingerprint",
        architecture: "linux-x64",
        status: "MISSING",
      }),
    ).resolves.toEqual({ status: "EXTERNAL_BLOCKER", reason: "PREPARATION_REQUIRED" });
  });

  it("ends the current task as terminal blocked without rollback or resume", () => {
    const admitted = Object.freeze({
      ...createTask({ taskId: "task-1", objective: "verify", mode: "Edit" }),
      state: TaskState.ADMITTED,
      budget: createTaskBudget("Medium"),
      lastObservedAt: 1,
    });
    const blocked = runTaskEvent(admitted, { kind: "IMAGE_STALE" }, 2);

    expect(blocked.task.state).toBe(TaskState.BLOCKED);
    expect(blocked.task.outcome).toEqual({ state: TaskState.BLOCKED, reason: "IMAGE_STALE" });
    expect(runTaskEvent(blocked.task, { kind: "TICK" }, 3).status).toBe("ALREADY_TERMINAL");
  });

  it("requires a new admitted task after preparation", () => {
    const oldTask = createTask({ taskId: "task-1", objective: "verify", mode: "Edit" });
    const newTask = createTask({ taskId: "task-2", objective: "verify", mode: "Edit" });

    expect(oldTask.taskId).not.toBe(newTask.taskId);
    expect(newTask.state).toBe(TaskState.RECEIVED);
  });
});

describe("TaskCheckoutSlot fencing on unconfirmed cleanup", () => {
  it("holds the slot when task finishes with CLEANUP_UNCONFIRMED until settled", () => {
    const slot = new TaskCheckoutSlot();
    const task = Object.freeze({
      ...createTask({ taskId: "task-1", objective: "verify", mode: "Edit" }),
      state: TaskState.ADMITTED,
      budget: createTaskBudget("Medium"),
      lastObservedAt: 1,
    });
    const runner = new TaskRunner(task, slot);
    runner.process({ kind: "CLEANUP_UNCONFIRMED" }, 2);

    expect(runner.task.state).toBe(TaskState.BLOCKED);
    expect(slot.isHeld).toBe(true);
    expect(() => slot.claim("task-2")).toThrow("Checkout already has an active task");

    const identity = { taskId: "task-1", resourceId: "unconfirmed-cleanup", generation: 1 };
    slot.settle({ ...identity, status: "UNCERTAIN" });
    expect(slot.isHeld).toBe(true);
    expect(() => slot.claim("task-2")).toThrow("Checkout already has an active task");

    slot.settle({ ...identity, status: "CONFIRMED" });
    expect(slot.isHeld).toBe(false);
    expect(() => slot.claim("task-2")).not.toThrow();
    expect(slot.heldBy).toBe("task-2");
  });
});
