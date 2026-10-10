import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { allowlistedDockerEnv } from "./dockerprocess.js";
import { createPreparationDockerCli } from "./preparationcli.js";

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const observationSchema = z.strictObject({
  engineId: z.string().min(1),
  dataRoot: z.string().startsWith("/"),
  boundary: z.string().startsWith("/"),
  device: z.string().regex(/^\/dev\/loop\d+$/u),
  mechanism: z.literal("dedicated-block-device"),
  deviceBytes: bytes.positive(),
  filesystemBytes: bytes.positive(),
  availableBytes: bytes,
  mountId: z.string().min(1),
  dedicated: z.literal(true),
  imageStorage: z.literal("classic-overlay2"),
  builder: z.literal("legacy-local"),
});
export type StorageObservation = z.infer<typeof observationSchema>;
export class PreparationAdmissionUncertain extends Error {
  constructor() {
    super("Preparation admission cleanup unconfirmed");
  }
}
export interface PreparationStorageLease {
  readonly identity: string;
  readonly engineId: string;
  account(category: "download" | "staging" | "transfer" | "image", bytes: number): void;
  revalidate(): Promise<void>;
  settle(cleanup: "CONFIRMED" | "UNCERTAIN"): void;
}
const leases = new WeakSet<object>();
export function isStorageLease(value: unknown): value is PreparationStorageLease {
  return typeof value === "object" && value !== null && leases.has(value);
}

function validate(input: unknown): StorageObservation {
  const parsed = observationSchema.safeParse(input);
  if (!parsed.success) throw new Error("Whole-builder quota unavailable");
  const value = parsed.data;
  const relative = path.posix.relative(value.boundary, value.dataRoot);
  if (
    !relative ||
    relative.startsWith("../") ||
    relative === ".." ||
    path.posix.isAbsolute(relative) ||
    value.filesystemBytes > value.deviceBytes ||
    value.availableBytes > value.filesystemBytes
  )
    throw new Error("Whole-builder quota unavailable");
  return value;
}
function identity(value: StorageObservation): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(Object.entries(value).filter(([key]) => key !== "availableBytes")),
      ),
    )
    .digest("hex");
}

/** Trusted platform-read seam; production uses readDedicatedLinuxStorage below, never repository data. */
export class PreparationStorage {
  constructor(private readonly read: () => Promise<unknown>) {}
  private readonly active = new Map<string, number>();
  private reserved = 0;
  private admitting = false;
  private admittedIdentity: string | undefined;

  async admit(
    workspaceId: string,
    reservationBytes: number,
    onConfirmedSettlement?: () => void,
    onRevalidate?: () => void,
  ): Promise<PreparationStorageLease> {
    if (!workspaceId || this.active.has(workspaceId) || this.admitting)
      throw new Error("Preparation already active");
    if (
      !Number.isSafeInteger(reservationBytes) ||
      reservationBytes <= 0 ||
      reservationBytes > 4 * 1024 ** 3
    )
      throw new Error("Invalid preparation reservation");
    this.admitting = true;
    let observed: StorageObservation;
    try {
      observed = validate(await this.read());
      if (this.admittedIdentity !== undefined && identity(observed) !== this.admittedIdentity)
        throw new Error("Preparation storage changed");
      if (observed.availableBytes - this.reserved < reservationBytes)
        throw new Error("Preparation storage exhausted");
      this.active.set(workspaceId, reservationBytes);
      this.reserved += reservationBytes;
      this.admittedIdentity = identity(observed);
    } finally {
      this.admitting = false;
    }
    const admittedIdentity = identity(observed);
    let consumed = 0;
    let settled = false;
    const lease = Object.freeze({
      identity: admittedIdentity,
      engineId: observed.engineId,
      account: (_category: "download" | "staging" | "transfer" | "image", count: number) => {
        if (
          settled ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          consumed + count > reservationBytes
        )
          throw new Error("Preparation resource limit exceeded");
        consumed += count;
      },
      revalidate: async () => {
        if (settled) throw new Error("Preparation reservation settled");
        onRevalidate?.();
        const current = validate(await this.read());
        onRevalidate?.();
        if (identity(current) !== admittedIdentity) throw new Error("Preparation storage changed");
        if (current.availableBytes < this.reserved)
          throw new Error("Preparation storage exhausted");
      },
      settle: (cleanup: "CONFIRMED" | "UNCERTAIN") => {
        if (settled || cleanup !== "CONFIRMED") return;
        onConfirmedSettlement?.();
        settled = true;
        this.active.delete(workspaceId);
        this.reserved -= reservationBytes;
        if (this.active.size === 0) this.admittedIdentity = undefined;
      },
    });
    leases.add(lease);
    return lease;
  }
}

/**
 * Supported Linux mechanism: a dedicated finite loop-block filesystem containing the entire
 * local daemon data root. No container-layer cap, usage estimate, or declared quota is accepted.
 * Other mechanisms require their own effective platform reader; Windows fails closed here.
 */
export function readDedicatedLinuxStorage(): Promise<StorageObservation> {
  if (process.platform !== "linux")
    return Promise.reject(new Error("Whole-builder quota unavailable"));
  try {
    const read = (executable: string, argv: readonly string[]) =>
      execFileSync(executable, argv, {
        shell: false,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 64 * 1024,
        env: allowlistedDockerEnv(),
      });
    const cli = createPreparationDockerCli();
    let rawInfo: string;
    try {
      rawInfo = read("docker", [...cli.prefix, "info", "--format", "{{json .}}"]);
    } finally {
      cli.dispose();
    }
    const info = z
      .object({
        ID: z.string().min(1),
        DockerRootDir: z.string().startsWith("/"),
        OSType: z.literal("linux"),
        Architecture: z.enum(["x86_64", "amd64"]),
        Driver: z.literal("overlay2"),
        DriverStatus: z.array(z.tuple([z.string(), z.string()])),
      })
      .parse(JSON.parse(rawInfo));
    if (
      info.DriverStatus.some(
        ([key, value]) => key === "driver-type" || value.includes("containerd"),
      )
    )
      throw new Error("Whole-builder quota unavailable");
    const root = fs.realpathSync(info.DockerRootDir);
    const mounts = z
      .object({
        filesystems: z
          .array(
            z.object({
              target: z.string(),
              source: z.string().regex(/^\/dev\/loop\d+$/u),
              fstype: z.enum(["ext4", "xfs"]),
              options: z.string(),
              "maj:min": z.string(),
            }),
          )
          .length(1),
      })
      .parse(
        JSON.parse(
          read("findmnt", [
            "--json",
            "--target",
            root,
            "--output",
            "TARGET,SOURCE,FSTYPE,OPTIONS,MAJ:MIN",
          ]),
        ),
      );
    const mount = mounts.filesystems[0]!;
    if (mount.target === "/" || !mount.options.split(",").includes("rw"))
      throw new Error("Whole-builder quota unavailable");
    const deviceBytes = Number(read("blockdev", ["--getsize64", mount.source]).trim());
    const filesystem = fs.statfsSync(root);
    return Promise.resolve(
      validate({
        engineId: info.ID,
        dataRoot: root,
        boundary: mount.target,
        mechanism: "dedicated-block-device",
        device: mount.source,
        deviceBytes,
        filesystemBytes: filesystem.blocks * filesystem.bsize,
        availableBytes: filesystem.bavail * filesystem.bsize,
        mountId: mount["maj:min"],
        dedicated: true,
        imageStorage: "classic-overlay2",
        builder: "legacy-local",
      }),
    );
  } catch {
    return Promise.reject(new Error("Whole-builder quota unavailable"));
  }
}
