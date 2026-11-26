/** Validates advisory session metadata and reissues prior source coordinates through the current run's registry. */
import type { AdmittedSpanV1, QuestionBudgetProfileV1, QuestionClosedOutcomeV1, QuestionIdentityV1, SourceSnapshotV1 } from '../contracts/questions/contracts.ts';
import { validateRepositoryBinding } from '../contracts/questions/validation.ts';
import { isCanonicalRelativePath, isRecord, validateDigest, validateId, validateLineRange } from '../contracts/questions/validation/shared.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionEvidenceRegistryV1 } from './evidence.ts';
import { questionStop, repositoryStop } from './graph-investigation.ts';
import type { QuestionSourceReference } from './graph-types.ts';
import { copySessionConstraints, projectQuestionSession, safeSessionText } from './session-projection.ts';
import type { QuestionSessionProjection } from './session-types.ts';
import { sameBinding } from './retrieval-admission.ts';

export interface QuestionContinuation {
  readonly context: QuestionSessionProjection | null;
  readonly references: readonly QuestionSourceReference[];
}

/** Copies bounded metadata only; source text and issuance IDs never enter retained references. */
export function copyQuestionSourceReferences(input: unknown, identity: QuestionIdentityV1, profile: QuestionBudgetProfileV1): readonly QuestionSourceReference[] | undefined {
  if (!Array.isArray(input) || input.length > Math.min(profile.runtime.maxToolCalls, profile.retrieval.maxChunks)) return undefined;
  const result: QuestionSourceReference[] = [];
  for (const item of input as unknown[]) {
    if (!isRecord(item) || Object.keys(item).sort().join(',') !== 'binding,excerptDigest,manifestDigest,originalByteDigest,path,range,sessionId,snapshotId,taskId') return undefined;
    const { binding: rawBinding, range: rawRange, sessionId, taskId, snapshotId, manifestDigest, path, originalByteDigest, excerptDigest } = item;
    const binding = validateRepositoryBinding(isRecord(rawBinding) ? { ...rawBinding } : rawBinding);
    const range = validateLineRange(isRecord(rawRange) ? { ...rawRange } : rawRange, 'range');
    if (
      !binding.ok ||
      !range.ok ||
      !sameBinding(binding.value, identity.binding) ||
      sessionId !== identity.sessionId ||
      taskId !== identity.taskId ||
      validateId(snapshotId, 'snapshotId') ||
      validateDigest(manifestDigest, 'manifestDigest') ||
      validateDigest(originalByteDigest, 'originalByteDigest') ||
      validateDigest(excerptDigest, 'excerptDigest') ||
      !isCanonicalRelativePath(path) ||
      Buffer.byteLength(path) > profile.repository.maxPathBytes ||
      range.value.endLine - range.value.startLine + 1 > profile.repository.maxSpanLines
    )
      return undefined;
    result.push(
      Object.freeze({
        sessionId: identity.sessionId,
        taskId: identity.taskId,
        binding: binding.value,
        snapshotId: snapshotId as string,
        manifestDigest: manifestDigest as string,
        path,
        range: range.value,
        originalByteDigest: originalByteDigest as string,
        excerptDigest: excerptDigest as string,
      }),
    );
  }
  return Object.freeze(result);
}

