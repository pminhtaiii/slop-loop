import { isMap, parseAllDocuments } from "yaml";
import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";

const APPROVED_REGISTRY_HOSTS = new Set(["registry.npmjs.org"]);
const MAX_ARTIFACTS = 10_000;
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u;

export interface LockedArtifact {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly integrity: string;
}

/** Digest actual retained bytes; accepting an SRI string alone establishes no integrity. */
export function verifyArtifactBytes(artifact: LockedArtifact, bytes: Buffer): void {
  validateLockedArtifact(artifact);
  if (bytes.length > 128 * 1024 * 1024) throw new TypeError("Artifact byte limit exceeded");
  const [algorithm, encoded] = artifact.integrity.split("-");
  const expected = Buffer.from(encoded!, "base64");
  const actual = createHash(algorithm!).update(bytes).digest();
  if (
    expected.toString("base64") !== encoded ||
    expected.length !== actual.length ||
    !timingSafeEqual(actual, expected)
  )
    throw new TypeError("Artifact integrity failure");
}

const packageName = z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u);
const strings = z.array(z.string().min(1).max(256)).max(64);
const versions = z.record(packageName, z.string().min(1).max(1024));
const dependency = z.strictObject({
  specifier: z.string().min(1).max(1024),
  version: z.string().min(1).max(1024),
});
const importerSchema = z.strictObject({
  dependencies: z.record(packageName, dependency).optional(),
  devDependencies: z.record(packageName, dependency).optional(),
  optionalDependencies: z.record(packageName, dependency).optional(),
});
const managerImporterSchema = z.strictObject({
  configDependencies: z.strictObject({}),
  packageManagerDependencies: z.strictObject({
    pnpm: z.strictObject({ specifier: z.literal("12.5.1"), version: z.literal("12.5.1") }),
  }),
});
const graphSchema = z.strictObject({
  lockfileVersion: z.union([z.literal("9.0"), z.literal(9)]),
  settings: z
    .strictObject({ autoInstallPeers: z.literal(true), excludeLinksFromLockfile: z.literal(false) })
    .optional(),
  importers: z.strictObject({ ".": z.union([importerSchema, managerImporterSchema]) }),
  packages: z
    .record(
      z.string().min(1).max(2048),
      z.strictObject({
        resolution: z.strictObject({ integrity: z.string(), tarball: z.string().optional() }),
        engines: z
          .strictObject({
            node: z.string().max(1024).optional(),
            pnpm: z.string().max(1024).optional(),
            npm: z.string().max(1024).optional(),
          })
          .optional(),
        cpu: strings.optional(),
        os: strings.optional(),
        libc: strings.optional(),
        hasBin: z.boolean().optional(),
        deprecated: z.string().max(4096).optional(),
        peerDependencies: versions.optional(),
        peerDependenciesMeta: z
          .record(packageName, z.strictObject({ optional: z.boolean() }))
          .optional(),
      }),
    )
    .refine((v) => Object.keys(v).length <= MAX_ARTIFACTS),
  snapshots: z
    .record(
      z.string().min(1).max(2048),
      z.strictObject({
        dependencies: versions.optional(),
        optionalDependencies: versions.optional(),
        transitivePeerDependencies: strings.optional(),
        optional: z.boolean().optional(),
      }),
    )
    .refine((v) => Object.keys(v).length <= MAX_ARTIFACTS),
});

export interface LockedGraph {
  readonly artifacts: readonly LockedArtifact[];
  readonly manifest: string;
  readonly lockfile: string;
  readonly nodes: readonly LockedNode[];
  readonly roots: Readonly<Record<string, string>>;
}

export interface LockedNode {
  readonly key: string;
  readonly artifact: string;
  readonly root: string;
  readonly dependencies: Readonly<Record<string, string>>;
}
const issuedGraphs = new WeakSet<LockedGraph>();
export function isValidatedGraph(graph: LockedGraph): boolean {
  return issuedGraphs.has(graph);
}

