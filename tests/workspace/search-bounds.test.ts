import { describe, expect, it, vi } from "vitest";
import { boundedSearch } from "../../src/workspace/retrieval.js";

describe("bounded workspace search", () => {
  it("bounds matches and marks omitted matches separately from shortened lines", () => {
    const result = boundedSearch([{ path: "a", content: "needle\n".repeat(202) }], "needle", 200);
    expect(result.kind).toBe("SEARCH_RESULT");
    expect(result.matches).toHaveLength(200);
    expect(result.omittedMatches).toBe(true);
    expect(result.shortenedLines).toBe(false);
  });
  it("shortens a long line and keeps total encoded result within 32 KiB", () => {
    const result = boundedSearch(
      [{ path: "a", content: `needle${"x".repeat(5000)}` }],
      "needle",
      200,
    );
    expect(result.matches[0]?.line.length).toBeLessThanOrEqual(4096);
    expect(result.shortenedLines).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
  });
  it("does not mark an unshortened line merely because JSON escapes its characters", () => {
    const line = `needle${'"'.repeat(3000)}`;
    const result = boundedSearch([{ path: "a", content: line }], "needle");
    expect(result.matches[0]).toMatchObject({ line, shortened: false });
    expect(result.shortenedLines).toBe(false);
  });
  it("shortens multibyte text at a character boundary within 4 KiB", () => {
    const result = boundedSearch([{ path: "a", content: `needle${"😀".repeat(1100)}` }], "needle");
    expect(result.matches[0]).toMatchObject({
      line: `needle${"😀".repeat(1022)}`,
      shortened: true,
    });
    expect(Buffer.byteLength(result.matches[0]?.line ?? "")).toBeLessThanOrEqual(4096);
    expect(result.shortenedLines).toBe(true);
  });
  it("marks omitted matches when the 32 KiB result ceiling is reached before 200 matches", () => {
    const result = boundedSearch(
      [
        {
          path: "a",
          content: Array.from({ length: 100 }, () => `needle${"x".repeat(900)}`).join("\n"),
        },
      ],
      "needle",
    );
    expect(result.matches.length).toBeLessThan(100);
    expect(result.omittedMatches).toBe(true);
    expect(result.shortenedLines).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
  });
  it("skips oversized and binary files with bounded metadata", () => {
    const result = boundedSearch(
      [
        { path: "a", content: Buffer.alloc(4 * 1024 * 1024 + 1) },
        { path: "b", content: Buffer.from([0]) },
      ],
      "x",
      200,
    );
    expect(result.skipped).toEqual([
      { path: "a", reason: "SIZE_LIMIT" },
      { path: "b", reason: "BINARY" },
    ]);
  });
  it("marks omitted skipped-file metadata when it fills the result budget", () => {
    const files = Array.from({ length: 100 }, (_, index) => ({
      path: `${"a".repeat(500)}-${index}`,
      content: Buffer.from([0]),
    }));
    const result = boundedSearch(files, "x");
    expect(result.omittedFiles).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
  });
  it("uses the byte freed by an omitted-match flag for trailing skipped metadata", () => {
    const skipped = Array.from({ length: 34 }, (_, index) => ({
      path: `${"a".repeat(900)}-${index}`,
      reason: "BINARY",
    }));
    const envelope = {
      kind: "SEARCH_RESULT",
      method: "workspace-search",
      matches: [{ path: "a", lineNumber: 1, line: "needle", shortened: false }],
      skipped: [...skipped, { path: "", reason: "BINARY" }],
      omittedMatches: true,
      shortenedLines: false,
      omittedFiles: false,
    };
    const tailLength = 32768 - Buffer.byteLength(JSON.stringify(envelope));
    expect(tailLength).toBeGreaterThan(0);
    expect(tailLength).toBeLessThanOrEqual(1024);
    const result = boundedSearch(
      [
        { path: "a", content: "needle\nneedle" },
        ...skipped.map(({ path }) => ({ path, content: Buffer.from([0]) })),
        { path: "z".repeat(tailLength), content: Buffer.from([0]) },
      ],
      "needle",
      1,
    );
    expect(result.skipped).toHaveLength(skipped.length + 1);
    expect(result.omittedMatches).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBe(32768);
  });
  it("keeps scanning for both omission flags without serializing the growing result per item", () => {
    const files = [
      ...Array.from({ length: 100 }, (_, index) => ({
        path: `${"a".repeat(500)}-${index}`,
        content: Buffer.from([0]),
      })),
      {
        path: "matches",
        content: Array.from({ length: 100 }, () => `needle${"x".repeat(900)}`).join("\n"),
      },
    ];
    const stringify = vi.spyOn(JSON, "stringify");
    let result;
    let fullResultSerializations;
    try {
      result = boundedSearch(files, "needle");
      fullResultSerializations = stringify.mock.calls.filter(([value]) => {
        const candidate: unknown = value;
        return (
          typeof candidate === "object" &&
          candidate !== null &&
          "kind" in candidate &&
          candidate.kind === "SEARCH_RESULT"
        );
      }).length;
    } finally {
      stringify.mockRestore();
    }
    expect(fullResultSerializations).toBeLessThanOrEqual(1);
    expect(result.omittedFiles).toBe(true);
    expect(result.omittedMatches).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
  });
});
