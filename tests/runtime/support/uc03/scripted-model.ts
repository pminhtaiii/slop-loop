/**
 * UC-03 Phase 2 - ScriptedModelPort
 *
 * Owned path: tests/runtime/support/uc03/scripted-model.ts
 * Feature: specs/001-verified-code-repair
 *
 * Deterministic test-only implementation of ModelPort and ModelPortV02
 * for controlled offline testing.
 * Replaced by real host ModelPort (T008) and wired at integration (T028).
 *
 * Invariants:
 * - Provenance is strictly 'mock'; rejected by isAdmittedForProduction.
 * - Zero real network, process spawning, or external fallback.
 * - Evaluates dispatch admission using canonical validateDispatchAdmission against
 *   an explicit trusted authoritative DispatchAdmissionContext; never admits bare refs.
 * - Tracks attempted calls vs actual simulated dispatches independently.
 * - Missing, exhausted, partial, or uncertain accounting produces zero dispatch.
 * - Supports v0.2 atomic admission forwarding preserving attempt identity and outcome.
 */

import {
  type ModelPort,
  type PortProvenance,
  type TaskState,
  type SourceEvidence,
  type ProviderRequest,
  type ModelPortResult,
  type ModelPortDenied,
  type DispatchAdmissionContext,
  type ModelPortV02,
  type ProviderAdmissionContextV02,
  type ProviderUsage,
  type ClaimReceiptV02,
  type AttemptReceiptV02,
  type AttemptOutcomeReceiptV02,
  type ExecutorIdentityV02,
  type StatePortV02,
  type ProposedSettlementEffectsV02,
  validateDispatchAdmission,
  validateProviderAdmissionV02,
  computeCanonicalSha256,
  computeRequestContentDigest,
} from '../../../../src/contracts/foundation/uc03.ts';
import {
  createTestProviderAdmissionTrustedContextV02,
  createTestProviderOutcomeReceiptV02,
} from './state-fixtures.ts';

function createProviderOutcomeEffects(
  context: ProviderAdmissionContextV02,
  outcome: 'observed' | 'uncertain',
  observedUsage?: ProviderUsage,
): ProposedSettlementEffectsV02 {
  return {
    taskTransition: { kind: 'none' },
    revision: { kind: 'not-applicable' },
    invalidatedEvidence: [],
    accounting: {
      disposition: outcome === 'observed' ? 'settle' : 'hold',
      reservationRefs: [context.requestReservationReceipt, ...context.budgetRefs],
      ...(observedUsage !== undefined ? { observedUsage } : {}),
    },
  };
}

export interface ModelCallRecord {
  readonly state: TaskState;
  readonly evidence: readonly SourceEvidence[];
  readonly request: ProviderRequest;
  readonly admitted: boolean;
  readonly result: ModelPortResult;
}

export interface ScriptedModelV02CallRecord {
  readonly request: ProviderRequest;
  readonly context: ProviderAdmissionContextV02;
  readonly claimId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly claim?: ClaimReceiptV02 | undefined;
  readonly attempt?: AttemptReceiptV02 | undefined;
  readonly outcomeReceipt?: AttemptOutcomeReceiptV02 | undefined;
  readonly outcome: ModelPortResult;
}

export interface ScriptedModelOptions {
  readonly admissionContext?: DispatchAdmissionContext | undefined;
  readonly responses?: readonly ModelPortResult[] | undefined;
  readonly responseFactory?: ((request: ProviderRequest) => ModelPortResult) | undefined;
  readonly statePort?: StatePortV02 | undefined;
  readonly executorIdentity?: ExecutorIdentityV02 | undefined;
  readonly defaultAdmissionContextV02?: ProviderAdmissionContextV02 | undefined;
}

export class ScriptedModelPort implements ModelPort, ModelPortV02 {
  readonly provenance: PortProvenance = 'mock';

  private attemptedCount = 0;
  private dispatchCount = 0;
  private defaultAdmissionContext?: DispatchAdmissionContext | undefined;
  private scriptedResponses: ModelPortResult[] = [];
  private responseFactory?: ((request: ProviderRequest) => ModelPortResult) | undefined;
  private callLog: ModelCallRecord[] = [];

  // v0.2 additions
  private statePort?: StatePortV02 | undefined;
  private executorIdentity?: ExecutorIdentityV02 | undefined;
  private defaultAdmissionContextV02?: ProviderAdmissionContextV02 | undefined;
  private v02CallLog: ScriptedModelV02CallRecord[] = [];

