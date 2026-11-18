/**
 * T028 campaign evidence checker (real-tier contract §(f) T028 row, §(h); T059).
 *
 * A passing label is not evidence. This checker reads the campaign record the runner wrote, resolves
 * every artifact it references, recomputes each artifact's digest, and judges the content behind each
 * case row: C01/C02 need a graded receipt bound to the same case and snapshot as the row, C16 needs a
 * safe report judged from the C01 run, and C10 needs its own zero-dispatch witness. A missing,
 * misattributed, digest-mismatched or failed artifact refuses (SPEC-W5-106).
 *
 * Missing or duplicate case ids are refused too (STD-W5-102): a campaign has exactly one row per
 * scheduled case, and an attempt id is unique for its case. The T057 directory scan runs first over
 * the whole evidence directory, so a leaked needle is reported before any judgement is made.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { needleGuard, resolveScanProfile, scanDirectory, type ScanOptions, type ScanResult } from '../../../src/runtime/real-tier-endpoint-scan.ts';

import {
  CASE_EVIDENCE_SCHEMA,
  C16_REPORT_SCHEMA,
  C10_WITNESS_SCHEMA,
  REASON_CODE,
  SAFE_ID,
  SHA256,
  digestOf,
  readArtifact,
  type CampaignRecord,
  type CaseArtifact,
  type StageRecord,
} from './uc03-success-real-record.ts';

const RECORD = 'campaign.json';
const RECORD_SCHEMA = 'uc03-campaign-record/2';

export interface EvidenceCheckOptions {
  /** The retained campaign directory: `campaign.json` and the artifacts it references. */
  readonly evidenceDir: string;
  readonly env: ScanOptions['env'];
  readonly repositoryRoot: string;
}

export interface EvidenceCheckResult {
  /** 0 clean and every predicate passed; 1 a failed/not-run/unsubstantiated predicate or a leak; 2 unusable input. */
  readonly exitCode: 0 | 1 | 2;
  readonly output: string;
}

/** The mandatory stages before any case, and the contract case rows; neither may be omitted. */
const REQUIRED_STAGES = ['preflight', 'conformance'] as const;
const REQUIRED_CASES = ['C01', 'C02', 'C16', 'C10'] as const;
/** The binding keys every campaign record must carry, so a partial record is not a campaign. */
const BINDING_KEYS = ['candidate-sha', 'profile-digest', 'endpoint-digest', 'model'] as const;

function isStageRecord(value: unknown): value is StageRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['stage'] !== 'string' || !['assembly', 'preflight', 'conformance', 'receipt', 'recovery', 'case'].includes(record['stage'])) return false;
  if (record['outcome'] !== 'pass' && record['outcome'] !== 'fail' && record['outcome'] !== 'not-run') return false;
  if (record['caseId'] !== undefined && (typeof record['caseId'] !== 'string' || !SAFE_ID.test(record['caseId']))) return false;
  // An unvalidated reason code is untrusted text that would otherwise reach the operator output.
  if (record['reasonCode'] !== undefined && (typeof record['reasonCode'] !== 'string' || !REASON_CODE.test(record['reasonCode']))) return false;
  return true;
}

function isArtifact(value: unknown): value is CaseArtifact {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['caseId'] === 'string' && SAFE_ID.test(record['caseId']) && typeof record['attempt'] === 'number' && Number.isSafeInteger(record['attempt']) && record['attempt'] >= 1 && (record['kind'] === 'evidence' || record['kind'] === 'c16' || record['kind'] === 'c10') && typeof record['path'] === 'string' && typeof record['digest'] === 'string' && SHA256.test(record['digest']);
}

