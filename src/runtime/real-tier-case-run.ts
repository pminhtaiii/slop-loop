/**
 * The real-tier case execution core (real-tier contract §(f) T028; Feature 007 T011, ticket #255).
 *
 * Binds the catalog task on a fresh host assembly, drives `runUC03GraphV02` with explicit operator
 * approval pauses, and resolves/applies the independent final-snapshot grade.
 *
 * Narrow interface: case spec, decision source and run limits in; observation, grade and evidence
 * identities out. No test doubles in src/.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { BugTask, CommandView } from '../contracts/foundation/uc03.ts';
import { canonicalJsonStringify } from '../contracts/foundation/uc03/identity.ts';
import { sha256Text } from '../uc01/contracts.ts';
import type { UC03WorkflowResult } from '../uc03/graph-types.ts';
import type { UC03GraphPortsV02 } from '../uc03/graph-types-v02.ts';
import { runUC03GraphV02 } from '../uc03/graph-v02.ts';
import { createHostCoderGeneration } from './host-coder.ts';
import type { RealTierAssembly } from './real-tier-assembly.ts';
import type { CaseGradeRequest, GradeOutcome, GraderCapability, GradeReceiptBinding } from './real-tier-case-grade.ts';
import { PINS, resolvePinnedGrader } from './real-tier-case-grade.ts';
import type { DecisionTarget } from './real-tier-case-operator.ts';
import { bindRealTierTask, type RealTierBoundTask } from './real-tier-task-binding.ts';
import type { UC03HostInputs } from './uc03-host-bootstrap.ts';

const MAX_APPROVAL_PAUSES = 3;

/** Core-owned temporary working-copy roots retained across `approvalRequired` pauses per assembly & case. */
const coreOwnedCopies = new WeakMap<RealTierAssembly, Map<string, string>>();

/** The bound task / run / workspace identity for one attempt. */
export interface AttemptIdentity {
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
}

/** One case's host-only evidence before artifact projection. */
export interface RealTierCaseEvidence {
  readonly snapshot?: Readonly<{ snapshotId: string; digest: string }> | undefined;
  readonly evidenceDigest?: string | undefined;
  readonly grade?: NonNullable<Exclude<GradeOutcome, { refusal: string } | undefined>>['grade'] | undefined;
  readonly gradeBinding?: GradeReceiptBinding | undefined;
  readonly commandView?: CommandView | undefined;
  readonly commandViewDigest?: string | undefined;
  readonly commandAdmissionRef?: string | undefined;
  readonly approval?: Readonly<{ decisionId: string; decided: 'approve' | 'reject' }> | undefined;
  readonly diffDigest?: string | undefined;
  readonly reportDigest?: string | undefined;
  readonly usage?: Readonly<{ tokens: number; cost: number; costLabel: 'estimate-unverified' | 'unknown' }> | undefined;
  readonly ownerRevisions?: Readonly<Record<string, string>> | undefined;
}

export interface RealTierCaseLimits {
  readonly totalModelCalls: number;
  readonly activeExecutionMs: number;
  readonly repairs: number;
  readonly materialReplans: number;
}

export interface ExecuteRealTierCaseOptions {
  readonly assembly: RealTierAssembly;
  readonly caseId: string;
  readonly attempt?: number | undefined;
  readonly pins: UC03HostInputs['pins'];
  readonly identity?: Readonly<Record<string, string>> | undefined;
  /**
   * Caller-owned directory for the task working copy. A caller resuming a paused (`approvalRequired`)
   * run must supply `workingCopyRoot` and manage its cleanup; when omitted, the core retains a
   * temporary copy for the same assembly and case until the run reaches a terminal outcome or is
   * explicitly abandoned via `abandonRealTierWorkingCopy`.
   */
  readonly workingCopyRoot?: string | undefined;
  readonly model?: string | undefined;
  /** Explicit operator decision source. */
  readonly decideApproval?: ((caseId: string, target: DecisionTarget) => Promise<'approve' | 'reject' | undefined>) | undefined;
  readonly clarificationHold?: ((caseId: string) => boolean) | undefined;
  /** Pre-resolved grader seam or live capability. */
  readonly grade?: ((assembly: RealTierAssembly, caseId: string, request: CaseGradeRequest) => Promise<GradeOutcome>) | undefined;
  readonly graderCapability?: GraderCapability | undefined;
  readonly limits?: RealTierCaseLimits | undefined;
  readonly maxApprovalPauses?: number | undefined;
  readonly runGraph?: typeof runUC03GraphV02 | undefined;
  readonly binding?: { readonly model?: string } | undefined;
}

