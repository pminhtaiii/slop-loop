/** LangGraph state and reducers; workflow execution lives in graph node modules. */
import { Annotation } from '@langchain/langgraph';
import type { Baseline, BugTask, ProviderRequest, RepositoryExecutionReceiptV02, ReviewResult, TaskOutcome, TaskState, VerificationResult } from '../contracts/foundation/uc03.ts';
import type { UC03RepositoryAdmission } from './graph-types.ts';
import type { FinalReport, Milestone } from './report.ts';

export const UC03StateAnnotation = Annotation.Root({
  task: Annotation<BugTask | undefined>({ reducer: (_, n) => n }),
  state: Annotation<TaskState | undefined>({ reducer: (_, n) => n }),
  baseline: Annotation<Baseline | undefined>({ reducer: (_, n) => n }),
  verificationResults: Annotation<readonly VerificationResult[]>({ reducer: (_, n) => n }),
  reviewResult: Annotation<ReviewResult | undefined>({ reducer: (_, n) => n }),
  reviewRequest: Annotation<ProviderRequest | undefined>({ reducer: (_, n) => n }),
  patchAdmission: Annotation<UC03RepositoryAdmission | undefined>({ reducer: (_, n) => n }),
  patchReceipt: Annotation<RepositoryExecutionReceiptV02 | undefined>({ reducer: (_, n) => n }),
  failureEvidence: Annotation<readonly (VerificationResult | ReviewResult)[]>({ reducer: (_, n) => n }),
  finalReport: Annotation<FinalReport | undefined>({ reducer: (_, n) => n }),
  reasons: Annotation<readonly string[]>({ reducer: (c, n) => [...(c ?? []), ...(n ?? [])] }),
  terminalOutcome: Annotation<TaskOutcome | 'pending-approval' | 'needs-info' | undefined>({ reducer: (_, n) => n }),
  milestones: Annotation<readonly Milestone[]>({ reducer: (_, n) => n }),
});

export type UC03GraphState = typeof UC03StateAnnotation.State;
export type UC03GraphNode = (state: UC03GraphState) => Promise<Partial<UC03GraphState>>;

