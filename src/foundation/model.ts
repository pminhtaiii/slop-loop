/**
 * UC-03 Host Model Boundary (Slice A: T008-a)
 *
 * Implements canonical ModelPort with injected host transport and authoritative
 * admission loader. Evaluates runtime TaskState, SourceEvidence, ProviderRequest,
 * and canonical validateDispatchAdmission against trusted StatePort snapshots.
 *
 * NOTE: This slice assumes an already atomic reserved request. The full
 * reservation and settlement lifecycle is owned by T008-b (partial canonical T008).
 * This module reports partial and does NOT claim full budget protocol ownership.
 *
 * Owned path: src/foundation/model.ts
 * Feature: specs/001-verified-code-repair
 */

import {
  type ModelPort,
  type PortProvenance,
  type TaskState,
  type SourceEvidence,
  type ProviderRequest,
  type ModelPortResult,
  type DispatchAdmissionContext,
  type ProviderUsage,
  type ValidationError,
  validateTaskState,
  validateSourceEvidence,
  validateProviderRequest,
  validateDispatchAdmission,
  validateModelResult,
  validateProviderUsage,
  computeCanonicalSha256,
} from '../contracts/uc03.ts';

export interface HostModelCaps {
  readonly timeoutMs: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxBillableTokens: number;
  readonly maxCostUsd: number;
}

export interface UntrustedContextItem {
  readonly path: string;
  readonly revisionDigest: string;
  readonly content: string;
  readonly isUntrustedRepositoryContent: true;
}

export interface HostModelTransportPayload {
  readonly state: TaskState;
  readonly evidence: readonly SourceEvidence[];
  readonly request: ProviderRequest;
  readonly caps: HostModelCaps;
  readonly untrustedContext: {
    readonly evidenceItems: readonly UntrustedContextItem[];
  };
}

export interface HostModelTransport {
  execute(payload: HostModelTransportPayload): Promise<unknown>;
}

export type AuthoritativeAdmissionLoader = (
  request: ProviderRequest
) => Promise<DispatchAdmissionContext | null | undefined> | DispatchAdmissionContext | null | undefined;

export interface HostProviderConfig {
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly configId?: string | undefined;
  readonly pricingPolicyId?: string | undefined;
}

export interface HostModelPortOptions {
  readonly transport: HostModelTransport;
  readonly admissionLoader: AuthoritativeAdmissionLoader;
  readonly providerConfig?: HostProviderConfig | undefined;
}

export interface ContextDigestPayload {
  readonly state: TaskState;
  readonly evidence: readonly SourceEvidence[];
}

/**
 * Computes a deterministic canonical digest for the exact state and evidence
 * payload admitted and sent to host transport. Reuses canonical sha256.
 */
export function computeContextDigest(
  stateOrPayload: TaskState | ContextDigestPayload,
  maybeEvidence?: readonly SourceEvidence[]
): string {
  let state: TaskState;
  let evidence: readonly SourceEvidence[];

  if (maybeEvidence !== undefined) {
    state = stateOrPayload as TaskState;
    evidence = maybeEvidence;
  } else if (
    typeof stateOrPayload === 'object' &&
    stateOrPayload !== null &&
    'state' in stateOrPayload &&
    'evidence' in stateOrPayload
  ) {
    state = (stateOrPayload as ContextDigestPayload).state;
    evidence = (stateOrPayload as ContextDigestPayload).evidence;
  } else {
    throw new Error('computeContextDigest requires state and evidence');
  }

  // Canonicalize evidence items to guarantee deterministic property ordering
  const canonicalEvidence = evidence.map((e) => ({
    boundedExcerpt: e.boundedExcerpt,
    path: e.path,
    resultCount: e.resultCount,
    revisionDigest: e.revisionDigest,
    truncated: e.truncated,
  }));

  return computeCanonicalSha256({
    evidence: canonicalEvidence,
    state,
  });
}

export { computeContextDigest as computeModelContextDigest };

/**
 * Detects embedded protected secrets, credential patterns, and marker phrases.
 */
export function containsProtectedContent(text: string): boolean {
  if (typeof text !== 'string') return false;
  return (
    /MARKER_SECRET/i.test(text) ||
    /UNAPPROVED_CONTEXT/i.test(text) ||
    /BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY/i.test(text) ||
    /(?:sk-|api[_-]?key\s*[:=]|token\s*[:=]|password\s*[:=]|bearer\s+)[a-zA-Z0-9_\-.]+/i.test(text) ||
    /SECRET_KEY/i.test(text)
  );
}

