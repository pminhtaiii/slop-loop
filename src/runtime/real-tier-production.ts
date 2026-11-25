/**
 * Real-tier production route for `evaluate run --host <host.json> --mode real`
 * (Feature 007 T011, ticket #257).
 *
 * Issues host-bound real-execution admissions only when CLI binding matches the loaded profile,
 * executes each selected case through `executeRealTierCase` with caller-owned working copies and the
 * T046 operator decision source, and attaches snapshot-bound grades via `produceWorkflowEvidence`.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { issueRealExecutionAdmission } from '../../eval/shared-admission.ts';
import type { EvaluationCaseSpec, WorkflowCaseContext, WorkflowDriver, WorkflowObservation } from '../../eval/uc03/types.ts';
import { lifecycleOf } from '../../eval/uc03/workflow-driver.ts';
import { produceWorkflowEvidence } from '../../eval/uc03/workflow-evidence.ts';
import type { HostProduction, HostProductionContext, UC03HostReady } from '../cli/evaluate-host.ts';
import { createOperatorDecisionSource, stdioOperator, type DecisionTarget, type OperatorIo } from './real-tier-case-operator.ts';
import { isDeepSeekTransport } from '../foundation/deepseek-transport.ts';
import { structuredSpawn } from '../foundation/docker-spawn.ts';
import { HostModelPortV02 } from '../foundation/model-v02.ts';
import { sanitizeText } from '../foundation/telemetry.ts';
import { sha256Text } from '../uc01/contracts.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../uc03/graph-types-v02.ts';
import { boundedText } from '../uc03/report/sanitize.ts';
import { gitHead } from './git-head.ts';
import type { RealTierAssembly, RealTierDependencies, RealTierResolution } from './real-tier-assembly.ts';
import { PINS, resolvePinnedGrader, type GraderResolution } from './real-tier-case-grade.ts';
import { executeRealTierCase, type AttemptIdentity, type RealTierCaseExecution } from './real-tier-case-run.ts';
import { createRealTierGraderCapability } from './real-tier-grader.ts';
import { REAL_TIER_DELIVERY_CONTRACT } from './real-tier-owners.ts';
import type { UC03HostInputs } from './uc03-host-bootstrap.ts';

const WORKFLOW_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const WORKFLOW_DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/u;

function safeIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = sanitizeText(value);
  return sanitized === value && WORKFLOW_IDENTIFIER.test(value) ? value : null;
}

function safeDigest(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  return WORKFLOW_DIGEST.test(value) ? value : null;
}

function safeLine(value: string, maxBytes: number): string {
  return boundedText(sanitizeText(value), maxBytes);
}

function bareHex(digest: string): string {
  return digest.startsWith('sha256:') ? digest.slice(7) : digest;
}

function sameDigest(actual: string | undefined, expectedHex: string): boolean {
  return actual === expectedHex || actual === `sha256:${expectedHex}`;
}

function expectedBindingsOf(assembly: RealTierAssembly) {
  return {
    profileDigest: bareHex(assembly.metadata.profileDigest),
    configDigest: sha256Text(JSON.stringify({ limits: assembly.profile.limits, runLimits: assembly.profile.runLimits })),
    pricingDigest: sha256Text(JSON.stringify(assembly.profile.pricing)),
    model: assembly.metadata.model,
  };
}

function matchesDigests(source: { readonly profileDigest?: unknown; readonly configDigest?: unknown; readonly pricingDigest?: unknown }, expected: ReturnType<typeof expectedBindingsOf>): boolean {
  return (
    typeof source.profileDigest === 'string' &&
    sameDigest(source.profileDigest, expected.profileDigest) &&
    typeof source.configDigest === 'string' &&
    sameDigest(source.configDigest, expected.configDigest) &&
    typeof source.pricingDigest === 'string' &&
    sameDigest(source.pricingDigest, expected.pricingDigest)
  );
}

function canIssueAdmission(
  assembly: RealTierAssembly,
  ready: UC03HostReady,
  context: HostProductionContext | undefined,
  expected: ReturnType<typeof expectedBindingsOf>,
): context is HostProductionContext {
  if (context === undefined || context.mode !== 'real' || context.caseIds.length === 0 || ready.status !== 'ready') return false;
  if (!matchesDigests(ready.identity, expected) || !matchesDigests(context.binding, expected) || context.binding.requestedModel !== expected.model) {
    return false;
  }
  if (context.pins.contractVersion !== REAL_TIER_DELIVERY_CONTRACT) return false;
  return UC03_PRODUCTION_COMPONENTS_V02.every(c => context.pins.revisions[c] === assembly.revision);
}

function coreArtifacts(assembly: RealTierAssembly, candidateSha: string, ownerRev: string, returnedModel: string | null): readonly string[] {
  return [
    safeLine(`candidate:${candidateSha};owner-rev:${ownerRev}`, 256),
    safeLine(`profile:${assembly.metadata.profileDigest}`, 256),
    safeLine(`image:${assembly.metadata.imageId}`, 256),
    safeLine(`model:req=${assembly.metadata.model};ret=${returnedModel ?? 'none'}`, 256),
  ];
}

function blockedObservation(spec: EvaluationCaseSpec, assembly: RealTierAssembly, candidateSha: string, ownerRevision: string, graderDigest: string | null, reason: string): WorkflowObservation {
  const safeReason = safeLine(reason, 256);
  return {
    repositoryId: null,
    taskId: null,
    runId: null,
    returnedModel: null,
    graderDigest: safeDigest(graderDigest),
    initialRepositoryDigest: null,
    workflowOutcome: 'not-observed',
    expectedWait: spec.caseId === 'C02' ? 'waiting-info' : null,
    blocked: 'prerequisite-unavailable',
    effects: 'none',
    usage: 'unavailable',
    diagnostic: safeLine(reason, 512),
    artifacts: [...coreArtifacts(assembly, candidateSha, ownerRevision, null), 'usage:tokens=unknown;cost=unknown;costLabel=unknown'],
    limitations: [safeReason],
  };
}

function returnedModelOf(assembly: RealTierAssembly, execution: RealTierCaseExecution): string | null {
  const port = assembly.components.modelPort;
  if (!execution.identity || !(port instanceof HostModelPortV02) || !isDeepSeekTransport(port.options.transport)) return null;
  return port.options.transport.identityForRun(execution.identity.taskId, execution.identity.runId)?.returned ?? null;
}

interface PausedCaseContext {
  readonly caseAssembly: RealTierAssembly;
  readonly stateRoot: string;
  readonly workingCopyRoot: string;
  readonly graderRes: Extract<GraderResolution, { readonly status: 'ready' }>;
  readonly graderDigest: string;
  readonly expectedOutcome: EvaluationCaseSpec['expectedOutcome'];
  readonly identity: AttemptIdentity;
  readonly repositoryRoot: string;
}

const driverDisposers = new WeakMap<WorkflowDriver, (caseId?: string) => boolean>();

/** Releases retained paused working copies scoped to a production workflow driver. */
export function abandonRealTierProductionCase(driver: WorkflowDriver, caseId?: string): boolean {
  return driverDisposers.get(driver)?.(caseId) ?? false;
}

