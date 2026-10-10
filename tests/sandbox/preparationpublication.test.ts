import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import tar from "tar-stream";
import { afterEach, expect, it, vi } from "vitest";
import { importCheckedArchive } from "../../src/sandbox/safeimport.js";
import {
  PreparedImagePublisher,
  preparationPublicationRecipeHash,
  writePreparedImageRecord,
} from "../../src/sandbox/preparationpublication.js";
import type { PreparationDockerCommand } from "../../src/sandbox/preparationnetwork.js";
import { freezeAndSeal } from "../../src/sandbox/frozentransfer.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const base = `sha256:${"a".repeat(64)}`;
const imageId = `sha256:${"b".repeat(64)}`;
const fingerprint = "c".repeat(64);
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slop-loop-publication-fixture-"));
  roots.push(root);
  const content = "sealed dependency bytes";
  const manifest = [
    {
      path: "dependency/index.js",
      kind: "file" as const,
      size: content.length,
      mode: 0o644,
      hash: createHash("sha256").update(content).digest("hex"),
    },
  ];
  const archive = tar.pack();
  archive.entry({ name: manifest[0]!.path, mode: 0o644 }, content);
  archive.finalize();
  const receipt = await importCheckedArchive(
    Readable.from(archive),
    manifest,
    root,
    new AbortController().signal,
  );
  return { root, manifest, receipt };
}
async function publicationFixture(
  fault?:
    | "build"
    | "inspect"
    | "identity"
    | "smoke"
    | "exit"
    | "cleanup"
    | "engine"
    | "basehooks"
    | "oversized"
    | "discardidentity",
  onBuild?: (tag: string, root: string) => void,
) {
  const { root, manifest, receipt } = await fixture();
  const recorded: string[][] = [];
  const labels: Record<string, string> = {};
  let name = "";
  let buildStarted = false;
  let imageRemoved = false;
  let infoCalls = 0;
  const command: PreparationDockerCommand = async (argv) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    recorded.push([...argv]);
    if (argv[0] === "info") {
      infoCalls++;
      return JSON.stringify({
        ID: fault === "engine" && infoCalls > 1 ? "engine-2" : "engine-1",
        OSType: "linux",
        Architecture: "amd64",
      });
    }
    if (argv[0] === "build") {
      onBuild?.(argv[argv.indexOf("--tag") + 1]!, root);
      const context = argv.at(-1)!;
      expect(fs.readFileSync(path.join(context, "Dockerfile"), "utf8")).toContain(`FROM ${base}`);
      expect(fs.readFileSync(path.join(context, "Dockerfile"), "utf8")).toContain(
        "COPY tree/ /opt/slop-loop/node_modules/",
      );
      expect(fs.readFileSync(path.join(context, "tree", manifest[0]!.path), "utf8")).toBe(
        "sealed dependency bytes",
      );
      expect(fs.readdirSync(context).sort()).toEqual(["Dockerfile", "tree"]);
      for (let i = 0; i < argv.length; i++)
        if (argv[i] === "--label") {
          const [key, value] = argv[i + 1]!.split("=");
          labels[key!] = value!;
        }
      buildStarted = true;
      if (fault === "build") throw new Error("Build failed after creating a tagged partial image");
      fs.writeFileSync(argv[argv.indexOf("--iidfile") + 1]!, imageId);
      return "build complete";
    }
    if (argv[0] === "image" && argv[1] === "inspect") {
      if (imageRemoved || (!buildStarted && argv.at(-1) !== base)) throw new Error("Image missing");
      if (fault === "inspect" && argv.at(-1) === imageId) throw new Error("Inspection failed");
      return JSON.stringify([
        {
          Id:
            argv.at(-1) === base
              ? base
              : (fault === "identity" && argv.at(-1) === imageId) || fault === "discardidentity"
                ? base
                : imageId,
          Os: "linux",
          Architecture: "amd64",
          Size: fault === "oversized" && argv.at(-1) !== base ? 4 * 1024 ** 3 + 1 : 1024,
          Config: {
            Labels: argv.at(-1) === base ? {} : labels,
            Volumes: null,
            OnBuild: fault === "basehooks" && argv.at(-1) === base ? ["RUN curl hostile"] : null,
          },
        },
      ]);
    }
    if (argv[0] === "image" && argv[1] === "rm") {
      imageRemoved = true;
      return "removed";
    }
    if (argv[0] === "image" && argv[1] === "ls")
      return buildStarted && !imageRemoved ? imageId : "";
    if (argv[0] === "run") {
      name = argv[argv.indexOf("--name") + 1]!;
      return fault === "smoke" ? "prerequisite unavailable" : "slop-loop-prerequisites:PASS";
    }
    if (argv[0] === "inspect")
      return JSON.stringify([
        {
          Id: "smoke-id",
          Image: imageId,
          Name: `/${name}`,
          Config: { Labels: labels },
          State: { Running: false, ExitCode: fault === "exit" ? 90 : 0 },
        },
      ]);
    if (argv[0] === "rm") return "smoke-id";
    if (argv[0] === "container") return fault === "cleanup" ? "smoke-id" : "";
    throw new Error("Unexpected Docker operation");
  };
  return {
    root,
    manifest,
    receipt,
    recorded,
    setFault: (next: typeof fault) => {
      fault = next;
    },
    publisher: new PreparedImagePublisher(
      base,
      preparationPublicationRecipeHash(base),
      root,
      command,
    ),
  };
}
function expectRetainedPublicationOwnership(root: string, checkedRoot: string): void {
  const names = fs.readdirSync(root);
  expect(names).toContain(path.basename(checkedRoot));
  const journals = names.filter((name) => name.startsWith(".publication-owner-"));
  const contexts = names.filter((name) => name.startsWith("publication-"));
  expect(journals).toHaveLength(1);
  expect(contexts).toHaveLength(1);
  const owner = JSON.parse(fs.readFileSync(path.join(root, journals[0]!), "utf8")) as {
    context: string;
    tag: string;
  };
  expect(owner.context).toBe(path.join(root, contexts[0]!));
  expect(owner.tag).toMatch(/^slop-loop-publication:/u);
}
function expectCandidateOwnership(root: string, checkedRoot: string): void {
  const names = fs.readdirSync(root);
  expect(names).toContain(path.basename(checkedRoot));
  const journals = names.filter((name) => name.startsWith(".publication-owner-"));
  expect(journals).toHaveLength(1);
  expect(names).toHaveLength(2);
  const owner = JSON.parse(fs.readFileSync(path.join(root, journals[0]!), "utf8")) as {
    tag: string;
    engineId: string;
  };
  expect(owner.tag).toMatch(/^slop-loop-publication:/u);
  expect(owner.engineId).toBe("engine-1");
}
it("persists owned build identity before the first Docker build effect", async () => {
  let observed = false;
  const { receipt, manifest, publisher } = await publicationFixture("build", (tag, root) => {
    const journals = fs.readdirSync(root).filter((name) => name.startsWith(".publication-owner-"));
    expect(journals).toHaveLength(1);
    const entry = JSON.parse(fs.readFileSync(path.join(root, journals[0]!), "utf8")) as {
      tag: string;
      engineId: string;
      actionId: string;
      publicationId: string;
    };
    expect(entry).toMatchObject({ tag, engineId: "engine-1" });
    expect(entry.actionId).toBeTruthy();
    expect(entry.publicationId).toBeTruthy();
    observed = true;
  });
  await expect(
    publisher.build(receipt, manifest, fingerprint, new AbortController().signal),
  ).rejects.toThrow();
  expect(observed).toBe(true);
});
it("records build-context ownership before creating its private directory", async () => {
  const { root, receipt, manifest, publisher } = await publicationFixture();
  const original = fs.mkdirSync;
  let observed = false;
  vi.spyOn(fs, "mkdirSync").mockImplementation((target, options) => {
    if (
      path.dirname(String(target)) === root &&
      path.basename(String(target)).startsWith("publication-")
    ) {
      const journals = fs
        .readdirSync(root)
        .filter((name) => name.startsWith(".publication-owner-"));
      expect(journals).toHaveLength(1);
      const entry = JSON.parse(fs.readFileSync(path.join(root, journals[0]!), "utf8")) as {
        context: string;
        publicationId: string;
      };
      expect(entry.context).toBe(String(target));
      expect(entry.publicationId).toBeTruthy();
      observed = true;
    }
    return original(target, options);
  });
  await publisher.build(receipt, manifest, fingerprint, new AbortController().signal);
  expect(observed).toBe(true);
});
it("retains the owned image journal after candidate creation until discard is confirmed", async () => {
  const { root, receipt, manifest, publisher, setFault } = await publicationFixture();
  const candidate = await publisher.build(
    receipt,
    manifest,
    fingerprint,
    new AbortController().signal,
  );
  const journals = () =>
    fs.readdirSync(root).filter((name) => name.startsWith(".publication-owner-"));
  expect(journals()).toHaveLength(1);
  setFault("discardidentity");
  expect(await publisher.discard(candidate, new AbortController().signal)).toBe("UNCERTAIN");
  expect(journals()).toHaveLength(1);
  setFault(undefined);
  expect(await publisher.discard(candidate, new AbortController().signal)).toBe("CONFIRMED");
  expect(journals()).toHaveLength(0);
});
it("records private frozen-input staging ownership before creating the build context", async () => {
  let observed = false;
  const { publisher } = await publicationFixture(undefined, (_tag, root) => {
    const names = fs.readdirSync(root);
    const stageJournal = names.find((name) => name.startsWith(".publication-stage-"));
    expect(stageJournal).toBeTruthy();
    const owner = JSON.parse(fs.readFileSync(path.join(root, stageJournal!), "utf8")) as {
      actionId: string;
      root: string;
    };
    expect(owner.actionId).toBeTruthy();
    expect(owner.root).toMatch(/publication-input-/u);
    observed = true;
  });
  const archive = await frozenFixture();
  try {
    await publisher.buildFrozen(
      archive,
      fingerprint,
      new AbortController().signal,
      () => undefined,
    );
    expect(observed).toBe(true);
  } finally {
    archive.dispose();
  }
});
it("publishes only the inspected immutable Linux image after prerequisite smoke and owned cleanup", async () => {
  const { root, manifest, receipt, recorded, publisher } = await publicationFixture();
  const candidate = await publisher.build(
    receipt,
    manifest,
    fingerprint,
    new AbortController().signal,
  );
  expect(candidate).toEqual({
    imageId,
    fingerprint,
    architecture: "linux-x64",
    baseImageDigest: base,
    recipeHash: preparationPublicationRecipeHash(base),
    prerequisiteOutput: "slop-loop-prerequisites:PASS",
  });
  expect(
    recorded.some(
      (argv) => argv[0] === "run" && argv.includes("--network=none") && argv.includes(imageId),
    ),
  ).toBe(true);
  expect(recorded.find((argv) => argv[0] === "build")).toContain(
    `slop-loop.preparationFingerprint=${fingerprint}`,
  );
  expect(recorded.find((argv) => argv[0] === "build")).toEqual(
    expect.arrayContaining([
      "--network=none",
      "--pull=false",
      "--memory=4g",
      "--memory-swap=4g",
      "--cpu-period=100000",
      "--cpu-quota=200000",
    ]),
  );
  expectCandidateOwnership(root, receipt.root);
});

