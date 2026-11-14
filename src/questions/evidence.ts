/**
 * Owns run-scoped source issuance and citation authority for repository questions.
 * Reads pass through the guarded repository port and cumulative task ledger; only
 * this private registry can turn those reads into final citations.
 */
import type {
  AdmittedSpanV1,
  QuestionCitationV1,
  QuestionClaimV1,
  QuestionIdentityV1,
  QuestionLineRangeV1,
  QuestionModelDecisionV1,
  RepositoryBindingV1,
  RepositoryOperationLimitsV1,
  RepositoryToolFailureV1,
  SourceSnapshotV1,
} from '../contracts/questions/contracts.ts';
import { validateQuestionDecision, validateQuestionIdentity, validateSourceSnapshot, validateSpanResult } from '../contracts/questions/validation.ts';
import { containsProtectedContent, computeFileDigest } from '../foundation/docker-workspace-policy.ts';
import { computeSourceManifestDigest } from '../foundation/question-repository-primitives.ts';
import { isCanonicalRelativePath, isProtectedPath } from '../contracts/foundation/uc03.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionRepositoryPort } from './repository.ts';
import { renderValidatedQuestionPresentation, type QuestionPresentationResultV1, type ValidatedQuestionPresentationV1 } from './presentation.ts';
import type { QuestionBudgetLedger, QuestionBudgetRefusalCodeV1 } from './budget.ts';

export type QuestionEvidenceOperationResultV1 =
  { readonly status: 'ok'; readonly span: AdmittedSpanV1 } | RepositoryToolFailureV1 | { readonly status: 'budget-exhausted'; readonly reasonCode: QuestionBudgetRefusalCodeV1 };

