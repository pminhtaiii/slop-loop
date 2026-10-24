import { safeSnapshot } from '../contracts/foundation/uc03/admission-v02/snapshot.ts';
import { validateProviderRequestOutcomeReceiptV02 } from '../contracts/foundation/uc03/attempt-v02.ts';
import { providerClaim, providerAttempt, sameProviderActor } from './provider-admission.ts';
/**
 * UC-03 Host Model Ingress v0.2 (Amendment: T051/T052)
 *
 * Implements versioned ModelPortV02 with UC-04 journal claim, attempt,
 * receiver-local one-shot boundary gate, and outcome receipt recording.
 *
 * Owned path: src/foundation/model-v02.ts
 * Feature: specs/001-verified-code-repair
 */

import {
  type ModelPortV02,
  type StatePortV02,
  type ProviderAdmissionContextV02,
  type ClaimReceiptV02,
  type AttemptReceiptV02,
  type ProviderRequestOutcomeReceiptV02,
  type ExecutorIdentityV02,
  type PortProvenance,
  type TaskState,
  type SourceEvidence,
  type ProviderRequest,
  type ProviderUsage,
  type ValidationError,
  computeCanonicalSha256,
  computeAdmissionDigest,
  computeAttemptOutcomeDigest,
  computeRequestContentDigest,
} from '../contracts/foundation/uc03.ts';
import {
  deepClone,
  deepFreeze,
  validateBaseModelInputs,
  buildTransportPayload,
  executeTransport,
  type HostModelTransport,
  type HostProviderConfig,
} from './model.ts';

export interface HostModelPortV02Options {
  readonly transport: HostModelTransport;
  readonly statePort: StatePortV02;
  readonly providerConfig?: HostProviderConfig | undefined;
  readonly executorIdentity?: Partial<ExecutorIdentityV02> | undefined;
  readonly currentExecutorIdentity?: (() => Partial<ExecutorIdentityV02>) | undefined;
}

export interface ModelPortV02Result {
  readonly outcome: 'observed' | 'uncertain' | 'denied' | 'invalid';
  readonly result?: unknown;
  readonly observedUsage?: ProviderUsage | undefined;
  readonly reason?: string | undefined;
  readonly errors?: readonly ValidationError[] | undefined;
  readonly recovery?: ProviderRecoveryEvidence | undefined;
}

export interface ProviderRecoveryEvidence {
  readonly admission: ProviderAdmissionContextV02;
  readonly claim: ClaimReceiptV02;
  readonly attempt: AttemptReceiptV02;
  readonly receipt: ProviderRequestOutcomeReceiptV02;
}

export function buildProviderOutcomeReceipt(
  context: ProviderAdmissionContextV02,
  claim: ClaimReceiptV02,
  attempt: AttemptReceiptV02,
  outcome: 'observed' | 'uncertain',
  rawPayload: unknown,
  observedUsage?: ProviderUsage
): ProviderRequestOutcomeReceiptV02 {
  const references = [context.requestReservationReceipt, ...context.budgetRefs];
  const receiptId = `prov-out-${attempt.attemptId}`;
  const resultRef = { reference: `res-${attempt.attemptId}`, digest: computeCanonicalSha256(rawPayload) };
  const evidenceRefs = [{ reference: `ev-${attempt.attemptId}`, digest: computeCanonicalSha256(rawPayload) }];

  const raw: Record<string, unknown> = {
    receiptId,
    receiptDigest: 'sha256:placeholder',
    claimId: claim.claimId,
    claimDigest: claim.claimDigest,
    attemptId: attempt.attemptId,
    executorIdentity: attempt.executorIdentity,
    admissionDigest: computeAdmissionDigest(context),
    versions: {
      taskStateSchemaVersion: context.taskStateSchemaVersion,
      controlSchemaVersion: context.controlSchemaVersion,
      preClaimTaskStateVersion: claim.preClaimTaskStateVersion,
      postClaimTaskStateVersion: claim.preClaimTaskStateVersion,
      postAttemptTaskStateVersion: attempt.postBeginTaskStateVersion,
      preClaimControlVersion: claim.preClaimControlVersion,
      postClaimControlVersion: claim.postClaimControlVersion,
      postAttemptControlVersion: attempt.postBeginControlVersion,
      epoch: context.expectedEpoch,
    },
    resultRef,
    evidenceRefs,
    proposedEffects: {
      taskTransition: { kind: 'none' },
      revision: { kind: 'not-applicable' },
      invalidatedEvidence: [],
      accounting: {
        disposition: outcome === 'observed' ? 'settle' : 'hold',
        reservationRefs: references,
        ...(observedUsage !== undefined ? { observedUsage } : {}),
      },
    },
    subjectKind: 'provider-request',
    planApplicability: context.planApplicability,
    providerRequestId: context.providerRequestId,
    requestContentDigest: context.requestContentDigest,
    role: context.role,
    outcome,
    providerAdmissionReceiptRef: context.providerAdmissionReceipt.receiptId,
    providerAdmissionReceiptDigest: context.providerAdmissionReceipt.receiptDigest,
    requestReservationReceiptRef: context.requestReservationReceipt,
    providerIdentity: context.providerIdentity,
    budgetRefs: [...context.budgetRefs],
    ...(observedUsage !== undefined ? { observedUsage } : {}),
    ...(context.planApplicability === 'approved-plan'
      ? {
          planBindingDigest: context.planBindingDigest,
          planDecisionRef: context.planDecisionRef,
          ...(context.diagnosticPurpose !== undefined ? { diagnosticPurpose: context.diagnosticPurpose } : {}),
          ...(context.taskCriteriaDigest !== undefined ? { taskCriteriaDigest: context.taskCriteriaDigest } : {}),
        }
      : {
          diagnosticPurpose: context.diagnosticPurpose,
          taskCriteriaDigest: context.taskCriteriaDigest,
        }),
  };

  return {
    ...raw,
    receiptDigest: computeAttemptOutcomeDigest(raw),
  } as unknown as ProviderRequestOutcomeReceiptV02;
}

