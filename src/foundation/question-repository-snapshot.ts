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
  private reservedScanBytes = 0;

  constructor(options: QuestionRepositorySnapshotReaderOptions) {
    this.identity = options.identity;
    this.limits = options.limits;
    this.bindingPort = options.bindingPort;
    this.snapshotPort = options.snapshotPort;
    this.checkReadHold = options.checkReadHold;
    this.checkPathContainment = options.checkPathContainment;
  }

  get scannedFileCount(): number {
    return this.scannedFiles;
  }
  get scannedByteCount(): number {
    return this.scannedBytes;
  }

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
    if (result && !(control.work && result.status === 'exhausted')) this.admissionFailure = result;
    return result ?? this.admittedSnapshot ?? failure('unavailable', 'unsupported-adapter');
  }

  async checkBinding(control: QuestionRepositoryOperationControl): Promise<ToolFailure | undefined> {
    const expected = this.identity?.binding;
    const port = this.bindingPort;
    if (!expected || !port || typeof port.checkBinding !== 'function') return failure('unavailable', 'unsupported-adapter');
    const active = activeControl(control);
    if (active) return active;
    const work = control.work;
    if (work && typeof port.checkBindingBounded !== 'function') return failure('unavailable', 'unsupported-adapter');
    if (work && (work.remaining('scannedFiles') <= 0 || work.remaining('scannedBytes') <= 0)) return failure('exhausted', 'scan-limit');
    this.checkReadHold();
    let result: unknown;
    try {
      result = work ? await port.checkBindingBounded?.(expected, { ...control, work }) : await port.checkBinding(expected, control);
    } catch (error: unknown) {
      return safeExceptionFailure(error);
    }
    const after = activeControl(control);
    if (after) return after;
    if (!isRecord(result) || typeof result['status'] !== 'string') return failure('unavailable', 'unsupported-adapter');
    if (result['status'] === 'exhausted' && result['reasonCode'] === 'scan-limit') return failure('exhausted', 'scan-limit');
    if (result['status'] === 'stale') return failure('stale', 'binding-mismatch');
    if (result['status'] === 'denied') return failure('denied', 'read-not-authorized');
    if (result['status'] === 'unavailable') return failure('unavailable', 'unsupported-adapter');
    if (result['status'] !== 'ok' || !isRecord(result['binding'])) return failure('unavailable', 'unsupported-adapter');
    const candidate = result['binding'];
    if (
      candidate['repositoryId'] !== expected.repositoryId ||
      candidate['workspaceId'] !== expected.workspaceId ||
      candidate['revisionDigest'] !== expected.revisionDigest ||
      candidate['policyDigest'] !== expected.policyDigest
    ) {
      return failure('stale', 'binding-mismatch');
    }
    return undefined;
  }

  async checkDirectoryPath(path: string, control: QuestionRepositoryOperationControl): Promise<ToolFailure | undefined> {
    if (path === '.') return undefined;
    if (control.work && !control.work.charge({ scannedBytes: Buffer.byteLength(path, 'utf8') })) return failure('exhausted', 'scan-limit');
    const active = activeControl(control);
    if (active) return active;
    try {
      await this.checkPathContainment(path, control);
    } catch (error: unknown) {
      return safeExceptionFailure(error);
    }
    return activeControl(control);
  }

  async readSnapshotFile(path: string, admitted: AdmittedSnapshot, control: QuestionRepositoryOperationControl): Promise<(SnapshotFileRead & { readonly digest: string }) | ToolFailure> {
    const limits = this.limits;
    if (!limits) return failure('unavailable', 'unsupported-adapter');
    const expected = admitted.manifestByPath.get(path);
    if (!expected) return failure('denied', 'outside-scope');
    const before = activeControl(control);
    if (before) return before;
    const work = control.work;
    const remainingFiles = () => Math.min(limits.maxScannedFiles - this.scannedFiles, work?.remaining('scannedFiles') ?? Infinity);
    const availableBytes = () => Math.min(limits.maxScannedBytes - this.scannedBytes - this.reservedScanBytes, work?.remaining('scannedBytes') ?? Infinity);
    if (remainingFiles() < 1 || availableBytes() < 2) {
      return failure('exhausted', 'scan-limit');
    }
    this.checkReadHold();
    const bindingBefore = await this.checkBinding(control);
    if (bindingBefore) return bindingBefore;
    if (work && !work.charge({ scannedBytes: 2 * Buffer.byteLength(path, 'utf8') })) return failure('exhausted', 'scan-limit');
    let prePath: { readonly resolvedPath: string };
    try {
      prePath = await this.checkPathContainment(path, control);
    } catch (error: unknown) {
      return safeExceptionFailure(error);
    }
    const afterPath = activeControl(control);
    if (afterPath) return afterPath;
    const bindingAfterContainment = await this.checkBinding(control);
    if (bindingAfterContainment) return bindingAfterContainment;
    this.checkReadHold();
    const remainingBytes = availableBytes();
    if (remainingFiles() < 1 || remainingBytes < 2) return failure('exhausted', 'scan-limit');
    // A bounded read can consume one extra byte to detect overflow.
    const maxReadBytes = Math.min(limits.maxFileBytes, remainingBytes - 1);
    const reservation = maxReadBytes + 1;
    const oversized = maxReadBytes < limits.maxFileBytes ? failure('exhausted', 'scan-limit') : failure('unavailable', 'oversized');
    if (work && !work.charge({ scannedFiles: 1 })) return failure('exhausted', 'scan-limit');
    this.scannedFiles += 1;
    this.reservedScanBytes += reservation;
    const settleBytes = (bytes: number) => {
      this.scannedBytes += bytes;
      return !work || work.charge({ scannedBytes: bytes });
    };
    let input: unknown;
    try {
      input = await admitted.readFile(path, maxReadBytes, control);
    } catch (error: unknown) {
      if (!settleBytes(reservation)) return failure('exhausted', 'scan-limit');
      const mapped = safeExceptionFailure(error);
      if (mapped.status === 'exhausted' || mapped.status === 'cancelled') return mapped;
      if (mapped.status === 'unavailable' && mapped.reasonCode === 'oversized') return oversized;
      return failure('unavailable', 'unreadable');
    } finally {
      this.reservedScanBytes -= reservation;
    }
    const afterRead = activeControl(control);
    if (!validReadFileResult(input) || input.scannedBytes > reservation || (input.status === 'oversized' && input.scannedBytes !== reservation)) {
      if (!settleBytes(reservation)) return failure('exhausted', 'scan-limit');
      return afterRead ?? failure('unavailable', 'unsupported-adapter');
    }
    if (!settleBytes(input.scannedBytes)) return failure('exhausted', 'scan-limit');
    if (afterRead) return afterRead;
    if (input.status !== 'ok') return input.status === 'oversized' ? oversized : failure('unavailable', 'unreadable');
    if (input.scannedBytes > maxReadBytes) return oversized;
    if (work && !work.charge({ scannedBytes: input.scannedBytes })) return failure('exhausted', 'scan-limit');
    const ownedBytes = Buffer.from(input.bytes);
    if (computeFileDigest(ownedBytes) !== expected.originalByteDigest) return failure('stale', 'source-mismatch');
    const bindingAfterRead = await this.checkBinding(control);
    if (bindingAfterRead) return bindingAfterRead;
    let postPath: { readonly resolvedPath: string };
    try {
      postPath = await this.checkPathContainment(path, control);
    } catch (error: unknown) {
      return safeExceptionFailure(error);
    }
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
    const work = control.work;
    if (work && typeof port.acquireSnapshotBounded !== 'function') return failure('unavailable', 'unsupported-adapter');
    if (work && (work.remaining('scannedFiles') <= 0 || work.remaining('scannedBytes') <= 0)) return failure('exhausted', 'scan-limit');
    const bindingFailure = await this.checkBinding(control);
    if (bindingFailure) return bindingFailure;
    const startedAt = Date.now();
    const requestedMaxElapsedMs = Math.max(1, control.deadlineEpochMs - startedAt);
    const admissionLimits = Object.freeze({
      maxFiles: Math.min(limits.maxScannedFiles - this.scannedFiles, work?.remaining('scannedFiles') ?? Infinity),
      maxBytes: Math.min(limits.maxScannedBytes - this.scannedBytes, work?.remaining('scannedBytes') ?? Infinity),
      maxElapsedMs: requestedMaxElapsedMs,
    });
    if (admissionLimits.maxFiles <= 0 || admissionLimits.maxBytes <= 0) return failure('exhausted', 'scan-limit');
    let leaseValue: unknown;
    try {
      leaseValue = work ? await port.acquireSnapshotBounded?.({ binding, admissionLimits, control: { ...control, work } }) : await port.acquireSnapshot({ binding, admissionLimits, control });
    } catch (error: unknown) {
      return safeExceptionFailure(error);
    }
    const afterAcquire = activeControl(control);
    if (afterAcquire) return afterAcquire;
    if (Date.now() - startedAt > Math.max(1, control.deadlineEpochMs - startedAt)) return failure('exhausted', 'deadline');
    if (isRecord(leaseValue) && leaseValue['status'] === 'exhausted' && leaseValue['reasonCode'] === 'scan-limit') return failure('exhausted', 'scan-limit');
    if (!isRecord(leaseValue) || !isRecord(leaseValue['snapshot']) || typeof leaseValue['readFile'] !== 'function') return failure('unavailable', 'unsupported-adapter');
    const lease = leaseValue as unknown as TrustedQuestionRepositorySnapshotLease;
    if (!isRecord(lease.snapshot) || !Array.isArray(lease.snapshot['manifest'])) return failure('unavailable', 'unsupported-adapter');
    const rawManifest = lease.snapshot['manifest'];
    if (work && rawManifest.length > work.remaining('scannedFiles')) return failure('exhausted', 'scan-limit');
    if (rawManifest.length > limits.maxScannedFiles - this.scannedFiles) {
      this.scannedFiles = limits.maxScannedFiles;
      return failure('exhausted', 'scan-limit');
    }
    for (const rawEntry of rawManifest) {
      const activeManifest = activeControl(control);
      if (activeManifest) return activeManifest;
      if (
        !isRecord(rawEntry) ||
        typeof rawEntry['path'] !== 'string' ||
        typeof rawEntry['originalByteDigest'] !== 'string' ||
        Buffer.byteLength(rawEntry['path'], 'utf8') > limits.maxPathBytes ||
        rawEntry['originalByteDigest'].length > 71
      ) {
        return failure('unavailable', 'unsupported-adapter');
      }
      const metadataBytes = Buffer.byteLength(rawEntry['path'], 'utf8') + Buffer.byteLength(rawEntry['originalByteDigest'], 'utf8');
      if (work && !work.charge({ scannedFiles: 1, scannedBytes: metadataBytes })) return failure('exhausted', 'scan-limit');
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
    if (snapshot.admissionLimits.maxFiles > admissionLimits.maxFiles || snapshot.admissionLimits.maxBytes > admissionLimits.maxBytes || snapshot.admissionLimits.maxElapsedMs > requestedMaxElapsedMs)
      return failure('unavailable', 'unsupported-adapter');
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
      const entries = [...children.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([path, kind]) => Object.freeze({ path, kind }));
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
