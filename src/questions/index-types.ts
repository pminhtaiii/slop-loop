/** Host-owned index boundary. Source text never crosses the SQLite worker boundary. */
import type {
  QuestionIndexedChunkV1,
  QuestionIndexedFileV1,
  QuestionIndexGenerationV1,
  QuestionRetrievalFailureReasonV1,
  QuestionRetrievalFailureStatusV1,
  RetrievalResourceLimitsV1,
  SourceSnapshotV1,
} from '../contracts/questions/contracts.ts';
import type { QuestionRepositoryOperationControl } from '../foundation/repository-types.ts';
import type { QuestionBudgetLedger } from './budget.ts';
import type { QuestionChunkSource } from './chunks.ts';
import type { QuestionEmbeddingPort } from './embedding.ts';

export interface QuestionIndexRow {
  readonly metadata: QuestionIndexedChunkV1;
  readonly embeddingInputTokens: number;
  readonly vector: readonly number[];
}
export interface QuestionIndexView {
  readonly generation: QuestionIndexGenerationV1;
  readonly files: readonly QuestionIndexedFileV1[];
  readonly chunks: readonly QuestionIndexRow[];
}
export interface QuestionIndexFailure {
  readonly status: QuestionRetrievalFailureStatusV1;
  readonly reasonCode: QuestionRetrievalFailureReasonV1;
}
export type QuestionIndexReadResult = ({ readonly status: 'ok' } & QuestionIndexView) | QuestionIndexFailure;
export type QuestionIndexSyncResult = { readonly status: 'ok'; readonly generation: QuestionIndexGenerationV1; readonly vectorWrites: number; readonly reusedChunks: number } | QuestionIndexFailure;
export interface QuestionIndexReference {
  readonly snapshot: SourceSnapshotV1;
  readonly generationId: string;
}
export interface QuestionIndexOptions {
  readonly databasePath: string;
  readonly targetRoots: readonly string[];
  readonly limits: RetrievalResourceLimitsV1;
  readonly configDigest: string;
  readonly embeddingDigest: string;
  readonly embedding: QuestionEmbeddingPort;
  /** Independent host refresh budget; query accounting belongs to the caller. */
  readonly budget: QuestionBudgetLedger;
  /** Checks the real admitted lease and current workspace/policy; metadata alone cannot grant authority. */
  readonly authorize: (snapshot: SourceSnapshotV1) => Promise<boolean>;
}
export interface QuestionIndex {
  synchronize(
    request: { readonly snapshot: SourceSnapshotV1; readonly sources: readonly QuestionChunkSource[]; readonly expectedGenerationId: string | null },
    control: QuestionRepositoryOperationControl,
  ): Promise<QuestionIndexSyncResult>;
  /** Reopen does not serve until synchronize explicitly revalidates the active snapshot. */
  read(request: QuestionIndexReference & { readonly maxChunks: number }, control: QuestionRepositoryOperationControl): Promise<QuestionIndexReadResult>;
  validateCurrent(request: QuestionIndexReference, control: QuestionRepositoryOperationControl): Promise<{ readonly status: 'ok' } | QuestionIndexFailure>;
  /** Invalidates pending publication and serving synchronously, then removes inaccessible derived rows. */
  revoke(): Promise<void>;
  close(): Promise<void>;
}

export type IndexCommand =
  | { readonly kind: 'current' }
  | { readonly kind: 'begin'; readonly attempt: string; readonly leaseUntil: number; readonly diskBytes: number }
  | { readonly kind: 'inspect'; readonly maxChunks: number }
  | { readonly kind: 'stage'; readonly attempt: string; readonly file: QuestionIndexedFileV1; readonly rows: readonly QuestionIndexRow[] }
  | { readonly kind: 'publish'; readonly attempt: string; readonly expected: string | null; readonly generation: QuestionIndexGenerationV1; readonly paths: readonly string[]; readonly reuse: boolean }
  | { readonly kind: 'cleanup'; readonly attempt: string | null; readonly revoke: boolean };
export interface IndexWorkerReply {
  readonly status: 'ok';
  readonly generation: QuestionIndexGenerationV1 | null;
  readonly files: readonly QuestionIndexedFileV1[];
  readonly chunks: readonly QuestionIndexRow[];
  readonly diskBytes: number;
}
export type IndexReply = IndexWorkerReply | QuestionIndexFailure;
