import { isAbsolute, normalize, parse } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  PreparedImageRecord,
  SandboxBackend,
  SandboxLimits,
  SandboxReadiness,
  VerificationEvidence,
} from "./types.js";
import { CleanupExecutionGate } from "./cleanup.js";
import { mapVerificationTarget } from "./config.js";

export interface DockerPort {
  readiness(): {
    readonly networkDisabled: boolean;
    readonly limitsEnforced: boolean;
    readonly readOnlyMounts: boolean;
  };
  inspectImage(imageId: string): {
    readonly imageId: string;
    readonly fingerprint: string;
    readonly architecture: string;
  };
  copySnapshot?(
    entries: readonly { readonly path: string; readonly content: Buffer; readonly mode: number }[],
  ): string;
  registerResource?(): string;
  run(
    argv: readonly string[],
    limits: SandboxLimits,
    runtime: {
      readonly signal: AbortSignal;
      readonly deadlineAt: number;
      readonly resourceId?: string;
    },
  ): Promise<{
    readonly id: string;
    readonly output: string;
    readonly exitCode: number;
    readonly elapsedSeconds?: number;
  }>;
  stopAndRemove?(id: string): Promise<"CONFIRMED" | "UNCERTAIN">;
}

export function validateFixedArgv(argv: readonly string[]): void {
  const first = argv[0];
  if (
    argv.length === 0 ||
    first !== "pnpm" ||
    argv.some((part) => !/^[A-Za-z0-9_./:@+-]+$/.test(part)) ||
    argv.some((part) => /[;&|$`()<>*\n\r]/.test(part))
  )
    throw new Error("Unsafe fixed argv");
}

export class DockerSandboxBackend implements SandboxBackend {
  private readonly cleanupGate = new CleanupExecutionGate();

  constructor(private readonly docker: DockerPort) {}
  readiness(image: PreparedImageRecord, limits: SandboxLimits): Promise<SandboxReadiness> {
    if (!this.cleanupGate.canStart())
      return Promise.resolve({ status: "BLOCKED", reason: "CLEANUP_UNCONFIRMED" });
    if (image.status === "MISSING")
      return Promise.resolve({ status: "BLOCKED", reason: "PREPARATION_REQUIRED" });
    if (image.status === "STALE")
      return Promise.resolve({ status: "BLOCKED", reason: "IMAGE_STALE" });
    const runtime = this.docker.readiness();
    if (
      image.status !== "READY" ||
      !/^sha256:[0-9a-f]{64}$/.test(image.imageId) ||
      !image.fingerprint ||
      image.architecture !== "linux-x64" ||
      limits.cpus <= 0 ||
      limits.maxOutputBytes <= 0 ||
      !runtime.networkDisabled ||
      !runtime.limitsEnforced ||
      !runtime.readOnlyMounts ||
      !this.cleanupGate.canStart()
    )
      return Promise.resolve({ status: "BLOCKED", reason: "RUNTIME_UNAVAILABLE" });
    return Promise.resolve({ status: "READY" });
  }
  async executeCheck(input: {
    readonly snapshot: import("./types.js").VerificationSnapshot;
    readonly image: PreparedImageRecord;
    readonly target: {
      readonly check: string;
      readonly argv: readonly string[];
      readonly profileSetId: string;
      readonly targetId: string;
      readonly taskId: string;
      readonly attemptId: string;
      readonly nativeIdentity: string;
    };
    readonly limits: SandboxLimits;
    readonly runtime: { readonly signal: AbortSignal; readonly deadlineAt: number };
  }): Promise<VerificationEvidence> {
    const runtime = this.docker.readiness();
    if (
      !runtime.networkDisabled ||
      !runtime.limitsEnforced ||
      !runtime.readOnlyMounts ||
      !this.cleanupGate.canStart()
    )
      throw new Error("Sandbox runtime not ready");
    validateFixedArgv(input.target.argv);
    const checkToTool: Record<string, [string, string]> = {
      tests: ["run_tests", "ordinary"],
      lint: ["run_linter", "lint"],
      typecheck: ["run_typecheck", "typecheck"],
      build: ["run_build", "build"],
    };
    const mapped = checkToTool[input.target.check];
    let approvedTarget: { readonly argv: readonly string[]; readonly check: string };
    try {
      if (!mapped) throw new Error("Unapproved logical verification target");
      approvedTarget = mapVerificationTarget(mapped[0], mapped[1]);
    } catch {
      throw new Error("Unapproved logical verification target");
    }
    if (
      approvedTarget.argv.length !== input.target.argv.length ||
      approvedTarget.argv.some((arg, index) => arg !== input.target.argv[index])
    )
      throw new Error("Unapproved logical verification target");
    if (
      input.image.status !== "READY" ||
      !/^sha256:[0-9a-f]{64}$/.test(input.image.imageId) ||
      !input.image.fingerprint ||
      input.image.architecture !== "linux-x64"
    )
      throw new Error("Image is not immutable and ready");
    const inspected = this.docker.inspectImage(input.image.imageId);
    if (
      inspected.imageId !== input.image.imageId ||
      inspected.fingerprint !== input.image.fingerprint ||
      inspected.architecture !== input.image.architecture
    )
      throw new Error("Prepared image identity mismatch");
    if (this.docker.copySnapshot === undefined)
      throw new Error("Snapshot materialization unavailable");
    const mount = this.docker.copySnapshot(input.snapshot.entries);
    if (
      !isAbsolute(mount) ||
      normalize(mount) !== mount ||
      mount === parse(mount).root ||
      /[,"]/u.test(mount) ||
      [...mount].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error("Untrusted snapshot mount");
    if (input.runtime.signal.aborted || input.runtime.deadlineAt <= Date.now())
      throw new Error("Sandbox deadline expired");
    const resourceId = this.docker.registerResource?.() ?? `slop-loop-${randomUUID()}`;
    let result: Awaited<ReturnType<DockerPort["run"]>> | undefined;
    let cleanup: "CONFIRMED" | "UNCERTAIN" = "UNCERTAIN";
    this.cleanupGate.hold();
    try {
      result = await this.docker.run(
        [
          "run",
          "--rm",
          "--user",
          "1000:1000",
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--label",
          "slop-loop.owner=verification",
          "--label",
          `slop-loop.taskId=${input.target.taskId}`,
          "--label",
          `slop-loop.containerId=${resourceId}`,
          "--name",
          resourceId,
          "--tmpfs",
          `/tmp:rw,nosuid,nodev,noexec,size=268435456`,
          "--tmpfs",
          `/workspace:rw,nosuid,nodev,size=2147483648`,
          "--cpus",
          String(input.limits.cpus),
          "--memory",
          String(input.limits.memoryBytes),
          "--pids-limit",
          String(input.limits.maxPids),
          "--mount",
          `type=bind,src=${mount},dst=/snapshot,readonly`,
          "--workdir",
          "/snapshot",
          input.image.imageId,
          ...input.target.argv,
        ],
        input.limits,
        { ...input.runtime, resourceId },
      );
    } finally {
      try {
        cleanup = (await this.docker.stopAndRemove?.(result?.id ?? resourceId)) ?? "UNCERTAIN";
      } finally {
        this.cleanupGate.settle({ status: cleanup, attempts: 1 });
      }
    }
    if (result === undefined) throw new Error("Sandbox execution failed");
    const bytes = Buffer.from(result.output, "utf8");
    const overflow = bytes.length > input.limits.maxOutputBytes;
    let end = Math.min(bytes.length, input.limits.maxOutputBytes);
    while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    const output = bytes.subarray(0, end).toString("utf8");
    return {
      check: input.target.check,
      snapshotId: input.snapshot.snapshotId,
      imageId: input.image.imageId,
      status:
        result.exitCode === 0 &&
        !overflow &&
        !input.runtime.signal.aborted &&
        input.runtime.deadlineAt > Date.now() &&
        (result.elapsedSeconds === undefined ||
          result.elapsedSeconds <= input.limits.timeoutSeconds)
          ? "PASS"
          : "FAIL",
      cleanup,
      output,
      exitCode: result.exitCode,
      truncated: overflow,
      preparationFingerprint: input.image.fingerprint,
      targetId: input.target.targetId,
      taskId: input.target.taskId,
      attemptId: input.target.attemptId,
      nativeIdentity: input.target.nativeIdentity,
      profileSetId: input.target.profileSetId,
    };
  }
}
