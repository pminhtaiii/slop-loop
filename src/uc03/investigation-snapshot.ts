import { createHash } from 'node:crypto';
import {
  computeCanonicalSha256,
  isCanonicalRelativePath,
  isProtectedPath,
} from '../contracts/foundation/uc03.ts';
import { extractCheckTestSelectors, normalizePytestSelector, PYTEST_OPTIONS_WITH_ARG, resolvePytestInvocation } from './selectors.ts';
import type { CheckDefinition } from '../contracts/foundation/uc03.ts';
import type {
  BaselineEvidenceAcknowledgement,
  BaselineEvidenceWriteRequest,
  TrustedHostExpectedContext,
  TrustedTestFileSnapshot,
} from './investigation-types.ts';

const COLLECTION_ERROR_PATTERN =
  /syntaxerror|collectionerror|collection error|failed to collect|import error|importerror|modulenotfounderror/i;

export function isCollectionOrSyntaxError(outputExcerpt?: string): boolean {
  if (!outputExcerpt) return false;
  return COLLECTION_ERROR_PATTERN.test(outputExcerpt);
}

export function baselineEvidenceAcknowledgementMatches(
  acknowledgement: unknown,
  request: BaselineEvidenceWriteRequest
): acknowledgement is BaselineEvidenceAcknowledgement {
  try {
    if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)) {
      return false;
    }
    const expectedKeys = [
      'evidenceId',
      'taskId',
      'workspaceId',
      'repositoryId',
      'contentDigest',
      'repositorySnapshotDigest',
      'criteriaDigest',
      'checkSetDigest',
      'testProtectionDigest',
      'reproductionCheckId',
      'expectedPassingCheckIds',
      'expectedTestFiles',
      'requiredCheckIds',
    ].sort();
    const ack = acknowledgement as Record<string, unknown>;
    const actualKeys = Reflect.ownKeys(ack).map(String).sort();
    const content = request.content;
    return (
      actualKeys.length === expectedKeys.length &&
      actualKeys.every((key, index) => key === expectedKeys[index]) &&
      typeof ack.evidenceId === 'string' &&
      ack.evidenceId.trim().length > 0 &&
      ack.taskId === content.taskId &&
      ack.workspaceId === content.workspaceId &&
      ack.repositoryId === content.repositoryId &&
      ack.contentDigest === request.contentDigest &&
      ack.repositorySnapshotDigest === content.repositorySnapshotDigest &&
      ack.criteriaDigest === content.criteriaDigest &&
      ack.checkSetDigest === content.checkSetDigest &&
      ack.testProtectionDigest === content.testProtectionDigest &&
      ack.reproductionCheckId === content.reproductionCheckId &&
      computeCanonicalSha256(ack.expectedPassingCheckIds) ===
        computeCanonicalSha256(content.expectedPassingCheckIds) &&
      computeCanonicalSha256(ack.expectedTestFiles) ===
        computeCanonicalSha256(content.expectedTestFiles) &&
      computeCanonicalSha256(ack.requiredCheckIds) ===
        computeCanonicalSha256(content.requiredChecks.map((check) => check.checkId))
    );
  } catch {
    return false;
  }
}

