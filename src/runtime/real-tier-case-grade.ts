/**
 * Independent snapshot grader resolver (real-tier contract §(f) T028; UC-03 T028).
 * Binds pinned catalog material (`criteria`, `profile`, `graderPayload`) and live `GraderCapability`,
 * failing closed with bounded unavailable reasons rather than throwing or inventing a verdict.
 */
import { readFileSync, statSync } from 'node:fs';

import type { BugTask } from '../contracts/foundation/uc03.ts';
import type { EvaluationGraderExecutor, EvaluationIsolationAuthority, WorkflowObservation } from '../../eval/uc03/types.ts';
import { lifecycleOf } from '../../eval/uc03/workflow-driver.ts';
import { deriveWorkflowEvidenceFacts, parseWorkflowFinalTree, type FinalTreeBinding, type TrustedFinalTreeSnapshotPort } from '../../eval/uc03/workflow-evidence-facts.ts';
import { createSnapshotGrader, isSnapshotGradeCurrent, type SnapshotGradeResult, type SnapshotGrader, type SnapshotPredicate } from '../../eval/uc03/workflow-grade.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';
import type { UC03GraphPortsV02 } from '../uc03/graph-types-v02.ts';
import type { UC03WorkflowResult } from '../uc03/graph-types.ts';
import { sha256Text } from '../uc01/contracts.ts';
import { isHostAdmission, registerHostAdmission } from '../../eval/uc03/grading.ts';
import type { GraderCasePins } from './real-tier-grader.ts';

import type { OperatorIo } from './real-tier-case-operator.ts';

/** The C01/C02 case predicates a pinned snapshot criterion supplies; C16/C10 are derived, never pinned. */
export const PINS: Readonly<Record<string, SnapshotPredicate>> = Object.freeze({ C01: 'repair-success', C02: 'clarification' });

/**
 * The host-measured facts a grade receipt is issued from (real-tier contract §(f) T028, T062):
 * the case's own bound identities, expected criterion, measured snapshot/evidence and the tier and
 * executor/admission that graded it. The checker compares the grade against this, never the reverse.
 */
export interface GradeReceiptBinding {
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly caseId: string;
  readonly criterionId: string;
  readonly criteriaDigest: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly evidenceDigest: string;
  readonly tier: 'real-tier' | 'controlled-tier';
  readonly executorId: string;
  readonly admissionId: string | null;
}

/** The live host capabilities the pinned catalog cannot carry. */
export interface GraderCapability {
  /** The tier this capability actually grades at; a controlled double never certifies real acceptance. */
  readonly tier: 'real-tier' | 'controlled-tier';
  readonly isolationAuthority: EvaluationIsolationAuthority;
  readonly executor: EvaluationGraderExecutor;
  /** Freezes the final worktree for grading and rechecks it afterwards. */
  readonly finalTree: TrustedFinalTreeSnapshotPort;
  /** Pins the case's task, root, grading profile and image before it is graded; a new bind makes earlier admissions stale. */
  readonly bindCase?: ((pins: GraderCasePins) => void) | undefined;
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
  /** The live repository root the run's final tree is frozen from. */
  readonly repositoryRoot: string;
  /** Whether the pinned criterion routes through a hidden check and so needs an isolation admission. */
  readonly requiresAdmission: boolean;
}

/** A bounded reason the case could not be graded; the case records it as not-run. */
export interface GradeRefusal {
  readonly refusal: 'grade-input-unavailable' | 'grade-snapshot-mismatch' | 'final-snapshot-drift' | 'grade-admission-unavailable';
}

/** A measured grade with the host facts it was issued on; the checker compares the two. */
export type GradeOutcome = Readonly<{ grade: SnapshotGradeResult; binding: GradeReceiptBinding }> | GradeRefusal | undefined;

export type RealTierCaseGrader = (assembly: RealTierAssembly, caseId: string, request: CaseGradeRequest) => Promise<GradeOutcome>;

/** What the pinned grader file must carry; the digest binds all three. */
interface PinnedGrader {
  readonly criteria: unknown;
  readonly profile: unknown;
  readonly graderPayload: unknown;
}

interface CatalogEntry {
  readonly graderPath: string;
  readonly graderDigest: string;
}