// Shared by reconstructed receivers in this process; UC-04 owns durable consumption.
const consumedAttempts = new Set<string>();

/**
 * Versioned ModelPortV02 ingress for both coder and reviewer roles (T051/T052).
 */
export class HostModelPortV02 implements ModelPortV02 {
  readonly provenance: PortProvenance = 'mock';
  readonly options: HostModelPortV02Options;
  private readonly completedRequests = new Map<string, { readonly identity: string; readonly result: Promise<ModelPortV02Result> }>();
  private readonly requestIdentities = new Map<string, string>();


  constructor(options: HostModelPortV02Options) {
    this.options = options;
  }

  async propose(
    state: TaskState,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest,
    context: ProviderAdmissionContextV02
  ): Promise<ModelPortV02Result> {
    const snapshotState = deepFreeze(deepClone(state));
    const snapshotEvidence = deepFreeze(deepClone(evidence));
    const snapshotRequest = deepFreeze(deepClone(request));
    const snapshotContext = deepFreeze(deepClone(context));
    const snapshotConfig =
      this.options.providerConfig !== undefined
        ? deepFreeze(deepClone(this.options.providerConfig))
        : undefined;

    const baseValidation = validateBaseModelInputs(snapshotState, snapshotEvidence, snapshotRequest, snapshotConfig);
    if (!baseValidation.ok) {
      return { outcome: baseValidation.outcome, errors: baseValidation.errors };
    }

    if (!snapshotContext || typeof snapshotContext !== 'object' || snapshotContext.subjectKind !== 'provider-request') {
      return { outcome: 'denied', reason: 'INVALID_ADMISSION_CONTEXT: Context must be a provider-request admission context' };
    }
    if (snapshotContext.taskId !== snapshotState.taskId || snapshotContext.runId !== snapshotState.runId) {
      return { outcome: 'denied', reason: 'CONTEXT_IDENTITY_MISMATCH: Context taskId/runId mismatch' };
    }
    if (snapshotContext.providerRequestId !== snapshotRequest.providerRequestId) {
      return { outcome: 'denied', reason: 'REQUEST_ID_MISMATCH: Context providerRequestId does not match request' };
    }
    if (snapshotContext.role !== snapshotRequest.role) {
      return { outcome: 'denied', reason: 'ROLE_MISMATCH: Context role does not match request role' };
    }
    if (
      !snapshotContext.providerAdmissionReceipt ||
      snapshotContext.providerAdmissionReceipt.role !== snapshotRequest.role ||
      snapshotContext.providerAdmissionReceipt.providerRequestId !== snapshotRequest.providerRequestId
    ) {
      return { outcome: 'denied', reason: 'RECEIPT_ROLE_MISMATCH: Admission receipt role or requestId mismatch' };
    }
    const computedReqDigest = computeRequestContentDigest(snapshotRequest);
    if (
      snapshotContext.requestContentDigest !== computedReqDigest ||
      snapshotContext.providerAdmissionReceipt.requestContentDigest !== computedReqDigest
    ) {
      return { outcome: 'denied', reason: 'REQUEST_DIGEST_MISMATCH: Request content digest mismatch' };
    }

    if (computeCanonicalSha256(snapshotContext.providerRequest) !== computeCanonicalSha256(snapshotRequest)) {
      return { outcome: 'denied', reason: 'REQUEST_ENVELOPE_MISMATCH' };
    }
    const identity = computeCanonicalSha256({ request: snapshotRequest, admission: snapshotContext });
    const requestIdentity = computeProviderRequestIdentity(snapshotRequest, snapshotContext);
    const priorRequestIdentity = this.requestIdentities.get(snapshotRequest.providerRequestId);
    if (priorRequestIdentity && priorRequestIdentity !== requestIdentity) {
      return { outcome: 'denied', reason: 'REPLAY_IDENTITY_MISMATCH' };
    }
    const cached = this.completedRequests.get(snapshotRequest.providerRequestId);
    if (cached) {
      if (cached.identity !== identity) return { outcome: 'denied', reason: 'REPLAY_IDENTITY_MISMATCH' };
      return cached.result;
    }
    this.requestIdentities.set(snapshotRequest.providerRequestId, requestIdentity);
    // Publish the in-flight entry before admission can yield or reenter this receiver.
    let provenPreClaimDenial = false;
    const result = Promise.resolve()
      .then(() => this.dispatch(snapshotState, snapshotEvidence, snapshotRequest, snapshotContext, () => { provenPreClaimDenial = true; }))
      .then((value) => {
        if (provenPreClaimDenial) {
          const current = this.completedRequests.get(snapshotRequest.providerRequestId);
          if (current?.identity === identity && current.result === result) {
            this.completedRequests.delete(snapshotRequest.providerRequestId);
            if (this.requestIdentities.get(snapshotRequest.providerRequestId) === requestIdentity) {
              this.requestIdentities.delete(snapshotRequest.providerRequestId);
            }
          }
        }
        return deepFreeze(deepClone(value));
      });
    this.completedRequests.set(snapshotRequest.providerRequestId, { identity, result });
    return result;
  }

