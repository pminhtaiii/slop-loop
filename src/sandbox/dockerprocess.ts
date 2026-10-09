import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { DockerPort } from "./docker.js";

const execDocker = promisify(execFile);

function allowlistedDockerEnv(): Record<string, string> {
  const allowlist: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    DOCKER_HOST: process.env.DOCKER_HOST,
    HOME: process.env.HOME,
    USER: process.env.USER,
    SYSTEMROOT: process.env.SystemRoot ?? process.env.SYSTEMROOT,
    WINDIR: process.env.windir ?? process.env.WINDIR,
  };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(allowlist)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

const containerLabelsSchema = z
  .object({
    "slop-loop.owner": z.literal("verification"),
    "slop-loop.containerId": z.string().min(1),
    "slop-loop.taskId": z.string().min(1),
  })
  .catchall(z.unknown());

export function truncateUtf8(buf: Buffer, maxBytes: number): string {
  let len = Math.min(buf.length, maxBytes);
  let i = len;
  while (i > 0 && (buf[i - 1]! & 0xc0) === 0x80) {
    i--;
  }
  if (i > 0 && (buf[i - 1]! & 0x80) !== 0) {
    const lead = buf[i - 1]!;
    let expectedLength = 1;
    if ((lead & 0xe0) === 0xc0) expectedLength = 2;
    else if ((lead & 0xf0) === 0xe0) expectedLength = 3;
    else if ((lead & 0xf8) === 0xf0) expectedLength = 4;

    if (len - (i - 1) < expectedLength) {
      len = i - 1;
    }
  }
  return buf.subarray(0, len).toString("utf8");
}

/** Process operations composed with trusted readiness, image inspection and staging ports. */
export class DockerCliExecution {
  private readonly resources = new Set<string>();
  private readonly running = new Set<string>();

  registerResource(): string {
    const id = `slop-loop-${randomUUID()}`;
    this.resources.add(id);
    return id;
  }

  async run(
    argv: Parameters<DockerPort["run"]>[0],
    limits: Parameters<DockerPort["run"]>[1],
    runtime: Parameters<DockerPort["run"]>[2],
  ): ReturnType<DockerPort["run"]> {
    const id = runtime.resourceId;
    if (id === undefined || !this.resources.has(id)) throw new Error("Unregistered container");
    const remaining = Math.min(runtime.deadlineAt - Date.now(), limits.timeoutSeconds * 1000);
    if (!Number.isFinite(remaining) || remaining <= 0 || runtime.signal.aborted)
      throw new Error("Sandbox deadline expired");
    if (this.running.has(id)) throw new Error("Container is already running");
    this.running.add(id);
    const controller = new AbortController();
    const signal = AbortSignal.any([runtime.signal, controller.signal]);
    let stopping: Promise<"CONFIRMED" | "UNCERTAIN"> | undefined;
    const stop = () => {
      stopping ??= this.stopAndRemove(id);
    };
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn("docker", [...argv], {
          shell: false,
          signal,
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "pipe"],
          env: allowlistedDockerEnv(),
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        let outputExceeded = false;
        let failure: Error | undefined;
        const collect = (chunk: Buffer) => {
          if (bytes < limits.maxOutputBytes) {
            const available = limits.maxOutputBytes - bytes;
            chunks.push(Buffer.from(chunk.subarray(0, available)));
          }
          bytes += chunk.length;
          if (bytes > limits.maxOutputBytes) {
            outputExceeded = true;
            controller.abort();
          }
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.once("error", (error) => {
          failure = error;
        });
        child.once("close", (code) => {
          if (outputExceeded || signal.aborted) {
            resolve({
              id,
              output: truncateUtf8(Buffer.concat(chunks), limits.maxOutputBytes),
              exitCode: code ?? 1,
              truncated: outputExceeded,
              terminationReason: outputExceeded
                ? "OUTPUT_LIMIT"
                : runtime.signal.aborted
                  ? "CANCELLED"
                  : "TIMEOUT",
            });
          } else if (failure) {
            reject(failure);
          } else {
            resolve({
              id,
              output: truncateUtf8(Buffer.concat(chunks), limits.maxOutputBytes),
              exitCode: code ?? 1,
              truncated: false,
              terminationReason: "EXITED",
            });
          }
        });
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      try {
        await stopping;
      } finally {
        this.running.delete(id);
      }
    }
  }

  async stopAndRemove(id: string): Promise<"CONFIRMED" | "UNCERTAIN"> {
    if (!this.resources.has(id)) return "UNCERTAIN";
    const command = async (argv: readonly string[]) =>
      (
        await execDocker("docker", [...argv], {
          timeout: 5000,
          maxBuffer: 64 * 1024,
          encoding: "utf8",
          shell: false,
          env: allowlistedDockerEnv(),
        })
      ).stdout.trim();
    const find = () =>
      command(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${id}$`]);
    try {
      const container = await find();
      if (container) {
        const labels: unknown = JSON.parse(
          await command(["inspect", "--format", "{{json .Config.Labels}}", "--", container]),
        );
        const parsed = containerLabelsSchema.safeParse(labels);
        if (!parsed.success || parsed.data["slop-loop.containerId"] !== id) {
          return "UNCERTAIN";
        }
        await command(["rm", "--force", "--", container]);
      }
      if ((await find()) !== "") return "UNCERTAIN";
      if (!this.running.has(id)) this.resources.delete(id);
      return "CONFIRMED";
    } catch {
      return "UNCERTAIN";
    }
  }
}