export type GraderResolution =
  | Readonly<{
      status: 'ready';
      graderDigest: string;
      hasCriterion: boolean;
      hasValidPayload: boolean;
      grade: (request: CaseGradeRequest) => Promise<GradeOutcome>;
      evidenceHost: (task: BugTask, repositoryRoot: string) => Readonly<{ grader: SnapshotGrader; finalTree: GraderCapability['finalTree'] }>;
    }>
  | Readonly<{ status: 'unavailable'; reasonCode: string; missing: readonly string[] }>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type LoadedJson = Readonly<{ status: 'ok'; value: unknown; raw: string }> | Readonly<{ status: 'unreadable' }> | Readonly<{ status: 'malformed' }>;

/**
 * Reads and parses one pinned JSON input. A missing or unreadable file and a malformed body are
 * distinct bounded outcomes (STD-W5-303); names and exception text never leave this boundary.
 */
function loadJson(path: string): LoadedJson {
  let stat;
  try {
    stat = statSync(path, { throwIfNoEntry: false });
  } catch {
    return { status: 'unreadable' };
  }
  if (stat === undefined || !stat.isFile()) return { status: 'unreadable' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { status: 'unreadable' };
  }
  try {
    return { status: 'ok', value: JSON.parse(text) as unknown, raw: text };
  } catch {
    return { status: 'malformed' };
  }
}

/** The catalog entry for one case, from the profile's own catalog path. */
function entryOf(catalogPath: string, caseId: string): Readonly<{ status: 'ok'; entry: CatalogEntry }> | Readonly<{ status: 'unavailable'; reasonCode: string; missing: readonly string[] }> {
  const loaded = loadJson(catalogPath);
  if (loaded.status === 'unreadable') return { status: 'unavailable', reasonCode: 'grader-catalog-unavailable', missing: ['catalog'] };
  if (loaded.status === 'malformed' || !isRecord(loaded.value) || !Array.isArray(loaded.value['catalog']))
    return { status: 'unavailable', reasonCode: 'grader-catalog-malformed', missing: ['catalog'] };
  const entries = loaded.value['catalog'] as readonly unknown[];
  const entry = entries.find(candidate => isRecord(candidate) && candidate['caseId'] === caseId);
  if (!isRecord(entry) || !isRecord(entry['grader'])) return { status: 'unavailable', reasonCode: 'grader-catalog-entry-missing', missing: ['catalog.grader.path', 'catalog.grader.digest'] };
  const grader = entry['grader'];
  return typeof grader['path'] === 'string' && typeof grader['digest'] === 'string'
    ? { status: 'ok', entry: { graderPath: grader['path'], graderDigest: grader['digest'] } }
    : { status: 'unavailable', reasonCode: 'grader-catalog-entry-missing', missing: ['catalog.grader.path', 'catalog.grader.digest'] };
}

