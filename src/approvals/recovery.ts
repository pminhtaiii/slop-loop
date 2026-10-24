import type { ApprovalService } from './service.ts';
import type { ApprovalBinding, NormalizedAction } from '../contracts/foundation/uc03.ts';
import type { ApprovalRequestRecord, ApprovalTaskControl, DispatchClaim, PolicyProfile } from '../contracts/approvals/contracts.ts';
import { isDeepStrictEqual } from 'node:util';
import { isProxy } from 'node:util/types';
import { validateApprovalRequestRecord, validateApprovalTaskControl, validateDispatchClaim, validatePolicyProfile, validateSafeResult } from '../contracts/approvals/contracts.ts';
import { computeActionDigest, validateNormalizedAction, validateReservationBundle } from '../contracts/foundation/uc03.ts';
import { containsProtectedContent } from '../foundation/repository-tools.ts';

/** Coordination evidence only: a claim ID or claim record never grants executor or generic activity authority. */
export function isExecutorCapability(_value: unknown): boolean {
  void _value;
  return false;
}

/** A retained owner snapshot; none of these fields are authority until admitted. */
export interface RecoverySnapshot { readonly control: unknown; readonly request: unknown; readonly action: unknown; readonly runId: unknown; readonly claims: unknown }
export interface RecoveryClaimInput { readonly taskId: string; readonly binding: ApprovalBinding; readonly action: NormalizedAction; readonly runId: string; readonly expectedControlVersion: number; readonly expectedEpoch: number }
export interface ApprovalRecoveryOwner {
  readonly provenance: 'mock';
  /** Explicit finite requirements selected by the mock execution owner for this continuation. */
  readonly reservationRequirements: readonly { readonly scope: 'task' | 'run'; readonly kind: string; readonly amount: number }[];
  load(decisionId: string): Promise<unknown>;
  claimDispatch(input: RecoveryClaimInput): Promise<unknown>;
}

/** Mock coordination evidence only. A claim ID never grants executor or generic activity authority. */
export interface ApprovalContinuation { admit(decisionId: string): Promise<{ readonly outcome: 'claimed' | 'blocked' | 'unavailable'; readonly claimId: string | null }> }

