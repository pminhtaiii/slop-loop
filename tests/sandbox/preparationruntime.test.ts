import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DockerProducerTransfer } from "../../src/sandbox/produceradapter.js";
import { freezeAndSeal, type FrozenArchive } from "../../src/sandbox/frozentransfer.js";
import { normalizePnpmOutput } from "../../src/sandbox/normalization.js";
import { planOfflineScripts } from "../../src/sandbox/offlinescripts.js";
import { verifyPackageTarball } from "../../src/sandbox/packagecontent.js";
import type { PreparationDockerCommand } from "../../src/sandbox/preparationnetwork.js";
import { z } from "zod";
import * as runtime from "../../src/sandbox/preparationruntime.js";
import {
  PreparedImagePublisher,
  preparationPublicationRecipeHash,
} from "../../src/sandbox/preparationpublication.js";
import os from "node:os";
import { parseLockedGraph } from "../../src/sandbox/downloads.js";
import { PreparationStorage } from "../../src/sandbox/preparationstorage.js";
import {
  PreparationConfiguration,
  prepareVerification,
} from "../../src/sandbox/preparationcoordinator.js";
import { createPreparationAction } from "../../src/sandbox/preparation.js";
import { offlineScriptPolicyIdentity } from "../../src/sandbox/offlinescripts.js";
import { createGitCheckout } from "../workspace/fixtures.js";
import { selectWorkspace, closeWorkspace } from "../../src/workspace/admission.js";
import { writePreparedImageRecord } from "../../src/sandbox/preparationpublication.js";
import type { PreparationDockerIO } from "../../src/sandbox/preparationio.js";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { Readable } from "node:stream";

