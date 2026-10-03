import { describe, expect, it } from "vitest";
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
});
