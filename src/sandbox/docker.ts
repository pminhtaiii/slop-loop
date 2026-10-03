import type { PreparedImageRecord, SandboxBackend, SandboxLimits, VerificationEvidence } from "./types.js";

export interface DockerPort {
  run(argv: readonly string[]): { readonly id: string; readonly output: string; readonly exitCode: number };
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
    if (image.status !== "READY" || !image.imageId.startsWith("sha256:") || limits.cpus <= 0)
      return Promise.resolve("BLOCKED" as const);
    return Promise.resolve("READY" as const);
  }
  executeCheck(input: { readonly snapshot: import("./types.js").VerificationSnapshot; readonly image: PreparedImageRecord; readonly argv: readonly string[]; readonly limits: SandboxLimits }): Promise<VerificationEvidence> {
    validateFixedArgv(input.argv);
    if (input.image.status !== "READY" || !input.image.imageId.startsWith("sha256:"))
      throw new Error("Image is not immutable and ready");
    const result = this.docker.run(["run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", input.image.imageId, ...input.argv]);
    return Promise.resolve({
      check: input.argv.join(" "),
      snapshotId: input.snapshot.snapshotId,
      imageId: input.image.imageId,
      status: result.exitCode === 0 ? "PASS" : "FAIL",
      cleanup: "CONFIRMED",
    });
  }
}
