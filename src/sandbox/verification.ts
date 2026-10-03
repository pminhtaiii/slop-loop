import type { VerificationEvidence, VerificationSnapshot, VerificationVerdict } from "./types.js";

export class VerificationCoordinator {
  private readonly evidence = new Map<string, VerificationEvidence>();
  constructor(private readonly requiredChecks: readonly string[]) {}
  record(evidence: VerificationEvidence): void {
    if (!this.requiredChecks.includes(evidence.check)) throw new Error("Unexpected verification check");
    if (this.evidence.has(evidence.check)) throw new Error("Duplicate verification check");
    if (this.evidence.size > 0) {
      const first = this.evidence.values().next().value as VerificationEvidence;
      if (first.snapshotId !== evidence.snapshotId || first.imageId !== evidence.imageId)
        throw new Error("Mixed verification identity");
    }
    this.evidence.set(evidence.check, Object.freeze({ ...evidence }));
  }
  verdict(input: { readonly snapshotId: string; readonly freshness: "CURRENT" | "STALE" | "UNCONFIRMED" }): Promise<VerificationVerdict> {
    const evidence = Object.freeze([...this.evidence.values()]);
    const complete =
      evidence.length === this.requiredChecks.length &&
      evidence.every((item) => item.snapshotId === input.snapshotId);
    const passed =
      complete &&
      input.freshness === "CURRENT" &&
      evidence.every((item) => item.status === "PASS" && item.cleanup === "CONFIRMED");
    return Promise.resolve(
      Object.freeze({
        status: input.freshness !== "CURRENT" ? "INCOMPLETE" : passed ? "PASS" : complete ? "FAIL" : "INCOMPLETE",
        freshness: input.freshness,
        evidence,
      }),
    );
  }
  snapshotFor(): VerificationSnapshot | undefined {
    return undefined;
  }
}
