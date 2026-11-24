/**
 * The T028 case stage (real-tier contract §(f) T028 row; T059).
 *
 * Runs cases in schedule order (C01, C02, C16, C10). Calls the shared real-tier case execution
 * core (`executeRealTierCase` in `src/runtime/real-tier-case-run.ts`) for C01 and C02 attempts.
 * C16 is judged from C01's final report; C10 runs as a zero-dispatch transport witness.
 */
import type { RealTierAssembly, resolveRealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { HostModelPortV02 } from '../../../src/foundation/model-v02.ts';
import { bindRealTierTask } from '../../../src/runtime/real-tier-task-binding.ts';
import type { runUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import type { UC03HostInputs } from '../../../src/runtime/uc03-host-bootstrap.ts';
import type { TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { executeRealTierCase, findSettledCommandAdmission } from '../../../src/runtime/real-tier-case-run.ts';
import { PINS, type CaseGradeRequest, type GradeOutcome } from '../../../src/runtime/real-tier-case-grade.ts';
import type { DecisionTarget } from '../../../src/runtime/real-tier-case-operator.ts';

import { judgeC16Report } from './uc03-success-real-c16.ts';
import { journalViewOf, judgeC10, publishRunAuthority, runC10Witness } from './uc03-success-real-c10.ts';
import {
  C16_REPORT_SCHEMA,
  CASE_EVIDENCE_SCHEMA,
  artifactName,
  digestOf,
  serialize,
  type ArtifactBinding,
  type C10WitnessBody,
  type C16ReportBody,
  type CaseArtifactBody,
  type CaseEvidence,
  type PendingArtifact,
  type StageRecord,
} from './uc03-success-real-record.ts';

export { PINS, findSettledCommandAdmission };

/** The campaign id a standalone stage records when the operator entry did not supply one. */
const STANDALONE = 'standalone';
/** A standalone stage is bound to nothing, so the checker can never accept its artifacts. */
const UNBOUND: ArtifactBinding = Object.freeze({ candidateSha: '', profileDigest: '', endpointDigest: '', model: '' });
/** The decision-authority generation the C10 witness publishes; the seeded head carries generation 1. */
const C10_GENERATION = 2;

/** One case's outcome: the row judged, and whatever artifact it can honestly produce. */
export interface CaseOutcome {
  readonly record: StageRecord;
  readonly evidence?: CaseEvidence | undefined;
  readonly artifact?: CaseArtifactBody | undefined;
  /** The C01 run's report judgement, kept so the C16 row derives from it and the C01 row never writes C16. */
  readonly judgedReport?: ReturnType<typeof judgeC16Report> | undefined;
  /** The artifact a derived row (C16, C10) owns. */
  readonly derived?: Readonly<{ kind: 'c16'; body: C16ReportBody } | { kind: 'c10'; body: C10WitnessBody }> | undefined;
}

export interface CaseStageOptions {
  readonly caseIds: readonly string[];
  readonly repositoryRoot: string;
  readonly pins: UC03HostInputs['pins'];
  readonly identity: Readonly<Record<string, string>>;
  /** The C01/C02 snapshot grade, from the pinned catalog or profile grader material; it receives the run's own result. */
  readonly grade?: ((assembly: RealTierAssembly, caseId: string, request: CaseGradeRequest) => Promise<GradeOutcome>) | undefined;
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
  /** The pinned identities every artifact repeats; absent, the artifacts are unbound and never accepted. */
  readonly binding?: ArtifactBinding | undefined;
  /** The fetch counter of the transport the bound provider uses; without it C10 cannot disprove a dispatch. */
  readonly fetches?: (() => number) | undefined;
  /** The graph entry; the gate injects a double because no live model drives a controlled campaign. */
  readonly runGraph?: typeof runUC03GraphV02 | undefined;
}

const ownersOf = (assembly: RealTierAssembly, ids: Readonly<{ taskId: string; workspaceId: string }>, repositoryId: string) =>
  assembly.owners.taskOwners({ taskId: ids.taskId, workspaceId: ids.workspaceId, repositoryId });

/** The state a bound task is seeded in, for the C10 witness's provider admission. */
async function stateOf(assembly: RealTierAssembly, ids: Readonly<{ taskId: string; workspaceId: string }>): Promise<TaskState> {
  const state = (await ownersOf(assembly, ids, '').statePort.loadTask(ids.taskId)) as TaskState | null;
  if (state === null) throw new Error('BOUND_TASK_MISSING');
  return state;
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
  const execution = await executeRealTierCase({
    assembly,
    caseId,
    attempt,
    pins: options.pins,
    identity: options.identity,
    decideApproval: options.decideApproval,
    clarificationHold: options.clarificationHold,
    grade: options.grade,
    binding: options.binding,
    runGraph: options.runGraph,
  });

  if (execution.status !== 'task-bound') {
    return caseNotRun(caseId, execution.reasonCode ?? 'binding-failed', { attempt });
  }

  const accounting = execution.accounting ?? { claims: 0, attempts: 0, outcomes: 0 };
  const artifactBinding = options.binding ?? UNBOUND;

  if (execution.approvalRequired) {
    return {
      record: {
        stage: 'case',
        outcome: 'fail',
        reasonCode: 'approval-required',
        caseId,
        facts: { attempt, workflow: execution.result?.outcome ?? 'none', node: execution.result?.state?.node ?? 'none' },
      },
    };
  }

  const graded = execution.gradeOutcome;
  const refusal = graded !== undefined && 'refusal' in graded ? graded.refusal : undefined;
  const gradeOutcome = graded !== undefined && !('refusal' in graded) ? graded : undefined;
  const grade = gradeOutcome?.grade;
  const commandAdmission = execution.commandAdmission ?? {};
  const finalReport = execution.result?.finalReport;
  const judgedReport = caseId === 'C01' ? judgeC16Report(finalReport) : undefined;

  const evidence: CaseEvidence = {
    ...execution.evidence,
    ...(judgedReport?.facts.present ? { reportDigest: judgedReport.facts.reportDigest } : {}),
  };

  const facts: Record<string, string | number | boolean | null> = {
    attempt,
    workflow: execution.result?.outcome ?? 'none',
    node: execution.result?.state?.node ?? 'none',
    claims: accounting.claims,
    attempts: accounting.attempts,
    outcomes: accounting.outcomes,
    ...(execution.approval ? { approval: execution.approval.decided, decision: execution.approval.decisionId } : {}),
    ...(grade ? { grade: grade.grade, 'grade-reason': grade.reason, 'grader-digest': grade.criteriaDigest } : {}),
    ...(commandAdmission.commandViewDigest ? { 'command-view-digest': commandAdmission.commandViewDigest } : {}),
  };

  const artifact: CaseArtifactBody = {
    schema: CASE_EVIDENCE_SCHEMA,
    campaignId: options.campaignId ?? STANDALONE,
    caseId,
    attempt,
    binding: artifactBinding,
    finalSnapshotDigest: grade?.snapshot?.digest ?? null,
    identity: execution.identity ?? { taskId: '', runId: '', workspaceId: '' },
    evidence,
    accounting,
  };

  if (PINS[caseId] !== undefined && grade === undefined) {
    return { record: { stage: 'case', outcome: 'not-run', reasonCode: refusal ?? 'grader-unavailable', caseId, facts }, evidence, artifact, judgedReport };
  }

  const outcome: StageRecord['outcome'] = PINS[caseId] === undefined ? 'not-run' : grade?.grade === 'pass' ? 'pass' : grade?.grade === 'fail' ? 'fail' : 'not-run';
  const record: StageRecord = { stage: 'case', outcome, ...(PINS[caseId] === undefined ? { reasonCode: 'unpinned' } : {}), caseId, facts };
  return { record, evidence, artifact, judgedReport };
}

/** C16: the safe report from the C01 run, judged on its own content and never on the repair verdict. */
function c16Outcome(options: CaseStageOptions, c01: CaseOutcome | undefined): CaseOutcome {
  const source = c01?.artifact;
  const judged = c01?.judgedReport;
  if (source === undefined || judged === undefined) return caseNotRun('C16', 'c16-report-unavailable', { derivedFrom: 'C01' });
  const body: C16ReportBody = Object.freeze({
    schema: C16_REPORT_SCHEMA,
    campaignId: options.campaignId ?? STANDALONE,
    caseId: 'C16' as const,
    attempt: source.attempt,
    binding: options.binding ?? UNBOUND,
    finalSnapshotDigest: source.finalSnapshotDigest,
    derivedFrom: 'C01' as const,
    sourceArtifact: artifactName('C01', source.attempt, 'evidence'),
    sourceDigest: digestOf(serialize(source)),
    verdict: judged.ok ? ('pass' as const) : ('fail' as const),
    ...(judged.reasonCode === undefined ? {} : { reasonCode: judged.reasonCode }),
    report: judged.facts,
  });
  return {
    record: {
      stage: 'case',
      outcome: body.verdict,
      ...(body.reasonCode === undefined ? {} : { reasonCode: body.reasonCode }),
      caseId: 'C16',
      facts: { derivedFrom: 'C01', 'report-digest': judged.facts.reportDigest },
    },
    derived: { kind: 'c16', body },
  };
}

/**
 * C10: one allowed bound provider request that settles observed usage, then one whose maxima exceed
 * the per-run token limit, so the transport's run limiter refuses before `fetch` (SPEC-W5-104). It
 * runs on its own fresh host; the witness publishes the run authority its claims bind to through the
 * owner's own control path, and the verdict is `judgeC10`, the same predicate the checker applies.
 */
async function runC10(assembly: RealTierAssembly, options: CaseStageOptions): Promise<CaseOutcome> {
  const fetches = options.fetches;
  if (fetches === undefined) return caseNotRun('C10', 'c10-fetch-counter-unavailable', { attempt: 1 });
  const binding = await bindRealTierTask(assembly, { caseId: 'C01', pins: options.pins, identity: options.identity });
  if (binding.status !== 'task-bound') return caseNotRun('C10', binding.reasonCode, { attempt: 1 });
  const port = binding.ports.modelPort;
  if (!(port instanceof HostModelPortV02)) return caseNotRun('C10', 'c10-transport-unobservable', { attempt: 1 });
  // The over-limit request reserves more than the whole per-run input budget from the task's own token
  // ledger first; a smaller ledger would refuse it as a budget claim, never reaching the limiter.
  // Headroom must cover both the preceding allowed call's reservation (ALLOWED = 32,768) and the
  // oversized call's reservation (perRunInputTokens + 2).
  const requiredHeadroom = 32_768 + assembly.profile.runLimits.perRunInputTokens + 2;
  if (binding.task.budgetLimits.maxTokens < requiredHeadroom) return caseNotRun('C10', 'c10-task-budget-below-run-limit', { attempt: 1 });
  const owner = ownersOf(assembly, binding.ids, binding.task.repositoryId).statePort;
  // A pre-plan provider admission is only legal at Investigate, so the witness moves the fresh task
  // there first, exactly as the operator's own first coder call will. The owner refuses a bad
  // transition by throwing; that is translated to a bounded not-run, never a crash mid-campaign.
  const seeded = await stateOf(assembly, binding.ids);
  try {
    await owner.transition({ ...seeded, node: 'Investigate', nextAction: 'propose-fix-plan', stateVersion: seeded.stateVersion + 1 }, seeded.stateVersion);
  } catch {
    return caseNotRun('C10', 'c10-investigate-transition-refused', { attempt: 1 });
  }
  if (!(await publishRunAuthority(owner as unknown as { publishAuthority(input: unknown): Promise<unknown> }, binding.task, C10_GENERATION)))
    return caseNotRun('C10', 'c10-authority-unavailable', { attempt: 1 });
  const body = await runC10Witness({
    port,
    transport: port.options.transport,
    fetches,
    journal: () => journalViewOf(owner.getJournalSnapshot(binding.ids.taskId)),
    control: () => {
      const head = owner.getJournalSnapshot(binding.ids.taskId) as { readonly controlVersion?: number; readonly epoch?: number };
      return { controlVersion: head.controlVersion ?? 1, epoch: head.epoch ?? 1 };
    },
    task: binding.task,
    state: () => stateOf(assembly, binding.ids),
    identity: { taskId: binding.ids.taskId, runId: binding.ids.runId, workspaceId: binding.ids.workspaceId },
    campaignId: options.campaignId ?? STANDALONE,
    binding: options.binding ?? UNBOUND,
    ceiling: {
      totalModelCalls: assembly.profile.limits.totalModelCalls,
      perRunInputTokens: assembly.profile.runLimits.perRunInputTokens,
      perRunOutputTokens: assembly.profile.runLimits.perRunOutputTokens,
    },
    generation: C10_GENERATION,
    commandViewDigest: null,
  });
  const reason = judgeC10(body);
  const { allowed, refused } = body.calls;
  const record: StageRecord = {
    stage: 'case',
    outcome: reason === undefined ? 'pass' : 'fail',
    ...(reason === undefined ? {} : { reasonCode: reason }),
    caseId: 'C10',
    facts: {
      attempt: 1,
      'allowed-fetches': allowed.fetchesAfter - allowed.fetchesBefore,
      'refused-fetches': refused.fetchesAfter - refused.fetchesBefore,
      'refusal-reason': refused.transport?.reasonCode ?? null,
    },
  };
  return { record, derived: { kind: 'c10', body } };
}

/**
 * The operator case stage: one fresh host assembly per ordinary case, plus the derived C16 report
 * from C01 and the C10 witness on its own host, in schedule order. A derived row this stage cannot
 * judge stays `not-run`, so the campaign is honest-incomplete.
 */
export async function runCaseStage(assemble: (caseId?: string) => ReturnType<typeof resolveRealTierAssembly>, options: CaseStageOptions): Promise<readonly CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];
  let c01: CaseOutcome | undefined;
  for (const caseId of options.caseIds) {
    if (caseId === 'C16') {
      // The C16 row follows its report's own verdict, never the C01 repair grade (SPEC-W5-103).
      outcomes.push(c16Outcome(options, c01));
      continue;
    }
    const assembled = assemble(caseId);
    if (assembled.status !== 'assembly-ready') {
      outcomes.push(caseNotRun(caseId, assembled.reasonCode, { attempt: 1 }));
      continue;
    }
    outcomes.push(caseId === 'C10' ? await runC10(assembled, options) : await runCaseAttempt(assembled, caseId, 1, options));
    if (caseId === 'C01') c01 = outcomes.at(-1);
  }
  return outcomes;
}

/** The artifacts a set of outcomes writes, in row order: the tuple is the unit and C16 has one owner. */
export function artifactsOf(outcomes: readonly CaseOutcome[]): readonly PendingArtifact[] {
  const artifacts: PendingArtifact[] = [];
  for (const outcome of outcomes) {
    const caseId = outcome.record.caseId;
    if (caseId === undefined) continue;
    if (outcome.artifact) artifacts.push([caseId, outcome.artifact.attempt, 'evidence', outcome.artifact]);
    if (outcome.derived?.kind === 'c16') artifacts.push(['C16', outcome.derived.body.attempt, 'c16', outcome.derived.body]);
    if (outcome.derived?.kind === 'c10') artifacts.push(['C10', 1, 'c10', outcome.derived.body]);
  }
  return artifacts;
}
