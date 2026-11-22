/** Sequential question investigation. Owns routing, not provider authority, source access, or task accounting. */
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type {
  AdmittedSpanV1,
  QuestionClosedOutcomeV1,
  QuestionIndexedChunkV1,
  QuestionModelDecisionV1,
  QuestionResultV1,
  QuestionRetrievalResultV1,
  QuestionUsageV1,
} from '../contracts/questions/contracts.ts';
import { validateQuestionBudgetProfile, validateQuestionIdentity, validateQuestionIndexedChunk, validateSourceSnapshot } from '../contracts/questions/validation.ts';
import { containsProtectedContent } from '../foundation/docker-workspace-policy.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import { createQuestionEvidenceRegistry } from './evidence.ts';
import { createQuestionModelPort, type QuestionModelOutcomeV1 } from './model.ts';
import { withRetrievalControl } from './retrieval-control.ts';
import { createQuestionRetrieval } from './retrieval.ts';
import { sameBinding } from './retrieval-admission.ts';
import { createQuestionConversationNodes } from './graph-outcomes.ts';
import { admitInvestigationBinding, budgetStop, definitionHint, investigateQuestionTool, investigationRepository, questionStop, repositoryStop } from './graph-investigation.ts';
import type { QuestionInvestigationConfiguration, QuestionInvestigationCreation, QuestionInvestigationOptions, QuestionInvestigationRun } from './graph-types.ts';

export type { QuestionInvestigation, QuestionInvestigationCreation, QuestionInvestigationOptions, QuestionInvestigationRun } from './graph-types.ts';

const InvestigationState = Annotation.Root({
  evidence: Annotation<readonly AdmittedSpanV1[]>(),
  observations: Annotation<readonly string[]>(),
  decision: Annotation<QuestionModelDecisionV1 | null>(),
  visibleEvidenceIds: Annotation<readonly string[]>(),
  usage: Annotation<QuestionUsageV1>(),
  result: Annotation<QuestionResultV1 | null>(),
  retrieval: Annotation<QuestionRetrievalResultV1 | null>(),
});
type State = typeof InvestigationState.State;

