import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  parseLockedGraph,
  validateLockedArtifact,
  verifyArtifactBytes,
  type LockedArtifact,
} from "./downloads.js";
import { importCheckedArchive } from "./safeimport.js";
import { NORMALIZATION_METADATA, NORMALIZATION_RECIPE } from "./dependencytree.js";

type ArtifactResponse = { readonly status: number; readonly bytes: Buffer };
type RestrictedArtifactRequest = (url: string, signal: AbortSignal) => Promise<ArtifactResponse>;

/** There is exactly one connection path: fixed proxy -> TLS-authenticated approved registry. */
async function restrictedRequest(url: string, signal: AbortSignal): Promise<ArtifactResponse> {
  const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const request = http.request({
      host: "172.31.253.2",
      port: 3128,
      method: "CONNECT",
      path: "registry.npmjs.org:443",
      agent: false,
      signal,
      timeout: 5000,
      headers: { Host: "registry.npmjs.org:443" },
    });
    request.on("timeout", () => request.destroy(new Error("Broker connect deadline exceeded")));
    request.once("error", reject);
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200 || head.length !== 0) {
        socket.destroy();
        reject(new Error("Broker connection rejected"));
        return;
      }
      const session = tls.connect({
        socket,
        servername: "registry.npmjs.org",
        rejectUnauthorized: true,
      });
      session.setTimeout(5000, () => session.destroy(new Error("TLS deadline exceeded")));
      session.once("error", reject);
      const onAbort = (): void => {
        session.destroy(new Error("Artifact request cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      session.once("close", () => signal.removeEventListener("abort", onAbort));
      session.once("secureConnect", () => {
        session.setTimeout(0);
        resolve(session);
      });
    });
    request.end();
  });
  return await new Promise<ArtifactResponse>((resolve, reject) => {
    const agent = new https.Agent({ keepAlive: false });
    agent.createConnection = () => secure;
    const request = https.request(
      url,
      { method: "GET", agent, signal, headers: { "Accept-Encoding": "identity" }, timeout: 10_000 },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        if (
          response.statusCode !== 200 ||
          (response.headers["content-encoding"] !== undefined &&
            response.headers["content-encoding"] !== "identity")
        ) {
          response.destroy();
          secure.destroy();
          reject(new Error("Restricted artifact response rejected"));
          return;
        }
        response.on("data", (bytes: Buffer) => {
          size += bytes.length;
          if (size > 128 * 1024 ** 2) request.destroy(new Error("Artifact byte limit exceeded"));
          else chunks.push(bytes);
        });
        response.once("error", reject);
        response.once("end", () => {
          secure.destroy();
          resolve({ status: response.statusCode ?? 0, bytes: Buffer.concat(chunks, size) });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Artifact response deadline exceeded")));
    request.once("error", (error) => {
      secure.destroy();
      reject(error);
    });
    request.end();
  });
}

const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const graphSchema = z.strictObject({
  lockfile: z.string().max(32 * 1024 ** 2),
  manifest: z.string().max(16 * 1024 ** 2),
});
const entrySchema = z.strictObject({
  path: z.string().min(1).max(4096),
  kind: z.enum(["file", "directory", "symlink"]),
  size: z
    .number()
    .int()
    .min(0)
    .max(128 * 1024 ** 2),
  mode: z.number().int().min(0).max(0o777).optional(),
  target: z.string().max(4096).optional(),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
const manifestSchema = z.array(entrySchema).max(50_000);
const identitySchema = z.string().regex(/^[a-f0-9]{64}$/u);
const instructionSchema = z.strictObject({
  nodeKey: z.string().min(1).max(2048),
  root: z.string().min(1).max(4096),
  integrity: z.string().min(1).max(256),
  phase: z.enum(["preinstall", "install", "postinstall"]),
  command: z
    .string()
    .min(1)
    .max(64 * 1024),
});
const receiptSchema = z.strictObject({
  contentId: identitySchema,
  graphId: identitySchema,
  manifest: manifestSchema,
});
type Manifest = z.infer<typeof manifestSchema>;

/** Internal execution seam: fixtures never execute target code on the host. */
export type WorkerExecutor = (
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<Buffer>;
interface WorkerOptions {
  readonly privateRoot?: string;
  readonly storeRoot?: string;
  readonly execute?: WorkerExecutor;
  readonly request?: RestrictedArtifactRequest;
  readonly signal?: AbortSignal;
}
const workerEnvironment = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/tmp",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  CI: "true",
  COREPACK_ENABLE_NETWORK: "0",
  COREPACK_ENABLE_AUTO_PIN: "0",
  npm_config_userconfig: "/dev/null",
  npm_config_globalconfig: "/dev/null",
});
const nativePrerequisiteCheck = `const fs=require('node:fs');
if(process.versions.node!=='24.14.0'||require('/opt/slop-loop/node_modules/node-gyp/package.json').version!=='12.4.0')throw Error('Pinned native tool mismatch');
const h=fs.readFileSync('/opt/slop-loop/node-headers/include/node/node_version.h','utf8');
if(['MAJOR','MINOR','PATCH'].map(p=>h.match(new RegExp('#define\\\\s+NODE_'+p+'_VERSION\\\\s+(\\\\d+)'))?.[1]).join('.')!=='24.14.0')throw Error('Pinned native headers mismatch');
process.stdout.write('native-prerequisites:PASS');`;

const executeFixed: WorkerExecutor = async (executable, args, cwd, env, signal) => {
  if (process.platform !== "linux" || !cwd.startsWith("/preparation"))
    throw new Error("Linux preparation recipient required");
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const consume = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > 1024 ** 2) child.kill("SIGKILL");
      else chunks.push(chunk);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 || size > 1024 ** 2) reject(new Error("Fixed preparation operation failed"));
      else resolve(Buffer.concat(chunks));
    });
  });
};