/** Closed pnpm 9 graph grammar for the pinned reference manager; never inherits repository hooks. */
export function parseLockedGraph(lockfile: string, manifest: string): LockedGraph {
  if (
    Buffer.byteLength(lockfile) > 32 * 1024 * 1024 ||
    Buffer.byteLength(manifest) > 16 * 1024 * 1024
  )
    throw new TypeError("Preparation input limit exceeded");
  const documents = parseAllDocuments(lockfile);
  if (
    documents.length < 1 ||
    documents.length > 2 ||
    documents.some((d) => d.errors.length || d.warnings.length)
  )
    throw new TypeError("Unsupported locked graph");
  const parsed = documents.map((d) => graphSchema.safeParse(d.toJS({ maxAliasCount: 0 })));
  if (parsed.some((p) => !p.success)) throw new TypeError("Unsupported locked graph");
  const graphs = parsed.map((p) => {
    if (!p.success) throw new TypeError("Unsupported locked graph");
    return p.data;
  });
  const appGraphs = graphs.filter((g) => !("packageManagerDependencies" in g.importers["."]));
  if (
    appGraphs.length !== 1 ||
    (graphs.length === 2 && !("packageManagerDependencies" in graphs[0]!.importers["."]))
  )
    throw new TypeError("Unsupported locked graph");
  const app = appGraphs[0]!;
  const root: unknown = JSON.parse(manifest);
  const rootSchema = z
    .object({
      dependencies: versions.optional(),
      devDependencies: versions.optional(),
      optionalDependencies: versions.optional(),
      packageManager: z.literal("pnpm@12.5.1").optional(),
    })
    .passthrough();
  const rootParsed = rootSchema.safeParse(root);
  if (
    !rootParsed.success ||
    [
      "pnpm",
      "workspaces",
      "overrides",
      "resolutions",
      "config",
      "installConfig",
      "publishConfig",
    ].some((k) => k in rootParsed.data)
  )
    throw new TypeError("Unsupported preparation manifest configuration");
  const all = new Map<string, LockedArtifact>();
  const baseKey = (value: string) => {
    if (value.length > 2048 || !/^[A-Za-z0-9@._/+()-]+$/u.test(value))
      throw new TypeError("Unsupported dependency source");
    const base = value.split("(")[0]!;
    const version = base.slice(base.lastIndexOf("@") + 1);
    if (!EXACT_VERSION.test(version)) throw new TypeError("Unsupported dependency source");
    // Every peer suffix is an exact identity, including nested peer variants.
    let balance = 0;
    for (const char of value.slice(base.length)) {
      if (char === "(" && ++balance > 32) throw new TypeError("Unsupported dependency source");
      if (char === ")" && --balance < 0) throw new TypeError("Unsupported dependency source");
    }
    if (balance !== 0) throw new TypeError("Unsupported dependency source");
    for (const peer of value.slice(base.length).split(/[()]/u).filter(Boolean)) {
      const at = peer.lastIndexOf("@");
      if (
        at <= 0 ||
        !packageName.safeParse(peer.slice(0, at)).success ||
        !EXACT_VERSION.test(peer.slice(at + 1))
      )
        throw new TypeError("Unsupported dependency source");
    }
    return base;
  };
  for (const g of graphs) {
    if (
      "packageManagerDependencies" in g.importers["."] &&
      (!("pnpm@12.5.1" in g.packages) || !("pnpm@12.5.1" in g.snapshots))
    )
      throw new TypeError("Missing locked package manager");
    for (const [key, entry] of Object.entries(g.packages)) {
      if (
        Object.values(entry.peerDependencies ?? {}).some(
          (range) => !/^[0-9xX*~^<>=| .+-]+$/u.test(range),
        )
      )
        throw new TypeError("Unsupported dependency source");
      if (baseKey(key) !== key) throw new TypeError("Unsupported package identity");
      const at = key.lastIndexOf("@");
      const name = key.slice(0, at),
        version = key.slice(at + 1);
      if (!packageName.safeParse(name).success) throw new TypeError("Unsupported package identity");
      const artifact = validateLockedArtifact({
        name,
        version,
        integrity: entry.resolution.integrity,
        tarball:
          entry.resolution.tarball ??
          `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`,
      });
      const [algorithm, encoded] = artifact.integrity.split("-");
      const digest = Buffer.from(encoded!, "base64");
      const length = algorithm === "sha256" ? 32 : algorithm === "sha384" ? 48 : 64;
      if (digest.length !== length || digest.toString("base64") !== encoded)
        throw new TypeError("Locked artifact digest encoding is invalid");
      const previous = all.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(artifact))
        throw new TypeError("Conflicting locked artifact");
      all.set(key, artifact);
    }
    const covered = new Set<string>();
    for (const [key, entry] of Object.entries(g.snapshots)) {
      const base = baseKey(key);
      if (!(base in g.packages)) throw new TypeError("Missing locked package");
      for (const peer of key.slice(base.length).split(/[()]/u).filter(Boolean))
        if (!(peer in g.packages)) throw new TypeError("Missing locked peer");
      let peerDepth = 0;
      let peerStart = 0;
      for (let index = base.length; index < key.length; index++) {
        if (key[index] === "(" && peerDepth++ === 0) peerStart = index + 1;
        if (key[index] !== ")" || --peerDepth !== 0) continue;
        const context = key.slice(peerStart, index);
        const peerBase = baseKey(context);
        const peerName = peerBase.slice(0, peerBase.lastIndexOf("@"));
        if (peerName in (g.packages[base]!.peerDependencies ?? {})) {
          const resolved = entry.dependencies?.[peerName] ?? entry.optionalDependencies?.[peerName];
          if (`${peerName}@${resolved}` !== context)
            throw new TypeError("Locked peer edge mismatch");
        }
      }
      covered.add(base);
      for (const refs of [entry.dependencies, entry.optionalDependencies])
        for (const [name, version] of Object.entries(refs ?? {}))
          if (
            !(baseKey(`${name}@${version}`) in g.packages) ||
            !(`${name}@${version}` in g.snapshots)
          )
            throw new TypeError("Missing locked dependency");
    }
    for (const key of Object.keys(g.packages))
      if (!covered.has(key)) throw new TypeError("Missing locked snapshot");
  }
  const importer = app.importers["."];
  if ("packageManagerDependencies" in importer) throw new TypeError("Unsupported locked graph");
  const sanitized: Record<string, unknown> = { name: "slop-loop-preparation", private: true };
  for (const kind of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const declared = rootParsed.data[kind] ?? {};
    const locked = importer[kind] ?? {};
    if (Object.keys(declared).length !== Object.keys(locked).length)
      throw new TypeError("Manifest lock mismatch");
    for (const [name, specifier] of Object.entries(declared)) {
      const ref = locked[name];
      if (
        !ref ||
        ref.specifier !== specifier ||
        !/^[0-9xX*~^<>=| .+-]+$/u.test(specifier) ||
        !(baseKey(`${name}@${ref.version}`) in app.packages) ||
        !(`${name}@${ref.version}` in app.snapshots)
      )
        throw new TypeError("Manifest lock mismatch");
    }
    sanitized[kind] = declared;
  }
  if (all.size === 0 || all.size > MAX_ARTIFACTS)
    throw new TypeError("Locked artifact count exceeds limit");
  const roots: Record<string, string> = {};
  const eligible = (key: string) => {
    const pkg = app.packages[baseKey(key)]!;
    const permits = (list: readonly string[] | undefined, value: string) =>
      !list ||
      (!list.includes(`!${value}`) &&
        (list.every((v) => v.startsWith("!")) || list.includes(value)));
    return permits(pkg.os, "linux") && permits(pkg.cpu, "x64") && permits(pkg.libc, "glibc");
  };
  const nodes: LockedNode[] = [];
  for (const [key, snapshot] of Object.entries(app.snapshots)) {
    if (!eligible(key)) continue;
    const dependencies: Record<string, string> = {};
    for (const [name, version] of Object.entries(snapshot.dependencies ?? {})) {
      const ref = `${name}@${version}`;
      if (!eligible(ref)) throw new TypeError("Required dependency platform unavailable");
      dependencies[name] = ref;
    }
    for (const [name, version] of Object.entries(snapshot.optionalDependencies ?? {})) {
      const ref = `${name}@${version}`;
      if (eligible(ref)) {
        if (name in dependencies && dependencies[name] !== ref)
          throw new TypeError("Conflicting locked dependency");
        dependencies[name] = ref;
      }
    }
    const artifact = baseKey(key);
    const name = artifact.slice(0, artifact.lastIndexOf("@"));
    let slot = key
      .replaceAll("/", "+")
      .replace(/\)$/u, "")
      .replaceAll(")(", "_")
      .replace(/[()]/gu, "_");
    if (slot.length > 120 || slot !== slot.toLowerCase())
      slot = slot.slice(0, 87) + "_" + createHash("sha256").update(slot).digest("hex").slice(0, 32);
    nodes.push(
      Object.freeze({
        key,
        artifact,
        root: `.pnpm/${slot}/node_modules/${name}`,
        dependencies: Object.freeze(dependencies),
      }),
    );
  }
  for (const kind of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    for (const [name, ref] of Object.entries(importer[kind] ?? {})) {
      const key = `${name}@${ref.version}`;
      if (!eligible(key)) {
        if (kind !== "optionalDependencies")
          throw new TypeError("Required dependency platform unavailable");
        continue;
      }
      if (name in roots && roots[name] !== key)
        throw new TypeError("Conflicting locked dependency");
      roots[name] = key;
    }
  }
  const result = Object.freeze({
    artifacts: Object.freeze([...all.values()]),
    manifest: JSON.stringify(sanitized),
    lockfile,
    nodes: Object.freeze(nodes),
    roots: Object.freeze(roots),
  });
  issuedGraphs.add(result);
  return result;
}

