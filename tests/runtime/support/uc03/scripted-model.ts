/**
 * UC-03 Phase 2 - ScriptedModelPort
 *
 * Owned path: tests/runtime/support/uc03/scripted-model.ts
 * Feature: specs/001-verified-code-repair
 *
 * Deterministic test-only implementation of ModelPort for controlled offline testing.
 * Replaced by real host ModelPort (T008) and wired at integration (T028).
 *
 * Invariants:
 * - Provenance is strictly 'mock'; rejected by isAdmittedForProduction.
 * - Zero real network, process spawning, or external fallback.
 * - Evaluates dispatch admission using canonical validateDispatchAdmission against
 *   an explicit trusted authoritative DispatchAdmissionContext; never admits bare refs.
 * - Tracks attempted calls vs actual simulated dispatches independently.
 * - Missing, exhausted, partial, or uncertain accounting produces zero dispatch.
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
  validateDispatchAdmission,
} from '../../../../src/contracts/uc03.ts';

export interface ModelCallRecord {
  readonly state: TaskState;
  readonly evidence: readonly SourceEvidence[];
  readonly request: ProviderRequest;
  readonly admitted: boolean;
  readonly result: ModelPortResult;
}

export interface ScriptedModelOptions {
  readonly admissionContext?: DispatchAdmissionContext | undefined;
  readonly responses?: readonly ModelPortResult[] | undefined;
  readonly responseFactory?: ((request: ProviderRequest) => ModelPortResult) | undefined;
}

export class ScriptedModelPort implements ModelPort {
  readonly provenance: PortProvenance = 'mock';

  private attemptedCount = 0;
  private dispatchCount = 0;
  private defaultAdmissionContext?: DispatchAdmissionContext | undefined;
  private scriptedResponses: ModelPortResult[] = [];
  private responseFactory?: ((request: ProviderRequest) => ModelPortResult) | undefined;
  private callLog: ModelCallRecord[] = [];

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

  setAdmissionContext(context: DispatchAdmissionContext | undefined): void {
    this.defaultAdmissionContext = context;
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
  }

  async propose(
    state: TaskState,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest
  ): Promise<ModelPortResult> {
    this.attemptedCount++;

    // Authoritative admission validation
    const admissionContext = this.defaultAdmissionContext;
    if (!admissionContext) {
      const denied: ModelPortDenied = {
        outcome: 'denied',
        reason: 'UNTRUSTED_DISPATCH_AUTHORIZATION: Dispatch admission requires trusted validated context (a bare reservation ref cannot authorize dispatch)',
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
        const denied: ModelPortDenied = { outcome: 'denied', reason: 'SCRIPT_EXHAUSTED: No scripted response remains' };
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