function assertPrivateRoot(root: string): void {
  const stat = fs.lstatSync(root);
  if (
    path.resolve(root) !== root ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(root) !== root
  )
    throw new Error("Preparation root authority unavailable");
}
function readOwned(root: string, name: string, limit: number): Buffer {
  const target = path.join(root, name);
  if (!target.startsWith(root + path.sep)) throw new Error("Preparation path escape");
  const relative = path.relative(root, target).split(path.sep);
  for (let i = 1; i < relative.length; i++) {
    const stat = fs.lstatSync(path.join(root, ...relative.slice(0, i)));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Preparation symlink parent rejected");
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit)
    throw new Error("Preparation file rejected");
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size)
      throw new Error("Preparation file changed");
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length !== stat.size) throw new Error("Preparation file changed");
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}
function writeExclusive(root: string, name: string, bytes: string | Buffer, mode = 0o600): void {
  const descriptor = fs.openSync(
    path.join(root, name),
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
function canonicalTreeId(manifest: Manifest): string {
  const canonical = manifest
    .map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      ...(entry.kind === "file" ? { hash: entry.hash, bytes: entry.size } : {}),
      ...(entry.kind === "symlink" ? { target: entry.target } : {}),
    }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  return digest(JSON.stringify([NORMALIZATION_RECIPE, canonical]));
}

/** Fixed trusted container entry phases; network removal remains the runtime's obligation. */
export async function runPreparationWorkerPhase(
  phase: string,
  input: unknown,
  options: WorkerOptions = {},
): Promise<Buffer> {
  const root = options.privateRoot ?? "/preparation";
  const store = options.storeRoot ?? "/tmp/store";
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(15 * 60_000),
  ]);
  signal.throwIfAborted();
  assertPrivateRoot(root);
  const execute = options.execute ?? executeFixed;
  const version = async (): Promise<void> => {
    if (
      (await execute("pnpm", ["--version"], root, workerEnvironment, signal)).toString().trim() !==
      "12.5.1"
    )
      throw new Error("Pinned package manager unavailable");
  };
  if (phase === "fetch" || phase === "materialize") {
    const original = graphSchema.parse(input);
    const graph = parseLockedGraph(original.lockfile, original.manifest);
    const binding = JSON.stringify(original);
    if (phase === "fetch") {
      if (fs.readdirSync(root).length !== 0) throw new Error("Fresh fetch recipient required");
      await version();
      writeExclusive(root, "package.json", graph.manifest);
      writeExclusive(root, "pnpm-lock.yaml", graph.lockfile);
      writeExclusive(root, "fetch-input.json", binding);
      fs.mkdirSync(path.join(root, "downloads"), { mode: 0o700 });
      await execute("pnpm", fixedManagerArguments("fetch"), root, workerEnvironment, signal);
      let total = 0;
      for (const [index, artifact] of graph.artifacts.entries()) {
        const bytes = await fetchExactArtifact(artifact, signal, options.request);
        total += bytes.length;
        if (total > 2 * 1024 ** 3) throw new Error("Aggregate artifact byte limit exceeded");
        writeExclusive(path.join(root, "downloads"), `${index}.tgz`, bytes);
      }
      writeExclusive(root, "fetch-complete", digest(binding), 0o400);
    } else {
      if (
        readOwned(root, "fetch-complete", 64).toString() !== digest(binding) ||
        readOwned(root, "fetch-input.json", 48 * 1024 ** 2).toString() !== binding ||
        readOwned(root, "package.json", 16 * 1024 ** 2).toString() !== graph.manifest ||
        readOwned(root, "pnpm-lock.yaml", 32 * 1024 ** 2).toString() !== graph.lockfile
      )
        throw new Error("Frozen preparation input changed");
      await version();
      await execute("pnpm", fixedManagerArguments("materialize"), root, workerEnvironment, signal);
    }
  } else if (phase === "artifact") {
    const { index } = z.strictObject({ index: z.number().int().min(0).max(9999) }).parse(input);
    const original = graphSchema.parse(
      JSON.parse(readOwned(root, "fetch-input.json", 48 * 1024 ** 2).toString()),
    );
    if (readOwned(root, "fetch-complete", 64).toString() !== digest(JSON.stringify(original)))
      throw new Error("Completed artifact fetch unavailable");
    const graph = parseLockedGraph(original.lockfile, original.manifest);
    const artifact = graph.artifacts[index];
    if (!artifact) throw new Error("Artifact index unavailable");
    const bytes = readOwned(root, `downloads/${index}.tgz`, 128 * 1024 ** 2);
    verifyArtifactBytes(artifact, bytes);
    return bytes;
  } else if (phase === "import") {
    const parsed = z
      .strictObject({
        tar: z.string().max(224 * 1024 ** 2),
        manifest: manifestSchema,
        contentId: identitySchema,
        graph: graphSchema,
      })
      .parse(input);
    const graph = parseLockedGraph(parsed.graph.lockfile, parsed.graph.manifest);
    if (fs.existsSync(store) || fs.readdirSync(root).length !== 0)
      throw new Error("Fresh CAS-free import recipient required");
    if (canonicalTreeId(parsed.manifest) !== parsed.contentId)
      throw new Error("Canonical tree identity mismatch");
    const bytes = Buffer.from(parsed.tar, "base64");
    if (bytes.length > 160 * 1024 ** 2 || bytes.toString("base64") !== parsed.tar)
      throw new Error("Import archive limit or encoding rejected");
    const imported = await importCheckedArchive(
      Readable.from([bytes]),
      parsed.manifest,
      root,
      signal,
    );
    if (
      readOwned(imported.root, ".slop-loop-tree.json", 1024).toString() !== NORMALIZATION_METADATA
    )
      throw new Error("Normalization recipe mismatch");
    for (const node of graph.nodes) {
      const pkg = z
        .object({ name: z.string(), version: z.string() })
        .parse(
          JSON.parse(
            readOwned(imported.root, `${node.root}/package.json`, 16 * 1024 ** 2).toString(),
          ),
        );
      if (`${pkg.name}@${pkg.version}` !== node.artifact)
        throw new Error("Imported graph package mismatch");
    }
    // The importer keeps parents private during writes; completed canonical directories
    // have the recipe's ordinary mode before a dependency export can be sealed again.
    const directories = new Set<string>();
    for (const entry of parsed.manifest) {
      const parts = entry.path.split("/");
      for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
      if (entry.kind === "directory") {
        if (entry.mode !== 0o755) throw new Error("Canonical directory mode mismatch");
        directories.add(entry.path);
      }
    }
    for (const directory of directories) {
      const target = path.join(imported.root, directory);
      const stat = fs.lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Canonical directory rejected");
      fs.chmodSync(target, 0o755);
    }
    const destination = path.join(root, "node_modules");
    if (fs.existsSync(destination)) throw new Error("Import destination already exists");
    fs.renameSync(imported.root, destination);
    writeExclusive(
      root,
      "receipt.json",
      JSON.stringify({
        contentId: parsed.contentId,
        graphId: digest(graph.lockfile + "\0" + graph.manifest),
        manifest: parsed.manifest,
      }),
      0o400,
    );
  } else if (phase === "scripts") {
    const parsed = z
      .strictObject({
        instructions: z.array(instructionSchema).max(30_000),
        treeId: identitySchema,
        graph: graphSchema,
      })
      .parse(input);
    if (fs.existsSync(store)) throw new Error("CAS-free script recipient required");
    const graph = parseLockedGraph(parsed.graph.lockfile, parsed.graph.manifest);
    const receipt = receiptSchema.parse(
      JSON.parse(readOwned(root, "receipt.json", 16 * 1024 ** 2).toString()),
    );
    if (
      receipt.contentId !== parsed.treeId ||
      receipt.graphId !== digest(graph.lockfile + "\0" + graph.manifest) ||
      canonicalTreeId(receipt.manifest) !== receipt.contentId
    )
      throw new Error("Imported tree binding mismatch");
    const seen = new Set<string>();
    const dependencyRoot = path.join(root, "node_modules");
    assertPrivateRoot(dependencyRoot);
    const validateLinks = (): void => {
      for (const entry of receipt.manifest.filter((entry) => entry.kind === "symlink")) {
        const target = path.join(dependencyRoot, entry.path);
        if (
          fs.realpathSync(path.dirname(target)) !== path.dirname(target) ||
          !fs.lstatSync(target).isSymbolicLink() ||
          fs.readlinkSync(target) !== entry.target ||
          !fs.realpathSync(target).startsWith(dependencyRoot + path.sep)
        )
          throw new Error("Authenticated context link changed");
      }
    };
    const validateInstruction = (instruction: z.infer<typeof instructionSchema>): void => {
      const node = graph.nodes.find((candidate) => candidate.key === instruction.nodeKey);
      const artifact =
        node &&
        graph.artifacts.find(
          (candidate) => `${candidate.name}@${candidate.version}` === node.artifact,
        );
      if (!node || node.root !== instruction.root || artifact?.integrity !== instruction.integrity)
        throw new Error("Script graph binding mismatch");
      for (const entry of receipt.manifest.filter(
        (entry) => entry.kind === "file" && entry.path.startsWith(node.root + "/"),
      )) {
        const bytes = readOwned(dependencyRoot, entry.path, 128 * 1024 ** 2);
        if (bytes.length !== entry.size || digest(bytes) !== entry.hash)
          throw new Error("Imported script package content changed");
      }
      const pkg = z
        .object({
          name: z.string(),
          version: z.string(),
          scripts: z.record(z.string(), z.string()).optional(),
        })
        .parse(
          JSON.parse(
            readOwned(dependencyRoot, `${node.root}/package.json`, 16 * 1024 ** 2).toString(),
          ),
        );
      const implicitInstall =
        instruction.phase === "install" &&
        !pkg.scripts?.install &&
        !pkg.scripts?.preinstall &&
        receipt.manifest.some(
          (entry) => entry.kind === "file" && entry.path === `${node.root}/binding.gyp`,
        )
          ? "node-gyp rebuild"
          : undefined;
      if (
        `${pkg.name}@${pkg.version}` !== node.artifact ||
        (pkg.scripts?.[instruction.phase] ?? implicitInstall) !== instruction.command
      )
        throw new Error("Authenticated script command mismatch");
    };
    for (const instruction of parsed.instructions) {
      const key = instruction.nodeKey + "\0" + instruction.phase;
      if (seen.has(key)) throw new Error("Duplicate script instruction");
      seen.add(key);
      validateInstruction(instruction);
    }
    validateLinks();
    if (
      parsed.instructions.length &&
      (
        await execute("node", ["-e", nativePrerequisiteCheck], root, workerEnvironment, signal)
      ).toString() !== "native-prerequisites:PASS"
    )
      throw new Error("Pinned native prerequisites unavailable");
    // Record consumption before dependency code starts; the runtime owns one script dispatch.
    writeExclusive(root, "scripts-consumed", parsed.treeId, 0o400);
    for (const instruction of parsed.instructions) {
      signal.throwIfAborted();
      if (fs.existsSync(store)) throw new Error("CAS-free script recipient required");
      validateInstruction(instruction);
      validateLinks();
      const cwd = path.join(dependencyRoot, instruction.root);
      const approvedBinDirectories = new Set(
        receipt.manifest
          .filter(
            (entry) =>
              entry.kind === "symlink" &&
              (entry.path.startsWith(".bin/") || entry.path.includes("/.bin/")),
          )
          .map((entry) => path.posix.dirname(entry.path)),
      );
      const bins = [
        path.join(instruction.root, "node_modules", ".bin"),
        path.join(instruction.root, "..", ".bin"),
        ".bin",
      ]
        .filter((directory) => approvedBinDirectories.has(directory.split(path.sep).join("/")))
        .map((directory) => path.join(dependencyRoot, directory));
      const env = {
        ...workerEnvironment,
        PATH: [...bins, "/opt/slop-loop/node_modules/.bin", workerEnvironment.PATH].join(":"),
        npm_config_nodedir: "/opt/slop-loop/node-headers",
        npm_config_offline: "true",
        npm_config_manage_package_manager_versions: "false",
      };
      await execute("/bin/sh", ["-c", instruction.command], cwd, env, signal);
    }
  } else throw new Error("Unknown fixed preparation phase");
  return Buffer.from(`${phase}:PASS`);
}