/**
 * Extracts the package name from a locked package identifier key.
 */
function artifactName(key: string): string {
  const at = key.lastIndexOf("@");
  if (at <= 0) throw new TypeError("Locked package identity is invalid");
  return key.slice(0, at);
}

/**
 * Validates a locked package artifact record ensuring exact semver versioning,
 * valid cryptographic integrity hash, and approved public registry origin.
 */
export function validateLockedArtifact(input: LockedArtifact): LockedArtifact {
  if (!input.name || !EXACT_VERSION.test(input.version)) {
    throw new TypeError("Locked artifact must use an exact version");
  }
  if (!INTEGRITY.test(input.integrity)) {
    throw new TypeError("Locked artifact integrity is required");
  }
  let url: URL;
  try {
    url = new URL(input.tarball);
  } catch {
    throw new TypeError("Locked artifact URL is invalid");
  }
  if (url.protocol !== "https:" || !APPROVED_REGISTRY_HOSTS.has(url.hostname)) {
    throw new TypeError("Locked artifact registry is not approved");
  }
  if (url.username || url.password || (url.port !== "" && url.port !== "443"))
    throw new TypeError("Locked artifact destination is unsafe");
  const basename = input.name.slice(input.name.lastIndexOf("/") + 1);
  const expectedPath = `/${input.name}/-/${basename}-${input.version}.tgz`;
  if (url.pathname !== expectedPath || url.search !== "" || url.hash !== "") {
    throw new TypeError("Locked artifact URL is not an approved registry URL");
  }
  return Object.freeze({ ...input });
}

