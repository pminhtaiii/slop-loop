import type {
  PreparedImageRecord,
  SandboxBackend,
  SandboxLimits,
  VerificationEvidence,
} from "./types.js";
import { CleanupExecutionGate } from "./cleanup.js";

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
  ): {
    readonly id: string;
    readonly output: string;
    readonly exitCode: number;
    readonly elapsedSeconds?: number;
  };
  stopAndRemove?(id: string): "CONFIRMED" | "UNCERTAIN";
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
  readiness(image: PreparedImageRecord, limits: SandboxLimits) {
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
      return Promise.resolve("BLOCKED" as const);
    return Promise.resolve("READY" as const);
  }
  executeCheck(input: {
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
      return Promise.reject(new Error("Sandbox runtime not ready"));
    validateFixedArgv(input.target.argv);
    const allowed = new Map([
      ["tests", "pnpm test"],
      ["lint", "pnpm lint"],
      ["typecheck", "pnpm typecheck"],
      ["build", "pnpm build"],
    ]);
    if (allowed.get(input.target.check) !== input.target.argv.join(" "))
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
    if (!/^snapshot:[A-Za-z0-9._-]+$/.test(mount)) throw new Error("Untrusted snapshot mount");
    if (input.runtime.signal.aborted || input.runtime.deadlineAt <= Date.now())
      return Promise.reject(new Error("Sandbox deadline expired"));
    const resourceId = this.docker.registerResource?.();
    let result: ReturnType<DockerPort["run"]> | undefined;
    let cleanup: "CONFIRMED" | "UNCERTAIN" = "UNCERTAIN";
    this.cleanupGate.hold();
    try {
      result = this.docker.run(
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
          ...(resourceId === undefined ? [] : ["--label", `slop-loop.containerId=${resourceId}`]),
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
          `type=bind,src=${mount.slice("snapshot:".length)},dst=/snapshot,readonly`,
          input.image.imageId,
          ...input.target.argv,
        ],
        input.limits,
        { ...input.runtime, resourceId },
      );
    } finally {
      if (result !== undefined) cleanup = this.docker.stopAndRemove?.(result.id) ?? "UNCERTAIN";
      this.cleanupGate.settle({ status: cleanup, attempts: 1 });
    }
    if (result === undefined) throw new Error("Sandbox execution failed");
    const output = result.output.slice(0, input.limits.maxOutputBytes);
    return Promise.resolve({
      check: input.target.check,
      snapshotId: input.snapshot.snapshotId,
      imageId: input.image.imageId,
      status:
        result.exitCode === 0 &&
        result.output.length <= input.limits.maxOutputBytes &&
        !input.runtime.signal.aborted &&
        input.runtime.deadlineAt > Date.now() &&
        (result.elapsedSeconds === undefined ||
          result.elapsedSeconds <= input.limits.timeoutSeconds)
          ? "PASS"
          : "FAIL",
      cleanup,
      output,
      preparationFingerprint: input.image.fingerprint,
      targetId: input.target.targetId,
      taskId: input.target.taskId,
      attemptId: input.target.attemptId,
      nativeIdentity: input.target.nativeIdentity,
      profileSetId: input.target.profileSetId,
    });
  }
}
