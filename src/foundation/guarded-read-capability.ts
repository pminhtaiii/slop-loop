/**
 * Producer for `ExecutionGuardReadCapability`: fenced, read-only mediation over an injected
 * owner control/policy reader. It persists nothing, performs no approval logic and exposes no
 * execute-through surface; repository readers keep their own containment, protection and limits.
 */
import { isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
import type { PortProvenance } from '../contracts/foundation/uc03.ts';
import type { ExecutionGuardReadCapability, GuardedReadOperation } from './repository-types.ts';

export type GuardedReadControlMode = 'runnable' | 'paused' | 'rejected' | 'ended' | 'recovery';

/** Current owner facts for one task/workspace read. Policy and fencing are owner-issued. */
export interface GuardedReadControlObservation {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly revisionDigest: string;
  readonly controlVersion: number;
  readonly mode: GuardedReadControlMode;
  readonly holdRef: string | null;
  readonly fencingGeneration: number;
  readonly policyDigest: string;
  readonly readAllowed: boolean;
}

/** Owner-agreed read-fencing receipt: the observation was still current when dispatch was admitted. */
export interface GuardedReadFenceReceipt {
  readonly receiptId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly revisionDigest: string;
  readonly controlVersion: number;
  readonly fencingGeneration: number;
  readonly policyDigest: string;
}

/**
 * Owner-supplied control reader and read-fencing protocol. `fenceReadControl` must validate the
 * observation against current owner control atomically and return null when it changed. There is
 * no distributed lock: the owner decides how the observation and dispatch are serialized.
 */
export interface GuardedReadOwnerPort {
  observeReadControl(): GuardedReadControlObservation | Promise<GuardedReadControlObservation>;
  fenceReadControl(observation: GuardedReadControlObservation): GuardedReadFenceReceipt | null | Promise<GuardedReadFenceReceipt | null>;
}

export interface GuardedReadBounds {
  readonly maxPathLength: number;
  readonly maxQueryLength: number;
}

export interface GuardedReadCapabilityOptions {
  readonly capabilityId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly expectedRevisionDigest: string;
  readonly policyDigest: string;
  readonly bounds: GuardedReadBounds;
  readonly owner: GuardedReadOwnerPort;
  readonly provenance: PortProvenance;
}

/** Typed denial; the capability's public signature returns the operation result, so denial surfaces here. */
export class GuardedReadDenial extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, detail?: string) {
    super(detail === undefined ? reasonCode : `${reasonCode}: ${detail}`);
    this.name = 'GuardedReadDenial';
    this.reasonCode = reasonCode;
  }
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MODES: readonly GuardedReadControlMode[] = ['runnable', 'paused', 'rejected', 'ended', 'recovery'];

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function deny(reasonCode: string, detail?: string): GuardedReadDenial {
  return new GuardedReadDenial(reasonCode, detail);
}

class FencedGuardedReadCapability implements ExecutionGuardReadCapability {
  readonly provenance: PortProvenance;
  readonly capabilityId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  private readonly repositoryId: string;
  private readonly expectedRevisionDigest: string;
  private readonly policyDigest: string;
  private readonly maxPathLength: number;
  private readonly maxQueryLength: number;
  private readonly owner: GuardedReadOwnerPort;
  // Reads serialize on the control observation, so no dispatch can reach the closure without its fence.
  private controlTail: Promise<unknown> = Promise.resolve();

