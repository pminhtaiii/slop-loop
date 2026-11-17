/**
 * T028 campaign evidence checker (real-tier contract §(f) T028 row, §(h); T059).
 *
 * `checkEvidence(options)` reads one retained campaign record and two things decide it: every stage
 * predicate must be `pass` (a `fail` or `not-run` row exits nonzero), and the T057 directory scan of
 * the same evidence must be clean. The scan runs first over the whole directory — including the
 * record about to be read — so a leaked endpoint or credential byte is reported before any judgement
 * is made. Nothing here echoes a needle, a matched line or the record's raw content.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanDirectory, type ScanOptions, type ScanResult } from '../../../src/runtime/real-tier-endpoint-scan.ts';
import type { StageRecord } from './uc03-success-real-run.ts';

const RECORD = 'campaign.json';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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

/** The contract row every campaign must have recorded. */
const REQUIRED_CASES = ['C01', 'C02'] as const;

function isStageRecord(value: unknown): value is StageRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record['stage'] !== 'string' || !['assembly', 'preflight', 'conformance', 'receipt', 'recovery', 'case'].includes(record['stage'])) return false;
  if (record['outcome'] !== 'pass' && record['outcome'] !== 'fail' && record['outcome'] !== 'not-run') return false;
  if (record['caseId'] !== undefined && (typeof record['caseId'] !== 'string' || !SAFE_ID.test(record['caseId']))) return false;
  if (record['reasonCode'] !== undefined && typeof record['reasonCode'] !== 'string') return false;
  return true;
}

/** A retained record is parsed as untrusted input: an unknown shape is unusable, never a pass. */
function parseRecord(text: string): readonly StageRecord[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const records = typeof parsed === 'object' && parsed !== null ? (parsed as { records?: unknown }).records : undefined;
  return Array.isArray(records) && records.every(isStageRecord) ? (records as readonly StageRecord[]) : undefined;
}

/**
 * Judges one retained campaign directory. The scan verdict comes first and blocks a failed predicate
 * from being reported as anything but a failure.
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
  const records = parseRecord(text);
  if (records === undefined) return { exitCode: 2, output: 'EVIDENCE_RECORD_INVALID' };

  const failed = records.filter(entry => entry.stage !== 'case' && entry.outcome !== 'pass');
  const cases = new Map(records.filter(entry => entry.stage === 'case' && entry.caseId !== undefined).map(entry => [entry.caseId as string, entry]));
  const missing = REQUIRED_CASES.filter(caseId => !cases.has(caseId));
  const unpromoted = [...cases.values()].filter(entry => entry.outcome !== 'pass');
  if (failed.length > 0 || missing.length > 0 || unpromoted.length > 0) {
    const lines = [
      ...failed.map(entry => `${entry.stage}:${entry.outcome}${entry.reasonCode === undefined ? '' : `:${entry.reasonCode}`}`),
      ...missing.map(caseId => `case:missing:${caseId}`),
      ...unpromoted.map(entry => `case:${entry.caseId ?? 'unknown'}:${entry.outcome}${entry.reasonCode === undefined ? '' : `:${entry.reasonCode}`}`),
    ];
    return { exitCode: 1, output: ['EVIDENCE_INCOMPLETE', ...lines].join('\n') };
  }
  return { exitCode: 0, output: `EVIDENCE_CLEAN ${cases.size} case(s)` };
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
