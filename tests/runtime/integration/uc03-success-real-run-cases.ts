/**
 * The T028 case stage (real-tier contract §(f) T028 row; T059).
 *
 * One fresh host per case, bound through `bindRealTierTask`, driven by `runUC03GraphV02`. C01's plan
 * pause is presented and decided explicitly through the injected T046 decision source — never
 * automatically — and only an approval continues the same bound task. C16 is judged from the C01
 * run's own final report (`uc03-success-real-c16.ts`), never inferred from the repair verdict; C10
 * is a dedicated zero-dispatch witness on its own fresh host (`uc03-success-real-c10.ts`).
 *
 * The operator entry wires the real decision source and the real grader; the gate drives the same
 * seams with doubles, so nothing here reaches Docker, the network or a live endpoint.
 */
import type { RealTierAssembly, resolveRealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { bindRealTierTask, type RealTierBoundTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { runUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import type { SnapshotGradeResult, SnapshotPredicate } from '../../../eval/uc03/workflow-grade.ts';
import type { UC03HostInputs } from '../../../src/runtime/uc03-host-bootstrap.ts';
import type { TaskState } from '../../../src/contracts/foundation/uc03.ts';
import type { FinalReport } from '../../../src/uc03/report.ts';

import { judgeC16Report } from './uc03-success-real-c16.ts';
import { allowedProviderResponse, runC10Witness } from './uc03-success-real-c10.ts';
import type { DecisionTarget } from './uc03-success-real-operator.ts';
import {
  C16_REPORT_SCHEMA,
  CASE_EVIDENCE_SCHEMA,
  type CaseArtifactBody,
  type CaseEvidence,
  type CaseKind,
  type PendingArtifact,
  type StageRecord,
} from './uc03-success-real-record.ts';

/** The C01/C02 case predicates a pinned snapshot criterion supplies; C16/C10 are derived, never pinned. */
const PINS: Readonly<Record<string, SnapshotPredicate>> = Object.freeze({ C01: 'repair-success', C02: 'clarification' });
/** The campaign id a standalone stage records when the operator entry did not supply one. */
const STANDALONE = 'standalone';

/** One case's outcome: the row judged, and whatever artifact it can honestly produce. */
export interface CaseOutcome {
  readonly record: StageRecord;
  readonly evidence?: CaseEvidence | undefined;
  readonly artifact?: CaseArtifactBody | undefined;
  readonly derived?: Readonly<{ kind: CaseKind; body: unknown }> | undefined;
}

export interface CaseStageOptions {
  readonly caseIds: readonly string[];
  readonly repositoryRoot: string;
  readonly pins: UC03HostInputs['pins'];
  readonly identity: Readonly<Record<string, string>>;
  /** The C01/C02 snapshot grade, from the pinned catalog or profile grader material. */
  readonly grade?: ((assembly: RealTierAssembly, caseId: string) => Promise<SnapshotGradeResult | undefined>) | undefined;
  /**
   * The explicit T046 decision source: it presents the pause through the bound task's own console
   * port and returns the operator's choice, or `undefined` when none was made. It never approves on
   * its own (SPEC-W5-101).
   */
  readonly decideApproval?: ((caseId: string, target: DecisionTarget) => Promise<'approve' | 'reject' | undefined>) | undefined;
  /** A task held for an expected clarification pause stays terminal (C02). */
  readonly clarificationHold?: ((caseId: string) => boolean) | undefined;
  /** The campaign id every artifact is bound to; a standalone stage records `standalone`. */
  readonly campaignId?: string | undefined;
  /** The C10 witness's own fetch counter; the operator entry passes its live one. */
  readonly fetches?: (() => number) | undefined;
}

/** The journal facts one case artifact records, read from the owner, never inferred. */
function accountingOf(assembly: RealTierAssembly, ids: Readonly<{ taskId: string }>): Readonly<{ claims: number; attempts: number; outcomes: number }> {
  const journal = assembly.owners.taskOwners({ taskId: ids.taskId, workspaceId: '', repositoryId: '' }).statePort.getJournalSnapshot(ids.taskId) as {
    readonly claims?: readonly unknown[];
    readonly attempts?: readonly unknown[];
    readonly outcomes?: readonly unknown[];
  };
  return Object.freeze({ claims: journal.claims?.length ?? 0, attempts: journal.attempts?.length ?? 0, outcomes: journal.outcomes?.length ?? 0 });
}

/** The state a bound task is seeded in, for the C10 witness's provider admission. */
async function stateOf(assembly: RealTierAssembly, ids: Readonly<{ taskId: string; workspaceId: string }>): Promise<TaskState> {
  const state = (await assembly.owners.taskOwners({ taskId: ids.taskId, workspaceId: ids.workspaceId, repositoryId: '' }).statePort.loadTask(ids.taskId)) as TaskState | null;
  if (state === null) throw new Error('BOUND_TASK_MISSING');
  return state;
}

/** The control head the C10 witness's two claims bind to, re-read from the owner before each claim. */
function controlOf(assembly: RealTierAssembly, taskId: string): Readonly<{ controlVersion: number; epoch: number }> {
  const journal = assembly.owners.taskOwners({ taskId, workspaceId: '', repositoryId: '' }).statePort.getJournalSnapshot(taskId) as { readonly controlVersion?: number; readonly epoch?: number };
  return { controlVersion: journal.controlVersion ?? 1, epoch: journal.epoch ?? 1 };
}

const caseNotRun = (caseId: string, reasonCode: string, facts: StageRecord['facts'] = {}): CaseOutcome => ({
  record: { stage: 'case', outcome: 'not-run', reasonCode, caseId, facts },
});

/**
 * One case attempt on its own fresh assembly. C01's plan pause is presented and decided explicitly
 * through the injected T046 decision source before the same bound task continues; C02's expected
 * clarification pause stays terminal. The outcome is judged by the pinned snapshot grader
 * (SPEC-W5-003), never by the workflow status string alone.
 */
async function runCaseAttempt(assembly: RealTierAssembly, caseId: string, attempt: number, options: CaseStageOptions): Promise<CaseOutcome> {
  const binding = await bindRealTierTask(assembly, { caseId, pins: options.pins, identity: options.identity });
  if (binding.status !== 'task-bound') return caseNotRun(caseId, binding.reasonCode, { attempt });
  return attemptOnBound(assembly, binding, caseId, attempt, options);
}

async function attemptOnBound(assembly: RealTierAssembly, binding: RealTierBoundTask, caseId: string, attempt: number, options: CaseStageOptions): Promise<CaseOutcome> {
  let result = await runUC03GraphV02(binding.task, binding.ports, binding.config);
  let approval: CaseEvidence['approval'];
  if (result.outcome === 'pending-approval' && !options.clarificationHold?.(caseId)) {
    // Nothing approves automatically: an absent source leaves the pause recorded, not passed.
    const decision = await options.decideApproval?.(caseId, { taskId: binding.ids.taskId, console: assembly.owners.taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId }).console });
    if (decision === undefined) return { record: { stage: 'case', outcome: 'fail', reasonCode: 'approval-required', caseId, facts: { attempt, workflow: result.outcome, node: result.state?.node ?? 'none' } } };
    approval = { decisionId: result.state?.activeDecisionId ?? '', decided: decision };
    // A rejection ends the case on its own hold; only approval continues the bound task.
    if (decision === 'approve') result = await runUC03GraphV02(binding.task, binding.ports, binding.config, result.state ?? undefined);
  }
  const accounting = accountingOf(assembly, binding.ids);
  const grade = PINS[caseId] === undefined ? undefined : await options.grade?.(assembly, caseId);
  const finalReport = result.finalReport;
  const evidence: CaseEvidence = {
    ...(grade?.snapshot ? { snapshot: grade.snapshot } : {}),
    ...(grade?.evidenceDigest ? { evidenceDigest: grade.evidenceDigest } : {}),
    ...(grade ? { grade } : {}),
    ...(approval ? { approval } : {}),
    ...(finalReport ? { diffDigest: finalReport.diff.diffDigest } : {}),
    ...(finalReport ? { usage: { tokens: finalReport.usage.tokensConsumed, cost: finalReport.usage.costUsd } } : {}),
    ownerRevisions: { repository: result.state?.repositoryRevisionDigest ?? binding.task.initialRevisionDigest },
  };
  const facts: Record<string, string | number | boolean | null> = {
    attempt,
    workflow: result.outcome,
    node: result.state?.node ?? 'none',
    claims: accounting.claims,
    attempts: accounting.attempts,
    outcomes: accounting.outcomes,
    ...(approval ? { approval: approval.decided, decision: approval.decisionId } : {}),
    ...(grade ? { grade: grade.grade, 'grade-reason': grade.reason, 'grader-digest': grade.criteriaDigest } : {}),
  };
  const artifact: CaseArtifactBody = {
    schema: CASE_EVIDENCE_SCHEMA,
    campaignId: options.campaignId ?? STANDALONE,
    caseId,
    attempt,
    identity: { taskId: binding.ids.taskId, runId: binding.ids.runId, workspaceId: binding.ids.workspaceId },
    evidence,
    accounting,
  };
  // A pinned predicate is the independent grade, never the status string; an unpinned id is not-run.
  if (PINS[caseId] !== undefined && grade === undefined) return { record: { stage: 'case', outcome: 'not-run', reasonCode: 'grader-unavailable', caseId, facts }, evidence, artifact };
  const outcome: StageRecord['outcome'] = PINS[caseId] === undefined ? 'not-run' : grade?.grade === 'pass' ? 'pass' : grade?.grade === 'fail' ? 'fail' : 'not-run';
  const record: StageRecord = { stage: 'case', outcome, ...(PINS[caseId] === undefined ? { reasonCode: 'unpinned' } : {}), caseId, facts };
  // C16 is judged from this run's own final report, on its content (SPEC-W5-103).
  const derived = caseId === 'C01' ? c16From(options, finalReport) : undefined;
  return { record, evidence, artifact, ...(derived ? { derived } : {}) };
}

/** C16: the safe report from the C01 run, judged on its own content and never on the repair verdict. */
function c16From(options: CaseStageOptions, report: FinalReport | undefined): NonNullable<CaseOutcome['derived']> {
  const judged = judgeC16Report(report);
  return {
    kind: 'c16',
    body: Object.freeze({
      schema: C16_REPORT_SCHEMA,
      campaignId: options.campaignId ?? STANDALONE,
      caseId: 'C16',
      attempt: 1,
      derivedFrom: 'C01',
      sourceArtifact: 'evidence-C01-1.json',
      verdict: judged.ok ? ('pass' as const) : ('fail' as const),
      ...(judged.reasonCode === undefined ? {} : { reasonCode: judged.reasonCode }),
      report: judged.facts,
    }),
  };
}

/**
 * C10: one bound provider request whose maxima exceed the run ceiling, so the transport's run
 * limiter refuses before `fetch` (SPEC-W5-104). It runs on its own fresh host, after one allowed
 * call settles observed usage, so the durable reservation and settlement are the run's own facts.
 */
async function runC10(assembly: RealTierAssembly, options: CaseStageOptions): Promise<CaseOutcome> {
  const binding = await bindRealTierTask(assembly, { caseId: 'C01', pins: options.pins, identity: options.identity });
  if (binding.status !== 'task-bound') return caseNotRun('C10', binding.reasonCode, { attempt: 1 });
  // A pre-plan provider admission is only legal at Investigate, so the witness moves the fresh task
  // there first, exactly as the operator's own first coder call will. The owner refuses a bad
  // transition by throwing; that is translated to a bounded not-run, never a crash mid-campaign.
  const seeded = await stateOf(assembly, binding.ids);
  try {
    await assembly.owners
      .taskOwners({ taskId: binding.ids.taskId, workspaceId: binding.ids.workspaceId, repositoryId: binding.task.repositoryId })
      .statePort.transition({ ...seeded, node: 'Investigate', nextAction: 'propose-fix-plan', stateVersion: seeded.stateVersion + 1 }, seeded.stateVersion);
  } catch {
    return caseNotRun('C10', 'c10-investigate-transition-refused', { attempt: 1 });
  }
  const body = await runC10Witness({
    port: binding.ports.modelPort,
    fetches: options.fetches ?? (() => 0),
    journal: () => accountingOf(assembly, binding.ids),
    control: () => controlOf(assembly, binding.ids.taskId),
    task: binding.task,
    state: () => stateOf(assembly, binding.ids),
    identity: { taskId: binding.ids.taskId, runId: binding.ids.runId, workspaceId: binding.ids.workspaceId },
    ceiling: { totalModelCalls: assembly.profile.limits.totalModelCalls, perRunInputTokens: assembly.profile.runLimits.perRunInputTokens, perRunOutputTokens: assembly.profile.runLimits.perRunOutputTokens },
    generation: 1,
    commandViewDigest: null,
  });
  // One refusal, one dispatched allowed call, and a durable reservation: the port reports a limiter
  // refusal as a pending provider outcome, so the zero-dispatch fact is the fetch count.
  const dispatched = body.dispatch.fetchesAfter - body.dispatch.fetchesBefore;
  const passed = body.dispatch.refusals === 1 && dispatched >= 1 && dispatched <= body.limits.totalModelCalls && body.journal.claimsAfter > body.journal.claimsBefore;
  const record: StageRecord = {
    stage: 'case',
    outcome: passed ? 'pass' : 'fail',
    ...(passed ? {} : { reasonCode: 'c10-witness-failed' }),
    caseId: 'C10',
    facts: { attempt: 1, refusals: body.dispatch.refusals, fetches: body.dispatch.fetchesAfter - body.dispatch.fetchesBefore, reason: body.dispatch.reason },
  };
  return { record, derived: { kind: 'c10', body: Object.freeze({ ...body, campaignId: options.campaignId ?? STANDALONE }) } };
}

/**
 * The operator case stage: one fresh host assembly per ordinary case, plus the derived C16 report
 * from C01 and the C10 witness on its own host. A derived row this stage cannot judge stays
 * `not-run`, so the campaign is honest-incomplete.
 */
export async function runCaseStage(assemble: () => ReturnType<typeof resolveRealTierAssembly>, options: CaseStageOptions): Promise<readonly CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];
  let c01: CaseOutcome | undefined;
  let c10: CaseOutcome | undefined;
  // C10 owns a fresh host and depends on no other case, so it runs whenever it is scheduled.
  if (options.caseIds.includes('C10')) {
    const fresh = assemble();
    c10 = fresh.status === 'assembly-ready' ? await runC10(fresh, options) : caseNotRun('C10', fresh.reasonCode, { attempt: 1 });
  }
  for (const caseId of options.caseIds) {
    if (caseId === 'C16' || caseId === 'C10') continue;
    const assembled = assemble();
    outcomes.push(assembled.status === 'assembly-ready' ? await runCaseAttempt(assembled, caseId, 1, options) : caseNotRun(caseId, assembled.reasonCode, { attempt: 1 }));
    if (caseId === 'C01') c01 = outcomes.at(-1);
  }
  for (const caseId of options.caseIds) {
    if (caseId === 'C16') {
      // The C16 row follows its report's own verdict, never the C01 repair grade (SPEC-W5-103).
      const c16 = c01?.derived?.kind === 'c16' ? (c01.derived.body as { verdict: 'pass' | 'fail'; reasonCode?: string; report: { reportDigest: string } }) : undefined;
      outcomes.push(
        c16 === undefined
          ? caseNotRun('C16', 'c16-report-unavailable', { derivedFrom: 'C01' })
          : {
              record: { stage: 'case', outcome: c16.verdict, ...(c16.reasonCode === undefined ? {} : { reasonCode: c16.reasonCode }), caseId: 'C16', facts: { derivedFrom: 'C01', 'report-digest': c16.report.reportDigest } },
              derived: c01?.derived as NonNullable<CaseOutcome['derived']>,
            },
      );
    }
    if (caseId === 'C10') outcomes.push(c10 ?? caseNotRun('C10', 'c10-not-observed', {}));
  }
  return outcomes;
}

/** The artifacts a set of outcomes writes, in row order: the tuple is the unit (SPEC-W5-105). */
export function artifactsOf(outcomes: readonly CaseOutcome[]): readonly PendingArtifact[] {
  const artifacts: PendingArtifact[] = [];
  for (const outcome of outcomes) {
    const caseId = outcome.record.caseId;
    if (caseId === undefined) continue;
    if (outcome.artifact) artifacts.push([caseId, outcome.artifact.attempt, 'evidence', outcome.artifact]);
    if (outcome.derived?.kind === 'c16') artifacts.push(['C16', 1, 'c16', outcome.derived.body]);
    if (outcome.derived?.kind === 'c10') artifacts.push(['C10', 1, 'c10', outcome.derived.body]);
  }
  return artifacts;
}

export { allowedProviderResponse };