/** Context is user intent, never source evidence. Mandatory fields are not shortened to fit. */
export function prepareQuestionContinuation(input: unknown, identity: QuestionIdentityV1, profile: QuestionBudgetProfileV1): QuestionContinuation | undefined {
  if (input === undefined) return { context: null, references: [] };
  if (!isRecord(input) || Object.keys(input).some(key => key !== 'context' && key !== 'sourceReferences')) return undefined;
  const { context, sourceReferences = [] } = input;
  if (!isRecord(context) || Object.keys(context).sort().join(',') !== 'binding,constraints,conversation,intent,pendingClarification,taskId') return undefined;
  const { binding: rawBinding, taskId, intent, constraints, pendingClarification, conversation } = context;
  const checkedConstraints = copySessionConstraints(constraints, 8192);
  const binding = validateRepositoryBinding(isRecord(rawBinding) ? { ...rawBinding } : rawBinding);
  if (
    !binding.ok ||
    !sameBinding(binding.value, identity.binding) ||
    taskId !== identity.taskId ||
    !safeSessionText(intent, profile.repository.maxQueryBytes) ||
    !checkedConstraints ||
    (pendingClarification !== null && !safeSessionText(pendingClarification, 8192)) ||
    !Array.isArray(conversation) ||
    conversation.length > 1000
  )
    return undefined;
  const turns: { readonly role: 'user'; readonly text: string }[] = [];
  for (const turn of conversation as unknown[]) {
    if (!isRecord(turn) || Object.keys(turn).sort().join(',') !== 'role,text') return undefined;
    const { role, text } = turn;
    if (role !== 'user' || !safeSessionText(text, profile.runtime.maxConversationBytes)) return undefined;
    turns.push({ role, text });
  }
  const projected = projectQuestionSession(
    { taskId: identity.taskId, binding: binding.value, intent, constraints: checkedConstraints, pendingClarification, conversation: turns },
    profile.runtime.maxConversationBytes,
  );
  const references = copyQuestionSourceReferences(sourceReferences, identity, profile);
  return projected && references ? Object.freeze({ context: projected, references }) : undefined;
}

/** Each saved coordinate must match this exact snapshot and the newly issued original/excerpt bytes. */
export async function readQuestionContinuation(
  references: readonly QuestionSourceReference[],
  snapshot: SourceSnapshotV1,
  registry: QuestionEvidenceRegistryV1,
  evidence: AdmittedSpanV1[],
  control: QuestionRepositoryOperationControl,
  stop: () => QuestionClosedOutcomeV1 | undefined,
): Promise<QuestionClosedOutcomeV1 | undefined> {
  for (const reference of references) {
    const before = stop();
    if (before) return before;
    if (
      reference.snapshotId !== snapshot.snapshotId ||
      reference.manifestDigest !== snapshot.manifestDigest ||
      snapshot.manifest.find(file => file.path === reference.path)?.originalByteDigest !== reference.originalByteDigest
    )
      return questionStop('source-mismatch');
    if (
      evidence.some(
        span =>
          span.path === reference.path &&
          span.range.startLine === reference.range.startLine &&
          span.range.endLine === reference.range.endLine &&
          span.originalByteDigest === reference.originalByteDigest &&
          span.excerptDigest === reference.excerptDigest,
      )
    )
      continue;
    const read = await registry.readSpan({ path: reference.path, startLine: reference.range.startLine, endLine: reference.range.endLine }, control);
    const after = stop();
    if (after) return after;
    if (read.status !== 'ok') return repositoryStop(read);
    if (
      read.span.range.startLine !== reference.range.startLine ||
      read.span.range.endLine !== reference.range.endLine ||
      read.span.originalByteDigest !== reference.originalByteDigest ||
      read.span.excerptDigest !== reference.excerptDigest
    )
      return questionStop('source-mismatch');
    evidence.push(read.span);
  }
  return undefined;
}

export function retainQuestionSourceReferences(spans: readonly AdmittedSpanV1[], profile: QuestionBudgetProfileV1): readonly QuestionSourceReference[] {
  return Object.freeze(
    spans.slice(-Math.min(profile.runtime.maxToolCalls, profile.retrieval.maxChunks)).map(span =>
      Object.freeze({
        sessionId: span.identity.sessionId,
        taskId: span.identity.taskId,
        binding: span.identity.binding,
        snapshotId: span.snapshotId,
        manifestDigest: span.manifestDigest,
        path: span.path,
        range: span.range,
        originalByteDigest: span.originalByteDigest,
        excerptDigest: span.excerptDigest,
      }),
    ),
  );
}
