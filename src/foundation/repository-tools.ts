import type { PortProvenance, RepositoryPort, SourceEvidence } from '../contracts/foundation/uc03.ts';
import type {
  RepositoryPortV02,
  RepositoryAdmissionContextV02,
  ReconciliationResultV02,
} from '../contracts/foundation/uc03/ports-v02.ts';
import type { ApplyPatchAction, CheckDefinition, CheckResult, RunCommandAction } from '../contracts/foundation/uc03/types.ts';
import { ControlledRepositoryReader, containsProtectedContent } from './repository-read.ts';
import { RepositoryCommandReceiver } from './repository-receiver.ts';
import { RepositoryPatchReceiver } from './repository-outcome.ts';
import type { ControlledRepositoryToolsOptions } from './repository-types.ts';

export type {
  ControlledRepositoryToolsV02Options,
  ControlledRepositoryToolsOptions,
  ExecutionGuardReadCapability,
  FileStat,
  GuardedReadOperation,
  PatchRecoveryHandoffV02,
  PatchRecoveryPreparationV02,
  PatchRecoveryRequestV02,
  RepositoryReadLimits,
  RepositoryTaskControlReadPortV02,
  TrustedFilesystemEntry,
  TrustedFilesystemPort,
} from './repository-types.ts';
export { containsProtectedContent };

export class ControlledRepositoryTools implements RepositoryPort, RepositoryPortV02 {
  readonly provenance: PortProvenance;
  private readonly reader: ControlledRepositoryReader;
  private readonly commands: RepositoryCommandReceiver;
  private readonly patches: RepositoryPatchReceiver;
  private readonly adapterIdentity: string;
  private readonly processIncarnation: string;
  private fencingGeneration: number;

  constructor(options: ControlledRepositoryToolsOptions) {
    if (!options || typeof options !== 'object') throw new Error('INVALID_OPTIONS: Options must be an object');
    if (!options.guardCapability?.mediateRead) throw new Error('MISSING_GUARD_CAPABILITY: Required injected ExecutionGuard capability must be provided');
    if (!options.fsPort?.readTextFile) throw new Error('MISSING_FILESYSTEM_PORT: Required trusted filesystem port must be provided');
    if (!options.limits || typeof options.limits !== 'object') throw new Error('MISSING_LIMITS: Explicit finite limits must be provided');
    const { maxExcerptBytes, maxResultCount } = options.limits;
    if (typeof maxExcerptBytes !== 'number' || maxExcerptBytes <= 0 || !Number.isSafeInteger(maxExcerptBytes)) {
      throw new Error('INVALID_LIMITS: maxExcerptBytes must be a positive integer');
    }
    if (typeof maxResultCount !== 'number' || maxResultCount <= 0 || !Number.isSafeInteger(maxResultCount)) {
      throw new Error('INVALID_LIMITS: maxResultCount must be a positive integer');
    }
    if (options.workspaceRoot !== undefined && (typeof options.workspaceRoot !== 'string' || !options.workspaceRoot.trim())) {
      throw new Error('INVALID_OPTIONS: workspaceRoot must be a non-empty string if provided');
    }
    const provenance = options.provenance ?? options.fsPort.provenance;
    if (provenance !== 'real' && provenance !== 'mock') throw new Error('INVALID_PROVENANCE: Provenance must be real or mock');

    this.provenance = provenance;
    this.reader = new ControlledRepositoryReader(options);
    this.commands = new RepositoryCommandReceiver(options);
    this.patches = new RepositoryPatchReceiver(options);
    this.adapterIdentity = options.adapterIdentity ?? options.commandExecutor?.getAdapterIdentity?.() ?? '';
    this.processIncarnation = options.processIncarnation ?? options.commandExecutor?.getProcessIncarnation?.() ?? '';
    this.fencingGeneration = options.fencingGeneration ?? options.commandExecutor?.getFencingGeneration?.() ?? 0;
  }

  getAdapterIdentity(): string { return this.adapterIdentity; }
  getProcessIncarnation(): string { return this.processIncarnation; }
  getFencingGeneration(): number { return this.fencingGeneration; }

  setFencingGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error('INVALID_FENCING_GENERATION: Fencing generation must be a positive safe integer');
    }
    this.fencingGeneration = generation;
    this.commands.setFencingGeneration(generation);
    this.patches.setFencingGeneration(generation);
  }

  listDir(dirPath: string): Promise<readonly string[]> { return this.reader.listDir(dirPath); }
  readFile(filePath: string): Promise<SourceEvidence> { return this.reader.readFile(filePath); }
  searchCode(query: string): Promise<readonly SourceEvidence[]> { return this.reader.searchCode(query); }
  applyPatch(patch: ApplyPatchAction, context?: RepositoryAdmissionContextV02): Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }> {
    return this.patches.applyPatch(patch, context);
  }
  runCommand(action: RunCommandAction, context?: RepositoryAdmissionContextV02): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    return this.commands.runCommand(action, context);
  }
  runTests(check: CheckDefinition, context?: RepositoryAdmissionContextV02): Promise<CheckResult> { return this.commands.runTests(check, context); }
  recoverPatchOutcome(attemptId: string): Promise<ReconciliationResultV02> { return this.patches.recoverPatchOutcome(attemptId); }

  async inspectDiff(baseRevisionDigest: string): Promise<{ readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] }> {
    void baseRevisionDigest;
    throw new Error('NOT_IMPLEMENTED: inspectDiff is not implemented in T007-a slice');
  }
}

export class ControlledRepositoryToolsV02 extends ControlledRepositoryTools implements RepositoryPortV02 {}

export function createRepositoryReceiverV02(options: ControlledRepositoryToolsOptions): RepositoryPortV02 {
  return new ControlledRepositoryTools(options);
}
