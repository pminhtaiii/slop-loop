/**
 * Workflow pause and withheld-completion facts for UC-03.
 * Owned path: eval/uc03/workflow-pause-facts.ts
 */

import type { TaskState } from '../../src/contracts/foundation/uc03.ts';
import type { UC03WorkflowResult } from '../../src/uc03/graph-types.ts';

/**
 * A patch-free state proves nothing was applied only at a pre-patch wait, or at a Repair/Incomplete
 * stop whose own budget-exhaustion evidence says the route halted before the next effect.
 */
export function patchFreeFacts(state: TaskState, stoppedOnBudget: boolean): boolean | undefined {
  if (state.changedPaths.length !== 0) return undefined;
  if (['Investigate', 'NeedsInfo', 'AwaitPlan', 'AwaitFeedback'].includes(state.node)) return false;
  return (state.node === 'Repair' || state.node === 'Incomplete') && stoppedOnBudget ? false : undefined;
}

export function completionWasWithheld(result: UC03WorkflowResult, state: TaskState): boolean | undefined {
  if (state.outcome === 'COMPLETED' || result.finalReport?.isComplete === true) return false;
  if (['Investigate', 'NeedsInfo', 'AwaitPlan', 'AwaitFeedback', 'Repair', 'Verify', 'Incomplete'].includes(state.node)) return true;
  return undefined;
}
