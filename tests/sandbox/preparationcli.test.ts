import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createPreparationDockerCli } from "../../src/sandbox/preparationcli.js";
import { localPreparationDockerIO } from "../../src/sandbox/preparationio.js";
import { localPreparationDockerCommand } from "../../src/sandbox/preparationnetwork.js";

const { controlledSpawn } = vi.hoisted(() => ({
  controlledSpawn: vi.fn<(executable: string, argv: readonly string[]) => unknown>(),
}));
const { controlledExecFile } = vi.hoisted(() => ({
  controlledExecFile:
    vi.fn<
      (
        executable: string,
        argv: readonly string[],
        options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => unknown
    >(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: controlledSpawn,
  execFile: controlledExecFile,
}));

const leftovers: string[] = [];
afterEach(() => {
  controlledSpawn.mockReset();
  controlledExecFile.mockReset();
  for (const root of leftovers.splice(0))
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
});
it("uses a fixed local endpoint and an owned empty config instead of developer credentials", () => {
  const cli = createPreparationDockerCli();
  const root = cli.prefix[3]!;
  leftovers.push(root);
  expect(cli.prefix).toEqual([
    "--host",
    process.platform === "win32"
      ? "npipe:////./pipe/dockerDesktopLinuxEngine"
      : "unix:///var/run/docker.sock",
    "--config",
    root,
  ]);
  expect(fs.readdirSync(root)).toEqual(["config.json"]);
  expect(fs.readFileSync(root + "/config.json", "utf8")).toBe("{}\n");
  cli.dispose();
  expect(fs.existsSync(root)).toBe(false);
  expect(() => cli.dispose()).not.toThrow();
});
it("refuses to delete a replacement directory when config ownership changes", () => {
  const cli = createPreparationDockerCli();
  const root = cli.prefix[3]!,
    moved = root + "-held";
  leftovers.push(root, moved);
  fs.renameSync(root, moved);
  fs.mkdirSync(root);
  fs.writeFileSync(root + "/keep", "unrelated");
  expect(() => cli.dispose()).toThrow("cleanup unconfirmed");
  expect(fs.readFileSync(root + "/keep", "utf8")).toBe("unrelated");
  expect(fs.readFileSync(moved + "/config.json", "utf8")).toBe("{}\n");
});
it("keeps the isolated config until the binary subprocess closes, including an earlier error event", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  controlledSpawn.mockReturnValue(child);
  const request = localPreparationDockerIO(
    [
      "exec",
      "-i",
      "a".repeat(64),
      "node",
      "/opt/slop-loop-preparation/preparationworker.js",
      "fetch",
    ],
    Buffer.from("{}"),
    new AbortController().signal,
  );
  const argv = controlledSpawn.mock.calls[0]![1];
  const root = argv[3]!;
  leftovers.push(root);
  expect(controlledSpawn.mock.calls[0]![0]).toBe("docker");
  expect(argv.slice(0, 4)).toEqual([
    "--host",
    process.platform === "win32"
      ? "npipe:////./pipe/dockerDesktopLinuxEngine"
      : "unix:///var/run/docker.sock",
    "--config",
    root,
  ]);
  let settled = false;
  void request.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  child.emit("error", new Error("Controlled subprocess error"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(fs.readFileSync(root + "/config.json", "utf8")).toBe("{}\n");
  child.emit("close", 1);
  await expect(request).rejects.toThrow("Controlled subprocess error");
  expect(fs.existsSync(root)).toBe(false);
});
it("retains text-command configuration until close even if the exec callback reports an error first", async () => {
  const child = new EventEmitter();
  controlledExecFile.mockReturnValue(child);
  const request = localPreparationDockerCommand(
    ["info", "--format", "{{json .}}"],
    new AbortController().signal,
  );
  const args = controlledExecFile.mock.calls[0]![1],
    root = args[3]!;
  leftovers.push(root);
  let settled = false;
  void request.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  controlledExecFile.mock.calls[0]![3](new Error("Controlled early callback error"), "", "");
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(fs.existsSync(root)).toBe(true);
  child.emit("close", 1);
  await expect(request).rejects.toThrow("Controlled early callback error");
  expect(fs.existsSync(root)).toBe(false);
});
