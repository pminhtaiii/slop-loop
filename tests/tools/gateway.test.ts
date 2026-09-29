import { describe, expect, it } from "vitest";

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

function readyToVerify(task: ReturnType<typeof createTask>) {
  return advanceTask(advanceTask(readyToWrite(task), "SANDBOX_READY"), "VERIFYING");
}

describe("ToolGateway", () => {
  it("denies an admitted task before any executor can start", () => {
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
    const task = admitTask(
      createTask({ taskId: "gateway-admitted", objective: "Read source", mode: "Ask" }),
      0,
      "Medium",
      { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["read_file"] },
    );

    expect(
      gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).toMatchObject({
      kind: "DENY",
      reason: "TASK_STATE_NOT_ELIGIBLE",
    });
    expect(executions).toBe(0);
  });

  it("executes an explicitly allowed call exactly once", () => {
    const received: unknown[] = [];
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
      executors: {
        read_file: {
          execute: (call: unknown) => {
            received.push(call);
            return { text: "source" };
          },
        },
      },
    });
    const task = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-allow", objective: "Read source", mode: "Ask" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["read_file"] },
      ),
    );

    const result = gateway.invoke(
      task,
      { name: "read_file", arguments: { path: "src/index.ts" } },
      0,
    );

    expect(result).toMatchObject({ kind: "EXECUTED", result: { text: "source" } });
    expect(received).toEqual([{ name: "read_file", arguments: { path: "src/index.ts" } }]);
  });

  it("reports an executor exception separately from policy failure", () => {
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
      executors: {
        read_file: {
          execute: () => {
            throw new Error("executor failed");
          },
        },
      },
    });
    const task = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-executor-failure", objective: "Read source", mode: "Ask" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["read_file"] },
      ),
    );

    expect(
      gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).toMatchObject({ kind: "FAILED", reason: "EXECUTION_FAILURE" });
  });

  it("revalidates malformed and unknown calls before asking ports or invoking an executor", () => {
    let factRequests = 0;
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => {
          factRequests += 1;
          return undefined;
        },
      },
      grants: { grantFor: () => undefined },
      executors: { read_file: { execute: () => (executions += 1) } },
    });
    const task = admitTask(
      createTask({ taskId: "gateway-revalidation", objective: "Read source", mode: "Ask" }),
      0,
      "Medium",
      { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["read_file"] },
    );

    expect(gateway.invoke(task, { name: "shell", arguments: {} }, 0)).toMatchObject({
      kind: "DENY",
      reason: "UNKNOWN_TOOL",
    });
    expect(gateway.invoke(task, { name: "read_file", arguments: {} }, 1)).toMatchObject({
      kind: "DENY",
      reason: "INVALID_ARGUMENTS",
    });
    expect(factRequests).toBe(0);
    expect(executions).toBe(0);
  });

  it("fails closed when a trusted authority provider is unavailable", () => {
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
    const task = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-fact-failure", objective: "Read source", mode: "Ask" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["read_file"] },
      ),
    );

    expect(
      gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).toMatchObject({
      kind: "FAILED",
      reason: "POLICY_FAILURE",
    });
    expect(executions).toBe(0);
  });

  it("fails closed when a provider returns malformed trusted path facts", () => {
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: "workspace-1",
          operation: "read" as const,
          canonicalPath: "",
          status: "ALLOWED" as const,
        }),
      },
      grants: { grantFor: () => undefined },
      executors: { read_file: { execute: () => (executions += 1) } },
    });
    const task = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-malformed-facts", objective: "Read source", mode: "Ask" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["read_file"] },
      ),
    );

    expect(
      gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).toMatchObject({
      kind: "FAILED",
      reason: "POLICY_FAILURE",
    });
    expect(executions).toBe(0);
  });

  it("fails closed when a provider returns an unrecognized trusted path status", () => {
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: "workspace-1",
          operation: "read" as const,
          canonicalPath: "src/index.ts",
          status: "UNKNOWN" as never,
        }),
      },
      grants: { grantFor: () => undefined },
      executors: { read_file: { execute: () => (executions += 1) } },
    });
    const task = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-invalid-status", objective: "Read source", mode: "Ask" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["read_file"] },
      ),
    );

    expect(
      gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).toMatchObject({ kind: "FAILED", reason: "POLICY_FAILURE" });
    expect(executions).toBe(0);
  });

  it("does not execute a mutation unavailable in Ask mode or a call missing its capability", () => {
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
      grants: {
        grantFor: () => ({
          sessionId: "session-1",
          workspaceId: "workspace-1",
          canonicalPath: "src/index.ts",
          operation: "update" as const,
          status: "GRANTED" as const,
        }),
      },
      executors: {
        apply_patch: { execute: () => (executions += 1) },
        read_file: { execute: () => (executions += 1) },
      },
    });
    const askTask = admitTask(
      createTask({ taskId: "gateway-wrong-mode", objective: "Read source", mode: "Ask" }),
      0,
      "Medium",
      { sessionId: "session-1", workspaceId: "workspace-1" },
    );
    const missingCapabilityTask = admitTask(
      createTask({ taskId: "gateway-missing-capability", objective: "Read source", mode: "Ask" }),
      0,
      "Medium",
      {
        sessionId: "session-1",
        workspaceId: "workspace-1",
        eligibleTools: ["read_file"],
        capabilities: [],
      },
    );

    expect(
      gateway.invoke(askTask, { name: "apply_patch", arguments: { patch: "patch" } }, 0),
    ).toMatchObject({
      kind: "DENY",
      reason: "TOOL_NOT_ELIGIBLE",
    });
    expect(
      gateway.invoke(
        missingCapabilityTask,
        { name: "read_file", arguments: { path: "src/index.ts" } },
        1,
      ),
    ).toMatchObject({ kind: "DENY", reason: "CAPABILITY_MISSING" });
    expect(executions).toBe(0);
  });

  it("uses a fresh trusted profile approval for verification execution", () => {
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: { factsFor: () => undefined },
      grants: { grantFor: () => undefined },
      execution: {
        factsFor: () => ({ approvedProfiles: ["unit"], executorReady: true }),
      },
      executors: { run_tests: { execute: () => (executions += 1) } },
    });
    const task = readyToVerify(
      admitTask(
        createTask({ taskId: "gateway-profile", objective: "Verify source", mode: "Edit" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["run_tests"] },
      ),
    );

    expect(
      gateway.invoke(task, { name: "run_tests", arguments: { profile: "other" } }, 0),
    ).toMatchObject({ kind: "DENY", reason: "PROFILE_NOT_APPROVED" });
    expect(
      gateway.invoke(task, { name: "run_tests", arguments: { profile: "unit" } }, 1),
    ).toMatchObject({ kind: "EXECUTED" });
    expect(executions).toBe(1);
  });

  it("uses fresh path facts before every executor invocation", () => {
    let factRequests = 0;
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => {
          factRequests += 1;
          return {
            workspaceId: "workspace-1",
            operation: "read" as const,
            canonicalPath: "src/index.ts",
            status: factRequests === 1 ? ("ALLOWED" as const) : ("FORBIDDEN" as const),
          };
        },
      },
      grants: { grantFor: () => undefined },
      executors: { read_file: { execute: () => (executions += 1) } },
    });
    const task = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-fresh-path", objective: "Read source", mode: "Ask" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["read_file"] },
      ),
    );

    expect(
      gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0).kind,
    ).toBe("EXECUTED");
    expect(
      gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 1),
    ).toMatchObject({
      kind: "DENY",
      reason: "FORBIDDEN_PATH",
    });
    expect(factRequests).toBe(2);
    expect(executions).toBe(1);
  });

  it("requires a current grant for every path in a workspace mutation", () => {
    let executions = 0;
    let receivedPaths: readonly unknown[] = [];
    let grantForNewPath = false;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => [
          {
            workspaceId: "workspace-1",
            operation: "update" as const,
            canonicalPath: "src/index.ts",
            status: "ALLOWED" as const,
          },
          {
            workspaceId: "workspace-1",
            operation: "create" as const,
            canonicalPath: "src/new.ts",
            status: "ALLOWED" as const,
          },
        ],
      },
      grants: {
        grantFor: (path) =>
          path.operation !== "read" && (path.canonicalPath === "src/index.ts" || grantForNewPath)
            ? {
                sessionId: "session-1",
                workspaceId: "workspace-1",
                canonicalPath: path.canonicalPath,
                operation: path.operation,
                status: "GRANTED" as const,
              }
            : undefined,
      },
      executors: {
        apply_patch: {
          execute: (_call, authority) => {
            executions += 1;
            receivedPaths = authority.paths;
          },
        },
      },
    });
    const task = readyToWrite(
      admitTask(
        createTask({ taskId: "gateway-multiple-paths", objective: "Patch source", mode: "Edit" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["apply_patch"] },
      ),
    );

    expect(
      gateway.invoke(task, { name: "apply_patch", arguments: { patch: "patch" } }, 0),
    ).toMatchObject({ kind: "NEEDS_FILE_PERMISSION", reason: "MISSING_FILE_GRANT" });
    expect(executions).toBe(0);
    expect(receivedPaths).toEqual([]);

    grantForNewPath = true;
    expect(
      gateway.invoke(task, { name: "apply_patch", arguments: { patch: "patch" } }, 1),
    ).toMatchObject({ kind: "EXECUTED" });
    expect(executions).toBe(1);
    expect(receivedPaths).toEqual([
      expect.objectContaining({ canonicalPath: "src/index.ts", operation: "update" }),
      expect.objectContaining({ canonicalPath: "src/new.ts", operation: "create" }),
    ]);
  });

  it("rechecks a current exact grant and blocks a later invalidated grant", () => {
    let grantRequests = 0;
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
      grants: {
        grantFor: () => {
          grantRequests += 1;
          return {
            sessionId: "session-1",
            workspaceId: "workspace-1",
            canonicalPath: "src/index.ts",
            operation: "update" as const,
            status: grantRequests === 1 ? ("GRANTED" as const) : ("INVALIDATED" as const),
          };
        },
      },
      executors: { apply_patch: { execute: () => (executions += 1) } },
    });
    const task = readyToWrite(
      admitTask(
        createTask({ taskId: "gateway-fresh-grant", objective: "Patch source", mode: "Edit" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: "workspace-1", eligibleTools: ["apply_patch"] },
      ),
    );

    expect(
      gateway.invoke(task, { name: "apply_patch", arguments: { patch: "patch" } }, 0).kind,
    ).toBe("EXECUTED");
    expect(
      gateway.invoke(task, { name: "apply_patch", arguments: { patch: "patch" } }, 1),
    ).toMatchObject({
      kind: "DENY",
      reason: "GRANT_INVALIDATED",
    });
    expect(grantRequests).toBe(2);
    expect(executions).toBe(1);
  });
});
