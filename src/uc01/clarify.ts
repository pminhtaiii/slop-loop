import { IntakeBinder } from './intake.ts';
import { validateProposal, type Intake, type Proposal, type Question, type TrustedContext, type Validation } from './contracts.ts';

export type Clarification = Intake & Readonly<{ priorQuestions: readonly Question[]; unansweredQuestions: readonly Question[] }>;

/** Pure projection; the caller owns trusted continuation resolution and storage. */
export function bindClarification(invocation: unknown, context: unknown): Validation<Clarification> {
  const intake = new IntakeBinder().bind(invocation, context);
  if (!intake.ok) return intake;
  const priorQuestions = Object.freeze((intake.value.context.continuation?.questions ?? []).map(question =>
    Object.freeze({ ...question, affects: Object.freeze([...question.affects]) })));
  const answered = new Set(intake.value.invocation.answers.map(answer => answer.questionId));
  return { ok: true, value: { ...intake.value, priorQuestions,
    unansweredQuestions: Object.freeze(priorQuestions.filter(question => !answered.has(question.id))) } };
}

export function projectClarification(proposal: unknown, binding: Clarification, context: TrustedContext = binding.context): Validation<Proposal> {
  const parsed = validateProposal(proposal, context);
  if (!parsed.ok) return parsed;
  const questions = [...binding.unansweredQuestions];
  for (const question of parsed.value.questions) {
    const prior = binding.priorQuestions.find(entry => entry.id === question.id);
    if (prior) {
      if (!binding.unansweredQuestions.some(entry => entry.id === prior.id) || question.text !== prior.text || question.reason !== prior.reason
        || JSON.stringify(question.affects) !== JSON.stringify(prior.affects)) {
        return { ok: false, status: 'error', reasonCode: 'invalid-model-output', path: '$.questions' };
      }
    } else questions.push(question);
  }
  if (questions.length > context.limits.questions) return { ok: false, status: 'error', reasonCode: 'question-budget-exhausted', path: '$.questions' };
  return validateProposal({ ...parsed.value, questions }, context);
}
