import type { Freshness, VerificationEvidence, VerificationSnapshot, VerificationVerdict } from "./types.js";

export class VerificationCoordinator {
  private readonly evidence = new Map<string, VerificationEvidence>();
  private readonly identity?: { readonly preparationFingerprint: string; readonly profileSetId: string; readonly taskId: string; readonly attemptId: string; readonly nativeIdentity: string };
  constructor(
    private readonly requiredChecks: readonly string[],
    private readonly sealedSnapshot?: VerificationSnapshot,
    private readonly freshnessProvider?: () => Freshness,
    identity?: { readonly preparationFingerprint: string; readonly profileSetId: string; readonly taskId: string; readonly attemptId: string; readonly nativeIdentity: string },
  ) { this.identity = identity; }
  record(evidence: VerificationEvidence): void {
    if (!this.requiredChecks.includes(evidence.check)) throw new Error("Unexpected verification check");
    if (this.evidence.has(evidence.check)) throw new Error("Duplicate verification check");
    if (this.identity && (
      evidence.preparationFingerprint !== this.identity.preparationFingerprint ||
      evidence.profileSetId !== this.identity.profileSetId ||
      evidence.taskId !== this.identity.taskId ||
      evidence.attemptId !== this.identity.attemptId ||
      evidence.nativeIdentity !== this.identity.nativeIdentity
    )) throw new Error("evidence identity mismatch");
    if (this.evidence.size > 0) {
      const first = this.evidence.values().next().value as VerificationEvidence;
      if (first.snapshotId !== evidence.snapshotId || first.imageId !== evidence.imageId)
        throw new Error("Mixed verification identity");
    }
    this.evidence.set(evidence.check, Object.freeze({ ...evidence }));
  }
  verdict(): Promise<VerificationVerdict> {
    const freshness = this.freshnessProvider?.() ?? "UNCONFIRMED";
    const evidence = Object.freeze([...this.evidence.values()]);
    const sealedSnapshotId = this.sealedSnapshot?.snapshotId;
    const complete =
      evidence.length === this.requiredChecks.length &&
      sealedSnapshotId !== undefined &&
      evidence.every((item) => item.snapshotId === sealedSnapshotId);
    const passed =
      complete &&
      freshness === "CURRENT" &&
      evidence.every((item) =>
        item.status === "PASS" &&
        item.cleanup === "CONFIRMED" &&
        item.preparationFingerprint.length > 0 &&
        item.profileSetId.length > 0 &&
        item.targetId.length > 0 &&
        item.taskId.length > 0 &&
        item.attemptId.length > 0 &&
        item.nativeIdentity.length > 0,
      );
    return Promise.resolve(
      Object.freeze({
        status: freshness !== "CURRENT" ? "INCOMPLETE" : passed ? "PASS" : complete ? "FAIL" : "INCOMPLETE",
        freshness,
        evidence,
      }),
    );
  }
  snapshotFor(): VerificationSnapshot | undefined {
    return this.sealedSnapshot;
  }
}
