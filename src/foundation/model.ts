import { safeSnapshot } from '../contracts/foundation/uc03/v02/admission/snapshot.ts';
/**
 * UC-03 Host Model Boundary (Slice A: T008-a; Amendment: T051/T052)
 *
 * Implements canonical ModelPort (v0.1) and re-exports versioned ModelPortV02 (v0.2)
 * with injected host transport, authoritative admission loader, and StatePortV02
 * journal admission.
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
} from '../contracts/foundation/uc03.ts';

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

export function deepClone<T>(val: T, seen = new WeakMap<object, unknown>()): T {
  if (val === null || typeof val !== 'object') return val;
  if (seen.has(val)) return seen.get(val) as T;
  if (Array.isArray(val)) {
    const copyArr: unknown[] = [];
    seen.set(val, copyArr);
    for (const item of val) copyArr.push(deepClone(item, seen));
    return copyArr as unknown as T;
  }
  const copyObj: Record<string, unknown> = {};
  seen.set(val, copyObj);
  for (const key of Object.keys(val)) {
    copyObj[key] = deepClone((val as Record<string, unknown>)[key], seen);
  }
  return copyObj as T;
}

export function deepFreeze<T>(val: T, seen = new WeakSet<object>()): Readonly<T> {
  if (val === null || typeof val !== 'object') return val;
  if (seen.has(val)) return val;
  seen.add(val);
  Object.freeze(val);
  if (Array.isArray(val)) {
    for (const item of val) deepFreeze(item, seen);
  } else {
    for (const key of Object.keys(val)) {
      deepFreeze((val as Record<string, unknown>)[key], seen);
    }
  }
  return val;
}

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

export function validateBaseModelInputs(
  snapshotState: TaskState,
  snapshotEvidence: readonly SourceEvidence[],
  snapshotRequest: ProviderRequest,
  snapshotConfig?: HostProviderConfig
): { ok: true; contextDigest: string } | { ok: false; outcome: 'invalid'; errors: readonly ValidationError[] } {
  const stateRes = validateTaskState(snapshotState);
  if (!stateRes.ok) {
    return { ok: false, outcome: 'invalid', errors: sanitizeValidationErrors(stateRes.errors) };
  }

  if (!Array.isArray(snapshotEvidence)) {
    return {
      ok: false,
      outcome: 'invalid',
      errors: [{ path: 'evidence', message: 'evidence must be an array', code: 'INVALID_TYPE' }],
    };
  }

  for (let i = 0; i < snapshotEvidence.length; i++) {
    const item = snapshotEvidence[i];
    const evRes = validateSourceEvidence(item, undefined, `evidence[${i}]`);
    if (!evRes.ok) {
      return { ok: false, outcome: 'invalid', errors: sanitizeValidationErrors(evRes.errors) };
    }
    if (item.revisionDigest !== snapshotState.repositoryRevisionDigest) {
      return {
        ok: false,
        outcome: 'invalid',
        errors: [
          {
            path: `evidence[${i}].revisionDigest`,
            message: `Evidence revisionDigest ${item.revisionDigest} does not match current state revisionDigest ${snapshotState.repositoryRevisionDigest}`,
            code: 'STALE_EVIDENCE_REVISION',
          },
        ],
      };
    }
    if (containsProtectedContent(item.boundedExcerpt)) {
      return {
        ok: false,
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

  const computedContextDigest = computeContextDigest(snapshotState, snapshotEvidence);
  const cfg = snapshotConfig;
  const reqRes = validateProviderRequest(snapshotRequest, {
    expectedTaskId: snapshotState.taskId,
    expectedRunId: snapshotState.runId,
    expectedContextDigest: computedContextDigest,
    ...(cfg?.providerId !== undefined ? { expectedProviderId: cfg.providerId } : {}),
    ...(cfg?.modelId !== undefined ? { expectedModelId: cfg.modelId } : {}),
    ...(cfg?.configId !== undefined ? { expectedConfigId: cfg.configId } : {}),
    ...(cfg?.pricingPolicyId !== undefined ? { expectedPricingPolicyId: cfg.pricingPolicyId } : {}),
  });
  if (!reqRes.ok) {
    return { ok: false, outcome: 'invalid', errors: sanitizeValidationErrors(reqRes.errors) };
  }

  return { ok: true, contextDigest: computedContextDigest };
}

export function buildTransportPayload(
  snapshotState: TaskState,
  snapshotEvidence: readonly SourceEvidence[],
  snapshotRequest: ProviderRequest
): HostModelTransportPayload {
  const caps: HostModelCaps = deepFreeze({
    timeoutMs: snapshotRequest.timeoutMs,
    maxInputTokens: snapshotRequest.maxInputTokens,
    maxOutputTokens: snapshotRequest.maxOutputTokens,
    maxBillableTokens: snapshotRequest.maxBillableTokens,
    maxCostUsd: snapshotRequest.maxCostUsd,
  });

  const untrustedEvidenceItems: readonly UntrustedContextItem[] = deepFreeze(
    snapshotEvidence.map((e) => ({
      path: e.path,
      revisionDigest: e.revisionDigest,
      content: e.boundedExcerpt,
      isUntrustedRepositoryContent: true as const,
    }))
  );

  return deepFreeze({
    state: snapshotState,
    evidence: snapshotEvidence,
    request: snapshotRequest,
    caps,
    untrustedContext: {
      evidenceItems: untrustedEvidenceItems,
    },
  });
}

function checkUsageCaps(
  snapshotRequest: ProviderRequest,
  observedUsage: ProviderUsage
): readonly ValidationError[] {
  const usageErrors: ValidationError[] = [];
  if (observedUsage.inputTokens > snapshotRequest.maxInputTokens) {
    usageErrors.push({
      path: 'observedUsage.inputTokens',
      message: `Observed input tokens (${observedUsage.inputTokens}) exceed maxInputTokens (${snapshotRequest.maxInputTokens})`,
      code: 'USAGE_EXCEEDS_CAPS',
    });
  }
  if (observedUsage.outputTokens > snapshotRequest.maxOutputTokens) {
    usageErrors.push({
      path: 'observedUsage.outputTokens',
      message: `Observed output tokens (${observedUsage.outputTokens}) exceed maxOutputTokens (${snapshotRequest.maxOutputTokens})`,
      code: 'USAGE_EXCEEDS_CAPS',
    });
  }
  if (observedUsage.costUsd > snapshotRequest.maxCostUsd) {
    usageErrors.push({
      path: 'observedUsage.costUsd',
      message: `Observed cost ($${observedUsage.costUsd}) exceeds maxCostUsd ($${snapshotRequest.maxCostUsd})`,
      code: 'USAGE_EXCEEDS_CAPS',
    });
  }
  if (
    observedUsage.billableTokens !== undefined &&
    observedUsage.billableTokens > snapshotRequest.maxBillableTokens
  ) {
    usageErrors.push({
      path: 'observedUsage.billableTokens',
      message: `Observed billable tokens (${observedUsage.billableTokens}) exceed maxBillableTokens (${snapshotRequest.maxBillableTokens})`,
      code: 'USAGE_EXCEEDS_CAPS',
    });
  }
  return usageErrors;
}

export type ExecutedTransportResult =
  | { readonly outcome: 'observed'; readonly result: { readonly proposal: unknown; readonly observedUsage: ProviderUsage }; readonly observedUsage: ProviderUsage }
  | { readonly outcome: 'uncertain'; readonly reason: string; readonly observedUsage?: ProviderUsage | undefined }
  | { readonly outcome: 'denied'; readonly reason: string }
  | { readonly outcome: 'invalid'; readonly errors: readonly ValidationError[]; readonly observedUsage?: ProviderUsage | undefined };

export async function executeTransport(
  transport: HostModelTransport,
  payload: HostModelTransportPayload,
  snapshotRequest: ProviderRequest
): Promise<ExecutedTransportResult> {
  let rawResult: unknown;
  try {
    rawResult = await transport.execute(payload);
  } catch (err: unknown) {
    let timeout = false;
    try {
      if (typeof err === 'object' && err !== null) {
        const name = Object.getOwnPropertyDescriptor(err, 'name');
        const message = Object.getOwnPropertyDescriptor(err, 'message');
        timeout = (name !== undefined && 'value' in name && name.value === 'TimeoutError')
          || (message !== undefined && 'value' in message && typeof message.value === 'string'
            && /timeout|timed out/i.test(message.value));
      }
    } catch {
      // Failed descriptor inspection leaves the rejection unclassified.
    }
    return { outcome: 'uncertain', reason: timeout
      ? 'PROVIDER_TIMEOUT: Model transport request timed out'
      : 'PROVIDER_ERROR: Model transport request failed' };
  }

  const snapshot = safeSnapshot(rawResult);
  if (!snapshot.ok) return { outcome: 'uncertain', reason: 'UNSAFE_PROVIDER_RESPONSE' };
  rawResult = snapshot.value;

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
      if (usageCheck.ok) observedUsage = usageCheck.value;
    }
    return {
      outcome: 'invalid',
      errors: sanitizeValidationErrors(modelResultRes.errors),
      ...(observedUsage !== undefined ? { observedUsage } : {}),
    };
  }

  const { proposal, observedUsage } = modelResultRes.value;
  const usageErrors = checkUsageCaps(snapshotRequest, observedUsage);
  if (usageErrors.length > 0) {
    return { outcome: 'invalid', errors: usageErrors, observedUsage };
  }

  return { outcome: 'observed', result: { proposal, observedUsage }, observedUsage };
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
    const snapshotState = deepFreeze(deepClone(state));
    const snapshotEvidence = deepFreeze(deepClone(evidence));
    const snapshotRequest = deepFreeze(deepClone(request));
    const snapshotConfig =
      this.options.providerConfig !== undefined
        ? deepFreeze(deepClone(this.options.providerConfig))
        : undefined;

    const baseValidation = validateBaseModelInputs(snapshotState, snapshotEvidence, snapshotRequest, snapshotConfig);
    if (!baseValidation.ok) {
      return { outcome: baseValidation.outcome, errors: baseValidation.errors };
    }
    const computedContextDigest = baseValidation.contextDigest;

    let admissionContext: DispatchAdmissionContext | null | undefined;
    try {
      const loaderRequest = deepFreeze(deepClone(snapshotRequest));
      admissionContext = await this.options.admissionLoader(loaderRequest);
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

    const admissionRes = validateDispatchAdmission(snapshotRequest, admissionContext);
    if (!admissionRes.ok) {
      const primary = admissionRes.errors[0];
      return {
        outcome: 'denied',
        reason: `${primary?.code ?? 'ADMISSION_DENIED'}: ${redactSensitiveData(primary?.message ?? 'Dispatch admission failed')}`,
      };
    }

    if (admissionContext.expectedRequest.contextDigest !== computedContextDigest) {
      return {
        outcome: 'denied',
        reason: 'CONTEXT_DIGEST_MISMATCH: Authoritative admission context digest does not match computed exact payload digest',
      };
    }

    const payload = buildTransportPayload(snapshotState, snapshotEvidence, snapshotRequest);
    const transportRes = await executeTransport(this.options.transport, payload, snapshotRequest);
    if (transportRes.outcome === 'observed') {
      return { outcome: 'observed', result: transportRes.result as Extract<ModelPortResult, { outcome: 'observed' }>['result'] };
    }
    if (transportRes.outcome === 'invalid') {
      return {
        outcome: 'invalid',
        errors: transportRes.errors,
        ...(transportRes.observedUsage !== undefined ? { observedUsage: transportRes.observedUsage } : {}),
      };
    }
    return { outcome: transportRes.outcome, reason: transportRes.reason };
  }
}

export {
  HostModelPortV02,
  buildProviderOutcomeReceipt,
  type HostModelPortV02Options,
  type ModelPortV02Result,
} from './model-v02.ts';
