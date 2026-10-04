import { expect, it } from "vitest";
import { DockerCliExecution } from "../../src/sandbox/docker-process.js";
import { requireDockerImage, runDocker } from "./integration-fixtures.js";

for (const owner of ["verification", "unrelated"]) {
  it(`only removes a registered container with verification ownership (${owner})`, async (context) => {
    requireDockerImage(context, "alpine:3.20");
    const docker = new DockerCliExecution();
    const id = docker.registerResource();
    runDocker([
      "create",
      "--name",
      id,
      "--label",
      `slop-loop.owner=${owner}`,
      "--label",
      `slop-loop.containerId=${id}`,
      "--label",
      "slop-loop.taskId=fixture",
      "alpine:3.20",
      "true",
    ]);
    try {
      const status = await docker.stopAndRemove(id);
      expect(status).toBe(owner === "verification" ? "CONFIRMED" : "UNCERTAIN");
      const exists = runDocker([
        "container",
        "ls",
        "--all",
        "--quiet",
        "--filter",
        `name=^/${id}$`,
      ]);
      expect(exists.length > 0).toBe(owner !== "verification");
    } finally {
      runDocker(["rm", "--force", "--", id]);
    }
  });
}
