import { describe, expect, it } from "vitest";

import { VerificationCoordinator } from "../../src/sandbox/verification.js";
import type { VerificationSnapshot } from "../../src/sandbox/types.js";

const snapshot: VerificationSnapshot = {
  formatVersion: 1,
  workspaceId: "workspace",
  exclusionPolicyId: "default",
  entries: [],
  totalBytes: 0,
  snapshotId: "snapshot",
};

describe("verification coordination", () => {
  it("rejects duplicate required checks before execution can satisfy coverage", () => {
    expect(
      () => new VerificationCoordinator(["tests", "tests"], snapshot, () => "CURRENT"),
    ).toThrow();
  });
});
