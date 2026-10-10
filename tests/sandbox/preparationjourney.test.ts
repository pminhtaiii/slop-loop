import { expect, it } from "vitest";
import * as coordinator from "../../src/sandbox/preparationcoordinator.js";
import { afterEach } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import tar from "tar-stream";
import { createGitCheckout } from "../workspace/fixtures.js";
import { selectWorkspace, closeWorkspace } from "../../src/workspace/admission.js";
import { createPreparationAction } from "../../src/sandbox/preparation.js";
import { PreparationStorage } from "../../src/sandbox/preparationstorage.js";
import type { PreparedImageRecord } from "../../src/sandbox/types.js";
import type { PreparationProducer } from "../../src/sandbox/frozentransfer.js";
import { normalizePnpmOutput } from "../../src/sandbox/normalization.js";
import { parseLockedGraph } from "../../src/sandbox/downloads.js";
import { verifyPackageTarball } from "../../src/sandbox/packagecontent.js";
import { offlineScriptPolicyIdentity } from "../../src/sandbox/offlinescripts.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function journey(corrupt = false, malformedProducer = false, wrongPolicy = false) {
  const pack = tar.pack();
  const manifest = '{"name":"fixture","version":"1.0.0"}';
  pack.entry({ name: "package/package.json", mode: 0o644 }, manifest);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  const artifact = gzipSync(Buffer.concat(chunks));
  const sri = "sha512-" + createHash("sha512").update(artifact).digest("base64");
  const lockfile = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      fixture: {specifier: 1.0.0, version: 1.0.0}
packages:
  fixture@1.0.0:
    resolution: {integrity: ${sri}}
snapshots:
  fixture@1.0.0: {}
