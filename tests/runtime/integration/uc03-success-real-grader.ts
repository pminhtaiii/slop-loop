/**
 * The independent snapshot grader for the T028 campaign (real-tier contract §(f) T028; UC-03 T028).
 *
 * `createSnapshotGrader` needs five host-held inputs. Three are pinned material the operator's catalog
 * already carries: the criterion set, the grading profile and the grader payload, read from the
 * entry's digest-checked `grader.path`. Two are live host capabilities no serializable pinned input
 * can supply: the isolation authority that admits a hidden check, and the executor that runs it. A
 * third host port freezes and rechecks the final tree. Those arrive through `GraderCapability` from
 * the operator entry; the gate supplies doubles.
 *
 * A ready grader is called with the case's real inputs: the observation built from the graph result,
 * the measured final snapshot and the evidence derived from the same run (SPEC-W5-202). The receipt
 * must name that snapshot and evidence digest, and the final tree must be unchanged after grading.
 *
 * When a required input is absent this returns an unavailable resolution with a bounded reason, so
 * the case stays `grader-unavailable` (not-run). It never constructs a grader over a mock isolation
 * authority and never returns a verdict of its own.
 */
import { readFileSync } from 'node:fs';

import type { BugTask } from '../../../src/contracts/foundation/uc03.ts';
import type { EvaluationGraderExecutor, EvaluationIsolationAuthority, WorkflowObservation } from '../../../eval/uc03/types.ts';
import { lifecycleOf } from '../../../eval/uc03/workflow-driver.ts';
import { deriveWorkflowEvidenceFacts, parseWorkflowFinalTree, type FinalTreeBinding, type TrustedFinalTreeSnapshotPort } from '../../../eval/uc03/workflow-evidence-facts.ts';
import { createSnapshotGrader, isSnapshotGradeCurrent, type SnapshotGradeResult } from '../../../eval/uc03/workflow-grade.ts';
import type { RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import type { UC03GraphPortsV02 } from '../../../src/uc03/graph-types-v02.ts';
import type { UC03WorkflowResult } from '../../../src/uc03/graph-types.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';

/** The live host capabilities the pinned catalog cannot carry. */
export interface GraderCapability {
  readonly isolationAuthority: EvaluationIsolationAuthority;
  readonly executor: EvaluationGraderExecutor;
  /** Freezes the final worktree for grading and rechecks it afterwards. */
  readonly finalTree: TrustedFinalTreeSnapshotPort;
  /** Evidence derivation; the real one by default. The gate injects a double. */
  readonly deriveFacts?: typeof deriveWorkflowEvidenceFacts | undefined;
}

/** What a case hands the grader: the run's own result and the ports that measured it. */
export interface CaseGradeRequest {
  readonly caseId: string;
  readonly task: BugTask;
  readonly result: UC03WorkflowResult;
  readonly ports: Pick<UC03GraphPortsV02, 'repositoryPort' | 'statePort'>;
  /** The conformed model identity; the observation names it only in the grader's identifier shape. */
  readonly model: string;
}

/** A bounded reason the case could not be graded; the case records it as not-run. */
export interface GradeRefusal {
  readonly refusal: 'grade-input-unavailable' | 'grade-snapshot-mismatch' | 'final-snapshot-drift';
}

export type GradeOutcome = SnapshotGradeResult | GradeRefusal | undefined;

/** What the pinned grader file must carry; the digest binds all three. */
interface PinnedGrader {
  readonly criteria: unknown;
  readonly profile: unknown;
  readonly graderPayload: unknown;
}

export type GraderResolution =
  | Readonly<{ status: 'ready'; grade: (request: CaseGradeRequest) => Promise<GradeOutcome> }>
  | Readonly<{ status: 'unavailable'; reasonCode: string; missing: readonly string[] }>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The catalog entry for one case, from the profile's own catalog path. */
function entryOf(catalogPath: string, caseId: string): Readonly<{ graderPath: string; graderDigest: string }> | undefined {
  const parsed: unknown = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const entries = isRecord(parsed) && Array.isArray(parsed['catalog']) ? parsed['catalog'] : [];
  const entry = entries.find(candidate => isRecord(candidate) && candidate['caseId'] === caseId);
  if (!isRecord(entry) || !isRecord(entry['grader'])) return undefined;
  const grader = entry['grader'];
  return typeof grader['path'] === 'string' && typeof grader['digest'] === 'string' ? { graderPath: grader['path'], graderDigest: grader['digest'] } : undefined;
}

/** The pinned material, digest-checked. A mismatch is a stale pin, not a gradeable file. */
function pinnedOf(entry: Readonly<{ graderPath: string; graderDigest: string }>): PinnedGrader | undefined {
  const text = readFileSync(entry.graderPath, 'utf8');
  if (`sha256:${sha256Text(text)}` !== entry.graderDigest) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) return undefined;
  return { criteria: parsed['criteria'], profile: parsed['profile'], graderPayload: parsed['graderPayload'] };
}

