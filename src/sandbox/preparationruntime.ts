import { isValidatedGraph, type LockedGraph } from "./downloads.js";
import { isStorageLease, type PreparationStorageLease } from "./preparationstorage.js";
import {
  isPublishedImageCandidate,
  type PreparedImagePublisher,
  type PublishedImageCandidate,
} from "./preparationpublication.js";
import {
  DockerPreparationNetwork,
  localPreparationDockerCommand,
  type FetchAdmission,
  type PreparationDockerCommand,
} from "./preparationnetwork.js";
import { DockerProducerTransfer } from "./produceradapter.js";
import { localPreparationDockerIO, type PreparationDockerIO } from "./preparationio.js";
import { z } from "zod";
import { verifyPackageTarball, type VerifiedPackage } from "./packagecontent.js";
import { isFrozenArchive, type FrozenArchive, type PreparationProducer } from "./frozentransfer.js";
import { normalizePnpmOutput } from "./normalization.js";
import { isValidatedTree, type ValidatedDependencyTree } from "./dependencytree.js";
import { parseTarStream, type ArchiveEntry } from "./archive.js";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { isOfflineScriptPlan, type OfflineScriptInstruction } from "./offlinescripts.js";
import type { PreparedImageRecord } from "./types.js";

interface RuntimeAction {
  readonly graph: LockedGraph;
  readonly lease: PreparationStorageLease;
  admission?: FetchAdmission;
  producer?: PreparationProducer;
  readonly packages: VerifiedPackage[];
  phase:
    | "FETCHING"
    | "FETCHED"
    | "MATERIALIZING"
    | "MATERIALIZED"
    | "IMPORTING"
    | "IMPORTED"
    | "SCRIPTS"
    | "EXECUTED"
    | "PUBLISHING"
    | "PUBLISHED"
    | "CLEANED";
  recipient?: PreparationProducer;
  tree?: ValidatedDependencyTree;
  normalizedEntries?: readonly (ArchiveEntry & { readonly hash?: string })[];
  approvedScriptRoots?: readonly string[];
  candidate?: PublishedImageCandidate;
  networkCleanupConfirmed?: boolean;
}
const basePrerequisites = `const fs=require('node:fs'),cp=require('node:child_process');
if(process.version!=='v24.14.0')process.exit(90);
const p=cp.spawnSync('pnpm',['--version'],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',npm_config_manage_package_manager_versions:'false'}});
if(p.status!==0||p.stdout.trim()!=='12.5.1')process.exit(90);
for(const file of ['/opt/slop-loop-preparation/preparationworker.js','/opt/slop-loop-preparation/connectbrokerentry.js','/usr/sbin/iptables','/usr/sbin/ip6tables'])if(!fs.statSync(file).isFile())process.exit(90);
if(fs.existsSync('/preparation/node_modules')||fs.existsSync('/tmp/store'))process.exit(90);
process.stdout.write('base-prerequisites:PASS');`;

export class DockerPreparationRuntime {
  private readonly network: DockerPreparationNetwork;
  private readonly transfer: DockerProducerTransfer;
  private readonly actions = new Map<string, RuntimeAction>();
  constructor(
    readonly baseImageId: string,
    readonly privateRoot: string,
    readonly publisher: PreparedImagePublisher,
    readonly command: PreparationDockerCommand = localPreparationDockerCommand,
    private readonly io: PreparationDockerIO = localPreparationDockerIO,
    transfer?: DockerProducerTransfer,
  ) {
    this.network = new DockerPreparationNetwork(baseImageId, command);
    this.transfer = transfer ?? new DockerProducerTransfer(command);
  }

