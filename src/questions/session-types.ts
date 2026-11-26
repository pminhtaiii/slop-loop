/** Process-local session API; projections are advisory data, never evidence or accounting authority. */
import type { QuestionBudgetProfileV1, QuestionIdentityV1, QuestionResultV1, RepositoryBindingV1 } from '../contracts/questions/contracts.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionBudgetLedger, QuestionBudgetLedgerSnapshotV1 } from './budget.ts';
import type { QuestionInvestigationRun } from './graph-types.ts';

export interface QuestionSessionProjection {
  readonly taskId: string;
  readonly binding: RepositoryBindingV1;
  readonly intent: string;
  readonly constraints: readonly string[];
  readonly pendingClarification: string | null;
  readonly conversation: readonly Readonly<{ role: 'user'; text: string }>[];
}

export interface QuestionSessionRunRequest {
  readonly identity: QuestionIdentityV1;
  readonly question: string;
  readonly profile: QuestionBudgetProfileV1;
  readonly budget: QuestionBudgetLedger;
  readonly context: QuestionSessionProjection;
}

export interface OpenQuestionSessionOptions {
  readonly sessionId: unknown;
  readonly pricing: unknown;
  readonly run: (request: QuestionSessionRunRequest, control: QuestionRepositoryOperationControl) => Promise<QuestionInvestigationRun>;
  /** Optional host expiry in epoch milliseconds. Nothing is restored from conversation text. */
  readonly expiresAtEpochMs?: number;
  readonly now?: () => number;
}

export type QuestionSessionRefusal =
  'invalid-request' | 'busy' | 'closed' | 'task-mismatch' | 'turn-mismatch' | 'clarification-required' | 'context-limit' | 'accounting-pending' | 'budget-closed' | 'rebind-required';
export type QuestionSessionTurn =
  | { readonly status: 'completed'; readonly turnId: string; readonly result: QuestionResultV1; readonly retrieval: QuestionInvestigationRun['retrieval'] }
  | { readonly status: 'refused'; readonly reasonCode: QuestionSessionRefusal };

export interface QuestionSessionSnapshot {
  readonly sessionId: string;
  readonly closed: boolean;
  readonly busy: boolean;
  readonly taskId: string | null;
  readonly turnId: string | null;
  readonly projection: QuestionSessionProjection | null;
  readonly budget: QuestionBudgetLedgerSnapshotV1 | null;
}

export interface QuestionSession {
  /** Explicitly opens a distinct task and ledger; existing IDs cannot be replayed. */
  submitQuestion(input: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionSessionTurn>;
  startTask(input: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionSessionTurn>;
  /** Requires exact current task/turn and pending clarification identity, when present. */
  continueTask(input: unknown, control: QuestionRepositoryOperationControl): Promise<QuestionSessionTurn>;
  compactSession(): Promise<{ readonly status: 'compacted'; readonly projection: QuestionSessionProjection } | Extract<QuestionSessionTurn, { status: 'refused' }>>;
  cancelTask(input: unknown): { readonly status: 'cancelled' } | Extract<QuestionSessionTurn, { status: 'refused' }>;
  closeSession(): void;
  snapshot(): QuestionSessionSnapshot;
}

export type QuestionSessionCreation = { readonly ok: true; readonly value: QuestionSession } | { readonly ok: false; readonly reasonCode: 'invalid-config' };