function redactSensitiveData(text: string): string {
  return text
    .replace(/(?:sk-|api_key=|key=|token=|password=|bearer\s+)[a-zA-Z0-9_\-.]+/gi, '[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, (url) => url.split('?')[0] ?? url);
}

function sanitizeValidationErrors(errors: readonly ValidationError[]): readonly ValidationError[] {
  return errors.map((err) => ({
    path: err.path,
    code: err.code,
    message: redactSensitiveData(err.message),
  }));
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export class HostModelPort implements ModelPort {
  readonly provenance: PortProvenance = 'real';
  readonly options: HostModelPortOptions;

  constructor(options: HostModelPortOptions) {
    this.options = options;
  }

  async propose(
    state: TaskState,
    evidence: readonly SourceEvidence[],
    request: ProviderRequest
  ): Promise<ModelPortResult> {
    // 1. Runtime validate TaskState
    const stateRes = validateTaskState(state);
    if (!stateRes.ok) {
      return {
        outcome: 'invalid',
        errors: sanitizeValidationErrors(stateRes.errors),
      };
    }

    // 2. Runtime validate approved bounded SourceEvidence with provenance / current revision and protected content checks
    if (!Array.isArray(evidence)) {
      return {
        outcome: 'invalid',
        errors: [{ path: 'evidence', message: 'evidence must be an array', code: 'INVALID_TYPE' }],
      };
    }

    for (let i = 0; i < evidence.length; i++) {
      const item = evidence[i];
      const evRes = validateSourceEvidence(item, undefined, `evidence[${i}]`);
      if (!evRes.ok) {
        return {
          outcome: 'invalid',
          errors: sanitizeValidationErrors(evRes.errors),
        };
      }
      if (item.revisionDigest !== state.repositoryRevisionDigest) {
        return {
          outcome: 'invalid',
          errors: [
            {
              path: `evidence[${i}].revisionDigest`,
              message: `Evidence revisionDigest ${item.revisionDigest} does not match current state revisionDigest ${state.repositoryRevisionDigest}`,
              code: 'STALE_EVIDENCE_REVISION',
            },
          ],
        };
      }
      if (containsProtectedContent(item.boundedExcerpt)) {
        return {
          outcome: 'invalid',
          errors: [
            {
              path: `evidence[${i}].boundedExcerpt`,
              message: 'Evidence boundedExcerpt contains protected content or embedded secret',
              code: 'PROTECTED_CONTENT_FORBIDDEN',
            },
          ],
        };
      }
    }

    // 3. Compute canonical digest from EXACT context payload to be sent to host transport
    const computedContextDigest = computeContextDigest(state, evidence);

    // Runtime validate ProviderRequest identity/role/config/pricing/caps/contextDigest against computedContextDigest
    const cfg = this.options.providerConfig;
    const reqRes = validateProviderRequest(request, {
      expectedTaskId: state.taskId,
      expectedRunId: state.runId,
      expectedContextDigest: computedContextDigest,
      ...(cfg?.providerId !== undefined ? { expectedProviderId: cfg.providerId } : {}),
      ...(cfg?.modelId !== undefined ? { expectedModelId: cfg.modelId } : {}),
      ...(cfg?.configId !== undefined ? { expectedConfigId: cfg.configId } : {}),
      ...(cfg?.pricingPolicyId !== undefined ? { expectedPricingPolicyId: cfg.pricingPolicyId } : {}),
    });
    if (!reqRes.ok) {
      return {
        outcome: 'invalid',
        errors: sanitizeValidationErrors(reqRes.errors),
      };
    }

    // 4. Canonical validateDispatchAdmission using trusted StatePort snapshot/receipt
    let admissionContext: DispatchAdmissionContext | null | undefined;
    try {
      admissionContext = await this.options.admissionLoader(request);
    } catch {
      return {
        outcome: 'denied',
        reason: 'ADMISSION_LOADER_FAILED: Authoritative admission loader threw an error',
      };
    }

    if (!admissionContext) {
      return {
        outcome: 'denied',
        reason: 'UNTRUSTED_DISPATCH_AUTHORIZATION: Dispatch admission requires trusted validated context (a bare reservation ref cannot authorize dispatch)',
      };
    }

    const admissionRes = validateDispatchAdmission(request, admissionContext);
    if (!admissionRes.ok) {
      const primary = admissionRes.errors[0];
      return {
        outcome: 'denied',
        reason: `${primary?.code ?? 'ADMISSION_DENIED'}: ${redactSensitiveData(primary?.message ?? 'Dispatch admission failed')}`,
      };
    }

    // Bound context verification: ensure host approved context matches computed exact payload digest
    if (admissionContext.expectedRequest.contextDigest !== computedContextDigest) {
      return {
        outcome: 'denied',
        reason: 'CONTEXT_DIGEST_MISMATCH: Authoritative admission context digest does not match computed exact payload digest',
      };
    }

    // 5. Pass envelope enforced token/cost/time caps to host transport; no tool execution ever
    const caps: HostModelCaps = {
      timeoutMs: request.timeoutMs,
      maxInputTokens: request.maxInputTokens,
      maxOutputTokens: request.maxOutputTokens,
      maxBillableTokens: request.maxBillableTokens,
      maxCostUsd: request.maxCostUsd,
    };

    const payload: HostModelTransportPayload = {
      state,
      evidence,
      request,
      caps,
      untrustedContext: {
        evidenceItems: evidence.map((e) => ({
          path: e.path,
          revisionDigest: e.revisionDigest,
          content: e.boundedExcerpt,
          isUntrustedRepositoryContent: true,
        })),
      },
    };

    // 6. Execute transport and validate raw provider ModelResult/usage
    let rawResult: unknown;
    try {
      rawResult = await this.options.transport.execute(payload);
    } catch (err: unknown) {
      const errName = err instanceof Error ? err.name : '';
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errName === 'TimeoutError' || /timeout|timed out/i.test(errMsg)) {
        return {
          outcome: 'uncertain',
          reason: 'PROVIDER_TIMEOUT: Model transport request timed out',
        };
      }
      return {
        outcome: 'uncertain',
        reason: `PROVIDER_ERROR: ${redactSensitiveData(errMsg)}`,
      };
    }

    if (isPlainObject(rawResult)) {
      if (rawResult['outcome'] === 'uncertain') {
        const reason = typeof rawResult['reason'] === 'string' ? redactSensitiveData(rawResult['reason']) : 'PROVIDER_UNCERTAIN';
        return { outcome: 'uncertain', reason };
      }
      if (rawResult['outcome'] === 'denied') {
        const reason = typeof rawResult['reason'] === 'string' ? redactSensitiveData(rawResult['reason']) : 'PROVIDER_DENIED';
        return { outcome: 'denied', reason };
      }
    }

    const modelResultRes = validateModelResult(rawResult);
    if (!modelResultRes.ok) {
      let observedUsage: ProviderUsage | undefined;
      if (isPlainObject(rawResult) && rawResult['observedUsage'] !== undefined) {
        const usageCheck = validateProviderUsage(rawResult['observedUsage']);
        if (usageCheck.ok) {
          observedUsage = usageCheck.value;
        }
      }
      return {
        outcome: 'invalid',
        errors: sanitizeValidationErrors(modelResultRes.errors),
        ...(observedUsage !== undefined ? { observedUsage } : {}),
      };
    }

    const { proposal, observedUsage } = modelResultRes.value;
    const usageErrors: ValidationError[] = [];

    if (observedUsage.inputTokens > request.maxInputTokens) {
      usageErrors.push({
        path: 'observedUsage.inputTokens',
        message: `Observed input tokens (${observedUsage.inputTokens}) exceed maxInputTokens (${request.maxInputTokens})`,
        code: 'USAGE_EXCEEDS_CAPS',
      });
    }
    if (observedUsage.outputTokens > request.maxOutputTokens) {
      usageErrors.push({
        path: 'observedUsage.outputTokens',
        message: `Observed output tokens (${observedUsage.outputTokens}) exceed maxOutputTokens (${request.maxOutputTokens})`,
        code: 'USAGE_EXCEEDS_CAPS',
      });
    }
    if (observedUsage.costUsd > request.maxCostUsd) {
      usageErrors.push({
        path: 'observedUsage.costUsd',
        message: `Observed cost ($${observedUsage.costUsd}) exceeds maxCostUsd ($${request.maxCostUsd})`,
        code: 'USAGE_EXCEEDS_CAPS',
      });
    }
    if (
      observedUsage.billableTokens !== undefined &&
      observedUsage.billableTokens > request.maxBillableTokens
    ) {
      usageErrors.push({
        path: 'observedUsage.billableTokens',
        message: `Observed billable tokens (${observedUsage.billableTokens}) exceed maxBillableTokens (${request.maxBillableTokens})`,
        code: 'USAGE_EXCEEDS_CAPS',
      });
    }

    if (usageErrors.length > 0) {
      return {
        outcome: 'invalid',
        errors: usageErrors,
        observedUsage,
      };
    }

    return {
      outcome: 'observed',
      result: {
        proposal,
        observedUsage,
      },
    };
  }
}
