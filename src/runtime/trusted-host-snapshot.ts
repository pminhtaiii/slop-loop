/**
 * Trusted snapshot producer for specs/007 host-composition §3.
 *
 * Every reported fact is measured from the configured workspace filesystem; the
 * request carries only comparison claims (task/revision digests, inventory).
 * A refusal is total: no partial snapshot is ever returned, and this module
 * performs no command, provider or network call.
 */
import { computeCanonicalSha256, computeCheckSetDigest, isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
import type { CheckDefinition } from '../contracts/foundation/uc03.ts';
import { SHA256_HEX_REGEX, containsProtectedContent } from '../foundation/docker-workspace-policy.ts';
import type { FileStat, TrustedFilesystemPort } from '../foundation/repository-types.ts';
import type { TrustedHostPort, TrustedHostSnapshot, TrustedHostSnapshotRequest, TrustedTestFileSnapshot } from '../uc03/investigation-types.ts';

export type TrustedHostSnapshotRefusal =
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'IDENTITY_MISMATCH'
  | 'REVISION_MISMATCH'
  | 'REVISION_DRIFT'
  | 'MISSING_FILE'
  | 'LINKED_ESCAPE'
  | 'UNREADABLE_FILE'
  | 'OVERSIZED_FILE'
  | 'PROTECTED_CONTENT';

export class TrustedHostSnapshotError extends Error {
  readonly code: TrustedHostSnapshotRefusal;

  constructor(code: TrustedHostSnapshotRefusal, message: string) {
    super(`${code}: ${message}`);
    this.name = 'TrustedHostSnapshotError';
    this.code = code;
  }
}

// shortcut: these are the hosts where lstat reports links and junctions as symbolic links; other platforms refuse explicitly until measured.
const SUPPORTED_SNAPSHOT_PLATFORMS: ReadonlySet<string> = new Set(['win32', 'linux', 'darwin']);

export function isSupportedSnapshotPlatform(platform: string): boolean {
  return SUPPORTED_SNAPSHOT_PLATFORMS.has(platform);
}

export interface TrustedHostSnapshotOptions {
  readonly filesystem: TrustedFilesystemPort;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly acceptanceCriteria: readonly string[];
  readonly requiredChecks: readonly CheckDefinition[];
  /** The complete trust configuration's test inventory; no request or model input may extend it. */
  readonly expectedTestFiles: readonly string[];
  readonly maxFileBytes: number;
}

function fail(code: TrustedHostSnapshotRefusal, message: string): never {
  throw new TrustedHostSnapshotError(code, message);
}

function requireText(value: unknown, code: TrustedHostSnapshotRefusal, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(code, `${field} must be a non-empty string`);
  return value;
}

function normalizeInventory(paths: unknown, code: TrustedHostSnapshotRefusal): readonly string[] {
  if (!Array.isArray(paths) || paths.length === 0) fail(code, 'the test inventory must be a non-empty array');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [index, path] of paths.entries()) {
    if (typeof path !== 'string' || !isCanonicalRelativePath(path) || isProtectedPath(path)) {
      fail(code, `invalid test inventory path at index ${index}`);
    }
    const key = path.toLowerCase();
    if (seen.has(key)) fail(code, `duplicate test inventory path at index ${index}`);
    seen.add(key);
    out.push(path);
  }
  return Object.freeze(out);
}

function assertRequestInventory(expected: readonly string[], configured: readonly string[], configuredSet: ReadonlySet<string>): void {
  if (!Array.isArray(expected) || expected.length !== configured.length) {
    fail('INVALID_REQUEST', 'the request inventory does not match the trusted configuration');
  }
  const seen = new Set<string>();
  for (const [index, path] of expected.entries()) {
    if (typeof path !== 'string' || !isCanonicalRelativePath(path) || isProtectedPath(path)) {
      fail('INVALID_REQUEST', `invalid requested test path at index ${index}`);
    }
    const key = path.toLowerCase();
    if (seen.has(key) || !configuredSet.has(key)) {
      fail('INVALID_REQUEST', `requested test path at index ${index} is not part of the trusted inventory`);
    }
    seen.add(key);
  }
}

