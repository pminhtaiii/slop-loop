import { describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_LIMITS, validateTrustedConfiguration } from "../../src/sandbox/config.js";

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
