/**
 * UC-03 Verified Code Repair - Investigation, Baseline & Plan Preparation
 *
 * Owned path: src/uc03/investigation.ts
 * Feature: specs/001-verified-code-repair
 * Task: T013 (adaptive baseline investigation & fix-plan approval preparation)
 *
 * Requirements:
 * - FR-002: Persist pre-edit reproduction baseline and previously passing checks;
 *   distinguish expected bug failure, non-reproduction, and test collection errors.
 * - FR-003: Permit adaptive investigation inside harness stage gates; record diagnosis
 *   and strategy in a validated FixPlan before requesting human approval.
 * - Enforces zero production code edits before plan approval.
 * - Approval pending pauses at AwaitPlan; rejection transitions to AwaitFeedback.
 */

import { createHash } from 'node:crypto';
import {
  computeCanonicalSha256,
  computeCheckSetDigest,
  isCanonicalRelativePath,
  isProtectedPath,
  validateBugTask,
  validateCheckDefinition,
  validateBaselineAdmission,
  validateTaskState,
  validateFixPlan,
  validateStateTransition,
  validateApprovalBinding,
  parseApprovalBinding,
  type BugTask,
  type TaskState,
  type Baseline,
  type FixPlan,
  type ApprovalBinding,
  type ApprovalBindingContext,
  type ApproveFixPlanAction,
  type CheckDefinition,
  type CheckResult,
  type RepositoryPort,
  type RepositoryPortV02,
  type StatePort,
  type StatePortV02,
  type ExecutionGuardV02,
  type RepositoryAdmissionContextV02,
  type ApprovalPort,
  type ModelPort,
} from '../contracts/foundation/uc03.ts';
import { validateRepositoryAdmissionV02 as validateRepositoryAdmissionRecordV02 } from '../contracts/foundation/uc03/admission-v02/repository.ts';
import {
  extractCheckTestSelectors,
  resolvePytestInvocation,
  normalizePytestSelector,
  PYTEST_OPTIONS_WITH_ARG,
} from './selectors.ts';