function matchesAdmittedAssembly(
  candidate: RealTierAssembly,
  initialRevision: string,
  expected: ReturnType<typeof expectedBindingsOf>,
  pins: UC03HostInputs['pins'],
  paused?: PausedCaseContext,
): boolean {
  const b = expectedBindingsOf(candidate);
  if (!matchesDigests(b, expected) || b.model !== expected.model || candidate.revision !== initialRevision || UC03_PRODUCTION_COMPONENTS_V02.some(c => pins.revisions[c] !== candidate.revision)) {
    return false;
  }
  if (paused === undefined) return true;
  const p = paused.caseAssembly;
  return candidate.metadata.imageId === p.metadata.imageId && candidate.metadata.endpointDigest === p.metadata.endpointDigest && candidate.profile.catalog.path === p.profile.catalog.path;
}

const PAUSED_MSG = 'Task remains paused awaiting explicit operator approval.';
const REJECTED_MSG = 'Operator rejected approval; explicit direction or termination is required before continuing.';

function buildObservation(
  spec: EvaluationCaseSpec,
  assembly: RealTierAssembly,
  execution: RealTierCaseExecution,
  candidateSha: string,
  pins: UC03HostInputs['pins'],
  graderDigest: string | null,
  rejectedByOperator: boolean,
): WorkflowObservation {
  const { task, result, evidence, commandAdmission } = execution;
  const finalState = result?.executionEvidence?.finalState ?? result?.state ?? null;
  const finalReport = result?.finalReport;
  const rawReturned = returnedModelOf(assembly, execution);
  const ownerRev = evidence?.ownerRevisions?.['statePort'] ?? pins.revisions['statePort'] ?? assembly.revision;
  const u = evidence?.usage;
  const pausedForApproval = execution.approvalRequired === true;
  const rejectedApproval = rejectedByOperator || (!pausedForApproval && result?.outcome === 'pending-approval');
  const workflowOutcome = pausedForApproval ? 'waiting-approval' : result ? lifecycleOf(result.outcome) : 'not-observed';
  const specificReason = result?.reasons.find(r => r !== 'Incomplete verification or review evidence for completion') ?? result?.reasons[0];
  const diagnostic = pausedForApproval ? PAUSED_MSG : rejectedApproval ? REJECTED_MSG : result?.outcome === 'INCOMPLETE' ? (specificReason ?? 'Task did not complete.') : null;
  const limitations: string[] = [];
  if (pausedForApproval) limitations.push(PAUSED_MSG);
  else if (rejectedApproval) limitations.push('Operator rejected approval; explicit direction or termination is required and no approval or replay occurred.');
  else if (finalReport === undefined) limitations.push('No authoritative final report was produced.');
  return {
    repositoryId: safeIdentifier(finalState?.repositoryId ?? task?.repositoryId),
    taskId: safeIdentifier(execution.identity?.taskId ?? finalState?.taskId),
    runId: safeIdentifier(execution.identity?.runId ?? finalState?.runId),
    returnedModel: safeIdentifier(rawReturned),
    graderDigest: safeDigest(graderDigest),
    initialRepositoryDigest: safeDigest(task?.initialRevisionDigest),
    workflowOutcome,
    expectedWait: spec.caseId === 'C02' ? 'waiting-info' : null,
    blocked: null,
    effects: finalState !== null ? 'observed' : 'uncertain',
    usage: finalReport?.usage !== undefined ? 'observed' : finalState !== null ? 'uncertain' : 'unavailable',
    diagnostic: diagnostic === null ? null : safeLine(diagnostic, 512),
    artifacts: [
      ...coreArtifacts(assembly, candidateSha, ownerRev, rawReturned ?? 'unknown'),
      safeLine(`evidence:diff=${evidence?.diffDigest || 'none'};report=${evidence?.reportDigest || 'none'}`, 256),
      safeLine(`evidence-cmd:${commandAdmission?.commandAdmissionRef ?? 'none'};view=${commandAdmission?.commandViewDigest ?? 'none'}`, 256),
      safeLine(`usage:tokens=${u ? String(u.tokens) : 'unknown'};cost=${u ? String(u.cost) : 'unknown'};costLabel=${u ? u.costLabel : 'unknown'}`, 256),
    ],
    limitations: limitations.map(item => safeLine(item, 256)),
  };
}

