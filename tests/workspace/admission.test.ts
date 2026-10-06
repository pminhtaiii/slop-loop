import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { admitTask, createTask } from "../../src/orchestration/task.js";
import type { TaskAdmissionAuthority } from "../../src/orchestration/task.js";
import { runTrustedGit } from "../../src/workspace/git.js";
import { createGitCheckout } from "./fixtures.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

function expectSamePhysicalDirectory(first: string, second: string): void {
  const firstIdentity = fs.statSync(first, { bigint: true });
  const secondIdentity = fs.statSync(second, { bigint: true });
  expect(firstIdentity.dev).toBe(secondIdentity.dev);
  expect(firstIdentity.ino).toBe(secondIdentity.ino);
}

describe("trusted checkout selection and admission", () => {
  it("rejects admission when the native capability probe cannot open a real child", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const require = createRequire(import.meta.url);
    const native = require("../../native/workspace/build/Release/workspace_boundary.node") as {
      probeWalk?: (...arguments_: unknown[]) => void;
    };
    const original = native.probeWalk;
    native.probeWalk = () => {
      throw new Error("native path walk unavailable");
    };
    try {
      const { selectWorkspace } = await import("../../src/workspace/admission.js");
      expect(selectWorkspace(fixture.root)).toMatchObject({ kind: "REJECTED" });
    } finally {
      if (original === undefined) delete native.probeWalk;
      else native.probeWalk = original;
    }
  });
  it("discovers a fixture checkout with the restricted Git environment", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const gitValue = (option: string): string =>
      runTrustedGit(fixture.root, ["rev-parse", option]).toString("utf8").trim();
    expect(gitValue("--is-inside-work-tree"), "Git worktree discovery").toBe("true");
    expect(gitValue("--is-bare-repository"), "Git bare-repository discovery").toBe("false");
    expectSamePhysicalDirectory(gitValue("--show-toplevel"), fixture.root);
    expect(fs.statSync(fs.realpathSync(gitValue("--absolute-git-dir"))).isDirectory()).toBe(true);
  });

  it("opens fixture directories with stable operating-system identities", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const root = fs.realpathSync(fixture.root);
    const gitdir = fs.realpathSync(path.join(root, ".git"));
    for (const directory of [root, gitdir]) {
      const fd = fs.openSync(directory, "r");
      try {
        const held = fs.fstatSync(fd, { bigint: true });
        const current = fs.statSync(directory, { bigint: true });
        expect(held.isDirectory(), "opened directory type").toBe(true);
        expect(held.dev, "directory device identity").toBe(current.dev);
        expect(held.ino, "directory file identity").toBe(current.ino);
      } finally {
        fs.closeSync(fd);
      }
    }
  });

  it("accepts a physical checkout through a differently spelled directory alias", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const aliasHome = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-alias-"));
    cleanup.push(() => {
      const resolved = path.resolve(aliasHome);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir())) {
        throw new Error("Alias cleanup escaped the temporary directory");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    });
    const alias = path.join(aliasHome, "checkout");
    fs.symlinkSync(fixture.root, alias, "junction");
    const launch = path.join(alias, "src");
    expect(fs.statSync(alias, { bigint: true }).ino).toBe(
      fs.statSync(fixture.root, { bigint: true }).ino,
    );
    const gitRoot = runTrustedGit(launch, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
    expectSamePhysicalDirectory(gitRoot, fixture.root);
    const originalRealpath = fs.realpathSync;
    const realpathSpy = vi.spyOn(fs, "realpathSync").mockImplementation((...args) => {
      if (args[0] === launch) return launch;
      return originalRealpath(...args);
    });
    try {
      const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
      const selected = selectWorkspace(launch);
      expect(selected.kind).toBe("SELECTED");
      if (selected.kind === "SELECTED") {
        cleanup.push(() => closeWorkspace(selected.workspace));
        expectSamePhysicalDirectory(selected.workspace.root, fixture.root);
      }
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("selects the same physical checkout from its root and a subdirectory", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const { selectWorkspace, closeWorkspace, workspaceForId } =
      await import("../../src/workspace/admission.js");
    const { isWorkspaceMember } = await import("../../src/workspace/membership.js");
    const root = selectWorkspace(fixture.root);
    const child = selectWorkspace(path.join(fixture.root, "src"));
    expect(root).toMatchObject({ kind: "SELECTED" });
    expect(child).toMatchObject({ kind: "SELECTED" });
    if (root.kind !== "SELECTED" || child.kind !== "SELECTED") return;
    cleanup.push(
      () => closeWorkspace(root.workspace),
      () => closeWorkspace(child.workspace),
    );
    expectSamePhysicalDirectory(root.workspace.root, fixture.root);
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

  it("rejects a non-repository and a bare repository", { timeout: 20_000 }, async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-outside-"));
    cleanup.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    const { selectWorkspace } = await import("../../src/workspace/admission.js");
    expect(selectWorkspace(outside)).toMatchObject({ kind: "REJECTED" });
    fixture.git("clone", "--bare", fixture.root, path.join(outside, "bare.git"));
    expect(selectWorkspace(path.join(outside, "bare.git"))).toMatchObject({ kind: "REJECTED" });
  });

  it("ignores Git repository-location environment overrides", { timeout: 20_000 }, async () => {
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
        expectSamePhysicalDirectory(selected.workspace.root, fixture.root);
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

  it(
    "rejects a replacement linked-worktree gitfile at the same path",
    { timeout: 20_000 },
    async () => {
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
    },
  );

  it("rejects a gitfile switch between discovery and opening directory handles", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const first = path.join(fixture.root, "first");
    const second = path.join(fixture.root, "second");
    fixture.git("worktree", "add", "-qb", "first", first);
    fixture.git("worktree", "add", "-qb", "second", second);
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const originalOpen = fs.openSync;
    const firstIdentity = fs.statSync(first, { bigint: true });
    let switched = false;
    let rootOpens = 0;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      const opened = fs.statSync(args[0], { bigint: true });
      if (opened.dev === firstIdentity.dev && opened.ino === firstIdentity.ino) {
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