export function createApprovalContinuation(options: { readonly taskId: string; readonly profile: unknown; readonly approval: ApprovalService; readonly recovery: ApprovalRecoveryOwner }): ApprovalContinuation {
  const checked = safeData(options.profile) ? validatePolicyProfile(options.profile) : null;
  if (!checked?.ok || !identifier(options.taskId)) throw new Error('invalid-approval-recovery-profile');
  const profile = checked.value;
  const requirements = options.recovery.reservationRequirements;
  if (!safeData(requirements) || !Array.isArray(requirements) || requirements.length === 0 || requirements.some(item => !record(item) || !fields(item, ['scope', 'kind', 'amount']) ||
    item.scope !== 'task' && item.scope !== 'run' || !identifier(item.kind) || typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount <= 0 || item.kind !== 'cost' && !Number.isSafeInteger(item.amount)) ||
    new Set(requirements.map(item => `${item.scope}:${item.kind}`)).size !== requirements.length) throw new Error('invalid-approval-recovery-requirements');
  const expectedReservations = structuredClone(requirements);
  let closed = false;
  let busy = false;
  return { admit: async decisionId => {
    if (closed) return { outcome: 'unavailable', claimId: null };
    if (busy || !identifier(decisionId)) return { outcome: 'blocked', claimId: null };
    busy = true;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = (): void => { if (expired) throw new Error('approval-recovery-expired'); };
    try {
      return await Promise.race([Promise.resolve().then(async () => {
        if (options.recovery.provenance !== 'mock' || options.approval.provenance !== 'mock') throw new Error('approval-recovery-unavailable');
        const saved = snapshot(await options.recovery.load(decisionId), options.taskId, decisionId, profile);
        active();
        if (!saved) throw new Error('approval-recovery-unavailable');
        if (!eligible(saved)) return { outcome: 'blocked' as const, claimId: null };
        const binding = await options.approval.resolve(decisionId);
        active();
        if (binding.status !== 'approved' || !isDeepStrictEqual(binding, { ...saved.request.binding, status: 'approved' }) || !await options.approval.validateBinding(binding)) return { outcome: 'blocked' as const, claimId: null };
        active();
        const latest = snapshot(await options.recovery.load(decisionId), options.taskId, decisionId, profile);
        active();
        if (!latest) throw new Error('approval-recovery-unavailable');
        if (!eligible(latest) || !isDeepStrictEqual(saved, latest)) return { outcome: 'blocked' as const, claimId: null };
        // The owner serializes current freshness/control/accounting with the claim. Snapshot checks alone grant no authority.
        const raw = await options.recovery.claimDispatch({ taskId: options.taskId, binding, action: latest.action, runId: latest.runId,
          expectedControlVersion: latest.control.version, expectedEpoch: latest.control.epoch });
        active();
        const claim = claimReceipt(raw, latest, binding, profile, expectedReservations);
        if (!claim) throw new Error('approval-recovery-unconfirmed');
        const retained = snapshot(await options.recovery.load(decisionId), options.taskId, decisionId, profile);
        active();
        if (!retained || retained.control.mode !== 'runnable' || retained.control.epoch !== latest.control.epoch || retained.control.version !== latest.control.version + 1 ||
          !isDeepStrictEqual(retained.control.outstandingClaimRefs, [claim.claimId]) || !isDeepStrictEqual(retained.action, latest.action) ||
          !isDeepStrictEqual(retained.request, latest.request) || retained.runId !== latest.runId || retained.claims.length !== latest.claims.length + 1 ||
          ![...latest.claims, claim].every(previous => retained.claims.some(value => isDeepStrictEqual(value, previous)))) throw new Error('approval-recovery-unconfirmed');
        return { outcome: 'claimed' as const, claimId: claim.claimId };
      }), new Promise<{ readonly outcome: 'unavailable'; readonly claimId: null }>(resolve => {
        timer = setTimeout(() => { expired = true; closed = true; resolve({ outcome: 'unavailable', claimId: null }); }, profile.operationDeadlineMs);
      })]);
    } catch {
      closed = true;
      return { outcome: 'unavailable', claimId: null };
    } finally { expired = true; busy = false; if (timer !== undefined) clearTimeout(timer); }
  } };
}