  async fetch(
    actionId: string,
    graph: LockedGraph,
    lease: PreparationStorageLease,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, Buffer>> {
    if (!isValidatedGraph(graph)) throw new Error("Untrusted locked graph");
    if (!isStorageLease(lease) || this.actions.has(actionId))
      throw new Error("Preparation admission unavailable");
    signal.throwIfAborted();
    await lease.revalidate();
    const engine = z
      .object({
        ID: z.string(),
        OSType: z.literal("linux"),
        Architecture: z.enum(["amd64", "x86_64"]),
        SecurityOptions: z.array(z.string()),
      })
      .parse(JSON.parse(await this.command(["info", "--format", "{{json .}}"], signal)));
    if (
      engine.ID !== lease.engineId ||
      !engine.SecurityOptions.some(
        (entry) => entry.startsWith("name=seccomp") && !entry.includes("unconfined"),
      )
    )
      throw new Error("Supported preparation engine unavailable");
    const base = z
      .array(
        z.object({
          Id: z.string(),
          Os: z.literal("linux"),
          Architecture: z.literal("amd64"),
          Config: z.object({
            OnBuild: z.array(z.string()).nullable().optional(),
            Volumes: z.record(z.string(), z.unknown()).nullable().optional(),
          }),
        }),
      )
      .length(1)
      .parse(
        JSON.parse(await this.command(["image", "inspect", "--", this.baseImageId], signal)),
      )[0]!;
    if (
      base.Id !== this.baseImageId ||
      base.Config.OnBuild?.length ||
      (base.Config.Volumes && Object.keys(base.Config.Volumes).length)
    )
      throw new Error("Immutable preparation base unavailable");
    const state: RuntimeAction = { graph, lease, packages: [], phase: "FETCHING" };
    this.actions.set(actionId, state);
    state.admission = await this.network.open(actionId, lease.engineId, signal);
    state.producer = this.transfer.register(state.admission);
    const prerequisite = await this.command(
      ["exec", state.admission.containerId, "node", "-e", basePrerequisites],
      signal,
    );
    if (prerequisite !== "base-prerequisites:PASS")
      throw new Error("Prepared toolchain prerequisites unavailable");
    const argv = (phase: string) => [
      "exec",
      "-i",
      state.admission!.containerId,
      "node",
      "/opt/slop-loop-preparation/preparationworker.js",
      phase,
    ];
    if (
      (
        await this.io(
          argv("fetch"),
          Buffer.from(JSON.stringify({ lockfile: graph.lockfile, manifest: graph.manifest })),
          signal,
        )
      ).toString("utf8") !== "fetch:PASS"
    )
      throw new Error("Restricted fetch incomplete");
    const artifacts = new Map<string, Buffer>();
    let bytes = 0;
    for (const [index, artifact] of graph.artifacts.entries()) {
      signal.throwIfAborted();
      await lease.revalidate();
      const downloaded = await this.io(
        argv("artifact"),
        Buffer.from(JSON.stringify({ index })),
        signal,
      );
      bytes += downloaded.length;
      if (bytes > 2 * 1024 ** 3) throw new Error("Preparation download limit exceeded");
      state.packages.push(await verifyPackageTarball(artifact, downloaded));
      artifacts.set(`${artifact.name}@${artifact.version}`, downloaded);
    }
    state.phase = "FETCHED";
    return artifacts;
  }

  async materialize(
    actionId: string,
    graph: LockedGraph,
    signal: AbortSignal,
  ): Promise<PreparationProducer> {
    const state = this.actions.get(actionId);
    if (
      !state ||
      state.phase !== "FETCHED" ||
      state.graph !== graph ||
      !state.admission ||
      !state.producer
    )
      throw new Error("Offline materialization authority unavailable");
    signal.throwIfAborted();
    await state.lease.revalidate();
    state.phase = "MATERIALIZING";
    await this.network.disconnect(state.admission, signal);
    const output = await this.io(
      [
        "exec",
        "-i",
        state.admission.containerId,
        "node",
        "/opt/slop-loop-preparation/preparationworker.js",
        "materialize",
      ],
      Buffer.from(
        JSON.stringify({
          lockfile: graph.lockfile,
          manifest: graph.manifest,
        }),
      ),
      signal,
    );
    if (output.toString("utf8") !== "materialize:PASS")
      throw new Error("Offline materialization failed");
    state.phase = "MATERIALIZED";
    return state.producer;
  }

  async importWithoutCAS(
    actionId: string,
    archive: FrozenArchive,
    tree: ValidatedDependencyTree,
    signal: AbortSignal,
    normalizedTar: Buffer,
  ): Promise<PreparationProducer> {
    const state = this.actions.get(actionId);
    if (
      !isFrozenArchive(archive) ||
      !isValidatedTree(tree) ||
      !state ||
      state.phase !== "MATERIALIZED" ||
      !state.admission ||
      !state.producer ||
      archive.producer.resourceId !== state.producer.resourceId ||
      archive.producer.actionId !== actionId ||
      archive.producer.generation !== state.producer.generation ||
      archive.producer.engineId !== state.lease.engineId
    )
      throw new Error("Frozen normalization authority unavailable");
    state.phase = "IMPORTING";
    signal.throwIfAborted();
    await state.lease.revalidate();
    const checked = await normalizePnpmOutput(state.graph, state.packages, archive.open());
    if (
      checked.sourceContentId !== archive.contentId ||
      checked.tree.contentId !== tree.contentId ||
      checked.tree.graphId !== tree.graphId ||
      !checked.tar.equals(normalizedTar)
    )
      throw new Error("Frozen normalization mismatch");
    const manifest = await describeCanonicalArchive(normalizedTar);
    const admission = await this.network.createOffline(actionId, state.lease.engineId, signal);
    state.recipient = this.transfer.register(admission);
    const output = await this.io(
      [
        "exec",
        "-i",
        admission.containerId,
        "node",
        "/opt/slop-loop-preparation/preparationworker.js",
        "import",
      ],
      Buffer.from(
        JSON.stringify({
          tar: normalizedTar.toString("base64"),
          manifest,
          contentId: tree.contentId,
          graph: { lockfile: state.graph.lockfile, manifest: state.graph.manifest },
        }),
      ),
      signal,
    );
    if (output.toString("utf8") !== "import:PASS") throw new Error("CAS-free import unconfirmed");
    // The old frozen store is destroyed, never resumed or exposed to dependency code.
    await this.network.removeProducer(state.admission, signal);
    state.tree = tree;
    state.normalizedEntries = manifest;
    state.phase = "IMPORTED";
    return state.recipient;
  }

  async runScripts(
    producer: PreparationProducer,
    instructions: readonly OfflineScriptInstruction[],
    signal: AbortSignal,
  ): Promise<void> {
    const state = this.actions.get(producer.actionId);
    if (
      !state ||
      state.phase !== "IMPORTED" ||
      state.recipient !== producer ||
      !state.tree ||
      !isOfflineScriptPlan(instructions)
    )
      throw new Error("Offline script authority unavailable");
    signal.throwIfAborted();
    await state.lease.revalidate();
    state.phase = "SCRIPTS";
    const output = await this.io(
      [
        "exec",
        "-i",
        producer.resourceId,
        "node",
        "/opt/slop-loop-preparation/preparationworker.js",
        "scripts",
      ],
      Buffer.from(
        JSON.stringify({
          instructions,
          treeId: state.tree.contentId,
          graph: { lockfile: state.graph.lockfile, manifest: state.graph.manifest },
        }),
      ),
      signal,
    );
    if (output.toString("utf8") !== "scripts:PASS") throw new Error("Exact offline scripts failed");
    state.approvedScriptRoots = Object.freeze(instructions.map((instruction) => instruction.root));
    state.phase = "EXECUTED";
  }

  quiesce(producer: PreparationProducer, signal: AbortSignal): Promise<void> {
    return this.transfer.quiesce(producer, signal);
  }
  pause(producer: PreparationProducer, signal: AbortSignal): Promise<void> {
    return this.transfer.pause(producer, signal);
  }
  inspect(producer: PreparationProducer, signal: AbortSignal): Promise<unknown> {
    return this.transfer.inspect(producer, signal);
  }
  export(producer: PreparationProducer, signal: AbortSignal): Promise<Readable> {
    return this.transfer.export(producer, signal);
  }

  async buildCandidate(
    archive: FrozenArchive,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<PublishedImageCandidate> {
    const state = this.actions.get(archive.producer.actionId);
    if (
      !isFrozenArchive(archive) ||
      !state ||
      state.phase !== "EXECUTED" ||
      !state.recipient ||
      archive.producer.resourceId !== state.recipient.resourceId ||
      archive.producer.generation !== state.recipient.generation ||
      archive.producer.engineId !== state.lease.engineId
    )
      throw new Error("Final frozen output authority unavailable");
    signal.throwIfAborted();
    await state.lease.revalidate();
    state.phase = "PUBLISHING";
    if (!state.normalizedEntries || !state.approvedScriptRoots)
      throw new Error("Post-script provenance unavailable");
    const prior = new Map(state.normalizedEntries.map((entry) => [entry.path, entry]));
    const final = new Map(
      archive.entries
        .filter((entry) => entry.path.startsWith("node_modules/"))
        .map((entry) => [entry.path.slice("node_modules/".length), entry]),
    );
    const scriptOutput = (name: string) =>
      state.approvedScriptRoots!.some((root) => name.startsWith(`${root}/`));
    const requiredDirectories = new Set<string>();
    for (const name of prior.keys()) {
      const segments = name.split("/");
      for (let end = 1; end < segments.length; end++)
        requiredDirectories.add(segments.slice(0, end).join("/"));
    }
    for (const [name, original] of prior) {
      if (scriptOutput(name)) continue;
      const observed = final.get(name);
      if (
        !observed ||
        observed.kind !== original.kind ||
        observed.size !== original.size ||
        observed.mode !== original.mode ||
        observed.target !== original.target ||
        observed.hash !== original.hash
      )
        throw new Error("Post-script provenance changed");
    }
    for (const [name, entry] of final)
      if (
        !prior.has(name) &&
        !scriptOutput(name) &&
        !(entry.kind === "directory" && entry.mode === 0o755 && requiredDirectories.has(name))
      )
        throw new Error("Post-script provenance changed");
    state.candidate = await this.publisher.buildFrozen(
      archive,
      fingerprint,
      signal,
      (category, bytes) => state.lease.account(category, bytes),
    );
    if (!isPublishedImageCandidate(state.candidate))
      throw new Error("Immutable publication evidence unavailable");
    const image = z
      .array(
        z.object({
          Id: z.string(),
          Size: z
            .number()
            .int()
            .nonnegative()
            .max(4 * 1024 ** 3),
        }),
      )
      .length(1)
      .parse(
        JSON.parse(await this.command(["image", "inspect", "--", state.candidate.imageId], signal)),
      )[0]!;
    if (image.Id !== state.candidate.imageId)
      throw new Error("Publication image accounting identity changed");
    state.lease.account("image", image.Size);
    state.phase = "PUBLISHED";
    return state.candidate;
  }

  async cleanup(actionId: string): Promise<"CONFIRMED" | "UNCERTAIN"> {
    const state = this.actions.get(actionId);
    if (!state || state.phase === "CLEANED") return "CONFIRMED";
    let cleanup: "CONFIRMED" | "UNCERTAIN" = state.networkCleanupConfirmed
      ? "CONFIRMED"
      : await this.network.cleanup(actionId);
    if (cleanup === "CONFIRMED") state.networkCleanupConfirmed = true;
    if (state.candidate && state.phase !== "PUBLISHED") {
      if (
        (await this.publisher.discard(state.candidate, AbortSignal.timeout(10_000))) === "CONFIRMED"
      )
        delete state.candidate;
      else cleanup = "UNCERTAIN";
    }
    if ((await this.publisher.cleanup(actionId)) !== "CONFIRMED") cleanup = "UNCERTAIN";
    if (cleanup === "CONFIRMED") state.phase = "CLEANED";
    return cleanup;
  }

  async discardPublication(record: PreparedImageRecord): Promise<"CONFIRMED" | "UNCERTAIN"> {
    const state = [...this.actions.values()].find(
      (action) =>
        action.candidate?.imageId === record.imageId &&
        action.candidate.fingerprint === record.fingerprint,
    );
    if (!state?.candidate) return "UNCERTAIN";
    return await this.publisher.discard(state.candidate, AbortSignal.timeout(10_000));
  }
}

async function describeCanonicalArchive(
  bytes: Buffer,
): Promise<readonly (ArchiveEntry & { readonly hash?: string })[]> {
  const hashes = new Map<string, string>();
  const entries = await parseTarStream(
    Readable.from([bytes]),
    { allowRelativeSymlinks: true },
    async (entry, stream) => {
      const hash = createHash("sha256");
      for await (const value of stream) {
        const bytes: unknown = value;
        if (!(bytes instanceof Uint8Array))
          throw new Error("Canonical archive payload is not binary");
        hash.update(bytes);
      }
      hashes.set(entry.path, hash.digest("hex"));
    },
  );
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        ...entry,
        ...(entry.kind === "file" ? { hash: hashes.get(entry.path) } : {}),
      }),
    ),
  );
}