export interface QuestionEvidenceRegistryV1 {
  readSpan(request: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionEvidenceOperationResultV1>;
  present(proposal: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionPresentationResultV1>;
}

export interface CreateQuestionEvidenceRegistryOptionsV1 {
  readonly identity: unknown;
  readonly snapshot: unknown;
  readonly repository: QuestionRepositoryPort;
  readonly budget: QuestionBudgetLedger;
  readonly repositoryLimits: RepositoryOperationLimitsV1;
}

export type QuestionEvidenceRegistryCreationV1 = { readonly ok: true; readonly value: QuestionEvidenceRegistryV1 } | { readonly ok: false; readonly reasonCode: 'invalid-context' };

const LIMIT_KEYS: readonly (keyof RepositoryOperationLimitsV1)[] = Object.freeze(['maxFileBytes', 'maxSpanBytes', 'maxSpanLines', 'maxPageEntries', 'maxSearchHits', 'maxQueryBytes', 'maxPathBytes']);

/** Creates one private issued-span registry bound to a validated task run and immutable source snapshot. */
export function createQuestionEvidenceRegistry(options: CreateQuestionEvidenceRegistryOptionsV1): QuestionEvidenceRegistryCreationV1 {
  const identityResult = validateQuestionIdentity(options?.identity);
  const snapshotResult = validateSourceSnapshot(options?.snapshot);
  if (!identityResult.ok || !snapshotResult.ok || !validRepositoryLimits(options?.repositoryLimits) || !hasRepositoryPort(options?.repository) || !hasBudgetLedger(options?.budget)) {
    return Object.freeze({ ok: false, reasonCode: 'invalid-context' });
  }

  const identity = identityResult.value;
  const snapshot = snapshotResult.value;
  if (
    !sameBinding(identity.binding, snapshot.binding) ||
    snapshot.manifestDigest !== computeSourceManifestDigest(snapshot.manifest) ||
    snapshot.manifest.some((entry, index, all) => isProtectedPath(entry.path) || entry.path <= (all[index - 1]?.path ?? ''))
  ) {
    return Object.freeze({ ok: false, reasonCode: 'invalid-context' });
  }

  const manifestByPath = new Map(snapshot.manifest.map(entry => [entry.path, entry.originalByteDigest]));
  const issued = new Map<string, AdmittedSpanV1>();
  const repository = options.repository;
  const budget = options.budget;
  const limits = Object.freeze({ ...options.repositoryLimits });

  async function readSpan(request: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionEvidenceOperationResultV1> {
    const decision = validateReadRequest(request);
    if (!decision || !validControl(control)) return Object.freeze({ status: 'invalid', reasonCode: 'invalid-request' });
    const admission = budget.reserveRepositoryOperation('read');
    if (!admission.ok) return budgetRefusal(admission.reasonCode);

    const operation = admission.value;
    const execution = await operation.execute(
      async context => {
        const safeControl = combineControl(control, context.signal, context.remainingMs);
        const binding = await repository.checkBinding(safeControl);
        if (binding.status !== 'ok') return binding;
        return await repository.readSpan(decision, safeControl);
      },
      () => ({ kind: 'work', work: operation.maximumWork }),
    );
    if (!execution.ok) return budgetRefusal(execution.reasonCode);

    const result = validateSpanResult(execution.value, limits);
    if (!result.ok) return Object.freeze({ status: 'unavailable', reasonCode: 'unsupported-adapter' });
    if (result.value.status !== 'ok') return result.value;
    const { span } = result.value;
    if (
      span.path !== decision.path ||
      span.range.startLine !== decision.startLine ||
      span.range.endLine > decision.endLine ||
      (span.truncation.kind === 'truncated' && span.range.endLine === decision.endLine)
    ) {
      return Object.freeze({ status: 'unavailable', reasonCode: 'unsupported-adapter' });
    }
    const admissionFailure = validateIssuedSpan(span, identity, snapshot, manifestByPath, issued);
    if (admissionFailure) return admissionFailure;
    issued.set(span.evidenceId, span);
    return Object.freeze({ status: 'ok', span });
  }

  async function present(proposal: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionPresentationResultV1> {
    const checked = validateProposal(proposal, identity, snapshot, manifestByPath, issued);
    if (checked.status !== 'ok') {
      return Object.freeze({ kind: 'failed', reasonCode: checked.status === 'protected' ? 'protected-content' : 'invalid-citation' });
    }
    if (!validControl(control)) return Object.freeze({ kind: 'cancelled', reasonCode: 'cancelled' });

    const safe = sanitizePresentation(checked.value);
    if (!safe.ok) return Object.freeze({ kind: 'failed', reasonCode: safe.reasonCode });
    const preview = renderValidatedQuestionPresentation(safe.value);
    if (preview === undefined) return Object.freeze({ kind: 'failed', reasonCode: 'invalid-citation' });

    const admission = budget.reserveFinalValidation();
    if (!admission.ok) return Object.freeze({ kind: 'budget-exhausted', reasonCode: admission.reasonCode });
    const operation = admission.value;
    const finalByteLimit = operation.maximumWork.finalBytes;
    if (finalByteLimit === undefined || Buffer.byteLength(preview, 'utf8') > finalByteLimit) {
      operation.releaseBeforeDispatch();
      return Object.freeze({ kind: 'failed', reasonCode: 'render-limit' });
    }

    const execution = await operation.execute(
      async context => {
        const safeControl = combineControl(control, context.signal, context.remainingMs);
        if (containsProtectedAnswer(safe.value)) return { status: 'protected' as const };
        const binding = await repository.checkBinding(safeControl);
        return binding.status === 'ok' ? { status: 'ok' as const } : { status: 'binding-failure' as const, binding };
      },
      () => ({ kind: 'work', work: { finalBytes: Buffer.byteLength(preview, 'utf8') } }),
    );
    if (!execution.ok) return budgetPresentationRefusal(execution.reasonCode);
    if (execution.value.status === 'protected') return Object.freeze({ kind: 'failed', reasonCode: 'protected-content' });
    if (execution.value.status === 'binding-failure') return bindingPresentationFailure(execution.value.binding);
    return Object.freeze({
      kind: 'delivered',
      claims: safe.value.claims,
      citations: safe.value.citations,
      limitations: safe.value.limitations,
      text: preview,
    });
  }

  return Object.freeze({ ok: true, value: Object.freeze({ readSpan, present }) });
}

function validateReadRequest(input: unknown): Extract<QuestionModelDecisionV1, { readonly kind: 'read' }> | undefined {
  if (!isRecord(input)) return undefined;
  const result = validateQuestionDecision({ kind: 'read', path: input['path'], startLine: input['startLine'], endLine: input['endLine'] });
  return result.ok && result.value.kind === 'read' ? result.value : undefined;
}

function validateIssuedSpan(
  span: AdmittedSpanV1,
  identity: QuestionIdentityV1,
  snapshot: SourceSnapshotV1,
  manifestByPath: ReadonlyMap<string, string>,
  issued: ReadonlyMap<string, AdmittedSpanV1>,
): RepositoryToolFailureV1 | undefined {
  const expectedDigest = manifestByPath.get(span.path);
  if (
    !sameIdentity(span.identity, identity) ||
    span.snapshotId !== snapshot.snapshotId ||
    span.manifestDigest !== snapshot.manifestDigest ||
    expectedDigest === undefined ||
    span.originalByteDigest !== expectedDigest
  ) {
    return Object.freeze({ status: 'stale', reasonCode: 'source-mismatch' });
  }
  if (
    !isSafeDisplayPath(span.path) ||
    isProtectedPath(span.path) ||
    containsProtectedContent(span.excerpt) ||
    computeFileDigest(Buffer.from(span.excerpt, 'utf8')) !== span.excerptDigest ||
    issued.has(span.evidenceId)
  ) {
    return Object.freeze({ status: 'unavailable', reasonCode: 'unsupported-adapter' });
  }
  return undefined;
}

function validateProposal(
  input: unknown,
  identity: QuestionIdentityV1,
  snapshot: SourceSnapshotV1,
  manifestByPath: ReadonlyMap<string, string>,
  issued: ReadonlyMap<string, AdmittedSpanV1>,
): { readonly status: 'ok'; readonly value: ValidatedQuestionPresentationV1 } | { readonly status: 'invalid' | 'protected' } {
  if (!isRecord(input)) return { status: 'invalid' };
  const decision = validateQuestionDecision({ kind: 'answer', claims: input['claims'], limitations: input['limitations'] });
  if (!decision.ok || decision.value.kind !== 'answer') return { status: 'invalid' };
  const claims = decision.value.claims;
  const citations: QuestionCitationV1[] = [];
  const citationKeys = new Set<string>();
  for (const claim of claims) {
    if (containsProtectedContent(claim.text)) return { status: 'protected' };
    for (const reference of claim.evidence) {
      const span = issued.get(reference.evidenceId);
      if (
        !span ||
        !sameIdentity(span.identity, identity) ||
        span.snapshotId !== snapshot.snapshotId ||
        span.manifestDigest !== snapshot.manifestDigest ||
        manifestByPath.get(span.path) !== span.originalByteDigest ||
        reference.range.startLine < span.range.startLine ||
        reference.range.endLine > span.range.endLine
      ) {
        return { status: 'invalid' };
      }
      const key = citationKey(reference.evidenceId, reference.range);
      if (!citationKeys.has(key)) {
        citationKeys.add(key);
        citations.push(
          Object.freeze({
            evidenceId: span.evidenceId,
            range: Object.freeze({ ...reference.range }),
            path: span.path,
            originalByteDigest: span.originalByteDigest,
            excerptDigest: span.excerptDigest,
          }),
        );
      }
    }
  }
  const limitations = decision.value.limitations;
  if (limitations.some(containsProtectedContent)) return { status: 'protected' };
  return {
    status: 'ok',
    value: Object.freeze({ claims, citations: Object.freeze(citations), limitations }),
  };
}

function sanitizePresentation(
  input: ValidatedQuestionPresentationV1,
): { readonly ok: true; readonly value: ValidatedQuestionPresentationV1 } | { readonly ok: false; readonly reasonCode: 'protected-content' } {
  const claims: QuestionClaimV1[] = [];
  for (const claim of input.claims) {
    const text = safeText(claim.text);
    if (text === undefined) return { ok: false, reasonCode: 'protected-content' };
    claims.push(Object.freeze({ ...claim, text }));
  }
  const limitations: string[] = [];
  for (const limitation of input.limitations) {
    const text = safeText(limitation);
    if (text === undefined) return { ok: false, reasonCode: 'protected-content' };
    limitations.push(text);
  }
  return { ok: true, value: Object.freeze({ claims: Object.freeze(claims), citations: input.citations, limitations: Object.freeze(limitations) }) };
}

function safeText(input: string): string | undefined {
  const clean = input
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!clean || containsProtectedContent(clean)) return undefined;
  return clean;
}

function containsProtectedAnswer(input: ValidatedQuestionPresentationV1): boolean {
  return (
    input.claims.some(claim => containsProtectedContent(claim.text)) ||
    input.limitations.some(containsProtectedContent) ||
    input.citations.some(citation => isProtectedPath(citation.path) || !isSafeDisplayPath(citation.path))
  );
}

function budgetRefusal(reasonCode: QuestionBudgetRefusalCodeV1): QuestionEvidenceOperationResultV1 {
  return Object.freeze({ status: 'budget-exhausted', reasonCode });
}

function budgetPresentationRefusal(reasonCode: QuestionBudgetRefusalCodeV1): QuestionPresentationResultV1 {
  if (reasonCode === 'cancelled') return Object.freeze({ kind: 'cancelled', reasonCode });
  return Object.freeze({ kind: 'budget-exhausted', reasonCode });
}

function bindingPresentationFailure(binding: Awaited<ReturnType<QuestionRepositoryPort['checkBinding']>>): QuestionPresentationResultV1 {
  if (binding.status === 'stale') return Object.freeze({ kind: 'stale-repository', reasonCode: binding.reasonCode });
  if (binding.status === 'cancelled') return Object.freeze({ kind: 'cancelled', reasonCode: 'cancelled' });
  if (binding.status === 'exhausted') return Object.freeze({ kind: 'budget-exhausted', reasonCode: 'elapsed-deadline' });
  if (binding.status === 'denied') return Object.freeze({ kind: 'blocked', reasonCode: 'owner-denied' });
  return Object.freeze({ kind: 'blocked', reasonCode: 'owner-unavailable' });
}

function combineControl(control: QuestionRepositoryOperationControl, reservationSignal: AbortSignal, remainingMs: number): QuestionRepositoryOperationControl {
  return Object.freeze({
    signal: AbortSignal.any([control.signal, reservationSignal]),
    deadlineEpochMs: Math.min(control.deadlineEpochMs, Date.now() + remainingMs),
  });
}

function validControl(input: unknown): input is QuestionRepositoryOperationControl {
  return (
    isRecord(input) &&
    isAbortSignal(input['signal']) &&
    typeof input['deadlineEpochMs'] === 'number' &&
    Number.isFinite(input['deadlineEpochMs']) &&
    input['deadlineEpochMs'] > Date.now() &&
    !input['signal'].aborted
  );
}

function hasRepositoryPort(input: unknown): input is QuestionRepositoryPort {
  return isRecord(input) && typeof input['checkBinding'] === 'function' && typeof input['readSpan'] === 'function';
}

function hasBudgetLedger(input: unknown): input is QuestionBudgetLedger {
  return isRecord(input) && typeof input['reserveRepositoryOperation'] === 'function' && typeof input['reserveFinalValidation'] === 'function';
}

function validRepositoryLimits(input: unknown): input is RepositoryOperationLimitsV1 {
  return isRecord(input) && LIMIT_KEYS.every(key => typeof input[key] === 'number' && Number.isSafeInteger(input[key]) && input[key] > 0);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isAbortSignal(input: unknown): input is AbortSignal {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  return 'aborted' in input && typeof input.aborted === 'boolean' && 'addEventListener' in input && typeof input.addEventListener === 'function';
}

function isSafeDisplayPath(path: string): boolean {
  return isCanonicalRelativePath(path) && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path);
}

function sameBinding(left: RepositoryBindingV1, right: RepositoryBindingV1): boolean {
  return left.repositoryId === right.repositoryId && left.workspaceId === right.workspaceId && left.revisionDigest === right.revisionDigest && left.policyDigest === right.policyDigest;
}

function sameIdentity(left: QuestionIdentityV1, right: QuestionIdentityV1): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.taskId === right.taskId &&
    left.runId === right.runId &&
    left.questionId === right.questionId &&
    left.configDigest === right.configDigest &&
    sameBinding(left.binding, right.binding)
  );
}

function citationKey(evidenceId: string, range: QuestionLineRangeV1): string {
  return evidenceId + ':' + range.startLine + ':' + range.endLine;
}
