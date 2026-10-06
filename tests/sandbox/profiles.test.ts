import { describe, expect, it } from "vitest";

import {
  DEFAULT_SANDBOX_LIMITS,
  mapNativePrelude,
  mapVerificationTarget,
  NODE_GYP_PRELUDE,
  validateTrustedConfiguration,
} from "../../src/sandbox/config.js";

describe("trusted verification profiles", () => {
  it("maps only fixed logical targets", () => {
    expect(mapVerificationTarget("run_tests", "ordinary")).toEqual({
      check: "tests",
      argv: ["pnpm", "test"],
    });
    expect(() => mapVerificationTarget("run_tests", "pnpm test && whoami")).toThrow();
    expect(() => mapVerificationTarget("run_tests", "unknown")).toThrow();
  });

  it("maps node-gyp native prelude for native build targets", () => {
    const target = mapVerificationTarget("run_build", "native");
    expect(target).toEqual({
      check: "build",
      argv: ["pnpm", "build"],
      nativePrelude: ["node-gyp", "rebuild"],
    });
    expect(NODE_GYP_PRELUDE).toEqual(["node-gyp", "rebuild"]);
    expect(mapNativePrelude("run_build", "native")).toEqual(["node-gyp", "rebuild"]);
    expect(mapNativePrelude("run_tests", "ordinary")).toBeUndefined();
  });

  it("rejects unapproved recursive-Docker suites", () => {
    for (const profile of ["docker", "recursive-docker", "sandbox:test", "docker_integration"]) {
      expect(() => mapVerificationTarget("run_tests", profile)).toThrow();
    }
    expect(() => mapVerificationTarget("docker", "ordinary")).toThrow();
  });

  it("rejects configured profiles with recursive-Docker commands", () => {
    expect(() =>
      validateTrustedConfiguration({
        limits: DEFAULT_SANDBOX_LIMITS,
        engine: { kind: "local" },
        approvedRegistries: ["https://registry.npmjs.org"],
        profiles: { docker: { argv: ["pnpm", "docker"] } },
      }),
    ).toThrow("Unapproved recursive-Docker profile suites are rejected");

    expect(() =>
      validateTrustedConfiguration({
        limits: DEFAULT_SANDBOX_LIMITS,
        engine: { kind: "local" },
        approvedRegistries: ["https://registry.npmjs.org"],
        profiles: { custom: { argv: ["pnpm", "sandbox:test"] } },
      }),
    ).toThrow("Unapproved recursive-Docker profile suites are rejected");
  });

  it("rejects arbitrary argv injection and non-allowlisted tools", () => {
    expect(() => mapVerificationTarget("run_tests", "; rm -rf /")).toThrow();
    expect(() => mapVerificationTarget("run_tests", "ordinary && ls")).toThrow();
    expect(() => mapVerificationTarget("run_custom", "ordinary")).toThrow();
  });
});