  private async dispatch(
    snapshotState: TaskState,
    snapshotEvidence: readonly SourceEvidence[],
    snapshotRequest: ProviderRequest,
    snapshotContext: ProviderAdmissionContextV02,
    markPreClaimDenial: () => void,
  ): Promise<ModelPortV02Result> {
    const configured = this.options.executorIdentity;
    if (!configured?.adapterIdentity?.trim() || !configured.processIncarnation?.trim() ||
      !Number.isSafeInteger(configured.fencingGeneration) || (configured.fencingGeneration ?? 0) <= 0 ||
      !this.options.currentExecutorIdentity) {
      markPreClaimDenial();
      return { outcome: 'denied', reason: 'EXECUTOR_IDENTITY_REQUIRED: Explicit trusted actor and current fence are required' };
    }
    const executorIdentity: ExecutorIdentityV02 = deepFreeze({
      adapterIdentity: configured.adapterIdentity,
      processIncarnation: configured.processIncarnation,
      fencingGeneration: configured.fencingGeneration as number,
      payloadDigest: snapshotContext.requestContentDigest,
    });
    const isCurrent = () => sameProviderActor(this.options.currentExecutorIdentity?.() ?? {}, executorIdentity);
    if (!isCurrent()) {
      markPreClaimDenial();
      return { outcome: 'denied', reason: 'FENCED_EXECUTOR' };
    }
    const claimInput: unknown = await this.options.statePort.claim(snapshotContext);
    const claim = providerClaim(claimInput, snapshotContext);
    if (!claim) {
      if (isNeutralClaimReceipt(claimInput)) markPreClaimDenial();
      return { outcome: 'denied', reason: 'CLAIM_DENIED: Mismatched provider claim' };
    }
    if (!isCurrent()) return { outcome: 'denied', reason: 'FENCED_EXECUTOR' };
    const attempt = providerAttempt(await this.options.statePort.beginAttempt(claim.claimId, executorIdentity), claim, executorIdentity);
    if (!attempt) return { outcome: 'denied', reason: 'ATTEMPT_DENIED: Mismatched provider attempt' };
    const consumeKey = computeCanonicalSha256({ taskId: claim.taskId, attemptId: attempt.attemptId,
      adapterIdentity: executorIdentity.adapterIdentity, processIncarnation: executorIdentity.processIncarnation });
    if (!isCurrent()) return { outcome: 'denied', reason: 'FENCED_EXECUTOR' };
    const payload = buildTransportPayload(snapshotState, snapshotEvidence, snapshotRequest);
    if (consumedAttempts.has(consumeKey)) return { outcome: 'denied', reason: 'ALREADY_CONSUMED' };
    consumedAttempts.add(consumeKey);

    // Dispatched transport execution
    const transportRes = await executeTransport(this.options.transport, payload, snapshotRequest);

    const usage = 'observedUsage' in transportRes ? transportRes.observedUsage : undefined;
    const bounds = snapshotContext.finiteBounds;
    const accounted = usage !== undefined &&
      usage.inputTokens <= Math.min(snapshotRequest.maxInputTokens, bounds.maxInputTokens) &&
      usage.outputTokens <= Math.min(snapshotRequest.maxOutputTokens, bounds.maxOutputTokens) &&
      (usage.billableTokens ?? usage.inputTokens + usage.outputTokens) <= Math.min(snapshotRequest.maxBillableTokens, bounds.maxBillableTokens) &&
      usage.costUsd <= Math.min(snapshotRequest.maxCostUsd, bounds.maxCostUsd);
    const receipt = buildProviderOutcomeReceipt(snapshotContext, claim, attempt,
      accounted ? 'observed' : 'uncertain',
      transportRes.outcome === 'observed' ? transportRes.result : { outcome: transportRes.outcome },
      accounted ? usage : undefined);
    const pending = await this.recordProviderOutcome(snapshotContext, claim, attempt, receipt);
    if (pending) return pending;
    if (transportRes.outcome === 'observed') {
      return { outcome: 'observed', result: transportRes.result, observedUsage: transportRes.observedUsage };
    }
    if (transportRes.outcome === 'invalid') return { outcome: 'invalid', errors: transportRes.errors, observedUsage: usage };
    return { outcome: 'uncertain', reason: 'PROVIDER_OUTCOME_PENDING' };
  }

