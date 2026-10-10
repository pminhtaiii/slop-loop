import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { parseTarStream, sanitizeArchivePath, type ArchiveEntry } from "./archive.js";
import { Transform } from "node:stream";
import { isFrozenArchive, type FrozenArchive } from "./frozentransfer.js";
import { NORMALIZATION_RECIPE } from "./dependencytree.js";
import { isCheckedImport } from "./safeimport.js";
import {
  localPreparationDockerCommand,
  type PreparationDockerCommand,
} from "./preparationnetwork.js";
import type { PreparedImageRecord } from "./types.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const imageSchema = z
  .array(
    z.object({
      Id: digest,
      Os: z.literal("linux"),
      Architecture: z.literal("amd64"),
      Size: z.number().int().nonnegative(),
      Config: z.object({
        Labels: z.record(z.string(), z.string()).nullable(),
        Volumes: z.record(z.string(), z.unknown()).nullable().optional(),
        OnBuild: z.array(z.string()).nullable().optional(),
      }),
    }),
  )
  .length(1);
const engineSchema = z.object({
  ID: z.string().min(1),
  OSType: z.literal("linux"),
  Architecture: z.enum(["amd64", "x86_64"]),
});
const recordSchema = z.strictObject({
  imageId: digest,
  fingerprint: hash,
  architecture: z.literal("linux-x64"),
  status: z.literal("READY"),
});
type CheckedEntry = ArchiveEntry & { readonly hash?: string };
export interface PublishedImageCandidate {
  readonly imageId: string;
  readonly fingerprint: string;
  readonly architecture: "linux-x64";
  readonly baseImageDigest: string;
  readonly recipeHash: string;
  readonly prerequisiteOutput: "slop-loop-prerequisites:PASS";
}
const candidates = new WeakSet<object>();
export function isPublishedImageCandidate(value: unknown): value is PublishedImageCandidate {
  return typeof value === "object" && value !== null && candidates.has(value);
}

function recipe(base: string): string {
  digest.parse(base);
  return `FROM ${base}\nCOPY tree/ /opt/slop-loop/node_modules/\nUSER 10001:10001\nWORKDIR /workspace\n`;
}
export function preparationPublicationRecipeHash(baseDigest: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "publication-recipe-v2",
        NORMALIZATION_RECIPE,
        "preparation-worker-v2",
        recipe(baseDigest),
      ]),
    )
    .digest("hex");
}
function protect(target: string): void {
  const isDirectory = fs.lstatSync(target).isDirectory();
  fs.chmodSync(target, isDirectory ? 0o700 : 0o600);
  const rights = isDirectory ? "(OI)(CI)F" : "F";
  if (process.platform === "win32")
    execFileSync(
      "icacls",
      [
        target,
        "/inheritance:r",
        "/grant:r",
        `${os.userInfo().username}:${rights}`,
        `*S-1-5-18:${rights}`,
      ],
      { shell: false, timeout: 5000, stdio: "ignore" },
    );
  else if (process.platform !== "linux")
    throw new Error("Private publication platform unavailable");
}
function directory(target: string): fs.Stats {
  if (
    !path.isAbsolute(target) ||
    path.resolve(target) !== target ||
    fs.realpathSync(target) !== target
  )
    throw new Error("Publication directory authority unavailable");
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Publication directory authority unavailable");
  return stat;
}
function same(left: fs.Stats, right: fs.Stats): boolean {
  return left.ino === right.ino && left.dev === right.dev;
}
function removeCreatedEntries(entries: readonly string[], context: string): void {
  for (const target of [...entries].reverse()) {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) fs.rmdirSync(target);
      else fs.unlinkSync(target);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  fs.rmdirSync(context);
}

const smoke = String.raw`const fs=require('node:fs'),cp=require('node:child_process');
if(process.version!=='v24.14.0'||process.platform!=='linux'||process.arch!=='x64')throw Error('Node prerequisite absent');
for(const [exe,args,expected] of [['pnpm',['--version'],'12.5.1'],['git',['--version']],['python3',['--version']],['make',['--version']],['g++',['--version']]]){
const r=cp.spawnSync(exe,args,{encoding:'utf8',timeout:5000,maxBuffer:65536,env:{PATH:'/usr/local/bin:/usr/bin:/bin'}});
if(r.status!==0||r.error||(expected&&r.stdout.trim()!==expected))throw Error('tool prerequisite absent');}
if(require('/opt/slop-loop/node_modules/node-gyp/package.json').version!=='12.4.0')throw Error('node-gyp prerequisite absent');
const header=fs.readFileSync('/opt/slop-loop/node-headers/include/node/node_version.h','utf8');
if(['MAJOR','MINOR','PATCH'].map(p=>header.match(new RegExp('#define\\s+NODE_'+p+'_VERSION\\s+(\\d+)'))?.[1]).join('.')!=='24.14.0')throw Error('Node headers mismatch');
process.stdout.write('slop-loop-prerequisites:PASS');`;

