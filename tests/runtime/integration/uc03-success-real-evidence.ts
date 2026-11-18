/**
 * T028 campaign evidence checker (real-tier contract §(f) T028 row, §(h); T059).
 *
 * A passing label is not evidence. This checker reads the campaign record the runner wrote, resolves
 * every artifact it references, recomputes each artifact's digest, and judges the content behind each
 * case row. Every artifact must be bound to this campaign: its campaign id, case, attempt, pinned
 * binding and final snapshot digest must agree with the record, the conformance receipt and the
 * artifacts it derives from (SPEC-W5-206). C10 is judged by the one predicate the runner applies.
 *
 * `--evidence` accepts the campaign directory itself or its parent (the T054 directory the quickstart
 * names), in which case the newest `--campaign` directory is judged. Missing or duplicate case ids are
 * refused (STD-W5-102). The T057 directory scan runs first, so a leaked needle is reported before any
 * judgement. Output carries bounded codes only; no decoded path or value is ever echoed (STD-W5-209).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { needleGuard, resolveScanProfile, scanDirectory, type ScanOptions, type ScanResult } from '../../../src/runtime/real-tier-endpoint-scan.ts';

import { judgeC10, parseC10 } from './uc03-success-real-c10.ts';
import { PINNED_MODEL } from './uc03-success-real-provider.ts';
import {
  CASE_EVIDENCE_SCHEMA,
  C16_REPORT_SCHEMA,
  RECORD_SCHEMA,
  REASON_CODE,
  SAFE_ID,
  SHA256,
  bindingOf,
  digestOf,
  parseReceipt,
  readArtifact,
  receiptName,
  sameBinding,
  type ArtifactBinding,
  type CampaignRecord,
  type CaseArtifact,
  type StageRecord,
} from './uc03-success-real-record.ts';

const RECORD = 'campaign.json';
/** The directory names a `--campaign` invocation creates; the parent form judges the newest. */
const CAMPAIGN_DIR = /^campaign-(\d+)-campaign-all(?:-(\d+))?$/u;

export interface EvidenceCheckOptions {
  /** The campaign directory, or the evidence directory holding campaign directories. */
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
const BINDING_KEYS = ['candidate-sha', 'profile-digest', 'endpoint-digest', 'model', 'image', 'scheme'] as const;

type Raw = Record<string, unknown>;
const isRaw = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const isDigest = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value);
const isId = (value: unknown): value is string => typeof value === 'string' && SAFE_ID.test(value);

function isStageRecord(value: unknown): value is StageRecord {
  if (!isRaw(value)) return false;
  if (typeof value['stage'] !== 'string' || !['assembly', 'preflight', 'conformance', 'receipt', 'recovery', 'case'].includes(value['stage'])) return false;
  if (value['outcome'] !== 'pass' && value['outcome'] !== 'fail' && value['outcome'] !== 'not-run') return false;
  if (value['caseId'] !== undefined && !isId(value['caseId'])) return false;
  // An unvalidated reason code is untrusted text that would otherwise reach the operator output.
  return value['reasonCode'] === undefined || (typeof value['reasonCode'] === 'string' && REASON_CODE.test(value['reasonCode']));
}

function isArtifact(value: unknown): value is CaseArtifact {
  return isRaw(value) && isId(value['caseId']) && typeof value['attempt'] === 'number' && Number.isSafeInteger(value['attempt']) && value['attempt'] >= 1 && (value['kind'] === 'evidence' || value['kind'] === 'c16' || value['kind'] === 'c10') && typeof value['path'] === 'string' && isDigest(value['digest']);
}