interface AdmittedSnapshot { readonly control: ApprovalTaskControl; readonly request: ApprovalRequestRecord; readonly action: NormalizedAction; readonly runId: string; readonly claims: readonly DispatchClaim[] }
function snapshot(raw: unknown, taskId: string, decisionId: string, profile: PolicyProfile): AdmittedSnapshot | null {
  if (!safeData(raw) || !record(raw) || !fields(raw, ['control', 'request', 'action', 'runId', 'claims'])) return null;
  const control = validateApprovalTaskControl(raw['control']);
  const request = validateApprovalRequestRecord(raw['request']);
  const action = validateNormalizedAction(raw['action']);
  const claims = raw['claims'];
  if (!control.ok || !request.ok || !action.ok || !identifier(raw['runId']) || !Array.isArray(claims) || !claims.every(value => validateDispatchClaim(value).ok) ||
    control.value.taskId !== taskId || request.value.taskId !== taskId || request.value.decisionId !== decisionId ||
    request.value.repositoryId !== control.value.repositoryId || request.value.workspaceId !== control.value.workspaceId ||
    request.value.actionRef !== action.value.actionId || request.value.actionDigest !== computeActionDigest(action.value) || request.value.binding.normalizedActionDigest !== computeActionDigest(action.value) ||
    request.value.policyId !== profile.policyIdentity.policyId || request.value.policyVersion !== profile.policyIdentity.policyVersion ||
    request.value.configId !== profile.policyIdentity.configId || request.value.configVersion !== profile.policyIdentity.configVersion ||
    claims.some(value => value.taskId !== taskId) || new Set(claims.map(value => value.claimId)).size !== claims.length ||
    !isDeepStrictEqual([...control.value.outstandingClaimRefs].sort(), claims.filter(value => ['claimed', 'dispatched', 'uncertain'].includes(value.phase)).map(value => value.claimId).sort())) return null;
  // Every claim was admitted above, before this local narrowing.
  return { control: control.value, request: request.value, action: action.value, runId: raw['runId'], claims: claims as readonly DispatchClaim[] };
}
function eligible(saved: AdmittedSnapshot): boolean {
  return saved.control.mode === 'runnable' && saved.control.pendingDecisionId === null && saved.control.outstandingClaimRefs.length === 0 &&
    !saved.claims.some(claim => claim.actionId === saved.action.actionId || claim.decisionRefs.includes(saved.request.decisionId));
}
function claimReceipt(raw: unknown, saved: AdmittedSnapshot, binding: ApprovalBinding, profile: PolicyProfile, requirements: ApprovalRecoveryOwner['reservationRequirements']): DispatchClaim | null {
  if (!safeData(raw) || !record(raw) || !fields(raw, ['safe', 'claim', 'control', 'reservations'])) return null;
  const safe = validateSafeResult(raw['safe']);
  const control = validateApprovalTaskControl(raw['control']);
  const claim = validateDispatchClaim(raw['claim']);
  const bundle = validateReservationBundle(raw['reservations']);
  if (!safe.ok || safe.value.outcome !== 'ok' || !control.ok || !claim.ok || !bundle.ok) return null;
  const value = claim.value;
  const reservations = bundle.value;
  const keys = reservations.reservations.map(item => `${item.scope}:${item.kind}`);
  if (safe.value.taskId !== saved.control.taskId || safe.value.controlVersion !== saved.control.version + 1 || safe.value.decisionId !== null || safe.value.requestVersion !== null || !identifier(safe.value.eventRef) ||
    control.value.taskId !== saved.control.taskId || control.value.repositoryId !== saved.control.repositoryId || control.value.workspaceId !== saved.control.workspaceId ||
    control.value.version !== saved.control.version + 1 || control.value.epoch !== saved.control.epoch || control.value.mode !== 'runnable' ||
    !isDeepStrictEqual(control.value.outstandingClaimRefs, [value.claimId]) || value.taskId !== saved.control.taskId || value.actionId !== saved.action.actionId ||
    value.expectedControlVersion !== saved.control.version || value.expectedEpoch !== saved.control.epoch || value.repositoryStateDigest !== binding.repositoryRevisionDigest ||
    !isDeepStrictEqual(value.policyIdentity, profile.policyIdentity) || !isDeepStrictEqual(value.decisionRefs, [binding.decisionId]) ||
    value.phase !== 'claimed' || value.resultRef !== null || !isDeepStrictEqual(value.reservationRefs, [reservations.bundleId]) || reservations.taskId !== saved.control.taskId || reservations.runId !== saved.runId ||
    new Set(keys).size !== keys.length || keys.length !== requirements.length || !requirements.every(required => reservations.reservations.some(item => item.scope === required.scope && item.kind === required.kind && item.amount === required.amount)) ||
    new Set(reservations.reservations.map(item => item.requestId)).size !== 1 ||
    reservations.reservations.some(item => item.configurationId !== profile.policyIdentity.configId || item.amount <= 0)) return null;
  return value;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/u.test(value); }
function safeData(value: unknown): boolean { return plainData(value) && !containsProtectedContent(JSON.stringify(value)); }
function plainData(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 65536;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || isProxy(value) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value) && (value.length > 256 || !Array.from({ length: value.length }, (_, index) => Object.hasOwn(descriptors, String(index))).every(Boolean))) return false;
  return Reflect.ownKeys(descriptors).length <= 256 && Reflect.ownKeys(descriptors).every(key => {
    const descriptor = typeof key === 'string' ? descriptors[key] : undefined;
    return descriptor !== undefined && 'value' in descriptor && (descriptor.enumerable || Array.isArray(value) && key === 'length') && plainData(descriptor.value, depth + 1);
  });
}

export { createApprovalContinuationV02 } from './recovery-v02.ts';
export type { ApprovalContinuationV02, ApprovalContinuationResultV02 } from './recovery-v02.ts';
