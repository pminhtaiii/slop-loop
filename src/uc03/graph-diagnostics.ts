/** Maps persisted UC-03 route state onto the bounded diagnostic vocabulary. */

import type { TaskState } from '../contracts/foundation/uc03.ts';
import { createEvaluationDiagnostic, type DiagnosticStage, type EvaluationDiagnostic } from '../runtime/evaluation-diagnostics.ts';
import type { UC03GraphState } from './graph-state.ts';

/** Persisted route node is the only stage evidence the result boundary has; anything else stays unknown. */
const NODE_STAGES: Readonly<Record<string, DiagnosticStage>> = {
  Validate: 'preflight',
  NeedsInfo: 'intake',
  Investigate: 'investigate',
  AwaitPlan: 'approve',
  AwaitFeedback: 'approve',
  Patch: 'patch',
  Repair: 'patch',
  Verify: 'verify',
  Review: 'review',
  Deliver: 'deliver',
};

export function stageForNode(node: TaskState['node'] | undefined): DiagnosticStage {
  return (node ? NODE_STAGES[node] : undefined) ?? 'unknown';
}

/**
 * The graph state carries no diagnostic annotation, so a non-complete route outcome can only be
 * reported from the persisted node and milestones. The failing component is never inferred here.
 */
export function diagnosticForOutcome(output: UC03GraphState): { readonly diagnostic?: EvaluationDiagnostic | undefined } {
  const outcome = output.finalReport?.outcome ?? output.terminalOutcome ?? output.state?.outcome ?? 'INCOMPLETE';
  if (outcome === 'COMPLETED' || outcome === 'needs-info' || outcome === 'pending-approval') return {};
  return {
    diagnostic: createEvaluationDiagnostic({
      stage: stageForNode(output.state?.node),
      component: 'workflow',
      attribution: 'unknown',
      attributionConfidence: 'unknown',
      reasonCode: 'route-incomplete',
      evidenceRefs: output.state?.evidenceRefs ?? [],
      milestones: (output.milestones ?? []).map(milestone => milestone.kind),
      limitations: ['Route reported a non-complete outcome; the failing component was not observed at the result boundary'],
    }),
  };
}