/**
 * Parses and extracts locked package artifacts from a pnpm lockfile string.
 * Validates schema, bounded artifact count, package identity naming, and integrity.
 */
export function parseLockedArtifacts(lockfile: string): readonly LockedArtifact[] {
  if (lockfile.length === 0 || lockfile.length > 32 * 1024 * 1024) {
    throw new TypeError("Lockfile is outside the supported bounds");
  }
  const pkgsMatch = lockfile.match(/(?:^|\n)packages:\s*\n([\s\S]*?)(?=\n\S|\n*$)/u);
  if (pkgsMatch) {
    const rawCount = (pkgsMatch[1]!.match(/^ {2}\S[^\n:]*:\s*(?:\n|$)/gmu) ?? []).length;
    if (rawCount > MAX_ARTIFACTS) {
      throw new TypeError("Locked artifact count exceeds limit");
    }
  }
  const docs = parseAllDocuments(lockfile);
  let totalRawPackages = 0;
  for (const document of docs) {
    const error = document.errors[0];
    if (error !== undefined) throw error;
    const pkgs = document.get("packages");
    if (isMap(pkgs)) {
      totalRawPackages += pkgs.items.length;
    } else if (
      pkgs !== null &&
      typeof pkgs === "object" &&
      "items" in pkgs &&
      Array.isArray((pkgs as { items?: unknown }).items)
    ) {
      totalRawPackages += (pkgs as { items: unknown[] }).items.length;
    }
  }
  if (totalRawPackages > MAX_ARTIFACTS) {
    throw new TypeError("Locked artifact count exceeds limit");
  }
  const schema = z.object({
    packages: z.record(
      z.string(),
      z.object({
        resolution: z.object({ integrity: z.string(), tarball: z.string().optional() }),
      }),
    ),
  });
  const packages = docs.flatMap((document) => {
    return Object.entries(schema.parse(document.toJS({ maxAliasCount: 0 })).packages);
  });
  if (packages.length > MAX_ARTIFACTS) {
    throw new TypeError("Locked artifact count exceeds limit");
  }
  const artifacts: LockedArtifact[] = [];
  for (const [rawKey, entry] of packages) {
    const key = rawKey.replace(/^\//u, "").replace(/\(.*\)$/u, "");
    const name = artifactName(key);
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name))
      throw new TypeError("Locked package identity is invalid");
    const version = key.slice(key.lastIndexOf("@") + 1);
    const basename = name.slice(name.lastIndexOf("/") + 1);
    artifacts.push(
      validateLockedArtifact({
        name,
        version,
        integrity: entry.resolution.integrity,
        tarball:
          entry.resolution.tarball ??
          `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`,
      }),
    );
  }
  if (artifacts.length === 0) throw new TypeError("No locked registry artifacts found");
  return Object.freeze(artifacts);
}