/** A retained record is parsed as untrusted input: an unknown shape is unusable, never a pass. */
function parseRecord(text: string): CampaignRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record['schemaVersion'] !== RECORD_SCHEMA) return undefined;
  const bindings = record['bindings'];
  if (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) return undefined;
  const bindingRecord = bindings as Record<string, unknown>;
  if (!BINDING_KEYS.every(key => typeof bindingRecord[key] === 'string' && (bindingRecord[key] as string).trim() !== '')) return undefined;
  const records = record['records'];
  if (!Array.isArray(records) || records.length === 0 || !records.every(isStageRecord)) return undefined;
  const caseArtifacts = record['caseArtifacts'];
  if (!Array.isArray(caseArtifacts) || !caseArtifacts.every(isArtifact)) return undefined;
  return {
    schemaVersion: RECORD_SCHEMA,
    campaignId: typeof record['campaignId'] === 'string' ? record['campaignId'] : '',
    candidateSha: typeof record['candidateSha'] === 'string' ? record['candidateSha'] : '',
    mode: record['mode'] === 'campaign' || record['mode'] === 'case' || record['mode'] === 'resume' ? record['mode'] : 'campaign',
    passed: record['passed'] === true,
    startedAt: typeof record['startedAt'] === 'number' ? record['startedAt'] : 0,
    finishedAt: typeof record['finishedAt'] === 'number' ? record['finishedAt'] : 0,
    bindings: bindingRecord as Readonly<Record<string, string>>,
    records: records as readonly StageRecord[],
    caseArtifacts: caseArtifacts as readonly CaseArtifact[],
  };
}

/** One case row's artifact, as the tuple it is keyed by; a row with none is a failure. */
interface ResolvedArtifact {
  readonly artifact: CaseArtifact;
  readonly body: Record<string, unknown> | undefined;
}

/** Reads and digest-checks every artifact the record references; a mismatch is named, never ignored. */
function resolveArtifacts(dir: string, artifacts: readonly CaseArtifact[]): readonly (ResolvedArtifact | string)[] {
  return artifacts.map(artifact => {
    const text = readArtifact(dir, artifact);
    if (text === undefined) return `artifact-misnamed:${artifact.path}`;
    if (digestOf(text) !== artifact.digest) return `artifact-digest-mismatch:${artifact.path}`;
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? { artifact, body: parsed as Record<string, unknown> } : `artifact-invalid:${artifact.path}`;
  });
}

/** The evidence behind a case row: its own artifact must exist, be bound to it, and agree with the row. */
function judgedCase(caseId: string, row: StageRecord, artifacts: readonly CaseArtifact[], bodies: ReadonlyMap<string, Record<string, unknown> | undefined>): string | undefined {
  const own = artifacts.filter(artifact => artifact.caseId === caseId && (artifact.kind === 'evidence' || artifact.kind === (caseId === 'C16' ? 'c16' : caseId === 'C10' ? 'c10' : 'evidence')));
  if (own.length !== 1) return own.length === 0 ? `case:${caseId}:missing-artifact` : `case:${caseId}:duplicate-artifact`;
  const body = bodies.get((own[0] as CaseArtifact).path);
  if (body === undefined) return `case:${caseId}:artifact-unreadable`;
  if (body['caseId'] !== caseId) return `case:${caseId}:artifact-misattributed`;
  if (body['campaignId'] === '') return `case:${caseId}:artifact-unbound`;
  if (caseId === 'C01' || caseId === 'C02') return judgedGraded(caseId, row, body);
  if (caseId === 'C16') return judgedC16(row, body, artifacts);
  return judgedC10(row, body);
}

/** C01/C02: a graded receipt whose case, snapshot and digest the row itself names. */
function judgedGraded(caseId: string, row: StageRecord, body: Record<string, unknown>): string | undefined {
  if (body['schema'] !== CASE_EVIDENCE_SCHEMA) return `case:${caseId}:artifact-schema`;
  const evidence = body['evidence'];
  if (typeof evidence !== 'object' || evidence === null) return `case:${caseId}:evidence-missing`;
  const record = evidence as Record<string, unknown>;
  const grade = record['grade'];
  if (typeof grade !== 'object' || grade === null) return `case:${caseId}:grade-missing`;
  const graded = grade as Record<string, unknown>;
  if (graded['caseId'] !== caseId) return `case:${caseId}:grade-case-mismatch`;
  if (row.outcome === 'pass' && graded['grade'] !== 'pass') return `case:${caseId}:label-unsubstantiated`;
  // The row's own facts must agree with the receipt it cites, so a copied pass cannot travel alone.
  if (row.facts?.['grade'] !== graded['grade']) return `case:${caseId}:label-mismatch`;
  const identity = body['identity'];
  if (typeof identity !== 'object' || identity === null || typeof (identity as Record<string, unknown>)['taskId'] !== 'string') return `case:${caseId}:identity-missing`;
  return undefined;
}