it("removes only its tagged partial image and retains recovery ownership when a build fails", async () => {
  const { root, receipt, manifest, publisher, recorded } = await publicationFixture("build");
  await expect(
    publisher.build(receipt, manifest, fingerprint, new AbortController().signal),
  ).rejects.toThrow("Build failed");
  expect(
    recorded.some(
      (argv) =>
        argv[0] === "image" &&
        argv[1] === "rm" &&
        argv.at(-1)?.startsWith("slop-loop-publication:"),
    ),
  ).toBe(true);
  expect(recorded.some((argv) => argv.includes("prune"))).toBe(false);
  expectRetainedPublicationOwnership(root, receipt.root);
});

it.each(["inspect", "identity", "smoke", "exit"] as const)(
  "blocks publication on %s failure and removes only owned output",
  async (fault) => {
    const { root, receipt, manifest, publisher, recorded } = await publicationFixture(fault);
    await expect(
      publisher.build(receipt, manifest, fingerprint, new AbortController().signal),
    ).rejects.toThrow();
    expect(recorded.some((argv) => argv[0] === "image" && argv[1] === "rm")).toBe(true);
    expect(fs.readdirSync(root)).toEqual([path.basename(receipt.root)]);
  },
);
it("refuses inherited base build instructions before starting a build", async () => {
  const { receipt, manifest, publisher, recorded } = await publicationFixture("basehooks");
  await expect(
    publisher.build(receipt, manifest, fingerprint, new AbortController().signal),
  ).rejects.toThrow("base unavailable");
  expect(recorded.some((argv) => argv[0] === "build")).toBe(false);
});
it("refuses an inspected image exceeding the finite image limit and removes its owned tag", async () => {
  const { receipt, manifest, publisher, recorded } = await publicationFixture("oversized");
  await expect(
    publisher.build(receipt, manifest, fingerprint, new AbortController().signal),
  ).rejects.toThrow("image mismatch");
  expect(recorded.some((argv) => argv[0] === "image" && argv[1] === "rm")).toBe(true);
});

