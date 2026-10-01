import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { admitTask, createTask } from "../../src/orchestration/task.js";
import type { TaskAdmissionAuthority } from "../../src/orchestration/task.js";
import { createGitCheckout } from "./fixtures.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

describe("trusted checkout selection and admission", () => {
  it("selects the same physical checkout from its root and a subdirectory", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const { selectWorkspace, closeWorkspace, workspaceForId } =
      await import("../../src/workspace/admission.js");
    const { isWorkspaceMember } = await import("../../src/workspace/membership.js");
    const root = selectWorkspace(fixture.root);
    const child = selectWorkspace(path.join(fixture.root, "src"));
    expect(root.kind).toBe("SELECTED");
    expect(child.kind).toBe("SELECTED");
    if (root.kind !== "SELECTED" || child.kind !== "SELECTED") return;
    cleanup.push(
      () => closeWorkspace(root.workspace),
      () => closeWorkspace(child.workspace),
    );
    expect(root.workspace.root).toBe(fs.realpathSync(fixture.root));
    expect(child.workspace.root).toBe(root.workspace.root);
    expect(child.workspace.workspaceId).not.toBe("");
    expect(isWorkspaceMember(root.workspace, "src/tracked.ts")).toBe(true);
    expect(isWorkspaceMember(child.workspace, "src/tracked.ts")).toBe(true);
    expect(workspaceForId(child.workspace.workspaceId)).toBe(child.workspace);
    const admitted = admitTask(
      createTask({ taskId: "selected", objective: "Read source", mode: "Ask" }),
      0,
      "Small",
      { sessionId: "session", workspace: child.workspace },
    );
    expect(admitted.state).toBe("ADMITTED");
    expect(admitted.capabilityCeiling?.workspaceId).toBe(child.workspace.workspaceId);
    closeWorkspace(child.workspace);
    expect(workspaceForId(child.workspace.workspaceId)).toBeNull();
  });

  it("rejects a non-repository and a bare repository", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-outside-"));
    cleanup.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    const { selectWorkspace } = await import("../../src/workspace/admission.js");
    expect(selectWorkspace(outside)).toMatchObject({ kind: "REJECTED" });
    fixture.git("clone", "--bare", fixture.root, path.join(outside, "bare.git"));
    expect(selectWorkspace(path.join(outside, "bare.git"))).toMatchObject({ kind: "REJECTED" });
  });

  it("ignores Git repository-location environment overrides", async () => {
    const fixture = createGitCheckout();
    const other = createGitCheckout();
    cleanup.push(
      () => fixture.cleanup(),
      () => other.cleanup(),
    );
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(other.root, ".git");
    try {
      const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
      const selected = selectWorkspace(fixture.root);
      expect(selected.kind).toBe("SELECTED");
      if (selected.kind === "SELECTED") {
        cleanup.push(() => closeWorkspace(selected.workspace));
        expect(selected.workspace.root).toBe(fs.realpathSync(fixture.root));
      }
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });

  it("rejects missing and forged workspace authority", () => {
    const task = createTask({ taskId: "unbound", objective: "Read source", mode: "Ask" });
    expect(admitTask(task, 0).state).toBe("FAILED");
    expect(
      admitTask(task, 0, "Small", {
        sessionId: "session",
        workspaceId: "forged",
      } as unknown as TaskAdmissionAuthority),
    ).toMatchObject({ state: "FAILED", outcome: { reason: "INTERNAL_ERROR" } });
  });

  it("rejects a replacement linked-worktree gitfile at the same path", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const first = path.join(fixture.root, "first");
    const second = path.join(fixture.root, "second");
    fixture.git("worktree", "add", "-qb", "first", first);
    fixture.git("worktree", "add", "-qb", "second", second);
    const { selectWorkspace, verifyWorkspace, workspaceForId, closeWorkspace } =
      await import("../../src/workspace/admission.js");
    const selected = selectWorkspace(first);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    expect(verifyWorkspace(selected.workspace)).toBe(true);
    const originalGitfile = fs.readFileSync(path.join(first, ".git"));
    fs.rmSync(path.join(first, ".git"));
    fs.copyFileSync(path.join(second, ".git"), path.join(first, ".git"));
    expect(verifyWorkspace(selected.workspace)).toBe(false);
    expect(workspaceForId(selected.workspace.workspaceId)).toBeNull();
    fs.rmSync(path.join(first, ".git"));
    fs.writeFileSync(path.join(first, ".git"), originalGitfile);
    expect(workspaceForId(selected.workspace.workspaceId)).toBeNull();
    expect(verifyWorkspace(selected.workspace)).toBe(false);
  });

  it("rejects a gitfile switch between discovery and opening directory handles", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const first = path.join(fixture.root, "first");
    const second = path.join(fixture.root, "second");
    fixture.git("worktree", "add", "-qb", "first", first);
    fixture.git("worktree", "add", "-qb", "second", second);
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const originalOpen = fs.openSync;
    let switched = false;
    let rootOpens = 0;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (args[0] === first) {
        rootOpens += 1;
        if (!switched && rootOpens === 2) {
          switched = true;
          fs.rmSync(path.join(first, ".git"));
          fs.copyFileSync(path.join(second, ".git"), path.join(first, ".git"));
        }
      }
      return originalOpen(...args);
    });
    try {
      const selected = selectWorkspace(first);
      if (selected.kind === "SELECTED") closeWorkspace(selected.workspace);
      expect(switched).toBe(true);
      expect(selected.kind).toBe("REJECTED");
    } finally {
      openSpy.mockRestore();
    }
  });
});
