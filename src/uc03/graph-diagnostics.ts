/** Maps persisted UC-03 route state onto the bounded diagnostic vocabulary. */

import type { TaskState } from '../contracts/foundation/uc03.ts';
import { createEvaluationDiagnostic, type DiagnosticComponent, type DiagnosticStage, type EvaluationDiagnostic } from '../runtime/evaluation-diagnostics.ts';
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

const CODER_REFUSAL_PREFIX = 'REAL_PROFILE_GENERATION_INVALID: ';

/** Exact coder-boundary codes (the agent's own bounded vocabulary, never exception text) and the category each one observes. */
const CODER_REFUSALS: readonly { readonly match: RegExp; readonly component: DiagnosticComponent; readonly attribution: 'model' | 'tool' | 'environment'; readonly reasonCode: string }[] = [
  { match: /^PROPOSAL_INVALID:[A-Z_]{1,64}$/u, component: 'model-output', attribution: 'model', reasonCode: 'coder-proposal-invalid' },
  { match: /^(?:TOOL_ERROR|CHECK_NOT_CONFIGURED|CHECK_ADMISSION_REQUIRED|CHECK_RESULT_INVALID:[A-Z_]{1,64})$/u, component: 'repository-tool', attribution: 'tool', reasonCode: 'coder-tool-refused' },
  { match: /^(?:MODEL_ERROR|MODEL_UNCERTAIN:[A-Za-z0-9_.-]{1,64})$/u, component: 'provider', attribution: 'environment', reasonCode: 'coder-dispatch-failed' },
];

function coderRefusal(reasons: readonly string[]): (typeof CODER_REFUSALS)[number] | undefined {
  for (const reason of reasons) {
    if (!reason.startsWith(CODER_REFUSAL_PREFIX)) continue;
    const code = reason.slice(CODER_REFUSAL_PREFIX.length);
    const found = CODER_REFUSALS.find(entry => entry.match.test(code));
    if (found) return found;
  }
  return undefined;
}

/**
 * The graph state carries no diagnostic annotation, so a non-complete route outcome is reported from
 * the persisted node and milestones, optionally labelled with one recognised bounded coder-boundary
 * refusal code (`REAL_PROFILE_GENERATION_INVALID: ...`) mapped to its observed category. An
 * unrecognised code falls back to the generic `route-incomplete`/`workflow` unknown diagnostic. The
 * failing component is never inferred here, and a recognised category is never claimed as a root cause.
 */
export function diagnosticForOutcome(output: UC03GraphState): { readonly diagnostic?: EvaluationDiagnostic | undefined } {
  const outcome = output.finalReport?.outcome ?? output.terminalOutcome ?? output.state?.outcome ?? 'INCOMPLETE';
  if (outcome === 'COMPLETED' || outcome === 'needs-info' || outcome === 'pending-approval') return {};
  // A recognized coder refusal labels only the observed category; the confidence never claims a root cause.
  const refusal = coderRefusal(output.finalReport?.failureReasons ?? output.reasons ?? []);
  return {
    diagnostic: createEvaluationDiagnostic({
      stage: stageForNode(output.state?.node),
      component: refusal?.component ?? 'workflow',
      attribution: refusal?.attribution ?? 'unknown',
      attributionConfidence: refusal ? 'observed' : 'unknown',
      reasonCode: refusal?.reasonCode ?? 'route-incomplete',
      evidenceRefs: output.state?.evidenceRefs ?? [],
      milestones: (output.milestones ?? []).map(milestone => milestone.kind),
      limitations: [
        refusal
          ? 'Category observed from a bounded coder refusal code; the root cause is not established'
          : 'Route reported a non-complete outcome; the failing component was not observed at the result boundary',
      ],
    }),
  };
}
