import { describe, expect, it } from "vitest";

import { bindDeveloperPreparation } from "../../src/sandbox/preparation.js";
import { SandboxGateway } from "../../src/sandbox/gateway.js";
import { DEFAULT_SANDBOX_LIMITS } from "../../src/sandbox/config.js";
import { createTask } from "../../src/orchestration/task.js";
import { requireDocker } from "./integration-fixtures.js";

describe("Phase 5 verification journey", () => {
  it("requires Docker availability before exercising stale-image preparation", ({ skip }) => {
    requireDocker({ skip });
    const binding = bindDeveloperPreparation({
      confirmedBy: "developer",
      workspaceId: "workspace-e2e",
      inputFingerprint: "fingerprint-e2e",
      recipeHash: "recipe-e2e",
    });
    const firstTask = createTask({ taskId: "stale-task", objective: "verify", mode: "Edit" });
    const secondTask = createTask({ taskId: "fresh-task", objective: "verify", mode: "Edit" });

    expect(binding.confirmedBy).toBe("developer");
    expect(secondTask.taskId).not.toBe(firstTask.taskId);
  });

  it("maps stale preparation through the real sandbox gateway contract", async ({ skip }) => {
    requireDocker({ skip });
    const gateway = new SandboxGateway(
      {
        readiness: () =>
          Promise.resolve({ status: "BLOCKED" as const, reason: "IMAGE_STALE" as const }),
        executeCheck: () => Promise.reject(new Error("not reached")),
      },
      DEFAULT_SANDBOX_LIMITS,
    );

    await expect(
      gateway.readiness({
        imageId: `sha256:${"a".repeat(64)}`,
        fingerprint: "stale-fingerprint",
        architecture: "linux-x64",
        status: "STALE",
      }),
    ).resolves.toEqual({ status: "EXTERNAL_BLOCKER", reason: "IMAGE_STALE" });
  });
});
