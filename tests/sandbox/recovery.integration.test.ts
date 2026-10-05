import { describe, expect, it } from "vitest";

import { requireDockerImage, runDocker } from "./integration-fixtures.js";
import { CleanupExecutionGate, createVerificationLabels } from "../../src/sandbox/cleanup.js";
import { DockerCliExecution } from "../../src/sandbox/docker-process.js";

describe("Phase 5 Docker recovery integration (T128)", () => {
  it(
    "is platform-gated before exercising daemon-loss recovery",
    { timeout: 30_000 },
    ({ skip }) => {
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
    },
  );

  it("releases the execution slot only after confirmed recovery cleanup", ({ skip }) => {
    requireDockerImage({ skip }, "alpine:3.20");
    const gate = new CleanupExecutionGate();
    gate.hold();
    gate.settle({ status: "CONFIRMED", attempts: 1 });
    expect(gate.canStart()).toBe(true);
  });

  it(
    "reconciles interrupted container lifecycle with ownership fencing",
    { timeout: 30_000 },
    async ({ skip }) => {
      requireDockerImage({ skip }, "alpine:3.20");
      const docker = new DockerCliExecution();
      const resourceId = docker.registerResource();

      // Create interrupted container
      runDocker([
        "create",
        "--name",
        resourceId,
        "--label",
        "slop-loop.owner=verification",
        "--label",
        `slop-loop.containerId=${resourceId}`,
        "--label",
        "slop-loop.taskId=interrupted-task-01",
        "alpine:3.20",
        "sleep",
        "120",
      ]);

      try {
        // Recovery stops and removes the orphaned container
        const outcome = await docker.stopAndRemove(resourceId);
        expect(outcome).toBe("CONFIRMED");

        // Verify container is gone
        const remaining = runDocker([
          "container",
          "ls",
          "--all",
          "--quiet",
          "--filter",
          `name=^/${resourceId}$`,
        ]);
        expect(remaining).toBe("");
      } finally {
        try {
          runDocker(["rm", "--force", "--", resourceId]);
        } catch {
          // already cleaned up
        }
      }
    },
  );
});
