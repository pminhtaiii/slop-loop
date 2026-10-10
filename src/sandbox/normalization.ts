import { createHash } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import tar from "tar-stream";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import { parseTarStream, type TarReadableSource } from "./archive.js";
import { isValidatedGraph, parseLockedGraph, type LockedGraph } from "./downloads.js";
import {
  NORMALIZATION_METADATA,
  validateDependencyTree,
  type ValidatedDependencyTree,
} from "./dependencytree.js";
import { validateNormalizedPackage, type VerifiedPackage } from "./packagecontent.js";

/** Application-owned producer settings; never loaded from repository configuration. */
export const PNPM_NORMALIZATION_SETTINGS = Object.freeze({
  packageManager: "pnpm@12.5.1",
  nodeLinker: "isolated",
  hoist: false,
  ignoreScripts: true,
  ignorePnpmfile: true,
  preferSymlinkedExecutables: true,
  storeDir: "/tmp/store/v11",
  virtualStoreDir: "/preparation/node_modules/.pnpm",
  virtualStoreDirMaxLength: 120,
} as const);

export interface NormalizedPnpmOutput {
  readonly tar: Buffer;
  readonly tree: ValidatedDependencyTree;
  readonly sourceContentId: string;
}

const modulesSchema = z.strictObject({
  hoistedDependencies: z.strictObject({}),
  hoistPattern: z.array(z.never()).optional(),
  publicHoistPattern: z.array(z.never()).optional(),
  included: z.strictObject({
    dependencies: z.literal(true),
    devDependencies: z.literal(true),
    optionalDependencies: z.literal(true),
  }),
  layoutVersion: z.literal(5),
  nodeLinker: z.literal("isolated"),
  packageManager: z.literal("pnpm@12.5.1"),
  pendingBuilds: z.array(z.string().max(2048)).max(512),
  skipped: z.array(z.string().max(2048)).max(10_000),
  prunedAt: z
    .string()
    .max(128)
    .refine((value) => Number.isFinite(Date.parse(value))),
  storeDir: z.literal(PNPM_NORMALIZATION_SETTINGS.storeDir),
  virtualStoreDir: z.literal(PNPM_NORMALIZATION_SETTINGS.virtualStoreDir),
  virtualStoreDirMaxLength: z.literal(120),
  allowBuilds: z.strictObject({}).optional(),
});

function yamlValue(bytes: Buffer): unknown {
  if (bytes.byteLength > 32 * 1024 ** 2) throw new Error("Generated metadata limit exceeded");
  const docs = parseAllDocuments(bytes.toString("utf8"));
  if (docs.length !== 1 || docs[0]!.errors.length || docs[0]!.warnings.length)
    throw new Error("Unsupported generated pnpm metadata");
  return docs[0]!.toJS({ maxAliasCount: 0 });
}

/**
 * Closed, in-memory source recipe: at most 128 MiB expanded payload, 512 contexts,
 * and 100,000 placement-search steps. Larger/ambiguous outputs block rather than
 * dropping bytes. Linux manager equivalence still requires runtime fixture proof.
 * No archive is extracted and no package code is executed here.
 */
