import { createHash } from "node:crypto";
import path from "node:path";
import { parseTarStream, type TarReadableSource } from "./archive.js";
import { isValidatedGraph, type LockedGraph } from "./downloads.js";
import {
  validateNormalizedPackage,
  type PackageFile,
  type VerifiedPackage,
} from "./packagecontent.js";

export const NORMALIZATION_RECIPE = "pnpm-12.5.1-closed-v1";
export const NORMALIZATION_METADATA =
  '{"recipe":"pnpm-12.5.1-closed-v1","linker":"isolated","bins":"relative-links"}\n';
export interface ValidatedDependencyTree {
  readonly contentId: string;
  readonly graphId: string;
  readonly recipe: typeof NORMALIZATION_RECIPE;
}
const issuedTrees = new WeakSet<object>();
export function isValidatedTree(value: unknown): value is ValidatedDependencyTree {
  return typeof value === "object" && value !== null && issuedTrees.has(value);
}

/** Content authority only. A separate matching frozen-producer authority is required for effects. */
export async function validateDependencyTree(
  graph: LockedGraph,
  packages: readonly VerifiedPackage[],
  source: TarReadableSource,
): Promise<ValidatedDependencyTree> {
  try {
    const contentId = await compareTree(graph, packages, source, {}, true);
    const receipt = Object.freeze({
      contentId,
      graphId: createHash("sha256")
        .update(graph.lockfile)
        .update("\0")
        .update(graph.manifest)
        .digest("hex"),
      recipe: NORMALIZATION_RECIPE,
    });
    issuedTrees.add(receipt);
    return receipt;
  } finally {
    source.destroy?.();
  }
}

/** Full content comparison only; execution authority additionally requires a matching frozen producer. */
export async function verifyDependencyTree(
  graph: LockedGraph,
  packages: readonly VerifiedPackage[],
  source: TarReadableSource,
  limits: { readonly maxEntries?: number; readonly maxBytes?: number } = {},
): Promise<void> {
  try {
    await compareTree(graph, packages, source, limits);
  } finally {
    source.destroy?.();
  }
}

