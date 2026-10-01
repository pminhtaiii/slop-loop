import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGitCheckout } from "./fixtures.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

describe("effective checkout membership", () => {
  it("includes tracked and nonignored untracked files but excludes ignored files", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write("src/new.ts", "export const newFile = true;\n");
    fixture.write(".gitignore", "*.log\n");
    fixture.write("src/ignored.log", "ignored\n");
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const { listWorkspaceMembers } = await import("../../src/workspace/membership.js");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const members = listWorkspaceMembers(selected.workspace);
    expect(members).toContain("src/tracked.ts");
    expect(members).toContain("src/new.ts");
    expect(members).not.toContain("src/ignored.log");
    expect(members.some((member) => member.startsWith(".git/"))).toBe(false);
  });

  it("excludes gitlinks and files beneath nested repositories", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const nested = path.join(fixture.root, "nested");
    fs.mkdirSync(nested);
    fixture.git("-C", nested, "init", "-q");
    fixture.write("nested/inside.ts", "export const outside = true;\n");
    fixture.git("-C", nested, "add", "inside.ts");
    fixture.git(
      "-C",
      nested,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "initial",
    );
    fixture.git("add", "nested");
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const { listWorkspaceMembers, isWorkspaceMember } =
      await import("../../src/workspace/membership.js");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    expect(listWorkspaceMembers(selected.workspace)).not.toContain("nested");
    expect(isWorkspaceMember(selected.workspace, "nested/inside.ts")).toBe(false);
  });

  it("keeps an indexed file eligible after a later ignore rule", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write("tracked.log", "tracked\n");
    fixture.git("add", "tracked.log");
    fixture.write(".gitignore", "*.log\n");
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const { isWorkspaceMember } = await import("../../src/workspace/membership.js");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    expect(isWorkspaceMember(selected.workspace, "tracked.log")).toBe(true);
  });

  it("does not treat a sibling checkout path as a selected workspace member", async () => {
    const fixture = createGitCheckout();
    const sibling = createGitCheckout();
    cleanup.push(
      () => fixture.cleanup(),
      () => sibling.cleanup(),
    );
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const { isWorkspaceMember } = await import("../../src/workspace/membership.js");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const siblingPath = path.relative(fixture.root, path.join(sibling.root, "src/tracked.ts"));
    expect(isWorkspaceMember(selected.workspace, siblingPath)).toBe(false);
  });

  it("excludes the internals of a nested bare repository", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.git("init", "--bare", path.join(fixture.root, "bare.git"));
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const { isWorkspaceMember } = await import("../../src/workspace/membership.js");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    expect(isWorkspaceMember(selected.workspace, "bare.git/HEAD")).toBe(false);
  });

  it("preserves a leading byte-order mark in an untracked pathname", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const name = "\uFEFFleading.ts";
    fixture.write(name, "export const marked = true;\n");
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const { isWorkspaceMember } = await import("../../src/workspace/membership.js");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    expect(isWorkspaceMember(selected.workspace, name)).toBe(true);
    expect(isWorkspaceMember(selected.workspace, "leading.ts")).toBe(false);
  });

  it("excludes a nested bare repository even without its config file", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const nested = path.join(fixture.root, "bare-without-config.git");
    fixture.git("init", "--bare", nested);
    fs.unlinkSync(path.join(nested, "config"));
    expect(fixture.git("-C", nested, "rev-parse", "--is-bare-repository")).toBe("true");
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const { isWorkspaceMember } = await import("../../src/workspace/membership.js");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    expect(isWorkspaceMember(selected.workspace, "bare-without-config.git/HEAD")).toBe(false);
  });

  it("keeps tracked files in an ordinary directory with repository-shaped names", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write("ordinary/HEAD", "plain text\n");
    fixture.write("ordinary/objects/item.txt", "object text\n");
    fixture.write("ordinary/refs/item.txt", "reference text\n");
    fixture.git("add", "ordinary");
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const { isWorkspaceMember } = await import("../../src/workspace/membership.js");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    expect(isWorkspaceMember(selected.workspace, "ordinary/HEAD")).toBe(true);
    expect(isWorkspaceMember(selected.workspace, "ordinary/objects/item.txt")).toBe(true);
  });

  it("excludes an indexed path whose directory became an external symlink", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write("alias/tracked.ts", "export const tracked = true;\n");
    fixture.git("add", "alias/tracked.ts");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-outside-"));
    cleanup.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, "tracked.ts"), "outside\n");
    fs.rmSync(path.join(fixture.root, "alias"), { recursive: true });
    fixture.symlink("alias", outside, "junction");
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const { isWorkspaceMember } = await import("../../src/workspace/membership.js");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    expect(isWorkspaceMember(selected.workspace, "alias/tracked.ts")).toBe(false);
  });

  it("excludes an indexed path when a parent directory cannot be inspected", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write("missing/tracked.ts", "export const tracked = true;\n");
    fixture.git("add", "missing/tracked.ts");
    fs.rmSync(path.join(fixture.root, "missing"), { recursive: true });
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const { isWorkspaceMember } = await import("../../src/workspace/membership.js");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    expect(isWorkspaceMember(selected.workspace, "missing/tracked.ts")).toBe(false);
  });

  it("inspects a blocked nested prefix once per enumeration", async () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    fixture.write("nested/first.ts", "first\n");
    fixture.write("nested/second.ts", "second\n");
    fixture.git("add", "nested");
    const nested = path.join(fixture.root, "nested");
    fixture.git("-C", nested, "init", "-q");
    const { selectWorkspace, closeWorkspace } = await import("../../src/workspace/admission.js");
    const { listWorkspaceMembers } = await import("../../src/workspace/membership.js");
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const originalLstat = fs.lstatSync;
    let inspections = 0;
    const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (args[0] === nested) inspections += 1;
      return originalLstat(...args);
    });
    try {
      const members = listWorkspaceMembers(selected.workspace);
      expect(members).not.toContain("nested/first.ts");
      expect(members).not.toContain("nested/second.ts");
      expect(inspections).toBe(1);
    } finally {
      lstatSpy.mockRestore();
    }
  });
});