export function computeTestProtectionDigest(
  testFiles: readonly TrustedTestFileSnapshot[]
): string {
  if (!Array.isArray(testFiles) || testFiles.length === 0) {
    throw new Error('TEST_PROTECTION_EMPTY: No test files provided for test protection authority');
  }

  // Defensively extract and validate test file entries once before sorting/hashing
  const extractedFiles: { path: string; rawBytes: Buffer; tag: 'text' | 'binary' }[] = [];
  const seenPaths = new Set<string>();

  for (const file of testFiles) {
    if (!file || typeof file !== 'object') {
      throw new Error('TEST_PROTECTION_INVALID_FILE: Test file entry must be an object');
    }

    let filePath: unknown;
    let fileContent: unknown;
    try {
      filePath = (file as { path?: unknown }).path;
      fileContent = (file as { content?: unknown }).content;
    } catch {
      throw new Error('TEST_PROTECTION_ACCESSOR_ERROR: Failed to read test file property');
    }

    if (
      typeof filePath !== 'string' ||
      !isCanonicalRelativePath(filePath) ||
      isProtectedPath(filePath)
    ) {
      throw new Error(
        `TEST_PROTECTION_INVALID_PATH: Invalid test file path '${typeof filePath === 'string' ? filePath : ''}'`
      );
    }
    const canonicalPath = String(filePath);
    const lower = canonicalPath.toLowerCase();
    if (seenPaths.has(lower)) {
      throw new Error(`TEST_PROTECTION_DUPLICATE_PATH: Duplicate test file path '${canonicalPath}'`);
    }
    seenPaths.add(lower);

    if (fileContent === undefined || fileContent === null) {
      throw new Error(`TEST_PROTECTION_INVALID_CONTENT: Missing test content for '${canonicalPath}'`);
    }

    let rawBytes: Buffer;
    let tag: 'text' | 'binary';

    if (typeof fileContent === 'string') {
      rawBytes = Buffer.from(fileContent, 'utf8');
      tag = 'text';
    } else if (fileContent instanceof Uint8Array || Buffer.isBuffer(fileContent)) {
      rawBytes = Buffer.from(
        fileContent.buffer,
        fileContent.byteOffset,
        fileContent.byteLength
      );
      tag = 'binary';
    } else {
      throw new Error(
        `TEST_PROTECTION_INVALID_CONTENT: Content for '${canonicalPath}' must be string or Uint8Array`
      );
    }

    extractedFiles.push({
      path: canonicalPath,
      rawBytes,
      tag,
    });
  }

  const sorted = extractedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries: {
    readonly path: string;
    readonly byteLength: number;
    readonly tag: 'text' | 'binary';
    readonly contentDigest: string;
  }[] = [];

  for (const item of sorted) {
    const contentHashHex = createHash('sha256').update(item.rawBytes).digest('hex');
    const contentDigest = `sha256:${contentHashHex}`;

    entries.push({
      path: item.path,
      byteLength: item.rawBytes.length,
      tag: item.tag,
      contentDigest,
    });
  }

  return computeCanonicalSha256(entries);
}

export type HostSnapshotValidationResult =
  | {
      readonly ok: true;
      readonly testProtectionDigest: string;
      readonly detachedTestFiles: readonly TrustedTestFileSnapshot[];
      readonly reason?: undefined;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly testProtectionDigest?: undefined;
      readonly detachedTestFiles?: undefined;
    };