  constructor(options?: ScriptedModelOptions) {
    if (options?.admissionContext !== undefined) {
      this.defaultAdmissionContext = options.admissionContext;
    }
    if (options?.responses !== undefined) {
      this.scriptedResponses = [...options.responses];
    }
    if (options?.responseFactory !== undefined) {
      this.responseFactory = options.responseFactory;
    }

    this.statePort = options?.statePort;
    this.executorIdentity = options?.executorIdentity;
    this.defaultAdmissionContextV02 = options?.defaultAdmissionContextV02;
  }

  get attemptedCalls(): number {
    return this.attemptedCount;
  }

  get simulatedDispatches(): number {
    return this.dispatchCount;
  }

  get calls(): readonly ModelCallRecord[] {
    return [...this.callLog];
  }

  get v02Calls(): readonly ScriptedModelV02CallRecord[] {
    return [...this.v02CallLog];
  }

  setStatePort(statePort: StatePortV02 | undefined): void {
    this.statePort = statePort;
  }

  setAdmissionContext(context: DispatchAdmissionContext | undefined): void {
    this.defaultAdmissionContext = context;
  }

  setAdmissionContextV02(context: ProviderAdmissionContextV02 | undefined): void {
    this.defaultAdmissionContextV02 = context;
  }

  queueResponse(response: ModelPortResult): void {
    this.scriptedResponses.push(response);
  }

  queueResponses(responses: readonly ModelPortResult[]): void {
    this.scriptedResponses.push(...responses);
  }

  setResponseFactory(factory: ((request: ProviderRequest) => ModelPortResult) | undefined): void {
    this.responseFactory = factory;
  }

  resetCounts(): void {
    this.attemptedCount = 0;
    this.dispatchCount = 0;
    this.callLog = [];
    this.v02CallLog = [];
  }

