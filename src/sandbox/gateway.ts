import type { PreparedImageRecord, SandboxBackend, SandboxLimits } from "./types.js";
import type { TrustedExecutionFacts } from "../policy/engine.js";
import type { TaskCapabilityCeiling } from "../policy/engine.js";
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
    return status === "READY"
      ? { status: "READY" }
      : {
          status: "EXTERNAL_BLOCKER",
          reason:
            image.status === "STALE"
              ? "IMAGE_STALE"
              : image.status === "MISSING"
                ? "PREPARATION_REQUIRED"
                : "RUNTIME_UNAVAILABLE",
        };
  }

  async factsFor(
    call: ValidatedToolCall,
    _ceiling: TaskCapabilityCeiling,
    image: PreparedImageRecord,
  ): Promise<TrustedExecutionFacts> {
    const readiness = await this.readiness(image);
    const profile =
      call.name === "run_tests" ||
      call.name === "run_linter" ||
      call.name === "run_typecheck" ||
      call.name === "run_build"
        ? call.arguments.profile
        : "";
    return Object.freeze({
      approvedProfiles: Object.freeze(profile === "" ? [] : [profile]),
      executorReady: readiness.status === "READY",
      readiness,
    });
  }
}
