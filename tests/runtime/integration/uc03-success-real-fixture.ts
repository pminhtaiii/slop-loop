/**
 * Shared T059 gate fixtures: a complete, internally consistent campaign record and its artifacts.
 *
 * Every artifact is bound to the fixture campaign, binding and snapshot, and C16 derives from the exact
 * bytes of the C01 artifact, so the checker accepts the whole set and a single removed or corrupted
 * item makes it refuse. Values are RFC 5737 / `.invalid`-safe: digests and ids only, no endpoint, no key.
 */
import type { SnapshotGradeResult } from '../../../eval/uc03/workflow-grade.ts';
import { isEvaluationCaseId } from '../../../eval/uc03/validation-primitives.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';

import type { CaseOutcome } from './uc03-success-real-run-cases.ts';
import { PINNED_MODEL } from './uc03-success-real-provider.ts';
import {
  C10_WITNESS_SCHEMA,
  C16_REPORT_SCHEMA,
  CASE_EVIDENCE_SCHEMA,
  RECEIPT_SCHEMA,
  artifactName,
  digestOf,
  serialize,
  writeCampaign,
  writeReceipt,
  type ArtifactBinding,
  type C10BudgetCallFacts,
  type C10CallFacts,
  type C10WitnessBody,
  type C16ReportBody,
  type CaseArtifactBody,
  type PendingArtifact,
  type StageRecord,
} from './uc03-success-real-record.ts';

const FIXTURE_REV = 'e'.repeat(40);
const FIXTURE_CAMPAIGN = 'campaign-1';
const hex = (char: string): string => `sha256:${char.repeat(64)}`;
export const FIXTURE_BINDING: ArtifactBinding = Object.freeze({ candidateSha: FIXTURE_REV, profileDigest: hex('a'), endpointDigest: hex('b'), model: PINNED_MODEL });
const FINAL_SNAPSHOT = hex('d');
const DIFF = hex('c');
const REPORT = hex('9');

const bindingsOf = (binding: ArtifactBinding): Record<string, string> => ({
  'candidate-sha': binding.candidateSha,
  'profile-digest': binding.profileDigest,
  'endpoint-digest': binding.endpointDigest,
  model: binding.model,
  image: hex('1'),
  scheme: 'https',
});

/** A validated snapshot grade for one case. */
export function gradeFor(caseId: string, grade: 'pass' | 'fail' | 'not-run'): SnapshotGradeResult {
  if (!isEvaluationCaseId(caseId)) throw new Error(`INVALID_CASE_ID: ${caseId}`);
  return {
    caseId,
    criterionId: `criterion-${caseId}`,
    grade,
    reason: grade === 'pass' ? 'criteria-satisfied' : grade === 'fail' ? 'criteria-violation' : 'private-grading',
    evidenceIds: [`criterion:${caseId}`, 'check:required'],
    snapshot: { snapshotId: `snap-${caseId}`, digest: FINAL_SNAPSHOT },
    evidenceDigest: hex('e'),
    criteriaDigest: hex('f'),
    limitations: [],
  };
}

export const STAGES: readonly StageRecord[] = Object.freeze([
  { stage: 'preflight', outcome: 'pass' },
  { stage: 'conformance', outcome: 'pass' },
]);

const rowOf = (caseId: string, facts: StageRecord['facts']): StageRecord => ({ stage: 'case', outcome: 'pass', caseId, facts });
/** The four passing case rows, each naming the receipt facts its artifact must repeat. */
export const PASSING_ROWS: readonly StageRecord[] = Object.freeze([
  rowOf('C01', { attempt: 1, workflow: 'COMPLETED', grade: 'pass', 'grader-digest': hex('f') }),
  rowOf('C02', { attempt: 1, workflow: 'needs-info', grade: 'pass', 'grader-digest': hex('f') }),
  rowOf('C16', { derivedFrom: 'C01', 'report-digest': REPORT }),
  rowOf('C10', { attempt: 1 }),
]);