  async propose(
    state: TaskState,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest,
    context?: ProviderAdmissionContextV02
  ): Promise<ModelPortResult> {
    this.attemptedCount++;

    const effectiveV02 = context ?? this.defaultAdmissionContextV02;
    if (effectiveV02 !== undefined) {
      // v0.2 validation
      if (
        !effectiveV02 ||
        typeof effectiveV02 !== 'object' ||
        effectiveV02.schemaVersion !== '0.2.0' ||
        effectiveV02.subjectKind !== 'provider-request'
      ) {
        const denied: ModelPortDenied = {
          outcome: 'denied',
          reason: 'INVALID_ADMISSION_CONTEXT: Expected valid v0.2 ProviderAdmissionContextV02',
        };
        this.callLog.push({ state, evidence, request, admitted: false, result: denied });
        return denied;
      }
      const contextValidation = validateProviderAdmissionV02(
        effectiveV02,
        createTestProviderAdmissionTrustedContextV02(effectiveV02),
      );
      if (!contextValidation.ok ||
        effectiveV02.providerRequestId !== request.providerRequestId ||
        effectiveV02.role !== request.role ||
        computeRequestContentDigest(request) !== effectiveV02.requestContentDigest ||
        computeCanonicalSha256(request) !== computeCanonicalSha256(effectiveV02.providerRequest)) {
        const denied: ModelPortDenied = {
          outcome: 'denied',
          reason: 'CONTEXT_IDENTITY_MISMATCH: Request payload does not match current admission context',
        };
        this.callLog.push({ state, evidence, request, admitted: false, result: denied });
        return denied;
      }
      if (
        effectiveV02.providerAdmissionReceipt?.role !== request.role ||
        effectiveV02.providerAdmissionReceipt?.providerRequestId !== request.providerRequestId
      ) {
        const denied: ModelPortDenied = {
          outcome: 'denied',
          reason: 'RECEIPT_ROLE_MISMATCH: Provider admission receipt role or request ID mismatch',
        };
        this.callLog.push({ state, evidence, request, admitted: false, result: denied });
        return denied;
      }

      if (!this.responseFactory && this.scriptedResponses.length === 0) {
        const denied: ModelPortDenied = { outcome: 'denied', reason: 'SCRIPT_EXHAUSTED: No scripted response remains' };
        this.callLog.push({ state, evidence, request, admitted: false, result: denied });
        return denied;
      }

      let claim: ClaimReceiptV02 | undefined;
      let attempt: AttemptReceiptV02 | undefined;
      if (this.statePort) {
        if (!this.executorIdentity) {
          const denied: ModelPortDenied = { outcome: 'denied', reason: 'MISSING_EXECUTOR_IDENTITY' };
          this.callLog.push({ state, evidence, request, admitted: false, result: denied });
          return denied;
        }
        claim = await this.statePort.claim(effectiveV02);
        if (!claim.claimId || claim.taskId !== effectiveV02.taskId || claim.runId !== effectiveV02.runId) {
          const denied: ModelPortDenied = { outcome: 'denied', reason: 'ADMISSION_CLAIM_REFUSED' };
          this.callLog.push({ state, evidence, request, admitted: false, result: denied });
          return denied;
        }
        attempt = await this.statePort.beginAttempt(claim.claimId, this.executorIdentity);
        if (!attempt.attemptId || attempt.claimId !== claim.claimId) {
          const denied: ModelPortDenied = { outcome: 'denied', reason: 'ADMISSION_ATTEMPT_REFUSED' };
          this.callLog.push({ state, evidence, request, admitted: false, result: denied });
          return denied;
        }
      }

      const nextResult = this.responseFactory
        ? this.responseFactory(request)
        : this.scriptedResponses.shift() as ModelPortResult;
      this.dispatchCount++;

      let outcomeReceipt: AttemptOutcomeReceiptV02 | undefined;
      if (this.statePort && claim && attempt) {
        const receiptId = `provider-outcome-${attempt.attemptId}`;
        if (nextResult.outcome === 'observed') {
          const observedUsage = nextResult.result.observedUsage;
          outcomeReceipt = createTestProviderOutcomeReceiptV02(claim, attempt, effectiveV02, {
            receiptId,
            outcome: 'observed',
            observedUsage,
            proposedEffects: createProviderOutcomeEffects(effectiveV02, 'observed', observedUsage),
          });
        } else {
          const observedUsage = 'observedUsage' in nextResult ? nextResult.observedUsage : undefined;
          outcomeReceipt = createTestProviderOutcomeReceiptV02(claim, attempt, effectiveV02, {
            receiptId,
            outcome: 'uncertain',
            observedUsage,
            proposedEffects: createProviderOutcomeEffects(effectiveV02, 'uncertain', observedUsage),
          });
        }
        await this.statePort.recordOutcome(outcomeReceipt);
      }

      this.callLog.push({ state, evidence, request, admitted: true, result: nextResult });
      this.v02CallLog.push({
        request,
        context: effectiveV02,
        claimId: claim?.claimId,
        attemptId: attempt?.attemptId,
        claim,
        attempt,
        outcomeReceipt,
        outcome: nextResult,
      });

      return nextResult;
    }

    // v0.1 Authoritative admission validation
    const admissionContext = this.defaultAdmissionContext;
    if (!admissionContext) {
      const denied: ModelPortDenied = {
        outcome: 'denied',
        reason:
          'UNTRUSTED_DISPATCH_AUTHORIZATION: Dispatch admission requires trusted validated context (a bare reservation ref cannot authorize dispatch)',
      };
      this.callLog.push({ state, evidence, request, admitted: false, result: denied });
      return denied;
    }

    const admissionRes = validateDispatchAdmission(request, admissionContext);
    if (!admissionRes.ok) {
      const denied: ModelPortDenied = {
        outcome: 'denied',
        reason: admissionRes.errors.map((e) => `${e.code}: ${e.message}`).join('; '),
      };
      this.callLog.push({ state, evidence, request, admitted: false, result: denied });
      return denied;
    }

    let nextResult: ModelPortResult;
    if (this.responseFactory) {
      nextResult = this.responseFactory(request);
    } else {
      const scripted = this.scriptedResponses.shift();
      if (scripted === undefined) {
        const denied: ModelPortDenied = {
          outcome: 'denied',
          reason: 'SCRIPT_EXHAUSTED: No scripted response remains',
        };
        this.callLog.push({ state, evidence, request, admitted: false, result: denied });
        return denied;
      }
      nextResult = scripted;
    }
    this.dispatchCount++;

    this.callLog.push({ state, evidence, request, admitted: true, result: nextResult });
    return nextResult;
  }
}

export class ScriptedModelPortV02 implements ModelPortV02 {
  readonly provenance: PortProvenance = 'mock';
  private readonly underlying: ScriptedModelPort;

  constructor(underlying: ScriptedModelPort) {
    this.underlying = underlying;
  }

  get attemptedCalls(): number {
    return this.underlying.attemptedCalls;
  }

  get simulatedDispatches(): number {
    return this.underlying.simulatedDispatches;
  }

  get v02Calls(): readonly ScriptedModelV02CallRecord[] {
    return this.underlying.v02Calls;
  }

  queueResponse(response: ModelPortResult): void {
    this.underlying.queueResponse(response);
  }

  queueResponses(responses: readonly ModelPortResult[]): void {
    this.underlying.queueResponses(responses);
  }

  propose(
    state: TaskState,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest,
    context: ProviderAdmissionContextV02
  ): Promise<ModelPortResult> {
    if (!context) {
      return Promise.resolve({
        outcome: 'denied',
        reason: 'MISSING_ADMISSION_CONTEXT: ModelPortV02 requires ProviderAdmissionContextV02',
      });
    }
    return this.underlying.propose(state, evidence, request, context);
  }
}
