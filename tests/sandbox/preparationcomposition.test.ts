import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as composition from "../../src/sandbox/preparationcomposition.js";
import { PreparationConfiguration } from "../../src/sandbox/preparationcoordinator.js";
import { DockerPreparationRuntime } from "../../src/sandbox/preparationruntime.js";
import { runDeveloperPreparation } from "../../scripts/prepare-verification.js";
import { createGitCheckout } from "../workspace/fixtures.js";
import { PreparationAdmissionUncertain } from "../../src/sandbox/preparationstorage.js";

const roots: string[] = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "composition-"));
  roots.push(home);
  const settings = path.join(home, ".slop-loop", "preparation");
  fs.mkdirSync(settings, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(settings), 0o700);
  fs.chmodSync(settings, 0o700);
  const boundary = path.join(home, "bounded");
  fs.mkdirSync(boundary, { mode: 0o700 });
  const observation = {
    engineId: "fixture-engine",
    dataRoot: "/finite/docker",
    boundary: "/finite",
    mechanism: "dedicated-block-device" as const,
    device: "/dev/loop7",
    deviceBytes: 16 * 1024 ** 3,
    filesystemBytes: 15 * 1024 ** 3,
    availableBytes: 10 * 1024 ** 3,
    mountId: "7:7",
    dedicated: true as const,
    imageStorage: "classic-overlay2" as const,
    builder: "legacy-local" as const,
  };
  const binding = Object.fromEntries(
    Object.entries(observation).filter(
      ([name]) => name !== "availableBytes" && name !== "dedicated",
    ),
  );
  const write = (name: string, value: unknown) => {
    const file = path.join(settings, name);
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  };
  write("config.json", { baseImageDigest: `sha256:${"a".repeat(64)}`, scriptApprovals: [] });
  write("quota-proof.json", { ...binding, outcome: "ENOSPC" });
  return {
    home,
    settings,
    boundary,
    observation,
    write,
    options: {
      homeDirectory: home,
      platform: "linux" as const,
      uid: fs.statSync(settings).uid,
      readStorage: () => Promise.resolve(observation),
      resolveBoundaryPath: () => boundary,
      // Controlled ownership syscall substitute; these fixtures do not claim real Linux permissions on Windows.
      fileAuthority: (stat: fs.Stats) => stat.uid === fs.statSync(settings).uid,
      command: () => Promise.reject(new Error("Unexpected Docker effect")),
    },
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("serializes builder actions across independently composed configurations", async () => {
  const f = fixture();
  const first = await composition.createLocalPreparationConfiguration(f.options);
  const second = await composition.createLocalPreparationConfiguration(f.options);
  const lease = await first.configuration.admission("first-workspace");
  const filename = path.join(f.boundary, ".slop-loop-preparation", "active-action.json");
  const record = JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, unknown>;
  expect(record.workspaceId).toBe("first-workspace");
  expect(record.engineId).toBe("fixture-engine");
  expect(record.storageIdentity).toBe(lease.identity);
  expect(record.generation).toMatch(/^[a-f0-9-]{36}$/u);
  await expect(second.configuration.admission("second-workspace")).rejects.toThrow();
  lease.settle("UNCERTAIN");
  await expect(second.configuration.admission("first-workspace")).rejects.toThrow();
  lease.settle("CONFIRMED");
  expect(fs.existsSync(filename)).toBe(false);
  const replacement = await second.configuration.admission("second-workspace");
  replacement.settle("CONFIRMED");
});

it("atomically admits exactly one concurrent builder action across separate factories", async () => {
  const f = fixture();
  const first = await composition.createLocalPreparationConfiguration(f.options);
  const second = await composition.createLocalPreparationConfiguration(f.options);
  const results = await Promise.allSettled([
    first.configuration.admission("one"),
    second.configuration.admission("two"),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  for (const result of results) if (result.status === "fulfilled") result.value.settle("CONFIRMED");
});

it("retains a replaced lock and refuses to settle the original action accounting", async () => {
  const f = fixture();
  const first = await composition.createLocalPreparationConfiguration(f.options);
  const second = await composition.createLocalPreparationConfiguration(f.options);
  const lease = await first.configuration.admission("workspace");
  const filename = path.join(f.boundary, ".slop-loop-preparation", "active-action.json");
  fs.unlinkSync(filename);
  fs.writeFileSync(filename, "{}", { mode: 0o600 });
  await expect(lease.revalidate()).rejects.toThrow();
  expect(() => lease.settle("CONFIRMED")).toThrow();
  expect(fs.readFileSync(filename, "utf8")).toBe("{}");
  await expect(second.configuration.admission("another-workspace")).rejects.toThrow();
});

it("does not reclaim an existing unowned builder lock", async () => {
  const f = fixture();
  const composed = await composition.createLocalPreparationConfiguration(f.options);
  const filename = path.join(f.boundary, ".slop-loop-preparation", "active-action.json");
  fs.writeFileSync(filename, "foreign-action", { mode: 0o600 });
  await expect(composed.configuration.admission("workspace")).rejects.toThrow();
  expect(fs.readFileSync(filename, "utf8")).toBe("foreign-action");
});

it("retains an owned lock whose generation bytes or hard-link count changed", async () => {
  const f = fixture();
  const composed = await composition.createLocalPreparationConfiguration(f.options);
  const lease = await composed.configuration.admission("workspace");
  const filename = path.join(f.boundary, ".slop-loop-preparation", "active-action.json");
  const original = fs.readFileSync(filename);
  const altered = Buffer.from(original);
  altered[0] = 0x5b;
  fs.writeFileSync(filename, altered);
  await expect(lease.revalidate()).rejects.toThrow();
  expect(() => lease.settle("CONFIRMED")).toThrow();
  fs.writeFileSync(filename, original);
  const alias = path.join(f.boundary, "action-alias");
  fs.linkSync(filename, alias);
  await expect(lease.revalidate()).rejects.toThrow();
  expect(() => lease.settle("CONFIRMED")).toThrow();
  fs.unlinkSync(alias);
  lease.settle("CONFIRMED");
});

it("removes a partially initialized owned lock before releasing failed admission", async () => {
  const f = fixture();
  const composed = await composition.createLocalPreparationConfiguration(f.options);
  const filename = path.join(f.boundary, ".slop-loop-preparation", "active-action.json");
  const write = fs.writeFileSync;
  const failure = vi.spyOn(fs, "writeFileSync").mockImplementation((target, bytes, options) => {
    if (typeof target === "number" && Buffer.isBuffer(bytes)) {
      fs.writeSync(target, bytes, 0, 8);
      throw new Error("Controlled partial write failure");
    }
    return write(target, bytes, options);
  });
  try {
    await expect(composed.configuration.admission("workspace")).rejects.toThrow();
  } finally {
    failure.mockRestore();
  }
  expect(fs.existsSync(filename)).toBe(false);
  const next = await composed.configuration.admission("workspace");
  next.settle("CONFIRMED");
});

it("reports uncertain admission and preserves a replacement lock after partial initialization failure", async () => {
  const f = fixture();
  const composed = await composition.createLocalPreparationConfiguration(f.options);
  const filename = path.join(f.boundary, ".slop-loop-preparation", "active-action.json");
  const write = fs.writeFileSync;
  const failure = vi.spyOn(fs, "writeFileSync").mockImplementation((target, bytes, options) => {
    if (typeof target === "number" && Buffer.isBuffer(bytes)) {
      fs.writeSync(target, bytes, 0, 8);
      fs.unlinkSync(filename);
      write(filename, "foreign-action", { mode: 0o600 });
      throw new Error("Controlled partial write and replacement");
    }
    return write(target, bytes, options);
  });
  try {
    await expect(composed.configuration.admission("workspace")).rejects.toBeInstanceOf(
      PreparationAdmissionUncertain,
    );
  } finally {
    failure.mockRestore();
  }
  expect(fs.readFileSync(filename, "utf8")).toBe("foreign-action");
  await expect(composed.configuration.admission("workspace")).rejects.toThrow();
});

it("rejects changed private configuration before acquiring an action lock", async () => {
  const f = fixture();
  const composed = await composition.createLocalPreparationConfiguration(f.options);
  f.write("config.json", { baseImageDigest: `sha256:${"b".repeat(64)}`, scriptApprovals: [] });
  await expect(composed.configuration.admission("workspace")).rejects.toThrow();
  expect(fs.existsSync(path.join(f.boundary, ".slop-loop-preparation", "active-action.json"))).toBe(
    false,
  );
});

it("composes real runtime and admits one action only from private config and bound quota proof", async () => {
  const f = fixture();
  const result = await composition.createLocalPreparationConfiguration(f.options);
  expect(result.configuration).toBeInstanceOf(PreparationConfiguration);
  expect(result.configuration.runtime).toBeInstanceOf(DockerPreparationRuntime);
  expect(result.policy.baseImageDigest).toBe(`sha256:${"a".repeat(64)}`);
  const lease = await result.configuration.admission("workspace");
  await expect(result.configuration.admission("workspace")).rejects.toThrow();
  expect(lease.engineId).toBe("fixture-engine");
  lease.settle("CONFIRMED");
  expect(fs.statSync(path.join(f.boundary, ".slop-loop-preparation")).isDirectory()).toBe(true);
});

it.each(["missing", "missing-proof", "extra-quota", "forged-proof", "hardlink"])(
  "blocks %s private evidence before creating staging",
  async (kind) => {
    const f = fixture();
    if (kind === "missing") fs.unlinkSync(path.join(f.settings, "config.json"));
    if (kind === "missing-proof") fs.unlinkSync(path.join(f.settings, "quota-proof.json"));
    if (kind === "extra-quota")
      f.write("config.json", {
        baseImageDigest: `sha256:${"a".repeat(64)}`,
        scriptApprovals: [],
        quotaBytes: 1024,
      });
    if (kind === "forged-proof")
      f.write("quota-proof.json", { outcome: "ENOSPC", engineId: "other" });
    if (kind === "hardlink")
      fs.linkSync(path.join(f.settings, "config.json"), path.join(f.home, "config-alias"));
    await expect(composition.createLocalPreparationConfiguration(f.options)).rejects.toThrow(
      "Local preparation configuration unavailable",
    );
    expect(fs.existsSync(path.join(f.boundary, ".slop-loop-preparation"))).toBe(false);
  },
);

it("rejects unprotected private files before allocating storage", async () => {
  const f = fixture();
  await expect(
    composition.createLocalPreparationConfiguration({
      ...f.options,
      fileAuthority: (stat, directory) => directory && stat.isDirectory(),
    }),
  ).rejects.toThrow();
  expect(fs.existsSync(path.join(f.boundary, ".slop-loop-preparation"))).toBe(false);
});

it("blocks capacity exhaustion before allocating host staging", async () => {
  const f = fixture();
  await expect(
    composition.createLocalPreparationConfiguration({
      ...f.options,
      readStorage: () => Promise.resolve({ ...f.observation, availableBytes: 0 }),
    }),
  ).rejects.toThrow();
  expect(fs.existsSync(path.join(f.boundary, ".slop-loop-preparation"))).toBe(false);
});

it("blocks unsupported Windows storage before reading developer evidence", async () => {
  const f = fixture();
  await expect(
    composition.createLocalPreparationConfiguration({ ...f.options, platform: "win32" }),
  ).rejects.toThrow("Local preparation configuration unavailable");
  expect(fs.existsSync(path.join(f.boundary, ".slop-loop-preparation"))).toBe(false);
});

it("rechecks engine-bound exhaustion evidence at action admission", async () => {
  const f = fixture();
  const result = await composition.createLocalPreparationConfiguration(f.options);
  f.write("quota-proof.json", { outcome: "ENOSPC", engineId: "replacement" });
  await expect(result.configuration.admission("workspace")).rejects.toThrow();
});

it("returns a typed blocker without prompting when private configuration is unavailable", async () => {
  const result = await runDeveloperPreparation(() =>
    Promise.reject(new Error("secret local path")),
  );
  expect(result).toEqual({
    status: "BLOCKED",
    reason: "Local preparation configuration unavailable",
    cleanup: "CONFIRMED",
  });
});

it("binds the actual workspace challenge and refuses a different confirmation", async () => {
  const f = fixture(),
    checkout = createGitCheckout();
  try {
    checkout.write("package.json", "{}");
    checkout.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    let challenge = "";
    const result = await runDeveloperPreparation(
      () => composition.createLocalPreparationConfiguration(f.options),
      {
        launchDirectory: checkout.root,
        prompt: (value) => {
          challenge = value;
          return Promise.resolve("incorrect");
        },
      },
    );
    expect(challenge).toMatch(/^prepare /u);
    expect(result.status).toBe("BLOCKED");
    expect(result).not.toHaveProperty("image");
  } finally {
    checkout.cleanup();
  }
});

it("runs the real coordinator after exact confirmation and reports controlled Docker failure", async () => {
  const f = fixture(),
    checkout = createGitCheckout();
  try {
    checkout.write("package.json", '{"dependencies":{"fixture":"1.0.0"}}');
    checkout.write(
      "pnpm-lock.yaml",
      `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      fixture: {specifier: 1.0.0, version: 1.0.0}\npackages:\n  fixture@1.0.0:\n    resolution: {integrity: sha512-${Buffer.alloc(64).toString("base64")}}\nsnapshots:\n  fixture@1.0.0: {}\n`,
    );
    const result = await runDeveloperPreparation(
      () => composition.createLocalPreparationConfiguration(f.options),
      {
        launchDirectory: checkout.root,
        prompt: (challenge) => Promise.resolve(challenge),
      },
    );
    expect(result.status).toBe("FAILED");
    expect(result).not.toHaveProperty("image");
  } finally {
    checkout.cleanup();
  }
});

it("does not report confirmed cleanup when the coordinator throws after confirmation", async () => {
  const f = fixture(),
    checkout = createGitCheckout();
  try {
    checkout.write("package.json", "{}");
    checkout.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    vi.spyOn(AbortSignal, "any").mockImplementation(() => {
      throw new Error("Coordinator outcome lost");
    });
    const result = await runDeveloperPreparation(
      () => composition.createLocalPreparationConfiguration(f.options),
      {
        launchDirectory: checkout.root,
        prompt: (challenge) => Promise.resolve(challenge),
      },
    );
    expect(result).toEqual({
      status: "BLOCKED",
      reason: "Preparation outcome unconfirmed",
      cleanup: "UNCERTAIN",
    });
  } finally {
    vi.restoreAllMocks();
    checkout.cleanup();
  }
});

it("cancels the developer action on SIGINT and removes its signal handlers", async () => {
  const f = fixture(),
    checkout = createGitCheckout();
  const listeners = process.listenerCount("SIGINT");
  try {
    checkout.write("package.json", "{}");
    checkout.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const result = await runDeveloperPreparation(
      () => composition.createLocalPreparationConfiguration(f.options),
      {
        launchDirectory: checkout.root,
        prompt: (challenge) => {
          process.emit("SIGINT");
          return Promise.resolve(challenge);
        },
      },
    );
    expect(result.status).toBe("CANCELLED");
    expect(process.listenerCount("SIGINT")).toBe(listeners);
  } finally {
    checkout.cleanup();
  }
});
