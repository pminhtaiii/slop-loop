/**
 * The T028 campaign record and its per-attempt artifacts (real-tier contract §(f) T028 row; T059).
 *
 * Both the runner and the checker import this module, so the on-disk shape has exactly one owner.
 * A case row and its artifact are written as one tuple and read back as one tuple: an evidence-less
 * case never shifts a later case's file name (STD-W5-106), and every artifact carries the campaign,
 * case, attempt, pinned binding and task/run identity it belongs to (SPEC-W5-105/206).
 *
 * Every invocation writes into its own directory, and nothing here overwrites an existing file, so no
 * later run replaces an earlier observation (SPEC-W5-207). Nothing here echoes a needle: values are
 * validated as bounded identifiers or digests before use.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SnapshotGradeResult } from '../../../eval/uc03/workflow-grade.ts';

/** `uc03-campaign-record/2` adds artifact references and the started/finished pair to v1. */
export const RECORD_SCHEMA = 'uc03-campaign-record/2';
export const CASE_EVIDENCE_SCHEMA = 'uc03-case-evidence/1';
export const C16_REPORT_SCHEMA = 'uc03-c16-report/2';
/** Version 2 carries per-call observations: the limiter verdict, per-call fetches and settlement. */
export const C10_WITNESS_SCHEMA = 'uc03-c10-witness/2';
export const RECEIPT_SCHEMA = 'uc03-conformance-receipt/1';

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const SHA256 = /^sha256:[0-9a-f]{64}$/u;
export const REASON_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type Outcome = 'pass' | 'fail' | 'not-run';

export interface StageRecord {
  readonly stage: 'assembly' | 'preflight' | 'conformance' | 'receipt' | 'recovery' | 'case';
  readonly outcome: Outcome;
  readonly reasonCode?: string | undefined;
  readonly caseId?: string | undefined;
  readonly facts?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

/** The task/run/workspace one attempt ran against; the artifact's own binding, never inferred. */
export interface AttemptIdentity {
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
}

/**
 * The four pinned identities the conformance receipt binds. Every artifact repeats them, so a file
 * copied from another candidate, profile, endpoint or model cannot certify this campaign.
 */
export interface ArtifactBinding {
  readonly candidateSha: string;
  readonly profileDigest: string;
  readonly endpointDigest: string;
  readonly model: string;
}

export interface ConformanceReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA;
  readonly campaignId: string;
  readonly binding: ArtifactBinding;
  readonly outcome: 'conformed' | 'failed';
  readonly reasonCode?: string;
  readonly finishedAt: number;
}

/** One case's host-only evidence before projection. */
export interface CaseEvidence {
  readonly snapshot?: Readonly<{ snapshotId: string; digest: string }> | undefined;
  readonly evidenceDigest?: string | undefined;
  readonly grade?: SnapshotGradeResult | undefined;
  readonly diffDigest?: string | undefined;
  /** The digest of the final report the C16 row is judged on; C16 must name the same bytes. */
  readonly reportDigest?: string | undefined;
  readonly usage?: Readonly<{ tokens: number; cost: number; costLabel: 'estimate-unverified' | 'unknown' }> | undefined;
  readonly ownerRevisions?: Readonly<Record<string, string>> | undefined;
  readonly approval?: Readonly<{ decisionId: string; decided: 'approve' | 'reject' }> | undefined;
}

/** The extra facts a case artifact carries beyond the evidence it was projected from. */
export interface CaseArtifactBody {
  readonly schema: typeof CASE_EVIDENCE_SCHEMA;
  readonly campaignId: string;
  readonly caseId: string;
  readonly attempt: number;
  readonly binding: ArtifactBinding;
  /** The digest of the snapshot the independent grade was issued on; null when none was graded. */
  readonly finalSnapshotDigest: string | null;
  readonly identity: AttemptIdentity;
  readonly evidence: CaseEvidence;
  /** Journal counts at attempt end: the owner-side accounting the artifact is bound to. */
  readonly accounting: Readonly<{ claims: number; attempts: number; outcomes: number }>;
}