`;
  const checkout = createGitCheckout();
  cleanups.push(() => checkout.cleanup());
  checkout.write("package.json", '{"dependencies":{"fixture":"1.0.0"}}');
  checkout.write("pnpm-lock.yaml", lockfile);
  const selected = selectWorkspace(checkout.root);
  if (selected.kind !== "SELECTED") throw new Error("Workspace unavailable");
  cleanups.push(() => closeWorkspace(selected.workspace));
  const action = createPreparationAction(selected.workspace, {
    nodeVersion: "24.14.0",
    pnpmVersion: "12.5.1",
    architecture: "linux-x64",
    managerConfigHash: "a".repeat(64),
    scriptPolicyId: wrongPolicy ? "b".repeat(64) : offlineScriptPolicyIdentity([]),
    recipeHash: "c".repeat(64),
    baseImageDigest: "sha256:" + "d".repeat(64),
  });
  const exported = tar.pack();
  if (malformedProducer) {
    exported.entry(
      { name: ".pnpm/fixture@1.0.0/node_modules/fixture/package.json", mode: 0o644 },
      manifest,
    );
    exported.entry({
      name: "fixture",
      type: "symlink",
      linkname: ".pnpm/fixture@1.0.0/node_modules/fixture",
    });
    exported.entry(
      { name: ".slop-loop-tree.json", mode: 0o644 },
      '{"recipe":"pnpm-12.5.1-closed-v1","linker":"isolated","bins":"relative-links"}\n',
    );
  } else {
    exported.entry({ name: "node_modules", type: "directory", mode: 0o755 });
    exported.entry(
      { name: "node_modules/.pnpm/physical/node_modules/fixture/package.json", mode: 0o644 },
      manifest,
    );
    exported.entry({
      name: "node_modules/fixture",
      mode: 0o777,
      type: "symlink",
      linkname: ".pnpm/physical/node_modules/fixture",
    });
    exported.entry({ name: "node_modules/.pnpm/lock.yaml", mode: 0o644 }, lockfile);
    exported.entry(
      { name: "node_modules/.modules.yaml", mode: 0o644 },
      JSON.stringify({
        hoistedDependencies: {},
        hoistPattern: [],
        publicHoistPattern: [],
        included: { dependencies: true, devDependencies: true, optionalDependencies: true },
        layoutVersion: 5,
        nodeLinker: "isolated",
        packageManager: "pnpm@12.5.1",
        pendingBuilds: [],
        skipped: [],
        prunedAt: "Fri, 09 Oct 2026 07:22:29 GMT",
        storeDir: "/tmp/store/v11",
        virtualStoreDir: "/preparation/node_modules/.pnpm",
        virtualStoreDirMaxLength: 120,
      }),
    );
  }
  exported.finalize();
  const archive: Buffer[] = [];
  for await (const chunk of exported) archive.push(Buffer.from(chunk));
  if (!malformedProducer) {
    const graph = parseLockedGraph(lockfile, '{"dependencies":{"fixture":"1.0.0"}}');
    await normalizePnpmOutput(
      graph,
      [await verifyPackageTarball(graph.artifacts[0]!, artifact)],
      Readable.from(archive),
    );
  }
  const events: string[] = [];
  const records: PreparedImageRecord[] = [];
  const storage = new PreparationStorage(() =>
    Promise.resolve({
      engineId: "engine",
      dataRoot: "/dedicated/docker",
      boundary: "/dedicated",
      mechanism: "dedicated-block-device",
      device: "/dev/loop7",
      deviceBytes: 16 * 1024 ** 3,
      filesystemBytes: 15 * 1024 ** 3,
      availableBytes: 10 * 1024 ** 3,
      mountId: "47",
      dedicated: true,
      imageStorage: "classic-overlay2",
      builder: "legacy-local",
    }),
  );
  const producer = (actionId: string, resourceId: string): PreparationProducer => ({
    actionId,
    resourceId,
    generation: 1,
    engineId: "engine",
  });
  const runtime: coordinator.PreparationRuntime = {
    fetch: () => {
      events.push("fetch");
      return Promise.resolve(
        new Map([["fixture@1.0.0", corrupt ? Buffer.from("corrupt") : artifact]]),
      );
    },
    materialize: (id) => {
      events.push("materialize");
      return Promise.resolve(producer(id, "initial"));
    },
    quiesce: () => {
      events.push("quiesce");
      return Promise.resolve();
    },
    pause: () => {
      events.push("pause");
      return Promise.resolve();
    },
    inspect: (owned) => Promise.resolve({ ...owned, paused: true, quiescent: true }),
    export: () => Promise.resolve(Readable.from(archive)),
    importWithoutCAS: (id) => {
      events.push("import-without-cas");
      return Promise.resolve(producer(id, "recipient"));
    },
    runScripts: () => {
      events.push("scripts");
      return Promise.resolve();
    },
    buildCandidate: (_output, fingerprint) => {
      events.push("build");
      return Promise.resolve({
        imageId: "sha256:" + "e".repeat(64),
        fingerprint,
        architecture: "linux-x64",
        baseImageDigest: "sha256:" + "d".repeat(64),
        recipeHash: "c".repeat(64),
        prerequisiteOutput: "slop-loop-prerequisites:PASS",
      });
    },
    cleanup: () => {
      events.push("cleanup");
      return Promise.resolve("CONFIRMED");
    },
  };
  const configuration = new coordinator.PreparationConfiguration(
    (workspaceId) => storage.admit(workspaceId, 4 * 1024 ** 3),
    runtime,
    [],
    (record) => {
      events.push("commit");
      const previous = records[0];
      records.push(record);
      return Promise.resolve(() => {
        records.pop();
        if (previous && records[0] !== previous) records.splice(0, 1, previous);
        return Promise.resolve();
      });
    },
  );
  return { action, configuration, events, records };
}

it("rejects developer-labelled objects before quota or runtime effects", async () => {
  let effects = 0;
  const result = await coordinator.prepareVerification(
    {
      action: { confirmedBy: "developer", workspaceId: "fixture" },
      receipt: {},
    },
    {
      admission: () => {
        effects++;
        throw new Error("unauthorized admission");
      },
    },
    new AbortController().signal,
  );
  expect(result.status).toBe("BLOCKED");
  expect(effects).toBe(0);
});

it("rejects a policy different from the confirmed dependency fingerprint before quota or fetch effects", async () => {
  const fixture = await journey(false, false, true);
  const result = await coordinator.prepareVerification(
    { action: fixture.action, receipt: fixture.action.confirm(fixture.action.challenge) },
    fixture.configuration,
    new AbortController().signal,
  );
  expect(result.status).toBe("BLOCKED");
  expect(fixture.events).toEqual([]);
});

it("runs the production coordinator through full checked source stages before committing a record", async () => {
  const fixture = await journey();
  const result = await coordinator.prepareVerification(
    { action: fixture.action, receipt: fixture.action.confirm(fixture.action.challenge) },
    fixture.configuration,
    new AbortController().signal,
  );
  expect(result.status).toBe("READY");
  expect(fixture.events).toEqual([
    "fetch",
    "materialize",
    "quiesce",
    "pause",
    "import-without-cas",
    "scripts",
    "quiesce",
    "pause",
    "build",
    "cleanup",
    "commit",
  ]);
  expect(fixture.records).toHaveLength(1);
});

it("does not materialize, execute scripts or publish after actual tarball integrity failure", async () => {
  const fixture = await journey(true);
  const result = await coordinator.prepareVerification(
    { action: fixture.action, receipt: fixture.action.confirm(fixture.action.challenge) },
    fixture.configuration,
    new AbortController().signal,
  );
  expect(result.status).toBe("FAILED");
  expect(fixture.events).toEqual(["fetch", "cleanup"]);
  expect(fixture.records).toHaveLength(0);
});

it("rejects producer output that bypasses authenticated manager metadata before importing or running scripts", async () => {
  const fixture = await journey(false, true);
  const result = await coordinator.prepareVerification(
    { action: fixture.action, receipt: fixture.action.confirm(fixture.action.challenge) },
    fixture.configuration,
    new AbortController().signal,
  );
  expect(result.status).toBe("FAILED");
  expect(fixture.events).toEqual(["fetch", "materialize", "quiesce", "pause", "cleanup"]);
});

it("does not commit after cancellation during final quota revalidation", async () => {
  const fixture = await journey();
  const abort = new AbortController();
  const configuration = new coordinator.PreparationConfiguration(
    async (workspaceId) => {
      const lease = await fixture.configuration.admission(workspaceId);
      return {
        ...lease,
        revalidate: async () => {
          await lease.revalidate();
          if (fixture.events.includes("cleanup")) abort.abort();
        },
      };
    },
    fixture.configuration.runtime,
    [],
    fixture.configuration.commitRecord,
    undefined,
    () => Promise.resolve("CONFIRMED"),
  );
  const result = await coordinator.prepareVerification(
    { action: fixture.action, receipt: fixture.action.confirm(fixture.action.challenge) },
    configuration,
    abort.signal,
  );
  expect(result.status).toBe("CANCELLED");
  expect(fixture.records).toHaveLength(0);
});

it("rejects a consumed developer receipt without starting another fetch", async () => {
  const fixture = await journey();
  const confirmed = {
    action: fixture.action,
    receipt: fixture.action.confirm(fixture.action.challenge),
  };
  expect(
    (
      await coordinator.prepareVerification(
        confirmed,
        fixture.configuration,
        new AbortController().signal,
      )
    ).status,
  ).toBe("READY");
  const before = [...fixture.events];
  expect(
    (
      await coordinator.prepareVerification(
        confirmed,
        fixture.configuration,
        new AbortController().signal,
      )
    ).status,
  ).toBe("BLOCKED");
  expect(fixture.events).toEqual(before);
});

it("retains quota until failed record publication has matching image cleanup", async () => {
  const fixture = await journey();
  const configuration = new coordinator.PreparationConfiguration(
    fixture.configuration.admission,
    fixture.configuration.runtime,
    [],
    () => Promise.reject(new Error("Atomic record write failed")),
    undefined,
    () => Promise.resolve("UNCERTAIN"),
  );
  const result = await coordinator.prepareVerification(
    { action: fixture.action, receipt: fixture.action.confirm(fixture.action.challenge) },
    configuration,
    new AbortController().signal,
  );
  expect(result).toMatchObject({ status: "BLOCKED", cleanup: "UNCERTAIN" });
  await expect(configuration.admission(fixture.action.workspaceId)).rejects.toThrow(
    "Preparation already active",
  );
  expect(fixture.records).toHaveLength(0);
});

it("preserves the previous READY record when lease settlement fails after publication", async () => {
  const fixture = await journey();
  const previous: PreparedImageRecord = {
    imageId: "sha256:" + "1".repeat(64),
    fingerprint: "2".repeat(64),
    architecture: "linux-x64",
    status: "READY",
  };
  fixture.records.push(previous);
  let discarded = 0;
  const configuration = new coordinator.PreparationConfiguration(
    async (workspaceId) => {
      const lease = await fixture.configuration.admission(workspaceId);
      return {
        ...lease,
        settle: () => {
          throw new Error("Controlled owned-lock release failure");
        },
      };
    },
    fixture.configuration.runtime,
    [],
    (record) => {
      const previousRecord = fixture.records[0];
      fixture.records.splice(0, 1, record);
      return Promise.resolve(() => {
        fixture.records.splice(0, 1);
        if (previousRecord) fixture.records.push(previousRecord);
        return Promise.resolve();
      });
    },
    undefined,
    () => {
      discarded++;
      return Promise.resolve("CONFIRMED");
    },
  );
  const result = await coordinator.prepareVerification(
    { action: fixture.action, receipt: fixture.action.confirm(fixture.action.challenge) },
    configuration,
    new AbortController().signal,
  );
  expect(result.status).not.toBe("READY");
  expect(fixture.records).toEqual([previous]);
  expect(discarded).toBe(1);
});

it("rolls back publication when cancellation arrives during the atomic record write", async () => {
  const fixture = await journey();
  const abort = new AbortController();
  let discarded = 0;
  const configuration = new coordinator.PreparationConfiguration(
    fixture.configuration.admission,
    fixture.configuration.runtime,
    [],
    (record) => {
      fixture.records.push(record);
      abort.abort();
      return Promise.resolve(() => {
        fixture.records.pop();
        return Promise.resolve();
      });
    },
    undefined,
    () => {
      discarded++;
      return Promise.resolve("CONFIRMED");
    },
  );
  const result = await coordinator.prepareVerification(
    { action: fixture.action, receipt: fixture.action.confirm(fixture.action.challenge) },
    configuration,
    abort.signal,
  );
  expect(result.status).toBe("CANCELLED");
  expect(fixture.records).toHaveLength(0);
  expect(discarded).toBe(1);
});
