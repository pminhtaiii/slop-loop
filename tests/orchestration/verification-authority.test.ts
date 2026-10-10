import {
  runTaskEvent as reduceTaskEvent,
  observeTaskEvent,
} from "../../src/orchestration/runner.js";
import { runObservedTaskEvent as runTaskEvent } from "../support/verification.js";
import { describe, expect, it } from "vitest";
import { createTask } from "../../src/orchestration/task.js";
import { advanceTask } from "../../src/orchestration/transitions.js";
import { runModelProposal, TaskRunner, TaskCheckoutSlot } from "../../src/orchestration/runner.js";
import { admitTask } from "../support/admission.js";
import { completionCoordinator, verificationResult } from "../support/verification.js";
import { ToolGateway } from "../../src/tools/gateway.js";

function verifying(taskId = "task") {
  let task = admitTask(createTask({ taskId, objective: "verify edit", mode: "Edit" }), 0);
  for (const state of [
    "INSPECTING",
    "PLANNING",
    "WAITING_FOR_FILE_PERMISSION",
    "IMPLEMENTING",
    "SANDBOX_READY",
    "VERIFYING",
  ] as const)
    task = advanceTask(task, state);
  return task;
}

describe("trusted verification completion authority", () => {
  it("reduces the same verification input deterministically without consuming authority", () => {
    const task = verifying("pure-receipt");
    const event = verificationResult(task);
    const observation = observeTaskEvent(task, event, 1);
    const first = reduceTaskEvent(task, event, 1, observation);
    expect(first.task.state).toBe("REVIEWING");
    expect(reduceTaskEvent(task, event, 1, observation)).toEqual(first);
    expect(runTaskEvent(task, event, 1).status).toBe("ACTION_REJECTED");
  });

  it("rejects an observation reused at a different event time", () => {
    const task = verifying("observation-time");
    const event = verificationResult(task);
    const observation = observeTaskEvent(task, event, 1);
    expect(reduceTaskEvent(task, event, 2, observation).status).toBe("ACTION_REJECTED");
  });

  it("reduces completion deterministically while ingress rejects new stale observations", () => {
    const task = verifying("pure-complete");
    let current: "CURRENT" | "STALE" = "CURRENT";
    let probes = 0;
    const receipt = completionCoordinator(task, () => {
      probes += 1;
      return current;
    }).issueCompletion(task, () => true);
    const runner = new TaskRunner(task, new TaskCheckoutSlot());
    const reviewing = runner.process({ kind: "VERIFICATION_RESULT", evidence: receipt }, 1).task;
    const event = { kind: "MODEL_PROPOSAL", action: "COMPLETE" } as const;
    const observation = observeTaskEvent(reviewing, event, 2);
    const beforeReduction = probes;
    const first = reduceTaskEvent(reviewing, event, 2, observation);
    expect(first.task.state).toBe("COMPLETED");
    current = "STALE";
    expect(reduceTaskEvent(reviewing, event, 2, observation)).toEqual(first);
    expect(probes).toBe(beforeReduction);
    expect(runner.process(event, 2).status).toBe("ACTION_REJECTED");
  });
  it("rejects forged, serialized and input-mismatched observations", () => {
    const task = verifying("bound-observation");
    const event = verificationResult(task);
    const observation = observeTaskEvent(task, event, 1)!;
    const serialized: unknown = JSON.parse(JSON.stringify(observation));
    const prototype: unknown = Object.getPrototypeOf(observation);
    const prototypeCopy: unknown = Object.create(typeof prototype === "object" ? prototype : null);
    for (const forged of [{ status: "PASS" }, serialized, prototypeCopy]) {
      // @ts-expect-error deliberately forged runtime observations must fail closed
      expect(reduceTaskEvent(task, event, 1, forged).status).toBe("ACTION_REJECTED");
    }
    expect(reduceTaskEvent({ ...task }, event, 1, observation).status).toBe("ACTION_REJECTED");
    expect(reduceTaskEvent(task, verificationResult(task), 1, observation).status).toBe(
      "ACTION_REJECTED",
    );
    const failedTask = verifying("bound-failure");
    const failure = verificationResult(failedTask, false);
    const failureObservation = observeTaskEvent(failedTask, failure, 1);
    const failed = reduceTaskEvent(failedTask, failure, 1, failureObservation).task;
    expect(reduceTaskEvent(failed, failure, 1, failureObservation).status).toBe("ACTION_REJECTED");
  });
  it("does not consume a valid receipt during a pure reduction or rejected runtime ingress", () => {
    const task = verifying("pure-does-not-consume");
    const event = verificationResult(task);
    expect(reduceTaskEvent(task, event, 1).status).toBe("ACTION_REJECTED");
    const runner = new TaskRunner(task, new TaskCheckoutSlot());
    const attempt = runner.beginToolAttempt(1)!;
    expect(runner.process(event, 2).reason).toBe("TOOL_IN_FLIGHT");
    const acknowledge = runner.cleanupTracker(attempt.generation).hold("owned-container");
    runner.settleToolAttempt(attempt.generation, 2);
    expect(runner.process(event, 3).reason).toBe("TASK_STOPPING");
    acknowledge("CONFIRMED");
    expect(runner.process(event, 4).task.state).toBe("REVIEWING");
  });
  it("rejects consumed receipts when another runner reconstructs the same admitted state", () => {
    const task = verifying("reconstructed");
    const first = new TaskRunner(task, new TaskCheckoutSlot());
    const event = verificationResult(task);
    expect(first.process(event, 1).task.state).toBe("REVIEWING");
    const reconstructed = new TaskRunner(task, new TaskCheckoutSlot());
    expect(reconstructed.process(event, 1).status).toBe("ACTION_REJECTED");
    expect(reconstructed.process(verificationResult(task), 1).status).toBe("ACTION_REJECTED");
  });
  it("rejects serialized and partial verdicts", () => {
    const task = verifying();
    const receipt = verificationResult(task);
    const serialized: unknown = JSON.parse(JSON.stringify(receipt.evidence));
    for (const evidence of [
      true,
      { passed: true },
      { status: "PASS", freshness: "CURRENT", evidence: [] },
      serialized,
    ]) {
      // @ts-expect-error intentionally invalid runtime completion authority
      expect(runTaskEvent(task, { kind: "VERIFICATION_RESULT", evidence }, 1).status).toBe(
        "ACTION_REJECTED",
      );
    }
  });
  it("ends policy failure without retaining a hold when no executor started", async () => {
    const slot = new TaskCheckoutSlot();
    const runner = new TaskRunner(verifying(), slot);
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => {
          throw new Error("unavailable authority");
        },
      },
      grants: { grantFor: () => undefined },
      executors: {},
    });
    const result = await runner.dispatchProposals(
      gateway,
      [{ name: "run_build", arguments: { profile: "build" } }],
      1,
    );
    expect(result[0]).toMatchObject({ kind: "FAILED", reason: "POLICY_FAILURE" });
    expect(runner.task.outcome?.reason).toBe("POLICY_FAILURE");
    expect(slot.heldBy).toBeNull();
    expect(slot.isHeld).toBe(false);
  });
  it("records terminal failure while retaining uncertain resource cleanup", () => {
    const slot = new TaskCheckoutSlot();
    const runner = new TaskRunner(verifying(), slot);
    const attempt = runner.beginToolAttempt(1)!;
    const acknowledge = runner.cleanupTracker(attempt.generation).hold("container");
    runner.settleToolAttempt(attempt.generation, 2);
    const failure = runner.process({ kind: "EXECUTION_FAILURE" }, 3);
    expect(failure.task.outcome?.reason).toBe("EXECUTION_FAILURE");
    expect(slot.heldBy).toBe(runner.task.taskId);
    acknowledge("CONFIRMED");
    expect(slot.heldBy).toBeNull();
  });
  it("rejects cross-task and cross-attempt receipts without consuming the valid original", () => {
    const task = verifying();
    const receipt = verificationResult(task);
    expect(runTaskEvent(verifying("other"), receipt, 1).status).toBe("ACTION_REJECTED");
    expect(
      runTaskEvent(advanceTask({ ...task, state: "SANDBOX_READY" }, "VERIFYING"), receipt, 1)
        .status,
    ).toBe("ACTION_REJECTED");
    expect(runTaskEvent(task, receipt, 1).task.state).toBe("REVIEWING");
    expect(runTaskEvent(task, receipt, 1).status).toBe("ACTION_REJECTED");
  });
  it("binds deterministic identities to distinct admissions even for the same task ID", () => {
    const task = verifying("same-id");
    const other = verifying("same-id");
    expect(other.verificationAttemptId).toBe(task.verificationAttemptId);
    expect(other.capabilityCeiling).not.toBe(task.capabilityCeiling);
    const receipt = verificationResult(task);
    expect(runTaskEvent(other, receipt, 1).status).toBe("ACTION_REJECTED");
    expect(runTaskEvent(task, receipt, 1).task.state).toBe("REVIEWING");
  });
  it("increments attempt identity through a legal repair without resetting its sequence", () => {
    const initial = verifying("repair");
    const failed = runTaskEvent(initial, verificationResult(initial, false), 1).task;
    const repaired = runTaskEvent(failed, { kind: "RETRY" }, 2).task;
    expect(repaired.state).toBe("REPAIRING");
    const implementing = advanceTask(repaired, "IMPLEMENTING");
    expect(implementing.verificationAttemptId).toBeUndefined();
    const second = advanceTask(advanceTask(implementing, "SANDBOX_READY"), "VERIFYING");
    expect(second.verificationAttemptSequence).toBe(2);
    expect(second.verificationAttemptId).toBe("repair:verification:2");
  });
  it("rejects stale or unconfirmed final freshness including drift after receipt issuance", () => {
    const task = verifying();
    let current: "CURRENT" | "STALE" | "UNCONFIRMED" = "CURRENT";
    const coordinator = completionCoordinator(task, () => current);
    const receipt = coordinator.issueCompletion(task, () => true);
    current = "STALE";
    expect(runTaskEvent(task, { kind: "VERIFICATION_RESULT", evidence: receipt }, 1).status).toBe(
      "ACTION_REJECTED",
    );
    current = "UNCONFIRMED";
    expect(() => coordinator.issueCompletion(task, () => true)).toThrow(
      "Incomplete or untrusted verification completion",
    );
  });
  it.each([
    { cleanup: "UNCERTAIN" as const },
    { targetId: "tests:targeted" },
    { taskId: "other" },
    { attemptId: "old" },
  ])("rejects incomplete identities/cleanup %j", (overrides) => {
    const task = verifying();
    expect(() =>
      completionCoordinator(task, undefined, overrides).issueCompletion(task, () => true),
    ).toThrow("Incomplete or untrusted verification completion");
  });
  it("requires canonical result evidence for every contributing check", () => {
    const task = verifying();
    expect(() =>
      completionCoordinator(task).issueCompletion(task, (evidence) => evidence.check !== "build"),
    ).toThrow("Incomplete or untrusted verification completion");
  });
  it("requires explicit exit, termination and native prelude evidence", () => {
    const task = verifying();
    expect(() =>
      completionCoordinator(task, undefined, { exitCode: undefined }).issueCompletion(
        task,
        () => true,
      ),
    ).toThrow("Incomplete or untrusted verification completion");
  });
  it("rejects malformed full-check metadata at the trusted seam", () => {
    const task = verifying();
    const malformed: Partial<import("../../src/sandbox/types.js").VerificationEvidence> = {
      // @ts-expect-error invalid adapter data must fail closed at runtime
      nativePrelude: "UNKNOWN",
    };
    for (const overrides of [
      { terminationReason: undefined },
      { nativePrelude: undefined },
      { truncated: undefined },
      malformed,
    ]) {
      expect(() =>
        completionCoordinator(task, undefined, overrides).issueCompletion(task, () => true),
      ).toThrow("Incomplete or untrusted verification completion");
    }
  });
  it("rejects a second receipt for an already consumed attempt", () => {
    const task = verifying();
    const first = verificationResult(task);
    const second = verificationResult(task);
    expect(runTaskEvent(task, first, 1).task.verification).toBe("PASSED");
    expect(runTaskEvent(task, second, 1).status).toBe("ACTION_REJECTED");
  });
  it("refuses completion if the checkout drifts after receipt acceptance", () => {
    const task = verifying();
    let current: "CURRENT" | "STALE" = "CURRENT";
    const receipt = completionCoordinator(task, () => current).issueCompletion(task, () => true);
    const reviewing = runTaskEvent(
      task,
      { kind: "VERIFICATION_RESULT", evidence: receipt },
      1,
    ).task;
    current = "STALE";
    expect(runTaskEvent(reviewing, { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, 2).status).toBe(
      "ACTION_REJECTED",
    );
  });
  it.each([
    { nativePrelude: "FAIL" as const },
    { truncated: true },
    { terminationReason: "TIMEOUT" as const },
  ])("cannot pass failed execution metadata %j", (overrides) => {
    const task = verifying();
    const receipt = completionCoordinator(task, undefined, overrides).issueCompletion(
      task,
      () => true,
    );
    expect(
      runTaskEvent(task, { kind: "VERIFICATION_RESULT", evidence: receipt }, 1).task.verification,
    ).toBe("FAILED");
  });
  it("does not complete while a settled attempt still has a cleanup hold", () => {
    const runner = new TaskRunner(verifying(), new TaskCheckoutSlot());
    const attempt = runner.beginToolAttempt(1)!;
    runner.settleToolAttempt(attempt.generation, 2);
    const result = runner.process(verificationResult(runner.task), 3);
    expect(result.status).toBe("ACTION_REJECTED");
    expect(runModelProposal(result.task, { action: "COMPLETE" }, 4).status).toBe("ACTION_REJECTED");
  });
});
