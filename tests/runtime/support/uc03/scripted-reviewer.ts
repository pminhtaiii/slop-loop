import {
  type ReviewerPort,
  type BugTask,
  type SourceEvidence,
  type ProviderRequest,
  type ReviewResult,
  type PortProvenance,
  type DispatchAdmissionContext,
  type ProviderAdmissionContextV02,
  type ClaimReceiptV02,
  type AttemptReceiptV02,
  type StatePortV02,
  type AttemptOutcomeReceiptV02,
  type ExecutorIdentityV02,
  validateProviderAdmissionV02,
  computeCanonicalSha256,
  computeRequestContentDigest,
  validateDispatchAdmission,
} from '../../../../src/contracts/foundation/uc03.ts';
import {
  createTestProviderAdmissionTrustedContextV02,
  createTestProviderOutcomeReceiptV02,
} from './state-fixtures.ts';

export interface ReviewerCallRecord {
  readonly task: BugTask;
  readonly diff: string;
  readonly evidence: readonly SourceEvidence[];
  readonly request: ProviderRequest;
  readonly admitted: boolean;
  readonly result?: ReviewResult | undefined;
  readonly error?: Error | undefined;
}

export interface ScriptedReviewerV02CallRecord {
  readonly task: BugTask;
  readonly diff: string;
  readonly evidence: readonly SourceEvidence[];
  readonly request: ProviderRequest;
  readonly context: ProviderAdmissionContextV02;
  readonly claimId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly claim?: ClaimReceiptV02 | undefined;
  readonly attempt?: AttemptReceiptV02 | undefined;
  readonly outcomeReceipt?: AttemptOutcomeReceiptV02 | undefined;
  readonly outcome: ReviewResult;
}

export interface ScriptedReviewerOptions {
  readonly admissionContext?: DispatchAdmissionContext | undefined;
  readonly responses?: readonly ReviewResult[] | undefined;
  readonly responseFactory?: ((request: ProviderRequest) => ReviewResult) | undefined;
  readonly statePort?: StatePortV02 | undefined;
  readonly executorIdentity?: ExecutorIdentityV02 | undefined;
  readonly defaultAdmissionContextV02?: ProviderAdmissionContextV02 | undefined;
}

export class ScriptedReviewerPort implements ReviewerPort {
  readonly provenance: PortProvenance = 'mock';

  private attemptedCount = 0;
  private dispatchCount = 0;
  private defaultAdmissionContext?: DispatchAdmissionContext | undefined;
  private scriptedResponses: ReviewResult[] = [];
  private responseFactory?: ((request: ProviderRequest) => ReviewResult) | undefined;
  private callLog: ReviewerCallRecord[] = [];

  // v0.2 additions
  private statePort?: StatePortV02 | undefined;
  private executorIdentity?: ExecutorIdentityV02 | undefined;
  private defaultAdmissionContextV02?: ProviderAdmissionContextV02 | undefined;
  private v02CallLog: ScriptedReviewerV02CallRecord[] = [];