async function main(): Promise<void> {
  if (process.platform !== "linux" || process.argv.length !== 3)
    throw new Error("Fixed Linux preparation entry required");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 256 * 1024 ** 2) throw new Error("Worker input limit exceeded");
    chunks.push(bytes);
  }
  const output = await runPreparationWorkerPhase(
    process.argv[2]!,
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
  process.stdout.write(output);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("Preparation worker failed\n");
    process.exitCode = 1;
  });
}

export async function fetchExactArtifact(
  artifact: LockedArtifact,
  signal: AbortSignal,
  request: RestrictedArtifactRequest = restrictedRequest,
): Promise<Buffer> {
  validateLockedArtifact(artifact);
  signal.throwIfAborted();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const response = await request(artifact.tarball, bounded);
  bounded.throwIfAborted();
  if (response.status !== 200) throw new Error("Restricted artifact response rejected");
  verifyArtifactBytes(artifact, response.bytes);
  return Buffer.from(response.bytes);
}

/** App-owned manager policy. Neither repository configuration nor lifecycle hooks are loaded. */
export function fixedManagerArguments(stage: "fetch" | "materialize"): readonly string[] {
  const common = [
    "--dir=/preparation",
    "--store-dir=/tmp/store",
    "--ignore-pnpmfile",
    "--ignore-workspace",
    "--reporter=silent",
    "--config.ignore-scripts=true",
    "--config.node-linker=isolated",
    "--config.hoist=false",
    "--config.shamefully-hoist=false",
    "--config.prefer-symlinked-executables=true",
    "--config.manage-package-manager-versions=false",
    "--config.virtual-store-dir-max-length=120",
  ];
  return Object.freeze(
    stage === "fetch"
      ? [
          "fetch",
          ...common,
          "--https-proxy=http://172.31.253.2:3128",
          "--http-proxy=http://172.31.253.2:3128",
          "--no-proxy=",
        ]
      : ["install", "--offline", "--frozen-lockfile", "--ignore-scripts", ...common],
  );
}