  private async recordProviderOutcome(
    admission: ProviderAdmissionContextV02,
    claim: ClaimReceiptV02,
    attempt: AttemptReceiptV02,
    receipt: ProviderRequestOutcomeReceiptV02,
  ): Promise<ModelPortV02Result | null> {
    const validation = validateProviderRequestOutcomeReceiptV02(receipt, {
      trustedAdmission: admission, trustedClaim: claim, trustedAttempt: attempt,
      currentClaimStatus: 'attempting', currentTaskStateVersion: attempt.postBeginTaskStateVersion,
      currentControlVersion: attempt.postBeginControlVersion, currentEpoch: attempt.epoch,
    });
    if (!validation.ok) throw new Error('INVALID_PROVIDER_OUTCOME_RECEIPT');
    const recovery = deepFreeze(deepClone({ admission, claim, attempt, receipt: validation.value }));
    try {
      const snapshot = safeSnapshot(await this.options.statePort.recordOutcome(recovery.receipt));
      const recorded = snapshot.ok ? snapshot.value : null;
      if (recorded && typeof recorded === 'object' && !Array.isArray(recorded) &&
        Object.keys(recorded).length === 2 && Object.hasOwn(recorded, 'receiptId') &&
        Object.hasOwn(recorded, 'outcome')) {
        // The detached snapshot contains only own plain-data properties.
        const data = recorded as Record<string, unknown>;
        if (data['receiptId'] === receipt.receiptId && data['outcome'] === 'settled' && receipt.outcome === 'observed') return null;
      }
    } catch {
      // A lost recording response cannot authorize dispatch or prove settlement.
    }
    return { outcome: 'uncertain', reason: 'PROVIDER_OUTCOME_PENDING', recovery };
  }

}

function computeProviderRequestIdentity(
  request: ProviderRequest,
  context: ProviderAdmissionContextV02,
): string {
  const immutableAdmission = { ...context };
  Reflect.deleteProperty(immutableAdmission, 'expectedControlVersion');
  Reflect.deleteProperty(immutableAdmission, 'admissionDigest');
  return computeCanonicalSha256({ request, admission: immutableAdmission });
}

function isNeutralClaimReceipt(input: unknown): boolean {
  const snapshot = safeSnapshot(input);
  const claimKeys = ['claimId', 'claimDigest', 'taskId', 'runId', 'subjectKind', 'planApplicability',
    'preClaimTaskStateVersion', 'preClaimControlVersion', 'postClaimControlVersion', 'epoch', 'status', 'reservationRefs'];
  if (!snapshot.ok || !snapshot.value || typeof snapshot.value !== 'object' || Array.isArray(snapshot.value)) return false;
  const copy = snapshot.value as Record<string, unknown>;
  return Object.keys(copy).length === claimKeys.length && claimKeys.every((key) => Object.hasOwn(copy, key)) &&
    copy['claimId'] === '' && copy['claimDigest'] === '' && copy['taskId'] === '' && copy['runId'] === '' &&
    copy['subjectKind'] === 'repository-action' && copy['planApplicability'] === 'pre-plan-diagnostic' &&
    copy['preClaimTaskStateVersion'] === 0 && copy['preClaimControlVersion'] === 0 &&
    copy['postClaimControlVersion'] === 0 && copy['epoch'] === 0 && copy['status'] === 'claimed' &&
    Array.isArray(copy['reservationRefs']) && copy['reservationRefs'].length === 0;
}
