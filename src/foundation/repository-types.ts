import type { PortIdentity, PortProvenance, ApplyPatchAction } from '../contracts/foundation/uc03.ts';
import type {
  RepositoryAdmissionContextV02,
  StatePortV02,
  AttemptReceiptV02,
  ClaimReceiptV02,
  ExecutorIdentityV02,
  RepositoryActionOutcomeReceiptV02,
  AttemptReconciliationReceiptV02,
  ClaimClosureResultV02,
} from '../contracts/foundation/uc03/v02/ports.ts';
import type { AttemptReconciliationValidationContextV02 } from '../contracts/foundation/uc03/v02/attempt.ts';
import type { DockerWorkspaceManager, StructuredCommandExecutor } from './docker-workspace.ts';
import type { RepositoryCommandResourcePolicy } from './repository-admission.ts';
import type { RepositoryDiffSourceOptions } from './repository-diff-types.ts';
export type { RepositoryDiffSourceOptions };
import type {
  QuestionIdentityV1,
  RepositoryBindingV1,
  RepositoryOperationLimitsV1,
} from '../contracts/questions/contracts.ts';

/** Caller-owned cancellation and wall-clock deadline for one question repository operation. */
export interface QuestionRepositoryOperationControl {
  readonly signal: AbortSignal;
  readonly deadlineEpochMs: number;
}

/** Per-task source work ceilings plus finite per-operation and cursor bounds. */
export interface QuestionRepositoryReadLimits extends RepositoryOperationLimitsV1 {
  readonly maxScannedFiles: number;
  readonly maxScannedBytes: number;
  readonly maxReturnedBytes: number;
  readonly maxCursors: number;
  readonly contextLinesBefore: number;
  readonly contextLinesAfter: number;
}

/** The host rechecks current owner/repository binding around each snapshot operation. */
export interface QuestionRepositoryBindingPort {
  checkBinding(expected: RepositoryBindingV1, control: QuestionRepositoryOperationControl): Promise<unknown>;
}

export type QuestionSnapshotFileReadResult =
  | { readonly status: 'ok'; readonly bytes: Uint8Array; readonly scannedBytes: number }
  | { readonly status: 'unreadable'; readonly scannedBytes: number }
  | { readonly status: 'oversized'; readonly scannedBytes: number };

/** A stable, host-owned view; it never forwards reads to a mutable workspace path. */
export interface TrustedQuestionRepositorySnapshotLease {
  readonly snapshot: unknown;
  readFile(
    canonicalPath: string,
    maxBytes: number,
    control: QuestionRepositoryOperationControl,
  ): Promise<unknown>;
}

/** Acquires a stable immutable source lease under the supplied finite admission limits. */
export interface TrustedQuestionRepositorySnapshotPort {
  acquireSnapshot(request: {
    readonly binding: RepositoryBindingV1;
    readonly admissionLimits: Readonly<{ maxFiles: number; maxBytes: number; maxElapsedMs: number }>;
    readonly control: QuestionRepositoryOperationControl;
  }): Promise<unknown>;
}

export interface FileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
}

export interface TrustedFilesystemEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export interface TrustedFilesystemPort extends PortIdentity {
  stat(canonicalPath: string, control?: QuestionRepositoryOperationControl): Promise<FileStat>;
  lstat(canonicalPath: string, control?: QuestionRepositoryOperationControl): Promise<FileStat>;
  realpath(canonicalPath: string, control?: QuestionRepositoryOperationControl): Promise<string>;
  readDir(canonicalPath: string, control?: QuestionRepositoryOperationControl): Promise<readonly TrustedFilesystemEntry[]>;
  /** Bounded streaming enumeration; rejects when the directory exceeds maxEntries. */
  readDirBounded?(
    canonicalPath: string,
    maxEntries: number,
    control: QuestionRepositoryOperationControl,
  ): Promise<readonly TrustedFilesystemEntry[]>;
  /**
   * If maxBytes is supplied, enforce it on raw bytes from the opened file handle
   * throughout the read, even if the file grows or is replaced after stat.
   * Read at most maxBytes + 1 bytes (including an overflow probe), reject with
   * FILE_TOO_LARGE on overflow, and close the handle on success or failure.
   * Never load the whole oversized file and then validate or truncate it.
   */
  readTextFile(canonicalPath: string, maxBytes?: number, control?: QuestionRepositoryOperationControl): Promise<string>;
  /**
   * If maxBytes is supplied, enforce it while hashing each file: read raw bytes from the
   * open handle with at most one maxBytes + 1 read, never loading the whole oversized file,
   * and reject with an Error whose message starts with FILE_TOO_LARGE on overflow.
   */
  getCurrentRevisionDigest(maxBytes?: number, control?: QuestionRepositoryOperationControl): Promise<string>;
  /** A digest traversal with explicit finite metadata, file and byte budgets. */
  getCurrentRevisionDigestBounded?(
    limits: Readonly<{ maxEntries: number; maxFiles: number; maxBytes: number }>,
    control: QuestionRepositoryOperationControl,
  ): Promise<string>;
}

export interface GuardedReadOperation<T = unknown> {
  readonly kind: 'list' | 'read' | 'search';
  readonly targetPath?: string | undefined;
  readonly query?: string | undefined;
  readonly execute: () => Promise<T>;
}