it.each(["cleanup", "engine"] as const)(
  "withholds the candidate when %s settlement is uncertain",
  async (fault) => {
    const { root, receipt, manifest, publisher, recorded } = await publicationFixture(fault);
    await expect(
      publisher.build(receipt, manifest, fingerprint, new AbortController().signal),
    ).rejects.toThrow("cleanup unconfirmed");
    expectRetainedPublicationOwnership(root, receipt.root);
    if (fault === "engine") expect(recorded.some((argv) => argv[0] === "rm")).toBe(false);
  },
);

it("refuses forged import receipts, changed bytes and unchecked Dockerfiles before invoking Docker", async () => {
  const { root, receipt, manifest, publisher, recorded } = await publicationFixture();
  await expect(
    publisher.build({ ...receipt }, manifest, fingerprint, new AbortController().signal),
  ).rejects.toThrow("Checked publication import unavailable");
  fs.writeFileSync(path.join(receipt.root, "Dockerfile"), "RUN hostile");
  await expect(
    publisher.build(receipt, manifest, fingerprint, new AbortController().signal),
  ).rejects.toThrow("content mismatch");
  fs.unlinkSync(path.join(receipt.root, "Dockerfile"));
  fs.writeFileSync(path.join(receipt.root, manifest[0]!.path), "modified sealed content");
  await expect(
    publisher.build(receipt, manifest, fingerprint, new AbortController().signal),
  ).rejects.toThrow("import changed");
  expect(recorded).toEqual([]);
  expect(fs.readdirSync(root)).toEqual([path.basename(receipt.root)]);
});

