import type { PreparedImageRecord, SandboxBackend, SandboxLimits } from "./types.js";
import type { TrustedExecutionFacts } from "../policy/engine.js";
import type { TaskCapabilityCeiling } from "../policy/engine.js";
import { approvedProfilesForTool } from "./config.js";

export type ReadinessAssessment =
  | { readonly status: "READY" }
  | {
      readonly status: "EXTERNAL_BLOCKER";
      readonly reason:
        "PREPARATION_REQUIRED" | "IMAGE_STALE" | "RUNTIME_UNAVAILABLE" | "CLEANUP_UNCONFIRMED";
    };

export class SandboxGateway {
  constructor(
    private readonly backend: SandboxBackend,
    private readonly limits: SandboxLimits,
  ) {}

  async readiness(image: PreparedImageRecord): Promise<ReadinessAssessment> {
    const status = await this.backend.readiness(image, this.limits);
    return status.status === "READY"
      ? { status: "READY" }
      : { status: "EXTERNAL_BLOCKER", reason: status.reason };
  }

  async factsFor(
    call: { readonly name: string; readonly arguments?: unknown },
    ceiling: TaskCapabilityCeiling,
    image: PreparedImageRecord,
  ): Promise<TrustedExecutionFacts | undefined> {
    if (approvedProfilesForTool(call.name).length === 0) return undefined;
    const readiness = await this.readiness(image);
    return Object.freeze({
      approvedProfiles: (ceiling.eligibleTools as readonly string[]).includes(call.name)
        ? approvedProfilesForTool(call.name)
        : Object.freeze([]),
      executorReady: readiness.status === "READY",
      readiness,
    });
  }
}
