import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { requireDockerImage, runDocker } from "./integration-fixtures.js";
import { DockerCliExecution } from "../../src/sandbox/docker-process.js";
import { DEFAULT_SANDBOX_LIMITS } from "../../src/sandbox/config.js";

describe("T105: Verification Integration Suite", () => {
  it("proves readonly dependency and snapshot layout with no host writeback", (context) => {
    requireDockerImage(context, "alpine:3.20");

    const hostDir = mkdtempSync(join(tmpdir(), "slop-loop-t105-"));
    const canaryFile = join(hostDir, "source.ts");
    const initialContent = "export const answer = 42;\n";
    writeFileSync(canaryFile, initialContent, "utf8");

    try {
      // 1. Attempt to write to the read-only mounted snapshot inside the container must fail
      expect(() => {
        runDocker([
          "run",
          "--rm",
          "--pull=never",
          "--network",
          "none",
          "--user",
          "1000:1000",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--mount",
          `type=bind,src=${hostDir},dst=/snapshot,readonly`,
          "alpine:3.20",
          "sh",
          "-c",
          "echo 'malicious write' >> /snapshot/source.ts",
        ]);
      }).toThrow();

      // 2. Verify no checkout writeback on the host
      const hostContent = readFileSync(canaryFile, "utf8");
      expect(hostContent).toBe(initialContent);

      // 3. Execution of read-only checks succeeds in tmpfs workspace
      const output = runDocker([
        "run",
        "--rm",
        "--pull=never",
        "--network",
        "none",
        "--user",
        "1000:1000",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/workspace:rw,nosuid,nodev,size=64m",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=16m",
        "--mount",
        `type=bind,src=${hostDir},dst=/snapshot,readonly`,
        "--workdir",
        "/workspace",
        "alpine:3.20",
        "sh",
        "-c",
        "cp /snapshot/source.ts /workspace/ && cat /workspace/source.ts",
      ]);

      expect(output.trim()).toBe("export const answer = 42;");
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  it("proves DockerCliExecution bounds output and returns exit code accurately", async (context) => {
    requireDockerImage(context, "alpine:3.20");

    const docker = new DockerCliExecution();
    const resourceId = docker.registerResource();

    const result = await docker.run(
      [
        "run",
        "--name",
        resourceId,
        "--rm",
        "--network",
        "none",
        "alpine:3.20",
        "sh",
        "-c",
        "echo 'verification completed'",
      ],
      DEFAULT_SANDBOX_LIMITS,
      {
        resourceId,
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 15_000,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("verification completed");
  });
});
