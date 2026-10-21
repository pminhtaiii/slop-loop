/**
 * UC-03 Phase 2 - ScriptedReviewerPort
 *
 * Owned path: tests/runtime/support/uc03/scripted-reviewer.ts
 * Feature: specs/001-verified-code-repair
 *
 * Deterministic test-only implementation of ReviewerPort for controlled offline testing.
 * Replaced by real runtime reviewer (T009) and evaluated at integration (T030).
 *
 * Invariants:
 * - Provenance is strictly 'mock'; rejected by isAdmittedForProduction.
 * - Read-only: strictly forbids write and execute capabilities.
 * - Distinct role: enforces request.role === 'reviewer'.
 * - Evaluates dispatch admission using canonical validateDispatchAdmission against
 *   an explicit trusted authoritative DispatchAdmissionContext; never admits bare refs.
 * - Requires explicit task/run reviewer iteration reservation before simulated dispatch.
 * - Tracks attempted calls vs actual simulated dispatches independently.
 * - Missing, exhausted, partial, or uncertain accounting produces zero dispatch.
 */

import {
  type ReviewerPort,
  type PortProvenance,
  type BugTask,
  type SourceEvidence,
  type ProviderRequest,
  type ReviewResult,
  type DispatchAdmissionContext,
  validateDispatchAdmission,
} from '../../../../src/contracts/foundation/uc03.ts';

export interface ReviewerCallRecord {
  readonly task: BugTask;
  readonly diff: string;
  readonly evidence: readonly SourceEvidence[];
  readonly request: ProviderRequest;
  readonly admitted: boolean;
  readonly result?: ReviewResult | undefined;
  readonly error?: Error | undefined;
}

export interface ScriptedReviewerOptions {
  readonly admissionContext?: DispatchAdmissionContext | undefined;
  readonly responses?: readonly ReviewResult[] | undefined;
  readonly responseFactory?: ((request: ProviderRequest) => ReviewResult) | undefined;
}

export class ScriptedReviewerPort implements ReviewerPort {
  readonly provenance: PortProvenance = 'mock';

  private attemptedCount = 0;
  private dispatchCount = 0;
  private defaultAdmissionContext?: DispatchAdmissionContext | undefined;
  private scriptedResponses: ReviewResult[] = [];
  private responseFactory?: ((request: ProviderRequest) => ReviewResult) | undefined;
  private callLog: ReviewerCallRecord[] = [];

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

  setAdmissionContext(context: DispatchAdmissionContext | undefined): void {
    this.defaultAdmissionContext = context;
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
  }

  async review(
    task: BugTask,
    diff: string,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest
  ): Promise<ReviewResult> {
    this.attemptedCount++;

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