export interface ExecutionGuardReadCapability extends PortIdentity {
  readonly capabilityId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  mediateRead<T>(operation: GuardedReadOperation<T>): Promise<T>;
}

export interface RepositoryReadLimits {
  readonly maxExcerptBytes: number;
  readonly maxResultCount: number;
  readonly maxFileSizeBytes?: number | undefined;
}

export interface RepositoryTaskControlReadPortV02 {
  getJournalSnapshot(): unknown;
}

export interface PatchRecoveryRequestV02 {
  readonly admission: RepositoryAdmissionContextV02;
  readonly claim: ClaimReceiptV02;
  readonly attempt: AttemptReceiptV02;
  readonly outcome: RepositoryActionOutcomeReceiptV02;
}

export interface PatchRecoveryPreparationV02 {
  readonly receipt: AttemptReconciliationReceiptV02;
  readonly validationContext: AttemptReconciliationValidationContextV02;
}

/** Supplies UC-04's trusted recovery facts; StatePortV02 remains the authority. */
export interface PatchRecoveryHandoffV02 {
  prepare(request: PatchRecoveryRequestV02): Promise<PatchRecoveryPreparationV02>;
}

export interface UnattemptedClaimClosureRequestV02 {
  readonly admission: RepositoryAdmissionContextV02;
  readonly claim: ClaimReceiptV02;
  readonly recipientIdentity: ExecutorIdentityV02;
}

/** Delegates no-attempt closure to the existing UC-05/UC-04 fenced proof boundary. */
export interface UnattemptedClaimClosureHandoffV02 {
  closeUnattemptedClaim(request: UnattemptedClaimClosureRequestV02): Promise<ClaimClosureResultV02>;
}

export interface RepositoryAttemptStartRecoveryRequestV02 {
  readonly recoveryId: string;
  readonly admission: RepositoryAdmissionContextV02;
  readonly claim: ClaimReceiptV02;
  readonly executorIdentity: ExecutorIdentityV02;
}

/** Queries the trusted UC-04 owner for the committed or fenced no-attempt start state. */
export interface RepositoryAttemptStartRecoveryHandoffV02 {
  queryAttemptStart(request: RepositoryAttemptStartRecoveryRequestV02): Promise<unknown>;
}

export interface RepositoryAttemptStartRecoveryResultV02 {
  readonly outcome: 'settled' | 'blocked' | 'conflict';
  readonly recoveryId: string;
  readonly receiptId?: string | undefined;
}

export interface ControlledRepositoryToolsOptions {
  readonly guardCapability: ExecutionGuardReadCapability;
  readonly fsPort: TrustedFilesystemPort;
  readonly limits: RepositoryReadLimits;
  readonly expectedRevisionDigest?: string | undefined;
  readonly provenance?: PortProvenance | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly statePort?: StatePortV02 | undefined;
  readonly workspaceManager?: DockerWorkspaceManager | undefined;
  readonly commandExecutor?: StructuredCommandExecutor | undefined;
  readonly trustedCommandResourcePolicy?: RepositoryCommandResourcePolicy | undefined;
  readonly adapterIdentity?: string | undefined;
  readonly processIncarnation?: string | undefined;
  readonly fencingGeneration?: number | undefined;
  readonly taskControl?: RepositoryTaskControlReadPortV02 | undefined;
  readonly patchReceiver?:
    ((patch: ApplyPatchAction, context: RepositoryAdmissionContextV02, attempt: AttemptReceiptV02) => Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }>) | undefined;
  readonly patchRecoveryHandoff?: PatchRecoveryHandoffV02 | undefined;
  readonly attemptStartRecoveryHandoff?: RepositoryAttemptStartRecoveryHandoffV02 | undefined;
  readonly unattemptedClaimClosureHandoff?: UnattemptedClaimClosureHandoffV02 | undefined;
  /** Absent means `inspectDiff` stays fail-closed: no baseline, no measurement. */
  readonly repositoryDiff?: RepositoryDiffSourceOptions | undefined;
  readonly neutralStub?: boolean | undefined;
  readonly questionIdentity?: QuestionIdentityV1 | undefined;
  readonly questionLimits?: QuestionRepositoryReadLimits | undefined;
  readonly questionBindingPort?: QuestionRepositoryBindingPort | undefined;
  readonly questionSnapshotPort?: TrustedQuestionRepositorySnapshotPort | undefined;
}

export type ControlledRepositoryToolsV02Options = ControlledRepositoryToolsOptions;

export interface RepositoryReadOperationsOptions {
  readonly guardCapability: ExecutionGuardReadCapability;
  readonly fsPort: TrustedFilesystemPort;
  readonly limits: RepositoryReadLimits;
  readonly expectedRevisionDigest?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly statePort?: StatePortV02 | undefined;
  readonly taskControl?: RepositoryTaskControlReadPortV02 | undefined;
  readonly questionIdentity?: QuestionIdentityV1 | undefined;
  readonly questionLimits?: QuestionRepositoryReadLimits | undefined;
  readonly questionBindingPort?: QuestionRepositoryBindingPort | undefined;
  readonly questionSnapshotPort?: TrustedQuestionRepositorySnapshotPort | undefined;
}