/** Builds only an application recipe over revalidated, sealed import bytes. Never executes package code. */
export class PreparedImagePublisher {
  private readonly pending = new Map<string, () => Promise<"CONFIRMED" | "UNCERTAIN">>();
  private readonly unpublished = new Map<string, PublishedImageCandidate>();
  private cleanupUnconfirmed = false;
  private readonly validatedImports = new WeakSet<object>();
  private readonly staging = new Map<
    string,
    {
      root: string;
      identity?: fs.Stats;
      rootRemoved: boolean;
      entries: string[];
      journal: string;
      journalIdentity?: fs.Stats;
      parentIdentity: fs.Stats;
    }
  >();
  private readonly ownedCandidates = new WeakMap<
    object,
    {
      tag: string;
      imageId: string;
      publicationId: string;
      engineId: string;
      journal: string;
      journalIdentity: fs.Stats;
      rootIdentity: fs.Stats;
    }
  >();
  constructor(
    private readonly baseDigest: string,
    private readonly recipeHash: string,
    private readonly trustedContextRoot: string,
    private readonly command: PreparationDockerCommand = localPreparationDockerCommand,
  ) {
    digest.parse(baseDigest);
    hash.parse(recipeHash);
    if (recipeHash !== preparationPublicationRecipeHash(baseDigest))
      throw new Error("Application publication recipe mismatch");
    directory(trustedContextRoot);
  }