export interface TrustedTestFileSnapshot {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface TrustedHostSnapshotRequest {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly expectedRevisionDigest: string;
  readonly expectedCriteriaDigest: string;
  readonly expectedCheckSetDigest: string;
  readonly expectedTestFiles: readonly string[];
}

/**
 * Host composition supplies facts it measured or derived from canonical
 * repository state, trusted check configuration, and the complete test
 * inventory. The consumer trusts this input boundary; T013 does not implement
 * or prove production measurement.
 */
export interface TrustedHostExpectedContext {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly revisionDigest: string;
  readonly criteriaDigest: string;
  readonly checkSetDigest: string;
  readonly expectedTestFiles: readonly string[];
  readonly admissionContext?: RepositoryAdmissionContextV02 | undefined;
  readonly executionGuard?: ExecutionGuardV02 | undefined;
  readonly statePort?: StatePortV02 | undefined;
}

/** Snapshot claims from the producer; each binding is checked against injected admission facts. */
export interface TrustedHostSnapshot {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly currentRevision: string;
  readonly checkSetDigest: string;
  readonly testFiles: readonly TrustedTestFileSnapshot[];
  readonly expectedTestFiles: readonly string[];
}

export interface TrustedHostPort {
  /** Returns producer claims; it cannot set admission facts or provide durable baseline/CAS guarantees. */
  loadSnapshot(
    request: TrustedHostSnapshotRequest
  ): Promise<TrustedHostSnapshot> | TrustedHostSnapshot;
}

export type TrustedInvestigationHostAuthority = TrustedHostPort;

export type BaselineStatus =
  | 'reproduced'
  | 'non-reproducing'
  | 'collection-error'
  | 'error';

export interface BaselineEvidenceCandidate extends Omit<Baseline, 'evidenceId'> {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly acceptanceCriteria: readonly string[];
  readonly criteriaDigest: string;
  readonly requiredChecks: BugTask['requiredChecks'];
  readonly expectedPassingCheckIds: readonly string[];
  readonly reproductionCheckId: string;
  readonly expectedTestFiles: readonly string[];
}

export interface BaselineEvidenceWriteRequest {
  readonly content: BaselineEvidenceCandidate;
  readonly contentDigest: string;
}

export interface BaselineEvidenceAcknowledgement {
  readonly evidenceId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly contentDigest: string;
  readonly repositorySnapshotDigest: string;
  readonly criteriaDigest: string;
  readonly checkSetDigest: string;
  readonly testProtectionDigest: string;
  readonly reproductionCheckId: string;
  readonly expectedPassingCheckIds: readonly string[];
  readonly expectedTestFiles: readonly string[];
  readonly requiredCheckIds: readonly string[];
}

/** Local UC-04 consumer contract; the host adapter owns durable storage and evidence identity. */
export interface BaselineEvidenceWriter {
  persistBaselineEvidence(
    request: BaselineEvidenceWriteRequest
  ): Promise<BaselineEvidenceAcknowledgement>;
}

export interface BaselineInvestigationResult {
  readonly status: BaselineStatus;
  readonly baseline?: BaselineEvidenceCandidate | undefined;
  readonly reproductionSignature?: string | undefined;
  readonly reason?: string | undefined;
}

export type PlanApprovalStatus = 'approved' | 'pending' | 'rejected';

export interface PlanPreparationResult {
  readonly outcome: PlanApprovalStatus;
  readonly plan?: FixPlan | undefined;
  readonly binding?: ApprovalBinding | undefined;
  readonly state?: TaskState | undefined;
  readonly reason?: string | undefined;
}

export interface InvestigationConfigPort {
  readonly provenance?: string | undefined;
  loadConfig?(
    taskId: string
  ):
    | Promise<{ readonly configId?: string; readonly configVersion?: string } | null>
    | { readonly configId?: string; readonly configVersion?: string }
    | null;
}

export interface InvestigationPorts {
  readonly repository: RepositoryPort;
  readonly state: StatePort;
  readonly approval: ApprovalPort;
  readonly baselineEvidenceWriter?: BaselineEvidenceWriter | undefined;
  readonly model?: ModelPort | undefined;
  readonly host?: TrustedHostPort | undefined;
  readonly config?: InvestigationConfigPort | undefined;
}

const COLLECTION_ERROR_PATTERN =
  /syntaxerror|collectionerror|collection error|failed to collect|import error|importerror|modulenotfounderror/i;

function isCollectionOrSyntaxError(outputExcerpt?: string): boolean {
  if (!outputExcerpt) return false;
  return COLLECTION_ERROR_PATTERN.test(outputExcerpt);
}

function baselineEvidenceAcknowledgementMatches(
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
export function investigateBaseline(
  task: BugTask,
  repository: RepositoryPort | RepositoryPortV02
): Promise<BaselineInvestigationResult>;
export function investigateBaseline(
  task: BugTask,
  repository: RepositoryPort | RepositoryPortV02,
  hostAuthority: TrustedHostPort,
  trustedExpectedContext: TrustedHostExpectedContext
): Promise<BaselineInvestigationResult>;
export async function investigateBaseline(
  task: BugTask,
  repository: RepositoryPort | RepositoryPortV02,
  hostAuthority?: TrustedHostPort,
  trustedExpectedContext?: TrustedHostExpectedContext
): Promise<BaselineInvestigationResult> {
  const taskValidation = validateBugTask(task);
  if (!taskValidation.ok) {
    return {
      status: 'error',
      reason: `BugTask validation failed: ${taskValidation.errors.map((e) => e.message).join(', ')}`,
    };
  }
  const validTask = taskValidation.value;

  // Detach every task fact used after a host or test await.
  const taskId = validTask.taskId;
  const repositoryId = validTask.repositoryId;
  const taskRevisionDigest = validTask.initialRevisionDigest;
  const requiredChecks = validTask.requiredChecks.map((check) =>
    Object.freeze({ ...check, argv: Object.freeze([...check.argv]) })
  );
  const checkSetDigest = computeCheckSetDigest(requiredChecks);
  const criteriaDigest = computeCanonicalSha256(validTask.acceptanceCriteria);

  const reproductionChecks = requiredChecks.filter((check) => check.purpose === 'reproduction');
  const reproductionCheck = reproductionChecks[0];

  if (!reproductionCheck) {
    return {
      status: 'error',
      reason: 'No reproduction check found with explicit purpose reproduction in requiredChecks',
    };
  }
  if (reproductionChecks.length !== 1) {
    return {
      status: 'error',
      reason: 'Exactly one check may have explicit purpose reproduction in requiredChecks',
    };
  }

  const checkValidation = validateCheckDefinition(reproductionCheck, 'reproductionCheck', []);
  if (!checkValidation) {
    return {
      status: 'error',
      reason: 'Reproduction check definition failed validation',
    };
  }

  // Trusted host snapshot authority is strictly REQUIRED. Fail closed before ANY test execution.
  const rawExpectedContext: unknown = trustedExpectedContext;
  if (!hostAuthority) {
    return {
      status: 'error',
      reason: 'Missing trusted host authority: explicit TrustedHostPort with loadSnapshot is required',
    };
  }

  if (!rawExpectedContext || typeof rawExpectedContext !== 'object') {
    return {
      status: 'error',
      reason: 'Missing separate trusted admission context for task, workspace, repository, checks, and inventory',
    };
  }

  let contextTaskId: unknown;
  let contextWorkspaceId: unknown;
  let contextRepositoryId: unknown;
  let contextRevisionDigest: unknown;
  let contextCriteriaDigest: unknown;
  let contextCheckSetDigest: unknown;
  let rawContextTestFiles: unknown;
  try {
    const context = rawExpectedContext as Record<string, unknown>;
    const keys = Reflect.ownKeys(context);
    if (
      !keys.includes('taskId') ||
      !keys.includes('workspaceId') ||
      !keys.includes('repositoryId') ||
      !keys.includes('revisionDigest') ||
      !keys.includes('criteriaDigest') ||
      !keys.includes('checkSetDigest') ||
      !keys.includes('expectedTestFiles')
    ) {
      return {
        status: 'error',
        reason: 'Trusted expected context is missing a required binding',
      };
    }
    contextTaskId = context.taskId;
    contextWorkspaceId = context.workspaceId;
    contextRepositoryId = context.repositoryId;
    contextRevisionDigest = context.revisionDigest;
    contextCriteriaDigest = context.criteriaDigest;
    contextCheckSetDigest = context.checkSetDigest;
    rawContextTestFiles = context.expectedTestFiles;
  } catch {
    return {
      status: 'error',
      reason: 'Trusted expected context access failed during extraction',
    };
  }

  if (
    typeof contextTaskId !== 'string' ||
    contextTaskId !== taskId ||
    typeof contextWorkspaceId !== 'string' ||
    contextWorkspaceId.length === 0 ||
    typeof contextRepositoryId !== 'string' ||
    contextRepositoryId !== repositoryId ||
    typeof contextRevisionDigest !== 'string' ||
    contextRevisionDigest !== taskRevisionDigest ||
    typeof contextCriteriaDigest !== 'string' ||
    contextCriteriaDigest !== criteriaDigest ||
    typeof contextCheckSetDigest !== 'string' ||
    contextCheckSetDigest !== checkSetDigest
  ) {
    return {
      status: 'error',
      reason: 'Trusted expected context does not match the current task, workspace, repository, revision, or check set',
    };
  }

  const expectedTaskId = contextTaskId;
  const expectedWorkspaceId = contextWorkspaceId;
  const expectedRepositoryId = contextRepositoryId;
  const expectedRevisionDigest = contextRevisionDigest;
  const expectedCriteriaDigest = contextCriteriaDigest;
  const expectedCheckSetDigest = contextCheckSetDigest;
  const detachedExpectedTestFiles: string[] = [];
  const expectedPathSet = new Set<string>();
  let contextTestFileCount = 0;
  try {
    if (!Array.isArray(rawContextTestFiles)) {
      return { status: 'error', reason: 'Trusted expected test inventory must be a non-empty array' };
    }
    contextTestFileCount = rawContextTestFiles.length;
    if (!Number.isSafeInteger(contextTestFileCount) || contextTestFileCount === 0) {
      return { status: 'error', reason: 'Trusted expected test inventory must be a non-empty array' };
    }
    for (let i = 0; i < contextTestFileCount; i++) {
      const filePath = rawContextTestFiles[i];
      if (typeof filePath !== 'string' || !isCanonicalRelativePath(filePath) || isProtectedPath(filePath)) {
        return { status: 'error', reason: 'Trusted expected test inventory contains an invalid path' };
      }
      const key = filePath.toLowerCase();
      if (expectedPathSet.has(key)) {
        return { status: 'error', reason: 'Trusted expected test inventory contains a duplicate path' };
      }
      expectedPathSet.add(key);
      detachedExpectedTestFiles.push(filePath);
    }
  } catch {
    return {
      status: 'error',
      reason: 'Trusted expected test inventory access failed during extraction',
    };
  }
  Object.freeze(detachedExpectedTestFiles);

  // Detach trusted admission facts before interacting with the producer object.
  let loadSnapshotFn: unknown;
  try {
    loadSnapshotFn = hostAuthority.loadSnapshot;
  } catch {
    return {
      status: 'error',
      reason: 'Trusted host snapshot producer access failed while reading its loader',
    };
  }
  if (typeof loadSnapshotFn !== 'function') {
    return {
      status: 'error',
      reason: 'Missing trusted host authority: explicit TrustedHostPort with loadSnapshot is required',
    };
  }

  const request: TrustedHostSnapshotRequest = Object.freeze({
    taskId: expectedTaskId,
    workspaceId: expectedWorkspaceId,
    repositoryId: expectedRepositoryId,
    expectedRevisionDigest: expectedRevisionDigest,
    expectedCriteriaDigest: expectedCriteriaDigest,
    expectedCheckSetDigest: expectedCheckSetDigest,
    expectedTestFiles: detachedExpectedTestFiles,
  });

  let rawSnapshot: unknown;
  try {
    rawSnapshot = await (
      loadSnapshotFn as (request: TrustedHostSnapshotRequest) => Promise<unknown> | unknown
    ).call(hostAuthority, request);
  } catch {
    return {
      status: 'error',
      reason: 'Trusted host snapshot loading failed',
    };
  }

  const snapshotValidation = validateHostSnapshotFacts(
    rawSnapshot,
    {
      taskId: expectedTaskId,
      workspaceId: expectedWorkspaceId,
      repositoryId: expectedRepositoryId,
      revisionDigest: expectedRevisionDigest,
      criteriaDigest: expectedCriteriaDigest,
      checkSetDigest: expectedCheckSetDigest,
      expectedTestFiles: detachedExpectedTestFiles,
    },
    requiredChecks
  );
  if (!snapshotValidation.ok) {
    return {
      status: 'error',
      reason: snapshotValidation.reason,
    };
  }
  const testProtectionDigest = snapshotValidation.testProtectionDigest;

  // Check if v0.2 guarded atomic admission is active
  const contextAdmission = (rawExpectedContext as Record<string, unknown> | undefined)?.admissionContext;
  const rawStatePort = (rawExpectedContext as Record<string, unknown> | undefined)?.statePort ??
    (repository as { statePort?: unknown })?.statePort;
  const isV02 = Boolean(
    contextAdmission !== undefined ||
    (rawExpectedContext as Record<string, unknown> | undefined)?.executionGuard !== undefined ||
    (rawStatePort !== undefined && (repository as { executionGuardApiVersion?: string })?.executionGuardApiVersion === '0.2.0')
  );

  let admission: RepositoryAdmissionContextV02 | undefined;
  if (isV02) {
    if (!contextAdmission || typeof contextAdmission !== 'object') {
      return {
        status: 'error',
        reason: 'ADMISSION_DENIED: Missing or malformed admission context',
      };
    }
    const valAdmission = validateRepositoryAdmissionRecordV02(contextAdmission as RepositoryAdmissionContextV02);
    if (!valAdmission.ok) {
      return {
        status: 'error',
        reason: `ADMISSION_DENIED: ${valAdmission.errors.map((e) => e.message).join('; ')}`,
      };
    }
    admission = valAdmission.value;

    if (
      admission.planApplicability !== 'pre-plan-diagnostic' ||
      admission.runnableNode !== 'Investigate' ||
      admission.planDecisionRef !== undefined ||
      admission.planBindingDigest !== undefined ||
      admission.taskCriteriaDigest !== criteriaDigest ||
      admission.checkSetDigest !== checkSetDigest ||
      admission.taskId !== expectedTaskId ||
      admission.canonicalRevision !== expectedRevisionDigest
    ) {
      return {
        status: 'error',
        reason: 'ADMISSION_DENIED: Baseline pre-plan diagnostic admission mismatch',
      };
    }

    if (rawStatePort && typeof rawStatePort === 'object') {
      const journal = rawStatePort as Record<string, unknown>;
      if (typeof journal.getJournalSnapshot === 'function') {
        const snap = (journal.getJournalSnapshot as () => { mode?: string; activeClaimId?: string | null })() as {
          mode?: string;
          activeClaimId?: string | null;
        };
        if (snap?.mode && snap.mode !== 'runnable') {
          return {
            status: 'error',
            reason: 'TASK_PAUSED: Task is paused',
          };
        }
        if (snap?.activeClaimId !== null && snap?.activeClaimId !== undefined) {
          return {
            status: 'error',
            reason: 'CLAIM_ACTIVE: Task has an active open claim',
          };
        }
      }
      if (typeof journal.loadTask === 'function') {
        try {
          const loaded = await (journal.loadTask as (id: string) => Promise<TaskState | null>)(expectedTaskId);
          if (!loaded) {
            return { status: 'error', reason: 'STATE_UNAVAILABLE: Task not found' };
          }
          const loadedMode = (loaded as { mode?: string }).mode;
          if (loadedMode && loadedMode !== 'runnable') {
            return { status: 'error', reason: 'TASK_PAUSED: Task is paused' };
          }
          if (loaded.repositoryRevisionDigest !== expectedRevisionDigest) {
            return { status: 'error', reason: 'REVISION_DRIFT: Authoritative repository revision has drifted' };
          }
        } catch {
          return { status: 'error', reason: 'STATE_UNAVAILABLE: Authoritative task state unavailable' };
        }
      }
    }
  }

  // Run every explicitly required check once, even when one result fails or throws.
  const checkResults: CheckResult[] = [];
  for (const check of requiredChecks) {
    try {
      let rawResult: unknown;
      if (isV02 && admission) {
        const checkCtx: RepositoryAdmissionContextV02 = check.checkId === admission.checkId
          ? admission
          : {
              ...admission,
              checkId: check.checkId,
              action: {
                actionId: check.checkId,
                kind: 'run_command',
                executable: check.executable,
                argv: [...check.argv],
                workingDirectory: check.workingDirectory ?? 'tests',
                purpose: check.purpose,
              },
              actionDigest: computeCanonicalSha256({
                actionId: check.checkId,
                kind: 'run_command',
                executable: check.executable,
                argv: [...check.argv],
                workingDirectory: check.workingDirectory ?? 'tests',
                purpose: check.purpose,
              }),
            };
        rawResult = await (repository as RepositoryPortV02).runTests(check, checkCtx);
      } else {
        rawResult = await (repository as RepositoryPort).runTests(check);
      }
      if (!rawResult || typeof rawResult !== 'object') {
        checkResults.push({
          checkId: check.checkId,
          outcome: 'error',
          outputExcerpt: 'Required check returned an invalid result',
        });
        continue;
      }

      const result = rawResult as Record<string, unknown>;
      const resultCheckId = result.checkId;
      const resultOutcome = result.outcome;
      const resultOutput = result.outputExcerpt;
      const resultDuration = result.durationMs;
      if (
        resultCheckId !== check.checkId ||
        !['pass', 'fail', 'timeout', 'error', 'not-run'].includes(resultOutcome as string)
      ) {
        checkResults.push({
          checkId: check.checkId,
          outcome: 'error',
          outputExcerpt: 'Required check returned a mismatched identity or invalid outcome',
        });
        continue;
      }

      checkResults.push({
        checkId: check.checkId,
        outcome: resultOutcome as CheckResult['outcome'],
        ...(typeof resultOutput === 'string' ? { outputExcerpt: resultOutput } : {}),
        ...(typeof resultDuration === 'number' && Number.isFinite(resultDuration)
          ? { durationMs: resultDuration }
          : {}),
      });
    } catch (err: unknown) {
      checkResults.push({
        checkId: check.checkId,
        outcome: 'error',
        outputExcerpt: `Required check execution threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (isV02) {
    const repoAny = repository as { currentRevisionDigest?: string };
    if (repoAny.currentRevisionDigest && repoAny.currentRevisionDigest !== expectedRevisionDigest) {
      return {
        status: 'error',
        reason: 'REVISION_DRIFT: Repository mutated during investigation',
      };
    }
  }

  const reproductionCheckId = reproductionCheck.checkId;
  const reproResult = checkResults.find((result) => result.checkId === reproductionCheckId);
  if (!reproResult) {
    return { status: 'error', reason: 'The required reproduction check result is missing' };
  }

  const expectedCheckIds = requiredChecks.map((check) => check.checkId);
  if (
    checkResults.length !== expectedCheckIds.length ||
    checkResults.some((result, index) => result.checkId !== expectedCheckIds[index])
  ) {
    return { status: 'error', reason: 'Required check results do not match the exact required check set' };
  }

  const expectedPassingChecks = requiredChecks.filter((check) => check.checkId !== reproductionCheckId);
  const expectedPassingCheckIds = expectedPassingChecks.map((check) => check.checkId);

  if (reproResult.outcome === 'pass') {
    const failedPreviouslyPassingCheck = expectedPassingChecks.find((check) =>
      checkResults.find((result) => result.checkId === check.checkId)?.outcome !== 'pass'
    );
    if (failedPreviouslyPassingCheck) {
      return {
        status: 'error',
        reason: `Required ${failedPreviouslyPassingCheck.purpose} check '${failedPreviouslyPassingCheck.checkId}' did not pass`,
      };
    }
    return {
      status: 'non-reproducing',
      reason: reproResult.outputExcerpt ?? 'Reproduction check passed; reported defect did not reproduce',
    };
  }

  if (reproResult.outcome === 'error' || isCollectionOrSyntaxError(reproResult.outputExcerpt)) {
    if (isCollectionOrSyntaxError(reproResult.outputExcerpt)) {
      return {
        status: 'collection-error',
        reproductionSignature: reproResult.outputExcerpt,
        reason: reproResult.outputExcerpt ?? 'Test collection or syntax error encountered during reproduction',
      };
    }
    return {
      status: 'error',
      reason: reproResult.outputExcerpt ?? 'Reproduction check encountered error',
    };
  }

  if (reproResult.outcome !== 'fail') {
    return {
      status: 'error',
      reason: `Reproduction check must fail; got '${reproResult.outcome}'`,
    };
  }

  const reproductionFailureSignature = reproResult.outputExcerpt ?? 'reproduction-failure';
  const candidateFields = {
    repositorySnapshotDigest: expectedRevisionDigest,
    checkSetDigest,
    reproductionFailureSignature,
    checkResults,
    testProtectionDigest,
  };
  const admissionBaseline: Baseline = {
    evidenceId: 'pending-baseline-evidence',
    ...candidateFields,
  };
  const baselineValidation = validateBaselineAdmission(admissionBaseline, {
    expectedEvidenceId: 'pending-baseline-evidence',
    expectedRepositorySnapshotDigest: expectedRevisionDigest,
    expectedCheckSetDigest,
    expectedTestProtectionDigest: testProtectionDigest,
    expectedReproductionCheckId: reproductionCheckId,
    expectedPassingCheckIds,
  });
  if (!baselineValidation.ok) {
    return {
      status: 'error',
      reason: `Baseline admission failed: ${baselineValidation.errors.map((e) => e.message).join(', ')}`,
    };
  }

  const baselineCandidate: BaselineEvidenceCandidate = {
    taskId: expectedTaskId,
    workspaceId: expectedWorkspaceId,
    repositoryId: expectedRepositoryId,
    acceptanceCriteria: Object.freeze([...validTask.acceptanceCriteria]),
    criteriaDigest: expectedCriteriaDigest,
    requiredChecks: Object.freeze(requiredChecks),
    expectedPassingCheckIds: Object.freeze(expectedPassingCheckIds),
    reproductionCheckId,
    expectedTestFiles: Object.freeze([...detachedExpectedTestFiles]),
    ...candidateFields,
  };

  return {
    status: 'reproduced',
    baseline: baselineCandidate,
    reproductionSignature: reproductionFailureSignature,
  };
}

function validateBaselineEvidenceCandidate(
  input: unknown,
  state: TaskState
):
  | { readonly ok: true; readonly candidate: BaselineEvidenceCandidate; readonly baseline: Baseline }
  | { readonly ok: false; readonly reason: string } {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, reason: 'Baseline evidence candidate must be an object' };
    }
    const candidateKeys = [
      'taskId',
      'workspaceId',
      'repositoryId',
      'acceptanceCriteria',
      'criteriaDigest',
      'requiredChecks',
      'expectedPassingCheckIds',
      'reproductionCheckId',
      'expectedTestFiles',
      'repositorySnapshotDigest',
      'checkSetDigest',
      'reproductionFailureSignature',
      'checkResults',
      'testProtectionDigest',
    ].sort();
    const actualKeys = Reflect.ownKeys(input).map(String).sort();
    if (
      actualKeys.length !== candidateKeys.length ||
      actualKeys.some((key, index) => key !== candidateKeys[index])
    ) {
      return { ok: false, reason: 'Baseline evidence candidate fields are incomplete or unexpected' };
    }

    const candidate = structuredClone(input) as BaselineEvidenceCandidate;
    const taskResult = validateBugTask(state.taskContext);
    if (!taskResult.ok) {
      return { ok: false, reason: 'Task context is required to validate baseline evidence' };
    }
    const task = taskResult.value;
    const requiredChecks = task.requiredChecks;
    const requiredCheckIds = requiredChecks.map((check) => check.checkId);
    const reproductionChecks = requiredChecks.filter((check) => check.purpose === 'reproduction');
    if (reproductionChecks.length !== 1 || !reproductionChecks[0]) {
      return { ok: false, reason: 'Task context must contain exactly one reproduction check' };
    }
    const reproductionCheckId = reproductionChecks[0].checkId;
    const expectedPassingCheckIds = requiredChecks
      .filter((check) => check.checkId !== reproductionCheckId)
      .map((check) => check.checkId);
    const criteriaDigest = computeCanonicalSha256(state.acceptanceCriteria);
    const checkSetDigest = computeCheckSetDigest(requiredChecks);
    const testFiles = candidate.expectedTestFiles;
    const expectedPathSet = new Set<string>();

    if (
      candidate.taskId !== state.taskId ||
      candidate.workspaceId !== state.workspaceId ||
      candidate.repositoryId !== state.repositoryId ||
      candidate.repositoryId !== task.repositoryId ||
      candidate.repositorySnapshotDigest !== state.repositoryRevisionDigest ||
      candidate.repositorySnapshotDigest !== task.initialRevisionDigest ||
      computeCanonicalSha256(candidate.acceptanceCriteria) !== criteriaDigest ||
      criteriaDigest !== computeCanonicalSha256(task.acceptanceCriteria) ||
      candidate.criteriaDigest !== criteriaDigest ||
      computeCheckSetDigest(candidate.requiredChecks) !== checkSetDigest ||
      candidate.checkSetDigest !== checkSetDigest ||
      computeCanonicalSha256(state.requiredCheckIds) !== computeCanonicalSha256(requiredCheckIds) ||
      candidate.reproductionCheckId !== reproductionCheckId ||
      computeCanonicalSha256(candidate.expectedPassingCheckIds) !==
        computeCanonicalSha256(expectedPassingCheckIds)
    ) {
      return { ok: false, reason: 'Baseline candidate does not match accepted task, criteria, check set, or revision facts' };
    }

    if (
      !Array.isArray(testFiles) ||
      testFiles.length === 0 ||
      testFiles.some((filePath) =>
        typeof filePath !== 'string' || !isCanonicalRelativePath(filePath) || isProtectedPath(filePath)
      )
    ) {
      return { ok: false, reason: 'Baseline candidate has an invalid protected test inventory' };
    }
    for (const filePath of testFiles) {
      const key = filePath.toLowerCase();
      if (expectedPathSet.has(key)) {
        return { ok: false, reason: 'Baseline candidate has a duplicate protected test path' };
      }
      expectedPathSet.add(key);
    }

    if (
      !Array.isArray(candidate.checkResults) ||
      candidate.checkResults.length !== requiredCheckIds.length ||
      candidate.checkResults.some((result, index) => result.checkId !== requiredCheckIds[index])
    ) {
      return { ok: false, reason: 'Baseline results do not match the exact required check set' };
    }

    const provisionalBaseline: Baseline = {
      evidenceId: 'pending-baseline-evidence',
      repositorySnapshotDigest: candidate.repositorySnapshotDigest,
      checkSetDigest: candidate.checkSetDigest,
      reproductionFailureSignature: candidate.reproductionFailureSignature,
      checkResults: candidate.checkResults,
      testProtectionDigest: candidate.testProtectionDigest,
    };
    const admission = validateBaselineAdmission(provisionalBaseline, {
      expectedEvidenceId: 'pending-baseline-evidence',
      expectedRepositorySnapshotDigest: state.repositoryRevisionDigest,
      expectedCheckSetDigest: checkSetDigest,
      expectedTestProtectionDigest: candidate.testProtectionDigest,
      expectedReproductionCheckId: reproductionCheckId,
      expectedPassingCheckIds,
    });
    if (!admission.ok) {
      return {
        ok: false,
        reason: `Baseline admission failed: ${admission.errors.map((error) => error.message).join(', ')}`,
      };
    }

    return {
      ok: true,
      candidate: {
        taskId: state.taskId,
        workspaceId: state.workspaceId,
        repositoryId: state.repositoryId,
        acceptanceCriteria: [...state.acceptanceCriteria],
        criteriaDigest,
        requiredChecks: structuredClone(requiredChecks),
        expectedPassingCheckIds,
        reproductionCheckId,
        expectedTestFiles: [...testFiles],
        repositorySnapshotDigest: state.repositoryRevisionDigest,
        checkSetDigest,
        reproductionFailureSignature: admission.value.reproductionFailureSignature,
        checkResults: structuredClone(admission.value.checkResults),
        testProtectionDigest: admission.value.testProtectionDigest,
      },
      baseline: admission.value,
    };
  } catch {
    return { ok: false, reason: 'Baseline evidence candidate validation failed safely' };
  }
}

/**
 * Prepares fix plan, transitions and checkpoints state via StatePort,
 * and requests human plan approval via ApprovalPort.
 *
 * Ensures no production edits are performed prior to approval.
 * Transitions to AwaitPlan and pauses on pending approval; transitions
 * to AwaitFeedback on rejection with zero production modifications.
 */
export async function prepareFixPlanAndApproval(
  state: TaskState,
  baseline: BaselineEvidenceCandidate,
  ports: InvestigationPorts,
  planDetails?: Partial<FixPlan>
): Promise<PlanPreparationResult> {
  const stateValidation = validateTaskState(state);
  if (!stateValidation.ok) {
    return {
      outcome: 'rejected',
      reason: `TaskState validation failed: ${stateValidation.errors.map((e) => e.message).join(', ')}`,
    };
  }
  const validState = stateValidation.value;

  const baselineValidation = validateBaselineEvidenceCandidate(baseline, validState);
  if (!baselineValidation.ok) {
    return {
      outcome: 'rejected',
      reason: baselineValidation.reason,
    };
  }
  const validBaselineCandidate = baselineValidation.candidate;

  if (!ports?.repository || !ports.state || !ports.approval) {
    return {
      outcome: 'rejected',
      reason: 'Missing required ports: repository, state, and approval are mandatory',
    };
  }

  if (validState.node !== 'Investigate') {
    return {
      outcome: 'rejected',
      reason: `Invalid starting node: expected 'Investigate', got '${validState.node}'`,
    };
  }

  const planVersion = planDetails?.planVersion ?? validState.planVersion ?? 1;

  const diagnosis = planDetails?.diagnosis;
  if (!diagnosis || diagnosis.trim().length === 0) {
    return {
      outcome: 'rejected',
      reason: 'Missing actual diagnosis: diagnosis must be explicitly provided in planDetails',
    };
  }

  const strategy = planDetails?.strategy;
  if (!strategy || strategy.trim().length === 0) {
    return {
      outcome: 'rejected',
      reason: 'Missing actual strategy: strategy must be explicitly provided in planDetails',
    };
  }

  const strategyDigest = computeCanonicalSha256(strategy);
  const decisionId = planDetails?.decisionRef ?? `dec-plan-${validState.taskId}-${planVersion}`;

  const suspectedCauseLocations = planDetails?.suspectedCauseLocations;
  if (
    !suspectedCauseLocations ||
    !Array.isArray(suspectedCauseLocations) ||
    suspectedCauseLocations.length === 0
  ) {
    return {
      outcome: 'rejected',
      reason: 'Missing suspected cause locations: suspectedCauseLocations must be explicitly provided in planDetails',
    };
  }

  for (const loc of suspectedCauseLocations) {
    if (
      typeof loc !== 'string' ||
      !isCanonicalRelativePath(loc) ||
      isProtectedPath(loc)
    ) {
      return {
        outcome: 'rejected',
        reason: `Invalid suspected cause location: '${loc}' is not a valid canonical relative path or is protected`,
      };
    }
  }

  const scopedChanges = planDetails?.scopedChanges;
  if (
    !scopedChanges ||
    !Array.isArray(scopedChanges) ||
    scopedChanges.length === 0
  ) {
    return {
      outcome: 'rejected',
      reason: 'Missing scoped changes: scopedChanges must be explicitly provided in planDetails',
    };
  }

  for (const chg of scopedChanges) {
    if (
      typeof chg !== 'string' ||
      !isCanonicalRelativePath(chg) ||
      isProtectedPath(chg)
    ) {
      return {
        outcome: 'rejected',
        reason: `Invalid scoped change path: '${chg}' is not a valid canonical relative path or is protected`,
      };
    }
  }

  const policyId = validState.taskContext?.configId;
  if (!policyId || policyId.trim().length === 0) {
    return {
      outcome: 'rejected',
      reason: 'Missing configId in task context: cannot fabricate default policy ID',
    };
  }

  const policyVersion = validState.taskContext?.configVersion;
  if (!policyVersion || policyVersion.trim().length === 0) {
    return {
      outcome: 'rejected',
      reason: 'Missing configVersion in task context: cannot fabricate default policy version',
    };
  }

  const evidenceWriter = ports.baselineEvidenceWriter;
  if (!evidenceWriter || typeof evidenceWriter.persistBaselineEvidence !== 'function') {
    return {
      outcome: 'rejected',
      reason: 'Missing trusted UC-04 baseline evidence writer',
    };
  }

  const evidenceContent: BaselineEvidenceCandidate = Object.freeze({
    ...validBaselineCandidate,
    acceptanceCriteria: Object.freeze([...validBaselineCandidate.acceptanceCriteria]),
    requiredChecks: Object.freeze(
      validBaselineCandidate.requiredChecks.map((check) =>
        Object.freeze({ ...check, argv: Object.freeze([...check.argv]) })
      )
    ),
    expectedPassingCheckIds: Object.freeze([...validBaselineCandidate.expectedPassingCheckIds]),
    expectedTestFiles: Object.freeze([...validBaselineCandidate.expectedTestFiles]),
    checkResults: Object.freeze(
      validBaselineCandidate.checkResults.map((result) => Object.freeze({ ...result }))
    ),
  });
  const writeRequest: BaselineEvidenceWriteRequest = Object.freeze({
    content: evidenceContent,
    contentDigest: computeCanonicalSha256(evidenceContent),
  });

  let rawAcknowledgement: unknown;
  try {
    rawAcknowledgement = await evidenceWriter.persistBaselineEvidence(writeRequest);
  } catch {
    return {
      outcome: 'rejected',
      reason: 'Trusted UC-04 baseline evidence persistence failed',
    };
  }
  if (!baselineEvidenceAcknowledgementMatches(rawAcknowledgement, writeRequest)) {
    return {
      outcome: 'rejected',
      reason: 'Trusted UC-04 baseline evidence acknowledgement did not match the persisted content',
    };
  }
  const acknowledgement = rawAcknowledgement;

  const persistedBaselineCandidate: Baseline = {
    evidenceId: acknowledgement.evidenceId,
    repositorySnapshotDigest: evidenceContent.repositorySnapshotDigest,
    checkSetDigest: evidenceContent.checkSetDigest,
    reproductionFailureSignature: evidenceContent.reproductionFailureSignature,
    checkResults: evidenceContent.checkResults,
    testProtectionDigest: evidenceContent.testProtectionDigest,
  };
  const persistedBaselineValidation = validateBaselineAdmission(persistedBaselineCandidate, {
    expectedEvidenceId: acknowledgement.evidenceId,
    expectedRepositorySnapshotDigest: evidenceContent.repositorySnapshotDigest,
    expectedCheckSetDigest: evidenceContent.checkSetDigest,
    expectedTestProtectionDigest: evidenceContent.testProtectionDigest,
    expectedReproductionCheckId: evidenceContent.reproductionCheckId,
    expectedPassingCheckIds: evidenceContent.expectedPassingCheckIds,
  });
  if (!persistedBaselineValidation.ok) {
    return {
      outcome: 'rejected',
      reason: `Persisted baseline admission failed: ${persistedBaselineValidation.errors.map((error) => error.message).join(', ')}`,
    };
  }
  const validBaseline = persistedBaselineValidation.value;
  const requestedEvidenceRefs = planDetails?.evidenceRefs;
  let completeEvidenceRefs: readonly string[];
  if (requestedEvidenceRefs === undefined) {
    completeEvidenceRefs = Object.freeze([validBaseline.evidenceId]);
  } else if (!Array.isArray(requestedEvidenceRefs)) {
    return {
      outcome: 'rejected',
      state: validState,
      reason: 'Invalid evidence references: planDetails.evidenceRefs must be an array',
    };
  } else {
    const stateRefs = validState.evidenceRefs ?? [];
    for (const ref of requestedEvidenceRefs) {
      if (typeof ref !== 'string' || ref.trim().length === 0) {
        return {
          outcome: 'rejected',
          state: validState,
          reason: 'Invalid evidence reference: reference must be a non-empty string',
        };
      }
      const isKnownProvenance =
        ref === validBaseline.evidenceId ||
        stateRefs.includes(ref);
      if (!isKnownProvenance) {
        return {
          outcome: 'rejected',
          state: validState,
          reason: `Untrusted or missing evidence reference: '${ref}' has no proven provenance in task state`,
        };
      }
    }
    const extra = requestedEvidenceRefs
      .filter((r) => r !== validBaseline.evidenceId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    completeEvidenceRefs = Object.freeze([validBaseline.evidenceId, ...new Set(extra)]);
  }

  const checkSetDigest = validBaseline.checkSetDigest;
  const baselineRef = validBaseline.evidenceId;

  const planCandidate: FixPlan = {
    planVersion,
    diagnosis,
    suspectedCauseLocations,
    evidenceRefs: completeEvidenceRefs,
    strategy,
    scopedChanges,
    checkSetDigest,
    baselineRef,
    strategyDigest,
    decisionRef: decisionId,
  };

  const planValidation = validateFixPlan(planCandidate);
  if (!planValidation.ok) {
    return {
      outcome: 'rejected',
      reason: `FixPlan validation failed: ${planValidation.errors.map((e) => e.message).join(', ')}`,
    };
  }
  const fixPlan = planValidation.value;

  const existingEvidenceRefs = validState.evidenceRefs ?? [];
  const updatedEvidenceRefs = [
    ...existingEvidenceRefs,
    ...completeEvidenceRefs.filter((r) => !existingEvidenceRefs.includes(r)),
  ];

  const awaitPlanCandidate: TaskState = {
    ...validState,
    stateVersion: validState.stateVersion + 1,
    node: 'AwaitPlan',
    plan: fixPlan,
    activeDecisionId: decisionId,
    nextAction: 'await-plan-approval',
    evidenceRefs: updatedEvidenceRefs,
    ...(validState.budgetLedgers !== undefined
      ? { budgetLedgers: validState.budgetLedgers }
      : { budgetLedgers: [] }),
  };

  const transitionValidation = validateStateTransition(validState, awaitPlanCandidate);
  if (!transitionValidation.ok) {
    return {
      outcome: 'rejected',
      reason: `State transition to AwaitPlan failed: ${transitionValidation.errors.map((e) => e.message).join(', ')}`,
    };
  }

  let persistedAwaitPlanState: TaskState;
  try {
    persistedAwaitPlanState = await ports.state.transition(
      awaitPlanCandidate,
      validState.stateVersion
    );
    await ports.state.checkpoint(persistedAwaitPlanState);
  } catch (err: unknown) {
    return {
      outcome: 'rejected',
      reason: `StatePort transition/checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const action: ApproveFixPlanAction = {
    actionId: decisionId,
    kind: 'approve_fix_plan',
    planVersion: fixPlan.planVersion,
    strategyDigest: fixPlan.strategyDigest,
    diagnosisEvidenceRefs: completeEvidenceRefs,
    checkSetDigest: validBaseline.checkSetDigest,
  };
  const actionDigest = computeCanonicalSha256(action);

  const criteriaDigest = computeCanonicalSha256(validState.acceptanceCriteria);

  const binding: ApprovalBinding = {
    decisionId,
    actionKind: 'fix_plan',
    normalizedActionDigest: actionDigest,
    taskId: validState.taskId,
    workspaceId: validState.workspaceId,
    repositoryRevisionDigest: validState.repositoryRevisionDigest,
    policyId,
    policyVersion,
    planVersion: fixPlan.planVersion,
    strategyDigest: fixPlan.strategyDigest,
    baselineRef: validBaseline.evidenceId,
    evidenceRefs: completeEvidenceRefs,
    criteriaDigest,
    checkSetDigest: validBaseline.checkSetDigest,
    status: 'pending',
    reason: 'Fix plan requires human review and explicit approval',
  };

  let decision: ApprovalBinding;
  try {
    decision = await ports.approval.requestDecision(binding);
  } catch (err: unknown) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `Approval request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!ports.state || typeof ports.state.loadTask !== 'function') {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'Missing StatePort loadTask capability: cannot reload authoritative state after approval await',
    };
  }

  let reloadedState: TaskState | null = null;
  try {
    reloadedState = await ports.state.loadTask(validState.taskId);
  } catch (err: unknown) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `Authoritative StatePort reload failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!reloadedState) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'Authoritative state missing from StatePort after approval await',
    };
  }

  if (reloadedState.stateVersion !== persistedAwaitPlanState.stateVersion) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `State CAS version drift detected while awaiting approval: expected version ${persistedAwaitPlanState.stateVersion}, observed ${reloadedState.stateVersion}`,
    };
  }

  if (reloadedState.node !== 'AwaitPlan') {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `State node drift detected while awaiting approval: expected 'AwaitPlan', observed '${reloadedState.node}'`,
    };
  }

