import { describe, expect, it } from "vitest";

import { requireDockerImage, runDocker } from "./integration-fixtures.js";
import { CleanupExecutionGate, createVerificationLabels } from "../../src/sandbox/cleanup.js";

describe("Phase 5 Docker recovery integration", () => {
  it("is platform-gated before exercising daemon-loss recovery", ({ skip }) => {
    requireDockerImage({ skip }, "alpine:3.20");
    const labels = createVerificationLabels("recovery-task", "recovery-container");
    const id = runDocker([
      "create",
      "--label",
      `slop-loop.owner=${labels["slop-loop.owner"]}`,
      "--label",
      `slop-loop.taskId=${labels["slop-loop.taskId"]}`,
      "--label",
      `slop-loop.containerId=${labels["slop-loop.containerId"]}`,
      "alpine:3.20",
      "sleep",
      "60",
    ]);
    try {
      expect(
        runDocker(["inspect", "--format", '{{index .Config.Labels "slop-loop.owner"}}', id]),
      ).toBe("verification");
    } finally {
      runDocker(["rm", "--force", "--", id]);
    }
    const gate = new CleanupExecutionGate();
    gate.hold();
    gate.settle({ status: "UNCERTAIN", attempts: 3 });
    expect(gate.canStart()).toBe(false);
  });

  it("releases the execution slot only after confirmed recovery cleanup", ({ skip }) => {
    requireDockerImage({ skip }, "alpine:3.20");
    const gate = new CleanupExecutionGate();
    gate.hold();
    gate.settle({ status: "CONFIRMED", attempts: 1 });
    expect(gate.canStart()).toBe(true);
  });
});