async function compareTree(
  graph: LockedGraph,
  packages: readonly VerifiedPackage[],
  source: TarReadableSource,
  limits: { readonly maxEntries?: number; readonly maxBytes?: number },
  closedRecipe = false,
): Promise<string> {
  const maxEntries = limits.maxEntries ?? 50_000;
  const maxBytes = limits.maxBytes ?? 4 * 1024 ** 3;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 50_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 4 * 1024 ** 3
  )
    throw new Error("Invalid dependency tree limits");
  if (!isValidatedGraph(graph)) throw new Error("Untrusted locked graph");
  const manifests = new Map(packages.map((pkg) => [pkg.identity, pkg]));
  if (manifests.size !== packages.length) throw new Error("Duplicate verified package identity");
  const expected = new Map<string, PackageFile>();
  const links = new Map<string, string>();
  const names = new Set<string>();
  let expandedBytes = 0;
  let metadataBytes = 0;
  const reserve = (name: string, bytes: number) => {
    if (names.has(name.toLowerCase())) throw new Error("Dependency tree path collision");
    names.add(name.toLowerCase());
    expandedBytes += bytes;
    metadataBytes += Buffer.byteLength(name) + 128;
    if (names.size > maxEntries || expandedBytes > maxBytes || metadataBytes > 16 * 1024 ** 2)
      throw new Error("Dependency tree limit exceeded");
  };
  if (closedRecipe) {
    reserve(".slop-loop-tree.json", Buffer.byteLength(NORMALIZATION_METADATA));
    expected.set(".slop-loop-tree.json", {
      path: ".slop-loop-tree.json",
      bytes: Buffer.byteLength(NORMALIZATION_METADATA),
      mode: 0o644,
      hash: createHash("sha256").update(NORMALIZATION_METADATA).digest("hex"),
    });
  }
  const roots = new Map(graph.nodes.map((node) => [node.key, node.root]));
  for (const node of graph.nodes) {
    const pkg = manifests.get(node.artifact);
    if (!pkg) throw new Error("Missing verified package");
    validateNormalizedPackage(pkg, pkg.files);
    const artifact = graph.artifacts.find((a) => `${a.name}@${a.version}` === node.artifact);
    if (!artifact || artifact.integrity !== pkg.integrity)
      throw new Error("Package integrity identity mismatch");
    for (const file of pkg.files) {
      const name = `${node.root}/${file.path}`;
      reserve(name, file.bytes);
      expected.set(
        name,
        Object.values(pkg.bins).includes(file.path) ? { ...file, mode: 0o755 } : file,
      );
    }
    const name = node.artifact.slice(0, node.artifact.lastIndexOf("@"));
    const parent = node.root.slice(0, -name.length);
    for (const [dependency, ref] of Object.entries(node.dependencies)) {
      const target = roots.get(ref);
      if (!target) throw new Error("Missing locked placement");
      reserve(parent + dependency, 0);
      links.set(parent + dependency, target);
      const dependencyNode = graph.nodes.find((candidate) => candidate.key === ref);
      const dependencyPackage = dependencyNode && manifests.get(dependencyNode.artifact);
      if (!dependencyPackage) throw new Error("Missing verified package");
      for (const [bin, executable] of Object.entries(dependencyPackage.bins)) {
        const location = `${parent}.bin/${bin}`;
        reserve(location, 0);
        links.set(location, `${target}/${executable}`);
      }
    }
  }
  for (const [name, key] of Object.entries(graph.roots)) {
    const root = roots.get(key);
    if (!root) throw new Error("Missing locked placement");
    reserve(name, 0);
    links.set(name, root);
    const node = graph.nodes.find((candidate) => candidate.key === key);
    const pkg = node && manifests.get(node.artifact);
    if (!pkg) throw new Error("Missing verified package");
    for (const [bin, target] of Object.entries(pkg.bins)) {
      const location = `.bin/${bin}`;
      reserve(location, 0);
      links.set(location, `${root}/${target}`);
    }
  }
  const resolveLink = (value: string): string => {
    let current = value;
    const visited = new Set<string>();
    for (let depth = 0; depth <= links.size; depth++) {
      if (visited.has(current)) throw new Error("Dependency tree link cycle");
      visited.add(current);
      const segments = current.split("/");
      let replacement: string | undefined;
      for (let end = 1; end <= segments.length; end++) {
        const prefix = segments.slice(0, end).join("/");
        const target = links.get(prefix);
        if (target) {
          replacement = [target, ...segments.slice(end)].join("/");
          break;
        }
      }
      if (!replacement) return current;
      current = replacement;
    }
    throw new Error("Dependency tree link cycle");
  };
  const observed = new Set<string>();
  const entries = await parseTarStream(
    source,
    { allowRelativeSymlinks: true, maxEntries, maxBytes },
    async (entry, stream, mode) => {
      const required = expected.get(entry.path);
      if (!required) throw new Error("Unexpected dependency tree entry");
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const part of stream) {
        const value: unknown = part;
        if (!(value instanceof Uint8Array)) throw new Error("Dependency payload is not binary");
        bytes += value.byteLength;
        hash.update(value);
      }
      if (
        bytes !== required.bytes ||
        hash.digest("hex") !== required.hash ||
        mode !== required.mode
      )
        throw new Error("Dependency tree content mismatch");
      observed.add(entry.path);
    },
  );
  const directories = new Set<string>();
  for (const file of [...expected.keys(), ...links.keys()]) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  for (const entry of entries) {
    if (entry.kind === "directory") {
      if (!directories.has(entry.path) || entry.mode !== 0o755)
        throw new Error("Unexpected dependency tree directory");
    } else if (entry.kind === "symlink") {
      const target = entry.target ?? "";
      // Only canonical relative links are emitted by the trusted recipe. In particular,
      // an interior '..' cannot be normalized before following a symlink component.
      if (
        !target ||
        path.posix.normalize(target) !== target ||
        target.startsWith("/") ||
        target.includes("\\") ||
        target.includes("\0") ||
        resolveLink(
          path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), target)),
        ) !== links.get(entry.path)
      )
        throw new Error("Dependency tree link mismatch");
      observed.add(entry.path);
    }
  }
  if (observed.size !== expected.size + links.size)
    throw new Error("Missing dependency tree entry");
  for (const required of [...expected.keys(), ...links.keys()])
    if (!observed.has(required)) throw new Error("Missing dependency tree entry");
  const canonical = entries
    .map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      ...(entry.kind === "file" ? { hash: expected.get(entry.path)!.hash, bytes: entry.size } : {}),
      ...(entry.kind === "symlink" ? { target: entry.target } : {}),
    }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  return createHash("sha256")
    .update(JSON.stringify([NORMALIZATION_RECIPE, canonical]))
    .digest("hex");
}