/** Parses retained JSON as untrusted input; an unparsable file is `undefined`, never a pass. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseRecord(text: string): CampaignRecord | undefined {
  const record = parseJson(text);
  if (!isRaw(record) || record['schemaVersion'] !== RECORD_SCHEMA || !isId(record['campaignId'])) return undefined;
  const bindings = record['bindings'];
  if (!isRaw(bindings) || !BINDING_KEYS.every(key => typeof bindings[key] === 'string' && (bindings[key] as string).trim() !== '')) return undefined;
  const records = record['records'];
  const caseArtifacts = record['caseArtifacts'];
  if (!Array.isArray(records) || records.length === 0 || !records.every(isStageRecord) || !Array.isArray(caseArtifacts) || !caseArtifacts.every(isArtifact)) return undefined;
  return {
    schemaVersion: RECORD_SCHEMA,
    campaignId: record['campaignId'],
    candidateSha: typeof record['candidateSha'] === 'string' ? record['candidateSha'] : '',
    mode: record['mode'] === 'campaign' || record['mode'] === 'case' || record['mode'] === 'resume' ? record['mode'] : 'campaign',
    passed: record['passed'] === true,
    startedAt: typeof record['startedAt'] === 'number' ? record['startedAt'] : 0,
    finishedAt: typeof record['finishedAt'] === 'number' ? record['finishedAt'] : 0,
    bindings: bindings as Readonly<Record<string, string>>,
    records: records as readonly StageRecord[],
    caseArtifacts: caseArtifacts as readonly CaseArtifact[],
  };
}

/** The campaign directory: the given one, or the newest `--campaign` directory under it. */
function campaignDirOf(root: string): string | undefined {
  if (existsSync(join(root, RECORD))) return root;
  if (!existsSync(root)) return undefined;
  const newest = readdirSync(root)
    .flatMap(name => {
      const match = CAMPAIGN_DIR.exec(name);
      return match === null ? [] : [{ name, at: Number(match[1]), n: Number(match[2] ?? 1) }];
    })
    .sort((left, right) => left.at - right.at || left.n - right.n)
    .at(-1);
  return newest !== undefined && existsSync(join(root, newest.name, RECORD)) ? join(root, newest.name) : undefined;
}

/** Record-level problems: the campaign shape, the binding values and the conformance receipt it rests on. */
function recordProblems(campaign: CampaignRecord, dir: string): readonly string[] {
  const { bindings } = campaign;
  const problems: string[] = [];
  if (campaign.mode !== 'campaign') problems.push('record:not-a-campaign');
  if (bindings['candidate-sha'] !== campaign.candidateSha || !/^[0-9a-f]{40}$/u.test(campaign.candidateSha)) problems.push('record:candidate-invalid');
  if (!isDigest(bindings['profile-digest']) || !isDigest(bindings['endpoint-digest'])) problems.push('record:binding-digest-invalid');
  if (bindings['model'] !== PINNED_MODEL) problems.push('record:model-not-pinned');
  const path = [join(dir, receiptName(campaign.campaignId)), join(dirname(dir), receiptName(campaign.campaignId))].find(existsSync);
  const receipt = path === undefined ? undefined : parseReceipt(parseJson(readFileSync(path, 'utf8')));
  if (path === undefined) problems.push('receipt:missing');
  else if (receipt === undefined) problems.push('receipt:malformed');
  else if (receipt.campaignId !== campaign.campaignId) problems.push('receipt:campaign-mismatch');
  else if (receipt.outcome !== 'conformed') problems.push('receipt:not-conformed');
  else if (!sameBinding(receipt.binding, bindingOf(bindings))) problems.push('receipt:binding-mismatch');
  return problems;
}

/** Everything a case judgement compares an artifact against. */
interface Context {
  readonly campaign: CampaignRecord;
  readonly binding: ArtifactBinding;
  readonly artifacts: readonly CaseArtifact[];
  readonly bodies: ReadonlyMap<string, Raw>;
}

/** Reads and digest-checks every referenced artifact; a failure is named by its index, never its path. */
function resolveArtifacts(dir: string, artifacts: readonly CaseArtifact[]): { readonly bodies: ReadonlyMap<string, Raw>; readonly broken: readonly string[] } {
  const bodies = new Map<string, Raw>();
  const broken: string[] = [];
  artifacts.forEach((artifact, index) => {
    const text = readArtifact(dir, artifact);
    if (text === undefined) broken.push(`artifact[${index}]:unreadable`);
    else if (digestOf(text) !== artifact.digest) broken.push(`artifact[${index}]:digest-mismatch`);
    else {
      const body = parseJson(text);
      if (isRaw(body)) bodies.set(artifact.path, body);
      else broken.push(`artifact[${index}]:invalid`);
    }
  });
  return { bodies, broken };
}

const ownOf = (ctx: Context, caseId: string) => ctx.artifacts.filter(artifact => artifact.caseId === caseId && artifact.kind === (caseId === 'C16' ? 'c16' : caseId === 'C10' ? 'c10' : 'evidence'));

