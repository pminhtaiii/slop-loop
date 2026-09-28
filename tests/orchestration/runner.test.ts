import { describe, expect, it } from "vitest";

import * as runnerModule from "../../src/orchestration/runner.js";
import { runModelProposal, runTaskEvent } from "../../src/orchestration/runner.js";
import { admitTask, createTask } from "../../src/orchestration/task.js";
import { advanceTask } from "../../src/orchestration/transitions.js";

function answeringTask(profile: "Small" | "Medium" | "Large" = "Medium") {
  const admitted = admitTask(
    createTask({ taskId: "ask-task", objective: "Explain the build", mode: "Ask" }),
    0,
    profile,
  );
  return advanceTask(advanceTask(admitted, "INSPECTING"), "ANSWERING");
}

function waitingEditTask() {
  const admitted = admitTask(
    createTask({ taskId: "edit-task", objective: "Fix the build", mode: "Edit" }),
    0,
  );
  return advanceTask(
    advanceTask(advanceTask(admitted, "INSPECTING"), "PLANNING"),
    "WAITING_FOR_FILE_PERMISSION",
  );
}

function verifyingEditTask() {
  const admitted = admitTask(
    createTask({ taskId: "verified-edit", objective: "Fix the build", mode: "Edit" }),
    0,
    "Small",
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
  return task;
}

describe("bounded task runner", () => {
  it("keeps a terminal task inert after its checkout slot has been released", () => {
    const slot = new runnerModule.TaskCheckoutSlot();
    const runner = new runnerModule.TaskRunner(answeringTask(), slot);
    const finished = runner.process({ kind: "MODEL_PROPOSAL", action: "COMPLETE" }, 1);
    expect(finished).toMatchObject({ oldState: "ANSWERING", newState: "COMPLETED" });
    expect(slot.heldBy).toBeNull();

    const late = runner.process({ kind: "TICK" }, 2);
    expect(late.status).toBe("ALREADY_TERMINAL");
    expect(late.task).toBe(finished.task);
    expect(slot.heldBy).toBeNull();
  });

  it("holds the checkout slot until an in-flight attempt settles even when its deadline expires", () => {
    const slot = new runnerModule.TaskCheckoutSlot();
    const runner = new runnerModule.TaskRunner(answeringTask(), slot);
    const started = runner.beginToolAttempt(1);
    if (started === null) throw new Error("Expected an in-flight attempt");

    const expired = runner.process({ kind: "TICK" }, 1_800_000);
    expect(expired.status).toBe("BUDGET_EXHAUSTED");
    expect(started.signal.aborted).toBe(true);
    expect(runner.canStart(started.generation)).toBe(false);
    expect(slot.heldBy).toBe("ask-task");

    runner.settleToolAttempt(started.generation, 1_800_001);
    expect(slot.heldBy).toBeNull();
    expect(runner.task.state).toBe("FAILED");
  });

  it("reports the state crossed by an explicit stop", () => {
    const slot = new runnerModule.TaskCheckoutSlot();
    const runner = new runnerModule.TaskRunner(answeringTask(), slot);
    expect(runner.process({ kind: "CANCEL" }, 1)).toMatchObject({
      status: "ACCEPTED",
      oldState: "ANSWERING",
      newState: "CANCELLED",
    });
    expect(slot.heldBy).toBeNull();
  });

  it("keeps the checkout slot until an in-flight attempt is safely settled after stop", () => {
    expect(runnerModule.TaskCheckoutSlot).toBeTypeOf("function");
    const slot = new runnerModule.TaskCheckoutSlot();
    const runner = new runnerModule.TaskRunner(answeringTask(), slot);
    const started = runner.beginToolAttempt(1_000);
    expect(started).not.toBeNull();
    if (started === null) throw new Error("Expected an in-flight attempt");
    expect(started.signal.aborted).toBe(false);
    expect(slot.heldBy).toBe("ask-task");

    runner.stop(1_001);
    expect(started.signal.aborted).toBe(true);
    expect(runner.canStart(started.generation)).toBe(false);
    expect(slot.heldBy).toBe("ask-task");
    expect(runner.task.state).not.toBe("CANCELLED");
    expect(runner.process({ kind: "MODEL_PROPOSAL", action: "COMPLETE" }, 1_002).status).toBe(
      "ACTION_REJECTED",
    );

    runner.settleToolAttempt(started.generation, 1_003);
    expect(runner.task.state).toBe("CANCELLED");
    expect(slot.heldBy).toBeNull();
  });

  it("retains the checkout slot while waiting for file permission", () => {
    expect(runnerModule.TaskCheckoutSlot).toBeTypeOf("function");
    const slot = new runnerModule.TaskCheckoutSlot();
    const waiting = new runnerModule.TaskRunner(waitingEditTask(), slot);
    expect(() => new runnerModule.TaskRunner(answeringTask(), slot)).toThrow();
    waiting.stop(1_000);
    expect(slot.heldBy).toBeNull();
    expect(new runnerModule.TaskRunner(answeringTask(), slot).task.state).toBe("ANSWERING");
  });

  it("ends Large model capacity with a bounded handoff", () => {
    const admitted = admitTask(
      createTask({ taskId: "large-limit", objective: "Explain the build", mode: "Ask" }),
      0,
      "Large",
    );
    let task = advanceTask(advanceTask(admitted, "INSPECTING"), "ANSWERING");
    for (let turn = 0; turn < 120; turn += 1) {
      task = runModelProposal(task, { action: "PLAN" }, 0).task;
    }
    const exhausted = runModelProposal(task, { action: "PLAN" }, 0);
    expect(exhausted.status).toBe("BUDGET_EXHAUSTED");
    expect(exhausted.task.outcome).toMatchObject({
      state: "FAILED",
      reason: "BUDGET_EXHAUSTED",
      evidence: { resource: "MODEL_TURNS", limit: 120, observed: 120, attempted: 121 },
      handoff: {
        objective: "Explain the build",
        exhaustedBudget: "MODEL_TURNS",
        limit: 120,
        observed: 120,
        completedActions: [],
        changedPaths: [],
        verification: "NOT_RUN",
        blockers: [],
      },
    });
  });

  it("carries trusted bounded progress into the budget handoff", () => {
    const task = verifyingEditTask();
    const reported = runTaskEvent(
      task,
      {
        kind: "PROGRESS",
        report: {
          completedAction: "Patched the calculation",
          changedPath: "src/calculate.ts",
          blocker: "Verification is still running",
          remainingStep: "Review the failed check",
        },
      },
      1_000,
    );
    expect(reported.status).toBe("ACCEPTED");
    const exhausted = runTaskEvent(reported.task, { kind: "TICK" }, 1_800_000);
    expect(exhausted.task.outcome).toMatchObject({
      reason: "BUDGET_EXHAUSTED",
      handoff: {
        completedActions: ["Patched the calculation"],
        changedPaths: ["src/calculate.ts"],
        blockers: ["Verification is still running"],
        remainingSteps: ["Review the failed check"],
      },
    });
  });

  it("rejects oversized progress instead of putting it in a handoff", () => {
    const task = verifyingEditTask();
    const reported = runTaskEvent(
      task,
      { kind: "PROGRESS", report: { completedAction: "x".repeat(257) } },
      1_000,
    );
    expect(reported.status).toBe("ACTION_REJECTED");
    const exhausted = runTaskEvent(reported.task, { kind: "TICK" }, 1_800_000);
    expect(exhausted.task.outcome).toMatchObject({
      handoff: { completedActions: [] },
    });
  });

  it("does not record a changed path before an Edit task has reached mutation", () => {
    const reported = runTaskEvent(
      answeringTask(),
      { kind: "PROGRESS", report: { changedPath: "src/calculate.ts" } },
      1_000,
    );
    expect(reported.status).toBe("ACTION_REJECTED");
    expect(reported.task.progress.changedPaths).toEqual([]);
  });

  it("charges model requests and individually dispatched calls in separate counters", () => {
    const admitted = admitTask(
      createTask({ taskId: "separate", objective: "Inspect source", mode: "Ask" }),
      0,
      "Small",
    );
    const inspecting = runTaskEvent(
      admitted,
      { kind: "TRUSTED_TRANSITION", target: "INSPECTING" },
      100,
    ).task;
    const answering = runTaskEvent(
      inspecting,
      { kind: "TRUSTED_TRANSITION", target: "ANSWERING" },
      200,
    ).task;
    expect(answering.usage).toMatchObject({ modelTurns: 0, toolAttempts: 0 });

    const rejected = runModelProposal(answering, { action: "PLAN" }, 300).task;
    expect(rejected.usage).toMatchObject({ modelTurns: 1, toolAttempts: 0 });
    const dispatched = runTaskEvent(rejected, { kind: "TOOL_ATTEMPT" }, 400).task;
    expect(dispatched.usage).toMatchObject({ modelTurns: 1, toolAttempts: 1 });
  });

  it("does not spend active-work time during a developer permission wait", () => {
    const admitted = admitTask(
      createTask({ taskId: "wait-clock", objective: "Fix source", mode: "Edit" }),
      0,
      "Small",
    );
    let task = admitted;
    for (const [target, now] of [
      ["INSPECTING", 1_000],
      ["PLANNING", 2_000],
      ["WAITING_FOR_FILE_PERMISSION", 3_000],
    ] as const) {
      task = runTaskEvent(task, { kind: "TRUSTED_TRANSITION", target }, now).task;
    }
    const waiting = runTaskEvent(task, { kind: "TICK" }, 7_200_000);
    expect(waiting.task.state).toBe("WAITING_FOR_FILE_PERMISSION");
    expect(waiting.task.usage.activeWorkMs).toBe(3_000);
    const resumed = runTaskEvent(
      waiting.task,
      { kind: "TRUSTED_TRANSITION", target: "IMPLEMENTING" },
      7_200_000,
    );
    expect(resumed.task.state).toBe("IMPLEMENTING");
    expect(resumed.task.usage.activeWorkMs).toBe(3_000);
  });

  it("shares one admission-sealed recovery budget across reasons", () => {
    const admitted = admitTask(
      createTask({ taskId: "recovery", objective: "Inspect source", mode: "Ask" }),
      0,
      "Small",
    );
    let task = advanceTask(advanceTask(admitted, "INSPECTING"), "ANSWERING");
    for (const reason of ["MODEL_RECOVERY", "DENIAL_RECOVERY", "MODEL_RECOVERY"] as const) {
      task = runTaskEvent(task, { kind: "RECOVER", reason }, 1_000).task;
    }
    expect(task.usage.retryReasons).toEqual([
      "MODEL_RECOVERY",
      "DENIAL_RECOVERY",
      "MODEL_RECOVERY",
    ]);
    const exhausted = runTaskEvent(task, { kind: "RECOVER", reason: "DENIAL_RECOVERY" }, 1_000);
    expect(exhausted.task.budget?.activeProfile).toBe("Small");
    expect(exhausted.task.outcome).toMatchObject({
      reason: "BUDGET_EXHAUSTED",
      evidence: { resource: "RETRIES", limit: 3, observed: 3, attempted: 4 },
    });
  });

  it("keeps the selected mode for the entire admitted task", () => {
    const waiting = waitingEditTask();
    const attempted = runTaskEvent(waiting, { kind: "MODE_CHANGE", mode: "Ask" }, 1_000);
    expect(attempted.status).toBe("ACTION_REJECTED");
    expect(attempted.task.mode).toBe("Edit");
    expect(attempted.task.state).toBe("WAITING_FOR_FILE_PERMISSION");
  });

  it("charges rejected model proposals and permits completion on Small turn 30", () => {
    let task = answeringTask("Small");
    for (let step = 1; step <= 29; step += 1) {
      const result = runTaskEvent(task, { kind: "MODEL_PROPOSAL", action: "PLAN" }, 1_000);
      expect(result.status).toBe("ACTION_REJECTED");
      expect(result.task.state).toBe("ANSWERING");
      expect(result.task.usage.modelTurns).toBe(step);
      task = result.task;
    }

    const final = runTaskEvent(task, { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, 1_000);
    expect(final.status).toBe("ACCEPTED");
    expect(final.task.state).toBe("COMPLETED");
    expect(final.task.usage.modelTurns).toBe(30);
  });

  it("promotes the 31st Small model turn without resetting usage", () => {
    let task = answeringTask("Small");
    for (let step = 0; step < 30; step += 1) {
      task = runTaskEvent(task, { kind: "MODEL_PROPOSAL", action: "PLAN" }, 1_000).task;
    }

    const extra = runTaskEvent(task, { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, 1_000);
    expect(extra.status).toBe("ACCEPTED");
    expect(extra.task.state).toBe("COMPLETED");
    expect(extra.task.usage.modelTurns).toBe(31);
    expect(extra.task.budget).toMatchObject({ activeProfile: "Medium", maxRetries: 3 });
  });

  it("rejects mode/objective changes while progress events spend no work capacity", () => {
    const waiting = waitingEditTask();
    const mode = runTaskEvent(waiting, { kind: "MODE_CHANGE", mode: "Ask" }, 1_000);
    expect(mode.status).toBe("ACTION_REJECTED");
    expect(mode.task.state).toBe("WAITING_FOR_FILE_PERMISSION");
    expect(mode.task.usage.modelTurns).toBe(0);

    const progress = runTaskEvent(mode.task, { kind: "PROGRESS" }, 1_000);
    expect(progress.task.usage).toMatchObject({ modelTurns: 0, toolAttempts: 0 });

    const replaced = runTaskEvent(
      progress.task,
      { kind: "REPLACE_OBJECTIVE", objective: "Delete the build" },
      1_000,
    );
    expect(replaced.status).toBe("ACTION_REJECTED");
    expect(replaced.task.objective).toBe("Fix the build");
    expect(replaced.task.usage.modelTurns).toBe(0);

    const editProposal = runModelProposal(replaced.task, { action: "IMPLEMENT" }, 1_000);
    expect(editProposal.status).toBe("ACTION_REJECTED");
    expect(editProposal.task.state).toBe("WAITING_FOR_FILE_PERMISSION");
    expect(editProposal.task.usage.modelTurns).toBe(1);
  });

  it("expires an active task at 30 minutes without promoting", () => {
    const expired = runTaskEvent(answeringTask("Small"), { kind: "TICK" }, 1_800_000);
    expect(expired.status).toBe("BUDGET_EXHAUSTED");
    expect(expired.task.state).toBe("FAILED");
    expect(expired.task.outcome).toMatchObject({
      reason: "BUDGET_EXHAUSTED",
      evidence: { resource: "ACTIVE_WORK_TIME", limit: 1_800, observed: 1_800, attempted: 1_800 },
    });
    expect(expired.task.budget?.activeProfile).toBe("Small");
  });

  it("distinguishes a recoverable policy denial from a blocked task", () => {
    const dispatched = runTaskEvent(answeringTask(), { kind: "TOOL_ATTEMPT" }, 1_000);
    const denied = runTaskEvent(
      dispatched.task,
      { kind: "POLICY_DENIAL", authorizedRouteRemains: true },
      1_000,
    );
    expect(denied.status).toBe("ACTION_REJECTED");
    expect(denied.task.state).toBe("ANSWERING");
    expect(denied.task.usage).toMatchObject({ modelTurns: 0, toolAttempts: 1 });

    const blocked = runTaskEvent(
      denied.task,
      { kind: "POLICY_DENIAL", authorizedRouteRemains: false },
      1_000,
    );
    expect(blocked.task.state).toBe("BLOCKED");
    expect(blocked.task.outcome?.reason).toBe("POLICY_DENIED");
  });

  it("cancels on developer request and seals the outcome", () => {
    const cancelled = runTaskEvent(answeringTask(), { kind: "CANCEL" }, 1_000);
    expect(cancelled.task.state).toBe("CANCELLED");
    expect(cancelled.task.usage.modelTurns).toBe(0);
    expect(cancelled.task.outcome?.reason).toBe("CANCELLED_BY_DEVELOPER");
    expect(
      runTaskEvent(cancelled.task, { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, 2_000),
    ).toMatchObject({
      status: "ALREADY_TERMINAL",
      task: cancelled.task,
      oldState: "CANCELLED",
      newState: "CANCELLED",
      usage: { modelTurns: 0, toolAttempts: 0, retries: 0 },
    });
  });

  it("fails an illegal trusted transition without charging model or tool work", () => {
    const failed = runTaskEvent(
      answeringTask(),
      { kind: "TRUSTED_TRANSITION", target: "IMPLEMENTING" },
      1_000,
    );
    expect(failed.task.state).toBe("FAILED");
    expect(failed.task.outcome?.reason).toBe("INVALID_TRANSITION");
    expect(failed.task.usage).toMatchObject({ modelTurns: 0, toolAttempts: 0 });
  });

  it("accepts changed Edit completion only after a trusted passing check", () => {
    const unverified = verifyingEditTask();
    expect(
      runTaskEvent(unverified, { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, 1_000).status,
    ).toBe("ACTION_REJECTED");
    const passed = runTaskEvent(unverified, { kind: "VERIFICATION_RESULT", passed: true }, 1_000);
    expect(passed.task.state).toBe("REVIEWING");
    expect(passed.task.verification).toBe("PASSED");

    const completed = runTaskEvent(
      passed.task,
      { kind: "MODEL_PROPOSAL", action: "COMPLETE" },
      1_000,
    );
    expect(completed.task.state).toBe("COMPLETED");
    expect(completed.task.outcome).toMatchObject({
      reason: "EDIT_VERIFIED",
      verification: "PASSED",
    });
  });

  it("requires fresh verification after a review retry", () => {
    const passed = runTaskEvent(
      verifyingEditTask(),
      { kind: "VERIFICATION_RESULT", passed: true },
      1_000,
    );
    const retry = runTaskEvent(passed.task, { kind: "RETRY" }, 1_000);
    expect(retry.task.state).toBe("REPAIRING");
    expect(retry.task.usage.retries).toBe(1);
    expect(retry.task.verification).toBe("NOT_RUN");
    let next = retry.task;
    for (const target of ["IMPLEMENTING", "SANDBOX_READY", "VERIFYING"] as const) {
      next = runTaskEvent(next, { kind: "TRUSTED_TRANSITION", target }, 1_000).task;
    }
    expect(runTaskEvent(next, { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, 1_000).status).toBe(
      "ACTION_REJECTED",
    );
    expect(
      runTaskEvent(next, { kind: "TRUSTED_TRANSITION", target: "REVIEWING" }, 1_000).task.outcome
        ?.reason,
    ).toBe("INVALID_TRANSITION");
  });

  it("ends with a budget handoff when failed verification has no recovery left", () => {
    let task = verifyingEditTask();
    for (let retry = 0; retry < 3; retry += 1) {
      task = runTaskEvent(task, { kind: "RECOVER", reason: "MODEL_RECOVERY" }, 1_000).task;
    }
    const failed = runTaskEvent(task, { kind: "VERIFICATION_RESULT", passed: false }, 1_000);
    expect(failed.task.state).toBe("VERIFYING");
    const exhausted = runTaskEvent(failed.task, { kind: "RETRY" }, 1_000);
    expect(exhausted.task.outcome).toMatchObject({
      reason: "BUDGET_EXHAUSTED",
      evidence: { resource: "RETRIES", limit: 3, observed: 3 },
      handoff: { verification: "FAILED" },
    });
  });

  it("completes an early no-change Edit without claiming verification", () => {
    const admitted = admitTask(
      createTask({ taskId: "unchanged", objective: "Fix if needed", mode: "Edit" }),
      0,
    );
    const inspecting = advanceTask(admitted, "INSPECTING");
    const result = runTaskEvent(inspecting, { kind: "NO_CHANGE" }, 1_000);
    expect(result.task.state).toBe("COMPLETED");
    expect(result.task.usage.modelTurns).toBe(0);
    expect(result.task.outcome).toMatchObject({
      reason: "NO_CHANGE_NEEDED",
      verification: "NOT_RUN",
    });
  });

  it("stops before a fourth repair retry without charging a model turn", () => {
    let task = runTaskEvent(
      verifyingEditTask(),
      { kind: "VERIFICATION_RESULT", passed: true },
      1_000,
    ).task;
    for (let retryNumber = 1; retryNumber <= 3; retryNumber += 1) {
      task = runTaskEvent(task, { kind: "RETRY" }, 1_000).task;
      expect(task.state).toBe("REPAIRING");
      expect(task.usage.retries).toBe(retryNumber);
      for (const target of ["IMPLEMENTING", "SANDBOX_READY", "VERIFYING"] as const) {
        task = runTaskEvent(task, { kind: "TRUSTED_TRANSITION", target }, 1_000).task;
      }
      task = runTaskEvent(task, { kind: "VERIFICATION_RESULT", passed: true }, 1_000).task;
      expect(task.state).toBe("REVIEWING");
    }

    const exhausted = runTaskEvent(task, { kind: "RETRY" }, 1_000);
    expect(exhausted.status).toBe("BUDGET_EXHAUSTED");
    expect(exhausted.task.state).toBe("FAILED");
    expect(exhausted.task.usage.modelTurns).toBe(task.usage.modelTurns);
    expect(exhausted.task.outcome).toMatchObject({
      reason: "BUDGET_EXHAUSTED",
      evidence: { resource: "RETRIES", limit: 3, observed: 3, attempted: 4 },
    });
  });

  it("rejects model payloads that claim trusted authority or extra fields", () => {
    const forged = runModelProposal(
      answeringTask(),
      { kind: "TRUSTED_TRANSITION", target: "IMPLEMENTING" },
      1_000,
    );
    expect(forged.status).toBe("ACTION_REJECTED");
    expect(forged.task.state).toBe("ANSWERING");
    expect(forged.task.usage.modelTurns).toBe(1);

    const extra = runModelProposal(
      answeringTask(),
      { action: "COMPLETE", budget: { maxModelTurns: 1_000 } },
      1_000,
    );
    expect(extra.status).toBe("ACTION_REJECTED");
    expect(extra.task.state).toBe("ANSWERING");
    expect(extra.task.budget?.maxModelTurns).toBe(60);

    const valid = runModelProposal(answeringTask(), { action: "COMPLETE" }, 1_000);
    expect(valid.task.state).toBe("COMPLETED");
  });

  it("turns an invalid trusted clock into a typed internal failure", () => {
    const result = runTaskEvent(
      answeringTask(),
      { kind: "MODEL_PROPOSAL", action: "COMPLETE" },
      Number.NaN,
    );
    expect(result.task.state).toBe("FAILED");
    expect(result.task.outcome?.reason).toBe("INTERNAL_ERROR");
  });

  it("refuses a mode change that would expand an informational objective", () => {
    const initial = answeringTask();
    const attempted = runTaskEvent(initial, { kind: "MODE_CHANGE", mode: "Edit" }, 1_000);
    expect(attempted.status).toBe("ACTION_REJECTED");
    expect(attempted.task.mode).toBe("Ask");
    expect(attempted.task.usage.modelTurns).toBe(0);
  });

  it("returns bounded refusal reasons and transition metadata", () => {
    const initial = answeringTask();
    const rejected = runModelProposal(initial, { action: "PLAN" }, 1_000);
    expect(rejected).toMatchObject({
      status: "ACTION_REJECTED",
      oldState: "ANSWERING",
      newState: "ANSWERING",
      usage: { modelTurns: 1, toolAttempts: 0, retries: 0 },
      reason: "ACTION_NOT_ALLOWED",
    });
    const malformed = runModelProposal(initial, { action: "COMPLETE", mode: "Edit" }, 1_000);
    expect(malformed.reason).toBe("INVALID_MODEL_PROPOSAL");
    const policy = runTaskEvent(
      initial,
      { kind: "POLICY_DENIAL", authorizedRouteRemains: true },
      1_000,
    );
    expect(policy.reason).toBe("POLICY_DENIED");

    const accepted = runModelProposal(initial, { action: "COMPLETE" }, 1_000);
    expect(accepted).toMatchObject({
      status: "ACCEPTED",
      oldState: "ANSWERING",
      newState: "COMPLETED",
      usage: { modelTurns: 1, toolAttempts: 0, retries: 0 },
    });
  });

  it("accepts a legal PLAN proposal without granting Edit execution", () => {
    const admitted = admitTask(
      createTask({ taskId: "plan-proposal", objective: "Fix the build", mode: "Edit" }),
      0,
    );
    const inspecting = advanceTask(admitted, "INSPECTING");
    const planned = runModelProposal(inspecting, { action: "PLAN" }, 1_000);
    expect(planned.status).toBe("ACCEPTED");
    expect(planned.task.state).toBe("PLANNING");
    expect(planned.task.usage.modelTurns).toBe(1);
    expect(planned.task.changed).toBe(false);
    expect(planned.task.outcome).toBeNull();
  });
});
