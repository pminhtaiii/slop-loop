import { describe, expect, it } from "vitest";
import { ConfigurationError, LOG_LEVELS, type LogLevel, loadConfig } from "../src/config.js";

describe("Configuration contract tests (User Story 2 / T014)", () => {
  it("defaults logLevel to 'info' when SLOP_LOOP_LOG_LEVEL is absent", () => {
    const config = loadConfig({});
    expect(config.logLevel).toBe("info");
  });

  it.each(LOG_LEVELS)("accepts supported log level '%s'", (level: LogLevel) => {
    const config = loadConfig({ SLOP_LOOP_LOG_LEVEL: level });
    expect(config.logLevel).toBe(level);
  });

  it("rejects invalid log level values with an actionable diagnostic", () => {
    const invalidValues = ["verbose", "warning", "INFO", "Debug", "unknown", ""];

    for (const invalid of invalidValues) {
      expect(() => loadConfig({ SLOP_LOOP_LOG_LEVEL: invalid })).toThrowError(
        new RegExp(
          `Invalid SLOP_LOOP_LOG_LEVEL '${invalid}'\\. Accepted values: ${LOG_LEVELS.join(", ")}`,
        ),
      );
    }
  });

  it("throws ConfigurationError when an unknown SLOP_LOOP_* variable is provided", () => {
    expect(() =>
      loadConfig({
        SLOP_LOOP_UNKNOWN: "some_value",
      }),
    ).toThrowError(ConfigurationError);

    expect(() =>
      loadConfig({
        SLOP_LOOP_PORT: "8080",
        SLOP_LOOP_TIMEOUT: "30s",
      }),
    ).toThrowError(
      /Unknown application configuration setting\(s\): SLOP_LOOP_PORT, SLOP_LOOP_TIMEOUT/,
    );
  });

  it("ignores unrelated environment variables outside the SLOP_LOOP_* namespace", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PATH: "/usr/bin:/bin",
      HOME: "/home/user",
      RANDOM_VAR: "ignored",
      SLOP_LOOP_LOG_LEVEL: "warn",
    });

    expect(config.logLevel).toBe("warn");
    expect("NODE_ENV" in config).toBe(false);
    expect("PATH" in config).toBe(false);
  });

  it("returns a frozen configuration object", () => {
    const config = loadConfig({});

    expect(Object.isFrozen(config)).toBe(true);

    expect(() => {
      // @ts-expect-error verifying runtime immutability
      config.logLevel = "warn";
    }).toThrow(TypeError);
  });

  it("supports injectable environments without mutating or requiring process.env", () => {
    const customEnv: NodeJS.ProcessEnv = {
      SLOP_LOOP_LOG_LEVEL: "debug",
    };

    const config = loadConfig(customEnv);
    expect(config.logLevel).toBe("debug");
    expect(customEnv).toEqual({ SLOP_LOOP_LOG_LEVEL: "debug" });
  });

  describe("Diagnostic bounding and sanitization (Issue 3)", () => {
    it("bounds excessively long invalid log level strings in diagnostic output", () => {
      const veryLongInput = "a".repeat(200);
      expect(() =>
        loadConfig({
          SLOP_LOOP_LOG_LEVEL: veryLongInput,
        }),
      ).toThrowError(
        new RegExp(
          `Invalid SLOP_LOOP_LOG_LEVEL '${"a".repeat(64)}\\.\\.\\.'\\. Accepted values: ${LOG_LEVELS.join(", ")}`,
        ),
      );
    });

    it("sanitizes control characters in diagnostic output", () => {
      const controlCharsInput = "bad\nlevel\r\t\x00value";
      expect(() =>
        loadConfig({
          SLOP_LOOP_LOG_LEVEL: controlCharsInput,
        }),
      ).toThrowError(/Invalid SLOP_LOOP_LOG_LEVEL 'bad level value'\./);
    });
  });
});