/** Builds the `HostProduction` route for `real-tier-assembly.ts`, receiving `resolveAssembly` to avoid circular imports. */
export function createRealTierProductionRoute(
  initialAssembly: RealTierAssembly,
  dependencies: RealTierDependencies,
  resolveAssembly: (deps: RealTierDependencies) => RealTierResolution,
): HostProduction {
  const expected = expectedBindingsOf(initialAssembly);
  const candidateSha = gitHead(dependencies.repositoryRoot ?? process.cwd()) || 'unknown';
  const baseStateRoot = dependencies.stateRoot ?? initialAssembly.profile.stateRoot;

  return (ready: UC03HostReady, context?: HostProductionContext) => {
    const admissionOk = canIssueAdmission(initialAssembly, ready, context, expected);
    const realAdmission = admissionOk ? issueRealExecutionAdmission({ ...context.binding, caseIds: context.caseIds }) : undefined;
    const pins: UC03HostInputs['pins'] = context?.pins ?? {
      contractVersion: REAL_TIER_DELIVERY_CONTRACT,
      revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(c => [c, initialAssembly.revision])),
    };
    const identity = ready.identity;
    const runNonce = randomUUID().slice(0, 12);
    let attemptSeq = 0;
    const pausedCases = new Map<string, PausedCaseContext>();

    const dropPaused = (id: string, root: string): void => {
      pausedCases.delete(id);
      rmSync(root, { recursive: true, force: true });
    };

    const driver: WorkflowDriver = {
      async executeCase(spec: EvaluationCaseSpec, caseContext: WorkflowCaseContext): Promise<WorkflowObservation> {
        const ownerFallback = pins.revisions['statePort'] ?? initialAssembly.revision;
        const fail = (assembly: RealTierAssembly, graderDigest: string | null, reason: string) => blockedObservation(spec, assembly, candidateSha, ownerFallback, graderDigest, reason);

        if (caseContext.mode !== 'real' || !matchesDigests(caseContext, expected) || caseContext.requestedModel !== expected.model) {
          return fail(initialAssembly, null, 'Real-tier production route requires real mode and matching host bindings.');
        }

        // An unpinned case has no grader: refuse before any spend.
        if (PINS[spec.caseId] === undefined) return fail(initialAssembly, null, 'No pinned grader exists for this case.');

        const paused = pausedCases.get(spec.caseId);
        if (paused !== undefined && spec.expectedOutcome !== paused.expectedOutcome) {
          return fail(paused.caseAssembly, paused.graderDigest, 'Case specification does not match the paused run.');
        }

        const stateRoot = paused ? paused.stateRoot : join(baseStateRoot, `run-${runNonce}-${++attemptSeq}-${spec.caseId}`);
        const fresh = resolveAssembly({ ...dependencies, stateRoot });
        if (fresh.status !== 'assembly-ready') return fail(initialAssembly, null, `Case assembly unavailable (${fresh.reasonCode}).`);
        if (!matchesAdmittedAssembly(fresh, initialAssembly.revision, expected, pins, paused)) {
          return fail(initialAssembly, null, 'Case assembly does not match the admitted bindings.');
        }

        const capability = dependencies.graderCapability ?? createRealTierGraderCapability({ spawn: dependencies.spawn ?? structuredSpawn });
        const grader: GraderResolution = resolvePinnedGrader(fresh, spec.caseId, capability);
        if (grader.status !== 'ready') {
          return fail(fresh, null, `Grader prerequisite unavailable (${grader.status === 'unavailable' ? grader.reasonCode : 'grader-unavailable'}).`);
        }
        if (!grader.hasCriterion) return fail(fresh, grader.graderDigest, 'Grader criterion is missing for pinned case.');
        if (dependencies.graderCapability === undefined && PINS[spec.caseId] === 'repair-success' && !grader.hasValidPayload) {
          return fail(fresh, grader.graderDigest, 'Grader payload is missing or invalid for pinned case.');
        }
        if (paused !== undefined && grader.graderDigest !== paused.graderDigest) {
          return fail(paused.caseAssembly, grader.graderDigest, 'Grader binding does not match the paused run.');
        }

        if (paused !== undefined) {
          if (!existsSync(paused.workingCopyRoot) || !existsSync(paused.repositoryRoot)) {
            dropPaused(spec.caseId, paused.workingCopyRoot);
            return fail(paused.caseAssembly, paused.graderDigest, 'Paused working copy is unavailable for continuation.');
          }
          const persisted = await paused.caseAssembly.owners.components.statePort.loadTask(paused.identity.taskId);
          if (persisted === null || persisted.runId !== paused.identity.runId || persisted.workspaceId !== paused.identity.workspaceId) {
            return fail(paused.caseAssembly, paused.graderDigest, 'Paused task state does not match the retained run identity.');
          }
        }

        const caseAssembly = paused?.caseAssembly ?? fresh;
        const graderRes = paused?.graderRes ?? grader;
        const graderDigest = paused?.graderDigest ?? grader.graderDigest;
        const workingCopyRoot = paused?.workingCopyRoot ?? mkdtempSync(join(tmpdir(), `uc03-real-prod-copy-${process.pid}-`));
        let routeOwnedIo: OperatorIo | undefined;
        let caseDecide: ((caseId: string, target: DecisionTarget) => Promise<'approve' | 'reject' | undefined>) | undefined;
        let rejectedOp = false;
        const decideApproval = async (caseId: string, target: DecisionTarget) => {
          const io = dependencies.operatorIo ?? (routeOwnedIo ??= stdioOperator());
          caseDecide ??= createOperatorDecisionSource(io);
          const decision = await caseDecide(caseId, target);
          if (decision === 'reject') rejectedOp = true;
          return decision;
        };
        let retainCopy = false;
        try {
          const execution = await executeRealTierCase({
            assembly: caseAssembly,
            caseId: spec.caseId,
            pins,
            identity,
            workingCopyRoot,
            model: caseAssembly.metadata.model,
            decideApproval,
            clarificationHold: id => id === 'C02',
            binding: { model: caseAssembly.metadata.model },
          });
          if (execution.status !== 'task-bound') {
            return fail(caseAssembly, graderDigest, `Task binding unavailable (${execution.reasonCode ?? 'binding-failed'}).`);
          }

          const observation = buildObservation(spec, caseAssembly, execution, candidateSha, pins, graderDigest, rejectedOp);
          const pausedOut = execution.approvalRequired === true;
          const rejected = rejectedOp || (!pausedOut && execution.result?.outcome === 'pending-approval');
          if (pausedOut && execution.identity && execution.repositoryRoot) {
            retainCopy = true;
            pausedCases.set(spec.caseId, {
              caseAssembly,
              stateRoot,
              workingCopyRoot,
              graderRes,
              graderDigest,
              expectedOutcome: spec.expectedOutcome,
              identity: execution.identity,
              repositoryRoot: execution.repositoryRoot,
            });
            return observation;
          }

          if (!rejected && execution.task && execution.ports && execution.result && execution.repositoryRoot) {
            await produceWorkflowEvidence({
              caseId: spec.caseId,
              mode: 'real',
              task: execution.task,
              result: execution.result,
              observation,
              repository: execution.ports.repositoryPort,
              statePort: execution.ports.statePort,
              host: graderRes.evidenceHost(execution.task, execution.repositoryRoot),
              retainedBaseline: execution.result.executionEvidence?.baselineCandidate,
            });
          }
          return observation;
        } finally {
          try {
            routeOwnedIo?.close?.();
          } finally {
            if (!retainCopy) dropPaused(spec.caseId, workingCopyRoot);
          }
        }
      },
    };

    driverDisposers.set(driver, (targetCaseId?: string) => {
      if (targetCaseId !== undefined) {
        const entry = pausedCases.get(targetCaseId);
        if (entry === undefined) return false;
        dropPaused(targetCaseId, entry.workingCopyRoot);
        return true;
      }
      if (pausedCases.size === 0) return false;
      for (const entry of pausedCases.values()) rmSync(entry.workingCopyRoot, { recursive: true, force: true });
      pausedCases.clear();
      return true;
    });

    return realAdmission === undefined ? { driver } : { driver, realAdmission };
  };
}
