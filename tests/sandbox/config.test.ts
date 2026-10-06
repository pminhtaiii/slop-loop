import { describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_LIMITS, validateTrustedConfiguration } from "../../src/sandbox/config.js";
import { trustedConfiguration, verificationProfile } from "./fixtures.js";

describe("trusted sandbox configuration", () => {
  it("accepts a bounded local configuration", () => {
    expect(
      validateTrustedConfiguration({
        limits: DEFAULT_SANDBOX_LIMITS,
        engine: { kind: "local" },
        approvedRegistries: ["https://registry.npmjs.org"],
      }),
    ).toMatchObject({
      engine: { kind: "local" },
      approvedRegistries: ["https://registry.npmjs.org"],
    });
  });

  it("provides valid trusted configuration and profile fixture builders", () => {
    const config = trustedConfiguration();
    expect(validateTrustedConfiguration(config)).toMatchObject({
      engine: { kind: "local" },
      approvedRegistries: ["https://registry.npmjs.org"],
    });

    const profile = verificationProfile();
    expect(profile).toEqual({
      argv: ["pnpm", "test"],
      check: "tests",
    });
  });

  it.each([
    ["negative", { maxBytes: -1 }],
    ["NaN", { maxBytes: Number.NaN }],
    ["infinite", { maxBytes: Number.POSITIVE_INFINITY }],
    ["excessive", { maxBytes: 257 * 1024 * 1024 }],
  ])("rejects %s resource limits", (_name, limits) => {
    expect(() =>
      validateTrustedConfiguration({
        limits: { ...DEFAULT_SANDBOX_LIMITS, ...limits },
        engine: { kind: "local" },
        approvedRegistries: ["https://registry.npmjs.org"],
      }),
    ).toThrow();
  });

  it("rejects unknown fields, credentials, hooks, and non-approved registries", () => {
    for (const value of [
      { unknown: true },
      { credentials: { token: "secret" } },
      { hooks: ["prepare"] },
      { approvedRegistries: ["https://evil.example"] },
    ]) {
      expect(() =>
        validateTrustedConfiguration({
          limits: DEFAULT_SANDBOX_LIMITS,
          engine: { kind: "local" },
          approvedRegistries: ["https://registry.npmjs.org"],
          ...value,
        }),
      ).toThrow();
    }
  });

  it.each(["docker", "Docker", "DOCKER", "sandbox:test", "Sandbox:Test", "SANDBOX:TEST"])(
    "rejects recursive suite %s in profile names and arguments",
    (suite) => {
      for (const profiles of [
        { [suite]: { argv: ["pnpm", "test"] } },
        { ordinary: { argv: ["pnpm", suite] } },
      ]) {
        expect(() => validateTrustedConfiguration({ ...trustedConfiguration(), profiles })).toThrow(
          "Unapproved recursive-Docker profile suites are rejected",
        );
      }
    },
  );

  it("rejects remote engines and shell metacharacters in profile argv", () => {
    expect(() =>
      validateTrustedConfiguration({
        limits: DEFAULT_SANDBOX_LIMITS,
        engine: { kind: "remote", endpoint: "docker.example" },
        approvedRegistries: ["https://registry.npmjs.org"],
      }),
    ).toThrow();
    expect(() =>
      validateTrustedConfiguration({
        limits: DEFAULT_SANDBOX_LIMITS,
        engine: { kind: "local" },
        approvedRegistries: ["https://registry.npmjs.org"],
        profiles: { ordinary: { argv: ["sh", "-c", "echo unsafe"] } },
      }),
    ).toThrow();
  });
});