/** C16: a safe report judged from the C01 run, present, bounded and carrying provenance. */
function judgedC16(row: StageRecord, body: Record<string, unknown>, artifacts: readonly CaseArtifact[]): string | undefined {
  if (body['schema'] !== C16_REPORT_SCHEMA || body['derivedFrom'] !== 'C01') return 'case:C16:artifact-schema';
  // The report must name the C01 artifact it was derived from, and that artifact must exist.
  const source = body['sourceArtifact'];
  if (typeof source !== 'string' || !artifacts.some(artifact => artifact.path === source && artifact.caseId === 'C01')) return 'case:C16:report-source-missing';
  const report = body['report'];
  if (typeof report !== 'object' || report === null) return 'case:C16:report-missing';
  const view = report as Record<string, unknown>;
  // The row's verdict must be the report predicate's own: a pass can never outrun its report.
  if (row.outcome === 'pass' && body['verdict'] !== 'pass') return 'case:C16:report-unsafe';
  if (row.outcome === 'pass' && view['present'] !== true) return 'case:C16:report-absent';
  if (row.outcome !== 'pass') return undefined;
  if (typeof view['diffDigest'] !== 'string' && view['isComplete'] === true) return 'case:C16:report-incomplete';
  const refs = view['evidenceRefs'];
  if (!Array.isArray(refs) || refs.length === 0) return 'case:C16:report-unprovenanced';
  if (typeof view['reportDigest'] !== 'string' || !SHA256.test(view['reportDigest'])) return 'case:C16:report-undigested';
  if (typeof view['bytes'] !== 'number' || view['bytes'] <= 0) return 'case:C16:report-empty';
  return undefined;
}

/** C10: its own witness, with exactly one refusal and no extra fetch for that refused call. */
function judgedC10(row: StageRecord, body: Record<string, unknown>): string | undefined {
  if (body['schema'] !== C10_WITNESS_SCHEMA) return 'case:C10:artifact-schema';
  const dispatch = body['dispatch'];
  if (typeof dispatch !== 'object' || dispatch === null) return 'case:C10:witness-missing';
  const witness = dispatch as Record<string, unknown>;
  if (row.outcome !== 'pass') return undefined;
  if (witness['refusals'] !== 1) return 'case:C10:no-refusal';
  if (typeof witness['reason'] !== 'string') return 'case:C10:reason-missing';
  if (typeof witness['fetchesBefore'] !== 'number' || typeof witness['fetchesAfter'] !== 'number') return 'case:C10:dispatch-unobserved';
  const limits = body['limits'];
  if (typeof limits !== 'object' || limits === null) return 'case:C10:limits-missing';
  const ceiling = (limits as Record<string, unknown>)['totalModelCalls'];
  if (typeof ceiling !== 'number') return 'case:C10:limits-missing';
  // Each allowed call dispatches once; the refused call adds nothing above the ceiling.
  if (witness['fetchesAfter'] - witness['fetchesBefore'] !== ceiling) return 'case:C10:refusal-dispatched';
  const journal = body['journal'];
  if (typeof journal !== 'object' || journal === null) return 'case:C10:journal-missing';
  const claims = journal as Record<string, unknown>;
  if (typeof claims['claimsAfter'] !== 'number' || (claims['claimsAfter'] as number) <= (claims['claimsBefore'] as number)) return 'case:C10:no-reservation';
  if (typeof claims['outcomesAfter'] !== 'number' || (claims['outcomesAfter'] as number) <= (claims['outcomesBefore'] as number)) return 'case:C10:no-settlement';
  return undefined;
}

/**
 * Judges one retained campaign directory. The scan verdict comes first and blocks a failed predicate
 * from being reported as anything but a failure. Every original row is inspected; a later row never
 * overwrites an earlier one, and every mandatory stage and case must be present exactly once.
 */
