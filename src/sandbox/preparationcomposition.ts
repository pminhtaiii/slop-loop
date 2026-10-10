import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PreparationStorage,
  PreparationAdmissionUncertain,
  readDedicatedLinuxStorage,
  type StorageObservation,
} from "./preparationstorage.js";
import { PreparationConfiguration } from "./preparationcoordinator.js";
import type { PreparationPolicy } from "./preparation.js";
import { DockerPreparationRuntime } from "./preparationruntime.js";
import {
  PreparedImagePublisher,
  preparationPublicationRecipeHash,
  writePreparedImageRecord,
} from "./preparationpublication.js";
import { offlineScriptPolicyIdentity } from "./offlinescripts.js";
import { PNPM_NORMALIZATION_SETTINGS } from "./normalization.js";
import {
  localPreparationDockerCommand,
  type PreparationDockerCommand,
} from "./preparationnetwork.js";
import { localPreparationDockerIO, type PreparationDockerIO } from "./preparationio.js";

const configSchema = z.strictObject({
  baseImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  scriptApprovals: z
    .array(
      z.strictObject({
        nodeKey: z.string().min(1).max(2048),
        integrity: z.string().min(1).max(256),
        phase: z.enum(["preinstall", "install", "postinstall"]),
        commandHash: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .max(30_000),
});
const proofSchema = z.strictObject({
  outcome: z.literal("ENOSPC"),
  engineId: z.string(),
  dataRoot: z.string(),
  boundary: z.string(),
  device: z.string(),
  mechanism: z.literal("dedicated-block-device"),
  mountId: z.string(),
  deviceBytes: z.number(),
  filesystemBytes: z.number(),
  imageStorage: z.literal("classic-overlay2"),
  builder: z.literal("legacy-local"),
});

/** Trusted syscall substitutions for controlled tests; never reachable through a model tool or environment JSON. */
export interface LocalPreparationPlatform {
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly readStorage?: () => Promise<StorageObservation>;
  readonly resolveBoundaryPath?: (boundary: string) => string;
  readonly fileAuthority?: (stat: fs.Stats, directory: boolean) => boolean;
  readonly command?: PreparationDockerCommand;
  readonly io?: PreparationDockerIO;
}
function same(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Reads only fixed application-private config and exhaustion records, then composes concrete Docker stages. */
export async function createLocalPreparationConfiguration(
  options: LocalPreparationPlatform = {},
): Promise<{
  readonly policy: PreparationPolicy;
  readonly configuration: PreparationConfiguration;
}> {
  try {
    if ((options.platform ?? process.platform) !== "linux")
      throw new Error("Unsupported quota platform");
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error("Private ownership unavailable");
    const authority =
      options.fileAuthority ??
      ((stat: fs.Stats, directory: boolean) =>
        stat.uid === uid &&
        (stat.mode & 0o077) === 0 &&
        (stat.mode & (directory ? 0o700 : 0o600)) === (directory ? 0o700 : 0o600));
    const privateDirectory = (target: string): fs.Stats => {
      const stat = fs.lstatSync(target);
      if (
        fs.realpathSync(target) !== target ||
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !authority(stat, true)
      )
        throw new Error("Private directory unavailable");
      return stat;
    };
    const home = fs.realpathSync(options.homeDirectory ?? os.homedir());
    const app = path.join(home, ".slop-loop"),
      settings = path.join(app, "preparation");
    const appIdentity = privateDirectory(app),
      settingsIdentity = privateDirectory(settings);
    const readPrivate = (name: string): unknown => {
      if (
        !same(appIdentity, privateDirectory(app)) ||
        !same(settingsIdentity, privateDirectory(settings))
      )
        throw new Error("Private directory changed");
      const filename = path.join(settings, name),
        initial = fs.lstatSync(filename);
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fs.fstatSync(fd);
        if (
          !same(initial, stat) ||
          !stat.isFile() ||
          initial.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > 16 * 1024 ** 2 ||
          !authority(stat, false)
        )
          throw new Error("Private file unavailable");
        const buffer = Buffer.alloc(stat.size);
        if (
          fs.readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length ||
          !same(stat, fs.lstatSync(filename)) ||
          fs.fstatSync(fd).size !== stat.size ||
          !same(settingsIdentity, privateDirectory(settings))
        )
          throw new Error("Private file changed");
        return JSON.parse(buffer.toString("utf8")) as unknown;
      } finally {
        fs.closeSync(fd);
      }
    };
    const parsed = configSchema.parse(readPrivate("config.json"));
    const scriptPolicy = Object.freeze(parsed.scriptApprovals.map((entry) => Object.freeze(entry)));
    const policy: PreparationPolicy = Object.freeze({
      baseImageDigest: parsed.baseImageDigest,
      managerConfigHash: createHash("sha256")
        .update(JSON.stringify(PNPM_NORMALIZATION_SETTINGS))
        .digest("hex"),
      scriptPolicyId: offlineScriptPolicyIdentity(scriptPolicy),
      nodeVersion: "24.14.0",
      pnpmVersion: "12.5.1",
      architecture: "linux-x64",
      recipeHash: preparationPublicationRecipeHash(parsed.baseImageDigest),
    });
    const read = options.readStorage ?? readDedicatedLinuxStorage;
    const assertConfigurationCurrent = () => {
      const current = configSchema.parse(readPrivate("config.json"));
      if (
        current.baseImageDigest !== policy.baseImageDigest ||
        offlineScriptPolicyIdentity(current.scriptApprovals) !== policy.scriptPolicyId
      )
        throw new Error("Private preparation configuration changed");
    };
    let observed: StorageObservation | undefined;
    const storage = new PreparationStorage(async () => {
      assertConfigurationCurrent();
      const current = await read();
      assertConfigurationCurrent();
      const proof = proofSchema.parse(readPrivate("quota-proof.json"));
      for (const key of Object.keys(proof) as (keyof typeof proof)[]) {
        if (key !== "outcome" && proof[key] !== current[key])
          throw new Error("Quota exhaustion binding unavailable");
      }
      if (
        observed &&
        (current.boundary !== observed.boundary ||
          current.mountId !== observed.mountId ||
          current.engineId !== observed.engineId)
      )
        throw new Error("Quota identity changed");
      observed = current;
      return current;
    });
    const probe = await storage.admit("composition-preflight", 4 * 1024 ** 3);
    try {
      await probe.revalidate();
    } finally {
      probe.settle("CONFIRMED");
    }
    if (!observed) throw new Error("Quota unavailable");
    const boundary = fs.realpathSync(
      options.resolveBoundaryPath?.(observed.boundary) ?? observed.boundary,
    );
    if (!options.resolveBoundaryPath && boundary !== observed.boundary)
      throw new Error("Quota path alias");
    const root = path.join(boundary, ".slop-loop-preparation");
    if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
    const rootIdentity = privateDirectory(root);
    if (rootIdentity.dev !== fs.statSync(boundary).dev)
      throw new Error("Private staging outside quota");
    const relay = path.join(root, "relay");
    if (!fs.existsSync(relay)) fs.mkdirSync(relay, { mode: 0o700 });
    privateDirectory(relay);
    const command = options.command ?? localPreparationDockerCommand;
    const publisher = new PreparedImagePublisher(
      policy.baseImageDigest,
      policy.recipeHash,
      root,
      command,
    );
    const runtime = new DockerPreparationRuntime(
      policy.baseImageDigest,
      root,
      publisher,
      command,
      options.io ?? localPreparationDockerIO,
    );
    const configuration = new PreparationConfiguration(
      async (workspaceId) => {
        if (
          !same(rootIdentity, privateDirectory(root)) ||
          fs.statSync(boundary).dev !== rootIdentity.dev
        )
          throw new Error("Private staging changed");
        if (!workspaceId || workspaceId.length > 2048)
          throw new Error("Preparation workspace unavailable");
        const filename = path.join(root, "active-action.json");
        let owned:
          { readonly fd: number; readonly stat: fs.Stats; readonly bytes: Buffer } | undefined;
        let createdFd: number | undefined;
        let initialized = false;
        let released = false;
        const assertOwned = (verifyBytes = true) => {
          if (!owned || released || !same(rootIdentity, privateDirectory(root)))
            throw new Error("Preparation action lock unavailable");
          const current = fs.lstatSync(filename),
            held = fs.fstatSync(owned.fd);
          if (
            !same(owned.stat, current) ||
            !same(current, held) ||
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.nlink !== 1 ||
            held.nlink !== 1 ||
            (verifyBytes && current.size !== owned.bytes.length) ||
            !authority(current, false)
          )
            throw new Error("Preparation action lock changed");
          if (!verifyBytes) return;
          const bytes = Buffer.alloc(owned.bytes.length);
          if (
            fs.readSync(owned.fd, bytes, 0, bytes.length, 0) !== bytes.length ||
            !bytes.equals(owned.bytes) ||
            !same(current, fs.lstatSync(filename)) ||
            !same(rootIdentity, privateDirectory(root))
          )
            throw new Error("Preparation action lock changed");
        };
        const release = () => {
          if (released) return;
          if (!owned) {
            if (createdFd !== undefined)
              throw new Error("Preparation action lock ownership unavailable");
            return;
          }
          assertOwned(initialized);
          // A replacement, unknown old lock, or uncertain action is never reclaimed here.
          fs.closeSync(owned.fd);
          fs.unlinkSync(filename);
          released = true;
        };
        const lease = await storage.admit(workspaceId, 4 * 1024 ** 3, release, () => assertOwned());
        try {
          const bytes = Buffer.from(
            JSON.stringify({
              workspaceId,
              engineId: lease.engineId,
              storageIdentity: lease.identity,
              generation: randomUUID(),
              ownerUid: uid,
            }),
          );
          const fd = fs.openSync(filename, "wx+", 0o600);
          createdFd = fd;
          owned = { fd, stat: fs.fstatSync(fd), bytes };
          fs.writeFileSync(fd, bytes);
          fs.fsyncSync(fd);
          initialized = true;
          await lease.revalidate();
          return lease;
        } catch (error) {
          try {
            lease.settle("CONFIRMED");
          } catch {
            throw new PreparationAdmissionUncertain();
          }
          throw error;
        }
      },
      runtime,
      scriptPolicy,
      (record) => {
        assertConfigurationCurrent();
        return writePreparedImageRecord(record, path.join(settings, "prepared-image.json"));
      },
      relay,
      (record) => runtime.discardPublication(record),
    );
    return Object.freeze({ policy, configuration });
  } catch {
    throw new Error("Local preparation configuration unavailable");
  }
}
