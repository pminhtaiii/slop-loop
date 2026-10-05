import { describe, expect, it } from "vitest";

import { bindDeveloperPreparation, publishPreparedImage } from "../../src/sandbox/preparation.js";
import { SandboxGateway } from "../../src/sandbox/gateway.js";
import { DEFAULT_SANDBOX_LIMITS } from "../../src/sandbox/config.js";
import { createTask } from "../../src/orchestration/task.js";
import { createTaskBudget } from "../../src/orchestration/budget.js";
import { runTaskEvent } from "../../src/orchestration/runner.js";
import { TaskState } from "../../src/orchestration/task.js";
import { VerificationCoordinator } from "../../src/sandbox/verification.js";
import type { PreparedImageRecord, VerificationSnapshot } from "../../src/sandbox/types.js";
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

  it("executes the full stale-image developer preparation and new-task reevaluation journey (T122)", async () => {
    // 1. Task 1 is admitted with an initial Edit objective
    const task1 = Object.freeze({
      ...createTask({ taskId: "task-stale-01", objective: "fix-discount", mode: "Edit" }),
      state: TaskState.ADMITTED,
      budget: createTaskBudget("Medium"),
      lastObservedAt: 1,
    });
    expect(task1.state).toBe(TaskState.ADMITTED);

    // 2. Gateway encounters a STALE image record
    const staleImage: PreparedImageRecord = {
      imageId: `sha256:${"1".repeat(64)}`,
      fingerprint: "old-fingerprint-v1",
      architecture: "linux-x64",
      status: "STALE",
    };

    const gateway = new SandboxGateway(
      {
        readiness: (image) => {
          if (image.status === "STALE") {
            return Promise.resolve({ status: "BLOCKED", reason: "IMAGE_STALE" });
          }
          return Promise.resolve({ status: "READY" });
        },
        executeCheck: () =>
          Promise.resolve({
            check: "tests",
            snapshotId: "snapshot-fresh-01",
            imageId: `sha256:${"2".repeat(64)}`,
            status: "PASS",
            cleanup: "CONFIRMED",
            preparationFingerprint: "new-fingerprint-v2",
            profileSetId: "profile-pnpm-01",
            targetId: "target-tests",
            taskId: "task-fresh-02",
            attemptId: "attempt-01",
            nativeIdentity: "native-x64",
          }),
      },
      DEFAULT_SANDBOX_LIMITS,
    );

    const readiness1 = await gateway.readiness(staleImage);
    expect(readiness1).toEqual({ status: "EXTERNAL_BLOCKER", reason: "IMAGE_STALE" });

    // 3. Task 1 transitions to terminal BLOCKED via IMAGE_STALE event; state is non-resumable
    const blocked = runTaskEvent(task1, { kind: "IMAGE_STALE" }, 2);
    expect(blocked.task.state).toBe(TaskState.BLOCKED);
    expect(blocked.task.outcome).toEqual({ state: TaskState.BLOCKED, reason: "IMAGE_STALE" });
    expect(runTaskEvent(blocked.task, { kind: "TICK" }, 3).status).toBe("ALREADY_TERMINAL");

    // 4. Developer explicitly confirms preparation via developer helper binding
    const developerBinding = bindDeveloperPreparation({
      confirmedBy: "developer",
      workspaceId: "workspace-repo-root",
      inputFingerprint: "new-fingerprint-v2",
      recipeHash: "recipe-sha256-verified",
    });
    expect(developerBinding.confirmedBy).toBe("developer");

    // 5. Preparation builds & publishes fresh immutable image
    const freshImage = publishPreparedImage({
      imageId: `sha256:${"2".repeat(64)}`,
      fingerprint: developerBinding.inputFingerprint,
      architecture: "linux-x64",
    });
    expect(freshImage.status).toBe("READY");

    // 6. A new Task 2 is admitted in the workspace (Task 1 does not resume)
    const task2 = Object.freeze({
      ...createTask({
        taskId: "task-fresh-02",
        objective: "fix-discount-retry",
        mode: "Edit",
      }),
      state: TaskState.ADMITTED,
      budget: createTaskBudget("Medium"),
      lastObservedAt: 3,
    });
    expect(task2.taskId).not.toBe(task1.taskId);
    expect(task2.state).toBe(TaskState.ADMITTED);

    // 7. Gateway reevaluates readiness with fresh image -> READY
    const readiness2 = await gateway.readiness(freshImage);
    expect(readiness2).toEqual({ status: "READY" });

    // 8. Reevaluation captures fresh snapshot and coordinates verification
    const freshSnapshot: VerificationSnapshot = {
      formatVersion: 1,
      workspaceId: "workspace-repo-root",
      exclusionPolicyId: "default-v1",
      entries: [
        {
          path: "src/discount.ts",
          bytes: 40,
          mode: 0o644,
          hash: "abc123hash",
          content: Buffer.from("export const calc = () => 10;"),
        },
      ],
      totalBytes: 40,
      snapshotId: "snapshot-fresh-01",
    };

    const coordinator = new VerificationCoordinator(["tests"], freshSnapshot, () => "CURRENT", {
      preparationFingerprint: freshImage.fingerprint,
      profileSetId: "profile-pnpm-01",
      taskId: task2.taskId,
      attemptId: "attempt-01",
      nativeIdentity: "native-x64",
    });

    coordinator.record({
      check: "tests",
      snapshotId: freshSnapshot.snapshotId,
      imageId: freshImage.imageId,
      status: "PASS",
      cleanup: "CONFIRMED",
      preparationFingerprint: freshImage.fingerprint,
      profileSetId: "profile-pnpm-01",
      targetId: "target-tests",
      taskId: task2.taskId,
      attemptId: "attempt-01",
      nativeIdentity: "native-x64",
    });

    const verdict = await coordinator.verdict();
    expect(verdict.status).toBe("PASS");
    expect(verdict.freshness).toBe("CURRENT");
    expect(verdict.evidence).toHaveLength(1);
  });
});