/** The pinned material, digest-checked. A mismatch is a stale pin, not a gradeable file. */
function pinnedOf(entry: CatalogEntry): Readonly<{ status: 'ok'; pinned: PinnedGrader }> | Readonly<{ status: 'unavailable'; reasonCode: string; missing: readonly string[] }> {
  const loaded = loadJson(entry.graderPath);
  if (loaded.status === 'unreadable') return { status: 'unavailable', reasonCode: 'grader-file-unreadable', missing: ['catalog.grader.path'] };
  if (loaded.status === 'malformed' || !isRecord(loaded.value)) return { status: 'unavailable', reasonCode: 'grader-file-malformed', missing: ['catalog.grader'] };
  if (`sha256:${sha256Text(loaded.raw)}` !== entry.graderDigest) return { status: 'unavailable', reasonCode: 'grader-digest-mismatch', missing: ['catalog.grader.digest'] };
  return { status: 'ok', pinned: { criteria: loaded.value['criteria'], profile: loaded.value['profile'], graderPayload: loaded.value['graderPayload'] } };
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

/** The admission ids the wrapped authority actually issued, in issuance order. */
interface Admissions {
  attempts: number;
  readonly ids: string[];
}

/** Wraps the live isolation authority so `gradeCase` can bind the admission it really received. */
function observeAdmissions(authority: EvaluationIsolationAuthority): Readonly<{ authority: EvaluationIsolationAuthority; admissions: Admissions }> {
  const admissions: Admissions = { attempts: 0, ids: [] };
  const wrapped: EvaluationIsolationAuthority = {
    admit: async request => {
      admissions.attempts += 1;
      const issued: unknown = await authority.admit(request);
      const id = isRecord(issued) ? issued['admissionId'] : undefined;
      if (typeof id === 'string' && IDENTIFIER.test(id)) admissions.ids.push(id);
      // The grading module checks provenance against the authority it was handed (this wrapper), so
      // vouch only for an admission the live authority itself issued.
      if (isHostAdmission(authority, issued)) registerHostAdmission(wrapped, issued as object);
      return issued;
    },
  };
  return { authority: wrapped, admissions };
}

/**
 * Grades one case on the snapshot measured from its own run. The receipt is accepted only when it names
 * the measured snapshot and evidence digest, a hidden-check criterion received exactly one valid
 * admission, and the final tree still matches after grading. The returned binding repeats those facts.
 */
async function gradeCase(
  grader: ReturnType<typeof createSnapshotGrader>,
  capability: GraderCapability,
  admissions: Admissions,
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
  const attemptsBefore = admissions.attempts;
  const idsBefore = admissions.ids.length;
  const graded = await grader.grade(request.caseId, { observation, snapshot: facts.snapshot, evidence: facts.evidence });
  const attempted = admissions.attempts - attemptsBefore;
  const issued = admissions.ids.slice(idsBefore);
  // A criterion that routes through a hidden check needs exactly one real admission; one that does not
  // must not pretend to have one. A denied or malformed admission is a refusal, never a pass.
  if (request.requiresAdmission ? attempted !== 1 || issued.length !== 1 : attempted !== 0 || issued.length !== 0) return { refusal: 'grade-admission-unavailable' };
  if (graded.snapshot === null || graded.evidenceDigest === null || graded.criterionId === null) return { refusal: 'grade-input-unavailable' };
  // A receipt with no snapshot is the grader's own not-run (unpinned, invalid input); anything else must be this snapshot.
  if (!isSnapshotGradeCurrent(graded, facts.snapshot, facts.evidence.digest)) return { refusal: 'grade-snapshot-mismatch' };
  const rechecked = parseWorkflowFinalTree(await capability.finalTree.recheckCurrentFinalTree(binding, facts.snapshot), binding);
  if (rechecked === undefined || rechecked.snapshot.snapshotId !== facts.snapshot.snapshotId || rechecked.snapshot.digest !== facts.snapshot.digest) return { refusal: 'final-snapshot-drift' };
  return {
    grade: graded,
    binding: Object.freeze({
      taskId: binding.taskId,
      runId: binding.runId,
      workspaceId: binding.workspaceId,
      caseId: request.caseId,
      criterionId: graded.criterionId,
      criteriaDigest: graded.criteriaDigest,
      snapshotId: facts.snapshot.snapshotId,
      snapshotDigest: facts.snapshot.digest,
      evidenceDigest: graded.evidenceDigest,
      tier: capability.tier,
      executorId: capability.executor.executorId,
      admissionId: issued[0] ?? null,
    }),
  };
}

/**
 * Resolves the case's independent grader. `capability` is the operator's live isolation/executor/final
 * tree set; absent, the missing inputs are named exactly. A pinned file that cannot be read, does not
 * parse or no longer matches its digest is its own bounded unavailable reason, never a thrown error or
 * a grade. A pinned file that lacks criteria or profile names those. Nothing here invents a criterion,
 * a hidden check or a verdict.
 */
function hasGraderPayloadShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const files = value['files'];
  const argv = value['argv'];
  if (!isRecord(files) || !Array.isArray(argv) || argv.length === 0 || argv[0] === '') return false;
  return (
    Object.entries(files).every(
      ([p, body]) => p !== '' && !/[\0\\]/u.test(p) && !p.startsWith('/') && !/^[A-Za-z]:/u.test(p) && p.split('/').every(s => s !== '' && s !== '.' && s !== '..') && typeof body === 'string',
    ) && argv.every(a => typeof a === 'string' && !a.includes('\0'))
  );
}

