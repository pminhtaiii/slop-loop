import type { BoundSource, CaseBinding, EvaluationProfile, IntakeQuestion } from './evaluation-profile.ts';
import type { CatalogEntry } from './evaluation-profile.ts';
import { sha256Text } from '../uc01/contracts.ts';
import type { WorkflowEvaluationReport } from '../../eval/uc03/types.ts';

export type ServiceStatus = 'waiting-approval' | 'waiting-info' | 'running' | 'completed' | 'incomplete' | 'implemented-unverified' | 'failed';
export type ServiceFailure = 'invalid-input' | 'not-found' | 'conflict' | 'busy' | 'blocked';

export type ServiceResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; status: ServiceFailure; reasonCode: string }>;

export type DirectionKind = 'resume' | 'revise' | 'end';

/** Narrow local shape of the UC-05 control API; `src/approvals/*` is neither imported nor reimplemented. */
export interface ServiceControlReceipt {
  readonly receiptRef: string;
  readonly kind: DirectionKind;
  readonly taskId: string;
  readonly controlVersion: number;
}

export interface ServiceControl {
  issue(
    input: Readonly<{ experimentId: string; kind: DirectionKind; expectedTaskVersion: number; expectedControlVersion: number; decisionRef?: string; feedback?: string }>,
  ): ServiceControlReceipt | Promise<ServiceControlReceipt>;
}

export interface EvaluationGraphResult {
  readonly outcome: string;
  readonly state: Readonly<{ taskId: string; runId: string; workspaceId: string }> | null;
  readonly usage?: Readonly<{ tokensConsumed: number; costUsd: number }> | undefined;
  readonly workflowClarification?: WorkflowClarificationView | null | undefined;
  readonly workflowReport?: WorkflowEvaluationReport | null | undefined;
}

export type EvaluationTaskIdentity = NonNullable<EvaluationGraphResult['state']>;

export interface EvaluationGraph {
  /** Resolved only after complete intake, so a preflight block never reaches owner ports. */
  portsFor(input: Readonly<{ experimentId: string; source: BoundSource }>): unknown;
  run(
    input: Readonly<{
      experimentId: string;
      source: BoundSource;
      ports: unknown;
      priorState: EvaluationTaskIdentity | null;
      direction: ServiceControlReceipt | null;
      answers: readonly AnswerRecord[];
    }>,
  ): Promise<EvaluationGraphResult>;
}

export interface EvaluationServiceDeps {
  readonly profile: EvaluationProfile | unknown;
  readonly catalog: readonly CatalogEntry[];
  readonly repositoryIds: readonly string[];
  readonly checkSetIds: readonly string[];
  readonly control: ServiceControl;
  readonly graph: EvaluationGraph;
  readonly now?: (() => string) | undefined;
  readonly ids?: (() => string) | undefined;
}

export interface QuestionView {
  readonly questionId: string;
  readonly text: string;
  /** Bound digest the reporter must echo back with an answer; never the answer itself. */
  readonly questionDigest: string;
}

/** A graph-owned clarification group, separate from immutable public intake questions. */
export interface WorkflowClarificationView {
  readonly questionId: string;
  readonly questionDigest: string;
  readonly questions: readonly Readonly<{ questionId: string; text: string }>[];
}

export interface SubmissionView {
  readonly submissionId: string;
  readonly submissionDigest: string;
  readonly repositoryId: string;
  readonly checkSetId: string;
  readonly questions: readonly QuestionView[];
}

export interface AnswerRecord {
  readonly questionId: string;
  readonly questionDigest: string;
  readonly answers: readonly string[];
  readonly recordedAt: string;
}

export interface ExperimentView {
  readonly id: string;
  readonly version: number;
  readonly status: ServiceStatus;
  readonly scope: 'catalog' | 'exploratory';
  readonly graded: boolean;
  readonly bindings: readonly CaseBinding[];
  readonly submission: SubmissionView | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly workspaceId: string | null;
  readonly usage: Readonly<{ tokensConsumed: number; costUsd: number }> | null;
  readonly workflowClarification: WorkflowClarificationView | null;
  readonly workflowReport: WorkflowEvaluationReport | null;
  readonly answers: readonly AnswerRecord[];
  readonly directions: readonly string[];
}

export interface ExperimentReceipt {
  readonly receiptId: string;
  readonly kind: 'start' | 'answer' | 'direction' | 'continue';
  readonly idempotencyKey: string;
  readonly experimentId: string;
  readonly version: number;
}