const fixtureRoots: string[] = [];
const archives: FrozenArchive[] = [];
afterEach(() => {
  for (const archive of archives.splice(0)) archive.dispose();
  for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function drain(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function journeyFixture(
  fault?: "cas-removal" | "cleanup" | "quota" | "final-mutation",
  active = false,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-runtime-fixture-"));
  fixtureRoots.push(root);
  const packageJson = active
    ? '{"name":"fixture","version":"1.0.0","scripts":{"install":"echo approved"}}'
    : '{"name":"fixture","version":"1.0.0"}';
  const packageTar = tar.pack();
  packageTar.entry({ name: "package/package.json", mode: 0o644 }, packageJson);
  packageTar.finalize();
  const artifactBytes = gzipSync(await drain(packageTar));
  const integrity = "sha512-" + createHash("sha512").update(artifactBytes).digest("base64");
  const lockfile = `lockfileVersion: '9.0'\nimporters:\n  .:\n    optionalDependencies:\n      fixture: {specifier: 1.0.0, version: 1.0.0}\npackages:\n  fixture@1.0.0:\n    resolution: {integrity: ${integrity}}\n    os: [${active ? "linux" : "darwin"}]\nsnapshots:\n  fixture@1.0.0: {}\n`;
  const graph = parseLockedGraph(lockfile, '{"optionalDependencies":{"fixture":"1.0.0"}}');
  const packages = [await verifyPackageTarball(graph.artifacts[0]!, artifactBytes)];
  const raw = tar.pack();
  raw.entry({ name: "node_modules", type: "directory", mode: 0o755 });
  if (active) {
    raw.entry(
      { name: "node_modules/.pnpm/physical-slot/node_modules/fixture/package.json", mode: 0o644 },
      packageJson,
    );
    raw.entry({
      name: "node_modules/fixture",
      type: "symlink",
      mode: 0o777,
      linkname: ".pnpm/physical-slot/node_modules/fixture",
    });
  }
  raw.entry({ name: "node_modules/.pnpm/lock.yaml", mode: 0o644 }, lockfile);
  raw.entry(
    { name: "node_modules/.modules.yaml", mode: 0o644 },
    JSON.stringify({
      hoistedDependencies: {},
      hoistPattern: [],
      publicHoistPattern: [],
      included: { dependencies: true, devDependencies: true, optionalDependencies: true },
      layoutVersion: 5,
      nodeLinker: "isolated",
      packageManager: "pnpm@12.5.1",
      pendingBuilds: active ? ["fixture@1.0.0"] : [],
      skipped: active ? [] : ["fixture@1.0.0"],
      prunedAt: "2026-10-09T00:00:00Z",
      storeDir: "/tmp/store/v11",
      virtualStoreDir: "/preparation/node_modules/.pnpm",
      virtualStoreDirMaxLength: 120,
    }),
  );
  raw.finalize();
  const rawBytes = await drain(raw);
  const normalized = await normalizePnpmOutput(graph, packages, Readable.from([rawBytes]));
  const finalPack = tar.pack();
  finalPack.entry({ name: "node_modules", type: "directory", mode: 0o755 });
  finalPack.entry(
    { name: "node_modules/.slop-loop-tree.json", mode: 0o644 },
    '{"recipe":"pnpm-12.5.1-closed-v1","linker":"isolated","bins":"relative-links"}\n',
  );
  if (fault === "final-mutation")
    finalPack.entry({ name: "node_modules/unapproved.js", mode: 0o755 }, "unchecked output");
  finalPack.finalize();
  const finalBytes = await drain(finalPack);
  const base = "sha256:" + "a".repeat(64),
    imageId = "sha256:" + "b".repeat(64);
  const containers = new Map<
    string,
    { id: string; generation: string; paused: boolean; labels: Record<string, string> }
  >();
  const calls: string[] = [];
  const imageLabels: Record<string, string> = {};
  let smokeName = "";
  let removedImage = false;
  let networkActionId = "action";
  const command: PreparationDockerCommand = async (argv) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (argv[0] === "info")
      return JSON.stringify({
        ID: "engine",
        OSType: "linux",
        Architecture: "amd64",
        SecurityOptions: ["name=seccomp,profile=builtin"],
      });
    if (argv[0] === "network" && argv[1] === "inspect")
      return JSON.stringify([
        {
          Internal: true,
          Id: "net-id",
          Labels: { "slop-loop.actionId": networkActionId, "slop-loop.generation": "1" },
        },
      ]);
    if (argv[0] === "network" && argv[1] === "disconnect") {
      calls.push("disconnect");
      return "";
    }
    if (argv[0] === "network") {
      if (argv[1] === "create")
        networkActionId =
          argv
            .find((value) => value.startsWith("slop-loop.actionId="))
            ?.slice("slop-loop.actionId=".length) ?? "";
      return "";
    }
    if (argv[0] === "create" || argv[0] === "run") {
      const name = argv[argv.indexOf("--name") + 1]!;
      const labels: Record<string, string> = {};
      for (let i = 0; i < argv.length; i++)
        if (argv[i] === "--label") {
          const [key, value] = argv[i + 1]!.split("=");
          labels[key!] = value!;
        }
      const id = name.endsWith("-fetch")
        ? "f".repeat(64)
        : name.endsWith("-offline")
          ? "e".repeat(64)
          : String(containers.size + 1).padStart(64, "0");
      containers.set(name, {
        id,
        generation: labels["slop-loop.generation"] ?? "1",
        paused: false,
        labels,
      });
      if (name.startsWith("slop-loop-smoke-")) {
        smokeName = name;
        return "slop-loop-prerequisites:PASS";
      }
      return argv[0] === "run" ? "egress-policy-installed" : id;
    }
    if (argv[0] === "start") return "";
    if (argv[0] === "inspect") {
      const name = [...containers].find(([name, c]) => name === argv[1] || c.id === argv[1]);
      if (!name) throw new Error("Fixture container unavailable");
      const [containerName, c] = name;
      return JSON.stringify([
        {
          Id: c.id,
          Image: imageId,
          Name: "/" + containerName,
          State: { Running: containerName !== smokeName, Paused: c.paused, ExitCode: 0 },
          Config: { Labels: c.labels },
          HostConfig: { NetworkMode: c.generation === "2" ? "none" : "bridge" },
          NetworkSettings: { SandboxKey: "namespace-" + c.generation, Networks: {} },
        },
      ]);
    }
    if (argv[0] === "exec")
      return argv.at(-1)?.includes("broker:READY")
        ? "broker:READY"
        : argv.at(-1)?.includes("producer-quiescent")
          ? "producer-quiescent"
          : "base-prerequisites:PASS";
    if (argv[0] === "pause") {
      const c = [...containers.values()].find((c) => c.id === argv[1])!;
      c.paused = true;
      calls.push("freeze:" + c.generation);
      return "";
    }
    if (argv[0] === "container") {
      const name = argv.at(-1)!.slice("name=^/".length, -1);
      return containers.get(name)?.id ?? "";
    }
    if (argv[0] === "rm") {
      const found = [...containers].find(([, c]) => c.id === argv.at(-1));
      if (found?.[0].endsWith("-fetch")) {
        calls.push("destroy-cas");
        if (fault === "cas-removal") return "";
      }
      if (fault === "cleanup" && found?.[0].endsWith("-offline")) return "";
      if (found) containers.delete(found[0]);
      return "";
    }
    if (argv[0] === "build") {
      calls.push("build");
      expect(
        fs.readFileSync(path.join(argv.at(-1)!, "tree/.slop-loop-tree.json"), "utf8"),
      ).toContain('"recipe":"pnpm-12.5.1-closed-v1"');
      for (let i = 0; i < argv.length; i++)
        if (argv[i] === "--label") {
          const [key, value] = argv[i + 1]!.split("=");
          imageLabels[key!] = value!;
        }
      fs.writeFileSync(argv[argv.indexOf("--iidfile") + 1]!, imageId);
      return "";
    }
    if (argv[0] === "image" && argv[1] === "inspect")
      return JSON.stringify([
        {
          Id: argv.at(-1) === base ? base : imageId,
          Os: "linux",
          Architecture: "amd64",
          Size: fault === "quota" ? 2 * 1024 ** 2 : 1024,
          Config: { OnBuild: [], Volumes: {}, Labels: argv.at(-1) === base ? {} : imageLabels },
        },
      ]);
    if (argv[0] === "image" && argv[1] === "ls") return removedImage ? "" : imageId;
    if (argv[0] === "image" && argv[1] === "rm") {
      removedImage = true;
      calls.push("discard-image");
      return "";
    }
    throw new Error("Unexpected controlled operation: " + argv[0]);
  };
  const storage = new PreparationStorage(() =>
    Promise.resolve({
      engineId: "engine",
      dataRoot: "/dedicated/docker",
      boundary: "/dedicated",
      device: "/dev/loop7",
      mechanism: "dedicated-block-device",
      deviceBytes: 16 * 1024 ** 3,
      filesystemBytes: 15 * 1024 ** 3,
      availableBytes: 10 * 1024 ** 3,
      mountId: "47",
      dedicated: true,
      imageStorage: "classic-overlay2",
      builder: "legacy-local",
    }),
  );
  const lease = await storage.admit("workspace", 1024 ** 2);
  const transfer = new DockerProducerTransfer(command, (producer) =>
    Promise.resolve(Readable.from([producer.generation === 1 ? rawBytes : finalBytes])),
  );
  const io: PreparationDockerIO = async (argv, input) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const payload = z
      .object({
        treeId: z.string().optional(),
        contentId: z.string().optional(),
        instructions: z.array(z.unknown()).optional(),
      })
      .parse(JSON.parse(input.toString()));
    const phase = argv[5]!;
    calls.push(phase);
    if (phase === "artifact") return artifactBytes;
    if (phase === "scripts") {
      expect(payload.treeId).toBe(normalized.tree.contentId);
      if (active)
        expect(payload.instructions).toEqual([
          {
            nodeKey: "fixture@1.0.0",
            root: graph.nodes[0]!.root,
            integrity,
            phase: "install",
            command: "echo approved",
          },
        ]);
      else expect(payload.instructions).toEqual([]);
    }
    if (phase === "import") expect(payload.contentId).toBe(normalized.tree.contentId);
    return Buffer.from(phase + ":PASS");
  };
  const production = new runtime.DockerPreparationRuntime(
    base,
    root,
    new PreparedImagePublisher(base, preparationPublicationRecipeHash(base), root, command),
    command,
    io,
    transfer,
  );
  const signal = new AbortController().signal;
  await production.fetch("action", graph, lease, signal);
  const producer = await production.materialize("action", graph, signal);
  const frozen = await freezeAndSeal(producer, production, signal, root);
  archives.push(frozen);
  return {
    production,
    normalized,
    frozen,
    signal,
    calls,
    lease,
    storage,
    root,
    graph,
    imageId,
    packages,
    integrity,
    command,
    io,
    base,
    rawBytes,
    finalBytes,
  };
}

it("connects confirmed developer action to the concrete runtime and atomic publication with controlled external ports", async () => {
  const f = await journeyFixture();
  expect(await f.production.cleanup("action")).toBe("CONFIRMED");
  f.lease.settle("CONFIRMED");
  const checkout = createGitCheckout();
  try {
    checkout.write("package.json", f.graph.manifest);
    checkout.write("pnpm-lock.yaml", f.graph.lockfile);
    const selected = selectWorkspace(checkout.root);
    if (selected.kind !== "SELECTED") throw new Error("Controlled checkout unavailable");
    try {
      const action = createPreparationAction(selected.workspace, {
        baseImageDigest: f.base,
        recipeHash: preparationPublicationRecipeHash(f.base),
        managerConfigHash: "a".repeat(64),
        scriptPolicyId: offlineScriptPolicyIdentity([]),
        nodeVersion: "24.14.0",
        pnpmVersion: "12.5.1",
        architecture: "linux-x64",
      });
      const ports = new DockerProducerTransfer(f.command, (producer) =>
        Promise.resolve(Readable.from([producer.generation === 1 ? f.rawBytes : f.finalBytes])),
      );
      const production = new runtime.DockerPreparationRuntime(
        f.base,
        f.root,
        new PreparedImagePublisher(
          f.base,
          preparationPublicationRecipeHash(f.base),
          f.root,
          f.command,
        ),
        f.command,
        f.io,
        ports,
      );
      const recordFile = path.join(f.root, "prepared-image.json");
      const configuration = new PreparationConfiguration(
        (workspaceId) => f.storage.admit(workspaceId, 4 * 1024 ** 3),
        production,
        [],
        (record) => writePreparedImageRecord(record, recordFile),
        f.root,
        (record) => production.discardPublication(record),
      );
      const result = await prepareVerification(
        { action, receipt: action.confirm(action.challenge) },
        configuration,
        new AbortController().signal,
      );
      expect(result.status).toBe("READY");
      expect(JSON.parse(fs.readFileSync(recordFile, "utf8"))).toMatchObject({
        imageId: f.imageId,
        fingerprint: action.fingerprint,
        status: "READY",
      });
      expect(f.calls).toContain("destroy-cas");
      expect(f.calls).toContain("scripts");
      expect(f.calls).toContain("build");
    } finally {
      closeWorkspace(selected.workspace);
    }
  } finally {
    checkout.cleanup();
  }
});

it("runs the concrete runtime through frozen normalization, CAS destruction, exact plan, publication and idempotent cleanup", async () => {
  const f = await journeyFixture();
  const recipient = await f.production.importWithoutCAS(
    "action",
    f.frozen,
    f.normalized.tree,
    f.signal,
    f.normalized.tar,
  );
  await f.production.runScripts(recipient, planOfflineScripts(f.graph, [], []), f.signal);
  const final = await freezeAndSeal(recipient, f.production, f.signal, f.root);
  archives.push(final);
  const candidate = await f.production.buildCandidate(final, "c".repeat(64), f.signal);
  expect(candidate.imageId).toBe(f.imageId);
  expect(f.calls).toEqual([
    "fetch",
    "artifact",
    "disconnect",
    "materialize",
    "freeze:1",
    "import",
    "destroy-cas",
    "scripts",
    "freeze:2",
    "build",
  ]);
  expect(await f.production.cleanup("action")).toBe("CONFIRMED");
  expect(await f.production.cleanup("action")).toBe("CONFIRMED");
});

it("rejects post-script bytes outside exact approved package roots before starting image build", async () => {
  const f = await journeyFixture("final-mutation");
  const recipient = await f.production.importWithoutCAS(
    "action",
    f.frozen,
    f.normalized.tree,
    f.signal,
    f.normalized.tar,
  );
  await f.production.runScripts(recipient, planOfflineScripts(f.graph, [], []), f.signal);
  const final = await freezeAndSeal(recipient, f.production, f.signal, f.root);
  archives.push(final);
  await expect(f.production.buildCandidate(final, "c".repeat(64), f.signal)).rejects.toThrow(
    "Post-script provenance changed",
  );
  expect(f.calls).not.toContain("build");
});

it("keeps dependency code fenced when CAS destruction is unconfirmed", async () => {
  const f = await journeyFixture("cas-removal");
  await expect(
    f.production.importWithoutCAS(
      "action",
      f.frozen,
      f.normalized.tree,
      f.signal,
      f.normalized.tar,
    ),
  ).rejects.toThrow("CAS producer cleanup unconfirmed");
  expect(f.calls).not.toContain("scripts");
  expect(await f.production.cleanup("action")).toBe("UNCERTAIN");
  f.lease.settle("UNCERTAIN");
  await expect(f.storage.admit("workspace", 1)).rejects.toThrow("Preparation already active");
});

it("rejects corrupt normalized output before creating a CAS-free recipient", async () => {
  const f = await journeyFixture();
  await expect(
    f.production.importWithoutCAS(
      "action",
      f.frozen,
      f.normalized.tree,
      f.signal,
      Buffer.from("corrupt"),
    ),
  ).rejects.toThrow("Frozen normalization mismatch");
  expect(f.calls).not.toContain("import");
});

it("accounts the inspected candidate image and discards it when it exceeds the action reservation", async () => {
  const f = await journeyFixture("quota");
  const recipient = await f.production.importWithoutCAS(
    "action",
    f.frozen,
    f.normalized.tree,
    f.signal,
    f.normalized.tar,
  );
  await f.production.runScripts(recipient, planOfflineScripts(f.graph, [], []), f.signal);
  const final = await freezeAndSeal(recipient, f.production, f.signal, f.root);
  archives.push(final);
  await expect(f.production.buildCandidate(final, "c".repeat(64), f.signal)).rejects.toThrow(
    "Preparation resource limit exceeded",
  );
  expect(await f.production.cleanup("action")).toBe("CONFIRMED");
  expect(f.calls).toContain("discard-image");
});

it("dispatches the issued nonempty exact script plan only into the CAS-free recipient", async () => {
  const f = await journeyFixture(undefined, true);
  const recipient = await f.production.importWithoutCAS(
    "action",
    f.frozen,
    f.normalized.tree,
    f.signal,
    f.normalized.tar,
  );
  const plan = planOfflineScripts(f.graph, f.packages, [
    {
      nodeKey: "fixture@1.0.0",
      integrity: f.integrity,
      phase: "install",
      commandHash: createHash("sha256").update("echo approved").digest("hex"),
    },
  ]);
  await f.production.runScripts(recipient, plan, f.signal);
  expect(recipient.generation).toBe(2);
  expect(f.calls.slice(-3)).toEqual(["import", "destroy-cas", "scripts"]);
  expect(await f.production.cleanup("action")).toBe("CONFIRMED");
});

it("retains the reservation when the final recipient cannot be removed", async () => {
  const f = await journeyFixture("cleanup");
  await f.production.importWithoutCAS(
    "action",
    f.frozen,
    f.normalized.tree,
    f.signal,
    f.normalized.tar,
  );
  const cleanup = await f.production.cleanup("action");
  expect(cleanup).toBe("UNCERTAIN");
  f.lease.settle(cleanup);
  await expect(f.storage.admit("workspace", 1)).rejects.toThrow("Preparation already active");
});

it("refuses an unauthenticated graph before preparing a namespace or fetching", async () => {
  let effects = 0;
  const command = () => {
    effects++;
    return Promise.resolve("");
  };
  const base = "sha256:" + "a".repeat(64);
  const production = new runtime.DockerPreparationRuntime(
    base,
    os.tmpdir(),
    new PreparedImagePublisher(base, preparationPublicationRecipeHash(base), os.tmpdir(), command),
    command,
  );
  await expect(
    production.fetch(
      "action",
      { artifacts: [], manifest: "{}", lockfile: "", nodes: [], roots: {} },
      {
        identity: "forged",
        engineId: "engine",
        account: () => {},
        revalidate: () => Promise.resolve(),
        settle: () => {},
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Untrusted locked graph");
  expect(effects).toBe(0);
  await expect(
    production.importWithoutCAS(
      "action",
      {
        producer: {
          actionId: "action",
          resourceId: "f".repeat(64),
          generation: 1,
          engineId: "engine",
        },
        bytes: 0,
        entries: [],
        contentId: "a".repeat(64),
        open: () => Readable.from([]),
        dispose: () => {},
      },
      { contentId: "a".repeat(64), graphId: "b".repeat(64), recipe: "pnpm-12.5.1-closed-v1" },
      new AbortController().signal,
      Buffer.alloc(0),
    ),
  ).rejects.toThrow("Frozen normalization authority unavailable");
  expect(effects).toBe(0);
});

it("connects real runtime fetch to quota identity, restricted namespace and exact artifact bytes", async () => {
  const pack = tar.pack();
  pack.entry({ name: "package/package.json", mode: 0o644 }, '{"name":"fixture","version":"1.0.0"}');
  pack.finalize();
  const parts: Buffer[] = [];
  for await (const part of pack) parts.push(Buffer.from(part));
  const artifact = gzipSync(Buffer.concat(parts));
  const integrity = "sha512-" + createHash("sha512").update(artifact).digest("base64");
  const graph = parseLockedGraph(
    `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      fixture: {specifier: 1.0.0, version: 1.0.0}\npackages:\n  fixture@1.0.0:\n    resolution: {integrity: ${integrity}}\nsnapshots:\n  fixture@1.0.0: {}\n`,
    '{"dependencies":{"fixture":"1.0.0"}}',
  );
  const calls: string[] = [];
  const base = "sha256:" + "a".repeat(64);
  const command = (argv: readonly string[]) => {
    if (argv[0] === "info")
      return Promise.resolve(
        '{"ID":"engine","OSType":"linux","Architecture":"amd64","SecurityOptions":["name=seccomp,profile=builtin"]}',
      );
    if (argv[0] === "image")
      return Promise.resolve(
        JSON.stringify([
          { Id: base, Os: "linux", Architecture: "amd64", Config: { OnBuild: [], Volumes: {} } },
        ]),
      );
    if (argv[0] === "inspect")
      return Promise.resolve(
        JSON.stringify([
          {
            Id: "f".repeat(64),
            State: { Running: true, Paused: false },
            Config: { Labels: { "slop-loop.actionId": "action", "slop-loop.generation": "1" } },
            NetworkSettings: { SandboxKey: "namespace", Networks: {} },
          },
        ]),
      );
    if (argv[0] === "network" && argv[1] === "inspect")
      return Promise.resolve('[{"Internal":true}]');
    if (argv[0] === "network" && argv[1] === "disconnect") {
      calls.push("disconnect");
      return Promise.resolve("");
    }
    if (argv[0] === "run") return Promise.resolve("egress-policy-installed");
    if (argv[0] === "exec")
      return Promise.resolve(
        argv.at(-1)?.includes("broker:READY") ? "broker:READY" : "base-prerequisites:PASS",
      );
    return Promise.resolve("");
  };
  const storage = new PreparationStorage(() =>
    Promise.resolve({
      engineId: "engine",
      dataRoot: "/dedicated/docker",
      boundary: "/dedicated",
      device: "/dev/loop7",
      mechanism: "dedicated-block-device",
      deviceBytes: 16 * 1024 ** 3,
      filesystemBytes: 15 * 1024 ** 3,
      availableBytes: 10 * 1024 ** 3,
      mountId: "47",
      dedicated: true,
      imageStorage: "classic-overlay2",
      builder: "legacy-local",
    }),
  );
  const lease = await storage.admit("workspace", 4 * 1024 ** 3);
  const production = new runtime.DockerPreparationRuntime(
    base,
    os.tmpdir(),
    new PreparedImagePublisher(base, preparationPublicationRecipeHash(base), os.tmpdir(), command),
    command,
    (argv) => {
      calls.push(argv[5] ?? "unknown");
      return Promise.resolve(argv[5] === "artifact" ? artifact : Buffer.from(`${argv[5]}:PASS`));
    },
  );
  const downloaded = await production.fetch("action", graph, lease, new AbortController().signal);
  expect(downloaded.get("fixture@1.0.0")).toEqual(artifact);
  expect(calls).toEqual(["fetch", "artifact"]);
  const producer = await production.materialize("action", graph, new AbortController().signal);
  expect(producer.generation).toBe(1);
  expect(calls).toEqual(["fetch", "artifact", "disconnect", "materialize"]);
  lease.settle("CONFIRMED");
});
