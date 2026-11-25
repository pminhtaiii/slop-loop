/**
 * Real-tier production route for `evaluate run --host <host.json> --mode real`
 * (Feature 007 T011, ticket #257).
 *
 * Issues host-bound real-execution admissions only when CLI binding matches the loaded profile,
 * executes each selected case through `executeRealTierCase` with caller-owned working copies and the
 * T046 operator decision source, and attaches snapshot-bound grades via `produceWorkflowEvidence`.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { executeRealTierCase, type RealTierCaseExecution } from './real-tier-case-run.ts';
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

function canIssueAdmission(
  assembly: RealTierAssembly,
  ready: UC03HostReady,
  context: HostProductionContext | undefined,
  expected: ReturnType<typeof expectedBindingsOf>,
): context is HostProductionContext {
  if (context === undefined || context.mode !== 'real' || context.caseIds.length === 0 || ready.status !== 'ready') return false;
  if (
    !sameDigest(ready.identity['profileDigest'], expected.profileDigest) ||
    !sameDigest(ready.identity['configDigest'], expected.configDigest) ||
    !sameDigest(ready.identity['pricingDigest'], expected.pricingDigest)
  ) {
    return false;
  }
  if (
    !sameDigest(context.binding.profileDigest, expected.profileDigest) ||
    !sameDigest(context.binding.configDigest, expected.configDigest) ||
    !sameDigest(context.binding.pricingDigest, expected.pricingDigest) ||
    context.binding.requestedModel !== expected.model
  ) {
    return false;
  }
  if (context.pins.contractVersion !== REAL_TIER_DELIVERY_CONTRACT) return false;
  return UC03_PRODUCTION_COMPONENTS_V02.every(component => context.pins.revisions[component] === assembly.revision);
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
    artifacts: [
      safeLine(`candidate:${candidateSha};owner-rev:${ownerRevision}`, 256),
      safeLine(`profile:${assembly.metadata.profileDigest}`, 256),
      safeLine(`image:${assembly.metadata.imageId}`, 256),
      safeLine(`model:req=${assembly.metadata.model};ret=none`, 256),
      'usage:tokens=unknown;cost=unknown;costLabel=unknown',
    ],
    limitations: [safeReason],
  };
}

function returnedModelOf(assembly: RealTierAssembly, execution: RealTierCaseExecution): string | null {
  const port = assembly.components.modelPort;
  if (!execution.identity || !(port instanceof HostModelPortV02) || !isDeepSeekTransport(port.options.transport)) return null;
  return port.options.transport.identityForRun(execution.identity.taskId, execution.identity.runId)?.returned ?? null;
}

function buildObservation(
  spec: EvaluationCaseSpec,
  assembly: RealTierAssembly,
  execution: RealTierCaseExecution,
  candidateSha: string,
  pins: UC03HostInputs['pins'],
  graderDigest: string | null,
): WorkflowObservation {
  const task = execution.task;
  const result = execution.result;
  const finalState = result?.executionEvidence?.finalState ?? result?.state ?? null;
  const finalReport = result?.finalReport;
  const rawReturned = returnedModelOf(assembly, execution);
  const ownerRevision = execution.evidence?.ownerRevisions?.['statePort'] ?? pins.revisions['statePort'] ?? assembly.revision;
  const diffDigest = execution.evidence?.diffDigest && execution.evidence.diffDigest.length > 0 ? execution.evidence.diffDigest : 'none';
  const reportDigest = execution.evidence?.reportDigest && execution.evidence.reportDigest.length > 0 ? execution.evidence.reportDigest : 'none';
  const cmdRef = execution.commandAdmission?.commandAdmissionRef ?? 'none';
  const cmdViewDigest = execution.commandAdmission?.commandViewDigest ?? 'none';
  const usage = execution.evidence?.usage;
  const tokensText = usage ? String(usage.tokens) : 'unknown';
  const costText = usage ? String(usage.cost) : 'unknown';
  const costLabel = usage ? usage.costLabel : 'unknown';
  const workflowOutcome = execution.approvalRequired === true ? 'waiting-approval' : result ? lifecycleOf(result.outcome) : 'not-observed';
  const specificReason = result?.reasons.find(r => r !== 'Incomplete verification or review evidence for completion') ?? result?.reasons[0];
  const diagnosticText =
    execution.approvalRequired === true ? 'Operator decision was not completed; task remains paused.' : result?.outcome === 'INCOMPLETE' ? (specificReason ?? 'Task did not complete.') : null;
  const limitations: string[] = [];
  if (execution.approvalRequired === true) {
    limitations.push('Operator decision was not completed; task remains paused.');
  } else if (finalReport === undefined) {
    limitations.push('No authoritative final report was produced.');
  }
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
    diagnostic: diagnosticText === null ? null : safeLine(diagnosticText, 512),
    artifacts: [
      safeLine(`candidate:${candidateSha};owner-rev:${ownerRevision}`, 256),
      safeLine(`profile:${assembly.metadata.profileDigest}`, 256),
      safeLine(`image:${assembly.metadata.imageId}`, 256),
      safeLine(`model:req=${assembly.metadata.model};ret=${rawReturned ?? 'unknown'}`, 256),
      safeLine(`evidence:diff=${diffDigest};report=${reportDigest}`, 256),
      safeLine(`evidence-cmd:${cmdRef};view=${cmdViewDigest}`, 256),
      safeLine(`usage:tokens=${tokensText};cost=${costText};costLabel=${costLabel}`, 256),
    ],
    limitations: limitations.map(item => safeLine(item, 256)),
  };
}

/**
 * Builds the `HostProduction` route for `real-tier-assembly.ts`.
 * Passes `resolveAssembly` as a callback to avoid circular module initialization.
 */
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
      revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, initialAssembly.revision])),
    };
    const identity = ready.identity;
    let cachedIo: OperatorIo | undefined;
    let cachedDecide: ((caseId: string, target: DecisionTarget) => Promise<'approve' | 'reject' | undefined>) | undefined;
    const decideApproval = (caseId: string, target: DecisionTarget) => {
      cachedIo ??= dependencies.operatorIo ?? stdioOperator();
      cachedDecide ??= createOperatorDecisionSource(cachedIo);
      return cachedDecide(caseId, target);
    };
    const runNonce = randomUUID().slice(0, 12);

    const driver: WorkflowDriver = {
      async executeCase(spec: EvaluationCaseSpec, caseContext: WorkflowCaseContext): Promise<WorkflowObservation> {
        const ownerFallback = pins.revisions['statePort'] ?? initialAssembly.revision;
        if (
          caseContext.mode !== 'real' ||
          !sameDigest(caseContext.profileDigest, expected.profileDigest) ||
          !sameDigest(caseContext.configDigest, expected.configDigest) ||
          !sameDigest(caseContext.pricingDigest, expected.pricingDigest) ||
          caseContext.requestedModel !== expected.model
        ) {
          return blockedObservation(spec, initialAssembly, candidateSha, ownerFallback, null, 'Real-tier production route requires real mode and matching host bindings.');
        }

        // An unpinned case has no grader, so a real run could only end ungraded: refuse before any spend.
        if (PINS[spec.caseId] === undefined) {
          return blockedObservation(spec, initialAssembly, candidateSha, ownerFallback, null, 'No pinned grader exists for this case.');
        }
        const caseAssemblyRes = resolveAssembly({ ...dependencies, stateRoot: join(baseStateRoot, `run-${runNonce}-${spec.caseId}`) });
        if (caseAssemblyRes.status !== 'assembly-ready') {
          return blockedObservation(spec, initialAssembly, candidateSha, ownerFallback, null, `Case assembly unavailable (${caseAssemblyRes.reasonCode}).`);
        }
        const caseAssembly = caseAssemblyRes;
        const capability = dependencies.graderCapability ?? createRealTierGraderCapability({ spawn: dependencies.spawn ?? structuredSpawn });
        const graderRes: GraderResolution = resolvePinnedGrader(caseAssembly, spec.caseId, capability);
        if (graderRes.status !== 'ready') {
          const reasonCode = graderRes.status === 'unavailable' ? graderRes.reasonCode : 'grader-unavailable';
          return blockedObservation(spec, caseAssembly, candidateSha, ownerFallback, null, `Grader prerequisite unavailable (${reasonCode}).`);
        }
        if (!graderRes.hasCriterion) {
          return blockedObservation(spec, caseAssembly, candidateSha, ownerFallback, graderRes.graderDigest, 'Grader criterion is missing for pinned case.');
        }
        if (dependencies.graderCapability === undefined && PINS[spec.caseId] === 'repair-success' && !graderRes.hasValidPayload) {
          return blockedObservation(spec, caseAssembly, candidateSha, ownerFallback, graderRes.graderDigest, 'Grader payload is missing or invalid for pinned case.');
        }

        const graderDigest = graderRes.graderDigest;
        // Caller-owned copy stays alive until `produceWorkflowEvidence` finishes freezing & rechecking.
        const workingCopyRoot = mkdtempSync(join(tmpdir(), `uc03-real-prod-copy-${process.pid}-`));
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
            return blockedObservation(spec, caseAssembly, candidateSha, ownerFallback, graderDigest, `Task binding unavailable (${execution.reasonCode ?? 'binding-failed'}).`);
          }

          const observation = buildObservation(spec, caseAssembly, execution, candidateSha, pins, graderDigest);
          if (
            execution.approvalRequired !== true &&
            execution.result?.outcome !== 'pending-approval' &&
            execution.task !== undefined &&
            execution.ports !== undefined &&
            execution.result !== undefined &&
            execution.repositoryRoot !== undefined
          ) {
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
          rmSync(workingCopyRoot, { recursive: true, force: true });
        }
      },
    };

    return realAdmission === undefined ? { driver } : { driver, realAdmission };
  };
}