function evidenceBody(caseId: 'C01' | 'C02', campaignId: string, binding: ArtifactBinding): CaseArtifactBody {
  return {
    schema: CASE_EVIDENCE_SCHEMA,
    campaignId,
    caseId,
    attempt: 1,
    binding,
    finalSnapshotDigest: FINAL_SNAPSHOT,
    identity: { taskId: `task-${caseId}`, runId: `run-${caseId}`, workspaceId: `ws-${caseId}` },
    evidence: {
      snapshot: { snapshotId: `snap-${caseId}`, digest: FINAL_SNAPSHOT },
      evidenceDigest: hex('e'),
      grade: gradeFor(caseId, 'pass'),
      gradeBinding: {
        taskId: `task-${caseId}`,
        runId: `run-${caseId}`,
        workspaceId: `ws-${caseId}`,
        caseId,
        criterionId: `criterion-${caseId}`,
        criteriaDigest: hex('f'),
        snapshotId: `snap-${caseId}`,
        snapshotDigest: FINAL_SNAPSHOT,
        evidenceDigest: hex('e'),
        tier: 'controlled-tier',
        executorId: 'mock-grader-executor',
        admissionId: 'admission-grader-1',
      },
      ownerRevisions: {
        repository: hex('7'),
        statePort: FIXTURE_REV,
        ...Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, FIXTURE_REV])),
      },
      ...(caseId === 'C01'
        ? {
            approval: { decisionId: 'decision-1', decided: 'approve' as const },
            diffDigest: DIFF,
            reportDigest: REPORT,
            commandViewDigest: hex('c'),
            commandAdmissionRef: 'admission-c01-cmd-1',
            usage: { tokens: 120, cost: 0.01, costLabel: 'estimate-unverified' as const },
          }
        : {}),
    },
    accounting: { claims: 3, attempts: 3, outcomes: 3 },
  };
}

function c16Body(campaignId: string, binding: ArtifactBinding, c01: CaseArtifactBody): C16ReportBody {
  return {
    schema: C16_REPORT_SCHEMA,
    campaignId,
    caseId: 'C16',
    attempt: 1,
    binding,
    finalSnapshotDigest: FINAL_SNAPSHOT,
    derivedFrom: 'C01',
    sourceArtifact: artifactName('C01', 1, 'evidence'),
    sourceDigest: digestOf(serialize(c01)),
    verdict: 'pass',
    report: { present: true, outcome: 'COMPLETED', isComplete: true, diffDigest: DIFF, evidenceRefs: ['ev-1'], changedFiles: ['src/calculator.py'], bytes: 512, reportDigest: REPORT },
  };
}

/** One C10 call's facts; the allowed call settles, the refused one is denied by the limiter before any fetch. */
function c10Calls(): C10WitnessBody['calls'] {
  const allowed: C10CallFacts = {
    requestId: 'c10-allowed',
    declared: { maxInputTokens: 16_384, maxOutputTokens: 1_024 },
    fetchesBefore: 0,
    fetchesAfter: 1,
    portOutcome: 'observed',
    transport: { outcome: 'observed', reasonCode: null, claimsAtTransport: 1, fetchesAtTransport: 0 },
    claims: { before: 0, after: 1 },
    outcomes: { before: 0, after: 1, recorded: ['observed'] },
    observedUsage: { inputTokens: 12, outputTokens: 4 },
  };
  const refused: C10CallFacts = {
    requestId: 'c10-oversized',
    declared: { maxInputTokens: 400_001, maxOutputTokens: 1 },
    fetchesBefore: 1,
    fetchesAfter: 1,
    portOutcome: 'uncertain',
    transport: { outcome: 'denied', reasonCode: 'RUN_USAGE_LIMIT_REACHED', claimsAtTransport: 2, fetchesAtTransport: 1 },
    claims: { before: 1, after: 2 },
    outcomes: { before: 1, after: 2, recorded: ['uncertain'] },
    observedUsage: null,
  };
  return { allowed, refused };
}

