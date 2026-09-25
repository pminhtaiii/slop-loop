import { describe, expect, it } from "vitest";

import { runModelProposal, runTaskEvent } from "../../src/orchestration/runner.js";
import { admitTask, createTask } from "../../src/orchestration/task.js";
import { advanceTask } from "../../src/orchestration/transitions.js";

function answeringTask() {
  const admitted = admitTask(
    createTask({ taskId: "ask-task", objective: "Explain the build", mode: "Ask" }),
    0,
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

function verifyingEditTask(maxRetries = 3) {
  const admitted = admitTask(
    createTask({ taskId: "verified-edit", objective: "Fix the build", mode: "Edit" }),
    0,
    { maxAgentSteps: 30, maxRetries, maxTaskSeconds: 900 },
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
  it("charges rejected automatic proposals and permits completion on step 30", () => {
    let task = answeringTask();
    for (let step = 1; step <= 29; step += 1) {
      const result = runTaskEvent(task, { kind: "MODEL_PROPOSAL", action: "PLAN" }, 1_000);
      expect(result.status).toBe("ACTION_REJECTED");
      expect(result.task.state).toBe("ANSWERING");
      expect(result.task.usage.agentSteps).toBe(step);
      task = result.task;
    }

    const final = runTaskEvent(task, { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, 1_000);
    expect(final.status).toBe("ACCEPTED");
    expect(final.task.state).toBe("COMPLETED");
    expect(final.task.usage.agentSteps).toBe(30);
  });

  it("refuses the 31st automatic step before processing it", () => {
    let task = answeringTask();
    for (let step = 0; step < 30; step += 1) {
      task = runTaskEvent(task, { kind: "MODEL_PROPOSAL", action: "PLAN" }, 1_000).task;
    }

    const extra = runTaskEvent(task, { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, 1_000);
    expect(extra.status).toBe("BUDGET_EXHAUSTED");
    expect(extra.task.state).toBe("FAILED");
    expect(extra.task.usage.agentSteps).toBe(30);
    expect(extra.task.outcome).toMatchObject({
      reason: "BUDGET_EXHAUSTED",
      evidence: { resource: "AGENT_STEPS", limit: 30, observed: 30, attempted: 31 },
    });
  });

  it("routes developer mode and progress events without an agent step", () => {
    const waiting = waitingEditTask();
    const paused = runTaskEvent(waiting, { kind: "MODE_CHANGE", mode: "Ask" }, 1_000);
    expect(paused.status).toBe("PAUSED");
    expect(paused.task.state).toBe("PAUSED_FOR_MODE");
    expect(paused.task.usage.agentSteps).toBe(0);

    const progress = runTaskEvent(paused.task, { kind: "PROGRESS" }, 1_000);
    expect(progress.task).toBe(paused.task);
    expect(progress.task.usage.agentSteps).toBe(0);

    const replaced = runTaskEvent(
      paused.task,
      { kind: "REPLACE_OBJECTIVE", objective: "Delete the build" },
      1_000,
    );
    expect(replaced.status).toBe("ACTION_REJECTED");
    expect(replaced.task.objective).toBe("Fix the build");
    expect(replaced.task.usage.agentSteps).toBe(0);

    const editProposal = runModelProposal(paused.task, { action: "IMPLEMENT" }, 1_000);
    expect(editProposal.status).toBe("ACTION_REJECTED");
    expect(editProposal.task.state).toBe("PAUSED_FOR_MODE");
    expect(editProposal.task.usage.agentSteps).toBe(1);

    const resumed = runTaskEvent(editProposal.task, { kind: "MODE_CHANGE", mode: "Edit" }, 2_000);
    expect(resumed.task.state).toBe("INSPECTING");
    expect(resumed.task.usage.agentSteps).toBe(1);
    expect(resumed.task.taskId).toBe("edit-task");
    expect(resumed.task.objective).toBe("Fix the build");
    expect(advanceTask(resumed.task, "IMPLEMENTING").outcome?.reason).toBe("INVALID_TRANSITION");
  });

  it("expires a paused task when the trusted clock advances", () => {
    const paused = runTaskEvent(waitingEditTask(), { kind: "MODE_CHANGE", mode: "Ask" }, 1_000);
    const expired = runTaskEvent(paused.task, { kind: "TICK" }, 900_000);
    expect(expired.status).toBe("BUDGET_EXHAUSTED");
    expect(expired.task.state).toBe("FAILED");
    expect(expired.task.outcome).toMatchObject({
      reason: "BUDGET_EXHAUSTED",
      evidence: { resource: "TASK_TIME", limit: 900, observed: 900, attempted: 900 },
    });
  });

  it("distinguishes a recoverable policy denial from a blocked task", () => {
    const denied = runTaskEvent(
      answeringTask(),
      { kind: "POLICY_DENIAL", authorizedRouteRemains: true },
      1_000,
    );
    expect(denied.status).toBe("ACTION_REJECTED");
    expect(denied.task.state).toBe("ANSWERING");
    expect(denied.task.usage.agentSteps).toBe(1);

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
    expect(cancelled.task.usage.agentSteps).toBe(0);
    expect(cancelled.task.outcome?.reason).toBe("CANCELLED_BY_DEVELOPER");
    expect(
      runTaskEvent(cancelled.task, { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, 2_000),
    ).toMatchObject({
      status: "ALREADY_TERMINAL",
      task: cancelled.task,
      oldState: "CANCELLED",
      newState: "CANCELLED",
      usage: { agentSteps: 0, retries: 0 },
    });
  });

  it("fails an illegal trusted transition after charging its cycle", () => {
    const failed = runTaskEvent(
      answeringTask(),
      { kind: "TRUSTED_TRANSITION", target: "IMPLEMENTING" },
      1_000,
    );
    expect(failed.task.state).toBe("FAILED");
    expect(failed.task.outcome?.reason).toBe("INVALID_TRANSITION");
    expect(failed.task.usage.agentSteps).toBe(1);
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

  it("requires fresh verification after a review retry or Edit resume", () => {
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

    const paused = runTaskEvent(passed.task, { kind: "MODE_CHANGE", mode: "Ask" }, 1_000);
    const resumed = runTaskEvent(paused.task, { kind: "MODE_CHANGE", mode: "Edit" }, 1_000);
    expect(resumed.task.state).toBe("INSPECTING");
    expect(resumed.task.verification).toBe("NOT_RUN");
  });

  it("reports failed required verification when no retry is allowed", () => {
    const failed = runTaskEvent(
      verifyingEditTask(0),
      { kind: "VERIFICATION_RESULT", passed: false },
      1_000,
    );
    expect(failed.task.state).toBe("FAILED");
    expect(failed.task.outcome).toMatchObject({
      reason: "VERIFICATION_FAILED",
      verification: "FAILED",
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
    expect(result.task.usage.agentSteps).toBe(1);
    expect(result.task.outcome).toMatchObject({
      reason: "NO_CHANGE_NEEDED",
      verification: "NOT_RUN",
    });
  });

  it("stops before a fourth retry while charging the attempted cycle", () => {
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
    expect(exhausted.task.usage.agentSteps).toBe(task.usage.agentSteps + 1);
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
    expect(forged.task.usage.agentSteps).toBe(1);

    const extra = runModelProposal(
      answeringTask(),
      { action: "COMPLETE", budget: { maxAgentSteps: 1_000 } },
      1_000,
    );
    expect(extra.status).toBe("ACTION_REJECTED");
    expect(extra.task.state).toBe("ANSWERING");
    expect(extra.task.budget?.maxAgentSteps).toBe(30);

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
    expect(attempted.task).toBe(initial);
    expect(attempted.task.usage.agentSteps).toBe(0);
  });

  it("returns bounded refusal reasons and transition metadata", () => {
    const initial = answeringTask();
    const rejected = runModelProposal(initial, { action: "PLAN" }, 1_000);
    expect(rejected).toMatchObject({
      status: "ACTION_REJECTED",
      oldState: "ANSWERING",
      newState: "ANSWERING",
      usage: { agentSteps: 1, retries: 0 },
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
      usage: { agentSteps: 1, retries: 0 },
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
    expect(planned.task.usage.agentSteps).toBe(1);
    expect(planned.task.changed).toBe(false);
    expect(planned.task.outcome).toBeNull();
  });
});