/** The evidence behind a case row: its own artifact must exist, be bound to this campaign, and agree with the row. */
function judgedCase(ctx: Context, caseId: string, row: StageRecord): string | undefined {
  const own = ownOf(ctx, caseId);
  if (own.length !== 1) return own.length === 0 ? `case:${caseId}:missing-artifact` : `case:${caseId}:duplicate-artifact`;
  const ref = own[0] as CaseArtifact;
  const body = ctx.bodies.get(ref.path);
  if (body === undefined) return `case:${caseId}:artifact-unreadable`;
  if (body['caseId'] !== caseId) return `case:${caseId}:artifact-misattributed`;
  if (body['campaignId'] !== ctx.campaign.campaignId) return `case:${caseId}:artifact-campaign`;
  if (body['attempt'] !== ref.attempt) return `case:${caseId}:artifact-attempt`;
  if (!sameBinding(body['binding'], ctx.binding)) return `case:${caseId}:artifact-binding`;
  const failure = caseId === 'C16' ? judgedC16(ctx, row, body, ref) : caseId === 'C10' ? judgedC10(body) : judgedGraded(caseId, row, body);
  return failure === undefined ? undefined : `case:${caseId}:${failure}`;
}

const identityOk = (body: Raw): boolean => isRaw(body['identity']) && isId(body['identity']['taskId']) && isId(body['identity']['runId']) && isId(body['identity']['workspaceId']);

/** C01/C02: a graded receipt whose snapshot, evidence and criteria the artifact and its row both name. */
function judgedGraded(caseId: string, row: StageRecord, body: Raw): string | undefined {
  if (body['schema'] !== CASE_EVIDENCE_SCHEMA) return 'artifact-schema';
  if (!identityOk(body)) return 'identity-missing';
  const evidence = body['evidence'];
  if (!isRaw(evidence)) return 'evidence-missing';
  const grade = evidence['grade'];
  if (!isRaw(grade)) return 'grade-missing';
  if (grade['caseId'] !== caseId) return 'grade-case-mismatch';
  if (grade['grade'] !== 'pass') return 'label-unsubstantiated';
  // The row's own facts must agree with the receipt it cites, so a copied pass cannot travel alone.
  if (row.facts?.['grade'] !== grade['grade']) return 'label-mismatch';
  const snapshot = grade['snapshot'];
  if (!isRaw(snapshot) || !isId(snapshot['snapshotId']) || !isDigest(snapshot['digest']) || !isDigest(grade['evidenceDigest']) || !isDigest(grade['criteriaDigest']) || typeof grade['criterionId'] !== 'string' || grade['criterionId'] === '') return 'grade-unbound';
  const kept = evidence['snapshot'];
  if (!isRaw(kept) || kept['snapshotId'] !== snapshot['snapshotId'] || kept['digest'] !== snapshot['digest'] || evidence['evidenceDigest'] !== grade['evidenceDigest']) return 'snapshot-mismatch';
  if (body['finalSnapshotDigest'] !== snapshot['digest']) return 'final-snapshot-mismatch';
  if (row.facts?.['grader-digest'] !== grade['criteriaDigest']) return 'criteria-mismatch';
  const accounting = body['accounting'];
  if (!isRaw(accounting) || !['claims', 'attempts', 'outcomes'].every(key => Number.isSafeInteger(accounting[key]))) return 'accounting-missing';
  if (!isRaw(evidence['ownerRevisions']) || typeof evidence['ownerRevisions']['repository'] !== 'string') return 'owner-revisions-missing';
  if (caseId !== 'C01') return undefined;
  const approval = evidence['approval'];
  if (!isRaw(approval) || approval['decided'] !== 'approve' || typeof approval['decisionId'] !== 'string' || approval['decisionId'] === '') return 'approval-missing';
  if (!isDigest(evidence['diffDigest']) || !isDigest(evidence['reportDigest'])) return 'diff-missing';
  const usage = evidence['usage'];
  if (!isRaw(usage) || typeof usage['tokens'] !== 'number' || typeof usage['cost'] !== 'number' || (usage['costLabel'] !== 'estimate-unverified' && usage['costLabel'] !== 'unknown')) return 'usage-unlabelled';
  return undefined;
}

