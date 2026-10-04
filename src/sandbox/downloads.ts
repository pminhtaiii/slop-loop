const APPROVED_REGISTRY_HOSTS = new Set(["registry.npmjs.org"]);
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/u;

export interface LockedArtifact {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly integrity: string;
}

function artifactName(key: string): string {
  const at = key.lastIndexOf("@");
  if (at <= 0) throw new TypeError("Locked package identity is invalid");
  return key.slice(0, at);
}

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

export function parseLockedArtifacts(lockfile: string): readonly LockedArtifact[] {
  if (lockfile.length === 0 || lockfile.length > 32 * 1024 * 1024) {
    throw new TypeError("Lockfile is outside the supported bounds");
  }
  const lines = lockfile.split(/\r?\n/u);
  const artifacts: LockedArtifact[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const packageMatch = /^ {2}([^:\s][^:]*):\s*$/u.exec(lines[index] ?? "");
    if (!packageMatch) continue;
    const key = packageMatch[1];
    if (!key || key.startsWith("http")) continue;
    let integrity = "";
    let tarball = "";
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (/^ {2}[^ \t]/u.test(line)) break;
      const integrityMatch = /^\s+integrity:\s*(\S+)\s*$/u.exec(line);
      const tarballMatch = /^\s+tarball:\s*(\S+)\s*$/u.exec(line);
      if (integrityMatch?.[1]) integrity = integrityMatch[1];
      if (tarballMatch?.[1]) tarball = tarballMatch[1];
    }
    if (integrity || tarball) {
      const versionMatch = /@([^@/]+)$/u.exec(key);
      if (!versionMatch?.[1]) throw new TypeError("Locked package version is missing");
      artifacts.push(
        validateLockedArtifact({
          name: artifactName(key),
          version: versionMatch[1],
          tarball,
          integrity,
        }),
      );
    }
  }
  if (artifacts.length === 0) throw new TypeError("No locked registry artifacts found");
  return Object.freeze(artifacts);
}
