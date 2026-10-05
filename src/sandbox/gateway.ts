import type { PreparedImageRecord, SandboxBackend, SandboxLimits } from "./types.js";
import type { TrustedExecutionFacts } from "../policy/engine.js";
import type { TaskCapabilityCeiling } from "../policy/engine.js";
import { approvedProfilesForTool } from "./config.js";
import { toolMetadataForName } from "../tools/registry.js";
import type { ValidatedToolCall } from "../tools/registry.js";

export type ReadinessAssessment =
  | { readonly status: "READY" }
  | {
      readonly status: "EXTERNAL_BLOCKER";
      readonly reason:
        "PREPARATION_REQUIRED" | "IMAGE_STALE" | "RUNTIME_UNAVAILABLE" | "CLEANUP_UNCONFIRMED";
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
    return status.status === "READY"
      ? { status: "READY" }
      : { status: "EXTERNAL_BLOCKER", reason: status.reason };
  }

  async factsFor(
    call: ValidatedToolCall,
    ceiling: TaskCapabilityCeiling,
    image: PreparedImageRecord,
  ): Promise<TrustedExecutionFacts | undefined> {
    if (toolMetadataForName(call.name).execution !== "trusted_profile") return undefined;
    const readiness = await this.readiness(image);
    return Object.freeze({
      approvedProfiles: ceiling.eligibleTools.includes(call.name)
        ? approvedProfilesForTool(call.name)
        : Object.freeze([]),
      executorReady: readiness.status === "READY",
      readiness,
    });
  }
}