  constructor(options: GuardedReadCapabilityOptions) {
    if (!options || typeof options !== 'object') throw new Error('MISSING_GUARDED_READ_OPTIONS: Options must be an object');
    if (!SAFE_ID.test(options.capabilityId ?? '') || !SAFE_ID.test(options.taskId ?? '') || !SAFE_ID.test(options.workspaceId ?? '') || !SAFE_ID.test(options.repositoryId ?? '')) {
      throw new Error('INVALID_GUARDED_READ_IDENTITY: capability, task, workspace and repository ids must be safe ids');
    }
    if (typeof options.expectedRevisionDigest !== 'string' || options.expectedRevisionDigest.length === 0 || options.expectedRevisionDigest.length > 256) {
      throw new Error('INVALID_EXPECTED_REVISION: A non-empty expected revision digest is required');
    }
    if (typeof options.policyDigest !== 'string' || !SHA256.test(options.policyDigest)) {
      throw new Error('INVALID_READ_POLICY_DIGEST: A canonical sha256 read-policy digest is required');
    }
    const owner = options.owner;
    if (!owner || typeof owner.observeReadControl !== 'function' || typeof owner.fenceReadControl !== 'function') {
      throw new Error('MISSING_READ_FENCING_PROTOCOL: An owner reader with observeReadControl and fenceReadControl is required');
    }
    const bounds = options.bounds;
    if (!bounds || typeof bounds !== 'object') throw new Error('MISSING_READ_BOUNDS: Explicit finite bounds are required');
    if (!isPositiveInteger(bounds.maxPathLength) || !isPositiveInteger(bounds.maxQueryLength)) {
      throw new Error('INVALID_READ_BOUNDS: maxPathLength and maxQueryLength must be positive finite integers');
    }
    if (options.provenance !== 'real' && options.provenance !== 'mock') throw new Error('INVALID_PROVENANCE: Provenance must be real or mock');

    this.provenance = options.provenance;
    this.capabilityId = options.capabilityId;
    this.taskId = options.taskId;
    this.workspaceId = options.workspaceId;
    this.repositoryId = options.repositoryId;
    this.expectedRevisionDigest = options.expectedRevisionDigest;
    this.policyDigest = options.policyDigest;
    // Freeze the scalars so later mutation of the supplied options cannot widen the bounds.
    this.maxPathLength = bounds.maxPathLength;
    this.maxQueryLength = bounds.maxQueryLength;
    this.owner = owner;
  }

