import { describe, expect, it } from "vitest";

import { createTask } from "../../src/orchestration/task.js";
import { admitTask, TEST_WORKSPACE_ID } from "../support/admission.js";
import { advanceTask } from "../../src/orchestration/transitions.js";
import { ToolGateway } from "../../src/tools/gateway.js";
import type { ToolExecutor } from "../../src/tools/gateway.js";

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
  it("records a possible effect when an executor fails after execution started", async () => {
    const events: { readonly kind: string; readonly effect: string }[] = [];
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
          operation: "read" as const,
          canonicalPath: "src/index.ts",
          status: "ALLOWED" as const,
        }),
      },
      grants: { grantFor: () => undefined },
      audit: {
        appendIfAbsent: (event) => {
          events.push(event);
          return Promise.resolve({ status: "COMMITTED" as const, eventId: event.eventId });
        },
      },
      executors: {
        read_file: {
          execute: () => {
            throw new Error("effect may have occurred");
          },
        },
      },
    });
    const task = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-possible-effect", objective: "Read source", mode: "Ask" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );

    await expect(
      gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).resolves.toMatchObject({ kind: "FAILED", reason: "EXECUTION_FAILURE", effect: "POSSIBLE" });
    expect(events).toContainEqual(expect.objectContaining({ kind: "RESULT", effect: "POSSIBLE" }));
  });

  it("blocks execution when pre-evidence rejects a duplicate ID, fails, or acknowledges a different event", async () => {
    for (const audit of [
      { appendIfAbsent: () => Promise.reject(new Error("sink offline")) },
      { appendIfAbsent: () => Promise.resolve({ status: "INTEGRITY_FAILURE" as const }) },
      { appendIfAbsent: () => Promise.resolve({ status: "COMMITTED" as const, eventId: "wrong" }) },
    ]) {
      let executions = 0;
      const gateway = new ToolGateway({
        workspace: {
          factsFor: () => ({
            workspaceId: TEST_WORKSPACE_ID,
            operation: "read" as const,
            canonicalPath: "src/index.ts",
            status: "ALLOWED" as const,
          }),
        },
        grants: { grantFor: () => undefined },
        audit,
        executors: { read_file: { execute: () => (executions += 1) } },
      });
      const task = readyToRead(
        admitTask(
          createTask({
            taskId: "gateway-pre-audit-integrity",
            objective: "Read source",
            mode: "Ask",
          }),
          0,
          "Medium",
          { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
        ),
      );

      await expect(
        gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
      ).resolves.toMatchObject({ kind: "BLOCKED", reason: "AUDIT_UNAVAILABLE" });
      expect(executions).toBe(0);
    }
  });

  it("blocks an allowed read before execution when pre-evidence is unavailable", async () => {
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
          operation: "read" as const,
          canonicalPath: "src/index.ts",
          status: "ALLOWED" as const,
        }),
      },
      grants: { grantFor: () => undefined },
      audit: { appendIfAbsent: () => Promise.resolve({ status: "UNAVAILABLE" as const }) },
      executors: { read_file: { execute: () => (executions += 1) } },
    });
    const task = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-audit-outage", objective: "Read source", mode: "Ask" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );

    const result = await gateway.invoke(
      task,
      { name: "read_file", arguments: { path: "src/index.ts" } },
      0,
    );
    expect(result).toMatchObject({ kind: "BLOCKED", reason: "AUDIT_UNAVAILABLE" });
    expect(executions).toBe(0);
  });

  it("fences executor start when cancellation wins during a pending pre-append", async () => {
    let executions = 0;
    let releaseAppend: ((result: { status: "COMMITTED"; eventId: string }) => void) | undefined;
    let announceAppend: (() => void) | undefined;
    const appendStarted = new Promise<void>((resolve) => {
      announceAppend = resolve;
    });
    const controller = new AbortController();
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
          operation: "read" as const,
          canonicalPath: "src/index.ts",
          status: "ALLOWED" as const,
        }),
      },
      grants: { grantFor: () => undefined },
      audit: {
        appendIfAbsent: (event) =>
          new Promise((resolve) => {
            announceAppend?.();
            releaseAppend = () => resolve({ status: "COMMITTED", eventId: event.eventId });
          }),
      },
      executors: { read_file: { execute: () => (executions += 1) } },
    });
    const task = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-cancel-fence", objective: "Read source", mode: "Ask" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );
    const invocation = gateway.invoke(
      task,
      { name: "read_file", arguments: { path: "src/index.ts" } },
      0,
      { signal: controller.signal, canStart: () => false },
    );
    await appendStarted;
    controller.abort();
    releaseAppend?.({ status: "COMMITTED", eventId: "ignored" });

    await expect(invocation).resolves.toMatchObject({ kind: "CANCELLED" });
    expect(executions).toBe(0);
  });

  it("retries a result append with the same event ID without replaying an effect", async () => {
    let executions = 0;
    const events: string[] = [];
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
          operation: "read" as const,
          canonicalPath: "src/index.ts",
          status: "ALLOWED" as const,
        }),
      },
      grants: { grantFor: () => undefined },
      audit: {
        appendIfAbsent: (event) => {
          events.push(event.eventId);
          return Promise.resolve(
            event.kind === "REQUEST_DECISION"
              ? { status: "COMMITTED" as const, eventId: event.eventId }
              : { status: "UNAVAILABLE" as const },
          );
        },
      },
      executors: { read_file: { execute: () => ({ text: `run-${++executions}` }) } },
    });
    const task = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-result-retry", objective: "Read source", mode: "Ask" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );

    await expect(
      gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).resolves.toMatchObject({ kind: "BLOCKED", reason: "AUDIT_INCOMPLETE", effect: "COMPLETED" });
    expect(executions).toBe(1);
    expect(new Set(events.filter((event) => event.endsWith(":RESULT"))).size).toBe(1);
    expect(events.filter((event) => event.endsWith(":RESULT"))).toHaveLength(3);
  });

  it("reuses an identical result event after a committed-but-unacknowledged append", async () => {
    let executions = 0;
    const resultPayloads = new Map<string, string>();
    let resultAttempts = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
          operation: "read" as const,
          canonicalPath: "src/index.ts",
          status: "ALLOWED" as const,
        }),
      },
      grants: { grantFor: () => undefined },
      audit: {
        appendIfAbsent: (event) => {
          if (event.kind === "REQUEST_DECISION")
            return Promise.resolve({ status: "COMMITTED" as const, eventId: event.eventId });
          resultAttempts += 1;
          const payload = JSON.stringify(event);
          const prior = resultPayloads.get(event.eventId);
          if (prior !== undefined && prior !== payload)
            return Promise.resolve({ status: "INTEGRITY_FAILURE" as const });
          resultPayloads.set(event.eventId, payload);
          return resultAttempts === 1
            ? Promise.reject(new Error("ack lost after commit"))
            : Promise.resolve({ status: "COMMITTED" as const, eventId: event.eventId });
        },
      },
      executors: { read_file: { execute: () => ({ text: `run-${++executions}` }) } },
    });
    const task = readyToRead(
      admitTask(
        createTask({
          taskId: "gateway-committed-unacknowledged",
          objective: "Read source",
          mode: "Ask",
        }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );

    await expect(
      gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).resolves.toMatchObject({ kind: "EXECUTED", result: { text: "run-1" } });
    expect(executions).toBe(1);
    expect(resultAttempts).toBe(2);
    expect(resultPayloads).toHaveLength(1);
  });

  it("rejects a result whose redaction expands past the output bound", async () => {
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
          operation: "read" as const,
          canonicalPath: "src/index.ts",
          status: "ALLOWED" as const,
        }),
      },
      grants: { grantFor: () => undefined },
      executors: { read_file: { execute: () => "token=a ".repeat(4_000) } },
    });
    const task = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-redaction-bound", objective: "Read source", mode: "Ask" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );

    await expect(
      gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).resolves.toMatchObject({ kind: "TOOL_CONTRACT_FAILURE", effect: "COMPLETED" });
  });

  it("reports contract failure after an oversized effect without exposing its output", async () => {
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
          operation: "read" as const,
          canonicalPath: "src/index.ts",
          status: "ALLOWED" as const,
        }),
      },
      grants: { grantFor: () => undefined },
      executors: { read_file: { execute: () => "x".repeat(32_769) } },
    });
    const task = readyToRead(
      admitTask(
        createTask({ taskId: "gateway-oversize", objective: "Read source", mode: "Ask" }),
        0,
        "Medium",
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );

    await expect(
      gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).resolves.toMatchObject({ kind: "TOOL_CONTRACT_FAILURE", effect: "COMPLETED" });
  });

  it("denies an admitted task before any executor can start", async () => {
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
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
      { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
    );

    expect(
      await gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).toMatchObject({
      kind: "DENY",
      reason: "TASK_STATE_NOT_ELIGIBLE",
    });
    expect(executions).toBe(0);
  });

  it("executes an explicitly allowed call exactly once", async () => {
    const received: unknown[] = [];
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
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
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );

    const result = await gateway.invoke(
      task,
      { name: "read_file", arguments: { path: "src/index.ts" } },
      0,
    );

    expect(result).toMatchObject({ kind: "EXECUTED", result: { text: "source" } });
    expect(received).toEqual([{ name: "read_file", arguments: { path: "src/index.ts" } }]);
  });

  it("reports an executor exception separately from policy failure", async () => {
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
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
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );

    expect(
      await gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).toMatchObject({ kind: "FAILED", reason: "EXECUTION_FAILURE" });
  });

  it("accepts an abortable asynchronous executor", async () => {
    const executor: ToolExecutor = {
      execute: () => Promise.resolve({ text: "source" }),
    };

    await expect(
      executor.execute(
        { name: "read_file", arguments: { path: "x" } },
        { paths: [], signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ text: "source" });
  });

  it("revalidates malformed and unknown calls before asking ports or invoking an executor", async () => {
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
      { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
    );

    expect(await gateway.invoke(task, { name: "shell", arguments: {} }, 0)).toMatchObject({
      kind: "DENY",
      reason: "UNKNOWN_TOOL",
    });
    expect(await gateway.invoke(task, { name: "read_file", arguments: {} }, 1)).toMatchObject({
      kind: "DENY",
      reason: "INVALID_ARGUMENTS",
    });
    expect(factRequests).toBe(0);
    expect(executions).toBe(0);
  });

  it("fails closed when a trusted authority provider is unavailable", async () => {
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
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );

    expect(
      await gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).toMatchObject({
      kind: "FAILED",
      reason: "POLICY_FAILURE",
    });
    expect(executions).toBe(0);
  });

  it("fails closed when a provider returns malformed trusted path facts", async () => {
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
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
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );

    expect(
      await gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).toMatchObject({
      kind: "FAILED",
      reason: "POLICY_FAILURE",
    });
    expect(executions).toBe(0);
  });

  it("fails closed when a provider returns an unrecognized trusted path status", async () => {
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
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
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );

    expect(
      await gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0),
    ).toMatchObject({ kind: "FAILED", reason: "POLICY_FAILURE" });
    expect(executions).toBe(0);
  });

  it("does not execute a mutation unavailable in Ask mode or a call missing its capability", async () => {
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
          operation: "update" as const,
          canonicalPath: "src/index.ts",
          status: "ALLOWED" as const,
        }),
      },
      grants: {
        grantFor: () => ({
          sessionId: "session-1",
          workspaceId: TEST_WORKSPACE_ID,
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
      { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID },
    );
    const missingCapabilityTask = admitTask(
      createTask({ taskId: "gateway-missing-capability", objective: "Read source", mode: "Ask" }),
      0,
      "Medium",
      {
        sessionId: "session-1",
        workspaceId: TEST_WORKSPACE_ID,
        eligibleTools: ["read_file"],
        capabilities: [],
      },
    );

    expect(
      await gateway.invoke(askTask, { name: "apply_patch", arguments: { patch: "patch" } }, 0),
    ).toMatchObject({
      kind: "DENY",
      reason: "TOOL_NOT_ELIGIBLE",
    });
    expect(
      await gateway.invoke(
        missingCapabilityTask,
        { name: "read_file", arguments: { path: "src/index.ts" } },
        1,
      ),
    ).toMatchObject({ kind: "DENY", reason: "CAPABILITY_MISSING" });
    expect(executions).toBe(0);
  });

  it("uses a fresh trusted profile approval for verification execution", async () => {
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
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["run_tests"] },
      ),
    );

    expect(
      await gateway.invoke(task, { name: "run_tests", arguments: { profile: "other" } }, 0),
    ).toMatchObject({ kind: "DENY", reason: "PROFILE_NOT_APPROVED" });
    expect(
      await gateway.invoke(task, { name: "run_tests", arguments: { profile: "unit" } }, 1),
    ).toMatchObject({ kind: "EXECUTED" });
    expect(executions).toBe(1);
  });

  it("uses fresh path facts before every executor invocation", async () => {
    let factRequests = 0;
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => {
          factRequests += 1;
          return {
            workspaceId: TEST_WORKSPACE_ID,
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
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["read_file"] },
      ),
    );

    expect(
      (await gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 0))
        .kind,
    ).toBe("EXECUTED");
    expect(
      await gateway.invoke(task, { name: "read_file", arguments: { path: "src/index.ts" } }, 1),
    ).toMatchObject({
      kind: "DENY",
      reason: "FORBIDDEN_PATH",
    });
    expect(factRequests).toBe(2);
    expect(executions).toBe(1);
  });

  it("requires a current grant for every path in a workspace mutation", async () => {
    let executions = 0;
    let receivedPaths: readonly unknown[] = [];
    let grantForNewPath = false;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => [
          {
            workspaceId: TEST_WORKSPACE_ID,
            operation: "update" as const,
            canonicalPath: "src/index.ts",
            status: "ALLOWED" as const,
          },
          {
            workspaceId: TEST_WORKSPACE_ID,
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
                workspaceId: TEST_WORKSPACE_ID,
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
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["apply_patch"] },
      ),
    );

    expect(
      await gateway.invoke(task, { name: "apply_patch", arguments: { patch: "patch" } }, 0),
    ).toMatchObject({ kind: "NEEDS_FILE_PERMISSION", reason: "MISSING_FILE_GRANT" });
    expect(executions).toBe(0);
    expect(receivedPaths).toEqual([]);

    grantForNewPath = true;
    expect(
      await gateway.invoke(task, { name: "apply_patch", arguments: { patch: "patch" } }, 1),
    ).toMatchObject({ kind: "EXECUTED" });
    expect(executions).toBe(1);
    expect(receivedPaths).toEqual([
      expect.objectContaining({ canonicalPath: "src/index.ts", operation: "update" }),
      expect.objectContaining({ canonicalPath: "src/new.ts", operation: "create" }),
    ]);
  });

  it("rechecks a current exact grant and blocks a later invalidated grant", async () => {
    let grantRequests = 0;
    let executions = 0;
    const gateway = new ToolGateway({
      workspace: {
        factsFor: () => ({
          workspaceId: TEST_WORKSPACE_ID,
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
            workspaceId: TEST_WORKSPACE_ID,
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
        { sessionId: "session-1", workspaceId: TEST_WORKSPACE_ID, eligibleTools: ["apply_patch"] },
      ),
    );

    expect(
      (await gateway.invoke(task, { name: "apply_patch", arguments: { patch: "patch" } }, 0)).kind,
    ).toBe("EXECUTED");
    expect(
      await gateway.invoke(task, { name: "apply_patch", arguments: { patch: "patch" } }, 1),
    ).toMatchObject({
      kind: "DENY",
      reason: "GRANT_INVALIDATED",
    });
    expect(grantRequests).toBe(2);
    expect(executions).toBe(1);
  });
});
