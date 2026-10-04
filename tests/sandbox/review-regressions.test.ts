import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { DockerSandboxBackend, type DockerPort } from "../../src/sandbox/docker.js";
import { SandboxGateway } from "../../src/sandbox/gateway.js";
import { DEFAULT_SANDBOX_LIMITS } from "../../src/sandbox/config.js";
import { createTaskCapabilityCeiling } from "../../src/policy/engine.js";
import { createTaskBudget } from "../../src/orchestration/budget.js";

const image = {
  imageId: `sha256:${"a".repeat(64)}`,
  fingerprint: "prep",
  architecture: "linux-x64",
  status: "READY" as const,
};
const input = () => ({
  image,
  snapshot: {
    formatVersion: 1 as const,
    workspaceId: "workspace",
    exclusionPolicyId: "default",
    entries: [],
    totalBytes: 0,
    snapshotId: "snapshot",
  },
  target: {
    check: "tests",
    argv: ["pnpm", "test"],
    profileSetId: "profiles",
    targetId: "tests",
    taskId: "task",
    attemptId: "attempt",
    nativeIdentity: "native",
  },
  limits: DEFAULT_SANDBOX_LIMITS,
  runtime: { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 },
});
function port(overrides: Partial<DockerPort> = {}): DockerPort {
  return {
    readiness: () => ({ networkDisabled: true, limitsEnforced: true, readOnlyMounts: true }),
    inspectImage: () => image,
    copySnapshot: () => resolve("staging", "snapshot"),
    registerResource: () => "owned-container",
    run: () => Promise.resolve({ id: "owned-container", output: "ok", exitCode: 0 }),
    stopAndRemove: () => Promise.resolve("CONFIRMED"),
    ...overrides,
  };
}

it("awaits execution and cleanup and uses the absolute snapshot as the working directory", async () => {
  const run = vi.fn((...args: Parameters<DockerPort["run"]>) => port().run(...args));
  const stopAndRemove = vi
    .fn<(id: string) => Promise<"CONFIRMED">>()
    .mockResolvedValue("CONFIRMED");
  const backend = new DockerSandboxBackend(port({ run, stopAndRemove }));
  await expect(backend.executeCheck(input())).resolves.toMatchObject({
    status: "PASS",
    output: "ok",
    cleanup: "CONFIRMED",
  });
  expect(run.mock.calls[0]?.[0]).toEqual(
    expect.arrayContaining([
      `type=bind,src=${resolve("staging", "snapshot")},dst=/snapshot,readonly`,
      "--workdir",
      "/snapshot",
    ]),
  );
  expect(stopAndRemove).toHaveBeenCalledWith("owned-container");
});

it.each(["snapshot:mount", "relative/path", "/tmp/staging,dst=/host", "/tmp/staging\n"])(
  "rejects unsafe staging path %s as a promise rejection",
  async (mount) => {
    const run = vi.fn((...args: Parameters<DockerPort["run"]>) => port().run(...args));
    const backend = new DockerSandboxBackend(port({ copySnapshot: () => mount, run }));
    await expect(backend.executeCheck(input())).rejects.toThrow("Untrusted snapshot mount");
    expect(run).not.toHaveBeenCalled();
  },
);

it.each(["validation", "inspect", "copy"])(
  "returns %s failures as promise rejections",
  async (step) => {
    const request = input();
    if (step === "validation") request.target.argv = ["sh", "-c", "evil"];
    const fail = () => {
      throw new Error("fixture failure");
    };
    const backend = new DockerSandboxBackend(
      port({
        ...(step === "inspect" ? { inspectImage: fail } : {}),
        ...(step === "copy" ? { copySnapshot: fail } : {}),
      }),
    );
    await expect(backend.executeCheck(request)).rejects.toThrow();
  },
);

it.each([
  ["éé", 3, "é", "FAIL"],
  ["a😀b", 4, "a", "FAIL"],
  ["a😀", 5, "a😀", "PASS"],
])("caps UTF-8 output %s at %i bytes", async (output, maxOutputBytes, expected, status) => {
  const backend = new DockerSandboxBackend(
    port({ run: () => Promise.resolve({ id: "owned-container", output, exitCode: 0 }) }),
  );
  const request = input();
  const evidence = await backend.executeCheck({
    ...request,
    limits: { ...request.limits, maxOutputBytes },
  });
  expect(evidence).toMatchObject({ output: expected, status });
  expect(Buffer.byteLength(evidence.output!)).toBeLessThanOrEqual(maxOutputBytes);
});

it("cleans the registered container after a rejected run and reports cleanup blockers", async () => {
  const cleanup = vi.fn(() => Promise.resolve("UNCERTAIN" as const));
  const backend = new DockerSandboxBackend(
    port({
      run: () => {
        return Promise.reject(new Error("aborted"));
      },
      stopAndRemove: cleanup,
    }),
  );
  await expect(backend.executeCheck(input())).rejects.toThrow("aborted");
  expect(cleanup).toHaveBeenCalledWith("owned-container");
  await expect(
    new SandboxGateway(backend, DEFAULT_SANDBOX_LIMITS).readiness(image),
  ).resolves.toEqual({ status: "EXTERNAL_BLOCKER", reason: "CLEANUP_UNCONFIRMED" });
});

const ceiling = createTaskCapabilityCeiling({
  taskId: "task",
  sessionId: "session",
  workspaceId: "workspace",
  mode: "Edit",
  eligibleTools: ["run_tests", "read_file"],
  resources: createTaskBudget("Medium"),
});
it("does not approve a profile supplied by the call", async () => {
  const gateway = new SandboxGateway(new DockerSandboxBackend(port()), DEFAULT_SANDBOX_LIMITS);
  const facts = await gateway.factsFor(
    { name: "run_tests", arguments: { profile: "forged" } },
    ceiling,
    image,
  );
  expect(facts?.approvedProfiles).toEqual(["ordinary"]);
  expect(facts?.executorReady).toBe(true);
});
it("returns no execution facts or readiness checks for inspection tools", async () => {
  const readiness = vi.fn(() => port().readiness());
  const gateway = new SandboxGateway(
    new DockerSandboxBackend(port({ readiness })),
    DEFAULT_SANDBOX_LIMITS,
  );
  await expect(
    gateway.factsFor({ name: "read_file", arguments: { path: "index.ts" } }, ceiling, image),
  ).resolves.toBeUndefined();
  expect(readiness).not.toHaveBeenCalled();
});