  if (reloadedState.activeDecisionId !== decisionId) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `State active decision ID drift detected while awaiting approval: expected '${decisionId}', observed '${reloadedState.activeDecisionId}'`,
    };
  }

  if (reloadedState.repositoryRevisionDigest !== persistedAwaitPlanState.repositoryRevisionDigest) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `State repository revision drift detected while awaiting approval: expected '${persistedAwaitPlanState.repositoryRevisionDigest}', observed '${reloadedState.repositoryRevisionDigest}'`,
    };
  }

  if (reloadedState.workspaceId !== validState.workspaceId) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `State workspace ID drift detected while awaiting approval: expected '${validState.workspaceId}', observed '${reloadedState.workspaceId}'`,
    };
  }

  if (reloadedState.repositoryId !== validState.repositoryId) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: `State repository ID drift detected while awaiting approval: expected '${validState.repositoryId}', observed '${reloadedState.repositoryId}'`,
    };
  }

  if (computeCanonicalSha256(reloadedState.acceptanceCriteria) !== criteriaDigest) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'State acceptance criteria drift detected while awaiting approval',
    };
  }

  if (reloadedState.plan?.strategyDigest !== fixPlan.strategyDigest) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'State plan strategy digest drift detected while awaiting approval',
    };
  }

  if (reloadedState.plan?.baselineRef !== validBaseline.evidenceId) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'State plan baseline reference drift detected while awaiting approval',
    };
  }

  if (
    !Array.isArray(reloadedState.plan?.evidenceRefs) ||
    computeCanonicalSha256(reloadedState.plan.evidenceRefs) !== computeCanonicalSha256(completeEvidenceRefs)
  ) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'State plan evidence references drift detected while awaiting approval',
    };
  }

  if (
    !Array.isArray(reloadedState.evidenceRefs) ||
    computeCanonicalSha256(reloadedState.evidenceRefs) !== computeCanonicalSha256(updatedEvidenceRefs)
  ) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      state: persistedAwaitPlanState,
      reason: 'State evidence references drift detected while awaiting approval',
    };
  }

  let revalidatedSnapshotValidation: HostSnapshotValidationResult | null = null;
  const hostPort = ports.host ?? (ports as { hostAuthority?: TrustedHostPort }).hostAuthority;
  if (hostPort && typeof hostPort.loadSnapshot === 'function') {
    let hostSnapshot: TrustedHostSnapshot;
    try {
      hostSnapshot = await hostPort.loadSnapshot({
        taskId: reloadedState.taskId,
        workspaceId: reloadedState.workspaceId,
        repositoryId: reloadedState.repositoryId,
        expectedRevisionDigest: reloadedState.repositoryRevisionDigest,
        expectedCriteriaDigest: criteriaDigest,
        expectedCheckSetDigest: validBaseline.checkSetDigest,
        expectedTestFiles: validBaselineCandidate.expectedTestFiles,
      });
    } catch (err: unknown) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: `Host snapshot reload failed after approval await: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const snapshotValidation = validateHostSnapshotFacts(
      hostSnapshot,
      {
        taskId: reloadedState.taskId,
        workspaceId: reloadedState.workspaceId,
        repositoryId: reloadedState.repositoryId,
        revisionDigest: reloadedState.repositoryRevisionDigest,
        criteriaDigest: criteriaDigest,
        checkSetDigest: validBaseline.checkSetDigest,
        expectedTestFiles: validBaselineCandidate.expectedTestFiles,
      },
      validBaselineCandidate.requiredChecks
    );
    if (!snapshotValidation.ok) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: snapshotValidation.reason ?? 'Host snapshot validation failed after approval await',
      };
    }

    if (snapshotValidation.testProtectionDigest !== validBaseline.testProtectionDigest) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: 'Host protected test files drift detected while awaiting approval',
      };
    }

    revalidatedSnapshotValidation = snapshotValidation;
  }

  let reloadedPolicyId = policyId;
  let reloadedPolicyVersion = policyVersion;
  const configPort = ports.config ?? (ports as { configPort?: InvestigationConfigPort }).configPort;
  if (configPort && typeof configPort.loadConfig === 'function') {
    let loadedConfig: { readonly configId?: string; readonly configVersion?: string } | null = null;
    try {
      loadedConfig = await configPort.loadConfig(reloadedState.taskId);
    } catch (err: unknown) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: `Config port reload failed after approval await: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!loadedConfig || !loadedConfig.configId || !loadedConfig.configVersion) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: 'Config port returned missing or incomplete config after approval await',
      };
    }

    if (loadedConfig.configId !== policyId || loadedConfig.configVersion !== policyVersion) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: `Config drift detected while awaiting approval: expected ${policyId}@${policyVersion}, observed ${loadedConfig.configId}@${loadedConfig.configVersion}`,
      };
    }
    reloadedPolicyId = loadedConfig.configId;
    reloadedPolicyVersion = loadedConfig.configVersion;
  } else if (reloadedState.taskContext?.configId && reloadedState.taskContext?.configVersion) {
    if (
      reloadedState.taskContext.configId !== policyId ||
      reloadedState.taskContext.configVersion !== policyVersion
    ) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        state: persistedAwaitPlanState,
        reason: `State taskContext config drift detected while awaiting approval: expected ${policyId}@${policyVersion}, observed ${reloadedState.taskContext.configId}@${reloadedState.taskContext.configVersion}`,
      };
    }
    reloadedPolicyId = reloadedState.taskContext.configId;
    reloadedPolicyVersion = reloadedState.taskContext.configVersion;
  }

  const freshnessContext: ApprovalBindingContext = {
    currentTaskId: reloadedState.taskId,
    currentWorkspaceId: reloadedState.workspaceId,
    currentRepositoryRevisionDigest: reloadedState.repositoryRevisionDigest,
    currentPolicyId: reloadedPolicyId,
    currentPolicyVersion: reloadedPolicyVersion,
    currentNormalizedActionDigest: actionDigest,
    currentPlanVersion: fixPlan.planVersion,
    currentStrategyDigest: fixPlan.strategyDigest,
    currentBaselineRef: validBaseline.evidenceId,
    currentEvidenceRefs: completeEvidenceRefs,
    currentCriteriaDigest: criteriaDigest,
    currentCheckSetDigest: validBaseline.checkSetDigest,
  };

  const bindingValidation = parseApprovalBinding(decision, freshnessContext);
  if (!bindingValidation.ok) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      binding: decision,
      state: persistedAwaitPlanState,
      reason: `Approval binding validation failed: ${bindingValidation.errors.map((e) => e.message).join(', ')}`,
    };
  }

  if (decision.decisionId !== binding.decisionId) {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      binding: decision,
      state: persistedAwaitPlanState,
      reason: `Approval decisionId mismatch: expected '${binding.decisionId}', got '${decision.decisionId}'`,
    };
  }

  if (decision.actionKind !== 'fix_plan') {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      binding: decision,
      state: persistedAwaitPlanState,
      reason: `Approval actionKind mismatch: expected 'fix_plan', got '${decision.actionKind}'`,
    };
  }

  if (decision.status === 'stale') {
    return {
      outcome: 'rejected',
      plan: fixPlan,
      binding: decision,
      state: persistedAwaitPlanState,
      reason: decision.reason ?? 'Approval binding is stale',
    };
  }

  if (decision.status === 'pending') {
    return {
      outcome: 'pending',
      plan: fixPlan,
      binding: decision,
      state: persistedAwaitPlanState,
      reason: decision.reason ?? 'Fix plan approval pending; paused at AwaitPlan',
    };
  }

  if (decision.status === 'rejected') {
    const awaitFeedbackCandidate: TaskState = {
      ...persistedAwaitPlanState,
      stateVersion: persistedAwaitPlanState.stateVersion + 1,
      node: 'AwaitFeedback',
      nextAction: 'await-feedback',
      ...(persistedAwaitPlanState.budgetLedgers !== undefined
        ? { budgetLedgers: persistedAwaitPlanState.budgetLedgers }
        : { budgetLedgers: [] }),
    };

    const feedbackTransitionVal = validateStateTransition(
      persistedAwaitPlanState,
      awaitFeedbackCandidate
    );
    if (!feedbackTransitionVal.ok) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        binding: decision,
        state: persistedAwaitPlanState,
        reason: `State transition to AwaitFeedback failed: ${feedbackTransitionVal.errors.map((e) => e.message).join(', ')}`,
      };
    }

    let finalFeedbackState: TaskState;
    try {
      finalFeedbackState = await ports.state.transition(
        awaitFeedbackCandidate,
        persistedAwaitPlanState.stateVersion
      );
      await ports.state.checkpoint(finalFeedbackState);
    } catch (err: unknown) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        binding: decision,
        state: persistedAwaitPlanState,
        reason: `Failed transitioning to AwaitFeedback: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      outcome: 'rejected',
      plan: fixPlan,
      binding: decision,
      state: finalFeedbackState,
      reason: decision.reason ?? 'Fix plan was rejected during review',
    };
  }

  if (decision.status === 'approved') {
    if (!revalidatedSnapshotValidation) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        binding: decision,
        state: persistedAwaitPlanState,
        reason: 'Missing HostPort loadSnapshot capability: fresh host snapshot revalidation is required before Patch transition',
      };
    }

    const admission = validateApprovalBinding(decision, freshnessContext);
    if (!admission.ok) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        binding: decision,
        state: persistedAwaitPlanState,
        reason: `Approval binding freshness validation failed: ${admission.errors.map((e) => e.message).join(', ')}`,
      };
    }

    const patchCandidate: TaskState = {
      ...persistedAwaitPlanState,
      stateVersion: persistedAwaitPlanState.stateVersion + 1,
      node: 'Patch',
      nextAction: 'apply-patch',
      plan: fixPlan,
      planVersion: fixPlan.planVersion,
      activeDecisionId: decision.decisionId,
      evidenceRefs: updatedEvidenceRefs,
      ...(persistedAwaitPlanState.budgetLedgers !== undefined
        ? { budgetLedgers: persistedAwaitPlanState.budgetLedgers }
        : { budgetLedgers: [] }),
    };

    const patchTransitionVal = validateStateTransition(
      persistedAwaitPlanState,
      patchCandidate,
      {
        trusted: {
          approval: {
            binding: decision,
            freshness: freshnessContext,
          },
        },
      }
    );
    if (!patchTransitionVal.ok) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        binding: decision,
        state: persistedAwaitPlanState,
        reason: `State transition to Patch failed: ${patchTransitionVal.errors.map((e) => e.message).join(', ')}`,
      };
    }

    let finalPatchState: TaskState;
    try {
      finalPatchState = await ports.state.transition(
        patchCandidate,
        persistedAwaitPlanState.stateVersion
      );
      await ports.state.checkpoint(finalPatchState);
    } catch (err: unknown) {
      return {
        outcome: 'rejected',
        plan: fixPlan,
        binding: decision,
        state: persistedAwaitPlanState,
        reason: `StatePort transition/checkpoint to Patch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      outcome: 'approved',
      plan: fixPlan,
      binding: decision,
      state: finalPatchState,
    };
  }

  return {
    outcome: 'rejected',
    plan: fixPlan,
    binding: decision,
    state: persistedAwaitPlanState,
    reason: `Unexpected approval status: ${(decision as { status?: unknown }).status}`,
  };
}
