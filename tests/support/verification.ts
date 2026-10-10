import { runTaskEvent, observeTaskEvent } from "../../src/orchestration/runner.js";
import type { TaskEvent } from "../../src/orchestration/runner.js";
import type { TaskContext } from "../../src/orchestration/task.js";
import { VerificationCoordinator } from "../../src/sandbox/verification.js";
import type { VerificationEvidence, Freshness } from "../../src/sandbox/types.js";

/** Source fixture only; not evidence of real Docker verification. */
export function completionCoordinator(
  task: TaskContext,
  freshness: () => Freshness = () => "CURRENT",
  overrides: Partial<VerificationEvidence> = {},
) {
  const coordinator = new VerificationCoordinator(
    ["tests", "lint", "typecheck", "build"],
    {
      formatVersion: 1,
      workspaceId: task.capabilityCeiling!.workspaceId,
      exclusionPolicyId: "fixture",
      entries: [],
      totalBytes: 0,
      snapshotId: "snapshot",
    },
    freshness,
  );
  for (const check of ["tests", "lint", "typecheck", "build"])
    coordinator.record({
      check,
      snapshotId: "snapshot",
      imageId: "sha256:" + "a".repeat(64),
      status: "PASS",
      cleanup: "CONFIRMED",
      preparationFingerprint: "fingerprint",
      profileSetId: "profiles",
      targetId: check === "tests" ? "tests:ordinary" : `${check}:${check}`,
      taskId: task.taskId,
      attemptId: task.verificationAttemptId!,
      nativeIdentity: "native",
      nativePrelude: "PASS",
      exitCode: 0,
      truncated: false,
      terminationReason: "EXITED",
      ...overrides,
    });
  return coordinator;
}

export function verificationResult(task: TaskContext, passed = true) {
  const coordinator = completionCoordinator(
    task,
    () => "CURRENT",
    passed ? {} : { status: "FAIL", exitCode: 1 },
  );
  return {
    kind: "VERIFICATION_RESULT" as const,
    evidence: coordinator.issueCompletion(task, () => true),
  };
}

/** Exercises the trusted runtime ingress; reducer-only tests call runTaskEvent directly. */
export function runObservedTaskEvent(task: TaskContext, event: TaskEvent, now: number) {
  return runTaskEvent(task, event, now, observeTaskEvent(task, event, now));
}
