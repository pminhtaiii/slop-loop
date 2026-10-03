import { describe, expect, it } from "vitest";
import { boundedRead } from "../../src/workspace/retrieval.js";
import { selectWorkspace, closeWorkspace } from "../../src/workspace/admission.js";
import { WorkspaceBoundary } from "../../src/workspace/boundary.js";
import { createGitCheckout } from "./fixtures.js";

const source = {
  canonicalPath: "src/a.ts",
  read: (limit: number) => Buffer.from("hello").subarray(0, limit),
};

describe("bounded workspace read", () => {
  it("returns a complete text file with source provenance", () => {
    expect(boundedRead(source)).toEqual({
      kind: "CONTENT",
      path: "src/a.ts",
      method: "workspace-read",
      content: "hello",
    });
  });
  it("returns no partial content when file or encoded envelope exceeds 64 KiB", () => {
    expect(
      boundedRead({ canonicalPath: "a", read: (limit) => Buffer.alloc(limit, 97) }),
    ).toMatchObject({ kind: "SIZE_LIMIT", path: "a" });
    expect(
      boundedRead({ canonicalPath: "src/a.ts", read: (limit) => Buffer.alloc(limit - 1, 97) }),
    ).toMatchObject({ kind: "SIZE_LIMIT", path: "src/a.ts" });
  });
  it("rejects binary and malformed UTF-8 without content", () => {
    for (const bytes of [Buffer.from([0]), Buffer.from([0xff])])
      expect(boundedRead({ canonicalPath: "a", read: () => bytes })).toMatchObject({
        kind: "BINARY",
        path: "a",
      });
  });
  it("forms a result from a safely opened member handle", () => {
    const fixture = createGitCheckout();
    try {
      const selected = selectWorkspace(fixture.root);
      expect(selected.kind).toBe("SELECTED");
      if (selected.kind !== "SELECTED") return;
      try {
        const opened = new WorkspaceBoundary().openRegularRead(
          selected.workspace.workspaceId,
          "src/tracked.ts",
        );
        expect(opened.kind).toBe("OPENED");
        if (opened.kind !== "OPENED") return;
        try {
          expect(boundedRead(opened.target)).toMatchObject({
            kind: "CONTENT",
            path: "src/tracked.ts",
            method: "workspace-read",
          });
        } finally {
          opened.target.close();
        }
      } finally {
        closeWorkspace(selected.workspace);
      }
    } finally {
      fixture.cleanup();
    }
  });
  it("returns the complete file on repeated reads of the same safe handle", () => {
    const fixture = createGitCheckout();
    try {
      const selected = selectWorkspace(fixture.root);
      expect(selected.kind).toBe("SELECTED");
      if (selected.kind !== "SELECTED") return;
      try {
        const opened = new WorkspaceBoundary().openRegularRead(
          selected.workspace.workspaceId,
          "src/tracked.ts",
        );
        expect(opened.kind).toBe("OPENED");
        if (opened.kind !== "OPENED") return;
        try {
          const first = boundedRead(opened.target);
          expect(first.kind).toBe("CONTENT");
          expect(boundedRead(opened.target)).toEqual(first);
        } finally {
          opened.target.close();
        }
      } finally {
        closeWorkspace(selected.workspace);
      }
    } finally {
      fixture.cleanup();
    }
  });
});
