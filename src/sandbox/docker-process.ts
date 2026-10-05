import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { DockerPort } from "./docker.js";

const execDocker = promisify(execFile);

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
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        let failure: Error | undefined;
        const collect = (chunk: Buffer) => {
          const available = Math.max(0, limits.maxOutputBytes + 1 - bytes);
          if (available > 0) chunks.push(Buffer.from(chunk.subarray(0, available)));
          bytes += Math.min(chunk.length, available);
          if (bytes > limits.maxOutputBytes) controller.abort();
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        child.once("error", (error) => {
          failure = error;
        });
        child.once("close", (code) => {
          if (failure || signal.aborted) reject(failure ?? new Error("Sandbox execution aborted"));
          else resolve({ id, output: Buffer.concat(chunks).toString("utf8"), exitCode: code ?? 1 });
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
        if (
          typeof labels !== "object" ||
          labels === null ||
          !("slop-loop.owner" in labels) ||
          labels["slop-loop.owner"] !== "verification" ||
          !("slop-loop.containerId" in labels) ||
          labels["slop-loop.containerId"] !== id ||
          !("slop-loop.taskId" in labels) ||
          typeof labels["slop-loop.taskId"] !== "string" ||
          labels["slop-loop.taskId"].length === 0
        )
          return "UNCERTAIN";
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