export async function normalizePnpmOutput(
  graph: LockedGraph,
  packages: readonly VerifiedPackage[],
  source: TarReadableSource,
  settings: typeof PNPM_NORMALIZATION_SETTINGS = PNPM_NORMALIZATION_SETTINGS,
): Promise<NormalizedPnpmOutput> {
  try {
    if (settings !== PNPM_NORMALIZATION_SETTINGS)
      throw new Error("Untrusted normalization settings");
    if (!isValidatedGraph(graph)) throw new Error("Untrusted locked graph");
    if (graph.nodes.length > 512) throw new Error("Normalization context limit exceeded");
    const manifests = new Map(packages.map((pkg) => [pkg.identity, pkg]));
    if (manifests.size !== packages.length) throw new Error("Duplicate verified package identity");
    for (const pkg of packages) validateNormalizedPackage(pkg, pkg.files);
    const data = new Map<string, Buffer>();
    const sourceHash = createHash("sha256");
    // Also bound tar padding/header bytes, independently from expanded payload.
    let archiveBytes = 0;
    const relay = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        archiveBytes += chunk.byteLength;
        if (archiveBytes > 160 * 1024 ** 2)
          return done(new Error("Normalization archive limit exceeded"));
        sourceHash.update(chunk);
        done(null, chunk);
      },
    });
    source.on("error", (error) =>
      relay.destroy(error instanceof Error ? error : new Error("Archive source failure")),
    );
    source.pipe(relay);
    const rawEntries = await parseTarStream(
      relay,
      { allowRelativeSymlinks: true, maxBytes: 128 * 1024 ** 2 },
      async (entry, stream) => {
        const chunks: Buffer[] = [];
        for await (const part of stream) {
          const value: unknown = part;
          if (!(value instanceof Uint8Array)) throw new Error("Dependency payload is not binary");
          chunks.push(Buffer.from(value));
        }
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== entry.size) throw new Error("Dependency payload size mismatch");
        if (!entry.path.startsWith("node_modules/"))
          throw new Error("Unsupported pnpm archive envelope");
        data.set(entry.path.slice("node_modules/".length), bytes);
      },
    );
    const envelope = rawEntries.find((entry) => entry.path === "node_modules");
    if (
      envelope?.kind !== "directory" ||
      envelope.mode !== 0o755 ||
      rawEntries.some(
        (entry) => entry.path !== "node_modules" && !entry.path.startsWith("node_modules/"),
      )
    )
      throw new Error("Unsupported pnpm archive envelope");
    const entries = rawEntries
      .filter((entry) => entry.path !== "node_modules")
      .map((entry) => ({ ...entry, path: entry.path.slice("node_modules/".length) }));
    const observed = new Map(entries.map((entry) => [entry.path, entry]));
    for (const name of [".modules.yaml", ".pnpm/lock.yaml"]) {
      if (observed.get(name)?.kind !== "file" || observed.get(name)?.mode !== 0o644)
        throw new Error("Missing or unsafe generated pnpm metadata");
    }
    const metadata = modulesSchema.parse(yamlValue(data.get(".modules.yaml")!));
    const active = new Set(graph.nodes.map((node) => node.artifact));
    const inactive = new Set(
      graph.artifacts.map((a) => `${a.name}@${a.version}`).filter((key) => !active.has(key)),
    );
    if (
      new Set(metadata.skipped).size !== metadata.skipped.length ||
      metadata.skipped.some((key) => !inactive.has(key))
    )
      throw new Error("Unsupported skipped pnpm package");
    if (
      new Set(metadata.pendingBuilds).size !== metadata.pendingBuilds.length ||
      metadata.pendingBuilds.some((key) => {
        const node = graph.nodes.find((candidate) => candidate.key === key);
        return !node || !Object.keys(manifests.get(node.artifact)?.scripts ?? {}).length;
      })
    )
      throw new Error("Unsupported pending pnpm build");
    const generated = parseLockedGraph(
      data.get(".pnpm/lock.yaml")!.toString("utf8"),
      graph.manifest,
    );
    // pnpm's virtual-store lock omits the root lock's manager prelude. Its
    // application artifacts must still be complete, including skipped platforms.
    const applicationDocument = parseAllDocuments(graph.lockfile).find(
      (document) => document.getIn(["importers", ".", "packageManagerDependencies"]) === undefined,
    );
    if (!applicationDocument) throw new Error("Missing application lock document");
    const applicationKeys = new Set(
      Object.keys(
        z
          .object({ packages: z.record(z.string(), z.unknown()) })
          .parse(applicationDocument.toJS({ maxAliasCount: 0 })).packages,
      ),
    );
    for (const artifact of generated.artifacts) {
      const authenticated = graph.artifacts.find(
        (candidate) => candidate.name === artifact.name && candidate.version === artifact.version,
      );
      if (!authenticated || JSON.stringify(authenticated) !== JSON.stringify(artifact))
        throw new Error("Generated pnpm artifact mismatch");
    }
    const signature = (value: LockedGraph) =>
      JSON.stringify([
        value.artifacts
          .filter((artifact) => applicationKeys.has(`${artifact.name}@${artifact.version}`))
          .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
        [...value.nodes]
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((node) => [node.key, node.artifact, Object.entries(node.dependencies).sort()]),
        Object.entries(value.roots).sort(),
      ]);
    if (signature(generated) !== signature(graph)) throw new Error("Generated pnpm lock mismatch");

    const rawLinks = new Map(
      entries
        .filter((entry) => entry.kind === "symlink")
        .map((entry) => [entry.path, entry.target ?? ""]),
    );
    const resolve = (location: string): string => {
      let current = location;
      const seen = new Set<string>();
      for (let depth = 0; depth <= rawLinks.size; depth++) {
        if (seen.has(current)) throw new Error("Dependency tree link cycle");
        seen.add(current);
        const segments = current.split("/");
        let changed = false;
        for (let end = 1; end <= segments.length; end++) {
          const prefix = segments.slice(0, end).join("/");
          const target = rawLinks.get(prefix);
          if (target === undefined) continue;
          if (
            !target ||
            target.includes("\\") ||
            target.includes("\0") ||
            target.startsWith("/") ||
            path.posix.normalize(target) !== target
          )
            throw new Error("Unsupported pnpm link target");
          current = path.posix.normalize(
            path.posix.join(path.posix.dirname(prefix), target, ...segments.slice(end)),
          );
          if (current === ".." || current.startsWith("../"))
            throw new Error("Dependency tree link escapes root");
          changed = true;
          break;
        }
        if (!changed) return current;
      }
      throw new Error("Dependency tree link cycle");
    };
    const candidates = new Map<string, string[]>();
    for (const node of graph.nodes) {
      const pkg = manifests.get(node.artifact);
      const artifact = graph.artifacts.find((a) => `${a.name}@${a.version}` === node.artifact);
      if (!pkg || artifact?.integrity !== pkg.integrity)
        throw new Error("Missing verified package or integrity mismatch");
      const name = artifact.name;
      const suffix = `/node_modules/${name}/package.json`;
      const roots = entries
        .filter(
          (entry) =>
            entry.kind === "file" && entry.path.startsWith(".pnpm/") && entry.path.endsWith(suffix),
        )
        .map((entry) => entry.path.slice(0, -"/package.json".length))
        .filter(
          (root) =>
            root.split("/node_modules/").length === 2 &&
            pkg.files.every((file) => {
              const entry = observed.get(`${root}/${file.path}`);
              const bytes = data.get(`${root}/${file.path}`);
              return (
                entry?.kind === "file" &&
                bytes?.length === file.bytes &&
                createHash("sha256").update(bytes).digest("hex") === file.hash &&
                entry.mode === (Object.values(pkg.bins).includes(file.path) ? 0o755 : file.mode)
              );
            }),
        );
      candidates.set(node.key, roots);
    }
    const assignment = new Map<string, string>();
    const used = new Set<string>();
    let steps = 0;
    let solution: Map<string, string> | undefined;
    let solutions = 0;
    const compatible = () => {
      for (const [name, key] of Object.entries(graph.roots)) {
        const root = assignment.get(key);
        if (root && (!rawLinks.has(name) || resolve(name) !== root)) return false;
      }
      for (const node of graph.nodes) {
        const root = assignment.get(node.key);
        if (!root) continue;
        const name = node.artifact.slice(0, node.artifact.lastIndexOf("@"));
        const parent = root.slice(0, -name.length);
        for (const [dependency, key] of Object.entries(node.dependencies)) {
          if (!rawLinks.has(parent + dependency)) return false;
          const target = assignment.get(key);
          if (target && resolve(parent + dependency) !== target) return false;
        }
      }
      return true;
    };
    const order = [...graph.nodes].sort(
      (a, b) => candidates.get(a.key)!.length - candidates.get(b.key)!.length,
    );
    const search = (index: number): void => {
      if (++steps > 100_000) throw new Error("Normalization placement search limit exceeded");
      if (solutions > 1) return;
      if (index === order.length) {
        solution = new Map(assignment);
        solutions++;
        return;
      }
      const key = order[index]!.key;
      for (const root of candidates.get(key)!) {
        if (used.has(root)) continue;
        assignment.set(key, root);
        used.add(root);
        if (compatible()) search(index + 1);
        assignment.delete(key);
        used.delete(root);
      }
    };
    search(0);
    if (solutions !== 1 || !solution)
      throw new Error("Missing or ambiguous authenticated pnpm placement");

    const output = new Map<string, { bytes?: Buffer; target?: string; mode: number }>();
    const accounted = new Set([".modules.yaml", ".pnpm/lock.yaml"]);
    const expectedRawLinks = new Map<string, string>();
    const canonicalRoots = new Map(graph.nodes.map((node) => [node.key, node.root]));
    const addLink = (raw: string, target: string, canonical: string, canonicalTarget: string) => {
      if (expectedRawLinks.has(raw) || output.has(canonical))
        throw new Error("Dependency tree path collision");
      expectedRawLinks.set(raw, target);
      output.set(canonical, {
        target: path.posix.relative(path.posix.dirname(canonical), canonicalTarget),
        mode: 0o777,
      });
    };
    for (const node of graph.nodes) {
      const rawRoot = solution.get(node.key)!;
      const pkg = manifests.get(node.artifact)!;
      for (const file of pkg.files) {
        const raw = `${rawRoot}/${file.path}`;
        accounted.add(raw);
        output.set(`${node.root}/${file.path}`, {
          bytes: data.get(raw)!,
          mode: observed.get(raw)!.mode!,
        });
      }
      const name = node.artifact.slice(0, node.artifact.lastIndexOf("@"));
      const rawParent = rawRoot.slice(0, -name.length);
      const parent = node.root.slice(0, -name.length);
      for (const [dependency, key] of Object.entries(node.dependencies)) {
        addLink(
          rawParent + dependency,
          solution.get(key)!,
          parent + dependency,
          canonicalRoots.get(key)!,
        );
        const dep = manifests.get(
          graph.nodes.find((candidate) => candidate.key === key)!.artifact,
        )!;
        for (const [bin, executable] of Object.entries(dep.bins))
          addLink(
            `${rawParent}.bin/${bin}`,
            `${solution.get(key)!}/${executable}`,
            `${parent}.bin/${bin}`,
            `${canonicalRoots.get(key)!}/${executable}`,
          );
      }
    }
    for (const [name, key] of Object.entries(graph.roots)) {
      addLink(name, solution.get(key)!, name, canonicalRoots.get(key)!);
      const pkg = manifests.get(graph.nodes.find((node) => node.key === key)!.artifact)!;
      for (const [bin, executable] of Object.entries(pkg.bins))
        addLink(
          `.bin/${bin}`,
          `${solution.get(key)!}/${executable}`,
          `.bin/${bin}`,
          `${canonicalRoots.get(key)!}/${executable}`,
        );
    }
    for (const [name, target] of expectedRawLinks) {
      if (!rawLinks.has(name) || resolve(name) !== target || observed.get(name)?.mode !== 0o777)
        throw new Error("Unsupported pnpm executable wrapper or dependency link");
      accounted.add(name);
    }
    const rawDirectories = new Set<string>();
    for (const name of accounted) {
      const parts = name.split("/");
      for (let end = 1; end < parts.length; end++)
        rawDirectories.add(parts.slice(0, end).join("/"));
    }
    for (const entry of entries) {
      if (entry.kind === "directory") {
        if (!rawDirectories.has(entry.path) || entry.mode !== 0o755)
          throw new Error("Unexpected pnpm directory");
      } else if (!accounted.has(entry.path)) throw new Error("Unexpected pnpm output entry");
    }
    output.set(".slop-loop-tree.json", { bytes: Buffer.from(NORMALIZATION_METADATA), mode: 0o644 });
    const pack = tar.pack();
    const chunks: Buffer[] = [];
    const collect = (async () => {
      for await (const part of pack) chunks.push(Buffer.from(part));
    })();
    for (const [name, entry] of [...output].sort(([a], [b]) => a.localeCompare(b, "en"))) {
      pack.entry(
        {
          name,
          mode: entry.mode,
          mtime: new Date(0),
          uid: 0,
          gid: 0,
          ...(entry.target ? { type: "symlink" as const, linkname: entry.target } : {}),
        },
        entry.bytes,
      );
    }
    pack.finalize();
    await collect;
    const bytes = Buffer.concat(chunks);
    const tree = await validateDependencyTree(graph, packages, Readable.from([bytes]));
    return Object.freeze({ tar: bytes, tree, sourceContentId: sourceHash.digest("hex") });
  } finally {
    source.destroy?.();
  }
}
