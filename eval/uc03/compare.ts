/**
 * UC-03 Verified Code Repair - Evaluation Comparison
 * Task: T027 (evaluation and comparison infrastructure)
 *
 * Compares two evaluation runs (baseline vs candidate), computing status
 * transitions, metrics deltas, and regression detection.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  validateEvaluationReport,
} from './validation.ts';
import type { CaseStatus, EvaluationMode } from './types.ts';

export interface CaseDelta {
  readonly caseId: string;
  readonly baselineStatus: CaseStatus | 'missing';
  readonly candidateStatus: CaseStatus | 'missing';
  readonly transition: 'stable' | 'improved' | 'regressed' | 'added' | 'removed';
  readonly durationDeltaMs: number;
  readonly tokensDelta: number;
  readonly costDeltaUsd: number;
}

export interface ComparisonSummary {
  readonly totalCommon: number;
  readonly totalAdded: number;
  readonly totalRemoved: number;
  readonly regressionsCount: number;
  readonly improvementsCount: number;
  readonly stableCount: number;
  readonly durationDeltaMs: number;
  readonly tokensDelta: number;
  readonly costDeltaUsd: number;
  readonly successRateDelta: number;
}

export interface ComparisonReport {
  readonly suite: 'uc03';
  readonly baselineDigest: string;
  readonly candidateDigest: string;
  readonly baselineMode: EvaluationMode;
  readonly candidateMode: EvaluationMode;
  readonly verdict: 'IDENTICAL' | 'IMPROVED' | 'REGRESSED' | 'INCOMPLETE';
  readonly exitCode: 0 | 1;
  readonly cases: readonly CaseDelta[];
  readonly summary: ComparisonSummary;
  readonly limitations: readonly string[];
}

export interface CompareOptions {
  readonly baselinePath: string;
  readonly candidatePath: string;
  readonly outputPath?: string | undefined;
}

export function compareEvaluations(
  baseline: unknown,
  candidate: unknown,
): ComparisonReport {
  const validBaseline = validateEvaluationReport(baseline);
  const validCandidate = validateEvaluationReport(candidate);

  if (
    validBaseline.suite !== validCandidate.suite ||
    validBaseline.contractVersion !== validCandidate.contractVersion ||
    validBaseline.mode !== validCandidate.mode ||
    validBaseline.manifestDigest !== validCandidate.manifestDigest ||
    validBaseline.configDigest !== validCandidate.configDigest ||
    validBaseline.cases.length !== validCandidate.cases.length
  ) {
    throw new Error('Incomparable evaluation reports');
  }
  for (let index = 0; index < validBaseline.cases.length; index++) {
    const baseCase = validBaseline.cases[index];
    const candidateCase = validCandidate.cases[index];
    if (
      !baseCase ||
      !candidateCase ||
      baseCase.caseId !== candidateCase.caseId ||
      baseCase.expectedOutcome !== candidateCase.expectedOutcome ||
      (baseCase.taskId !== null &&
        candidateCase.taskId !== null &&
        baseCase.taskId !== candidateCase.taskId)
    ) {
      throw new Error('Incomparable evaluation reports');
    }
  }

  const baselineCaseMap = new Map(validBaseline.cases.map((c) => [c.caseId, c]));
  const candidateCaseMap = new Map(validCandidate.cases.map((c) => [c.caseId, c]));

  const allCaseIds = Array.from(
    new Set([...baselineCaseMap.keys(), ...candidateCaseMap.keys()])
  ).sort();

  const caseDeltas: CaseDelta[] = [];
  let totalCommon = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  let regressionsCount = 0;
  let improvementsCount = 0;
  let stableCount = 0;

  for (const caseId of allCaseIds) {
    const baseCase = baselineCaseMap.get(caseId);
    const candCase = candidateCaseMap.get(caseId);

    const baselineStatus: CaseStatus | 'missing' = baseCase ? baseCase.status : 'missing';
    const candidateStatus: CaseStatus | 'missing' = candCase ? candCase.status : 'missing';

    let transition: CaseDelta['transition'] = 'stable';
    if (baselineStatus === 'missing') {
      transition = 'added';
      totalAdded++;
      if (candidateStatus === 'pass') improvementsCount++;
    } else if (candidateStatus === 'missing') {
      transition = 'removed';
      totalRemoved++;
      regressionsCount++;
    } else {
      totalCommon++;
      if (baselineStatus === 'pass' && candidateStatus !== 'pass') {
        transition = 'regressed';
        regressionsCount++;
      } else if (baselineStatus !== 'pass' && candidateStatus === 'pass') {
        transition = 'improved';
        improvementsCount++;
      } else {
        transition = 'stable';
        stableCount++;
      }
    }

    const durationDeltaMs =
      (candCase ? candCase.timing.durationMs : 0) -
      (baseCase ? baseCase.timing.durationMs : 0);
    const tokensDelta =
      (candCase ? candCase.usage.tokensConsumed : 0) -
      (baseCase ? baseCase.usage.tokensConsumed : 0);
    const costDeltaUsd =
      (candCase ? candCase.usage.costUsd : 0) -
      (baseCase ? baseCase.usage.costUsd : 0);

    caseDeltas.push({
      caseId,
      baselineStatus,
      candidateStatus,
      transition,
      durationDeltaMs,
      tokensDelta,
      costDeltaUsd,
    });
  }

  const durationDeltaMs =
    validCandidate.summary.totalDurationMs - validBaseline.summary.totalDurationMs;
  const tokensDelta =
    validCandidate.summary.totalTokensConsumed - validBaseline.summary.totalTokensConsumed;
  const costDeltaUsd =
    validCandidate.summary.totalCostUsd - validBaseline.summary.totalCostUsd;
  const successRateDelta =
    validCandidate.summary.successRate - validBaseline.summary.successRate;

  let verdict: ComparisonReport['verdict'] = 'IDENTICAL';
  let exitCode: 0 | 1 = 0;

  if (regressionsCount > 0) {
    verdict = 'REGRESSED';
    exitCode = 1;
  } else if (validCandidate.summary.requiredFailuresOrNotRun > 0) {
    verdict = 'INCOMPLETE';
    exitCode = 1;
  } else if (improvementsCount > 0) {
    verdict = 'IMPROVED';
    exitCode = 0;
  } else {
    verdict = 'IDENTICAL';
    exitCode = 0;
  }

  return {
    suite: 'uc03',
    baselineDigest: validBaseline.manifestDigest,
    candidateDigest: validCandidate.manifestDigest,
    baselineMode: validBaseline.mode,
    candidateMode: validCandidate.mode,
    verdict,
    exitCode,
    cases: caseDeltas,
    summary: {
      totalCommon,
      totalAdded,
      totalRemoved,
      regressionsCount,
      improvementsCount,
      stableCount,
      durationDeltaMs,
      tokensDelta,
      costDeltaUsd,
      successRateDelta,
    },
    limitations: [
      'Comparison summarizes recorded statuses and metrics; it does not establish workflow evidence.',
      'Reports missing any required C01-C17 case are rejected.',
    ],
  };
}

export async function runComparison(options: CompareOptions): Promise<ComparisonReport> {
  const resolvedBase = resolve(process.cwd(), options.baselinePath);
  const resolvedCand = resolve(process.cwd(), options.candidatePath);

  if (!existsSync(resolvedBase)) {
    throw new Error('Baseline report not found');
  }
  if (!existsSync(resolvedCand)) {
    throw new Error('Candidate report not found');
  }

  let baseValue: unknown;
  let candidateValue: unknown;
  try {
    baseValue = JSON.parse(readFileSync(resolvedBase, 'utf8'));
    candidateValue = JSON.parse(readFileSync(resolvedCand, 'utf8'));
  } catch {
    throw new Error('Comparison report JSON is invalid or unavailable');
  }

  const comparison = compareEvaluations(baseValue, candidateValue);

  if (options.outputPath) {
    try {
      writeFileSync(resolve(process.cwd(), options.outputPath), JSON.stringify(comparison, null, 2), 'utf8');
    } catch {
      throw new Error('Comparison report could not be written');
    }
  }

  return comparison;
}

export async function main(): Promise<void> {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        baseline: { type: 'string' },
        candidate: { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: false,
    });

    if (!values.baseline || !values.candidate) {
      console.error('Usage: node compare.js --baseline <run-a.json> --candidate <run-b.json> [--output <comparison.json>]');
      process.exitCode = 1;
      return;
    }

    const comparison = await runComparison({
      baselinePath: values.baseline,
      candidatePath: values.candidate,
      ...(values.output ? { outputPath: values.output } : {}),
    });

    console.log(`UC-03 Comparison: Verdict = ${comparison.verdict}, ExitCode = ${comparison.exitCode}`);
    console.log(
      `Summary: ${comparison.summary.totalCommon} common, ${comparison.summary.regressionsCount} regressions, ${comparison.summary.improvementsCount} improvements`
    );
    process.exitCode = comparison.exitCode;
  } catch {
    console.error('UC-03 comparison refused: invalid or incomparable report inputs.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