function c10Budgets(): C10WitnessBody['budgets'] {
  const absent: C10BudgetCallFacts = {
    requestId: 'c10-budget-absent',
    kind: 'absent',
    declared: { maxInputTokens: 2_000_001, maxOutputTokens: 1, maxBillableTokens: 2_000_002 },
    budgetRefs: ['task-tokens-c10', 'run-tokens-c10'],
    reservationRef: 'res-c10-budget-absent',
    ledger: { limit: 2_000_000, consumedBefore: 0, reservedBefore: 0, consumedAfter: 0, reservedAfter: 0 },
    requestedBillable: 2_000_002,
    fetchesBefore: 0,
    fetchesAfter: 0,
    portOutcome: 'claim-denied',
    refusal: 'CLAIM_DENIED',
    transport: null,
    claims: { before: 0, after: 0 },
    outcomes: { before: 0, after: 0, recorded: [] },
  };
  const exhausted: C10BudgetCallFacts = {
    requestId: 'c10-budget-exhausted',
    kind: 'exhausted',
    declared: { maxInputTokens: 2_000_001, maxOutputTokens: 1, maxBillableTokens: 2_000_002 },
    budgetRefs: ['task-tokens-c10', 'run-tokens-c10'],
    reservationRef: 'res-c10-budget-exhausted',
    ledger: { limit: 2_000_000, consumedBefore: 16, reservedBefore: 0, consumedAfter: 16, reservedAfter: 0 },
    requestedBillable: 2_000_002,
    fetchesBefore: 1,
    fetchesAfter: 1,
    portOutcome: 'claim-denied',
    refusal: 'CLAIM_DENIED',
    transport: null,
    claims: { before: 1, after: 1 },
    outcomes: { before: 1, after: 1, recorded: [] },
  };
  return { absent, exhausted };
}

function c10Body(campaignId: string, binding: ArtifactBinding): C10WitnessBody {
  return {
    schema: C10_WITNESS_SCHEMA,
    campaignId,
    caseId: 'C10',
    attempt: 1,
    binding,
    finalSnapshotDigest: null,
    identity: { taskId: 'task-C10', runId: 'run-C10', workspaceId: 'ws-C10' },
    provider: { providerId: 'provider-deepseek', modelId: binding.model, configId: 'config-v1', configVersion: '1.0.0' },
    limits: { totalModelCalls: 24, perRunInputTokens: 400_000, perRunOutputTokens: 80_000, budgetRefs: [] },
    calls: c10Calls(),
    budgets: c10Budgets(),
    commandViewDigest: null,
    commandViewScope: 'not-applicable-provider-only',
    disclosure: 'test fixture',
  };
}

/** The complete artifact set, in row order. */
export function passingArtifacts(campaignId = FIXTURE_CAMPAIGN, binding: ArtifactBinding = FIXTURE_BINDING): PendingArtifact[] {
  const c01 = evidenceBody('C01', campaignId, binding);
  return [
    ['C01', 1, 'evidence', c01],
    ['C02', 1, 'evidence', evidenceBody('C02', campaignId, binding)],
    ['C16', 1, 'c16', c16Body(campaignId, binding, c01)],
    ['C10', 1, 'c10', c10Body(campaignId, binding)],
  ];
}

/** The passing case outcomes a stage returns, each carrying the artifact its row owns. */
export function passingCases(campaignId = FIXTURE_CAMPAIGN, binding: ArtifactBinding = FIXTURE_BINDING): CaseOutcome[] {
  const [c01, c02, c16, c10] = passingArtifacts(campaignId, binding).map(([, , , body]) => body);
  const [r01, r02, r16, r10] = PASSING_ROWS as [StageRecord, StageRecord, StageRecord, StageRecord];
  return [
    { record: r01, artifact: c01 as CaseArtifactBody },
    { record: r02, artifact: c02 as CaseArtifactBody },
    { record: r16, derived: { kind: 'c16', body: c16 as C16ReportBody } },
    { record: r10, derived: { kind: 'c10', body: c10 as C10WitnessBody } },
  ];
}

/**
 * A v2 campaign directory with its conformance receipt beside the record. The artifacts default to the
 * complete set restricted to the cases the records name, so a record without a case writes no artifact.
 */
export function writeRecord(dir: string, records: readonly StageRecord[], artifacts?: readonly PendingArtifact[], campaignId = FIXTURE_CAMPAIGN): void {
  const named = new Set(records.map(row => row.caseId));
  writeCampaign(
    dir,
    { campaignId, candidateSha: FIXTURE_REV, mode: 'campaign', passed: records.every(row => row.outcome === 'pass'), startedAt: 1, finishedAt: 2, bindings: bindingsOf(FIXTURE_BINDING), records },
    artifacts ?? passingArtifacts(campaignId).filter(([caseId]) => named.has(caseId)),
  );
  writeReceipt(dir, { schemaVersion: RECEIPT_SCHEMA, campaignId, binding: FIXTURE_BINDING, outcome: 'conformed', finishedAt: 2 });
}