  async build(
    imported: { readonly root: string; readonly entries: number },
    manifest: readonly CheckedEntry[],
    fingerprint: string,
    signal: AbortSignal,
    actionId: string = randomUUID(),
  ): Promise<PublishedImageCandidate> {
    if (this.cleanupUnconfirmed) throw new Error("Publication cleanup unconfirmed");
    signal.throwIfAborted();
    hash.parse(fingerprint);
    if (
      (!isCheckedImport(imported) && !this.validatedImports.has(imported)) ||
      imported.entries !== manifest.length ||
      manifest.length > 50_000
    )
      throw new Error("Checked publication import unavailable");
    const parent = directory(this.trustedContextRoot);
    const root = directory(imported.root);
    const relative = path.relative(this.trustedContextRoot, imported.root);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    )
      throw new Error("Publication import outside private root");
    const expected = new Map<string, CheckedEntry>();
    const folded = new Set<string>();
    let bytes = 0;
    for (const entry of manifest) {
      sanitizeArchivePath(entry.path);
      if (
        folded.has(entry.path.toLowerCase()) ||
        !["file", "directory", "symlink"].includes(entry.kind) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > 128 * 1024 ** 2 ||
        (entry.mode !== undefined &&
          (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777))
      )
        throw new Error("Publication manifest unsupported");
      bytes += entry.size;
      if (bytes > 4 * 1024 ** 3) throw new Error("Publication byte limit exceeded");
      if (entry.kind === "file") hash.parse(entry.hash);
      if (
        entry.kind === "symlink" &&
        (!entry.target ||
          entry.target.startsWith("/") ||
          entry.target.includes("\\") ||
          /^[A-Za-z]:/u.test(entry.target) ||
          Array.from(entry.target).some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ))
      )
        throw new Error("Publication link escape");
      expected.set(entry.path, entry);
      folded.add(entry.path.toLowerCase());
    }
    const directories = new Set<string>();
    for (const entry of manifest) {
      const parts = entry.path.split("/");
      for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
      if (entry.kind === "directory") directories.add(entry.path);
    }
    for (const name of directories)
      if (expected.has(name) && expected.get(name)?.kind !== "directory")
        throw new Error("Publication symlink parent rejected");
    const seen = new Set<string>();
    const scan = (current: string, prefix: string): void => {
      for (const name of fs.readdirSync(current)) {
        signal.throwIfAborted();
        const relativePath = prefix ? `${prefix}/${name}` : name;
        const entry = expected.get(relativePath),
          target = path.join(current, name),
          stat = fs.lstatSync(target);
        if (stat.isDirectory() && !stat.isSymbolicLink() && directories.has(relativePath)) {
          scan(target, relativePath);
        } else if (
          !entry ||
          (entry.kind === "file" &&
            (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) ||
          (entry.kind === "symlink" &&
            (!stat.isSymbolicLink() || fs.readlinkSync(target) !== entry.target)) ||
          entry.kind === "directory"
        )
          throw new Error("Publication import content mismatch");
        if (entry) seen.add(relativePath);
      }
    };
    scan(imported.root, "");
    if (seen.size !== expected.size) throw new Error("Publication import missing entries");
    for (const entry of manifest.filter((value) => value.kind === "symlink")) {
      const target = fs.realpathSync(path.join(imported.root, ...entry.path.split("/")));
      const nested = path.relative(imported.root, target);
      if (
        !nested ||
        nested === ".." ||
        nested.startsWith(`..${path.sep}`) ||
        path.isAbsolute(nested)
      )
        throw new Error("Publication link escape");
      const stat = fs.lstatSync(target);
      if (!stat.isFile() && !stat.isDirectory())
        throw new Error("Publication link target unsupported");
    }
    const publicationId = randomUUID(),
      tag = `slop-loop-publication:${publicationId}`,
      smokeName = `slop-loop-smoke-${publicationId}`;
    const context = path.join(this.trustedContextRoot, `publication-${publicationId}`);
    const owned: string[] = [];
    const journal = path.join(this.trustedContextRoot, `.publication-owner-${publicationId}.json`);
    let journalIdentity: fs.Stats | undefined;
    let smokeStarted = false,
      buildStarted = false,
      engineId: string | undefined,
      imageId: string | undefined;
    let candidate: PublishedImageCandidate | undefined;
    let buildEnded = false;
    let contextRemoved = false;
    let contextIdentity: fs.Stats | undefined;
    let failure: Error | undefined;
    try {
      if (!same(parent, directory(this.trustedContextRoot)))
        throw new Error("Publication ownership root changed");
      const journalFd = fs.openSync(journal, "wx", 0o600);
      try {
        journalIdentity = fs.fstatSync(journalFd);
        fs.writeFileSync(
          journalFd,
          `${JSON.stringify({ actionId, publicationId, generation: 1, tag, smokeName, context, fingerprint })}\n`,
        );
        fs.fsyncSync(journalFd);
      } finally {
        fs.closeSync(journalFd);
      }
      if (process.platform === "win32") protect(journal);
      if (!same(journalIdentity, fs.lstatSync(journal)))
        throw new Error("Publication ownership record changed");
      this.pending.set(actionId, () => Promise.resolve("UNCERTAIN"));
      fs.mkdirSync(context, { mode: 0o700 });
      contextIdentity = fs.lstatSync(context);
      protect(context);
      fs.mkdirSync(path.join(context, "tree"), { mode: 0o700 });
      owned.push(path.join(context, "tree"));
      for (const name of [...directories].sort(
        (a, b) => a.split("/").length - b.split("/").length,
      )) {
        const target = path.join(context, "tree", ...name.split("/"));
        fs.mkdirSync(target, { mode: 0o755 });
        owned.push(target);
      }
      for (const entry of manifest.filter((value) => value.kind === "file")) {
        signal.throwIfAborted();
        const source = path.join(imported.root, ...entry.path.split("/"));
        const initial = fs.lstatSync(source);
        const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        let content: Buffer;
        try {
          const stat = fs.fstatSync(fd);
          if (
            !same(initial, stat) ||
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size !== entry.size ||
            (process.platform !== "win32" &&
              entry.mode !== undefined &&
              (stat.mode & 0o777) !== entry.mode)
          )
            throw new Error("Publication import changed");
          content = fs.readFileSync(fd);
          if (
            !same(stat, fs.lstatSync(source)) ||
            content.length !== entry.size ||
            createHash("sha256").update(content).digest("hex") !== entry.hash
          )
            throw new Error("Publication import changed");
        } finally {
          fs.closeSync(fd);
        }
        const target = path.join(context, "tree", ...entry.path.split("/"));
        fs.writeFileSync(target, content, { flag: "wx", mode: entry.mode ?? 0o644 });
        owned.push(target);
      }
      for (const entry of manifest.filter((value) => value.kind === "symlink")) {
        const target = path.join(context, "tree", ...entry.path.split("/"));
        fs.symlinkSync(entry.target!, target);
        owned.push(target);
      }
      if (
        !same(root, directory(imported.root)) ||
        !same(parent, directory(this.trustedContextRoot))
      )
        throw new Error("Publication directory changed");
      const dockerfile = path.join(context, "Dockerfile");
      fs.writeFileSync(dockerfile, recipe(this.baseDigest), { flag: "wx", mode: 0o600 });
      owned.push(dockerfile);
      const engine = engineSchema.parse(
        JSON.parse(await this.command(["info", "--format", "{{json .}}"], signal)),
      );
      engineId = engine.ID;
      const base = imageSchema.parse(
        JSON.parse(await this.command(["image", "inspect", this.baseDigest], signal)),
      )[0]!;
      if (
        base.Id !== this.baseDigest ||
        Object.keys(base.Config.Volumes ?? {}).length ||
        (base.Config.OnBuild ?? []).length ||
        base.Size > 4 * 1024 ** 3
      )
        throw new Error("Immutable publication base unavailable");
      const nextJournal = `${journal}.next-${randomUUID()}`;
      let nextFd: number | undefined;
      try {
        nextFd = fs.openSync(nextJournal, "wx", 0o600);
        fs.writeFileSync(
          nextFd,
          `${JSON.stringify({ actionId, publicationId, generation: 1, tag, smokeName, engineId, context, fingerprint })}\n`,
        );
        fs.fsyncSync(nextFd);
        fs.closeSync(nextFd);
        nextFd = undefined;
        if (process.platform === "win32") protect(nextJournal);
        if (
          !same(parent, directory(this.trustedContextRoot)) ||
          !same(journalIdentity, fs.lstatSync(journal))
        )
          throw new Error("Publication ownership record changed");
        const nextIdentity = fs.lstatSync(nextJournal);
        fs.renameSync(nextJournal, journal);
        journalIdentity = nextIdentity;
      } finally {
        if (nextFd !== undefined) fs.closeSync(nextFd);
        if (fs.existsSync(nextJournal)) fs.unlinkSync(nextJournal);
      }
      const labels = {
        "slop-loop.publication": publicationId,
        "slop-loop.preparationFingerprint": fingerprint,
        "slop-loop.baseImageDigest": this.baseDigest,
        "slop-loop.recipeHash": this.recipeHash,
      };
      const labelArgs = Object.entries(labels).flatMap(([key, value]) => [
        "--label",
        `${key}=${value}`,
      ]);
      const iidfile = path.join(context, "image-id");
      owned.push(iidfile);
      buildStarted = true;
      await this.command(
        [
          "build",
          "--network=none",
          "--pull=false",
          "--memory=4g",
          "--memory-swap=4g",
          "--cpu-period=100000",
          "--cpu-quota=200000",
          "--rm=true",
          "--force-rm=true",
          "--no-cache",
          "--platform=linux/amd64",
          "--iidfile",
          iidfile,
          "--tag",
          tag,
          ...labelArgs,
          "--file",
          dockerfile,
          context,
        ],
        signal,
      );
      buildEnded = true;
      imageId = digest.parse(fs.readFileSync(iidfile, "utf8").trim());
      const inspect = async () => {
        const image = imageSchema.parse(
          JSON.parse(await this.command(["image", "inspect", imageId!], signal)),
        )[0]!;
        if (
          image.Id !== imageId ||
          image.Size > 4 * 1024 ** 3 ||
          (image.Config.OnBuild ?? []).length ||
          Object.keys(image.Config.Volumes ?? {}).length ||
          Object.entries(labels).some(([key, value]) => image.Config.Labels?.[key] !== value)
        )
          throw new Error("Immutable publication image mismatch");
      };
      await inspect();
      smokeStarted = true;
      const output = await this.command(
        [
          "run",
          "--name",
          smokeName,
          ...labelArgs,
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--user=10001:10001",
          "--cpus=1",
          "--memory=256m",
          "--memory-swap=256m",
          "--pids-limit=32",
          "--log-driver=none",
          "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m,uid=10001,gid=10001",
          "--entrypoint",
          "node",
          imageId,
          "-e",
          smoke,
        ],
        signal,
      );
      if (output !== "slop-loop-prerequisites:PASS")
        throw new Error("Publication prerequisites unavailable");
      const observed = z
        .array(
          z.object({
            Image: digest,
            State: z.object({ Running: z.literal(false), ExitCode: z.literal(0) }),
          }),
        )
        .length(1)
        .parse(JSON.parse(await this.command(["inspect", smokeName], signal)))[0]!;
      if (observed.Image !== imageId) throw new Error("Publication smoke image changed");
      await inspect();
      const finalEngine = engineSchema.parse(
        JSON.parse(await this.command(["info", "--format", "{{json .}}"], signal)),
      );
      if (finalEngine.ID !== engineId) throw new Error("Publication engine changed");
      signal.throwIfAborted();
      candidate = Object.freeze({
        imageId,
        fingerprint,
        architecture: "linux-x64",
        baseImageDigest: this.baseDigest,
        recipeHash: this.recipeHash,
        prerequisiteOutput: "slop-loop-prerequisites:PASS",
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Publication failed");
    }
    const settle = async (keepCandidate: boolean): Promise<"CONFIRMED" | "UNCERTAIN"> => {
      const cleanupSignal = AbortSignal.timeout(10_000);
      let cleanup: "CONFIRMED" | "UNCERTAIN" = "CONFIRMED";
      try {
        if (buildStarted) {
          const engine = engineSchema.parse(
            JSON.parse(await this.command(["info", "--format", "{{json .}}"], cleanupSignal)),
          );
          if (engine.ID !== engineId) throw new Error("Publication cleanup unconfirmed");
        }
        if (smokeStarted) {
          const engine = engineSchema.parse(
            JSON.parse(await this.command(["info", "--format", "{{json .}}"], cleanupSignal)),
          );
          if (engine.ID !== engineId) throw new Error("Publication cleanup unconfirmed");
          const container = z
            .array(
              z.object({
                Id: z.string().min(1),
                Name: z.string(),
                Image: digest,
                Config: z.object({ Labels: z.record(z.string(), z.string()) }),
              }),
            )
            .length(1)
            .parse(JSON.parse(await this.command(["inspect", smokeName], cleanupSignal)))[0]!;
          if (
            container.Name !== `/${smokeName}` ||
            container.Image !== imageId ||
            container.Config.Labels["slop-loop.publication"] !== publicationId
          )
            throw new Error("Publication cleanup ownership unavailable");
          await this.command(["rm", "--force", "--", container.Id], cleanupSignal);
          if (
            (
              await this.command(
                [
                  "container",
                  "ls",
                  "--all",
                  "--quiet",
                  "--no-trunc",
                  "--filter",
                  `name=^/${smokeName}$`,
                ],
                cleanupSignal,
              )
            ).trim()
          )
            throw new Error("Publication cleanup unconfirmed");
          smokeStarted = false;
        }
        if (buildStarted && !keepCandidate) {
          const found = (
            await this.command(
              ["image", "ls", "--quiet", "--no-trunc", "--filter", `reference=${tag}`],
              cleanupSignal,
            )
          ).trim();
          if (found) {
            digest.parse(found);
            const image = imageSchema.parse(
              JSON.parse(await this.command(["image", "inspect", tag], cleanupSignal)),
            )[0]!;
            if (
              image.Id !== found ||
              image.Config.Labels?.["slop-loop.publication"] !== publicationId
            )
              throw new Error("Publication cleanup ownership unavailable");
            await this.command(["image", "rm", "--no-prune", "--", tag], cleanupSignal);
            if (
              (
                await this.command(
                  ["image", "ls", "--quiet", "--no-trunc", "--filter", `reference=${tag}`],
                  cleanupSignal,
                )
              ).trim()
            )
              throw new Error("Publication cleanup unconfirmed");
          }
        }
        if (buildStarted && !buildEnded) cleanup = "UNCERTAIN";
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Publication cleanup unconfirmed");
        cleanup = "UNCERTAIN";
      }
      if (!contextRemoved && cleanup === "CONFIRMED") {
        try {
          if (contextIdentity) {
            if (!same(contextIdentity, directory(context)))
              throw new Error("Publication context ownership changed");
            removeCreatedEntries(owned, context);
          } else if (fs.existsSync(context))
            throw new Error("Publication context ownership changed");
          contextRemoved = true;
        } catch (error) {
          failure = error instanceof Error ? error : new Error("Publication cleanup unconfirmed");
          cleanup = "UNCERTAIN";
        }
      }
      if (cleanup === "CONFIRMED" && !keepCandidate && fs.existsSync(journal)) {
        try {
          if (
            !journalIdentity ||
            !same(parent, directory(this.trustedContextRoot)) ||
            !same(journalIdentity, fs.lstatSync(journal))
          )
            throw new Error("Publication ownership record changed");
          fs.unlinkSync(journal);
        } catch (error) {
          failure = error instanceof Error ? error : new Error("Publication cleanup unconfirmed");
          cleanup = "UNCERTAIN";
        }
      } else if (cleanup === "CONFIRMED" && !keepCandidate && journalIdentity) {
        cleanup = "UNCERTAIN";
      }
      return cleanup;
    };
    this.pending.set(actionId, () => settle(false));
    if ((await settle(!!candidate)) === "CONFIRMED") this.pending.delete(actionId);
    else {
      this.cleanupUnconfirmed = true;
      failure ??= new Error("Publication cleanup unconfirmed");
    }
    if (failure) throw failure;
    if (!candidate) throw new Error("Publication candidate unavailable");
    candidates.add(candidate);
    this.ownedCandidates.set(candidate, {
      tag,
      imageId: candidate.imageId,
      publicationId,
      engineId: engineId!,
      journal,
      journalIdentity: journalIdentity!,
      rootIdentity: parent,
    });
    return candidate;
  }

  async cleanup(actionId: string): Promise<"CONFIRMED" | "UNCERTAIN"> {
    return this.settleOwned(actionId, false);
  }

  private async settleOwned(
    actionId: string,
    preserveCandidate: boolean,
  ): Promise<"CONFIRMED" | "UNCERTAIN"> {
    const settle = this.pending.get(actionId);
    let result: "CONFIRMED" | "UNCERTAIN" = settle ? await settle() : "CONFIRMED";
    if (result === "CONFIRMED") this.pending.delete(actionId);
    const unpublished = this.unpublished.get(actionId);
    if (unpublished && !preserveCandidate) {
      if ((await this.discard(unpublished, AbortSignal.timeout(10_000))) === "CONFIRMED")
        this.unpublished.delete(actionId);
      else result = "UNCERTAIN";
    }
    const stage = this.staging.get(actionId);
    if (stage) {
      try {
        if (stage.identity && !stage.rootRemoved) {
          if (!same(stage.identity, directory(stage.root)))
            throw new Error("Publication staging ownership changed");
          removeCreatedEntries(stage.entries, stage.root);
          stage.rootRemoved = true;
        } else if (!stage.identity && fs.existsSync(stage.root))
          throw new Error("Publication staging ownership changed");
        if (
          !stage.journalIdentity ||
          !same(stage.parentIdentity, directory(this.trustedContextRoot)) ||
          !same(stage.journalIdentity, fs.lstatSync(stage.journal))
        )
          throw new Error("Publication staging journal changed");
        fs.unlinkSync(stage.journal);
        this.staging.delete(actionId);
      } catch {
        result = "UNCERTAIN";
      }
    }
    this.cleanupUnconfirmed =
      this.pending.size > 0 ||
      this.staging.size > 0 ||
      (!preserveCandidate && this.unpublished.size > 0);
    return result;
  }

  /** The opaque relay is fully parsed, authenticated and checked in memory before any dependency path is materialized. */
  async buildFrozen(
    archive: FrozenArchive,
    fingerprint: string,
    signal: AbortSignal,
    account: (category: "staging", bytes: number) => void,
  ): Promise<PublishedImageCandidate> {
    if (this.cleanupUnconfirmed) throw new Error("Publication cleanup unconfirmed");
    if (!isFrozenArchive(archive)) throw new Error("Issued frozen publication unavailable");
    signal.throwIfAborted();
    hash.parse(fingerprint);
    const envelope = archive.entries.find((entry) => entry.path === "node_modules");
    if (
      envelope?.kind !== "directory" ||
      envelope.mode !== 0o755 ||
      archive.entries.length > 50_000 ||
      archive.entries.some(
        (entry) => entry.path !== "node_modules" && !entry.path.startsWith("node_modules/"),
      )
    )
      throw new Error("Final dependency envelope unsupported");
    const expected = new Map(archive.entries.map((entry) => [entry.path, entry]));
    const contents = new Map<string, Buffer>();
    const sourceHash = createHash("sha256");
    let rawBytes = 0,
      totalBytes = 0;
    const source = archive.open();
    const hashed = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        try {
          signal.throwIfAborted();
          rawBytes += chunk.length;
          if (rawBytes > archive.bytes || rawBytes > 4 * 1024 ** 3)
            throw new Error("Frozen publication byte limit exceeded");
          sourceHash.update(chunk);
          done(null, chunk);
        } catch (error) {
          done(error instanceof Error ? error : new Error("Frozen publication failed"));
        }
      },
    });
    const abort = () => source.destroy(new Error("Frozen publication cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    source.on("error", (error) => hashed.destroy(error));
    let entries: readonly ArchiveEntry[];
    try {
      entries = await parseTarStream(
        source.pipe(hashed),
        { allowRelativeSymlinks: true },
        async (entry, stream) => {
          const approved = expected.get(entry.path);
          if (
            !approved ||
            approved.kind !== "file" ||
            approved.size !== entry.size ||
            approved.mode !== entry.mode
          )
            throw new Error("Frozen publication manifest mismatch");
          const parts: Buffer[] = [];
          let actual = 0;
          const fileHash = createHash("sha256");
          for await (const value of stream) {
            signal.throwIfAborted();
            const part: unknown = value;
            if (!(part instanceof Uint8Array))
              throw new Error("Frozen publication payload unsupported");
            actual += part.byteLength;
            totalBytes += part.byteLength;
            if (actual > approved.size || totalBytes > 4 * 1024 ** 3)
              throw new Error("Frozen publication payload limit exceeded");
            const content = Buffer.from(part);
            parts.push(content);
            fileHash.update(content);
          }
          if (actual !== approved.size || fileHash.digest("hex") !== approved.hash)
            throw new Error("Frozen publication content mismatch");
          contents.set(entry.path.slice("node_modules/".length), Buffer.concat(parts, actual));
        },
      );
      if (
        rawBytes !== archive.bytes ||
        sourceHash.digest("hex") !== archive.contentId ||
        entries.length !== expected.size
      )
        throw new Error("Frozen publication content changed");
      for (const entry of entries) {
        const approved = expected.get(entry.path);
        if (
          !approved ||
          entry.kind !== approved.kind ||
          entry.size !== approved.size ||
          entry.mode !== approved.mode ||
          entry.target !== approved.target ||
          !Number.isInteger(entry.mode) ||
          entry.mode! < 0 ||
          entry.mode! > 0o777
        )
          throw new Error("Frozen publication manifest mismatch");
      }
    } finally {
      signal.removeEventListener("abort", abort);
      source.destroy();
      hashed.destroy();
    }
    const manifest: CheckedEntry[] = archive.entries
      .filter((entry) => entry.path !== "node_modules")
      .map((entry) => ({ ...entry, path: entry.path.slice("node_modules/".length) }));
    const nodes = new Map(manifest.map((entry) => [entry.path, entry]));
    const dirs = new Set<string>();
    for (const entry of manifest) {
      sanitizeArchivePath(entry.path);
      const parts = entry.path.split("/");
      for (let end = 1; end < parts.length; end++) dirs.add(parts.slice(0, end).join("/"));
      if (entry.kind === "directory") dirs.add(entry.path);
    }
    for (const name of dirs)
      if (nodes.has(name) && nodes.get(name)?.kind !== "directory")
        throw new Error("Frozen publication symlink parent");
    for (const entry of manifest.filter((entry) => entry.kind === "symlink")) {
      let resolved = entry.path;
      const visited = new Set<string>();
      for (;;) {
        if (visited.has(resolved)) throw new Error("Frozen publication link cycle");
        visited.add(resolved);
        const parts = resolved.split("/");
        let changed = false;
        for (let end = 1; end <= parts.length; end++) {
          const prefix = parts.slice(0, end).join("/");
          const link = nodes.get(prefix);
          if (link?.kind !== "symlink") continue;
          const target = link.target ?? "";
          if (
            !target ||
            target.startsWith("/") ||
            target.includes("\\") ||
            /^[A-Za-z]:/u.test(target) ||
            Array.from(target).some(
              (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            )
          )
            throw new Error("Frozen publication link escape");
          resolved = path.posix.join(path.posix.dirname(prefix), target, ...parts.slice(end));
          sanitizeArchivePath(resolved);
          changed = true;
          break;
        }
        if (!changed) {
          if (!dirs.has(resolved) && nodes.get(resolved)?.kind !== "file")
            throw new Error("Frozen publication link target missing");
          break;
        }
      }
    }
    signal.throwIfAborted();
    account("staging", totalBytes);
    account("staging", totalBytes);
    const actionId = archive.producer.actionId;
    const stageId = randomUUID();
    const root = path.join(this.trustedContextRoot, `publication-input-${stageId}`);
    const journal = path.join(this.trustedContextRoot, `.publication-stage-${stageId}.json`);
    const stage: {
      root: string;
      identity?: fs.Stats;
      rootRemoved: boolean;
      entries: string[];
      journal: string;
      journalIdentity?: fs.Stats;
      parentIdentity: fs.Stats;
    } = {
      root,
      rootRemoved: false,
      entries: [],
      journal,
      parentIdentity: directory(this.trustedContextRoot),
    };
    this.staging.set(actionId, stage);
    try {
      const fd = fs.openSync(journal, "wx", 0o600);
      try {
        stage.journalIdentity = fs.fstatSync(fd);
        fs.writeFileSync(fd, `${JSON.stringify({ actionId, stageId, root, fingerprint })}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (process.platform === "win32") protect(journal);
      fs.mkdirSync(root, { mode: 0o700 });
      stage.identity = fs.lstatSync(root);
      protect(root);
      for (const name of [...dirs].sort((a, b) => a.split("/").length - b.split("/").length)) {
        const target = path.join(root, ...name.split("/"));
        fs.mkdirSync(target, { mode: 0o755 });
        stage.entries.push(target);
      }
      for (const entry of manifest.filter((entry) => entry.kind === "file")) {
        signal.throwIfAborted();
        const target = path.join(root, ...entry.path.split("/"));
        fs.writeFileSync(target, contents.get(entry.path)!, { flag: "wx", mode: entry.mode });
        stage.entries.push(target);
      }
      for (const entry of manifest.filter((entry) => entry.kind === "symlink")) {
        const target = path.join(root, ...entry.path.split("/"));
        fs.symlinkSync(entry.target!, target);
        stage.entries.push(target);
      }
      const imported = Object.freeze({ root, entries: manifest.length });
      this.validatedImports.add(imported);
      const candidate = await this.build(imported, manifest, fingerprint, signal, actionId);
      this.unpublished.set(actionId, candidate);
      if ((await this.settleOwned(actionId, true)) !== "CONFIRMED")
        throw new Error("Publication cleanup unconfirmed");
      this.unpublished.delete(actionId);
      return candidate;
    } catch (error) {
      await this.cleanup(actionId);
      throw error;
    }
  }

  /** Settles an unpublished candidate by its unique owned tag, preserving other references to the immutable image. */
  async discard(candidate: unknown, signal: AbortSignal): Promise<"CONFIRMED" | "UNCERTAIN"> {
    if (!isPublishedImageCandidate(candidate)) return "UNCERTAIN";
    const owned = this.ownedCandidates.get(candidate);
    if (!owned) return "UNCERTAIN";
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    try {
      const engine = engineSchema.parse(
        JSON.parse(await this.command(["info", "--format", "{{json .}}"], bounded)),
      );
      if (engine.ID !== owned.engineId) return "UNCERTAIN";
      const find = async () =>
        (
          await this.command(
            ["image", "ls", "--quiet", "--no-trunc", "--filter", `reference=${owned.tag}`],
            bounded,
          )
        ).trim();
      const found = await find();
      if (found) {
        if (found !== owned.imageId) return "UNCERTAIN";
        const image = imageSchema.parse(
          JSON.parse(await this.command(["image", "inspect", owned.tag], bounded)),
        )[0]!;
        if (
          image.Id !== owned.imageId ||
          image.Config.Labels?.["slop-loop.publication"] !== owned.publicationId
        )
          return "UNCERTAIN";
        await this.command(["image", "rm", "--no-prune", "--", owned.tag], bounded);
        if (await find()) return "UNCERTAIN";
      }
      if (
        path.dirname(owned.journal) !== this.trustedContextRoot ||
        !same(owned.rootIdentity, directory(this.trustedContextRoot)) ||
        !same(owned.journalIdentity, fs.lstatSync(owned.journal))
      )
        return "UNCERTAIN";
      fs.unlinkSync(owned.journal);
      this.ownedCandidates.delete(candidate);
      candidates.delete(candidate);
      return "CONFIRMED";
    } catch {
      return "UNCERTAIN";
    }
  }
}

/** Atomic replacement in an application-owned private directory; failed writes preserve the last good record. */
async function replacePrivateRecordBytes(
  bytes: Buffer,
  filename: string,
  expected?: fs.Stats,
  expectAbsent = false,
): Promise<fs.Stats> {
  if (path.resolve(filename) !== filename) throw new Error("Private record path unavailable");
  const parentPath = path.dirname(filename),
    parent = directory(parentPath);
  const initial = fs.existsSync(filename) ? fs.lstatSync(filename) : undefined;
  if (initial && (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1))
    throw new Error("Private record identity unavailable");
  if (expected && (!initial || !same(initial, expected))) throw new Error("Private record changed");
  if (expectAbsent && initial) throw new Error("Private record changed");
  const temporary = path.join(parentPath, `.prepared-record-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (process.platform === "win32") protect(temporary);
    const replacement = fs.lstatSync(temporary);
    if (!same(parent, directory(parentPath))) throw new Error("Private record directory changed");
    const current = fs.existsSync(filename) ? fs.lstatSync(filename) : undefined;
    if ((initial && (!current || !same(initial, current))) || (!initial && current))
      throw new Error("Private record changed");
    await fs.promises.rename(temporary, filename);
    return replacement;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Atomic replacement with a one-use, identity-fenced rollback for failed settlement. */
export async function writePreparedImageRecord(
  record: PreparedImageRecord,
  filename: string,
): Promise<() => Promise<void>> {
  const parsed = recordSchema.parse(record);
  let previous: Buffer | undefined;
  let previousIdentity: fs.Stats | undefined;
  if (fs.existsSync(filename)) {
    const before = fs.lstatSync(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4096)
      throw new Error("Private record identity unavailable");
    const held = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      if (!same(before, fs.fstatSync(held))) throw new Error("Private record changed");
      previous = fs.readFileSync(held);
      if (
        previous.length > 4096 ||
        !same(before, fs.fstatSync(held)) ||
        !same(before, fs.lstatSync(filename))
      )
        throw new Error("Private record changed");
      previousIdentity = before;
    } finally {
      fs.closeSync(held);
    }
  }
  const committed = await replacePrivateRecordBytes(
    Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8"),
    filename,
    previousIdentity,
    !previousIdentity,
  );
  let rolledBack = false;
  return async () => {
    if (rolledBack) throw new Error("Private record rollback replayed");
    const current = fs.lstatSync(filename);
    if (!same(committed, current)) throw new Error("Private record changed");
    if (previous) await replacePrivateRecordBytes(previous, filename, committed);
    else {
      const parentPath = path.dirname(filename);
      const parent = directory(parentPath);
      if (!same(committed, fs.lstatSync(filename)) || !same(parent, directory(parentPath)))
        throw new Error("Private record changed");
      fs.unlinkSync(filename);
    }
    rolledBack = true;
  };
}
