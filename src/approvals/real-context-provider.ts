import { computeActionDigest, validateNormalizedAction } from '../contracts/foundation/uc03.ts';
import type { PortProvenance } from '../contracts/foundation/uc03.ts';
import type { DurableStore } from '../persistence/store.ts';
import type { DurableApprovalStore } from '../persistence/adapters/approval-store-adapter.ts';
import type { ApprovalContext } from './service-data.ts';
import type { PolicyFacts } from './policy.ts';
import { dataRecord, decisionElements } from './service-context.ts';

/**
 * Host-owned trust root for the action itself: the registered action, its observed policy facts and
 * the operator-facing elements. Durable task/approval state cannot reconstruct these, so the host
 * supplies them and this provider binds them to that durable state.
 */
export interface RealContextSource {
  readonly provenance: PortProvenance;
  /** Returns `{ action, facts, elements }` for a known action, or null/undefined when it is unknown. */
  observe(taskId: string, actionId: string): unknown;
}

/**
 * Real approval context provider derived from durable task/approval state. Never invents a value:
 * an unknown task, decision, or action throws before any context is returned.
 */
// ponytail: the repository revision digest comes from the host facts because the durable UC-04 task
// only records commitHash + trackedFilesHash; derive it from those once they are canonicalized there.
export function createRealContextProvider(options: {
  readonly durable: Pick<DurableStore, 'loadTask'>;
  readonly approvals: Pick<DurableApprovalStore, 'provenance' | 'profile' | 'readRequest'>;
  readonly source: RealContextSource;
}): { loadForAction(taskId: string, actionId: string): Promise<unknown>; loadForDecision(decisionId: string): Promise<unknown> } {
  if (options.approvals.provenance !== 'real' || options.source.provenance !== 'real') throw new Error('real-context-requires-real-sources');

  const build = async (taskId: string, actionId: string, policy: { readonly policyId: string; readonly policyVersion: string }): Promise<ApprovalContext> => {
    const task = await options.durable.loadTask(taskId);
    if (!task) throw new Error('real-context-unknown-task');
    const observed = await options.source.observe(taskId, actionId);
    if (!dataRecord(observed) || !['action', 'facts', 'elements'].every(key => Object.hasOwn(observed, key))) throw new Error('real-context-unknown-action');
    const action = validateNormalizedAction(observed['action']);
    const facts = observed['facts'];
    if (!action.ok || action.value.actionId !== actionId || !dataRecord(facts) || !decisionElements(observed['elements'])) throw new Error('real-context-unknown-action');
    const digest = computeActionDigest(action.value);
    if (
      facts['taskId'] !== task.taskId ||
      facts['workspaceId'] !== task.workspaceId ||
      facts['repositoryId'] !== task.repositoryId ||
      facts['registeredActionDigest'] !== digest ||
      typeof facts['repositoryRevisionDigest'] !== 'string'
    )
      throw new Error('real-context-task-mismatch');
    return {
      action: action.value,
      facts: facts as unknown as PolicyFacts,
      runId: task.runId,
      freshness: {
        currentTaskId: task.taskId,
        currentWorkspaceId: task.workspaceId,
        currentRepositoryRevisionDigest: facts['repositoryRevisionDigest'],
        currentPolicyId: policy.policyId,
        currentPolicyVersion: policy.policyVersion,
        currentNormalizedActionDigest: digest,
      },
      elements: observed['elements'],
    };
  };

  const { policyIdentity } = options.approvals.profile;
  return {
    loadForAction: (taskId, actionId) => build(taskId, actionId, policyIdentity),
    loadForDecision: async decisionId => {
      const response = options.approvals.readRequest(decisionId);
      const request = response.safe.outcome === 'ok' ? response.value : null;
      if (!request) throw new Error('real-context-unknown-decision');
      return build(request.taskId, request.actionRef, { policyId: request.policyId, policyVersion: request.policyVersion });
    },
  };
}
