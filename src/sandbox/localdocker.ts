import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DockerCliExecution, allowlistedDockerEnv } from "./dockerprocess.js";
import type { PreparationInputs } from "./config.js";
import { createPreparationFingerprint, ORDINARY_TEST_PATHS } from "./config.js";
import { SnapshotMaterializationError } from "./docker.js";
import type { DockerPort } from "./docker.js";
import { excludedSnapshotPath } from "./workspacesnapshot.js";
import { parseRepositoryPath } from "../workspace/path-policy.js";

const infoSchema = z.object({
  OSType: z.literal("linux"),
  Architecture: z.enum(["x86_64", "amd64"]),
  ID: z.string().min(1),
  MemoryLimit: z.literal(true),
  SwapLimit: z.literal(true),
  PidsLimit: z.literal(true),
  SecurityOptions: z.array(z.string()),
});
const imageSchema = z
  .array(
    z.object({
      Id: z.string(),
      Os: z.literal("linux"),
      Architecture: z.literal("amd64"),
      Config: z.object({
        Labels: z.record(z.string(), z.string()).nullable(),
        Volumes: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    }),
  )
  .length(1);
const unavailable = Object.freeze({
  networkDisabled: false,
  limitsEnforced: false,
  readOnlyMounts: false,
});

/** Fixed application bootstrap: copies regular, hash-checked entries, never installs dependencies. */
const bootstrap = `const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');
const manifest=JSON.parse(fs.readFileSync('/snapshot/manifest.json','utf8'));
for(const e of manifest){const src=p.join('/snapshot/tree',e.path),dst=p.join('/workspace',e.path);const s=fs.lstatSync(src);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('invalid staged file');const b=fs.readFileSync(src);if(b.length!==e.bytes||c.createHash('sha256').update(b).digest('hex')!==e.hash)throw Error('staged bytes changed');fs.mkdirSync(p.dirname(dst),{recursive:true});fs.writeFileSync(dst,b,{flag:'wx',mode:e.mode});}
if(!fs.statSync('/opt/slop-loop/node_modules').isDirectory())throw Error('prepared dependencies missing');
fs.symlinkSync('/opt/slop-loop/node_modules','/workspace/node_modules','dir');`;

function protect(root: string): void {
  fs.chmodSync(root, 0o700);
  if (process.platform === "win32")
    execFileSync(
      "icacls",
      [
        root,
        "/inheritance:r",
        "/grant:r",
        `${os.userInfo().username}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
      ],
      { timeout: 5000, stdio: "ignore", shell: false },
    );
  else if (process.platform !== "linux") throw new Error("Private staging platform unavailable");
}

/** Concrete local-only Docker operations. Records and endpoint are application construction inputs. */
export class LocalDockerPort implements DockerPort {
  constructor(private readonly preparedInputs?: PreparationInputs) {}
  readonly endpoint =
    process.platform === "win32"
      ? "npipe:////./pipe/dockerDesktopLinuxEngine"
      : "unix:///var/run/docker.sock";
  private root?: string;
  private rootIdentity?: string;
  private configIdentity?: string;
  private execution?: DockerCliExecution;
  private readonly stages = new Map<
    string,
    { root: string; identity: string; bytes: number; entries: Map<string, string> }
  >();
  private stagedBytes = 0;
  private engineIdentity?: string;

  private prefix(): readonly string[] {
    if (!this.root) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-runtime-"));
      try {
        protect(root);
      } catch (error) {
        fs.rmdirSync(root);
        throw error;
      }
      fs.mkdirSync(path.join(root, "docker-config"), { mode: 0o700 });
      this.root = root;
      const stat = fs.lstatSync(root);
      this.rootIdentity = `${stat.dev}:${stat.ino}`;
      const config = fs.lstatSync(path.join(root, "docker-config"));
      this.configIdentity = `${config.dev}:${config.ino}`;
    }
    return ["--host", this.endpoint, "--config", path.join(this.root, "docker-config")];
  }
  private command(argv: readonly string[]): string {
    return execFileSync("docker", [...this.prefix(), ...argv], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      shell: false,
      env: allowlistedDockerEnv(),
    }).trim();
  }
  private process(): DockerCliExecution {
    return (this.execution ??= new DockerCliExecution(this.prefix()));
  }
  readiness(): ReturnType<DockerPort["readiness"]> {
    try {
      const value: unknown = JSON.parse(this.command(["info", "--format", "{{json .}}"]));
      const info = infoSchema.parse(value);
      if (
        !info.SecurityOptions.some(
          (option) => option.startsWith("name=seccomp") && !option.includes("unconfined"),
        )
      )
        return unavailable;
      if (this.engineIdentity && this.engineIdentity !== info.ID) return unavailable;
      this.engineIdentity = info.ID;
      return { networkDisabled: true, limitsEnforced: true, readOnlyMounts: true };
    } catch {
      return unavailable;
    }
  }
  inspectImage(imageId: string): ReturnType<DockerPort["inspectImage"]> {
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Image is not immutable");
    const raw: unknown = JSON.parse(this.command(["image", "inspect", "--", imageId]));
    const image = imageSchema.parse(raw)[0]!;
    if (image.Config.Volumes && Object.keys(image.Config.Volumes).length)
      throw new Error("Image-owned volumes are forbidden");
    const fingerprint = image.Config.Labels?.["slop-loop.preparationFingerprint"];
    if (
      image.Id !== imageId ||
      !fingerprint ||
      (this.preparedInputs && fingerprint !== createPreparationFingerprint(this.preparedInputs))
    )
      throw new Error("Prepared image identity mismatch");
    return { imageId: image.Id, fingerprint, architecture: "linux-x64" };
  }
  async copySnapshot(
    entries: Parameters<NonNullable<DockerPort["copySnapshot"]>>[0],
    runtime?: Parameters<NonNullable<DockerPort["copySnapshot"]>>[1],
  ): Promise<string> {
    try {
      return await this.materialize(entries, runtime);
    } catch (error) {
      if (error instanceof SnapshotMaterializationError) throw error;
      throw new SnapshotMaterializationError(this.stages.size ? "UNCERTAIN" : "CONFIRMED");
    }
  }
  /** Releases only this adapter's empty private configuration root, after all stages settle. */
  dispose(): "CONFIRMED" | "UNCERTAIN" {
    if (this.stages.size) return "UNCERTAIN";
    if (!this.root) return "CONFIRMED";
    try {
      const st = fs.lstatSync(this.root);
      const cfg = fs.lstatSync(path.join(this.root, "docker-config"));
      if (
        st.isSymbolicLink() ||
        cfg.isSymbolicLink() ||
        `${st.dev}:${st.ino}` !== this.rootIdentity ||
        `${cfg.dev}:${cfg.ino}` !== this.configIdentity
      )
        return "UNCERTAIN";
      fs.rmdirSync(path.join(this.root, "docker-config"));
      fs.rmdirSync(this.root);
      this.root = undefined;
      this.execution = undefined;
      return "CONFIRMED";
    } catch {
      return "UNCERTAIN";
    }
  }
  private async materialize(
    entries: Parameters<NonNullable<DockerPort["copySnapshot"]>>[0],
    runtime?: Parameters<NonNullable<DockerPort["copySnapshot"]>>[1],
  ): Promise<string> {
    const checkBoundary = () => {
      runtime?.signal.throwIfAborted();
      if (runtime && Date.now() >= runtime.deadlineAt)
        throw new Error("Snapshot staging deadline expired");
    };
    try {
      checkBoundary();
      this.prefix();
    } catch {
      throw new SnapshotMaterializationError("CONFIRMED");
    }
    let bytes = 0;
    const seen = new Set<string>();
    if (entries.length > 50000) throw new Error("Snapshot entry limit exceeded");
    for (const entry of entries) {
      checkBoundary();
      if (
        parseRepositoryPath(entry.path) === null ||
        entry.path === "." ||
        excludedSnapshotPath(entry.path) ||
        seen.has(entry.path.toLowerCase())
      )
        throw new Error("Unsafe snapshot staging path");
      seen.add(entry.path.toLowerCase());
      bytes += entry.content.length;
      if (entry.content.length > 16 * 1024 * 1024 || bytes > 256 * 1024 * 1024)
        throw new Error("Snapshot staging limit exceeded");
    }
    if (this.stagedBytes + bytes > 1024 * 1024 * 1024)
      throw new Error("Snapshot staging quota exceeded");
    const stageRoot = path.join(this.root!, `snapshot-${randomUUID()}`);
    const payload = path.join(stageRoot, "payload");
    const ownedEntries = new Map<string, string>();
    const record = { root: stageRoot, identity: "UNCONFIRMED", bytes, entries: ownedEntries };
    this.stages.set(payload, record);
    this.stagedBytes += bytes;
    const remember = (name: string) => {
      const st = fs.lstatSync(name);
      ownedEntries.set(name, `${st.dev}:${st.ino}`);
    };
    try {
      fs.mkdirSync(stageRoot, { mode: 0o700 });
      remember(stageRoot);
      record.identity = ownedEntries.get(stageRoot)!;
      fs.mkdirSync(payload, { mode: 0o755 });
      remember(payload);
      const manifest = [];
      for (const entry of entries) {
        checkBoundary();
        const destination = path.join(payload, "tree", ...entry.path.split("/"));
        const parts = path.relative(payload, path.dirname(destination)).split(path.sep);
        let directory = payload;
        for (const part of parts) {
          directory = path.join(directory, part);
          if (!ownedEntries.has(directory)) {
            fs.mkdirSync(directory, { mode: 0o755 });
            remember(directory);
          }
        }

        const content = Buffer.from(entry.content);
        const file = await fs.promises.open(
          destination,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            (fs.constants.O_NOFOLLOW ?? 0),
          0o444,
        );
        try {
          remember(destination);
          await file.writeFile(content);
        } finally {
          await file.close();
        }
        manifest.push({
          path: entry.path,
          bytes: content.length,
          hash: createHash("sha256").update(content).digest("hex"),
          mode: entry.mode & 0o777,
        });
      }
      const writeOwned = async (name: string, content: string) => {
        const file = await fs.promises.open(name, "wx", 0o444);
        try {
          remember(name);
          await file.writeFile(content);
        } finally {
          await file.close();
        }
      };
      await writeOwned(path.join(payload, "manifest.json"), JSON.stringify(manifest));
      await writeOwned(
        path.join(payload, "vitest.config.cjs"),
        `module.exports = {cacheDir:"/tmp/slop-loop-vite-cache",test:{include:["tests/**/*.test.ts"],exclude:["tests/sandbox/**/*.integration.test.ts","tests/sandbox/verification.e2e.test.ts"],testTimeout:120000}};`,
      );
      checkBoundary();
      fs.chmodSync(payload, 0o555);
      return payload;
    } catch {
      throw new SnapshotMaterializationError(await this.releaseSnapshot(payload));
    }
  }
  async releaseSnapshot(mount: string): Promise<"CONFIRMED" | "UNCERTAIN"> {
    const owned = this.stages.get(mount);
    if (!owned || !this.root || path.dirname(owned.root) !== this.root) return "UNCERTAIN";
    const cleanupDeadline = Date.now() + 30000;
    try {
      const rootStat = await fs.promises.lstat(owned.root);
      if (rootStat.isSymbolicLink() || `${rootStat.dev}:${rootStat.ino}` !== owned.identity)
        return "UNCERTAIN";
      for (const [name, identity] of owned.entries) {
        if (Date.now() >= cleanupDeadline) throw new Error("Staging cleanup deadline exceeded");
        const st = await fs.promises.lstat(name);
        if (
          st.isSymbolicLink() ||
          `${st.dev}:${st.ino}` !== identity ||
          (!st.isDirectory() && (!st.isFile() || st.nlink !== 1))
        )
          throw new Error("Staging ownership changed");
        if (st.isDirectory())
          for (const child of await fs.promises.readdir(name))
            if (!owned.entries.has(path.join(name, child)))
              throw new Error("Unowned staging entry");
      }
      for (const name of owned.entries.keys()) {
        const st = await fs.promises.lstat(name);
        if (st.isDirectory()) await fs.promises.chmod(name, 0o700);
      }
      for (const name of [...owned.entries.keys()].sort((a, b) => b.length - a.length)) {
        if (Date.now() >= cleanupDeadline) throw new Error("Staging cleanup deadline exceeded");
        const st = await fs.promises.lstat(name);
        if (`${st.dev}:${st.ino}` !== owned.entries.get(name) || st.isSymbolicLink())
          throw new Error("Staging ownership changed");
        await fs.promises.chmod(name, st.isDirectory() ? 0o700 : 0o600);
        if (st.isDirectory()) await fs.promises.rmdir(name);
        else await fs.promises.unlink(name);
        owned.entries.delete(name);
      }
      this.stages.delete(mount);
      this.stagedBytes -= owned.bytes;
      return this.stages.size === 0 ? this.dispose() : "CONFIRMED";
    } catch {
      return "UNCERTAIN";
    }
  }

  registerResource(): string {
    return this.process().registerResource();
  }
  stopAndRemove(id: string): Promise<"CONFIRMED" | "UNCERTAIN"> {
    return this.process().stopAndRemove(id);
  }

  async run(
    argv: Parameters<DockerPort["run"]>[0],
    limits: Parameters<DockerPort["run"]>[1],
    runtime: Parameters<DockerPort["run"]>[2],
  ): ReturnType<DockerPort["run"]> {
    const id = runtime.resourceId;
    if (!id || !argv.includes(id) || argv[0] !== "run")
      throw new Error("Unregistered verification invocation");
    const imageIndex = argv.findIndex((arg) => /^sha256:[a-f0-9]{64}$/.test(arg));
    if (imageIndex < 0) throw new Error("Missing immutable image");
    const image = argv[imageIndex]!;
    this.inspectImage(image);
    const requested = argv.slice(imageIndex + 1);
    const command =
      requested.length === 2 && requested[0] === "pnpm" && requested[1] === "test"
        ? [
            "pnpm",
            "exec",
            "vitest",
            "run",
            "--config",
            "/snapshot/vitest.config.cjs",
            ...ORDINARY_TEST_PATHS,
          ]
        : requested;
    this.command([
      "create",
      ...argv.slice(1, imageIndex).filter((arg) => arg !== "--rm"),
      "--entrypoint=node",
      image,
      "-e",
      "setInterval(()=>{},1000)",
    ]);
    this.verifyContainer(id, image, limits);
    runtime.signal.throwIfAborted();
    this.command(["start", "--", id]);
    let nativePrelude: "PASS" | "FAIL" | "NOT_REQUIRED" = "NOT_REQUIRED";
    let output = "";
    const execute = async (args: readonly string[]) => {
      const remaining = limits.maxOutputBytes - Buffer.byteLength(output);
      if (remaining <= 0)
        return {
          id,
          output,
          exitCode: 1,
          truncated: true,
          terminationReason: "OUTPUT_LIMIT" as const,
          nativePrelude,
        };
      runtime.signal.throwIfAborted();
      if (Date.now() >= runtime.deadlineAt)
        return {
          id,
          output,
          exitCode: 1,
          truncated: false,
          terminationReason: "TIMEOUT" as const,
          nativePrelude,
        };
      const result = await this.process().run(
        ["exec", "--workdir", "/workspace", id, ...args],
        { ...limits, maxOutputBytes: Math.max(1, remaining) },
        runtime,
      );
      output += result.output;
      return { ...result, output, nativePrelude };
    };
    if (this.preparedInputs) {
      const prerequisite = await execute([
        "node",
        "-e",
        `const cp=require('node:child_process');if(process.version.replace(/^v/,'')!==${JSON.stringify(this.preparedInputs.nodeVersion.replace(/^v/, ""))})process.exit(90);const p=cp.spawnSync('pnpm',['--version'],{encoding:'utf8',timeout:5000});if(p.status!==0||p.stdout.trim()!==${JSON.stringify(this.preparedInputs.pnpmVersion)})process.exit(90);`,
      ]);
      if (
        prerequisite.exitCode !== 0 ||
        prerequisite.truncated ||
        prerequisite.terminationReason !== "EXITED"
      )
        return prerequisite;
    }
    const copied = await execute(["node", "-e", bootstrap]);
    if (copied.exitCode !== 0 || copied.terminationReason !== "EXITED" || copied.truncated)
      return copied;
    // Reference target native source is identified by staged inputs, never by host binaries.
    const mountFlag = argv[argv.indexOf("--mount") + 1]!;
    const mount = mountFlag.slice("type=bind,src=".length, mountFlag.indexOf(",dst="));
    const manifest: unknown = JSON.parse(
      await fs.promises.readFile(path.join(mount, "manifest.json"), "utf8"),
    );
    const entrySchema = z.array(z.object({ path: z.string() }));
    if (
      entrySchema.parse(manifest).some((entry) => entry.path === "native/workspace/binding.gyp")
    ) {
      nativePrelude = "FAIL";
      const nativePrerequisites = await execute([
        "node",
        "-e",
        String.raw`const fs=require('node:fs');const v=require('/opt/slop-loop/node_modules/node-gyp/package.json').version;if(v!=='12.4.0')process.exit(90);const h=fs.readFileSync('/opt/slop-loop/node-headers/include/node/node_version.h','utf8');const parts=['MAJOR','MINOR','PATCH'].map(p=>h.match(new RegExp('#define\\s+NODE_'+p+'_VERSION\\s+(\\d+)'))?.[1]);if(parts.join('.')!==process.version.replace(/^v/,''))process.exit(90);`,
      ]);
      if (
        nativePrerequisites.exitCode !== 0 ||
        nativePrerequisites.truncated ||
        nativePrerequisites.terminationReason !== "EXITED"
      )
        return { ...nativePrerequisites, nativePrelude: "FAIL" };
      const native = await execute([
        "node",
        "/opt/slop-loop/node_modules/node-gyp/bin/node-gyp.js",
        "rebuild",
        "--directory",
        "native/workspace",
        "--nodedir=/opt/slop-loop/node-headers",
      ]);
      if (native.exitCode !== 0 || native.truncated || native.terminationReason !== "EXITED")
        return { ...native, nativePrelude: "FAIL" };
      nativePrelude = "PASS";
    }
    if (Buffer.byteLength(output) >= limits.maxOutputBytes)
      return {
        id,
        output,
        exitCode: 1,
        truncated: true,
        terminationReason: "OUTPUT_LIMIT",
        nativePrelude,
      };
    return { ...(await execute(command)), nativePrelude };
  }
  private verifyContainer(
    id: string,
    image: string,
    limits: Parameters<DockerPort["run"]>[1],
  ): void {
    const raw: unknown = JSON.parse(this.command(["inspect", "--", id]));
    const schema = z
      .array(
        z.object({
          Image: z.string(),
          Config: z.object({ User: z.string() }),
          HostConfig: z.object({
            NetworkMode: z.string(),
            ReadonlyRootfs: z.boolean(),
            Privileged: z.boolean(),
            CapDrop: z.array(z.string()),
            CapAdd: z.array(z.string()).nullable(),
            SecurityOpt: z.array(z.string()),
            Memory: z.number(),
            MemorySwap: z.number(),
            PidsLimit: z.number(),
            NanoCpus: z.number(),
            LogConfig: z.object({ Type: z.string() }),
            Binds: z.array(z.string()).nullable(),
            Mounts: z.array(
              z.object({
                Type: z.string(),
                Source: z.string(),
                Target: z.string(),
                ReadOnly: z.boolean(),
              }),
            ),
            Tmpfs: z.record(z.string(), z.string()),
          }),
        }),
      )
      .length(1);
    const container = schema.parse(raw)[0]!,
      config = container.HostConfig;
    if (
      container.Image !== image ||
      container.Config.User !== "1000:1000" ||
      config.NetworkMode !== "none" ||
      !config.ReadonlyRootfs ||
      config.Privileged ||
      !config.CapDrop.includes("ALL") ||
      config.CapAdd?.length ||
      !config.SecurityOpt.includes("no-new-privileges") ||
      config.Memory !== limits.memoryBytes ||
      config.MemorySwap !== limits.memoryBytes ||
      config.PidsLimit !== limits.maxPids ||
      config.NanoCpus !== limits.cpus * 1e9 ||
      config.LogConfig.Type !== "none" ||
      config.Binds?.length ||
      config.Mounts.length !== 1 ||
      config.Mounts[0]?.Target !== "/snapshot" ||
      !config.Mounts[0].ReadOnly ||
      !this.stages.has(config.Mounts[0].Source) ||
      !config.Tmpfs["/workspace"]?.includes("size=2147483648") ||
      !config.Tmpfs["/tmp"]?.includes("size=268435456")
    )
      throw new Error("Effective sandbox hardening unavailable");
  }
}