export function resolvePinnedGrader(assembly: RealTierAssembly, caseId: string, capability: GraderCapability | undefined): GraderResolution {
  const catalog = entryOf(assembly.profile.catalog.path, caseId);
  if (catalog.status === 'unavailable') return catalog;
  const material = pinnedOf(catalog.entry);
  if (material.status === 'unavailable') return material;
  const { pinned } = material;
  const missing: string[] = [];
  if (!isRecord(pinned.criteria)) missing.push('grader.criteria');
  if (!isRecord(pinned.profile)) missing.push('grader.profile');
  // The live capabilities: no serializable pinned input can carry a function.
  if (capability === undefined) missing.push('grader.isolationAuthority', 'grader.executor', 'grader.finalTree');
  if (missing.length > 0 || capability === undefined) return { status: 'unavailable', reasonCode: capability === undefined ? 'grader-capability-unavailable' : 'grader-material-incomplete', missing };
  const observed = observeAdmissions(capability.isolationAuthority);
  let grader: SnapshotGrader;
  try {
    grader = createSnapshotGrader(
      {
        criteria: pinned.criteria,
        profile: pinned.profile,
        graderPayload: pinned.graderPayload,
        isolationAuthority: observed.authority,
        executor: capability.executor,
      },
      capability.tier,
    );
  } catch {
    return { status: 'unavailable', reasonCode: 'grader-material-incomplete', missing: ['grader.criteria', 'grader.profile'] };
  }
  const rawCriteria = (pinned.criteria as { readonly criteria?: unknown }).criteria;
  const hasCriterion = Array.isArray(rawCriteria) && rawCriteria.some(entry => isRecord(entry) && entry['caseId'] === caseId);
  const hasValidPayload = hasGraderPayloadShape(pinned.graderPayload);
  const image = { imageId: assembly.metadata.imageId, platform: assembly.profile.image.platform, user: assembly.profile.image.user };
  let tail = Promise.resolve();
  return {
    status: 'ready',
    graderDigest: catalog.entry.graderDigest,
    hasCriterion,
    hasValidPayload,
    evidenceHost: (task, repositoryRoot) => {
      capability.bindCase?.({ taskId: task.taskId, repositoryRoot, profile: pinned.profile, image });
      return { grader, finalTree: capability.finalTree };
    },
    grade: async request => {
      const prior = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => {
        release = resolve;
      });
      await prior;
      try {
        capability.bindCase?.({ taskId: request.task.taskId, repositoryRoot: request.repositoryRoot, profile: pinned.profile, image });
        return await gradeCase(grader, capability, observed.admissions, catalog.entry.graderDigest, request);
      } finally {
        release();
      }
    },
  };
}

export interface PinnedGraderOptions {
  readonly graderCapability?: GraderCapability | undefined;
  readonly operators?: OperatorIo | undefined;
}

/**
 * The pinned grader and the facts that explain it. A ready grader yields the seam with no facts; an
 * unavailable one yields no seam and the bounded reason plus the exact missing inputs, which the
 * campaign record then carries so the refusal is visible to an evidence reader (SPEC-W5-102). No
 * grade is ever invented.
 */
export function pinnedGraderOf(options: PinnedGraderOptions, assembly: RealTierAssembly): { grade: RealTierCaseGrader | undefined; facts: Readonly<Record<string, string>> } {
  // Each pinned case resolves its own criterion from the same material (C02 has its own).
  const resolutions = new Map(Object.keys(PINS).map(caseId => [caseId, resolvePinnedGrader(assembly, caseId, options.graderCapability)] as const));
  const first = resolutions.get('C01');
  if (first === undefined || first.status === 'unavailable') {
    const reason = first?.status === 'unavailable' ? first : { reasonCode: 'grader-catalog-entry-missing', missing: ['catalog.grader.path'] };
    options.operators?.write(`T054: grader unavailable (${reason.reasonCode}); missing: ${reason.missing.join(', ')}.`);
    return { grade: undefined, facts: { 'grader-status': 'unavailable', 'grader-reason': reason.reasonCode, 'grader-missing': reason.missing.join(',') } };
  }
  return {
    grade: async (_assembly, caseId, request) => {
      const resolution = resolutions.get(caseId);
      return resolution?.status === 'ready' ? resolution.grade(request) : undefined;
    },
    facts: {},
  };
}