/** The C16 safe report, derived from the C01 run and judged on its own content (§(f) T028). */
export interface C16ReportBody {
  readonly schema: typeof C16_REPORT_SCHEMA;
  readonly campaignId: string;
  readonly caseId: 'C16';
  readonly attempt: number;
  readonly binding: ArtifactBinding;
  readonly finalSnapshotDigest: string | null;
  readonly derivedFrom: 'C01';
  /** The retained C01 artifact this report was derived from, by file name and by digest. */
  readonly sourceArtifact: string;
  readonly sourceDigest: string;
  /** The predicate's own verdict, so the C16 row can never claim more than its report did. */
  readonly verdict: 'pass' | 'fail';
  readonly reasonCode?: string | undefined;
  readonly report: Readonly<{
    readonly present: boolean;
    readonly outcome: string;
    readonly isComplete: boolean;
    readonly diffDigest: string | null;
    readonly evidenceRefs: readonly string[];
    readonly changedFiles: readonly string[];
    readonly bytes: number;
    readonly reportDigest: string;
  }>;
}

/** What the witness observed around one provider request. */
export interface C10CallFacts {
  readonly requestId: string;
  readonly declared: Readonly<{ maxInputTokens: number; maxOutputTokens: number }>;
  readonly fetchesBefore: number;
  readonly fetchesAfter: number;
  /** The bound port's own verdict for the request. */
  readonly portOutcome: string;
  /** The real transport's verdict for this request, or null when the transport was never reached. */
  readonly transport: Readonly<{ outcome: string; reasonCode: string | null; claimsAtTransport: number; fetchesAtTransport: number }> | null;
  readonly claims: Readonly<{ before: number; after: number }>;
  /** The outcome kinds of the receipts this request added to the owner journal. */
  readonly outcomes: Readonly<{ before: number; after: number; recorded: readonly string[] }>;
  readonly observedUsage: Readonly<{ inputTokens: number; outputTokens: number }> | null;
}

/** The C10 refusal witness: one allowed call that settles, then one over-limit call that never dispatches. */
export interface C10WitnessBody {
  readonly schema: typeof C10_WITNESS_SCHEMA;
  readonly campaignId: string;
  readonly caseId: 'C10';
  readonly attempt: number;
  readonly binding: ArtifactBinding;
  readonly finalSnapshotDigest: null;
  readonly identity: AttemptIdentity;
  readonly provider: Readonly<Record<string, string>>;
  readonly limits: Readonly<{ totalModelCalls: number; perRunInputTokens: number; perRunOutputTokens: number; budgetRefs: readonly string[] }>;
  readonly calls: Readonly<{ allowed: C10CallFacts; refused: C10CallFacts }>;
  readonly commandViewDigest: string | null;
  readonly disclosure: string;
}

/** Which artifact schema a case row writes. */
export type CaseKind = 'evidence' | 'c16' | 'c10';

/** One artifact reference: its file name is derived from the tuple, never from an array index. */
export interface CaseArtifact {
  readonly caseId: string;
  readonly attempt: number;
  readonly kind: CaseKind;
  readonly path: string;
  readonly digest: string;
}

export interface CampaignRecord {
  readonly schemaVersion: typeof RECORD_SCHEMA;
  readonly campaignId: string;
  readonly candidateSha: string;
  readonly mode: 'campaign' | 'case' | 'resume';
  readonly passed: boolean;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly bindings: Readonly<Record<string, string>>;
  readonly records: readonly StageRecord[];
  readonly caseArtifacts: readonly CaseArtifact[];
}

/** One artifact to write: the tuple, and the body that becomes its file. */
export type PendingArtifact = readonly [caseId: string, attempt: number, kind: CaseKind, body: unknown];

/** The one file name a (case, attempt, kind) tuple owns. Two tuples can never collide. */
export function artifactName(caseId: string, attempt: number, kind: CaseKind): string {
  return `${kind}-${caseId}-${attempt}.json`;
}

export function receiptName(campaignId: string): string {
  return `conformance-${campaignId}.json`;
}

/** The one serialization an artifact file holds, so a writer and a deriving case compute the same digest. */
export function serialize(body: unknown): string {
  return JSON.stringify(body, null, 2);
}

