/** Host composition and observable result of one bounded, process-local question investigation. */
import type {
  QuestionBudgetProfileV1,
  QuestionIdentityV1,
  QuestionResultV1,
  QuestionRetrievalResultV1,
  RepositoryBindingV1,
  QuestionLineRangeV1,
  SourceSnapshotV1,
} from '../contracts/questions/contracts.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionBudgetLedger } from './budget.ts';
import type { QuestionEmbeddingPort } from './embedding.ts';
import type { QuestionIndex } from './index.ts';
import type { CreateQuestionModelPortOptionsV1 } from './model.ts';
import type { QuestionRepositoryPort } from './repository.ts';

export interface QuestionInvestigationOptions {
  readonly identity: unknown;
  readonly snapshot: unknown;
  readonly profile: unknown;
  /** The host retains one ledger for the whole task; this graph never replaces or resets it. */
  readonly budget: QuestionBudgetLedger;
  readonly repository: QuestionRepositoryPort;
  readonly index: Pick<QuestionIndex, 'read' | 'validateCurrent'>;
  readonly embedding: QuestionEmbeddingPort;
  readonly generationId: string;
  readonly embeddingDigest: string;
  readonly model: Omit<CreateQuestionModelPortOptionsV1, 'identity' | 'profile' | 'budget'>;
  /** Host-held advisory context and source coordinates; every reused span is re-read and reissued. */
  readonly continuation?: unknown;
}

export interface QuestionInvestigationConfiguration extends Omit<QuestionInvestigationOptions, 'identity' | 'snapshot' | 'profile'> {
  readonly identity: QuestionIdentityV1;
  readonly snapshot: SourceSnapshotV1;
  readonly profile: QuestionBudgetProfileV1;
}

export interface QuestionInvestigationRun {
  readonly result: QuestionResultV1;
  /** The original scored observation. Supplemental reads never replace or enlarge its ranked spans. */
  readonly retrieval: QuestionRetrievalResultV1 | null;
  /** Metadata only. These references confer no evidence authority without a guarded current-run read. */
  readonly sourceReferences?: readonly QuestionSourceReference[];
}

export interface QuestionSourceReference {
  readonly sessionId: string;
  readonly taskId: string;
  readonly binding: RepositoryBindingV1;
  readonly snapshotId: string;
  readonly manifestDigest: string;
  readonly path: string;
  readonly range: QuestionLineRangeV1;
  readonly originalByteDigest: string;
  readonly excerptDigest: string;
}

export interface QuestionInvestigation {
  /** Runs once under the admitted identity; session continuation creates a fresh run with the retained task ledger. */
  run(question: string, control: QuestionRepositoryOperationControl): Promise<QuestionInvestigationRun>;
}

export type QuestionInvestigationCreation = { readonly ok: true; readonly value: QuestionInvestigation } | { readonly ok: false; readonly reasonCode: 'invalid-config' };