  constructor(options?: ScriptedReviewerOptions) {
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

  get calls(): readonly ReviewerCallRecord[] {
    return [...this.callLog];
  }

  get v02Calls(): readonly ScriptedReviewerV02CallRecord[] {
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

  queueResponse(response: ReviewResult): void {
    this.scriptedResponses.push(response);
  }

  queueResponses(responses: readonly ReviewResult[]): void {
    this.scriptedResponses.push(...responses);
  }

  setResponseFactory(factory: ((request: ProviderRequest) => ReviewResult) | undefined): void {
    this.responseFactory = factory;
  }

  resetCounts(): void {
    this.attemptedCount = 0;
    this.dispatchCount = 0;
    this.callLog = [];
    this.v02CallLog = [];
  }

  async review(
    task: BugTask,
    diff: string,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest,
    context?: ProviderAdmissionContextV02
  ): Promise<ReviewResult> {
    this.attemptedCount++;

    const effectiveV02 = context ?? this.defaultAdmissionContextV02;
    if (effectiveV02 !== undefined) {
      // Role check: ReviewerPort requires distinct reviewer role
      if (request.role !== 'reviewer') {
        const err = new Error(
          `INVALID_ROLE: ReviewerPort expected request role 'reviewer', got '${request.role}'`
        );
        this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
        throw err;
      }
      if (
        !effectiveV02 ||
        typeof effectiveV02 !== 'object' ||
        effectiveV02.schemaVersion !== '0.2.0' ||
        effectiveV02.subjectKind !== 'provider-request'
      ) {
        const err = new Error('INVALID_ADMISSION_CONTEXT: Expected valid v0.2 ProviderAdmissionContextV02');
        this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
        throw err;
      }
      if (effectiveV02.role !== 'reviewer') {
        const err = new Error('INVALID_ROLE: ProviderAdmissionContextV02 role must be "reviewer"');
        this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
        throw err;
      }
      if (effectiveV02.providerRequestId !== request.providerRequestId) {
        const err = new Error('CONTEXT_IDENTITY_MISMATCH: Request ID mismatch with admission context');
        this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
        throw err;
      }
      const contextValidation = validateProviderAdmissionV02(
        effectiveV02,
        createTestProviderAdmissionTrustedContextV02(effectiveV02),
      );
      if (!contextValidation.ok || effectiveV02.role !== request.role ||
        computeRequestContentDigest(request) !== effectiveV02.requestContentDigest ||
        computeCanonicalSha256(request) !== computeCanonicalSha256(effectiveV02.providerRequest)) {
        const err = new Error('CONTEXT_IDENTITY_MISMATCH: Request payload does not match current admission context');
        this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
        throw err;
      }

      if (!this.responseFactory && this.scriptedResponses.length === 0) {
        const err = new Error('SCRIPT_EXHAUSTED: No scripted response remains');
        this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
        throw err;
      }

      let claim: ClaimReceiptV02 | undefined;
      let attempt: AttemptReceiptV02 | undefined;
      if (this.statePort) {
        if (!this.executorIdentity) {
          const err = new Error('MISSING_EXECUTOR_IDENTITY');
          this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
          throw err;
        }
        claim = await this.statePort.claim(effectiveV02);
        if (!claim.claimId || claim.taskId !== effectiveV02.taskId || claim.runId !== effectiveV02.runId) {
          const err = new Error('ADMISSION_CLAIM_REFUSED');
          this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
          throw err;
        }
        attempt = await this.statePort.beginAttempt(claim.claimId, this.executorIdentity);
        if (!attempt.attemptId || attempt.claimId !== claim.claimId) {
          const err = new Error('ADMISSION_ATTEMPT_REFUSED');
          this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
          throw err;
        }
      }

      let nextResult: ReviewResult;
      if (this.responseFactory) {
        nextResult = this.responseFactory(request);
      } else {
        const scripted = this.scriptedResponses.shift();
        if (scripted === undefined) {
          const err = new Error('SCRIPT_EXHAUSTED: No scripted response remains');
          this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
          throw err;
        }
        nextResult = scripted;
      }

      this.dispatchCount++;

      let outcomeReceipt: AttemptOutcomeReceiptV02 | undefined;
      if (this.statePort && claim && attempt) {
        outcomeReceipt = createTestProviderOutcomeReceiptV02(claim, attempt, effectiveV02, {
          receiptId: `reviewer-outcome-${attempt.attemptId}`,
          outcome: 'uncertain',
          observedUsage: undefined,
          proposedEffects: {
            taskTransition: { kind: 'none' },
            revision: { kind: 'not-applicable' },
            invalidatedEvidence: [],
            accounting: {
              disposition: 'hold',
              reservationRefs: [effectiveV02.requestReservationReceipt, ...effectiveV02.budgetRefs],
            },
          },
        });
        await this.statePort.recordOutcome(outcomeReceipt);
      }

      this.callLog.push({ task, diff, evidence, request, admitted: true, result: nextResult });
      this.v02CallLog.push({
        task,
        diff,
        evidence,
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

    // Role check: ReviewerPort requires distinct reviewer role
    if (request.role !== 'reviewer') {
      const err = new Error(
        `INVALID_ROLE: ReviewerPort expected request role 'reviewer', got '${request.role}'`
      );
      this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
      throw err;
    }

    // Authoritative admission validation
    const admissionContext = this.defaultAdmissionContext;
    if (!admissionContext) {
      const err = new Error(
        'UNTRUSTED_DISPATCH_AUTHORIZATION: Dispatch admission requires trusted validated context (a bare reservation ref cannot authorize dispatch)'
      );
      this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
      throw err;
    }

    const admissionRes = validateDispatchAdmission(request, admissionContext);
    if (!admissionRes.ok) {
      const err = new Error(
        `DISPATCH_ADMISSION_DENIED: ${admissionRes.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`
      );
      this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
      throw err;
    }

    let nextResult: ReviewResult;
    if (this.responseFactory) {
      nextResult = this.responseFactory(request);
    } else {
      const scripted = this.scriptedResponses.shift();
      if (scripted === undefined) {
        const err = new Error('SCRIPT_EXHAUSTED: No scripted response remains');
        this.callLog.push({ task, diff, evidence, request, admitted: false, error: err });
        throw err;
      }
      nextResult = scripted;
    }
    this.dispatchCount++;

    this.callLog.push({ task, diff, evidence, request, admitted: true, result: nextResult });
    return nextResult;
  }
}

export class ScriptedReviewerPortV02 {
  readonly provenance: PortProvenance = 'mock';
  private readonly underlying: ScriptedReviewerPort;

  constructor(underlying: ScriptedReviewerPort) {
    this.underlying = underlying;
  }

  get attemptedCalls(): number {
    return this.underlying.attemptedCalls;
  }

  get simulatedDispatches(): number {
    return this.underlying.simulatedDispatches;
  }

  get v02Calls(): readonly ScriptedReviewerV02CallRecord[] {
    return this.underlying.v02Calls;
  }

  queueResponse(response: ReviewResult): void {
    this.underlying.queueResponse(response);
  }

  queueResponses(responses: readonly ReviewResult[]): void {
    this.underlying.queueResponses(responses);
  }

  review(
    task: BugTask,
    diff: string,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest,
    context: ProviderAdmissionContextV02
  ): Promise<ReviewResult> {
    if (!context) {
      return Promise.reject(new Error('MISSING_ADMISSION_CONTEXT: Expected ProviderAdmissionContextV02'));
    }
    return this.underlying.review(task, diff, evidence, request, context);
  }
}