  async mediateRead<T>(operation: GuardedReadOperation<T>): Promise<T> {
    this.validateOperation(operation);
    const run = this.controlTail.then(() => this.#dispatch(operation));
    this.controlTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #dispatch<T>(operation: GuardedReadOperation<T>): Promise<T> {
    const observation = await this.owner.observeReadControl();
    this.assertObservation(observation);
    const receipt = await this.owner.fenceReadControl(observation);
    this.assertFenceReceipt(observation, receipt);
    // No await between the fence and this call: the closure is invoked inside the fenced section, once.
    return operation.execute();
  }

  private validateOperation(operation: GuardedReadOperation<unknown>): void {
    if (!operation || typeof operation !== 'object') throw deny('INVALID_READ_OPERATION', 'Operation must be an object');
    const kind: unknown = operation.kind;
    if (kind !== 'list' && kind !== 'read' && kind !== 'search') throw deny('UNSUPPORTED_READ_KIND', String(kind));
    if (typeof operation.execute !== 'function') throw deny('INVALID_READ_OPERATION', 'execute must be a function');

    const targetPath: unknown = operation.targetPath;
    if (targetPath !== undefined) this.assertPath(kind, targetPath);
    else if (kind === 'read') throw deny('INVALID_READ_PATH', 'read requires a targetPath');

    const query: unknown = operation.query;
    if (query !== undefined) this.assertQuery(kind, query);
    else if (kind === 'search') throw deny('INVALID_READ_QUERY', 'search requires a query');
  }

  private assertPath(kind: 'list' | 'read' | 'search', targetPath: unknown): void {
    if (typeof targetPath !== 'string') throw deny('INVALID_READ_PATH', 'targetPath must be a string');
    if (targetPath.length > this.maxPathLength) throw deny('INVALID_READ_PATH', 'targetPath exceeds maxPathLength');
    if (targetPath === '' || targetPath === '.') {
      if (kind !== 'list') throw deny('INVALID_READ_PATH', 'only list may target the repository root');
      return;
    }
    if (!isCanonicalRelativePath(targetPath)) throw deny('INVALID_READ_PATH', `Path '${targetPath}' must be a canonical repository-relative path`);
    if (isProtectedPath(targetPath)) throw deny('PROTECTED_READ_PATH', `Path '${targetPath}' is protected`);
  }

  private assertQuery(kind: 'list' | 'read' | 'search', query: unknown): void {
    if (kind !== 'search') throw deny('INVALID_READ_QUERY', 'only search accepts a query');
    if (typeof query !== 'string' || query.length === 0) throw deny('INVALID_READ_QUERY', 'query must be a non-empty string');
    if (query.length > this.maxQueryLength) throw deny('INVALID_READ_QUERY', 'query exceeds maxQueryLength');
    if (query.includes('\0')) throw deny('INVALID_READ_QUERY', 'query must not contain NUL');
  }

  private assertObservation(observation: GuardedReadControlObservation | null | undefined): void {
    if (!observation || typeof observation !== 'object') throw deny('INVALID_READ_CONTROL', 'Owner control observation is missing');
    if (!SAFE_ID.test(observation.taskId ?? '') || !SAFE_ID.test(observation.workspaceId ?? '') || !SAFE_ID.test(observation.repositoryId ?? '')) {
      throw deny('INVALID_READ_CONTROL', 'Owner control observation identities are malformed');
    }
    if (typeof observation.revisionDigest !== 'string' || observation.revisionDigest.length === 0 || observation.revisionDigest.length > 256) {
      throw deny('INVALID_READ_CONTROL', 'Owner control observation revision is malformed');
    }
    if (typeof observation.policyDigest !== 'string' || !SHA256.test(observation.policyDigest)) {
      throw deny('INVALID_READ_CONTROL', 'Owner control observation policy digest is malformed');
    }
    if (!isPositiveInteger(observation.controlVersion) || !isPositiveInteger(observation.fencingGeneration)) {
      throw deny('INVALID_READ_CONTROL', 'Owner control observation versions must be positive integers');
    }
    if (!MODES.includes(observation.mode)) throw deny('INVALID_READ_CONTROL', 'Owner control observation mode is unknown');
    if (observation.holdRef !== null && !SAFE_ID.test(observation.holdRef ?? '')) throw deny('INVALID_READ_CONTROL', 'Owner control observation hold is malformed');
    if (typeof observation.readAllowed !== 'boolean') throw deny('INVALID_READ_CONTROL', 'Owner control observation policy decision is malformed');

    if (observation.taskId !== this.taskId || observation.workspaceId !== this.workspaceId || observation.repositoryId !== this.repositoryId) {
      throw deny('READ_CONTROL_MISMATCH', 'Observed control does not belong to this task/workspace/repository');
    }
    if (observation.revisionDigest !== this.expectedRevisionDigest) {
      throw deny('READ_REVISION_MISMATCH', `Observed revision '${observation.revisionDigest}' does not match the bound revision`);
    }
    if (observation.policyDigest !== this.policyDigest) throw deny('READ_POLICY_MISMATCH', 'Observed read policy differs from the accepted policy');
    if (!observation.readAllowed) throw deny('READ_POLICY_DENIED', 'Current owner read policy does not permit this read');
    if (observation.mode !== 'runnable') throw deny('READ_CONTROL_NOT_RUNNABLE', `Task is not runnable (mode: ${observation.mode})`);
    if (observation.holdRef !== null) throw deny('READ_CONTROL_HELD', `Task retains hold '${observation.holdRef}'`);
  }

  private assertFenceReceipt(observation: GuardedReadControlObservation, receipt: GuardedReadFenceReceipt | null | undefined): void {
    if (!receipt || typeof receipt !== 'object') throw deny('READ_FENCED', 'Owner fence refused dispatch; control changed after observation');
    if (!SAFE_ID.test(receipt.receiptId ?? '')) throw deny('READ_FENCE_INVALID', 'Owner fence receipt identity is malformed');
    if (
      receipt.taskId !== observation.taskId ||
      receipt.workspaceId !== observation.workspaceId ||
      receipt.repositoryId !== observation.repositoryId ||
      receipt.revisionDigest !== observation.revisionDigest ||
      receipt.controlVersion !== observation.controlVersion ||
      receipt.fencingGeneration !== observation.fencingGeneration ||
      receipt.policyDigest !== observation.policyDigest
    ) {
      throw deny('READ_FENCE_MISMATCH', 'Owner fence receipt does not match the admitted observation');
    }
  }
}

export function createGuardedReadCapability(options: GuardedReadCapabilityOptions): ExecutionGuardReadCapability {
  return new FencedGuardedReadCapability(options);
}
