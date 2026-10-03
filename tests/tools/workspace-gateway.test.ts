import { describe, expect, it } from "vitest";

import { admitTask, createTask, TaskState } from "../../src/orchestration/task.js";
import { ToolGateway } from "../../src/tools/gateway.js";
import { admitTask as admitFixtureTask, TEST_WORKSPACE_ID } from "../support/admission.js";
import type { TrustedPathFacts } from "../../src/policy/engine.js";
import { selectWorkspace, closeWorkspace } from "../../src/workspace/admission.js";
import { WorkspaceBoundary } from "../../src/workspace/boundary.js";
import { createGitCheckout } from "../workspace/fixtures.js";

const admitted = admitFixtureTask(
  createTask({ taskId: "coverage", objective: "Inspect", mode: "Ask" }),
  0,
);
const task = { ...admitted, state: TaskState.INSPECTING };

function invoke(
  name: "read_file" | "list_files" | "search_code",
  args: Record<string, unknown>,
  facts: readonly TrustedPathFacts[],
) {
  let executions = 0;
  const gateway = new ToolGateway({
    workspace: { factsFor: () => facts },
    grants: { grantFor: () => undefined },
    executors: {
      read_file: {
        execute: () => {
          executions += 1;
          return {
            kind: "CONTENT",
            path: "src/tracked.ts",
            method: "workspace-read",
            content: "source",
          };
        },
      },
      list_files: { execute: () => ++executions },
      search_code: {
        execute: () => {
          executions += 1;
          return {
            kind: "SEARCH_RESULT",
            method: "workspace-search",
            matches: [],
            skipped: [],
            omittedMatches: false,
            shortenedLines: false,
            omittedFiles: false,
          };
        },
      },
    },
  });
  return {
    result: gateway.invoke(task, { name, arguments: args }, 0),
    executions: () => executions,
  };
}

const fact = (requestedPath: string): TrustedPathFacts => ({
  workspaceId: TEST_WORKSPACE_ID,
  requestedPath,
  canonicalPath: requestedPath,
  operation: "read",
  status: "ALLOWED",
});

describe("gateway path fact coverage", () => {
  it.each([
    ["read_file", { path: "src/tracked.ts" }, "src/tracked.ts"],
    ["list_files", {}, "."],
    ["list_files", { path: "src" }, "src"],
    ["search_code", { query: "tracked" }, "."],
    ["search_code", { query: "tracked", scope: "src" }, "src"],
  ] as const)("allows exactly one matching fact for %s", async (name, args, expected) => {
    const call = invoke(name, args, [fact(expected)]);
    expect(await call.result).toMatchObject({ kind: "EXECUTED" });
    expect(call.executions()).toBe(1);
  });

  it.each([
    [[]],
    [[fact("other")]],
    [[fact("src/tracked.ts"), fact("src/tracked.ts")]],
    [[fact("src/tracked.ts"), fact("extra")]],
    [[{ ...fact("src/tracked.ts"), operation: "update" as const }]],
  ])(
    "fails closed on missing, wrong, duplicate, extra, or wrong-operation facts",
    async (facts) => {
      const call = invoke("read_file", { path: "src/tracked.ts" }, facts);
      expect(await call.result).toMatchObject({ kind: "FAILED", reason: "POLICY_FAILURE" });
      expect(call.executions()).toBe(0);
    },
  );

  it("uses current real workspace facts before the fake executor", async () => {
    const fixture = createGitCheckout();
    try {
      fixture.writeDeniedPaths();
      const selection = selectWorkspace(fixture.root);
      expect(selection.kind).toBe("SELECTED");
      if (selection.kind !== "SELECTED") return;
      try {
        const admittedReal = admitTask(
          createTask({ taskId: "real-facts", objective: "Inspect", mode: "Ask" }),
          0,
          "Small",
          { sessionId: "real-session", workspace: selection.workspace },
        );
        const current = { ...admittedReal, state: TaskState.INSPECTING };
        let executions = 0;
        const gateway = new ToolGateway({
          workspace: new WorkspaceBoundary(),
          grants: { grantFor: () => undefined },
          executors: {
            read_file: {
              execute: () => {
                executions += 1;
                return {
                  kind: "CONTENT",
                  path: "src/tracked.ts",
                  method: "workspace-read",
                  content: "source",
                };
              },
            },
          },
        });
        expect(
          await gateway.invoke(
            current,
            { name: "read_file", arguments: { path: "src/tracked.ts" } },
            0,
          ),
        ).toMatchObject({ kind: "EXECUTED" });
        expect(
          await gateway.invoke(current, { name: "read_file", arguments: { path: ".env" } }, 1),
        ).toMatchObject({ kind: "DENY", reason: "FORBIDDEN_PATH" });
        expect(executions).toBe(1);
      } finally {
        closeWorkspace(selection.workspace);
      }
    } finally {
      fixture.cleanup();
    }
  });
});