/** The digest a reader recomputes; the writer stores the same value in the record. */
export function digestOf(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** The record's binding keys, in the `bindings` map's own spelling. */
export function bindingOf(bindings: Readonly<Record<string, string>>): ArtifactBinding {
  return { candidateSha: bindings['candidate-sha'] ?? '', profileDigest: bindings['profile-digest'] ?? '', endpointDigest: bindings['endpoint-digest'] ?? '', model: bindings['model'] ?? '' };
}

export function sameBinding(left: unknown, right: ArtifactBinding): boolean {
  if (typeof left !== 'object' || left === null) return false;
  const value = left as Record<string, unknown>;
  return Object.keys(value).length === 4 && value['candidateSha'] === right.candidateSha && value['profileDigest'] === right.profileDigest && value['endpointDigest'] === right.endpointDigest && value['model'] === right.model;
}

function isBinding(value: unknown): value is ArtifactBinding {
  const v = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  return v !== undefined && ['candidateSha', 'profileDigest', 'endpointDigest', 'model'].every(key => typeof v[key] === 'string');
}

/** A receipt read back from disk is untrusted input: an unknown shape is `undefined`, never a receipt. */
export function parseReceipt(value: unknown): ConformanceReceipt | undefined {
  const v = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  if (
    v?.['schemaVersion'] !== RECEIPT_SCHEMA ||
    typeof v['campaignId'] !== 'string' ||
    !SAFE_ID.test(v['campaignId']) ||
    (v['outcome'] !== 'conformed' && v['outcome'] !== 'failed') ||
    typeof v['finishedAt'] !== 'number' ||
    !Number.isSafeInteger(v['finishedAt']) ||
    !isBinding(v['binding'])
  ) {
    return undefined;
  }
  return {
    schemaVersion: RECEIPT_SCHEMA,
    campaignId: v['campaignId'],
    binding: v['binding'],
    outcome: v['outcome'],
    ...(typeof v['reasonCode'] === 'string' ? { reasonCode: v['reasonCode'] } : {}),
    finishedAt: v['finishedAt'],
  };
}

/** Writes a new file only: an existing observation is never replaced. */
function writeNew(path: string, text: string): void {
  writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
}

export function writeReceipt(evidenceDir: string, receipt: ConformanceReceipt): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeNew(join(evidenceDir, receiptName(receipt.campaignId)), JSON.stringify(receipt, null, 2));
}

/**
 * Writes every artifact for one campaign, then the record that references them. The tuple is the
 * unit: a case with no artifact writes no file and therefore no reference, and no other case's file
 * name moves. A directory that already holds a record is refused, never merged into.
 */
export function writeCampaign(dir: string, record: Omit<CampaignRecord, 'caseArtifacts' | 'schemaVersion'>, artifacts: readonly PendingArtifact[]): CampaignRecord {
  if (existsSync(join(dir, 'campaign.json'))) throw new Error('CAMPAIGN_EXISTS');
  mkdirSync(dir, { recursive: true });
  const caseArtifacts: CaseArtifact[] = artifacts.map(([caseId, attempt, kind, body]) => {
    if (!SAFE_ID.test(caseId)) throw new Error('ARTIFACT_CASE_INVALID');
    const path = artifactName(caseId, attempt, kind);
    const text = serialize(body);
    writeNew(join(dir, path), text);
    return Object.freeze({ caseId, attempt, kind, path, digest: digestOf(text) });
  });
  const full: CampaignRecord = Object.freeze({ schemaVersion: RECORD_SCHEMA, ...record, caseArtifacts: Object.freeze(caseArtifacts) });
  writeNew(join(dir, 'campaign.json'), JSON.stringify(full, null, 2));
  return full;
}

/**
 * Reads one referenced artifact, or `undefined` when its path is not the name its tuple owns or the
 * file is absent. The caller compares the returned text's digest with the recorded one.
 */
export function readArtifact(dir: string, artifact: CaseArtifact): string | undefined {
  if (artifact.path !== artifactName(artifact.caseId, artifact.attempt, artifact.kind)) return undefined;
  const path = join(dir, artifact.path);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
