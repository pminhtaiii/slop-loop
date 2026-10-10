import { spawn } from "node:child_process";
import { allowlistedDockerEnv } from "./dockerprocess.js";
import { createPreparationDockerCli } from "./preparationcli.js";

export type PreparationDockerIO = (
  argv: readonly string[],
  input: Buffer,
  signal: AbortSignal,
) => Promise<Buffer>;

export function preparationTransportTimeout(
  phase: "fetch" | "artifact" | "materialize" | "import" | "scripts",
): number {
  return phase === "artifact" ? 60_000 : 15 * 60_000;
}

/** Bounded binary transport; stdout is accepted only after a successful CLI termination. */
export async function localPreparationDockerIO(
  argv: readonly string[],
  input: Buffer,
  signal: AbortSignal,
): Promise<Buffer> {
  if (
    argv[0] !== "exec" ||
    argv[1] !== "-i" ||
    !/^[a-f0-9]{64}$/u.test(argv[2] ?? "") ||
    argv[3] !== "node" ||
    argv[4] !== "/opt/slop-loop-preparation/preparationworker.js" ||
    argv.length !== 6 ||
    !["fetch", "artifact", "materialize", "import", "scripts"].includes(argv[5] ?? "")
  )
    throw new Error("Immutable preparation resource unavailable");
  if (input.length > 200 * 1024 ** 2) throw new Error("Preparation input limit exceeded");
  signal.throwIfAborted();
  const cli = createPreparationDockerCli();
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("docker", [...cli.prefix, ...argv], {
        shell: false,
        env: allowlistedDockerEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let retained = 0;
      let failure: Error | undefined;
      const fail = (error: Error): void => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(
        () => fail(new Error("Preparation transport deadline exceeded")),
        preparationTransportTimeout(
          argv[5] as "fetch" | "artifact" | "materialize" | "import" | "scripts",
        ),
      );
      child.stdout.on("data", (bytes: Buffer) => {
        size += bytes.length;
        if (size > 160 * 1024 ** 2) fail(new Error("Preparation output limit exceeded"));
        else chunks.push(bytes);
      });
      child.stderr.on("data", (bytes: Buffer) => {
        retained += bytes.length;
        if (retained > 1024 ** 2) fail(new Error("Preparation output limit exceeded"));
      });
      child.stdin.on("error", (error) => fail(error));
      child.once("error", (error) => {
        failure ??= error;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failure || code !== 0 || signal.aborted)
          reject(failure ?? new Error("Preparation transport failed"));
        else resolve(Buffer.concat(chunks, size));
      });
      child.stdin.end(input);
    });
  } finally {
    cli.dispose();
  }
}
