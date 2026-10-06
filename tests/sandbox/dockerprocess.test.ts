import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import { promisify } from "node:util";
import { DockerCliExecution } from "../../src/sandbox/dockerprocess.js";
import { DEFAULT_SANDBOX_LIMITS } from "../../src/sandbox/config.js";

const { execFileMock } = vi.hoisted(() => {
  const fn = vi.fn();
  (fn as unknown as { [key: symbol]: unknown })[Symbol.for("nodejs.util.promisify.custom")] =
    vi.fn();
  return { execFileMock: fn };
});

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
    execFile: execFileMock,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function child() {
  return Object.assign(new ChildProcess(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}

it.each(["deadline", "abort"])(
  "stops the registered container on %s while Docker is running",
  async (cause) => {
    vi.useFakeTimers();
    const process = child();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    vi.mocked(spawn).mockImplementation((_command, _args, options) => {
      signal = options?.signal;
      signal?.addEventListener("abort", () => {
        process.emit("error", new Error("aborted"));
        process.emit("close", null);
      });
      return process;
    });
    const docker = new DockerCliExecution();
    const resourceId = docker.registerResource();
    const cleanup = vi.spyOn(docker, "stopAndRemove").mockResolvedValue("CONFIRMED");
    const running = docker.run(["run"], DEFAULT_SANDBOX_LIMITS, {
      resourceId,
      signal: controller.signal,
      deadlineAt: Date.now() + 5000,
    });
    const rejected = expect(running).rejects.toThrow();
    expect(signal?.aborted).toBe(false);
    if (cause === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledWith(resourceId);
    expect(spawn).toHaveBeenCalledWith(
      "docker",
      ["run"],
      expect.objectContaining({ shell: false, signal, killSignal: "SIGKILL" }),
    );
  },
);

it("passes allowlisted environment to spawn and strips unapproved environment variables", async () => {
  const childProcess = child();
  let spawnOptions: { env?: Record<string, string | undefined> } | undefined;
  vi.mocked(spawn).mockImplementation((_command, _args, options) => {
    spawnOptions = options;
    return childProcess;
  });

  process.env.POISON_UNAPPROVED_VAR = "secret";
  try {
    const docker = new DockerCliExecution();
    const resourceId = docker.registerResource();
    const running = docker.run(["run"], DEFAULT_SANDBOX_LIMITS, {
      resourceId,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5000,
    });
    childProcess.emit("close", 0);
    await running;

    expect(spawnOptions?.env).toBeDefined();
    expect(spawnOptions?.env).not.toHaveProperty("POISON_UNAPPROVED_VAR");
    expect(spawnOptions?.env?.PATH).toBeDefined();
  } finally {
    delete process.env.POISON_UNAPPROVED_VAR;
  }
});

it("collects output asynchronously and returns only after process close", async () => {
  const process = child();
  vi.mocked(spawn).mockReturnValue(process);
  const docker = new DockerCliExecution();
  const resourceId = docker.registerResource();
  const running = docker.run(["run"], DEFAULT_SANDBOX_LIMITS, {
    resourceId,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5000,
  });
  process.stdout.write("output");
  process.stderr.write("error");
  process.emit("close", 0);
  await expect(running).resolves.toMatchObject({
    id: resourceId,
    output: "outputerror",
    exitCode: 0,
  });
});

it("aborts process, cleans up, and resolves with truncated output when combined stdout and stderr exceed the byte limit", async () => {
  const process = child();
  let signal: AbortSignal | undefined;
  vi.mocked(spawn).mockImplementation((_command, _args, options) => {
    signal = options?.signal;
    signal?.addEventListener("abort", () => process.emit("close", 137));
    return process;
  });
  const docker = new DockerCliExecution();
  const resourceId = docker.registerResource();
  const cleanup = vi.spyOn(docker, "stopAndRemove").mockResolvedValue("CONFIRMED");
  const running = docker.run(
    ["run"],
    { ...DEFAULT_SANDBOX_LIMITS, maxOutputBytes: 3 },
    {
      resourceId,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 5000,
    },
  );
  process.stdout.write("é");
  expect(signal?.aborted).toBe(false);
  process.stderr.write("é");
  const result = await running;
  expect(signal?.aborted).toBe(true);
  expect(cleanup).toHaveBeenCalledWith(resourceId);
  expect(result.id).toBe(resourceId);
  expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(3);
  expect(result.exitCode).toBe(137);
});

it("stopAndRemove uses allowlisted environment and verifies labels with strict Zod schema", async () => {
  const customExec = (execFileMock as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[
    promisify.custom
  ]!;
  const execCalls: { args: readonly string[]; env?: Record<string, string | undefined> }[] = [];
  customExec.mockImplementation(
    (
      _cmd: string,
      args: readonly string[],
      options: { env?: Record<string, string | undefined> },
    ) => {
      execCalls.push({ args, env: options?.env });
      const sub = args[0];
      if (sub === "container") {
        return Promise.resolve({ stdout: "container-abc-123\n", stderr: "" });
      }
      if (sub === "inspect") {
        return Promise.resolve({
          stdout: JSON.stringify({
            "slop-loop.owner": "verification",
            "slop-loop.containerId": "test-res-id",
            "slop-loop.taskId": "task-xyz",
          }),
          stderr: "",
        });
      }
      if (sub === "rm") {
        return Promise.resolve({ stdout: "container-abc-123\n", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    },
  );

  const docker = new DockerCliExecution();
  (docker as unknown as { resources: Set<string> })["resources"].add("test-res-id");

  // On second call to container ls, return empty string to indicate removal confirmed
  customExec
    .mockImplementationOnce(
      (
        _cmd: string,
        args: readonly string[],
        options: { env?: Record<string, string | undefined> },
      ) => {
        execCalls.push({ args, env: options?.env });
        return Promise.resolve({ stdout: "container-abc-123\n", stderr: "" });
      },
    )
    .mockImplementationOnce(
      (
        _cmd: string,
        args: readonly string[],
        options: { env?: Record<string, string | undefined> },
      ) => {
        execCalls.push({ args, env: options?.env });
        return Promise.resolve({
          stdout: JSON.stringify({
            "slop-loop.owner": "verification",
            "slop-loop.containerId": "test-res-id",
            "slop-loop.taskId": "task-xyz",
          }),
          stderr: "",
        });
      },
    )
    .mockImplementationOnce(
      (
        _cmd: string,
        args: readonly string[],
        options: { env?: Record<string, string | undefined> },
      ) => {
        execCalls.push({ args, env: options?.env });
        return Promise.resolve({ stdout: "container-abc-123\n", stderr: "" });
      },
    )
    .mockImplementationOnce(
      (
        _cmd: string,
        args: readonly string[],
        options: { env?: Record<string, string | undefined> },
      ) => {
        execCalls.push({ args, env: options?.env });
        return Promise.resolve({ stdout: "", stderr: "" });
      },
    );

  const status = await docker.stopAndRemove("test-res-id");
  expect(status).toBe("CONFIRMED");
  expect(execCalls.length).toBeGreaterThan(0);
  for (const call of execCalls) {
    expect(call.env).toBeDefined();
    expect(call.env?.PATH).toBeDefined();
  }
});

it("stopAndRemove returns UNCERTAIN if container labels fail schema validation", async () => {
  const customExec = (execFileMock as unknown as Record<symbol, ReturnType<typeof vi.fn>>)[
    promisify.custom
  ]!;
  customExec.mockImplementation((_cmd: string, args: readonly string[]) => {
    const sub = args[0];
    if (sub === "container") {
      return Promise.resolve({ stdout: "container-abc-123\n", stderr: "" });
    }
    if (sub === "inspect") {
      // Invalid: missing slop-loop.taskId
      return Promise.resolve({
        stdout: JSON.stringify({
          "slop-loop.owner": "verification",
          "slop-loop.containerId": "test-res-id",
        }),
        stderr: "",
      });
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  });

  const docker = new DockerCliExecution();
  (docker as unknown as { resources: Set<string> })["resources"].add("test-res-id");

  const status = await docker.stopAndRemove("test-res-id");
  expect(status).toBe("UNCERTAIN");
});
