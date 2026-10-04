import { execFileSync } from "node:child_process";
import { beforeAll } from "vitest";
import type { TestContext } from "vitest";

const DOCKER_UNAVAILABLE = "UNAVAILABLE: Local Docker daemon is not accessible";
const IMAGE_UNAVAILABLE = "UNAVAILABLE: Required Docker integration image is not available";

export function dockerServerVersion(): string | undefined {
  try {
    const output = execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

type SkipContext = Pick<TestContext, "skip">;

export function requireDocker(context: SkipContext): string {
  const version = dockerServerVersion();
  if (version === undefined) context.skip(DOCKER_UNAVAILABLE);
  return version ?? "";
}

export function requireDockerImage(context: SkipContext, image: string): void {
  requireDocker(context);
  try {
    execFileSync("docker", ["image", "inspect", "--", image], {
      stdio: "ignore",
      timeout: 5_000,
    });
  } catch {
    context.skip(IMAGE_UNAVAILABLE);
  }
}

export function runDocker(args: readonly string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}

export function dockerContainerExists(id: string): boolean {
  try {
    runDocker(["inspect", "--format", "{{.Id}}", "--", id]);
    return true;
  } catch {
    return false;
  }
}

export function installDockerGate(setup: () => void): void {
  beforeAll(setup);
}

export const dockerUnavailableMessage = DOCKER_UNAVAILABLE;
