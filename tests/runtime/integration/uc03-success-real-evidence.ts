/**
 * T028 campaign evidence checker (real-tier contract §(f) T028 row, §(h); T059).
 *
 * `checkEvidence(options)` reads one retained campaign record and two things decide it: the record is a
 * complete, internally consistent campaign (every mandatory stage, every scheduled case, no failed
 * earlier attempt hidden by a later pass) whose every predicate is `pass`, and the T057 directory scan
 * of the same evidence is clean. The scan runs first over the whole directory — including the record
 * about to be read — so a leaked endpoint or credential byte is reported before any judgement is made.
 * Nothing here echoes a needle, a matched line or the record's raw content (SPEC-W5-006, STD-W5-003/4/5).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { needleGuard, resolveScanProfile, scanDirectory, type ScanOptions, type ScanResult } from '../../../src/runtime/real-tier-endpoint-scan.ts';
import type { StageRecord } from './uc03-success-real-run.ts';

const RECORD = 'campaign.json';
const RECORD_SCHEMA = 'uc03-campaign-record/1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** The bounded reason code the checker will print; an unknown string is never echoed. */
const REASON_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface EvidenceCheckOptions {
  /** The retained evidence directory, which also holds every artifact the scan must cover. */
  readonly evidenceDir: string;
  readonly env: ScanOptions['env'];
  readonly repositoryRoot: string;
}

export interface EvidenceCheckResult {
  /** 0 clean and every predicate passed; 1 a failed/not-run predicate or a scan leak; 2 unusable input. */
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

interface CampaignRecord {
  readonly bindings: Readonly<Record<string, string>>;
  readonly records: readonly StageRecord[];
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
  const record = parsed as { schemaVersion?: unknown; bindings?: unknown; records?: unknown };
  if (record.schemaVersion !== RECORD_SCHEMA) return undefined;
  const bindings = record.bindings;
  if (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) return undefined;
  const bindingRecord = bindings as Record<string, unknown>;
  if (!BINDING_KEYS.every(key => typeof bindingRecord[key] === 'string' && (bindingRecord[key] as string).trim() !== '')) return undefined;
  const records = record.records;
  if (!Array.isArray(records) || records.length === 0 || !records.every(isStageRecord)) return undefined;
  return { bindings: bindingRecord as Readonly<Record<string, string>>, records: records as readonly StageRecord[] };
}

/**
 * Judges one retained campaign directory. The scan verdict comes first and blocks a failed predicate
 * from being reported as anything but a failure. Every original row is inspected; a later row never
 * overwrites an earlier one (STD-W5-003), and every mandatory stage and case must be present.
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
  const seenCases = new Set(records.filter(entry => entry.stage === 'case').map(entry => entry.caseId));
  const missingCases = REQUIRED_CASES.filter(caseId => !seenCases.has(caseId));
  if (failed.length > 0 || missingStages.length > 0 || missingCases.length > 0) {
    const lines = [
      ...failed.map(entry => (entry.stage === 'case' ? `case:${entry.caseId ?? 'unknown'}:${entry.outcome}` : `${entry.stage}:${entry.outcome}`) + (entry.reasonCode === undefined ? '' : `:${entry.reasonCode}`)),
      ...missingStages.map(stage => `${stage}:missing`),
      ...missingCases.map(caseId => `case:missing:${caseId}`),
    ];
    return { exitCode: 1, output: ['EVIDENCE_INCOMPLETE', ...lines].join('\n') };
  }
  return { exitCode: 0, output: `EVIDENCE_CLEAN ${new Set(records.filter(entry => entry.stage === 'case').map(entry => entry.caseId)).size} case(s)` };
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
