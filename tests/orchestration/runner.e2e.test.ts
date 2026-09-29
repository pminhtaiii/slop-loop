import { describe, expect, it } from "vitest";

import { runTaskScript, TaskCheckoutSlot, TaskRunner } from "../../src/orchestration/runner.js";
import { admitTask, createTask } from "../../src/orchestration/task.js";
import { advanceTask } from "../../src/orchestration/transitions.js";
import { ToolGateway } from "../../src/tools/gateway.js";

function readyToRead(task: ReturnType<typeof createTask>) {
  return advanceTask(advanceTask(task, "INSPECTING"), "ANSWERING");
}

function readyToWrite(task: ReturnType<typeof createTask>) {
  return advanceTask(
    advanceTask(
      advanceTask(advanceTask(task, "INSPECTING"), "PLANNING"),
      "WAITING_FOR_FILE_PERMISSION",
    ),
    "IMPLEMENTING",
  );
}

describe("scripted task lifecycle", () => {
  it("completes an Ask task through admission, inspection and answering", () => {
    const initial = admitTask(
      createTask({ taskId: "ask-e2e", objective: "Explain the build", mode: "Ask" }),
      0,
    );
    const result = runTaskScript(initial, [
      { event: { kind: "TRUSTED_TRANSITION", target: "INSPECTING" }, now: 1_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "ANSWERING" }, now: 2_000 },
      { event: { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, now: 3_000 },
    ]);
    expect(result.results.map((item) => item.task.state)).toEqual([
      "INSPECTING",
      "ANSWERING",
      "COMPLETED",
    ]);
    expect(result.task.outcome?.reason).toBe("ANSWERED");
    expect(result.task.usage).toMatchObject({ modelTurns: 1, toolAttempts: 0 });
  });

  it("completes Edit only after permission stage, sandbox stage and verification", () => {
    const initial = admitTask(
      createTask({ taskId: "edit-e2e", objective: "Fix the build", mode: "Edit" }),
      0,
    );
    const result = runTaskScript(initial, [
      { event: { kind: "TRUSTED_TRANSITION", target: "INSPECTING" }, now: 1_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "PLANNING" }, now: 2_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "WAITING_FOR_FILE_PERMISSION" }, now: 3_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "IMPLEMENTING" }, now: 4_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "SANDBOX_READY" }, now: 5_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "VERIFYING" }, now: 6_000 },
      { event: { kind: "VERIFICATION_RESULT", passed: true }, now: 7_000 },
      { event: { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, now: 8_000 },
    ]);
    expect(result.results.map((item) => item.task.state)).toEqual([
      "INSPECTING",
      "PLANNING",
      "WAITING_FOR_FILE_PERMISSION",
      "IMPLEMENTING",
      "SANDBOX_READY",
      "VERIFYING",
      "REVIEWING",
      "COMPLETED",
    ]);
    expect(result.task.outcome).toMatchObject({ reason: "EDIT_VERIFIED", verification: "PASSED" });
  });

  it("ends a no-change Edit during inspection without invented verification", () => {
    const initial = admitTask(
      createTask({ taskId: "no-change-e2e", objective: "Fix if needed", mode: "Edit" }),
      0,
    );
    const result = runTaskScript(initial, [
      { event: { kind: "TRUSTED_TRANSITION", target: "INSPECTING" }, now: 1_000 },
      { event: { kind: "NO_CHANGE" }, now: 2_000 },
    ]);
    expect(result.task.state).toBe("COMPLETED");
    expect(result.task.outcome).toMatchObject({
      reason: "NO_CHANGE_NEEDED",
      verification: "NOT_RUN",
    });
    expect(result.results.map((item) => item.task.state)).toEqual(["INSPECTING", "COMPLETED"]);
  });

  it("keeps Edit mode through a rejected switch and follows the permission path", () => {
    const initial = admitTask(
      createTask({ taskId: "pause-e2e", objective: "Fix the build", mode: "Edit" }),
      0,
    );
    const result = runTaskScript(initial, [
      { event: { kind: "TRUSTED_TRANSITION", target: "INSPECTING" }, now: 1_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "PLANNING" }, now: 2_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "WAITING_FOR_FILE_PERMISSION" }, now: 3_000 },
      { event: { kind: "MODE_CHANGE", mode: "Ask" }, now: 4_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "IMPLEMENTING" }, now: 8_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "SANDBOX_READY" }, now: 9_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "VERIFYING" }, now: 10_000 },
      { event: { kind: "VERIFICATION_RESULT", passed: true }, now: 11_000 },
      { event: { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, now: 12_000 },
    ]);
    expect(result.results.map((item) => item.task.state).slice(3, 5)).toEqual([
      "WAITING_FOR_FILE_PERMISSION",
      "IMPLEMENTING",
    ]);
    expect(result.task.state).toBe("COMPLETED");
    expect(result.task.mode).toBe("Edit");
  });

  it("terminates a repeated invalid proposal loop at the Large turn cap", () => {
    const initial = admitTask(
      createTask({ taskId: "exhaust-e2e", objective: "Explain the build", mode: "Ask" }),
      0,
      "Large",
    );
    const result = runTaskScript(initial, [
      { event: { kind: "TRUSTED_TRANSITION", target: "INSPECTING" }, now: 1_000 },
      { event: { kind: "TRUSTED_TRANSITION", target: "ANSWERING" }, now: 2_000 },
      ...Array.from({ length: 121 }, () => ({
        event: { kind: "MODEL_PROPOSAL" as const, action: "PLAN" as const },
        now: 3_000,
      })),
    ]);
    expect(result.task.state).toBe("FAILED");
    expect(result.task.usage.modelTurns).toBe(120);
    expect(result.task.outcome).toMatchObject({
      reason: "BUDGET_EXHAUSTED",
      evidence: { resource: "MODEL_TURNS", observed: 120, attempted: 121 },
      handoff: { objective: "Explain the build", exhaustedBudget: "MODEL_TURNS" },
    });
    expect(result.results.length).toBe(123);
  });

  it("ignores later scripted work after developer stop", () => {
    const initial = admitTask(
      createTask({ taskId: "stop-e2e", objective: "Explain the build", mode: "Ask" }),
      0,
    );
    const result = runTaskScript(initial, [
      { event: { kind: "TRUSTED_TRANSITION", target: "INSPECTING" }, now: 1_000 },
      { event: { kind: "CANCEL" }, now: 2_000 },
      { event: { kind: "MODEL_PROPOSAL", action: "COMPLETE" }, now: 3_000 },
    ]);
    expect(result.task.state).toBe("CANCELLED");
    expect(result.task.usage.modelTurns).toBe(0);
    expect(result.results).toHaveLength(2);
  });

  it("dispatches calls serially and discards a response tail after its first denial", () => {
    const initial = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-denial-e2e", objective: "Read source", mode: "Ask" }),
        0,
        "Small",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["read_file"] },
      ),
    );
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: "workspace-1",
          operation: "read" as const,
          canonicalPath: "src/index.ts",
          status: "ALLOWED" as const,
        }),
      },
      grants: { grantFor: () => undefined },
      executors: { read_file: { execute: () => (executions += 1) } },
    });
    const runner = new TaskRunner(initial, new TaskCheckoutSlot());

    const results = runner.dispatchProposals(
      gateway,
      [
        { name: "shell", arguments: {} },
        { name: "read_file", arguments: { path: "src/index.ts" } },
      ],
      1_000,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "DENY", reason: "UNKNOWN_TOOL" });
    expect(runner.task.usage.toolAttempts).toBe(1);
    expect(executions).toBe(0);
  });

  it("charges one received call when runner dispatch reaches an allowed executor", () => {
    const initial = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-allow-e2e", objective: "Read source", mode: "Ask" }),
        0,
        "Small",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["read_file"] },
      ),
    );
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: "workspace-1",
          operation: "read" as const,
          canonicalPath: "src/index.ts",
          status: "ALLOWED" as const,
        }),
      },
      grants: { grantFor: () => undefined },
      executors: { read_file: { execute: () => (executions += 1) } },
    });
    const runner = new TaskRunner(initial, new TaskCheckoutSlot());

    const results = runner.dispatchProposals(
      gateway,
      [{ name: "read_file", arguments: { path: "src/index.ts" } }],
      1_000,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "EXECUTED" });
    expect(runner.task.usage.toolAttempts).toBe(1);
    expect(executions).toBe(1);
  });

  it("discards a response tail when an eligible mutation needs file permission", () => {
    const initial = readyToWrite(
      admitTask(
        createTask({ taskId: "gateway-permission-e2e", objective: "Patch source", mode: "Edit" }),
        0,
        "Small",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["apply_patch"] },
      ),
    );
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: "workspace-1",
          operation: "update" as const,
          canonicalPath: "src/index.ts",
          status: "ALLOWED" as const,
        }),
      },
      grants: { grantFor: () => undefined },
      executors: { apply_patch: { execute: () => (executions += 1) } },
    });
    const runner = new TaskRunner(initial, new TaskCheckoutSlot());

    const results = runner.dispatchProposals(
      gateway,
      [
        { name: "apply_patch", arguments: { patch: "patch" } },
        { name: "apply_patch", arguments: { patch: "second patch" } },
      ],
      1_000,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "NEEDS_FILE_PERMISSION" });
    expect(runner.task.usage.toolAttempts).toBe(1);
    expect(executions).toBe(0);
  });

  it("terminates with POLICY_FAILURE and stops the response after a trusted-fact failure", () => {
    const initial = readyToRead(
      admitTask(
        createTask({
          taskId: "gateway-policy-failure-e2e",
          objective: "Read source",
          mode: "Ask",
        }),
        0,
        "Small",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["read_file"] },
      ),
    );
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => {
          throw new Error("workspace unavailable");
        },
      },
      grants: { grantFor: () => undefined },
      executors: { read_file: { execute: () => (executions += 1) } },
    });
    const slot = new TaskCheckoutSlot();
    const runner = new TaskRunner(initial, slot);

    const results = runner.dispatchProposals(
      gateway,
      [
        { name: "read_file", arguments: { path: "src/index.ts" } },
        { name: "read_file", arguments: { path: "src/other.ts" } },
      ],
      1_000,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "FAILED", reason: "POLICY_FAILURE" });
    expect(runner.task.outcome).toMatchObject({ state: "FAILED", reason: "POLICY_FAILURE" });
    expect(slot.heldBy).toBeNull();
    expect(executions).toBe(0);
  });
});
