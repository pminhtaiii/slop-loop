/**
 * T028 operator entry and argv parsing (real-tier contract §(f) T028 row, §(h); T059, T062).
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRealTierGraderCapability } from '../../../src/runtime/real-tier-grader.ts';
import { stdioOperator } from './uc03-success-real-operator.ts';
import { SAFE_ID } from './uc03-success-real-record.ts';
import { runCampaign, type CampaignMode } from './uc03-success-real-run.ts';

const OPERATION_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const FLAGS = new Set(['--campaign', '--case', '--resume', '--evidence']);

export interface ParsedCampaignArgs {
  readonly mode: CampaignMode;
  readonly caseId?: string | undefined;
  readonly resumeRef?: string | undefined;
  readonly evidenceDir: string;
}

export function defaultEvidenceDir(now: number): string {
  return join('.agent-work', new Date(now).toISOString().slice(0, 10), 'uc03-real-tier', 'evidence', 'T054');
}

/** The operator's argv. A malformed invocation is a `refused` reason, never a default campaign. */
export function parseCampaignArgs(args: readonly string[]): ParsedCampaignArgs | { readonly refused: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] as string;
    if (!FLAGS.has(flag)) return { refused: 'arguments' };
    if (values.has(flag)) return { refused: 'arguments' };
    if (flag === '--campaign') {
      values.set(flag, '');
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) return { refused: 'arguments' };
    values.set(flag, value);
    index += 1;
  }
  const caseId = values.get('--case');
  const resumeRef = values.get('--resume');
  const mode: CampaignMode | undefined = values.has('--campaign') ? 'campaign' : resumeRef !== undefined ? 'resume' : caseId !== undefined ? 'case' : undefined;
  // Exactly one mode: a campaign with a case/resume flag is ambiguous, and so is a case with a resume ref.
  const flags = [values.has('--campaign'), caseId !== undefined, resumeRef !== undefined].filter(Boolean).length;
  if (mode === undefined || flags !== 1) return { refused: 'arguments' };
  if (mode === 'resume' && !OPERATION_REF.test(resumeRef ?? '')) return { refused: 'arguments' };
  if (mode === 'case' && !SAFE_ID.test(caseId ?? '')) return { refused: 'arguments' };
  return {
    mode,
    ...(caseId === undefined ? {} : { caseId }),
    ...(resumeRef === undefined ? {} : { resumeRef }),
    evidenceDir: values.get('--evidence') ?? defaultEvidenceDir(Date.now()),
  };
}

export async function runOperatorEntry(args: readonly string[]): Promise<number> {
  const parsed = parseCampaignArgs(args);
  if ('refused' in parsed) {
    process.stdout.write(`CAMPAIGN_REFUSED ${parsed.refused}\n`);
    process.exitCode = 2;
    return 2;
  }
  const root = process.cwd();
  const result = await runCampaign({
    ...parsed,
    env: process.env,
    repositoryRoot: root,
    operators: stdioOperator(),
    graderCapability: createRealTierGraderCapability(),
  });
  process.stdout.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
  return result.exitCode;
}

function isDirectExecution(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && resolve(invoked) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  void runOperatorEntry(process.argv.slice(2));
}
