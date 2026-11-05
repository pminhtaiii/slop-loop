/**
 * Host-only observed action registry for specs/007 host-composition §3.
 *
 * The host registers an action at execution time together with the facts and
 * operator-facing elements it measured, then the approval layer observes it.
 * Everything observed is re-derived from this registry plus a fresh revision
 * measurement: the caller supplies identifiers only, never facts. Unknown,
 * replaced, expired or drifted actions observe as unavailable.
 *
 * This module performs no policy evaluation and issues no decision; UC-05 and
 * the existing real-context provider keep that authority.
 */
import type { PolicyIdentity } from '../contracts/approvals/contracts.ts';
import { computeActionDigest, computeCanonicalSha256, validateNormalizedAction } from '../contracts/foundation/uc03.ts';
import type { NormalizedAction } from '../contracts/foundation/uc03.ts';
import { freezePolicyData, isValidPolicyFacts } from '../approvals/policy-v01.ts';
import type { PolicyFacts } from '../approvals/policy.ts';
import type { PresentationInput } from '../approvals/presentation.ts';
import type { RealContextSource } from '../approvals/real-context-provider.ts';
import { dataRecord, decisionElements, identifier } from '../approvals/service-context.ts';
import { SHA256_HEX_REGEX } from '../foundation/docker-workspace-policy.ts';
import type { TrustedFilesystemPort } from '../foundation/repository-types.ts';

export type HostActionRefusal =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REGISTRATION'
  | 'IDENTITY_MISMATCH'
  | 'FABRICATED_FACTS'
  | 'MEASUREMENT_INVALID'
  | 'REPLACED_ACTION'
  | 'UNKNOWN_ACTION'
  | 'CROSS_TASK'
  | 'REVISION_DRIFT'
  | 'EXPIRED_AUTHORITY';

export class HostActionContextError extends Error {
  readonly code: HostActionRefusal;

  constructor(code: HostActionRefusal, message: string) {
    super(`${code}: ${message}`);
    this.name = 'HostActionContextError';
    this.code = code;
  }
}

export interface HostActionContextOptions {
  /** The host's own revision measurement; must be a real-provenance port, since only that supports a caller-claim-free 'real' context. */
  readonly filesystem: Pick<TrustedFilesystemPort, 'getCurrentRevisionDigest' | 'provenance'>;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly policyIdentity: PolicyIdentity;
  /** Registration lifetime. Longer waits must re-register from a fresh measurement. */
  readonly ttlMs: number;
  readonly now?: (() => number) | undefined;
}

/** The host's execution-time statement: the action plus the facts and elements it measured. */
export interface HostActionRegistration {
  readonly action: unknown;
  readonly facts: unknown;
  readonly elements: unknown;
}

export interface HostActionObservation {
  readonly action: NormalizedAction;
  readonly facts: PolicyFacts;
  readonly elements: PresentationInput['elements'];
}

/** Extending `RealContextSource` keeps the produced context usable wherever a source is accepted. */
export interface HostActionContext extends RealContextSource {
  readonly provenance: 'real';
  register(registration: HostActionRegistration): Promise<{ readonly actionId: string; readonly expiresAtEpochMs: number }>;
  observe(taskId: string, actionId: string): Promise<HostActionObservation>;
}

interface RegisteredAction {
  readonly taskId: string;
  readonly actionDigest: string;
  readonly observed: HostActionObservation;
  readonly revision: string;
  readonly expiresAtEpochMs: number;
  /** Set when the same identifier is registered again with different content or identity. */
  replaced: boolean;
}

function fail(code: HostActionRefusal, message: string): never {
  throw new HostActionContextError(code, message);
}

function requireIdentifier(value: unknown, field: string): string {
  if (!identifier(value)) fail('INVALID_CONFIGURATION', `${field} must be a bounded identifier`);
  return value;
}

function samePolicyIdentity(left: PolicyIdentity, right: PolicyIdentity): boolean {
  return left.policyId === right.policyId && left.policyVersion === right.policyVersion && left.configId === right.configId && left.configVersion === right.configVersion;
}

