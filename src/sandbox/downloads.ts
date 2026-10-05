import { parseAllDocuments } from "yaml";
import { z } from "zod";

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
  const schema = z.object({
    packages: z.record(
      z.string(),
      z.object({
        resolution: z.object({ integrity: z.string(), tarball: z.string().optional() }),
      }),
    ),
  });
  const packages = parseAllDocuments(lockfile).flatMap((document) => {
    const error = document.errors[0];
    if (error !== undefined) throw error;
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