export function validateHostSnapshotFacts(
  rawSnapshot: unknown,
  expected: TrustedHostExpectedContext,
  requiredChecks: readonly CheckDefinition[]
): HostSnapshotValidationResult {
  if (!rawSnapshot || typeof rawSnapshot !== 'object') {
    return {
      ok: false,
      reason: 'Trusted host authority returned an invalid snapshot',
    };
  }

  let snapshotTaskId: unknown;
  let snapshotWorkspaceId: unknown;
  let snapshotRepositoryId: unknown;
  let rawRevision: unknown;
  let rawSnapshotCheckSetDigest: unknown;
  let rawSnapshotExpectedTestFiles: unknown;
  let rawTestFiles: unknown;
  try {
    const snapshot = rawSnapshot as Record<string, unknown>;
    const keys = Reflect.ownKeys(snapshot);
    if (!keys.includes('checkSetDigest')) {
      return { ok: false, reason: 'Trusted host snapshot check-set binding is required' };
    }
    if (!keys.includes('expectedTestFiles')) {
      return { ok: false, reason: 'Trusted host snapshot complete inventory binding is required' };
    }
    if (
      !keys.includes('taskId') ||
      !keys.includes('workspaceId') ||
      !keys.includes('repositoryId') ||
      !keys.includes('currentRevision') ||
      !keys.includes('testFiles')
    ) {
      return { ok: false, reason: 'Trusted host snapshot is missing a required context binding' };
    }
    snapshotTaskId = snapshot.taskId;
    snapshotWorkspaceId = snapshot.workspaceId;
    snapshotRepositoryId = snapshot.repositoryId;
    rawRevision = snapshot.currentRevision;
    rawSnapshotCheckSetDigest = snapshot.checkSetDigest;
    rawSnapshotExpectedTestFiles = snapshot.expectedTestFiles;
    rawTestFiles = snapshot.testFiles;
  } catch {
    return {
      ok: false,
      reason: 'Trusted host snapshot access failed during extraction',
    };
  }

  if (
    snapshotTaskId !== expected.taskId ||
    snapshotWorkspaceId !== expected.workspaceId ||
    snapshotRepositoryId !== expected.repositoryId
  ) {
    return {
      ok: false,
      reason: 'Trusted host snapshot task, workspace, or repository binding mismatch',
    };
  }

  if (
    typeof rawRevision !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(rawRevision) ||
    rawRevision !== expected.revisionDigest
  ) {
    return {
      ok: false,
      reason: `Host repository revision drift detected: Trusted host snapshot revision binding mismatch: expected '${expected.revisionDigest}', observed '${typeof rawRevision === 'string' ? rawRevision : String(rawRevision)}'`,
    };
  }

  if (
    typeof rawSnapshotCheckSetDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(rawSnapshotCheckSetDigest) ||
    rawSnapshotCheckSetDigest !== expected.checkSetDigest
  ) {
    return { ok: false, reason: 'Trusted host snapshot check-set binding mismatch' };
  }

  const snapshotExpectedPathSet = new Set<string>();
  let snapshotExpectedTestFileCount = 0;
  try {
    if (!Array.isArray(rawSnapshotExpectedTestFiles)) {
      return { ok: false, reason: 'Trusted host snapshot complete inventory is invalid' };
    }
    snapshotExpectedTestFileCount = rawSnapshotExpectedTestFiles.length;
    if (!Number.isSafeInteger(snapshotExpectedTestFileCount) || snapshotExpectedTestFileCount === 0) {
      return { ok: false, reason: 'Trusted host snapshot complete inventory is invalid' };
    }
    for (let i = 0; i < snapshotExpectedTestFileCount; i++) {
      const filePath = rawSnapshotExpectedTestFiles[i];
      if (typeof filePath !== 'string' || !isCanonicalRelativePath(filePath) || isProtectedPath(filePath)) {
        return { ok: false, reason: 'Trusted host snapshot complete inventory contains an invalid path' };
      }
      const key = filePath.toLowerCase();
      if (snapshotExpectedPathSet.has(key)) {
        return { ok: false, reason: 'Trusted host snapshot complete inventory contains a duplicate path' };
      }
      snapshotExpectedPathSet.add(key);
    }
  } catch {
    return {
      ok: false,
      reason: 'Trusted host snapshot inventory access failed during extraction',
    };
  }

  if (
    snapshotExpectedTestFileCount !== expected.expectedTestFiles.length ||
    expected.expectedTestFiles.some((filePath) => !snapshotExpectedPathSet.has(filePath.toLowerCase()))
  ) {
    return {
      ok: false,
      reason: 'Trusted host snapshot inventory does not match trusted expected context',
    };
  }

  const detachedTestFiles: TrustedTestFileSnapshot[] = [];
  const authorityPathSet = new Set<string>();
  let testFileCount = 0;

  try {
    if (!Array.isArray(rawTestFiles)) {
      return { ok: false, reason: 'Trusted host test file inventory is invalid' };
    }
    testFileCount = rawTestFiles.length;
    if (!Number.isSafeInteger(testFileCount) || testFileCount === 0) {
      return { ok: false, reason: 'Trusted host test file inventory is invalid' };
    }
    for (let i = 0; i < testFileCount; i++) {
      const file = rawTestFiles[i];
      if (!file || typeof file !== 'object') {
        return { ok: false, reason: 'Trusted host test file entry is invalid' };
      }

      let filePath: unknown;
      let fileContent: unknown;
      try {
        const entry = file as Record<string, unknown>;
        const entryKeys = Reflect.ownKeys(entry);
        if (!entryKeys.includes('path') || !entryKeys.includes('content')) {
          return { ok: false, reason: 'Trusted host test file entry is incomplete' };
        }
        filePath = entry.path;
        fileContent = entry.content;
      } catch {
        return { ok: false, reason: 'Trusted host test file access failed during extraction' };
      }

      if (
        typeof filePath !== 'string' ||
        !isCanonicalRelativePath(filePath) ||
        isProtectedPath(filePath)
      ) {
        return {
          ok: false,
          reason: 'Trusted host test file path is invalid',
        };
      }

      const pathKey = filePath.toLowerCase();
      if (authorityPathSet.has(pathKey)) {
        return { ok: false, reason: 'Trusted host test file inventory contains a duplicate path' };
      }
      authorityPathSet.add(pathKey);

      if (fileContent === undefined || fileContent === null) {
        return { ok: false, reason: 'Trusted host test file content is missing' };
      }

      let detachedContent: string | Uint8Array;
      if (typeof fileContent === 'string') {
        detachedContent = fileContent;
      } else if (fileContent instanceof Uint8Array || Buffer.isBuffer(fileContent)) {
        const byteLength = fileContent.byteLength;
        const byteOffset = fileContent.byteOffset;
        const backingBuffer = fileContent.buffer;
        const copy = new Uint8Array(byteLength);
        copy.set(new Uint8Array(backingBuffer, byteOffset, byteLength));
        detachedContent = copy;
      } else {
        return { ok: false, reason: 'Trusted host test file content must be text or raw bytes' };
      }

      detachedTestFiles.push(
        Object.freeze({
          path: filePath,
          content: detachedContent,
        })
      );
    }
  } catch {
    return {
      ok: false,
      reason: 'Trusted host test file inventory access failed during extraction',
    };
  }

  if (expected.expectedTestFiles.length !== detachedTestFiles.length) {
    return {
      ok: false,
      reason: 'Trusted host measured test inventory count mismatch with expected context',
    };
  }

  for (const ep of expected.expectedTestFiles) {
    if (!authorityPathSet.has(ep.toLowerCase())) {
      return {
        ok: false,
        reason: 'Trusted host measured test inventory is incomplete',
      };
    }
  }

  for (const check of requiredChecks) {
    const invocation = resolvePytestInvocation(check);
    if (!invocation) continue;

    const argv = check.argv ?? [];
    for (let i = invocation.argStart; i < argv.length; i++) {
      let arg = argv[i];
      if (typeof arg !== 'string') continue;

      if (arg === '--deselect') {
        arg = argv[++i] ?? '';
      } else if (PYTEST_OPTIONS_WITH_ARG.has(arg)) {
        i++; // skip option argument value
        continue;
      } else if (arg.startsWith('-') && !arg.startsWith('--test-file=') && !arg.startsWith('--deselect=')) {
        continue;
      }

      // Positional arguments and explicit selectors must be valid and trusted.
      const parsed = normalizePytestSelector(arg);
      if (!parsed) {
        return {
          ok: false,
          reason: `Invalid or untrusted test selector in required check: '${arg}'`,
        };
      }
    }

    const selectors = extractCheckTestSelectors(check);
    for (const sel of selectors) {
      if (sel.isDirectory) {
        const prefix = sel.filePath.endsWith('/')
          ? sel.filePath.toLowerCase()
          : `${sel.filePath.toLowerCase()}/`;
        let dirHasFiles = false;
        for (const path of authorityPathSet) {
          if (path.startsWith(prefix)) {
            dirHasFiles = true;
            break;
          }
        }
        if (!dirHasFiles) {
          return {
            ok: false,
            reason: `Trusted host measured test inventory omits a test referenced by directory selector: '${sel.filePath}'`,
          };
        }
      } else {
        if (!authorityPathSet.has(sel.filePath.toLowerCase())) {
          return {
            ok: false,
            reason: `Trusted host measured test inventory omits a test referenced by the check set: '${sel.filePath}'`,
          };
        }
      }
    }
  }

  let testProtectionDigest: string;
  try {
    testProtectionDigest = computeTestProtectionDigest(detachedTestFiles);
  } catch {
    return {
      ok: false,
      reason: 'Trusted host test protection facts could not be digested',
    };
  }

  return {
    ok: true,
    testProtectionDigest,
    detachedTestFiles: Object.freeze(detachedTestFiles),
  };
}

/**
 * Investigates the reported bug by running reproduction checks under isolation.
 *
 * Distinguishes localized reproduced failures, non-reproducing defects,
 * and test collection/syntax errors. Persists pre-edit reproduction evidence
 * and computes baseline digests without executing raw unverified shell commands.
 */
