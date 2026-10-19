import { isProtectedPayload } from '../foundation/telemetry.ts';
import { validateCatalog, validateProposal, type Proposal, type TrustedContext, type Validation } from './contracts.ts';

function unusedId(prefix: string, ids: readonly string[]): string {
  let suffix = 1;
  while (ids.includes(`${prefix}:${suffix}`)) suffix++;
  return `${prefix}:${suffix}`;
}

/** Pure recommendation boundary; accepted output grants no execution authority. */
export function projectRecommendation(proposal: unknown, context: unknown): Validation<Proposal> {
  const parsed = validateProposal(proposal, context);
  if (!parsed.ok) return parsed;
  const candidate = parsed.value;
  if (isProtectedPayload(candidate)) return { ok: false, status: 'error', reasonCode: 'invalid-model-output', path: '$' };
  const trusted = context as TrustedContext; // validateProposal checked the complete closed context above.
  // validateProposal has checked the closed context and catalog before this projection.
  const catalog = validateCatalog(Object.getOwnPropertyDescriptor(context, 'catalog')?.value);
  if (!catalog.ok) return catalog;
  if (isProtectedPayload(catalog.value)) return { ok: false, status: 'invalid-input', reasonCode: 'protected-content', path: '$.catalog' };
  const compatible = catalog.value.destinations.filter(entry => entry.acceptsClassificationIds.includes(candidate.classification.value));
  const destination = compatible.find(entry => entry.id === candidate.destination.value);
  const normalize = (text: string): string => text.trim().replace(/\s+/gu, ' ').toLowerCase();
  const indistinguishable = destination && compatible.some(entry => entry.id !== destination.id
    && normalize(entry.responsibility) === normalize(destination.responsibility));
  const hasRouteQuestion = candidate.questions.some(question => question.affects.includes('destination'));
  if (candidate.destination.value === 'undetermined' || indistinguishable || hasRouteQuestion) {
    const ambiguous = compatible.length > 1;
    const reason = compatible.length === 0 ? 'No configured destination supports the assessed classification.'
      : ambiguous ? 'Available evidence does not distinguish compatible destination responsibilities.'
        : 'Destination responsibility fit remains undetermined from the available evidence.';
    const questions = [...candidate.questions];
    if (ambiguous && !hasRouteQuestion) questions.push({ id: unusedId('uc01-destination', questions.map(question => question.id)),
      text: 'Which configured destination responsibility should handle this issue?', affects: ['destination'],
      reason: 'The available evidence cannot distinguish the compatible configured destinations.' });
    if (questions.length > trusted.limits.questions) return {
      ok: false, status: 'error', reasonCode: 'question-budget-exhausted', path: '$.questions',
    };
    const routeId = unusedId('uc01-route-unknown', candidate.assertions.map(assertion => assertion.id));
    return validateProposal({ ...candidate, destination: { value: 'undetermined', assertionIds: [routeId] }, questions,
      assertions: [...candidate.assertions, { id: routeId, text: reason, basis: 'unknown', evidenceIds: [] }],
      uncertainties: [...new Set([...candidate.uncertainties, reason])] }, context);
  }
  const fit = candidate.assertions.find(assertion => candidate.destination.assertionIds.includes(assertion.id)
    && assertion.basis === 'inference' && assertion.evidenceIds.length > 0);
  if (!destination || !fit) return { ok: false, status: 'error', reasonCode: 'invalid-model-output', path: '$.destination' };
  const responsibility = `Configured responsibility: ${destination.responsibility}`;
  return validateProposal({ ...candidate, assertions: candidate.assertions.map(assertion => assertion.id === fit.id
    ? { ...assertion, text: `${assertion.text} ${responsibility}` } : assertion) }, context);
}
