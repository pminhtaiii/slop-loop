/** Host-selected retrieval scope; serialized results never carry source or receipt authority. */
import type {
  AdmittedSpanV1,
  QuestionAbsenceReceiptV1,
  QuestionIdentityV1,
  QuestionRetrievalResultV1,
  RepositoryOperationLimitsV1,
  RetrievalResourceLimitsV1,
  SourceSnapshotV1,
} from '../contracts/questions/contracts.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionBudgetLedger } from './budget.ts';
import type { QuestionEmbeddingPort } from './embedding.ts';
import type { QuestionIndex, QuestionIndexFailure } from './index.ts';
import type { QuestionRepositoryPort } from './repository.ts';
import type { QuestionPresentationResultV1 } from './presentation.ts';

export interface QuestionRetrievalOptions {
  readonly identity: QuestionIdentityV1;
  readonly snapshot: SourceSnapshotV1;
  readonly generationId: string;
  readonly embeddingDigest: string;
  readonly limits: RetrievalResourceLimitsV1;
  readonly repositoryLimits: RepositoryOperationLimitsV1;
  readonly index: Pick<QuestionIndex, 'read' | 'validateCurrent'>;
  readonly embedding: QuestionEmbeddingPort;
  readonly budget: QuestionBudgetLedger;
  readonly repository: QuestionRepositoryPort;
  /** Canonical eligible file paths derived by the host from explicit user scope; omission means full manifest. */
  readonly scope?: readonly string[];
  /** Only the host may classify an explicit concrete static-definition lookup. */
  readonly staticLookup?: string;
}
export type QuestionRetrievalAdmission = { readonly status: 'ok'; readonly span: AdmittedSpanV1 } | QuestionIndexFailure;
export type QuestionAbsenceResult =
  | { readonly status: 'ok'; readonly receipt: QuestionAbsenceReceiptV1 }
  | { readonly status: 'insufficient'; readonly reasonCode: 'not-static' | 'incomplete-coverage' | 'matches-found' }
  | QuestionIndexFailure;
export interface QuestionRetrieval {
  rank(request: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionRetrievalResultV1>;
  admit(observation: unknown, chunkId: string, control: QuestionRepositoryOperationControl): Promise<QuestionRetrievalAdmission>;
  /** Delivers claims only through the same registry that issued admitted spans, with current-generation final checks. */
  present(proposal: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionPresentationResultV1>;
  proveAbsence(control: QuestionRepositoryOperationControl): Promise<QuestionAbsenceResult>;
  validateAbsence(receipt: unknown, control: QuestionRepositoryOperationControl): Promise<{ readonly status: 'ok' } | QuestionIndexFailure>;
  close(): void;
}
