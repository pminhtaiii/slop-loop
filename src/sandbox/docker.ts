import type { PreparedImageRecord, SandboxBackend, SandboxLimits, VerificationEvidence } from "./types.js";

export interface DockerPort {
  readiness(): { readonly networkDisabled: boolean; readonly limitsEnforced: boolean; readonly readOnlyMounts: boolean };
  inspectImage(imageId: string): { readonly imageId: string; readonly fingerprint: string; readonly architecture: string };
  copySnapshot?(entries: readonly { readonly path: string; readonly content: Buffer; readonly mode: number }[]): string;
  run(argv: readonly string[], limits: SandboxLimits): { readonly id: string; readonly output: string; readonly exitCode: number; readonly elapsedSeconds?: number };
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
  constructor(private readonly docker: DockerPort) {}
  readiness(image: PreparedImageRecord, limits: SandboxLimits) {
    const runtime = this.docker.readiness();
    if (
      image.status !== "READY" ||
      !/^sha256:[0-9a-f]{64}$/.test(image.imageId) ||
      !image.fingerprint ||
      image.architecture !== "linux-x64" ||
      limits.cpus <= 0 ||
      limits.maxOutputBytes <= 0
      || !runtime.networkDisabled
      || !runtime.limitsEnforced
      || !runtime.readOnlyMounts
    )
      return Promise.resolve("BLOCKED" as const);
    return Promise.resolve("READY" as const);
  }
  executeCheck(input: { readonly snapshot: import("./types.js").VerificationSnapshot; readonly image: PreparedImageRecord; readonly target: { readonly check: string; readonly argv: readonly string[] }; readonly limits: SandboxLimits }): Promise<VerificationEvidence> {
    const runtime = this.docker.readiness();
    if (!runtime.networkDisabled || !runtime.limitsEnforced || !runtime.readOnlyMounts)
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
    if (this.docker.copySnapshot === undefined) throw new Error("Snapshot materialization unavailable");
    const mount = this.docker.copySnapshot(input.snapshot.entries);
    if (!/^snapshot:[A-Za-z0-9._-]+$/.test(mount)) throw new Error("Untrusted snapshot mount");
    let result: ReturnType<DockerPort["run"]> | undefined;
    let cleanup: "CONFIRMED" | "UNCERTAIN" = "UNCERTAIN";
    try {
      result = this.docker.run([
        "run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges", "--cpus", String(input.limits.cpus),
        "--memory", String(input.limits.memoryBytes), "--pids-limit", String(input.limits.maxPids),
        "--mount", `type=bind,src=${mount.slice("snapshot:".length)},dst=/snapshot,readonly`,
        input.image.imageId, ...input.target.argv,
      ], input.limits);
    } finally {
      if (result !== undefined) cleanup = this.docker.stopAndRemove?.(result.id) ?? "UNCERTAIN";
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
        (result.elapsedSeconds === undefined || result.elapsedSeconds <= input.limits.timeoutSeconds)
          ? "PASS"
          : "FAIL",
      cleanup,
      output,
      preparationFingerprint: input.image.fingerprint,
      profileSetId: "profiles-v1",
      targetId: `${input.target.check}:${input.target.argv.join(" ")}`,
      taskId: "sandbox-task",
      attemptId: "sandbox-attempt",
      nativeIdentity: "native-v1",
    });
  }
}
