import { describe, expect, it } from "vitest";

import { VerificationCoordinator } from "../../src/sandbox/verification.js";
import type { VerificationEvidence, VerificationSnapshot } from "../../src/sandbox/types.js";

const snapshot: VerificationSnapshot = {
  formatVersion: 1,
  workspaceId: "workspace",
  exclusionPolicyId: "default",
  entries: [],
  totalBytes: 0,
  snapshotId: "snapshot",
};

const createEvidence = (
  check: string,
  overrides?: Partial<VerificationEvidence>,
): VerificationEvidence => ({
  check,
  snapshotId: "snapshot",
  imageId: "image-1",
  status: "PASS",
  cleanup: "CONFIRMED",
  preparationFingerprint: "fingerprint-1",
  profileSetId: "profile-1",
  targetId: "target-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  nativeIdentity: "native-1",
  ...overrides,
});

describe("verification coordination", () => {
  it("rejects duplicate required checks before execution can satisfy coverage", () => {
    expect(
      () => new VerificationCoordinator(["tests", "tests"], snapshot, () => "CURRENT"),
    ).toThrow("Verification checks must be unique and non-empty");
  });

  it("retains sealed snapshot for verification lifecycle", () => {
    const coordinator = new VerificationCoordinator(["test"], snapshot, () => "CURRENT");
    expect(coordinator.snapshotFor()).toBe(snapshot);
  });

  it("enforces required-check coverage and rejects unexpected or duplicate checks", () => {
    const coordinator = new VerificationCoordinator(["test", "lint"], snapshot, () => "CURRENT");
    expect(() => coordinator.record(createEvidence("build"))).toThrow(
      "Unexpected verification check",
    );

    coordinator.record(createEvidence("test"));
    expect(() => coordinator.record(createEvidence("test"))).toThrow(
      "Duplicate verification check",
    );
  });

  it("returns INCOMPLETE when fewer than all required checks are recorded", async () => {
    const coordinator = new VerificationCoordinator(["test", "lint"], snapshot, () => "CURRENT");
    coordinator.record(createEvidence("test"));

    const verdict = await coordinator.verdict();
    expect(verdict.status).toBe("INCOMPLETE");
    expect(verdict.freshness).toBe("CURRENT");
    expect(verdict.evidence).toHaveLength(1);
  });

  it("rejects mixed snapshot or image identities and mismatched coordinator identities", () => {
    const identity = {
      preparationFingerprint: "fingerprint-1",
      profileSetId: "profile-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      nativeIdentity: "native-1",
    };

    const coordWithIdentity = new VerificationCoordinator(
      ["test", "lint"],
      snapshot,
      () => "CURRENT",
      identity,
    );

    expect(() =>
      coordWithIdentity.record(createEvidence("test", { taskId: "different-task" })),
    ).toThrow("evidence identity mismatch");

    const coordMixed = new VerificationCoordinator(["test", "lint"], snapshot, () => "CURRENT");
    coordMixed.record(createEvidence("test", { snapshotId: "snapshot", imageId: "image-1" }));
    expect(() =>
      coordMixed.record(
        createEvidence("lint", { snapshotId: "different-snapshot", imageId: "image-1" }),
      ),
    ).toThrow("Mixed verification identity");

    const coordMixedImage = new VerificationCoordinator(
      ["test", "lint"],
      snapshot,
      () => "CURRENT",
    );
    coordMixedImage.record(createEvidence("test", { snapshotId: "snapshot", imageId: "image-1" }));
    expect(() =>
      coordMixedImage.record(
        createEvidence("lint", { snapshotId: "snapshot", imageId: "image-2" }),
      ),
    ).toThrow("Mixed verification identity");
  });

  it("retains passing snapshot evidence with PASS verdict status when freshness is STALE", async () => {
    const coordinator = new VerificationCoordinator(["test", "lint"], snapshot, () => "STALE");
    coordinator.record(createEvidence("test"));
    coordinator.record(createEvidence("lint"));

    const verdict = await coordinator.verdict();
    expect(verdict.status).toBe("PASS");
    expect(verdict.freshness).toBe("STALE");
    expect(verdict.evidence).toHaveLength(2);
    expect(verdict.evidence.every((e) => e.status === "PASS")).toBe(true);
  });

  it("returns FAIL when all checks are recorded but one check fails or cleanup is uncertain", async () => {
    const coordinatorFail = new VerificationCoordinator(
      ["test", "lint"],
      snapshot,
      () => "CURRENT",
    );
    coordinatorFail.record(createEvidence("test", { status: "FAIL" }));
    coordinatorFail.record(createEvidence("lint", { status: "PASS" }));

    const verdictFail = await coordinatorFail.verdict();
    expect(verdictFail.status).toBe("FAIL");

    const coordinatorUncertain = new VerificationCoordinator(["test"], snapshot, () => "CURRENT");
    coordinatorUncertain.record(createEvidence("test", { cleanup: "UNCERTAIN" }));

    const verdictUncertain = await coordinatorUncertain.verdict();
    expect(verdictUncertain.status).toBe("FAIL");
  });
});