/** C16: a safe report derived from the retained C01 artifact, present, bounded and carrying provenance. */
function judgedC16(ctx: Context, row: StageRecord, body: Raw, ref: CaseArtifact): string | undefined {
  if (body['schema'] !== C16_REPORT_SCHEMA || body['derivedFrom'] !== 'C01') return 'artifact-schema';
  const source = ownOf(ctx, 'C01')[0];
  const c01 = source === undefined ? undefined : ctx.bodies.get(source.path);
  if (source === undefined || c01 === undefined || body['sourceArtifact'] !== source.path) return 'report-source-missing';
  if (body['sourceDigest'] !== source.digest || ref.attempt !== source.attempt) return 'report-source-mismatch';
  if (!isDigest(body['finalSnapshotDigest']) || body['finalSnapshotDigest'] !== c01['finalSnapshotDigest']) return 'final-snapshot-mismatch';
  // The row's verdict must be the report predicate's own: a pass can never outrun its report.
  if (body['verdict'] !== 'pass') return 'report-unsafe';
  const view = body['report'];
  if (!isRaw(view)) return 'report-missing';
  if (view['present'] !== true) return 'report-absent';
  if (view['isComplete'] === true && !isDigest(view['diffDigest'])) return 'report-incomplete';
  if (!Array.isArray(view['evidenceRefs']) || view['evidenceRefs'].length === 0) return 'report-unprovenanced';
  if (!isDigest(view['reportDigest'])) return 'report-undigested';
  if (typeof view['bytes'] !== 'number' || view['bytes'] <= 0) return 'report-empty';
  const kept = isRaw(c01['evidence']) ? c01['evidence'] : {};
  if (view['reportDigest'] !== kept['reportDigest'] || (view['diffDigest'] !== null && view['diffDigest'] !== kept['diffDigest'])) return 'report-source-mismatch';
  return row.facts?.['report-digest'] === view['reportDigest'] ? undefined : 'label-mismatch';
}

/** C10: the one predicate the runner applies, over a witness bound to this campaign. */
function judgedC10(body: Raw): string | undefined {
  const witness = parseC10(body);
  if (witness === undefined) return 'artifact-schema';
  if (!identityOk(body)) return 'identity-missing';
  return judgeC10(witness);
}

/**
 * Judges one retained campaign directory. The scan verdict comes first and blocks a failed predicate
 * from being reported as anything but a failure. Every original row is inspected; a later row never
 * overwrites an earlier one, and every mandatory stage and case must be present exactly once.
 */
export function checkEvidence(options: EvidenceCheckOptions): EvidenceCheckResult {
  const root = resolve(options.evidenceDir);
  const scan: ScanResult = scanDirectory(root, { env: options.env, repositoryRoot: options.repositoryRoot });
  if (scan.exitCode !== 0) {
    // The scanner's own report already names only a location, so it is forwarded unchanged.
    return { exitCode: scan.exitCode === 1 ? 1 : 2, output: `EVIDENCE_SCAN_FAILED\n${scan.output}` };
  }
  const dir = campaignDirOf(root);
  if (dir === undefined) return { exitCode: 2, output: 'EVIDENCE_RECORD_MISSING' };
  const campaign = parseRecord(readFileSync(join(dir, RECORD), 'utf8'));
  if (campaign === undefined) return { exitCode: 2, output: 'EVIDENCE_RECORD_INVALID' };
  const { records } = campaign;

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
  const lines: string[] = [
    ...failed.map(entry => (entry.stage === 'case' ? `case:${entry.caseId ?? 'unknown'}:${entry.outcome}` : `${entry.stage}:${entry.outcome}`) + (entry.reasonCode === undefined ? '' : `:${entry.reasonCode}`)),
    ...missingStages.map(stage => `${stage}:missing`),
    ...missingCases.map(caseId => `case:missing:${caseId}`),
    ...unlabelled.map(() => 'case:unlabelled'),
    ...duplicated.map(caseId => `case:${caseId}:duplicate`),
  ];
  if (lines.length === 0) {
    // Each case row must be backed by its own artifact, bound to this campaign; a pass label alone is never enough.
    const { bodies, broken } = resolveArtifacts(dir, campaign.caseArtifacts);
    const ctx: Context = { campaign, binding: bindingOf(campaign.bindings), artifacts: campaign.caseArtifacts, bodies };
    lines.push(
      ...recordProblems(campaign, dir),
      ...broken,
      ...(campaign.caseArtifacts.some(artifact => !(REQUIRED_CASES as readonly string[]).includes(artifact.caseId)) ? ['artifact:unexpected-case'] : []),
      ...(broken.length > 0 ? [] : REQUIRED_CASES.map(caseId => judgedCase(ctx, caseId, caseRows.find(row => row.caseId === caseId) as StageRecord)).filter((entry): entry is string => entry !== undefined)),
    );
  }
  if (lines.length === 0) return { exitCode: 0, output: `EVIDENCE_CLEAN ${caseCounts.size} case(s)` };
  const output = ['EVIDENCE_INCOMPLETE', ...lines].join('\n');
  // Decoded record text reaches this output only through ids and reason codes, which JSON escapes can
  // hide from the raw-text scan: re-scan the final output against the same needle set before echoing it.
  const profile = resolveScanProfile(options.env, options.repositoryRoot);
  if (profile.ok && needleGuard(output, profile.profile, options.env) !== undefined) return { exitCode: 2, output: 'EVIDENCE_RECORD_INVALID' };
  return { exitCode: 1, output };
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
