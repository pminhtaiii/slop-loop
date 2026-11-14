import { Buffer } from 'node:buffer';
import type { DirectoryEntryV1, QuestionIdentityV1, SourceManifestEntryV1 } from '../contracts/questions/contracts.ts';
import { computeCanonicalSha256, isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
import { validateSourceSnapshot } from '../contracts/questions/validation.ts';
import { computeFileDigest } from './docker-workspace-policy.ts';
import type {
  QuestionRepositoryBindingPort,
  QuestionRepositoryOperationControl,
  QuestionRepositoryReadLimits,
  TrustedQuestionRepositorySnapshotLease,
  TrustedQuestionRepositorySnapshotPort,
} from './repository-types.ts';
import {
  activeControl,
  canonicalManifest,
  failure,
  isRecord,
  safeExceptionFailure,
  sameBinding,
  validReadFileResult,
  type AdmittedSnapshot,
  type SnapshotFileRead,
  type ToolFailure,
} from './question-repository-primitives.ts';

const SHA256_RE = /^sha256:[a-f0-9]{64}$/u;

export interface QuestionRepositorySnapshotReaderOptions {
  readonly identity: QuestionIdentityV1 | undefined;
  readonly limits: QuestionRepositoryReadLimits | undefined;
  readonly bindingPort: QuestionRepositoryBindingPort | undefined;
  readonly snapshotPort: TrustedQuestionRepositorySnapshotPort | undefined;
  readonly checkReadHold: () => void;
  readonly checkPathContainment: (path: string, control: QuestionRepositoryOperationControl) => Promise<{ readonly resolvedPath: string }>;
}

export class QuestionRepositorySnapshotReader {
  private readonly identity: QuestionIdentityV1 | undefined;
  private readonly limits: QuestionRepositoryReadLimits | undefined;
  private readonly bindingPort: QuestionRepositoryBindingPort | undefined;
  private readonly snapshotPort: TrustedQuestionRepositorySnapshotPort | undefined;
  private readonly checkReadHold: () => void;
  private readonly checkPathContainment: QuestionRepositorySnapshotReaderOptions['checkPathContainment'];
  private admittedSnapshot: AdmittedSnapshot | undefined;
  private admissionPromise: Promise<ToolFailure | undefined> | undefined;
  private admissionFailure: ToolFailure | undefined;
  private scannedFiles = 0;
  private scannedBytes = 0;

  constructor(options: QuestionRepositorySnapshotReaderOptions) {
    this.identity = options.identity;
    this.limits = options.limits;
    this.bindingPort = options.bindingPort;
    this.snapshotPort = options.snapshotPort;
    this.checkReadHold = options.checkReadHold;
    this.checkPathContainment = options.checkPathContainment;
  }

  get scannedFileCount(): number { return this.scannedFiles; }
  get scannedByteCount(): number { return this.scannedBytes; }

  async ensureSnapshot(control: QuestionRepositoryOperationControl): Promise<AdmittedSnapshot | ToolFailure> {
    if (this.admittedSnapshot) return this.admittedSnapshot;
    if (this.admissionFailure) return this.admissionFailure;
    if (this.admissionPromise) {
      const pendingFailure = await this.admissionPromise;
      return pendingFailure ?? this.admittedSnapshot ?? failure('unavailable', 'unsupported-adapter');
    }
    this.admissionPromise = this.acquireSnapshot(control);
    const result = await this.admissionPromise;
    this.admissionPromise = undefined;
    if (result) this.admissionFailure = result;
    return result ?? this.admittedSnapshot ?? failure('unavailable', 'unsupported-adapter');
  }

  async checkBinding(control: QuestionRepositoryOperationControl): Promise<ToolFailure | undefined> {
    const expected = this.identity?.binding;
    const port = this.bindingPort;
    if (!expected || !port || typeof port.checkBinding !== 'function') return failure('unavailable', 'unsupported-adapter');
    const active = activeControl(control);
    if (active) return active;
    this.checkReadHold();
    let result: unknown;
    try { result = await port.checkBinding(expected, control); }
    catch (error: unknown) { return safeExceptionFailure(error); }
    const after = activeControl(control);
    if (after) return after;
    if (!isRecord(result) || typeof result['status'] !== 'string') return failure('unavailable', 'unsupported-adapter');
    if (result['status'] === 'stale') return failure('stale', 'binding-mismatch');
    if (result['status'] === 'denied') return failure('denied', 'read-not-authorized');
    if (result['status'] === 'unavailable') return failure('unavailable', 'unsupported-adapter');
    if (result['status'] !== 'ok' || !isRecord(result['binding'])) return failure('unavailable', 'unsupported-adapter');
    const candidate = result['binding'];
    if (candidate['repositoryId'] !== expected.repositoryId || candidate['workspaceId'] !== expected.workspaceId ||
      candidate['revisionDigest'] !== expected.revisionDigest || candidate['policyDigest'] !== expected.policyDigest) {
      return failure('stale', 'binding-mismatch');
    }
    return undefined;
  }

  async checkDirectoryPath(path: string, control: QuestionRepositoryOperationControl): Promise<ToolFailure | undefined> {
    if (path === '.') return undefined;
    const active = activeControl(control);
    if (active) return active;
    try { await this.checkPathContainment(path, control); }
    catch (error: unknown) { return safeExceptionFailure(error); }
    return activeControl(control);
  }

  async readSnapshotFile(
    path: string,
    admitted: AdmittedSnapshot,
    control: QuestionRepositoryOperationControl,
  ): Promise<(SnapshotFileRead & { readonly digest: string }) | ToolFailure> {
    const limits = this.limits;
    if (!limits) return failure('unavailable', 'unsupported-adapter');
    const expected = admitted.manifestByPath.get(path);
    if (!expected) return failure('denied', 'outside-scope');
    const before = activeControl(control);
    if (before) return before;
    if (this.scannedFiles + 1 > limits.maxScannedFiles) return failure('exhausted', 'scan-limit');
    this.checkReadHold();
    const bindingBefore = await this.checkBinding(control);
    if (bindingBefore) return bindingBefore;
    let prePath: { readonly resolvedPath: string };
    try { prePath = await this.checkPathContainment(path, control); }
    catch (error: unknown) { return safeExceptionFailure(error); }
    const afterPath = activeControl(control);
    if (afterPath) return afterPath;
    const bindingAfterContainment = await this.checkBinding(control);
    if (bindingAfterContainment) return bindingAfterContainment;
    this.checkReadHold();
    let input: unknown;
    try { input = await admitted.readFile(path, limits.maxFileBytes, control); }
    catch (error: unknown) {
      const mapped = safeExceptionFailure(error);
      if (mapped.status === 'exhausted' || mapped.status === 'cancelled') return mapped;
      this.scannedFiles += 1;
      if (mapped.status === 'unavailable' && mapped.reasonCode === 'oversized') {
        const observedBytes = limits.maxFileBytes + 1;
        if (this.scannedBytes + observedBytes > limits.maxScannedBytes) {
          this.scannedBytes = limits.maxScannedBytes;
          return failure('exhausted', 'scan-limit');
        }
        this.scannedBytes += observedBytes;
        return mapped;
      }
      return failure('unavailable', 'unreadable');
    }
    const afterRead = activeControl(control);
    if (!validReadFileResult(input)) return afterRead ?? failure('unavailable', 'unsupported-adapter');
    this.scannedFiles += 1;
    if (input.scannedBytes > limits.maxFileBytes + 1 || (input.status === 'oversized' && input.scannedBytes !== limits.maxFileBytes + 1)) {
      return failure('unavailable', 'unsupported-adapter');
    }
    if (this.scannedBytes + input.scannedBytes > limits.maxScannedBytes) {
      this.scannedBytes = limits.maxScannedBytes;
      return failure('exhausted', 'scan-limit');
    }
    this.scannedBytes += input.scannedBytes;
    if (afterRead) return afterRead;
    if (input.status !== 'ok') return failure('unavailable', input.status === 'oversized' ? 'oversized' : 'unreadable');
    if (input.scannedBytes > limits.maxFileBytes || input.bytes.byteLength > limits.maxFileBytes) return failure('unavailable', 'oversized');
    const ownedBytes = Buffer.from(input.bytes);
    if (computeFileDigest(ownedBytes) !== expected.originalByteDigest) return failure('stale', 'source-mismatch');
    const bindingAfterRead = await this.checkBinding(control);
    if (bindingAfterRead) return bindingAfterRead;
    let postPath: { readonly resolvedPath: string };
    try { postPath = await this.checkPathContainment(path, control); }
    catch (error: unknown) { return safeExceptionFailure(error); }
    if (postPath.resolvedPath !== prePath.resolvedPath) return failure('stale', 'source-mismatch');
    const bindingAfterSecondContainment = await this.checkBinding(control);
    if (bindingAfterSecondContainment) return bindingAfterSecondContainment;
    return { status: 'ok', bytes: ownedBytes, scannedBytes: input.scannedBytes, digest: expected.originalByteDigest };
  }

  private async acquireSnapshot(control: QuestionRepositoryOperationControl): Promise<ToolFailure | undefined> {
    const binding = this.identity?.binding;
    const limits = this.limits;
    const port = this.snapshotPort;
    if (!binding || !limits || !port || typeof port.acquireSnapshot !== 'function') return failure('unavailable', 'unsupported-adapter');
    const before = activeControl(control);
    if (before) return before;
    const bindingFailure = await this.checkBinding(control);
    if (bindingFailure) return bindingFailure;
    const startedAt = Date.now();
    const requestedMaxElapsedMs = Math.max(1, control.deadlineEpochMs - startedAt);
    let leaseValue: unknown;
    try {
      leaseValue = await port.acquireSnapshot({
        binding,
        admissionLimits: { maxFiles: limits.maxScannedFiles, maxBytes: limits.maxScannedBytes, maxElapsedMs: requestedMaxElapsedMs },
        control,
      });
    } catch (error: unknown) { return safeExceptionFailure(error); }
    const afterAcquire = activeControl(control);
    if (afterAcquire) return afterAcquire;
    if (Date.now() - startedAt > Math.max(1, control.deadlineEpochMs - startedAt)) return failure('exhausted', 'deadline');
    if (!isRecord(leaseValue) || !isRecord(leaseValue['snapshot']) || typeof leaseValue['readFile'] !== 'function') return failure('unavailable', 'unsupported-adapter');
    const lease = leaseValue as unknown as TrustedQuestionRepositorySnapshotLease;
    if (!isRecord(lease.snapshot) || !Array.isArray(lease.snapshot['manifest'])) return failure('unavailable', 'unsupported-adapter');
    const rawManifest = lease.snapshot['manifest'];
    if (rawManifest.length > limits.maxScannedFiles - this.scannedFiles) {
      this.scannedFiles = limits.maxScannedFiles;
      return failure('exhausted', 'scan-limit');
    }
    for (const rawEntry of rawManifest) {
      const activeManifest = activeControl(control);
      if (activeManifest) return activeManifest;
      if (!isRecord(rawEntry) || typeof rawEntry['path'] !== 'string' || typeof rawEntry['originalByteDigest'] !== 'string' ||
        Buffer.byteLength(rawEntry['path'], 'utf8') > limits.maxPathBytes || rawEntry['originalByteDigest'].length > 71) {
        return failure('unavailable', 'unsupported-adapter');
      }
      const metadataBytes = Buffer.byteLength(rawEntry['path'], 'utf8') + Buffer.byteLength(rawEntry['originalByteDigest'], 'utf8');
      this.scannedFiles += 1;
      if (this.scannedBytes + metadataBytes > limits.maxScannedBytes) {
        this.scannedBytes = limits.maxScannedBytes;
        return failure('exhausted', 'scan-limit');
      }
      this.scannedBytes += metadataBytes;
    }
    const validatedSnapshot = validateSourceSnapshot(lease.snapshot);
    if (!validatedSnapshot.ok) return failure('unavailable', 'unsupported-adapter');
    const snapshot = validatedSnapshot.value;
    if (!sameBinding(snapshot.binding, binding)) return failure('stale', 'binding-mismatch');
    if (snapshot.admissionLimits.maxFiles > limits.maxScannedFiles || snapshot.admissionLimits.maxBytes > limits.maxScannedBytes ||
      snapshot.admissionLimits.maxElapsedMs > requestedMaxElapsedMs) return failure('unavailable', 'unsupported-adapter');
    if (Date.now() - startedAt > snapshot.admissionLimits.maxElapsedMs) return failure('exhausted', 'deadline');
    let previousPath = '';
    const manifestByPath = new Map<string, SourceManifestEntryV1>();
    const pathIndex: string[] = [];
    const mutableDirectories = new Map<string, Map<string, 'file' | 'directory'>>([['.', new Map()]]);
    for (const entry of snapshot.manifest) {
      const active = activeControl(control);
      if (active) return active;
      if (!SHA256_RE.test(entry.originalByteDigest) || !isCanonicalRelativePath(entry.path) || isProtectedPath(entry.path) || entry.path <= previousPath) {
        return failure('unavailable', 'unsupported-adapter');
      }
      if (Buffer.byteLength(entry.path, 'utf8') > limits.maxPathBytes) return failure('unavailable', 'unsupported-adapter');
      previousPath = entry.path;
      manifestByPath.set(entry.path, entry);
      pathIndex.push(entry.path);
      const segments = entry.path.split('/');
      let parent = '.';
      for (let index = 0; index < segments.length; index += 1) {
        const activeSegment = activeControl(control);
        if (activeSegment) return activeSegment;
        const segment = segments[index];
        if (segment === undefined) return failure('unavailable', 'unsupported-adapter');
        const child = parent === '.' ? segment : parent + '/' + segment;
        const isFile = index === segments.length - 1;
        const kind = isFile ? 'file' : 'directory';
        const siblings = mutableDirectories.get(parent);
        if (!siblings) return failure('unavailable', 'unsupported-adapter');
        const existing = siblings.get(child);
        if (existing !== undefined && existing !== kind) return failure('unavailable', 'unsupported-adapter');
        siblings.set(child, kind);
        if (!isFile) {
          if (manifestByPath.has(child)) return failure('unavailable', 'unsupported-adapter');
          if (!mutableDirectories.has(child)) mutableDirectories.set(child, new Map());
          parent = child;
        }
      }
    }
    if (canonicalManifest(snapshot.manifest) !== snapshot.manifestDigest) return failure('unavailable', 'unsupported-adapter');
    const afterManifest = activeControl(control);
    if (afterManifest) return afterManifest;
    const directoryChildren = new Map<string, readonly DirectoryEntryV1[]>();
    for (const [directory, children] of mutableDirectories) {
      const activeDirectory = activeControl(control);
      if (activeDirectory) return activeDirectory;
      const entries = [...children.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([path, kind]) => Object.freeze({ path, kind }));
      directoryChildren.set(directory, Object.freeze(entries));
    }
    if (!directoryChildren.has('.')) return failure('unavailable', 'unsupported-adapter');
    const bindingAfter = await this.checkBinding(control);
    if (bindingAfter) return bindingAfter;
    const bindingDigest = computeCanonicalSha256(binding);
    this.admittedSnapshot = Object.freeze({
      snapshot,
      readFile: lease.readFile.bind(lease),
      manifestByPath,
      pathIndex: Object.freeze(pathIndex),
      directoryChildren,
      bindingDigest,
    });
    return undefined;
  }
}
