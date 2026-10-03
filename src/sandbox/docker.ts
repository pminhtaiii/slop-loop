import type { PreparedImageRecord, SandboxBackend, SandboxLimits, VerificationEvidence } from "./types.js";

export interface DockerPort {
  copySnapshot?(entries: readonly { readonly path: string; readonly content: Buffer; readonly mode: number }[]): string;
  run(argv: readonly string[]): { readonly id: string; readonly output: string; readonly exitCode: number };
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
    if (
      image.status !== "READY" ||
      !/^sha256:[0-9a-f]{64}$/.test(image.imageId) ||
      !image.fingerprint ||
      image.architecture !== "linux-x64" ||
      limits.cpus <= 0 ||
      limits.maxOutputBytes <= 0
    )
      return Promise.resolve("BLOCKED" as const);
    return Promise.resolve("READY" as const);
  }
  executeCheck(input: { readonly snapshot: import("./types.js").VerificationSnapshot; readonly image: PreparedImageRecord; readonly target: { readonly check: string; readonly argv: readonly string[] }; readonly limits: SandboxLimits }): Promise<VerificationEvidence> {
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
    if (this.docker.copySnapshot === undefined) throw new Error("Snapshot materialization unavailable");
    const mount = this.docker.copySnapshot(input.snapshot.entries);
    const result = this.docker.run([
      "run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--mount", mount,
      input.image.imageId, ...input.target.argv,
    ]);
    const cleanup = this.docker.stopAndRemove?.(result.id) ?? "CONFIRMED";
    const output = result.output.slice(0, input.limits.maxOutputBytes);
    return Promise.resolve({
      check: input.target.check,
      snapshotId: input.snapshot.snapshotId,
      imageId: input.image.imageId,
      status: result.exitCode === 0 && result.output.length <= input.limits.maxOutputBytes ? "PASS" : "FAIL",
      cleanup,
      output,
    });
  }
}
