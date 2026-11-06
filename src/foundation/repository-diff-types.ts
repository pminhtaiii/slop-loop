/**
 * Dependency-neutral declarations shared by the retained-baseline source and the diff measurement.
 * Kept import-free so `repository-baseline-source.ts`, `repository-diff.ts` and `repository-types.ts`
 * can all depend on it without forming a module cycle.
 */

export interface RepositoryBaselineBinding {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  /** Measured revision digest of the retained initial tree. */
  readonly baseRevision: string;
}

export interface RepositoryBaselineManifestEntry {
  readonly path: string;
  /** Raw-byte sha256, matching `WorkspaceFilesystemPort.getCurrentRevisionDigest`. */
  readonly digest: string;
  readonly sizeBytes: number;
}

export interface RepositoryBaselineManifest {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly baseRevision: string;
  readonly entries: readonly RepositoryBaselineManifestEntry[];
  readonly manifestDigest: string;
}

export interface RepositoryBaselineFile {
  readonly path: string;
  readonly content: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

export interface RepositoryBaselineSource {
  loadManifest(binding: RepositoryBaselineBinding): Promise<RepositoryBaselineManifest>;
  readBaselineFile(binding: RepositoryBaselineBinding, path: string): Promise<RepositoryBaselineFile>;
}

export interface RepositoryDiffSourceOptions {
  readonly baseline: RepositoryBaselineSource;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  /** Per-file read bound; a larger current or retained file refuses rather than truncating. */
  readonly maxFileBytes: number;
  /** Finite bound on the emitted diff bytes; exceeding it refuses rather than truncating. */
  readonly maxDiffBytes: number;
}
