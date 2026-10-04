import { describe, expect, it } from "vitest";

import {
  CleanupExecutionGate,
  createVerificationLabels,
  stopAndRemoveOwnedContainer,
} from "../../src/sandbox/cleanup.js";

describe("owned verification cleanup", () => {
  it("creates immutable ownership labels for a task container", () => {
    expect(createVerificationLabels("task-1", "container-1")).toEqual({
      "slop-loop.owner": "verification",
      "slop-loop.taskId": "task-1",
      "slop-loop.containerId": "container-1",
    });
  });

  it("retries bounded stop/remove and confirms disappearance", async () => {
    const calls: string[] = [];
    const result = await stopAndRemoveOwnedContainer(
      {
        id: "container-1",
        labels: createVerificationLabels("task-1", "container-1"),
      },
      {
        stop: () => {
          calls.push("stop");
          return Promise.resolve();
        },
        remove: () => {
          calls.push("remove");
          return Promise.resolve();
        },
        inspect: () => Promise.resolve(false),
      },
      { maxAttempts: 3 },
    );

    expect(result).toEqual({ status: "CONFIRMED", attempts: 1 });
    expect(calls).toEqual(["stop", "remove"]);
  });

  it("reports uncertain cleanup after bounded failures", async () => {
    const result = await stopAndRemoveOwnedContainer(
      {
        id: "container-1",
        labels: createVerificationLabels("task-1", "container-1"),
      },
      {
        stop: () => Promise.reject(new Error("daemon unavailable")),
        remove: () => Promise.reject(new Error("daemon unavailable")),
        inspect: () => Promise.resolve(true),
      },
      { maxAttempts: 2 },
    );

    expect(result).toEqual({ status: "UNCERTAIN", attempts: 2 });
  });

  it("holds the execution slot after uncertain cleanup", () => {
    const gate = new CleanupExecutionGate();
    expect(gate.canStart()).toBe(true);
    gate.hold();
    expect(gate.canStart()).toBe(false);
    gate.settle({ status: "UNCERTAIN", attempts: 2 });
    expect(gate.canStart()).toBe(false);
    gate.settle({ status: "CONFIRMED", attempts: 1 });
    expect(gate.canStart()).toBe(true);
  });
});
