import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});

import { selectWorkspace, closeWorkspace } from "../../src/workspace/admission.js";
import { WorkspaceBoundary } from "../../src/workspace/boundary.js";
import { createGitCheckout } from "./fixtures.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

describe("bounded directory membership work", () => {
  it("uses constant Git work and at most one child handle for a directory batch", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    for (let index = 0; index < 20; index += 1)
      fixture.write(`src/item-${index}.ts`, `export const n = ${index};\n`);
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const opened = new WorkspaceBoundary().openDirectory(selected.workspace.workspaceId, "src");
    expect(opened.kind).toBe("OPENED");
    if (opened.kind !== "OPENED") return;
    const require = createRequire(import.meta.url);
    const native = require("../../native/workspace/build/Release/workspace_boundary.node") as {
      openChild: (...arguments_: unknown[]) => number;
      closeDescriptor: (fd: number) => void;
    };
    const originalOpen = native.openChild;
    const originalClose = native.closeDescriptor;
    const liveChildren = new Set<number>();
    let peakChildren = 0;
    native.openChild = (...args: unknown[]) => {
      const fd = originalOpen(...args);
      liveChildren.add(fd);
      peakChildren = Math.max(peakChildren, liveChildren.size);
      return fd;
    };
    native.closeDescriptor = (fd: number) => {
      liveChildren.delete(fd);
      originalClose(fd);
    };
    try {
      const baseline = vi.mocked(execFileSync).mock.calls.length;
      const entries = opened.target.entries();
      expect(entries).toHaveLength(21);
      const memberCalls = vi
        .mocked(execFileSync)
        .mock.calls.slice(baseline)
        .filter((call) => Array.isArray(call[1]) && call[1].includes("ls-files"));
      expect(memberCalls).toHaveLength(2);
      const discoveryCalls = vi
        .mocked(execFileSync)
        .mock.calls.slice(baseline)
        .filter((call) => Array.isArray(call[1]) && call[1].includes("rev-parse"));
      expect(discoveryCalls).toHaveLength(3);
      expect(peakChildren).toBeLessThanOrEqual(1);
    } finally {
      native.openChild = originalOpen;
      native.closeDescriptor = originalClose;
      opened.target.close();
    }
  });

  it("keeps read revalidation before and after bytes with bounded Git discovery", () => {
    const fixture = createGitCheckout();
    cleanup.push(() => fixture.cleanup());
    const selected = selectWorkspace(fixture.root);
    expect(selected.kind).toBe("SELECTED");
    if (selected.kind !== "SELECTED") return;
    cleanup.push(() => closeWorkspace(selected.workspace));
    const opened = new WorkspaceBoundary().openRegularRead(
      selected.workspace.workspaceId,
      "src/tracked.ts",
    );
    expect(opened.kind).toBe("OPENED");
    if (opened.kind !== "OPENED") return;
    try {
      const baseline = vi.mocked(execFileSync).mock.calls.length;
      expect(opened.target.read(128).toString("utf8")).toContain("tracked");
      const calls = vi.mocked(execFileSync).mock.calls.slice(baseline);
      expect(
        calls.filter((call) => Array.isArray(call[1]) && call[1].includes("ls-files")),
      ).toHaveLength(2);
      expect(
        calls.filter((call) => Array.isArray(call[1]) && call[1].includes("rev-parse")),
      ).toHaveLength(4);
    } finally {
      opened.target.close();
    }
  });
});
