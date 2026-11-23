/** Conversation terminal nodes: budgeted clarification and registry-validated partial knowledge. */
import type { QuestionClosedOutcomeV1, QuestionModelDecisionV1, QuestionResultV1, QuestionUsageV1 } from '../contracts/questions/contracts.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionEvidenceRegistryV1 } from './evidence.ts';
import { questionStop } from './graph-investigation.ts';
import type { QuestionInvestigationConfiguration } from './graph-types.ts';
import { presentQuestionClarification, presentQuestionInsufficientEvidence } from './presentation.ts';

interface ConversationState {
  readonly decision: QuestionModelDecisionV1 | null;
  readonly usage: QuestionUsageV1;
}
interface ConversationUpdate {
  readonly result: QuestionResultV1;
}

/** Uses the run's existing control, ledger and evidence owner; no retry or continuation is created here. */
export function createQuestionConversationNodes(
  config: QuestionInvestigationConfiguration,
  registry: QuestionEvidenceRegistryV1,
  control: QuestionRepositoryOperationControl,
  stop: (preferred?: QuestionClosedOutcomeV1) => QuestionClosedOutcomeV1 | undefined,
): { clarify(state: ConversationState): Promise<ConversationUpdate>; insufficient(state: ConversationState): Promise<ConversationUpdate> } {
  const close = (outcome: QuestionClosedOutcomeV1, state: ConversationState): ConversationUpdate => ({
    result: Object.freeze({ schemaVersion: 'repository-question/1', identity: config.identity, usage: state.usage, ...outcome }),
  });
  return {
    async clarify(state) {
      const before = stop();
      if (before) return close(before, state);
      if (state.decision?.kind !== 'clarify') return close(questionStop('invalid-decision'), state);
      const round = config.budget.snapshot().consumed.clarificationRounds + 1;
      if (round > config.profile.runtime.maxClarificationRounds)
        return {
          result: presentQuestionInsufficientEvidence(config.identity, state.usage, 'Clarification limit reached; the intended referent remains unresolved.', config.profile.runtime.maxFinalBytes),
        };
      const result = presentQuestionClarification(config.identity, state.usage, state.decision, round, config.profile.runtime.maxFinalBytes);
      if (result.kind !== 'awaiting-clarification') return { result };
      const admission = config.budget.reserveClarification();
      if (!admission.ok) return close(questionStop(admission.reasonCode), state);
      const charged = await admission.value.execute(
        async () => undefined,
        () => ({ kind: 'work', work: { clarificationRounds: 1 } }),
      );
      const after = stop(charged.ok ? undefined : questionStop(charged.reasonCode));
      if (after) return close(after, state);
      if (!charged.ok) return close(questionStop(charged.reasonCode), state);
      return { result };
    },
    async insufficient(state) {
      const before = stop();
      if (before) return close(before, state);
      if (state.decision?.kind !== 'insufficient') return close(questionStop('invalid-decision'), state);
      const decision = state.decision;
      const preview = presentQuestionInsufficientEvidence(config.identity, state.usage, decision.explanation, config.profile.runtime.maxFinalBytes);
      if (preview.kind !== 'insufficient-evidence' || !decision.claims?.length) return { result: preview };
      const supported = await registry.present({ kind: 'answer', claims: decision.claims, limitations: [decision.explanation] }, control);
      const after = stop(supported.kind === 'budget-exhausted' ? questionStop(supported.reasonCode) : undefined);
      if (after) return close(after, state);
      if (supported.kind !== 'delivered') return close(supported.kind === 'budget-exhausted' ? questionStop(supported.reasonCode) : supported, state);
      return {
        result: presentQuestionInsufficientEvidence(config.identity, state.usage, decision.explanation, config.profile.runtime.maxFinalBytes, {
          claims: supported.claims,
          citations: supported.citations,
          limitations: [],
        }),
      };
    },
  };
}
