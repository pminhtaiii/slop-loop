import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { start } from "../src/index.js";

function createMemoryStream(): { stream: Writable; getLines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  return {
    stream,
    getLines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0),
  };
}

describe("Application startup smoke tests", () => {
  it("starts successfully with default config and emits a structured startup record at info level", () => {
    const memory = createMemoryStream();
    const result = start({
      env: {},
      destination: memory.stream,
    });

    expect(result.status).toBe("started");
    expect(result.config.logLevel).toBe("info");

    const lines = memory.getLines();
    expect(lines.length).toBeGreaterThan(0);

    const firstRecord = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(firstRecord.level).toBe(30); // Pino info level is 30
    expect(firstRecord.status).toBe("started");
  });

  it("emits the structured startup record even when SLOP_LOOP_LOG_LEVEL is set to warn", () => {
    const memory = createMemoryStream();
    const result = start({
      env: { SLOP_LOOP_LOG_LEVEL: "warn" },
      destination: memory.stream,
    });

    expect(result.status).toBe("started");
    expect(result.config.logLevel).toBe("warn");

    const lines = memory.getLines();
    expect(lines.length).toBeGreaterThan(0);

    const firstRecord = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(firstRecord.level).toBe(30);
    expect(firstRecord.status).toBe("started");
    expect(firstRecord.logLevel).toBe("warn");
  });

  it("fails with a bounded diagnostic when configuration has an invalid log level", () => {
    expect(() =>
      start({
        env: { SLOP_LOOP_LOG_LEVEL: "invalid_level" },
      }),
    ).toThrowError(/Invalid SLOP_LOOP_LOG_LEVEL/);
  });

  it("fails with a bounded diagnostic when an unknown SLOP_LOOP_* variable is provided", () => {
    expect(() =>
      start({
        env: { SLOP_LOOP_UNKNOWN_VAR: "some_value" },
      }),
    ).toThrowError(/Unknown application configuration setting\(s\)/);
  });
});
