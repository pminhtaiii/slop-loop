import { describe, expect, it } from "vitest";

import { mapVerificationTarget } from "../../src/sandbox/config.js";

describe("trusted verification profiles", () => {
  it("maps only fixed logical targets", () => {
    expect(mapVerificationTarget("run_tests", "ordinary")).toEqual({
      check: "tests",
      argv: ["pnpm", "test"],
    });
    expect(() => mapVerificationTarget("run_tests", "pnpm test && whoami")).toThrow();
    expect(() => mapVerificationTarget("run_tests", "unknown")).toThrow();
  });
});