/** The observation the grader judges, built from the run's own result; absent facts are explicit nulls. */
function observationOf(request: CaseGradeRequest, graderDigest: string, expectedWait: WorkflowObservation['expectedWait']): WorkflowObservation {
  const { result, task } = request;
  const state = result.state;
  const report = result.finalReport;
  return {
    repositoryId: state?.repositoryId ?? task.repositoryId,
    taskId: state?.taskId ?? null,
    runId: state?.runId ?? null,
    returnedModel: IDENTIFIER.test(request.model) ? request.model : null,
    graderDigest,
    initialRepositoryDigest: task.initialRevisionDigest,
    workflowOutcome: lifecycleOf(result.outcome),
    expectedWait,
    blocked: null,
    effects: state === null ? 'uncertain' : 'observed',
    usage: report?.usage !== undefined ? 'observed' : state !== null ? 'uncertain' : 'unavailable',
    diagnostic: null,
    artifacts: [],
    limitations: report === undefined ? ['No authoritative final report was produced.'] : [],
  };
}

function finalBinding(request: CaseGradeRequest): FinalTreeBinding | undefined {
  const state = request.result.executionEvidence?.finalState;
  return state === null || state === undefined
    ? undefined
    : {
        taskId: state.taskId,
        runId: state.runId,
        workspaceId: state.workspaceId,
        repositoryId: state.repositoryId,
        initialRevisionDigest: request.task.initialRevisionDigest,
        finalRevisionDigest: state.repositoryRevisionDigest,
      };
}

/**
 * Grades one case on the snapshot measured from its own run. The receipt is accepted only when it names
 * the measured snapshot and evidence digest, and the final tree must still match after grading.
 */
async function gradeCase(
  grader: ReturnType<typeof createSnapshotGrader>,
  capability: GraderCapability,
  graderDigest: string,
  request: CaseGradeRequest,
): Promise<GradeOutcome> {
  const observation = observationOf(request, graderDigest, request.caseId === 'C02' ? 'waiting-info' : null);
  const derive = capability.deriveFacts ?? deriveWorkflowEvidenceFacts;
  const facts = await derive({
    caseId: request.caseId,
    task: request.task,
    result: request.result,
    observation,
    repository: request.ports.repositoryPort,
    statePort: request.ports.statePort,
    finalTree: capability.finalTree,
  });
  const binding = finalBinding(request);
  if (facts === undefined || binding === undefined) return { refusal: 'grade-input-unavailable' };
  const graded = await grader.grade(request.caseId, { observation, snapshot: facts.snapshot, evidence: facts.evidence });
  // A receipt with no snapshot is the grader's own not-run (unpinned, invalid input); anything else must be this snapshot.
  if (graded.snapshot !== null && !isSnapshotGradeCurrent(graded, facts.snapshot, facts.evidence.digest)) return { refusal: 'grade-snapshot-mismatch' };
  const rechecked = parseWorkflowFinalTree(await capability.finalTree.recheckCurrentFinalTree(binding, facts.snapshot), binding);
  if (rechecked === undefined || rechecked.snapshot.snapshotId !== facts.snapshot.snapshotId || rechecked.snapshot.digest !== facts.snapshot.digest) return { refusal: 'final-snapshot-drift' };
  return graded;
}

/**
 * Resolves the case's independent grader. `capability` is the operator's live isolation/executor/final
 * tree set; absent, the missing inputs are named exactly. A pinned file that lacks criteria or profile
 * names those. Nothing here invents a criterion, a hidden check or a verdict.
 */
export function resolvePinnedGrader(assembly: RealTierAssembly, caseId: string, capability: GraderCapability | undefined): GraderResolution {
  const entry = entryOf(assembly.profile.catalog.path, caseId);
  if (entry === undefined) return { status: 'unavailable', reasonCode: 'grader-catalog-entry-missing', missing: ['catalog.grader.path', 'catalog.grader.digest'] };
  const pinned = pinnedOf(entry);
  if (pinned === undefined) return { status: 'unavailable', reasonCode: 'grader-digest-mismatch', missing: ['catalog.grader.digest'] };
  const missing: string[] = [];
  if (!isRecord(pinned.criteria)) missing.push('grader.criteria');
  if (!isRecord(pinned.profile)) missing.push('grader.profile');
  // The live capabilities: no serializable pinned input can carry a function.
  if (capability === undefined) missing.push('grader.isolationAuthority', 'grader.executor', 'grader.finalTree');
  if (missing.length > 0 || capability === undefined) return { status: 'unavailable', reasonCode: capability === undefined ? 'grader-capability-unavailable' : 'grader-material-incomplete', missing };
  const grader = createSnapshotGrader({ criteria: pinned.criteria, profile: pinned.profile, graderPayload: pinned.graderPayload, isolationAuthority: capability.isolationAuthority, executor: capability.executor });
  return { status: 'ready', grade: request => gradeCase(grader, capability, entry.graderDigest, request) };
}