it("atomically replaces the private record and rejects invalid records without losing the prior image", async () => {
  const { root } = await fixture();
  const filename = path.join(root, "prepared.json");
  fs.writeFileSync(filename, "previous good record\n");
  const record = { imageId, fingerprint, architecture: "linux-x64", status: "READY" as const };
  await expect(
    writePreparedImageRecord({ ...record, fingerprint: "forged" }, filename),
  ).rejects.toThrow();
  expect(fs.readFileSync(filename, "utf8")).toBe("previous good record\n");
  await writePreparedImageRecord(record, filename);
  expect(JSON.parse(fs.readFileSync(filename, "utf8"))).toEqual(record);
  expect(fs.readdirSync(root).some((name) => name.startsWith(".prepared-record-"))).toBe(false);
});

it("rolls back only the exact newly committed record and restores previous bytes", async () => {
  const { root } = await fixture();
  const filename = path.join(root, "prepared.json");
  fs.writeFileSync(filename, "previous good record\n");
  const record = { imageId, fingerprint, architecture: "linux-x64", status: "READY" as const };
  const rollback = await writePreparedImageRecord(record, filename);
  await rollback();
  expect(fs.readFileSync(filename, "utf8")).toBe("previous good record\n");
  await expect(rollback()).rejects.toThrow("replayed");
  const rollbackChanged = await writePreparedImageRecord(record, filename);
  const replacement = path.join(root, "other-record");
  fs.writeFileSync(replacement, "changed by another owner");
  fs.renameSync(replacement, filename);
  await expect(rollbackChanged()).rejects.toThrow("changed");
});

