import { isDeepStrictEqual } from 'node:util';
import { isProxy } from 'node:util/types';
import type { ClaimClosureReceipt, DispatchClaimV02 } from '../contracts/approvals/contracts.ts';
import { UC05_APPROVAL_SCHEMA_VERSION_V02 } from '../contracts/approvals/contracts.ts';
import { computeCanonicalSha256 } from '../contracts/foundation/uc03.ts';
import type {
  ClaimClosureReceiptV02 as JournalClaimClosureReceiptV02,
  ClaimReceiptV02 as JournalClaimReceiptV02,
  ExecutorIdentityV02,
  PolicyAuthorityRefV02,
  SafeReferenceV02,
} from '../contracts/foundation/uc03/ports-v02.ts';

export interface AuthorityPublicationOptionsV02 {
  readonly authorityRef: PolicyAuthorityRefV02;
  readonly effectiveAt?: string;
}
export interface AuthorityPublicationReceiptV02 {
  readonly schemaVersion: 'uc05-approval/0.2-draft';
  readonly publicationId: string;
  readonly publicationDigest: string;
  readonly authorityRef: PolicyAuthorityRefV02;
  readonly generation: number;
  readonly status: 'published' | 'stale' | 'conflict';
}
export interface CloseUnattemptedClaimInputV02 {
  readonly claim: DispatchClaimV02;
  readonly journalClaim: JournalClaimReceiptV02;
  readonly recipientIdentity: ExecutorIdentityV02;
  readonly pauseOrDenialEvent: ClaimClosureReceipt['pauseOrDenialEvent'];
}
export interface UC04JournalPortV02 {
  readonly provenance?: 'mock' | 'real';
  publishAuthority?(options: AuthorityPublicationOptionsV02): Promise<unknown>;
  setTaskControl?(taskId: string, mode: 'paused' | 'rejected', eventRef: string): Promise<unknown>;
  loadTask?(taskId: string): Promise<unknown>;
  getJournalSnapshot?(): unknown;
  fenceClaimRecipient?(claimId: string, recipientIdentity: ExecutorIdentityV02): Promise<unknown>;
  closeUnattemptedClaim?(receipt: JournalClaimClosureReceiptV02): Promise<unknown>;
}
export interface ApprovalControlV02 {
  publishAuthority(options: AuthorityPublicationOptionsV02): Promise<{
    readonly outcome: 'ok' | 'stale' | 'conflict' | 'paused';
    readonly receipt: AuthorityPublicationReceiptV02 | null;
  }>;
  closeUnattemptedClaim(input: CloseUnattemptedClaimInputV02): Promise<{
    readonly closed: boolean;
    readonly receipt: ClaimClosureReceipt | null;
  }>;
}
export type JournalClaimV02 = JournalClaimReceiptV02;
export interface JournalSnapshotV02 {
  readonly controlVersion: number;
  readonly epoch: number;
  readonly mode: 'runnable' | 'paused' | 'rejected' | 'ended' | 'recovery';
  readonly holdRef: string | null;
  readonly holdEventDigest: string | null;
  readonly activeClaimId: string | null;
  readonly activeAuthorityRef: PolicyAuthorityRefV02 | null;
  readonly claims: readonly { readonly claimId: string; readonly status: string; readonly attemptId: string | null }[];
  readonly attempts: readonly { readonly attemptId: string; readonly claimId: string; readonly status: string; readonly outcomeReceiptId: string | null }[];
  readonly closures: readonly { readonly receiptId: string; readonly claimId: string; readonly receiptDigest: string }[];
  readonly controlEventRefs: readonly string[];
  readonly fenceProofs: readonly { readonly claimId: string; readonly proofRef: SafeReferenceV02; readonly fencingGeneration: number; readonly holdRef: string; readonly controlVersion: number; readonly epoch: number }[];
  readonly fencedIncarnations: readonly string[];
}
export interface FenceProofV02 {
  readonly claimId: string;
  readonly claimDigest: string;
  readonly taskId: string;
  readonly recipientIdentity: ExecutorIdentityV02;
  readonly fencedExecutorIdentity: ExecutorIdentityV02;
  readonly fencingGeneration: number;
  readonly proofRef: SafeReferenceV02;
  readonly adapterEvidenceRefs: readonly SafeReferenceV02[];
  readonly holdRef: string;
  readonly controlVersion: number;
  readonly epoch: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/u;
const SHA = /^sha256:[0-9a-f]{64}$/u;
const AUTHORITY_KEYS = ['policyId', 'policyVersion', 'configId', 'configVersion', 'issuerKeyRef', 'decisionAuthorityGeneration'] as const;
const CLAIM_KEYS = ['claimId', 'claimDigest', 'taskId', 'runId', 'subjectKind', 'planApplicability', 'preClaimTaskStateVersion', 'preClaimControlVersion', 'postClaimControlVersion', 'epoch', 'status', 'reservationRefs'] as const;
const SNAPSHOT_KEYS = ['controlVersion', 'epoch', 'mode', 'holdRef', 'holdEventDigest', 'activeClaimId', 'activeAuthorityRef', 'claims', 'attempts', 'outcomes', 'reconciliations', 'closures', 'authorityPublications', 'controlEventRefs', 'fenceProofs', 'recoveryEvidencePredecessorReceiptIds', 'fencedIncarnations'] as const;
const FENCE_KEYS = ['claimId', 'claimDigest', 'taskId', 'recipientIdentity', 'fencedExecutorIdentity', 'fencingGeneration', 'proofRef', 'adapterEvidenceRefs', 'holdRef', 'controlVersion', 'epoch'] as const;

export function dataMethodV02(target: unknown, key: string): ((...args: unknown[]) => unknown) | null {
  if (target === null || typeof target !== 'object') return null;
  try {
    let owner: object | null = target;
    for (let depth = 0; owner && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function' ? descriptor.value.bind(target) as (...args: unknown[]) => unknown : null;
      owner = Object.getPrototypeOf(owner) as object | null;
    }
  } catch { return null; }
  return null;
}
export function dataPropertyV02(target: unknown, key: string): unknown {
  if (target === null || typeof target !== 'object') return undefined;
  try {
    let owner: object | null = target;
    for (let depth = 0; owner && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
      owner = Object.getPrototypeOf(owner) as object | null;
    }
  } catch { return undefined; }
  return undefined;
}
export function safeDataV02(input: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (input === null || input === undefined || typeof input === 'boolean') return true;
  if (typeof input === 'string') return input.length <= 8192;
  if (typeof input === 'number') return Number.isFinite(input);
  if (typeof input !== 'object') return false;
  try {
    if (isProxy(input)) return false;
    const prototype = Object.getPrototypeOf(input);
    const array = Array.isArray(input);
    if (array ? prototype !== Array.prototype || input.length > 512 : prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 512) return false;
    return keys.every(key => {
      if (typeof key !== 'string') return false;
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) return false;
      if (array && key === 'length') return Number.isSafeInteger(descriptor.value) && descriptor.value === input.length;
      return descriptor.enumerable && (!array || /^(0|[1-9][0-9]*)$/u.test(key)) && safeDataV02(descriptor.value, depth + 1);
    }) && (!array || keys.length === input.length + 1 && Array.from({ length: input.length }, (_, index) => Object.hasOwn(descriptors, String(index))).every(Boolean));
  } catch { return false; }
}
export function plainRecordV02(input: unknown, allowed?: readonly string[]): Record<string, unknown> | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string')) return null;
    const result: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || (allowed && !allowed.includes(key))) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return null; }
}
export function exactKeysV02(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key));
}
export function isIdV02(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
export function isDigestV02(value: unknown): value is string { return typeof value === 'string' && SHA.test(value); }
export function isVersionV02(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
export function isPositiveVersionV02(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }

export function authorityRefV02(input: unknown): PolicyAuthorityRefV02 | null {
  if (!safeDataV02(input)) return null;
  const value = plainRecordV02(input, AUTHORITY_KEYS);
  if (!value || !exactKeysV02(value, AUTHORITY_KEYS) || !AUTHORITY_KEYS.slice(0, 5).every(key => isIdV02(value[key])) || !isPositiveVersionV02(value['decisionAuthorityGeneration'])) return null;
  return value as unknown as PolicyAuthorityRefV02;
}
export function validatePublicationV02(input: unknown, requested: PolicyAuthorityRefV02, effectiveAt: string | undefined): AuthorityPublicationReceiptV02 | null {
  if (!safeDataV02(input)) return null;
  const keys = ['schemaVersion', 'publicationId', 'publicationDigest', 'authorityRef', 'generation', 'status'] as const;
  const value = plainRecordV02(input, keys);
  if (!value || !exactKeysV02(value, keys)) return null;
  const publicationId = 'pub-' + requested.policyId + '-' + requested.decisionAuthorityGeneration;
  const status = value['status'];
  const expectedDigest = computeCanonicalSha256(status === 'published'
    ? { publicationId, authorityRef: requested, effectiveAt }
    : { publicationId, authorityRef: requested });
  const returnedAuthority = authorityRefV02(value['authorityRef']);
  if (value['schemaVersion'] !== UC05_APPROVAL_SCHEMA_VERSION_V02 || value['publicationId'] !== publicationId ||
    value['publicationDigest'] !== expectedDigest || value['generation'] !== requested.decisionAuthorityGeneration ||
    !returnedAuthority || !isDeepStrictEqual(returnedAuthority, requested) ||
    status !== 'published' && status !== 'stale' && status !== 'conflict') return null;
  return value as unknown as AuthorityPublicationReceiptV02;
}
export async function publishAuthorityV02(taskId: string, journal: UC04JournalPortV02 | undefined, input: AuthorityPublicationOptionsV02): Promise<{
  readonly outcome: 'ok' | 'stale' | 'conflict' | 'paused';
  readonly receipt: AuthorityPublicationReceiptV02 | null;
}> {
  try {
    if (!isIdV02(taskId) || !safeDataV02(input) || dataPropertyV02(journal, 'provenance') !== 'mock') return { outcome: 'paused', receipt: null };
    const fields = plainRecordV02(input, ['authorityRef', 'effectiveAt']);
    if (!fields || Object.keys(fields).some(key => key !== 'authorityRef' && key !== 'effectiveAt') ||
      fields['effectiveAt'] !== undefined && (typeof fields['effectiveAt'] !== 'string' || fields['effectiveAt'].length > 128)) return { outcome: 'paused', receipt: null };
    const requested = authorityRefV02(fields['authorityRef']);
    const publish = dataMethodV02(journal, 'publishAuthority');
    if (!requested || !publish) return { outcome: 'paused', receipt: null };
    const effectiveAt = fields['effectiveAt'] as string | undefined;
    const args = { authorityRef: requested, ...(effectiveAt !== undefined ? { effectiveAt } : {}) };
    const receipt = validatePublicationV02(await publish(args), requested, effectiveAt);
    if (!receipt) return { outcome: 'paused', receipt: null };
    if (receipt.status === 'stale') return { outcome: 'stale', receipt };
    if (receipt.status === 'conflict') return { outcome: 'conflict', receipt };
    return { outcome: 'ok', receipt };
  } catch { return { outcome: 'paused', receipt: null }; }
}
export function executorIdentityV02(input: unknown): ExecutorIdentityV02 | null {
  if (!safeDataV02(input)) return null;
  const keys = ['adapterIdentity', 'processIncarnation', 'fencingGeneration', 'payloadDigest'] as const;
  const value = plainRecordV02(input, keys);
  if (!value || !exactKeysV02(value, keys) || !isIdV02(value['adapterIdentity']) || !isIdV02(value['processIncarnation']) ||
    !isPositiveVersionV02(value['fencingGeneration']) || !isDigestV02(value['payloadDigest'])) return null;
  return value as unknown as ExecutorIdentityV02;
}
export function journalClaimV02(input: unknown): JournalClaimReceiptV02 | null {
  if (!safeDataV02(input)) return null;
  const value = plainRecordV02(input, CLAIM_KEYS);
  if (!value || !exactKeysV02(value, CLAIM_KEYS)) return null;
  const refs = value['reservationRefs'];
  if (!Array.isArray(refs) || refs.length === 0 || !refs.every(isIdV02) || new Set(refs).size !== refs.length ||
    !isIdV02(value['claimId']) || !isDigestV02(value['claimDigest']) || !isIdV02(value['taskId']) || !isIdV02(value['runId']) ||
    value['subjectKind'] !== 'repository-action' && value['subjectKind'] !== 'provider-request' ||
    value['planApplicability'] !== 'pre-plan-diagnostic' && value['planApplicability'] !== 'approved-plan' ||
    !isVersionV02(value['preClaimTaskStateVersion']) || !isPositiveVersionV02(value['preClaimControlVersion']) ||
    value['postClaimControlVersion'] !== (value['preClaimControlVersion'] as number) + 1 ||
    !isPositiveVersionV02(value['postClaimControlVersion']) || !isPositiveVersionV02(value['epoch']) || value['status'] !== 'claimed' ||
    value['claimDigest'] !== computeCanonicalSha256({ ...value, claimDigest: undefined })) return null;
  return value as unknown as JournalClaimV02;
}
export function safeReferenceV02(input: unknown): SafeReferenceV02 | null {
  if (!safeDataV02(input)) return null;
  const keys = ['reference', 'digest'] as const;
  const value = plainRecordV02(input, keys);
  if (!value || !exactKeysV02(value, keys) || !isIdV02(value['reference']) || !isDigestV02(value['digest'])) return null;
  return value as unknown as SafeReferenceV02;
}
export function journalSnapshotV02(input: unknown): JournalSnapshotV02 | null {
  if (!safeDataV02(input)) return null;
  const value = plainRecordV02(input, SNAPSHOT_KEYS);
  if (!value || !exactKeysV02(value, SNAPSHOT_KEYS) || !isVersionV02(value['controlVersion']) || !isPositiveVersionV02(value['epoch']) ||
    !['runnable', 'paused', 'rejected', 'ended', 'recovery'].includes(String(value['mode'])) ||
    (value['holdRef'] !== null && !isIdV02(value['holdRef'])) ||
    (value['holdRef'] === null ? value['holdEventDigest'] !== null : !isDigestV02(value['holdEventDigest'])) ||
    (value['activeClaimId'] !== null && !isIdV02(value['activeClaimId']))) return null;
  const rows = (key: string, allowed: readonly string[]): Record<string, unknown>[] | null => {
    const inputRows = value[key];
    if (!Array.isArray(inputRows)) return null;
    const result = inputRows.map(item => plainRecordV02(item, allowed));
    return result.every(row => row && exactKeysV02(row, allowed)) ? result as Record<string, unknown>[] : null;
  };
  const claims = rows('claims', ['claimId', 'status', 'attemptId']);
  const attempts = rows('attempts', ['attemptId', 'claimId', 'status', 'outcomeReceiptId']);
  const outcomes = rows('outcomes', ['receiptId', 'claimId', 'attemptId', 'outcome', 'receiptDigest']);
  const reconciliations = rows('reconciliations', ['reconciliationId', 'claimId', 'attemptId', 'predecessorReceiptId', 'receiptDigest']);
  const closures = rows('closures', ['receiptId', 'claimId', 'receiptDigest']);
  const publications = rows('authorityPublications', ['publicationId', 'publicationDigest', 'generation']);
  const fences = rows('fenceProofs', ['claimId', 'proofRef', 'fencingGeneration', 'holdRef', 'controlVersion', 'epoch']);
  const refs = value['controlEventRefs'];
  const incarnations = value['fencedIncarnations'];
  const evidenceRefs = value['recoveryEvidencePredecessorReceiptIds'];
  if (!claims || !attempts || !outcomes || !reconciliations || !closures || !publications || !fences ||
    !Array.isArray(refs) || !refs.every(isIdV02) ||
    !Array.isArray(incarnations) || !incarnations.every(item => typeof item === 'string') ||
    !Array.isArray(evidenceRefs) || !evidenceRefs.every(isIdV02) ||
    !claims.every(row => isIdV02(row['claimId']) && typeof row['status'] === 'string' && (row['attemptId'] === null || isIdV02(row['attemptId']))) ||
    !attempts.every(row => isIdV02(row['attemptId']) && isIdV02(row['claimId']) && typeof row['status'] === 'string' && (row['outcomeReceiptId'] === null || isIdV02(row['outcomeReceiptId']))) ||
    !outcomes.every(row => isIdV02(row['receiptId']) && isIdV02(row['claimId']) && isIdV02(row['attemptId']) &&
      typeof row['outcome'] === 'string' && isDigestV02(row['receiptDigest'])) ||
    !reconciliations.every(row => isIdV02(row['reconciliationId']) && isIdV02(row['claimId']) && isIdV02(row['attemptId']) &&
      isIdV02(row['predecessorReceiptId']) && isDigestV02(row['receiptDigest'])) ||
    !closures.every(row => isIdV02(row['receiptId']) && isIdV02(row['claimId']) && isDigestV02(row['receiptDigest'])) ||
    !publications.every(row => isIdV02(row['publicationId']) && isDigestV02(row['publicationDigest']) && isPositiveVersionV02(row['generation'])) ||
    !fences.every(row => isIdV02(row['claimId']) && safeReferenceV02(row['proofRef']) && isPositiveVersionV02(row['fencingGeneration']) && isIdV02(row['holdRef']) && isVersionV02(row['controlVersion']) && isPositiveVersionV02(row['epoch']))) return null;
  if (value['activeAuthorityRef'] !== null && !authorityRefV02(value['activeAuthorityRef'])) return null;
  return value as unknown as JournalSnapshotV02;
}
export function fenceProofV02(input: unknown): FenceProofV02 | null {
  if (!safeDataV02(input)) return null;
  const value = plainRecordV02(input, FENCE_KEYS);
  if (!value || !exactKeysV02(value, FENCE_KEYS)) return null;
  const recipient = executorIdentityV02(value['recipientIdentity']);
  const fenced = executorIdentityV02(value['fencedExecutorIdentity']);
  const proofRef = safeReferenceV02(value['proofRef']);
  const evidence = value['adapterEvidenceRefs'];
  if (!recipient || !fenced || !proofRef || !Array.isArray(evidence) || !evidence.length || !evidence.every(item => safeReferenceV02(item)) ||
    !isIdV02(value['claimId']) || !isDigestV02(value['claimDigest']) || !isIdV02(value['taskId']) || !isPositiveVersionV02(value['fencingGeneration']) ||
    !isIdV02(value['holdRef']) || !isPositiveVersionV02(value['controlVersion']) || !isPositiveVersionV02(value['epoch'])) return null;
  return value as unknown as FenceProofV02;
}
export function matchesClaimV02(claim: DispatchClaimV02, journal: JournalClaimV02): boolean {
  return claim.phase === 'claimed' && claim.resultRef === null && claim.claimId === journal.claimId && claim.taskId === journal.taskId &&
    claim.runId === journal.runId && claim.subjectKind === journal.subjectKind && claim.planApplicability === journal.planApplicability &&
    claim.expectedTaskStateVersion === journal.preClaimTaskStateVersion && claim.expectedControlVersion === journal.preClaimControlVersion &&
    claim.expectedEpoch === journal.epoch && isDeepStrictEqual(claim.reservationRefs, journal.reservationRefs);
}
