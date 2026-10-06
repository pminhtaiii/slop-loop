import { describe, expect, it } from "vitest";

import {
  createPolicyDecisionContext,
  createTaskCapabilityCeiling as createCeilingWithResources,
  PolicyEngine,
} from "../../src/policy/engine.js";
import { createTaskBudget } from "../../src/orchestration/budget.js";
import type { TaskCapabilityCeilingInput } from "../../src/policy/engine.js";
import { validateToolCall } from "../../src/tools/registry.js";

function createCeiling(input: Omit<TaskCapabilityCeilingInput, "resources">) {
  return createCeilingWithResources({ ...input, resources: createTaskBudget("Medium") });
}

describe("PolicyEngine", () => {
  it("allows an eligible registered read call within its sealed ceiling", () => {
    const validated = validateToolCall({ name: "read_file", arguments: { path: "src/index.ts" } });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const ceiling = createCeiling({
      taskId: "policy-allow",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      mode: "Ask",
      eligibleTools: ["read_file"],
    });
    const decision = PolicyEngine.evaluate(
      validated.call,
      createPolicyDecisionContext({
        invocationId: "invocation-1",
        taskId: "policy-allow",
        sessionId: "session-1",
        workspaceId: "workspace-1",
        taskState: "ANSWERING",
        ceiling,
        path: {
          workspaceId: "workspace-1",
          operation: "read",
          requestedPath: "src/index.ts",
          canonicalPath: "src/index.ts",
          status: "ALLOWED",
        },
      }),
    );

    expect(decision).toEqual({ kind: "ALLOW", invocationId: "invocation-1" });
  });

  it("maps canonical external readiness facts to a typed blocker", () => {
    const validated = validateToolCall({ name: "run_tests", arguments: { profile: "unit" } });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const ceiling = createCeiling({
      taskId: "policy-readiness",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      mode: "Edit",
      eligibleTools: ["run_tests"],
    });

    expect(
      PolicyEngine.evaluate(
        validated.call,
        createPolicyDecisionContext({
          invocationId: "invocation-readiness",
          taskId: "policy-readiness",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          taskState: "VERIFYING",
          ceiling,
          execution: {
            approvedProfiles: ["unit"],
            executorReady: false,
            readiness: {
              status: "EXTERNAL_BLOCKER",
              reason: "IMAGE_STALE",
            },
          },
        }),
      ),
    ).toEqual({
      kind: "BLOCKED",
      invocationId: "invocation-readiness",
      reason: "IMAGE_STALE",
      effect: "NONE",
    });
  });

  it("denies a call before the lifecycle state admits its metadata-defined effect", () => {
    const validated = validateToolCall({ name: "read_file", arguments: { path: "src/index.ts" } });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const ceiling = createCeiling({
      taskId: "policy-state",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      mode: "Ask",
      eligibleTools: ["read_file"],
    });

    expect(
      PolicyEngine.evaluate(
        validated.call,
        createPolicyDecisionContext({
          invocationId: "invocation-state",
          taskId: "policy-state",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          taskState: "ADMITTED",
          ceiling,
          path: {
            workspaceId: "workspace-1",
            operation: "read",
            requestedPath: "src/index.ts",
            canonicalPath: "src/index.ts",
            status: "ALLOWED",
          },
        }),
      ),
    ).toEqual({
      kind: "DENY",
      invocationId: "invocation-state",
      reason: "TASK_STATE_NOT_ELIGIBLE",
    });
  });

  it("denies an otherwise valid call that is outside the sealed tool ceiling", () => {
    const validated = validateToolCall({ name: "git_diff", arguments: {} });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const ceiling = createCeiling({
      taskId: "policy-deny-tool",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      mode: "Ask",
      eligibleTools: ["read_file"],
    });

    expect(
      PolicyEngine.evaluate(
        validated.call,
        createPolicyDecisionContext({
          invocationId: "invocation-2",
          taskId: "policy-deny-tool",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          taskState: "ANSWERING",
          ceiling,
        }),
      ),
    ).toEqual({ kind: "DENY", invocationId: "invocation-2", reason: "TOOL_NOT_ELIGIBLE" });
  });

  it("denies a ceiling that names a tool but omits its required capability", () => {
    const validated = validateToolCall({ name: "read_file", arguments: { path: "src/index.ts" } });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const ceiling = createCeiling({
      taskId: "policy-deny-capability",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      mode: "Ask",
      eligibleTools: ["read_file"],
      capabilities: [],
    });

    expect(
      PolicyEngine.evaluate(
        validated.call,
        createPolicyDecisionContext({
          invocationId: "invocation-3",
          taskId: "policy-deny-capability",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          taskState: "ANSWERING",
          ceiling,
          path: {
            workspaceId: "workspace-1",
            operation: "read",
            requestedPath: "src/index.ts",
            canonicalPath: "src/index.ts",
            status: "ALLOWED",
          },
        }),
      ),
    ).toEqual({ kind: "DENY", invocationId: "invocation-3", reason: "CAPABILITY_MISSING" });
  });

  it("fails closed when a read requires unavailable trusted path facts", () => {
    const validated = validateToolCall({ name: "read_file", arguments: { path: "src/index.ts" } });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const ceiling = createCeiling({
      taskId: "policy-missing-facts",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      mode: "Ask",
      eligibleTools: ["read_file"],
    });

    expect(() =>
      PolicyEngine.evaluate(
        validated.call,
        createPolicyDecisionContext({
          invocationId: "invocation-4",
          taskId: "policy-missing-facts",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          taskState: "ANSWERING",
          ceiling,
        }),
      ),
    ).toThrow("Required trusted path facts are unavailable");
  });

  it("allows reads without a file grant but denies a path the workspace marks forbidden", () => {
    const validated = validateToolCall({ name: "read_file", arguments: { path: ".env" } });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const ceiling = createCeiling({
      taskId: "policy-forbidden-read",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      mode: "Ask",
      eligibleTools: ["read_file"],
    });

    expect(
      PolicyEngine.evaluate(
        validated.call,
        createPolicyDecisionContext({
          invocationId: "invocation-5",
          taskId: "policy-forbidden-read",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          taskState: "ANSWERING",
          ceiling,
          path: {
            workspaceId: "workspace-1",
            operation: "read",
            requestedPath: ".env",
            canonicalPath: ".env",
            status: "FORBIDDEN",
          },
        }),
      ),
    ).toEqual({ kind: "DENY", invocationId: "invocation-5", reason: "FORBIDDEN_PATH" });
  });

  it("requires an exact current write grant and allows its reuse in the same session", () => {
    const validated = validateToolCall({ name: "apply_patch", arguments: { patch: "patch" } });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const ceiling = createCeiling({
      taskId: "policy-write-grant",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      mode: "Edit",
      eligibleTools: ["apply_patch"],
    });
    const path = {
      workspaceId: "workspace-1",
      operation: "update" as const,
      requestedPath: "src/index.ts",
      canonicalPath: "src/index.ts",
      status: "ALLOWED" as const,
    };
    const missing = createPolicyDecisionContext({
      invocationId: "invocation-6",
      taskId: "policy-write-grant",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      taskState: "IMPLEMENTING",
      ceiling,
      path,
    });
    expect(PolicyEngine.evaluate(validated.call, missing)).toEqual({
      kind: "NEEDS_FILE_PERMISSION",
      invocationId: "invocation-6",
      reason: "MISSING_FILE_GRANT",
    });

    for (const invocationId of ["invocation-7", "invocation-8"]) {
      expect(
        PolicyEngine.evaluate(
          validated.call,
          createPolicyDecisionContext({
            invocationId,
            taskId: "policy-write-grant",
            sessionId: "session-1",
            workspaceId: "workspace-1",
            taskState: "IMPLEMENTING",
            ceiling,
            path,
            grant: {
              sessionId: "session-1",
              workspaceId: "workspace-1",
              canonicalPath: "src/index.ts",
              operation: "update",
              status: "GRANTED",
            },
          }),
        ),
      ).toEqual({ kind: "ALLOW", invocationId });
    }
  });

  it("does not reactivate an externally invalidated grant when old bytes return", () => {
    const validated = validateToolCall({ name: "apply_patch", arguments: { patch: "patch" } });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const ceiling = createCeiling({
      taskId: "policy-invalidated-grant",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      mode: "Edit",
      eligibleTools: ["apply_patch"],
    });

    expect(
      PolicyEngine.evaluate(
        validated.call,
        createPolicyDecisionContext({
          invocationId: "invocation-9",
          taskId: "policy-invalidated-grant",
          sessionId: "session-1",
          workspaceId: "workspace-1",
          taskState: "IMPLEMENTING",
          ceiling,
          path: {
            workspaceId: "workspace-1",
            operation: "update",
            requestedPath: "src/index.ts",
            canonicalPath: "src/index.ts",
            status: "ALLOWED",
          },
          grant: {
            sessionId: "session-1",
            workspaceId: "workspace-1",
            canonicalPath: "src/index.ts",
            operation: "update",
            status: "INVALIDATED",
          },
        }),
      ),
    ).toEqual({ kind: "DENY", invocationId: "invocation-9", reason: "GRANT_INVALIDATED" });
  });
});