/** Validates host configuration without IO; one returned instance represents exactly one admitted run. */
export function createQuestionInvestigation(options: QuestionInvestigationOptions): QuestionInvestigationCreation {
  const identity = validateQuestionIdentity(options?.identity);
  const snapshot = validateSourceSnapshot(options?.snapshot);
  const profile = validateQuestionBudgetProfile(options?.profile);
  if (
    !identity.ok ||
    !snapshot.ok ||
    !profile.ok ||
    !sameBinding(identity.value.binding, snapshot.value.binding) ||
    typeof options?.repository?.checkBinding !== 'function' ||
    typeof options.repository.readSpan !== 'function' ||
    typeof options.repository.listDirectory !== 'function' ||
    typeof options.repository.searchLiteral !== 'function' ||
    typeof options?.index?.read !== 'function' ||
    typeof options.index.validateCurrent !== 'function' ||
    typeof options?.budget?.snapshot !== 'function'
  )
    return { ok: false, reasonCode: 'invalid-config' };
  const config: QuestionInvestigationConfiguration = Object.freeze({
    ...options,
    identity: identity.value,
    snapshot: snapshot.value,
    profile: profile.value,
    repository: Object.freeze({
      checkBinding: options.repository.checkBinding.bind(options.repository),
      readSpan: options.repository.readSpan.bind(options.repository),
      listDirectory: options.repository.listDirectory.bind(options.repository),
      searchLiteral: options.repository.searchLiteral.bind(options.repository),
    }),
    index: Object.freeze({ read: options.index.read.bind(options.index), validateCurrent: options.index.validateCurrent.bind(options.index) }),
  });
  const model = createQuestionModelPort({ ...config.model, identity: config.identity, profile: config.profile, budget: config.budget });
  if (!model.ok) return { ok: false, reasonCode: 'invalid-config' };
  const modelPort = model.value;
  const repository = investigationRepository(config);
  const registry = createQuestionEvidenceRegistry({ identity: config.identity, snapshot: config.snapshot, repository, budget: config.budget, repositoryLimits: config.profile.repository });
  if (!registry.ok) return { ok: false, reasonCode: 'invalid-config' };
  const evidenceRegistry = registry.value;
  const chunks = new Map<string, QuestionIndexedChunkV1>();
  const linkedDefinitions = new Map<string, QuestionIndexedChunkV1>();
  let retrieval;
  try {
    retrieval = createQuestionRetrieval({
      identity: config.identity,
      snapshot: config.snapshot,
      generationId: config.generationId,
      embeddingDigest: config.embeddingDigest,
      limits: config.profile.retrieval,
      repositoryLimits: config.profile.repository,
      repository: config.repository,
      budget: config.budget,
      embedding: config.embedding,
      index: {
        ...config.index,
        async read(request, control) {
          const result = await config.index.read(request, control);
          if (result.status === 'ok' && Array.isArray(result.chunks) && result.chunks.length <= request.maxChunks) {
            for (const row of result.chunks) {
              const checked = validateQuestionIndexedChunk(row?.metadata);
              if (checked.ok) chunks.set(checked.value.chunkId, checked.value);
            }
          }
          return result;
        },
      },
    });
  } catch {
    return { ok: false, reasonCode: 'invalid-config' };
  }
  const source = retrieval;
  let started = false;
  const closedResult = (outcome: QuestionClosedOutcomeV1, usage: QuestionUsageV1): QuestionResultV1 =>
    Object.freeze({ schemaVersion: 'repository-question/1', identity: config.identity, usage, ...outcome });

  async function run(question: string, control: QuestionRepositoryOperationControl): Promise<QuestionInvestigationRun> {
    const initialUsage: QuestionUsageV1 = { status: 'missing' };
    const failed = (outcome: QuestionClosedOutcomeV1): QuestionInvestigationRun => Object.freeze({ result: closedResult(outcome, initialUsage), retrieval: null });
    if (started) return failed(questionStop('invalid-decision'));
    started = true;
    if (
      !control ||
      !(control.signal instanceof AbortSignal) ||
      !Number.isFinite(control.deadlineEpochMs) ||
      typeof question !== 'string' ||
      !question.trim() ||
      Buffer.byteLength(question) > config.profile.repository.maxQueryBytes ||
      !question.isWellFormed()
    )
      return failed(questionStop('invalid-decision'));
    if (containsProtectedContent(question)) return failed(questionStop('protected-content'));
    const stop = (preferred?: QuestionClosedOutcomeV1): QuestionClosedOutcomeV1 | undefined => {
      if (Date.now() >= control.deadlineEpochMs) return questionStop('deadline');
      if (control.signal.aborted) {
        config.budget.cancel();
        return questionStop('cancelled');
      }
      if (control.work && (control.work.remaining('scannedFiles') <= 0 || control.work.remaining('scannedBytes') <= 0)) return questionStop('scan-limit');
      if (control.work && control.work.remaining('returnedBytes') <= 0) return questionStop('output-limit');
      const budget = config.budget.snapshot();
      if (budget.status !== 'open') return budget.status === 'exhausted' && preferred?.kind === 'budget-exhausted' ? preferred : budgetStop(budget.status);
      if (budget.remainingElapsedMs <= 0) return questionStop('elapsed-deadline');
      return undefined;
    };
    const close = (outcome: QuestionClosedOutcomeV1, state: State) => ({ result: closedResult(outcome, state.usage) });
    const conversation = createQuestionConversationNodes(config, evidenceRegistry, control, stop);
    const app = new StateGraph(InvestigationState)
      .addNode('Admit', async (state: State) => {
        const before = stop();
        if (before) return close(before, state);
        const bindingFailure = await admitInvestigationBinding(config, repository, control);
        const afterBinding = stop(bindingFailure);
        if (afterBinding) return close(afterBinding, state);
        if (bindingFailure) return close(bindingFailure, state);
        const observation = await source.rank(
          { schemaVersion: 'question-retrieval/1', identity: config.identity, generationId: config.generationId, queryText: question, limits: config.profile.retrieval },
          control,
        );
        const after = stop(observation.status !== 'complete' && observation.status !== 'empty' ? repositoryStop(observation) : undefined);
        if (after) return { ...close(after, state), retrieval: observation };
        if (observation.status !== 'complete' && observation.status !== 'empty') return { ...close(repositoryStop(observation), state), retrieval: observation };
        const evidence: AdmittedSpanV1[] = [];
        const observations: string[] = [];
        for (const hit of observation.ranked) {
          const admitted = await source.admit(observation, hit.chunkId, control);
          const afterAdmission = stop(admitted.status !== 'ok' ? repositoryStop(admitted) : undefined);
          if (afterAdmission) return { ...close(afterAdmission, state), retrieval: observation };
          if (admitted.status !== 'ok') return { ...close(repositoryStop(admitted), state), retrieval: observation };
          // Issuance cannot be copied between registries. This extra guarded read is charged independently.
          const read = await evidenceRegistry.readSpan({ path: hit.path, startLine: hit.startLine, endLine: hit.endLine }, control);
          const afterRead = stop(read.status !== 'ok' ? repositoryStop(read) : undefined);
          if (afterRead) return { ...close(afterRead, state), retrieval: observation };
          if (read.status !== 'ok') return { ...close(repositoryStop(read), state), retrieval: observation };
          if (
            read.span.range.startLine !== hit.startLine ||
            read.span.range.endLine !== hit.endLine ||
            read.span.originalByteDigest !== hit.originalByteDigest ||
            read.span.excerptDigest !== hit.excerptDigest
          )
            return { ...close(questionStop('source-mismatch'), state), retrieval: observation };
          evidence.push(read.span);
          const chunk = chunks.get(hit.chunkId);
          if (
            chunk &&
            chunk.path === hit.path &&
            chunk.startLine === hit.startLine &&
            chunk.endLine === hit.endLine &&
            chunk.originalByteDigest === hit.originalByteDigest &&
            chunk.excerptDigest === hit.excerptDigest
          ) {
            linkedDefinitions.set(chunk.chunkId, chunk);
            const hint = definitionHint(chunk, read.span, config.profile.repository.maxSpanLines);
            if (hint) observations.push(hint);
          }
        }
        return { retrieval: observation, evidence: Object.freeze(evidence), observations: Object.freeze(observations) };
      })
      .addNode('Decide', async (state: State) => {
        const before = stop();
        if (before) return close(before, state);
        const response = await withRetrievalControl<QuestionModelOutcomeV1>(
          control,
          bounded => modelPort.decide({ question, evidence: state.evidence, observations: state.observations }, bounded.signal, bounded.deadlineEpochMs),
          failure => ({
            status: 'stopped',
            reasonCode: failure.reasonCode === 'deadline' ? 'elapsed-deadline' : 'cancelled',
            usage: { status: 'unknown', reasonCode: failure.reasonCode === 'deadline' ? 'timeout' : 'cancelled' },
          }),
        );
        const after = stop(response.status === 'stopped' ? questionStop(response.reasonCode) : undefined);
        if (response.status !== 'ok' && !control.signal.aborted && Date.now() < control.deadlineEpochMs)
          return { result: closedResult(questionStop(response.reasonCode), response.usage), usage: response.usage };
        if (after) return { result: closedResult(after, response.usage), usage: response.usage };
        if (response.status !== 'ok') return { result: closedResult(questionStop(response.reasonCode), response.usage), usage: response.usage };
        return { decision: response.decision, usage: response.usage, visibleEvidenceIds: response.visibleEvidenceIds };
      })
      .addNode('Validate', (state: State) => {
        const before = stop();
        if (before) return close(before, state);
        const decision = state.decision;
        if (!decision || !['answer', 'read', 'search', 'list', 'clarify', 'insufficient'].includes(decision.kind)) return close(questionStop('invalid-decision'), state);
        if (
          (decision.kind === 'answer' || decision.kind === 'insufficient') &&
          decision.claims?.some(claim => claim.evidence.some(reference => !state.visibleEvidenceIds.includes(reference.evidenceId)))
        )
          return close(questionStop('invalid-citation'), state);
        return {};
      })
      .addNode('Clarify', conversation.clarify)
      .addNode('Insufficient', conversation.insufficient)
      .addNode('Read', async (state: State) => {
        const before = stop();
        if (before) return close(before, state);
        if (!state.decision) return close(questionStop('invalid-decision'), state);
        const result = await investigateQuestionTool(state.decision, config, repository, evidenceRegistry, control);
        const after = stop(result.status === 'stopped' ? result.outcome : undefined);
        if (after) return close(after, state);
        if (result.status !== 'ok') return close(result.outcome, state);
        const hints = [...result.evidence].flatMap(span =>
          [...linkedDefinitions.values()]
            .filter(chunk => chunk.path === span.path && chunk.definition && span.range.startLine >= chunk.definition.startLine && span.range.endLine <= chunk.definition.endLine)
            .slice(0, 1)
            .flatMap(chunk => {
              const hint = definitionHint(chunk, span, config.profile.repository.maxSpanLines);
              return hint ? [hint] : [];
            }),
        );
        return { evidence: Object.freeze([...state.evidence, ...result.evidence]), observations: Object.freeze([...state.observations, result.observation, ...hints]), decision: null };
      })
      .addNode('Deliver', async (state: State) => {
        const before = stop();
        if (before) return close(before, state);
        if (state.decision?.kind !== 'answer') return close(questionStop('invalid-decision'), state);
        const presentation = await evidenceRegistry.present(state.decision, control);
        const after = stop(presentation.kind === 'budget-exhausted' ? questionStop(presentation.reasonCode) : undefined);
        if (after) return close(after, state);
        if (presentation.kind !== 'delivered') return close(presentation.kind === 'budget-exhausted' ? questionStop(presentation.reasonCode) : presentation, state);
        const result: QuestionResultV1 = Object.freeze({
          schemaVersion: 'repository-question/1',
          identity: config.identity,
          usage: state.usage,
          kind: 'answered',
          claims: presentation.claims,
          citations: presentation.citations,
          limitations: presentation.limitations,
        });
        return { result };
      })
      .addEdge(START, 'Admit')
      .addConditionalEdges('Admit', state => (state.result ? END : 'Decide'))
      .addConditionalEdges('Decide', state => (state.result ? END : 'Validate'))
      .addConditionalEdges('Validate', state =>
        state.result ? END : state.decision?.kind === 'answer' ? 'Deliver' : state.decision?.kind === 'clarify' ? 'Clarify' : state.decision?.kind === 'insufficient' ? 'Insufficient' : 'Read',
      )
      .addConditionalEdges('Read', state => (state.result ? END : 'Decide'))
      .addEdge('Deliver', END)
      .addEdge('Clarify', END)
      .addEdge('Insufficient', END)
      .compile();
    try {
      const final = await app.invoke(
        { evidence: [], observations: [], decision: null, visibleEvidenceIds: [], usage: initialUsage, result: null, retrieval: null },
        { recursionLimit: Math.min(100000, config.profile.runtime.maxModelCalls * 4 + 8) },
      );
      return Object.freeze({ result: final.result ?? closedResult(questionStop('invalid-decision'), final.usage), retrieval: final.retrieval });
    } catch {
      return failed(stop() ?? questionStop('unavailable'));
    } finally {
      source.close();
    }
  }
  return Object.freeze({ ok: true, value: Object.freeze({ run }) });
}