export interface EvaluationService {
  startExperiment(input: unknown): Promise<ServiceResult<Readonly<{ experiment: ExperimentView; receipt: ExperimentReceipt }>>>;
  getExperiment(id: unknown): ServiceResult<ExperimentView>;
  answerClarification(input: unknown): Promise<ServiceResult<Readonly<{ experiment: ExperimentView; receipt: ExperimentReceipt }>>>;
  issueDirection(input: unknown): Promise<ServiceResult<Readonly<{ experiment: ExperimentView; receipt: ServiceControlReceipt | ExperimentReceipt }>>>;
  continueExperiment(input: unknown): Promise<ServiceResult<Readonly<{ experiment: ExperimentView; receipt: ExperimentReceipt }>>>;
}

export const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const DIGEST = /^[a-f0-9]{64}$/u;
export const TERMINAL = new Set<ServiceStatus>(['completed', 'incomplete', 'implemented-unverified', 'failed']);
const QUESTION_KEYS = ['questionId', 'text'] as const;

export interface ExperimentRecord {
  readonly id: string;
  readonly scope: 'catalog' | 'exploratory';
  readonly bindings: readonly CaseBinding[];
  readonly submission: SubmissionView | null;
  task: EvaluationGraphResult['state'];
  workflowReport: WorkflowEvaluationReport | null;
  readonly startedSource: BoundSource;
  status: ServiceStatus;
  version: number;
  usage: Readonly<{ tokensConsumed: number; costUsd: number }> | null;
  workflowClarification: WorkflowClarificationView | null;
  answers: AnswerRecord[];
  directions: ServiceControlReceipt[];
}

export function fail<T>(status: ServiceFailure, reasonCode: string): ServiceResult<T> {
  return { ok: false, status, reasonCode };
}

export function ok<T>(value: T): ServiceResult<T> {
  return { ok: true, value };
}

/** Rejects unknown keys; each caller then checks the required ones itself (optional keys may be omitted). */
export function record(value: unknown, allowed: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const own = Reflect.ownKeys(value);
  return own.every(key => typeof key === 'string' && allowed.includes(key)) ? (value as Record<string, unknown>) : undefined;
}

export function idValue(value: unknown): string | undefined {
  return typeof value === 'string' && ID.test(value) ? value : undefined;
}

export function keyValue(value: unknown): string | undefined {
  return typeof value === 'string' && KEY.test(value) ? value : undefined;
}

export function versionValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function textValue(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maxBytes) return undefined;
  return value;
}

/** True when every catalog binding is explained by a host entry with identical pinned digests. */
export function bindingsExplained(bindings: readonly CaseBinding[], catalog: readonly CatalogEntry[]): boolean {
  return bindings.every(binding => {
    const entry = catalog.find(candidate => candidate.caseId === binding.caseId && candidate.catalogEntryId === binding.catalogEntryId);
    return (
      entry !== undefined &&
      DIGEST.test(entry.caseDigest) &&
      entry.version === binding.version &&
      entry.caseDigest === binding.caseDigest &&
      entry.publicTaskDigest === binding.publicTaskDigest &&
      entry.initialRepositoryDigest === binding.initialRepositoryDigest &&
      entry.grader.version === binding.grader.version &&
      entry.grader.digest === binding.grader.digest
    );
  });
}

export function questionsOf(submission: BoundSource & { kind: 'bug' }): readonly QuestionView[] {
  return submission.questions.map((question: IntakeQuestion) => Object.freeze({ questionId: question.questionId, text: question.text, questionDigest: questionDigestOf(question) }));
}

function questionDigestOf(question: IntakeQuestion): string {
  const shape = record(question, QUESTION_KEYS);
  if (!shape) throw new Error('Invalid intake question');
  return sha256Text(JSON.stringify({ questionId: shape['questionId'], text: shape['text'] }));
}

export function statusOf(outcome: string): ServiceStatus {
  if (outcome === 'pending-approval') return 'waiting-approval';
  if (outcome === 'needs-info') return 'waiting-info';
  if (outcome === 'COMPLETED') return 'completed';
  if (outcome === 'IMPLEMENTED_UNVERIFIED') return 'implemented-unverified';
  if (outcome === 'FAILED') return 'failed';
  return 'incomplete';
}

export function viewOf(record_: ExperimentRecord): ExperimentView {
  return Object.freeze({
    id: record_.id,
    version: record_.version,
    status: record_.status,
    scope: record_.scope,
    // A custom submission pins no independent criteria, so it can never borrow catalog acceptance.
    graded: record_.scope === 'catalog',
    bindings: Object.freeze([...record_.bindings]),
    submission: record_.submission,
    taskId: record_.task?.taskId ?? null,
    runId: record_.task?.runId ?? null,
    workspaceId: record_.task?.workspaceId ?? null,
    usage: record_.usage,
    workflowClarification: record_.workflowClarification,
    workflowReport: record_.workflowReport,
    answers: Object.freeze([...record_.answers]),
    directions: Object.freeze(record_.directions.map(receipt => receipt.receiptRef)),
  });
}