export function createHostActionContext(options: HostActionContextOptions): HostActionContext {
  if (!options || typeof options !== 'object') fail('INVALID_CONFIGURATION', 'options are required');
  const { filesystem } = options;
  if (!filesystem || typeof filesystem.getCurrentRevisionDigest !== 'function') {
    fail('INVALID_CONFIGURATION', 'a revision-measuring filesystem port is required');
  }
  if (filesystem.provenance !== 'real') fail('INVALID_CONFIGURATION', 'the filesystem port must have real provenance');
  const workspaceId = requireIdentifier(options.workspaceId, 'workspaceId');
  const repositoryId = requireIdentifier(options.repositoryId, 'repositoryId');
  const identity = options.policyIdentity;
  if (!dataRecord(identity)) fail('INVALID_CONFIGURATION', 'policyIdentity is required');
  const policyIdentity: PolicyIdentity = {
    policyId: requireIdentifier(identity['policyId'], 'policyIdentity.policyId'),
    policyVersion: requireIdentifier(identity['policyVersion'], 'policyIdentity.policyVersion'),
    configId: requireIdentifier(identity['configId'], 'policyIdentity.configId'),
    configVersion: requireIdentifier(identity['configVersion'], 'policyIdentity.configVersion'),
  };
  const ttlMs = options.ttlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail('INVALID_CONFIGURATION', 'ttlMs must be a positive safe integer');
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') fail('INVALID_CONFIGURATION', 'now must be a clock function');
  const registry = new Map<string, RegisteredAction>();

  const measureRevision = async (): Promise<string> => {
    const digest = await filesystem.getCurrentRevisionDigest();
    if (typeof digest !== 'string' || !SHA256_HEX_REGEX.test(digest)) fail('MEASUREMENT_INVALID', 'the filesystem returned a malformed revision digest');
    return digest;
  };

  const register = async (registration: HostActionRegistration): Promise<{ readonly actionId: string; readonly expiresAtEpochMs: number }> => {
    if (!registration || typeof registration !== 'object') fail('INVALID_REGISTRATION', 'a registration object is required');
    const action = validateNormalizedAction(registration.action);
    if (!action.ok) fail('INVALID_REGISTRATION', 'the registered action is not a normalized action');
    const facts = registration.facts;
    if (!isValidPolicyFacts(facts)) fail('INVALID_REGISTRATION', 'the registered facts are not valid policy facts');
    if (!decisionElements(registration.elements)) fail('INVALID_REGISTRATION', 'the registered elements are not decision elements');

    if (facts.workspaceId !== workspaceId || facts.repositoryId !== repositoryId) {
      fail('IDENTITY_MISMATCH', 'the registered facts name a different workspace or repository');
    }
    if (!samePolicyIdentity(facts.policyIdentity, policyIdentity)) fail('IDENTITY_MISMATCH', 'the registered facts name a different policy profile');
    const digest = computeActionDigest(action.value);
    if (facts.registeredActionDigest !== digest) fail('FABRICATED_FACTS', 'the claimed action digest is not the action the host was given');

    const revision = await measureRevision();
    if (facts.repositoryRevisionDigest !== revision) {
      fail('FABRICATED_FACTS', 'the claimed repository revision is not the revision the host measured');
    }

    const actionId = requireIdentifier(action.value.actionId, 'actionId');
    const taskId = facts.taskId;
    const existing = registry.get(actionId);
    if (existing) {
      // A repeated identical registration is the same fact; anything else swaps the action behind an id already observed.
      if (
        !existing.replaced &&
        existing.actionDigest === digest &&
        existing.taskId === taskId &&
        computeCanonicalSha256(existing.observed.facts) === computeCanonicalSha256(facts) &&
        computeCanonicalSha256(existing.observed.elements) === computeCanonicalSha256(registration.elements)
      ) {
        return { actionId, expiresAtEpochMs: existing.expiresAtEpochMs };
      }
      existing.replaced = true;
      fail('REPLACED_ACTION', `action '${actionId}' was already registered with different content or identity`);
    }

    const expiresAtEpochMs = now() + ttlMs;
    registry.set(actionId, {
      taskId,
      actionDigest: digest,
      observed: freezePolicyData(structuredClone({ action: action.value, facts, elements: registration.elements })),
      revision,
      expiresAtEpochMs,
      replaced: false,
    });
    return { actionId, expiresAtEpochMs };
  };

  const observe = async (taskId: string, actionId: string): Promise<HostActionObservation> => {
    const entry = identifier(actionId) && identifier(taskId) ? registry.get(actionId) : undefined;
    if (!entry) fail('UNKNOWN_ACTION', 'the action was never registered by the host');
    if (entry.taskId !== taskId) fail('CROSS_TASK', `action '${actionId}' is registered for a different task`);
    if (entry.replaced) fail('REPLACED_ACTION', `action '${actionId}' was replaced after registration`);
    if (now() >= entry.expiresAtEpochMs) fail('EXPIRED_AUTHORITY', `action '${actionId}' registration has expired`);
    // Continuation re-observes: facts recorded earlier are only reused while the tree they describe is unchanged.
    if ((await measureRevision()) !== entry.revision) fail('REVISION_DRIFT', `the repository changed since action '${actionId}' was registered`);
    return entry.observed;
  };

  return Object.freeze({ provenance: 'real' as const, register, observe });
}