export function checkEvidence(options: EvidenceCheckOptions): EvidenceCheckResult {
  const dir = resolve(options.evidenceDir);
  const scan: ScanResult = scanDirectory(dir, { env: options.env, repositoryRoot: options.repositoryRoot });
  if (scan.exitCode !== 0) {
    // The scanner's own report already names only a location, so it is forwarded unchanged.
    return { exitCode: scan.exitCode === 1 ? 1 : 2, output: `EVIDENCE_SCAN_FAILED\n${scan.output}` };
  }

  let text: string;
  try {
    text = readFileSync(join(dir, RECORD), 'utf8');
  } catch {
    return { exitCode: 2, output: 'EVIDENCE_RECORD_MISSING' };
  }
  const campaign = parseRecord(text);
  if (campaign === undefined) return { exitCode: 2, output: 'EVIDENCE_RECORD_INVALID' };
  const { records } = campaign;

  // A reason code is decoded by JSON.parse before it is judged, so a needle hidden as Unicode escapes
  // evades the raw-text scan. Re-scan every decoded code against the same needle set before echoing any.
  const resolved = resolveScanProfile(options.env, options.repositoryRoot);
  const leaks = resolved.ok && records.some(entry => entry.reasonCode !== undefined && needleGuard(entry.reasonCode, resolved.profile, options.env) !== undefined);
  if (leaks) return { exitCode: 2, output: 'EVIDENCE_RECORD_INVALID' };

  // Every non-case stage row and every earlier attempt is judged in place, never through a last-value map.
  const failed = records.filter(entry => entry.outcome !== 'pass');
  const seenStages = new Set(records.filter(entry => entry.stage !== 'case').map(entry => entry.stage));
  const missingStages = REQUIRED_STAGES.filter(stage => !seenStages.has(stage));
  const caseRows = records.filter(entry => entry.stage === 'case');
  // A case row without an id is malformed, and two rows for one case are ambiguous: both refuse.
  const unlabelled = caseRows.filter(entry => entry.caseId === undefined);
  const caseCounts = new Map<string, number>();
  for (const row of caseRows) if (row.caseId !== undefined) caseCounts.set(row.caseId, (caseCounts.get(row.caseId) ?? 0) + 1);
  const duplicated = [...caseCounts.entries()].filter(([, count]) => count > 1).map(([caseId]) => caseId);
  const missingCases = REQUIRED_CASES.filter(caseId => !caseCounts.has(caseId));
  if (failed.length > 0 || missingStages.length > 0 || missingCases.length > 0 || unlabelled.length > 0 || duplicated.length > 0) {
    const lines = [
      ...failed.map(entry => (entry.stage === 'case' ? `case:${entry.caseId ?? 'unknown'}:${entry.outcome}` : `${entry.stage}:${entry.outcome}`) + (entry.reasonCode === undefined ? '' : `:${entry.reasonCode}`)),
      ...missingStages.map(stage => `${stage}:missing`),
      ...missingCases.map(caseId => `case:missing:${caseId}`),
      ...unlabelled.map(() => 'case:unlabelled'),
      ...duplicated.map(caseId => `case:${caseId}:duplicate`),
    ];
    return { exitCode: 1, output: ['EVIDENCE_INCOMPLETE', ...lines].join('\n') };
  }

  // Each passing case row must be backed by its own artifact; a pass label alone is never enough.
  const artifacts = resolveArtifacts(dir, campaign.caseArtifacts);
  const broken = artifacts.filter((entry): entry is string => typeof entry === 'string');
  if (broken.length > 0) return { exitCode: 1, output: ['EVIDENCE_INCOMPLETE', ...broken].join('\n') };
  const bodies = new Map<string, Record<string, unknown> | undefined>((artifacts as ResolvedArtifact[]).map(entry => [entry.artifact.path, entry.body]));
  const unsubstantiated = REQUIRED_CASES.map(caseId => judgedCase(caseId, caseRows.find(row => row.caseId === caseId) as StageRecord, campaign.caseArtifacts, bodies)).filter((entry): entry is string => entry !== undefined);
  if (unsubstantiated.length > 0) return { exitCode: 1, output: ['EVIDENCE_INCOMPLETE', ...unsubstantiated].join('\n') };
  return { exitCode: 0, output: `EVIDENCE_CLEAN ${caseCounts.size} case(s)` };
}

function isDirectExecution(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && resolve(invoked) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--evidence');
  const dir = at === -1 ? undefined : args[at + 1];
  if (dir === undefined || dir === '') {
    process.stdout.write('EVIDENCE_REFUSED arguments\n');
    process.exitCode = 2;
  } else {
    const result = checkEvidence({ evidenceDir: dir, env: process.env, repositoryRoot: process.cwd() });
    process.stdout.write(`${result.output}\n`);
    process.exitCode = result.exitCode;
  }
}