it("preserves another record when the target is a hard link and refuses cancellation before Docker", async () => {
  const { root, receipt, manifest, publisher, recorded } = await publicationFixture();
  const original = path.join(root, "previous.json"),
    alias = path.join(root, "prepared.json");
  fs.writeFileSync(original, "previous good record");
  fs.linkSync(original, alias);
  await expect(
    writePreparedImageRecord(
      { imageId, fingerprint, architecture: "linux-x64", status: "READY" },
      alias,
    ),
  ).rejects.toThrow("identity unavailable");
  expect(fs.readFileSync(original, "utf8")).toBe("previous good record");
  const aborted = new AbortController();
  aborted.abort();
  await expect(publisher.build(receipt, manifest, fingerprint, aborted.signal)).rejects.toThrow();
  expect(recorded).toEqual([]);
});
it("retains the last good record and deletes only its temporary file when atomic replacement fails", async () => {
  const { root } = await fixture();
  const filename = path.join(root, "prepared.json");
  fs.writeFileSync(filename, "previous good record\n");
  vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(
    new Error("Controlled external atomic-write failure"),
  );
  await expect(
    writePreparedImageRecord(
      { imageId, fingerprint, architecture: "linux-x64", status: "READY" },
      filename,
    ),
  ).rejects.toThrow("Controlled external atomic-write failure");
  expect(fs.readFileSync(filename, "utf8")).toBe("previous good record\n");
  expect(fs.readdirSync(root).some((name) => name.startsWith(".prepared-record-"))).toBe(false);
});
it("discards only the unique owned tag of an observed candidate after record commit fails", async () => {
  const { receipt, manifest, publisher, recorded } = await publicationFixture();
  const candidate = await publisher.build(
    receipt,
    manifest,
    fingerprint,
    new AbortController().signal,
  );
  expect(await publisher.discard({ ...candidate }, new AbortController().signal)).toBe("UNCERTAIN");
  expect(recorded.some((argv) => argv[0] === "image" && argv[1] === "rm")).toBe(false);
  expect(await publisher.discard(candidate, new AbortController().signal)).toBe("CONFIRMED");
  const removals = recorded.filter((argv) => argv[0] === "image" && argv[1] === "rm");
  expect(removals).toHaveLength(1);
  expect(removals[0]).toContain("--no-prune");
  expect(removals[0]?.at(-1)).toMatch(/^slop-loop-publication:/u);
  expect(removals[0]).not.toContain(imageId);
});
it.each(["engine", "discardidentity"] as const)(
  "refuses candidate deletion when %s identity changes",
  async (fault) => {
    const { receipt, manifest, publisher, recorded, setFault } = await publicationFixture();
    const candidate = await publisher.build(
      receipt,
      manifest,
      fingerprint,
      new AbortController().signal,
    );
    setFault(fault);
    expect(await publisher.discard(candidate, new AbortController().signal)).toBe("UNCERTAIN");
    expect(recorded.some((argv) => argv[0] === "image" && argv[1] === "rm")).toBe(false);
  },
);
it("retains independent publication ownership and fences a failed build even before a candidate exists", async () => {
  const { receipt, manifest, publisher } = await publicationFixture("build");
  await expect(
    publisher.build(receipt, manifest, fingerprint, new AbortController().signal, "failed-action"),
  ).rejects.toThrow("Build failed");
  expect(await publisher.cleanup("failed-action")).toBe("UNCERTAIN");
  await expect(
    publisher.build(receipt, manifest, fingerprint, new AbortController().signal),
  ).rejects.toThrow("cleanup unconfirmed");
});
async function frozenFixture() {
  const producer = {
    actionId: "frozen-action",
    resourceId: "d".repeat(64),
    generation: 2,
    engineId: "engine-1",
  };
  const pack = tar.pack();
  pack.entry({ name: "node_modules", type: "directory", mode: 0o755 });
  pack.entry({ name: "node_modules/dependency/index.js", mode: 0o644 }, "sealed dependency bytes");
  pack.finalize();
  return await freezeAndSeal(
    producer,
    {
      quiesce: () => Promise.resolve(),
      pause: () => Promise.resolve(),
      inspect: () => Promise.resolve({ ...producer, paused: true, quiescent: true }),
      export: () => Promise.resolve(Readable.from(pack)),
    },
    new AbortController().signal,
  );
}
it("fully validates an issued frozen relay before materializing app-owned publication bytes", async () => {
  const { publisher, root, receipt } = await publicationFixture();
  const archive = await frozenFixture();
  const charged: [string, number][] = [];
  try {
    const candidate = await publisher.buildFrozen(
      archive,
      fingerprint,
      new AbortController().signal,
      (category, bytes) => {
        charged.push([category, bytes]);
      },
    );
    expect(candidate.imageId).toBe(imageId);
    expect(
      charged.filter(([category]) => category === "staging").map(([, bytes]) => bytes),
    ).toEqual([23, 23]);
    expectCandidateOwnership(root, receipt.root);
  } finally {
    archive.dispose();
  }
});

it("retains and removes an unpublished image when sanitized staging cleanup fails after build", async () => {
  const { publisher, recorded, root } = await publicationFixture();
  const archive = await frozenFixture();
  const original = fs.rmdirSync.bind(fs);
  let failStageRemoval = true;
  vi.spyOn(fs, "rmdirSync").mockImplementation((target, options) => {
    if (failStageRemoval && String(target).includes("publication-input-"))
      throw new Error("Staging cleanup interrupted");
    return original(target, options);
  });
  try {
    await expect(
      publisher.buildFrozen(archive, fingerprint, new AbortController().signal, () => {}),
    ).rejects.toThrow("Publication cleanup unconfirmed");
    expect(fs.readdirSync(root).some((name) => name.startsWith(".publication-stage-"))).toBe(true);
    expect(fs.readdirSync(root).some((name) => name.startsWith("publication-input-"))).toBe(true);
    failStageRemoval = false;
    expect(await publisher.cleanup("frozen-action")).toBe("CONFIRMED");
    expect(fs.readdirSync(root).some((name) => name.startsWith(".publication-stage-"))).toBe(false);
    expect(recorded.filter((argv) => argv[0] === "image" && argv[1] === "rm")).toHaveLength(1);
  } finally {
    failStageRemoval = false;
    archive.dispose();
  }
});