export interface RealTierCaseExecution {
  readonly caseId: string;
  readonly attempt: number;
  readonly status: 'task-bound' | 'binding-failed';
  readonly reasonCode?: string | undefined;
  readonly identity?: AttemptIdentity | undefined;
  readonly task?: BugTask | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly ports?: Pick<UC03GraphPortsV02, 'repositoryPort' | 'statePort'> | undefined;
  readonly result?: UC03WorkflowResult | undefined;
  readonly approval?: Readonly<{ decisionId: string; decided: 'approve' | 'reject' }> | undefined;
  readonly approvalRequired?: boolean | undefined;
  readonly gradeOutcome?: GradeOutcome | undefined;
  readonly commandAdmission?:
    | {
        readonly commandView?: CommandView | undefined;
        readonly commandViewDigest?: string | undefined;
        readonly commandAdmissionRef?: string | undefined;
      }
    | undefined;
  readonly accounting?:
    | {
        readonly claims: number;
        readonly attempts: number;
        readonly outcomes: number;
      }
    | undefined;
  readonly evidence?: RealTierCaseEvidence | undefined;
}

const ownersOf = (assembly: RealTierAssembly, ids: Readonly<{ taskId: string; workspaceId: string }>, repositoryId: string) =>
  assembly.owners.taskOwners({ taskId: ids.taskId, workspaceId: ids.workspaceId, repositoryId });

function serialize(value: unknown): string {
  return canonicalJsonStringify(value);
}

