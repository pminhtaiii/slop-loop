import type {
  PortIdentity,
  PortProvenance,
  ApplyPatchAction,
} from '../contracts/foundation/uc03.ts';
import type {
  RepositoryAdmissionContextV02,
  StatePortV02,
  AttemptReceiptV02,
  ClaimReceiptV02,
  ExecutorIdentityV02,
  RepositoryActionOutcomeReceiptV02,
  AttemptReconciliationReceiptV02,
  ClaimClosureResultV02,
} from '../contracts/foundation/uc03/ports-v02.ts';
import type { AttemptReconciliationValidationContextV02 } from '../contracts/foundation/uc03/attempt-v02.ts';
import type { DockerWorkspaceManager, StructuredCommandExecutor } from './docker-workspace.ts';
import type { RepositoryCommandResourcePolicy } from './repository-admission.ts';

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
  stat(canonicalPath: string): Promise<FileStat>;
  lstat(canonicalPath: string): Promise<FileStat>;
  realpath(canonicalPath: string): Promise<string>;
  readDir(canonicalPath: string): Promise<readonly TrustedFilesystemEntry[]>;
  /**
   * If maxBytes is supplied, enforce it on raw bytes from the opened file handle
   * throughout the read, even if the file grows or is replaced after stat.
   * Read at most maxBytes + 1 bytes (including an overflow probe), reject with
   * FILE_TOO_LARGE on overflow, and close the handle on success or failure.
   * Never load the whole oversized file and then validate or truncate it.
   */
  readTextFile(canonicalPath: string, maxBytes?: number): Promise<string>;
  getCurrentRevisionDigest(): Promise<string>;
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
  readonly patchReceiver?: ((patch: ApplyPatchAction, context: RepositoryAdmissionContextV02, attempt: AttemptReceiptV02) => Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }>) | undefined;
  readonly patchRecoveryHandoff?: PatchRecoveryHandoffV02 | undefined;
  readonly unattemptedClaimClosureHandoff?: UnattemptedClaimClosureHandoffV02 | undefined;
  readonly neutralStub?: boolean | undefined;
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
}

