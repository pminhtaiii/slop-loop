import type { PreparedImageRecord, SandboxBackend, SandboxLimits } from "./types.js";

export type ReadinessAssessment =
  | { readonly status: "READY" }
  | {
      readonly status: "EXTERNAL_BLOCKER";
      readonly reason: "PREPARATION_REQUIRED" | "IMAGE_STALE" | "RUNTIME_UNAVAILABLE" | "CLEANUP_UNCONFIRMED";
    };

export interface SandboxExecutionFacts {
  readonly readiness: ReadinessAssessment;
  readonly image: PreparedImageRecord;
}

export class SandboxGateway {
  constructor(
    private readonly backend: SandboxBackend,
    private readonly limits: SandboxLimits,
  ) {}

  async readiness(image: PreparedImageRecord): Promise<ReadinessAssessment> {
    const status = await this.backend.readiness(image, this.limits);
    return status === "READY"
      ? { status: "READY" }
      : { status: "EXTERNAL_BLOCKER", reason: image.status === "STALE" ? "IMAGE_STALE" : "RUNTIME_UNAVAILABLE" };
  }
}