function digestOf(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** The settled command admission, read from the owner state store on disk. */
export function findSettledCommandAdmission(
  assembly: RealTierAssembly,
  ids: Readonly<{ taskId: string; workspaceId: string }>,
  repositoryId: string,
): { commandView?: CommandView; commandViewDigest?: string; commandAdmissionRef?: string } {
  try {
    const owner = ownersOf(assembly, ids, repositoryId);
    const store = (owner.statePort as unknown as { store?: { getClaimPath?: (taskId: string, claimId: string) => string } }).store;
    if (!store?.getClaimPath) return {};
    const claimDir = dirname(store.getClaimPath(ids.taskId, 'dummy'));
    if (!existsSync(claimDir)) return {};
    const files = readdirSync(claimDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const content = readFileSync(join(claimDir, file), 'utf8');
      const claim = JSON.parse(content) as Record<string, unknown>;
      const ctx = claim['context'] as Record<string, unknown> | undefined;
      if (claim['status'] === 'settled' && ctx && ctx['subjectKind'] === 'repository-action' && ctx['commandView']) {
        const commandView = ctx['commandView'] as CommandView;
        const commandViewDigest = digestOf(serialize(commandView));
        const receipt = claim['receipt'] as Record<string, unknown> | undefined;
        const commandAdmissionRef = (receipt?.['claimId'] as string) ?? (ctx['action'] as { actionId?: string })?.actionId ?? file.replace(/\.json$/, '');
        return { commandView, commandViewDigest, commandAdmissionRef };
      }
    }
  } catch {
    // Non-throwing bounded read
  }
  return {};
}

/** The journal facts read from the owner state port, never inferred. */
export function accountingOf(assembly: RealTierAssembly, ids: Readonly<{ taskId: string }>): Readonly<{ claims: number; attempts: number; outcomes: number }> {
  const raw = assembly.owners.taskOwners({ taskId: ids.taskId, workspaceId: '', repositoryId: '' }).statePort.getJournalSnapshot(ids.taskId);
  if (typeof raw !== 'object' || raw === null) return Object.freeze({ claims: 0, attempts: 0, outcomes: 0 });
  const journal = raw as Record<string, unknown>;
  const claims = Array.isArray(journal['claims']) ? journal['claims'].length : 0;
  const attempts = Array.isArray(journal['attempts']) ? journal['attempts'].length : 0;
  const outcomes = Array.isArray(journal['outcomes']) ? journal['outcomes'].length : 0;
  return Object.freeze({ claims, attempts, outcomes });
}

/** Releases a core-owned temporary working copy retained across a paused run. */
export function abandonRealTierWorkingCopy(assembly: RealTierAssembly, caseId: string): boolean {
  const byCase = coreOwnedCopies.get(assembly);
  const retained = byCase?.get(caseId);
  if (retained === undefined) return false;
  byCase?.delete(caseId);
  rmSync(retained, { recursive: true, force: true });
  return true;
}

/**
 * Runs one real-tier case attempt: binds the catalog task, executes the v0.2 workflow graph with
 * explicit operator approval pauses, and runs independent snapshot grading.
 */
export async function executeRealTierCase(options: ExecuteRealTierCaseOptions): Promise<RealTierCaseExecution> {
  const { assembly, caseId, pins } = options;
  const attempt = options.attempt ?? 1;
  const identity = options.identity ?? {};
  const callerOwned = options.workingCopyRoot !== undefined;
  const retainedRoot = callerOwned ? undefined : coreOwnedCopies.get(assembly)?.get(caseId);
  const workingCopyRoot = options.workingCopyRoot ?? retainedRoot ?? mkdtempSync(join(tmpdir(), 'uc03-t054-copy-'));
  if (!callerOwned && retainedRoot === undefined) {
    let byCase = coreOwnedCopies.get(assembly);
    if (byCase === undefined) {
      byCase = new Map();
      coreOwnedCopies.set(assembly, byCase);
    }
    byCase.set(caseId, workingCopyRoot);
  }

  let keepCoreCopy = false;
  try {
    const binding = await bindRealTierTask(assembly, { caseId, pins, identity, workingCopyRoot });
    if (binding.status !== 'task-bound') {
      return { caseId, attempt, status: 'binding-failed', reasonCode: binding.reasonCode };
    }
    const execution = await executeOnBound(assembly, binding, caseId, attempt, pins, options);
    if (!callerOwned && execution.approvalRequired === true) {
      keepCoreCopy = true;
    }
    return execution;
  } finally {
    if (!callerOwned && !keepCoreCopy) {
      coreOwnedCopies.get(assembly)?.delete(caseId);
      rmSync(workingCopyRoot, { recursive: true, force: true });
    }
  }
}

async function executeOnBound(
  assembly: RealTierAssembly,
  binding: RealTierBoundTask,
  caseId: string,
  attempt: number,
  pins: UC03HostInputs['pins'],
  options: ExecuteRealTierCaseOptions,
): Promise<RealTierCaseExecution> {
  const runGraph = options.runGraph ?? runUC03GraphV02;
  const limits = options.limits ?? assembly.profile.limits;
  const config = {
    ...binding.config,
    generation: createHostCoderGeneration({
      model: binding.ports.modelPort,
      repository: binding.ports.repositoryPort,
      guardedRead: binding.ports.guardedRead,
      admissionContextForCheck: binding.config.trustedExpectedContext.admissionContextForCheck,
      budget: {
        maxModelCalls: limits.totalModelCalls,
        maxActiveMs: limits.activeExecutionMs,
        maxRepairs: limits.repairs,
        maxReplans: limits.materialReplans,
      },
    }),
  };

  let result = await runGraph(binding.task, binding.ports, config);
  let approval: RealTierCaseEvidence['approval'];
  const maxPauses = options.maxApprovalPauses ?? MAX_APPROVAL_PAUSES;

  for (let pause = 0; pause < maxPauses && result.outcome === 'pending-approval' && !options.clarificationHold?.(caseId); pause++) {
    const decision = await options.decideApproval?.(caseId, {
      taskId: binding.ids.taskId,
      console: ownersOf(assembly, binding.ids, binding.task.repositoryId).console,
    });
    if (decision === undefined) {
      return {
        caseId,
        attempt,
        status: 'task-bound',
        identity: { taskId: binding.ids.taskId, runId: binding.ids.runId, workspaceId: binding.ids.workspaceId },
        task: binding.task,
        repositoryRoot: binding.repositoryRoot,
        ports: { repositoryPort: binding.ports.repositoryPort, statePort: binding.ports.statePort },
        result,
        approvalRequired: true,
        accounting: accountingOf(assembly, binding.ids),
      };
    }
    approval ??= { decisionId: result.state?.activeDecisionId ?? '', decided: decision };
    if (decision === 'reject') break;
    result = await runGraph(binding.task, binding.ports, config, result.state ?? undefined);
  }

  const accounting = accountingOf(assembly, binding.ids);
  const model = options.binding?.model ?? options.model ?? '';

  let gradeFn = options.grade;
  if (gradeFn === undefined && options.graderCapability !== undefined) {
    const resolution = resolvePinnedGrader(assembly, caseId, options.graderCapability);
    if (resolution.status === 'ready') {
      gradeFn = async (_asm, _cid, req) => resolution.grade(req);
    }
  }

  const graded: GradeOutcome =
    PINS[caseId] === undefined
      ? undefined
      : await gradeFn?.(assembly, caseId, {
          caseId,
          task: binding.task,
          result,
          ports: binding.ports,
          model,
          repositoryRoot: binding.repositoryRoot,
          requiresAdmission: caseId === 'C01',
        });

  const gradeOutcome = graded !== undefined && !('refusal' in graded) ? graded : undefined;
  const grade = gradeOutcome?.grade;
  const gradeBinding = gradeOutcome?.binding;
  const commandAdmission = caseId === 'C01' ? findSettledCommandAdmission(assembly, binding.ids, binding.task.repositoryId) : {};
  const finalReport = result.finalReport;
  const reportDigest = finalReport ? `sha256:${sha256Text(JSON.stringify(finalReport))}` : undefined;

  const evidence: RealTierCaseEvidence = {
    ...(grade?.snapshot ? { snapshot: grade.snapshot } : {}),
    ...(grade?.evidenceDigest ? { evidenceDigest: grade.evidenceDigest } : {}),
    ...(grade ? { grade } : {}),
    ...(gradeBinding ? { gradeBinding } : {}),
    ...(commandAdmission.commandView ? { commandView: commandAdmission.commandView } : {}),
    ...(commandAdmission.commandViewDigest ? { commandViewDigest: commandAdmission.commandViewDigest } : {}),
    ...(commandAdmission.commandAdmissionRef ? { commandAdmissionRef: commandAdmission.commandAdmissionRef } : {}),
    ...(approval ? { approval } : {}),
    ...(finalReport ? { diffDigest: finalReport.diff.diffDigest } : {}),
    ...(reportDigest ? { reportDigest } : {}),
    ...(finalReport ? { usage: { tokens: finalReport.usage.tokensConsumed, cost: finalReport.usage.costUsd, costLabel: 'estimate-unverified' as const } } : {}),
    ownerRevisions: { repository: result.state?.repositoryRevisionDigest ?? binding.task.initialRevisionDigest, ...pins.revisions },
  };

  return {
    caseId,
    attempt,
    status: 'task-bound',
    identity: { taskId: binding.ids.taskId, runId: binding.ids.runId, workspaceId: binding.ids.workspaceId },
    task: binding.task,
    repositoryRoot: binding.repositoryRoot,
    ports: { repositoryPort: binding.ports.repositoryPort, statePort: binding.ports.statePort },
    result,
    approval,
    gradeOutcome: graded,
    commandAdmission,
    accounting,
    evidence,
  };
}