export function createTrustedHostSnapshot(options: TrustedHostSnapshotOptions): TrustedHostPort {
  if (!options || typeof options !== 'object') fail('INVALID_CONFIGURATION', 'options are required');
  const { filesystem } = options;
  if (
    !filesystem ||
    typeof filesystem.lstat !== 'function' ||
    typeof filesystem.realpath !== 'function' ||
    typeof filesystem.readTextFile !== 'function' ||
    typeof filesystem.getCurrentRevisionDigest !== 'function'
  ) {
    fail('INVALID_CONFIGURATION', 'a trusted filesystem port is required');
  }
  const workspaceId = requireText(options.workspaceId, 'INVALID_CONFIGURATION', 'workspaceId');
  const repositoryId = requireText(options.repositoryId, 'INVALID_CONFIGURATION', 'repositoryId');
  const maxFileBytes = options.maxFileBytes;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    fail('INVALID_CONFIGURATION', 'maxFileBytes must be a positive safe integer');
  }
  if (!Array.isArray(options.acceptanceCriteria) || options.acceptanceCriteria.length === 0 || !options.acceptanceCriteria.every(item => typeof item === 'string')) {
    fail('INVALID_CONFIGURATION', 'acceptanceCriteria must be a non-empty string array');
  }
  if (
    !Array.isArray(options.requiredChecks) ||
    options.requiredChecks.length === 0 ||
    !options.requiredChecks.every(check => check && typeof check === 'object' && typeof check.checkId === 'string' && check.checkId.length > 0)
  ) {
    fail('INVALID_CONFIGURATION', 'requiredChecks must be a non-empty check array');
  }
  const configuredInventory = normalizeInventory(options.expectedTestFiles, 'INVALID_CONFIGURATION');
  const configuredSet: ReadonlySet<string> = new Set(configuredInventory.map(path => path.toLowerCase()));
  const criteriaDigest = computeCanonicalSha256(options.acceptanceCriteria);
  const checkSetDigest = computeCheckSetDigest(options.requiredChecks);

  const measureRevision = async (): Promise<string> => {
    const digest = await filesystem.getCurrentRevisionDigest();
    if (typeof digest !== 'string' || !SHA256_HEX_REGEX.test(digest)) fail('REVISION_MISMATCH', 'the filesystem returned a malformed revision digest');
    return digest;
  };

  const measureFile = async (path: string): Promise<TrustedTestFileSnapshot> => {
    let link: FileStat;
    try {
      link = await filesystem.lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('MISSING_FILE', `test file '${path}' is missing`);
      fail('UNREADABLE_FILE', `test file '${path}' could not be inspected`);
    }
    if (link.isSymbolicLink) fail('LINKED_ESCAPE', `test file '${path}' is a symbolic link or junction`);
    if (!link.isFile) fail('MISSING_FILE', `test file '${path}' is not a regular file`);
    if (link.size > maxFileBytes) fail('OVERSIZED_FILE', `test file '${path}' exceeds ${maxFileBytes} bytes`);

    let resolved: string;
    try {
      resolved = await filesystem.realpath(path);
    } catch {
      fail('UNREADABLE_FILE', `test file '${path}' could not be resolved`);
    }
    // A link or junction anywhere above the file resolves to a different path; containment requires identity.
    if (resolved !== path) fail('LINKED_ESCAPE', `test file '${path}' resolves to '${resolved}' outside the approved path`);

    let content: string;
    try {
      content = await filesystem.readTextFile(path, maxFileBytes);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('FILE_TOO_LARGE')) fail('OVERSIZED_FILE', `test file '${path}' exceeds ${maxFileBytes} bytes`);
      fail('UNREADABLE_FILE', `test file '${path}' could not be read`);
    }
    if (containsProtectedContent(content)) fail('PROTECTED_CONTENT', `test file '${path}' contains protected content`);
    return Object.freeze({ path, content });
  };

  const loadSnapshot = async (request: TrustedHostSnapshotRequest): Promise<TrustedHostSnapshot> => {
    if (!isSupportedSnapshotPlatform(process.platform)) {
      fail('UNSUPPORTED_PLATFORM', `trusted snapshot measurement is unsupported on '${process.platform}'`);
    }
    if (!request || typeof request !== 'object') fail('INVALID_REQUEST', 'a snapshot request is required');
    const taskId = requireText(request.taskId, 'INVALID_REQUEST', 'taskId');
    const requestWorkspaceId = requireText(request.workspaceId, 'INVALID_REQUEST', 'workspaceId');
    const requestRepositoryId = requireText(request.repositoryId, 'INVALID_REQUEST', 'repositoryId');
    for (const [field, value] of [
      ['expectedRevisionDigest', request.expectedRevisionDigest],
      ['expectedCriteriaDigest', request.expectedCriteriaDigest],
      ['expectedCheckSetDigest', request.expectedCheckSetDigest],
    ] as const) {
      if (typeof value !== 'string' || !SHA256_HEX_REGEX.test(value)) fail('INVALID_REQUEST', `${field} must be a sha256 digest`);
    }
    if (requestWorkspaceId !== workspaceId || requestRepositoryId !== repositoryId) {
      fail('IDENTITY_MISMATCH', 'the request workspace or repository does not match the configured identity');
    }
    if (request.expectedCriteriaDigest !== criteriaDigest) fail('INVALID_REQUEST', 'the expected criteria digest does not match trusted configuration');
    if (request.expectedCheckSetDigest !== checkSetDigest) fail('INVALID_REQUEST', 'the expected check-set digest does not match trusted configuration');
    assertRequestInventory(request.expectedTestFiles, configuredInventory, configuredSet);

    const revision = await measureRevision();
    if (revision !== request.expectedRevisionDigest) {
      fail('REVISION_MISMATCH', `measured revision '${revision}' does not match the expected '${request.expectedRevisionDigest}'`);
    }

    const testFiles: TrustedTestFileSnapshot[] = [];
    for (const path of configuredInventory) testFiles.push(await measureFile(path));

    // Re-measure after the reads: any write during measurement changes the tree digest and refuses the whole snapshot.
    if ((await measureRevision()) !== revision) fail('REVISION_DRIFT', 'the repository revision changed during snapshot measurement');

    return Object.freeze({
      taskId,
      workspaceId,
      repositoryId,
      currentRevision: revision,
      checkSetDigest,
      testFiles: Object.freeze(testFiles),
      expectedTestFiles: configuredInventory,
    });
  };

  return Object.freeze({ loadSnapshot });
}
