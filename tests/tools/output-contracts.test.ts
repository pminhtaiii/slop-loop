import { describe, expect, it } from "vitest";
import { outputContractForName, validateToolCall } from "../../src/tools/registry.js";
import { ToolGateway } from "../../src/tools/gateway.js";
import { createTask, TaskState } from "../../src/orchestration/task.js";
import { admitTask, TEST_WORKSPACE_ID } from "../support/admission.js";

function gatewayForRead(output: unknown) {
  const task = {
    ...admitTask(createTask({ taskId: "output-contract", objective: "Read", mode: "Ask" }), 0),
    state: TaskState.INSPECTING,
  };
  const gateway = new ToolGateway({
    workspace: {
      factsFor: () => ({
        workspaceId: TEST_WORKSPACE_ID,
        requestedPath: "src/a.ts",
        canonicalPath: "src/a.ts",
        operation: "read",
        status: "ALLOWED",
      }),
    },
    grants: { grantFor: () => undefined },
    executors: { read_file: { execute: () => output } },
  });
  return gateway.invoke(task, { name: "read_file", arguments: { path: "src/a.ts" } }, 0);
}

function gatewayForUnscopedTool(name: "search_code" | "git_diff", output: unknown) {
  const task = {
    ...admitTask(createTask({ taskId: `output-${name}`, objective: "Inspect", mode: "Ask" }), 0),
    state: TaskState.INSPECTING,
  };
  const gateway = new ToolGateway({
    workspace: {
      factsFor: () =>
        name === "git_diff"
          ? undefined
          : {
              workspaceId: TEST_WORKSPACE_ID,
              requestedPath: ".",
              canonicalPath: ".",
              operation: "read",
              status: "ALLOWED",
            },
    },
    grants: { grantFor: () => undefined },
    executors: { [name]: { execute: () => output } },
  });
  return gateway.invoke(task, { name, arguments: name === "git_diff" ? {} : { query: "x" } }, 0);
}

describe("registered output contracts", () => {
  it("keeps list at 100 and allows search up to 200", () => {
    expect(
      validateToolCall({ name: "search_code", arguments: { query: "x", limit: 200 } }).ok,
    ).toBe(true);
    expect(
      validateToolCall({ name: "search_code", arguments: { query: "x", limit: 201 } }).ok,
    ).toBe(false);
    expect(validateToolCall({ name: "list_files", arguments: { limit: 101 } }).ok).toBe(false);
  });
  it("registers read/search byte ceilings and retains smaller other-tool ceilings", () => {
    expect(outputContractForName("read_file").maxBytes).toBe(65536);
    expect(outputContractForName("search_code").maxBytes).toBe(32768);
    expect(outputContractForName("git_diff").maxBytes).toBeLessThan(32768);
  });
  it("rejects malformed read results", () => {
    expect(
      outputContractForName("read_file").schema.safeParse({ kind: "CONTENT", content: "x" })
        .success,
    ).toBe(false);
  });
  it("rejects a search result with a returned line above 4 KiB", () => {
    const result = {
      kind: "SEARCH_RESULT",
      method: "workspace-search",
      matches: [{ path: "a", lineNumber: 1, line: "😀".repeat(1025), shortened: false }],
      skipped: [],
      omittedMatches: false,
      shortenedLines: false,
      omittedFiles: false,
    };
    expect(outputContractForName("search_code").schema.safeParse(result).success).toBe(false);
  });
  it("rejects host and traversal paths in search provenance", () => {
    for (const path of ["C:/secret.txt", "/etc/passwd", "../secret.txt", "src/../secret.txt"]) {
      const result = {
        kind: "SEARCH_RESULT",
        method: "workspace-search",
        matches: [{ path, lineNumber: 1, line: "x", shortened: false }],
        skipped: [],
        omittedMatches: false,
        shortenedLines: false,
        omittedFiles: false,
      };
      expect(outputContractForName("search_code").schema.safeParse(result).success).toBe(false);
    }
  });
  it("does not allow a caller to raise a registered output ceiling", () => {
    const received = outputContractForName("read_file");
    expect(() => {
      (received as { maxBytes: number }).maxBytes = 1_000_000;
    }).toThrow(TypeError);
    expect(outputContractForName("read_file").maxBytes).toBe(65_536);
  });
  it("accepts a valid read result above the old 32 KiB ceiling", async () => {
    expect(
      await gatewayForRead({
        kind: "CONTENT",
        path: "src/a.ts",
        method: "workspace-read",
        content: "x".repeat(40_000),
      }),
    ).toMatchObject({ kind: "EXECUTED" });
  });
  it("rejects a malformed or over-limit read result after execution", async () => {
    expect(await gatewayForRead({ kind: "CONTENT", content: "x" })).toMatchObject({
      kind: "TOOL_CONTRACT_FAILURE",
    });
    expect(
      await gatewayForRead({
        kind: "CONTENT",
        path: "src/a.ts",
        method: "workspace-read",
        content: "x".repeat(65_500),
      }),
    ).toMatchObject({ kind: "TOOL_CONTRACT_FAILURE" });
  });
  it("rejects read provenance that disagrees with the authorized canonical path", async () => {
    expect(
      await gatewayForRead({
        kind: "CONTENT",
        path: "other.ts",
        method: "workspace-read",
        content: "x",
      }),
    ).toMatchObject({ kind: "TOOL_CONTRACT_FAILURE" });
  });
  it("never returns redacted content as a complete whole-file read", async () => {
    expect(
      await gatewayForRead({
        kind: "CONTENT",
        path: "src/a.ts",
        method: "workspace-read",
        content: "token=example",
      }),
    ).toMatchObject({ kind: "TOOL_CONTRACT_FAILURE" });
  });
  it("never returns a rewritten search line without an explicit outcome", async () => {
    expect(
      await gatewayForUnscopedTool("search_code", {
        kind: "SEARCH_RESULT",
        method: "workspace-search",
        matches: [{ path: "a", lineNumber: 1, line: "token=example", shortened: false }],
        skipped: [],
        omittedMatches: false,
        shortenedLines: false,
        omittedFiles: false,
      }),
    ).toMatchObject({ kind: "TOOL_CONTRACT_FAILURE" });
  });
  it("enforces the search ceiling and the smaller Git result ceiling independently", async () => {
    const search = {
      kind: "SEARCH_RESULT",
      method: "workspace-search",
      matches: Array.from({ length: 80 }, (_, index) => ({
        path: "a",
        lineNumber: index + 1,
        line: "x".repeat(500),
        shortened: false,
      })),
      skipped: [],
      omittedMatches: false,
      shortenedLines: false,
      omittedFiles: false,
    };
    expect(await gatewayForUnscopedTool("search_code", search)).toMatchObject({
      kind: "TOOL_CONTRACT_FAILURE",
    });
    expect(await gatewayForUnscopedTool("git_diff", "x".repeat(20_000))).toMatchObject({
      kind: "TOOL_CONTRACT_FAILURE",
    });
  });
});
