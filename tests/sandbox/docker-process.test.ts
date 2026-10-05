import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { ChildProcess, spawn } from "node:child_process";
import { DockerCliExecution } from "../../src/sandbox/docker-process.js";
import { DEFAULT_SANDBOX_LIMITS } from "../../src/sandbox/config.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
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
      deadlineAt: Date.now() + 50,
    });
    const rejected = expect(running).rejects.toThrow();
    expect(signal?.aborted).toBe(false);
    if (cause === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(50);
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

it("aborts and cleans up when combined stdout and stderr exceed the byte limit", async () => {
  const process = child();
  let signal: AbortSignal | undefined;
  vi.mocked(spawn).mockImplementation((_command, _args, options) => {
    signal = options?.signal;
    signal?.addEventListener("abort", () => process.emit("close", null));
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
  const rejected = expect(running).rejects.toThrow("aborted");
  process.stdout.write("é");
  expect(signal?.aborted).toBe(false);
  process.stderr.write("é");
  await rejected;
  expect(cleanup).toHaveBeenCalledWith(resourceId);
});
