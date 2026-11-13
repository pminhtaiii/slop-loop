/**
 * Graph-backed workflow driver for the uc03 workflow evaluation.
 *
 * The host supplies the task, ports and pinned expected wait per case; only IDs and digests
 * reach the observation. A preflight block never calls the graph.
 */

import type { BugTask } from '../../src/contracts/foundation/uc03.ts';
import { sanitizeText } from '../../src/foundation/telemetry.ts';
import type { CatalogEntry } from '../../src/runtime/evaluation-profile.ts';
import type { CoderBudget } from '../../src/uc03/agent-types.ts';
import { createHostCoderGeneration } from '../../src/runtime/host-coder.ts';
import type { UC03ControlledHostReadiness, UC03HostReadiness } from '../../src/runtime/uc03-host-bootstrap.ts';
import { HostModelPortV02 } from '../../src/foundation/model-v02.ts';
import { isDeepSeekTransport } from '../../src/foundation/deepseek-transport.ts';
import { reuseClarificationBaseline } from '../../src/uc03/graph-investigation-baseline.ts';
import type { BaselineEvidenceCandidate, TrustedHostExpectedContext } from '../../src/uc03/investigation.ts';
import { runUC03Graph } from '../../src/uc03/graph.ts';
import { runControlledUC03GraphV02, runUC03GraphV02 } from '../../src/uc03/graph-v02.ts';
import type { UC03GraphConfigV02, UC03GraphPortsV02 } from '../../src/uc03/graph-types-v02.ts';
import type { UC03GraphConfig, UC03GraphPorts, UC03WorkflowResult } from '../../src/uc03/graph-types.ts';
import { produceWorkflowEvidence, type WorkflowEvidenceHost } from './workflow-evidence.ts';
import type { EvaluationCaseSpec, WorkflowCaseContext, WorkflowDriver, WorkflowLifecycle, WorkflowObservation, WorkflowUsage, WorkflowWait } from './types.ts';

export interface WorkflowCaseHost {
  readonly entry: CatalogEntry;
  readonly task: BugTask;
  /** Controlled route. Absent only when `production` supplies the route instead. */
  readonly ports?: UC03GraphPorts | undefined;
  /** Pinned by the host catalog; never inferred from the run. */
  readonly expectedWait: WorkflowWait | null;
  /** Needed to drive the route at all; the brief's map shape omits it (reported gap). */
  readonly config?: UC03GraphConfig | undefined;
  /**
   * Production route: the v0.2 entry takes its ports explicitly and refuses a mock, half-implemented
   * or stale delivery before any effect. A host that reaches here has already passed
   * `prepareUC03Host`; presenting it does not make the run real.
   */
  readonly production?:
    | Readonly<{ readiness: Extract<UC03HostReadiness, { status: 'ready' }>; coderBudget: CoderBudget }>
    | Readonly<{ ports: UC03GraphPortsV02; config: UC03GraphConfigV02 }>
    | undefined;
  /** Mock-only versioned route, never eligible for real evaluation admission. */
  readonly controlled?:
    | Readonly<{ ports: UC03GraphPortsV02; config: UC03GraphConfigV02 }>
    | Readonly<{ readiness: Extract<UC03ControlledHostReadiness, { status: 'controlled-ready' }>; coderBudget: CoderBudget }>
    | undefined;
  /** Optional host-only independent grade wiring; it never crosses the observation boundary. */
  readonly workflowEvidence?: WorkflowEvidenceHost | undefined;
}

const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/u;
const TERMINAL = new Set<string>(['COMPLETED', 'INCOMPLETE', 'IMPLEMENTED_UNVERIFIED', 'FAILED']);
const MAX_DIAGNOSTIC = 512;
const MAX_ARTIFACT = 256;
const MAX_ARTIFACTS = 16;

function safeText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = sanitizeText(value);
  return clean.length > 0 && Buffer.byteLength(clean, 'utf8') <= maxBytes ? clean : null;
}

function safeList(values: readonly unknown[]): readonly string[] {
  const out: string[] = [];
  for (const value of values) {
    const clean = safeText(value, MAX_ARTIFACT);
    if (clean !== null && !out.includes(clean)) out.push(clean);
    if (out.length === MAX_ARTIFACTS) break;
  }
  return out;
}

export function lifecycleOf(outcome: string): WorkflowLifecycle {
  if (outcome === 'pending-approval') return 'waiting-approval';
  if (outcome === 'needs-info') return 'waiting-info';
  return TERMINAL.has(outcome) ? (outcome as WorkflowLifecycle) : 'not-observed';
}

function usageOf(observed: boolean, statePresent: boolean): WorkflowUsage {
  return observed ? 'observed' : statePresent ? 'uncertain' : 'unavailable';
}

function blockedObservation(caseId: string, host: WorkflowCaseHost | undefined, reasonCode: string): WorkflowObservation {
  return {
    repositoryId: host?.task.repositoryId ?? null,
    taskId: null,
    runId: null,
    returnedModel: null,
    graderDigest: host && DIGEST.test(host.entry.grader.digest) ? host.entry.grader.digest : null,
    initialRepositoryDigest: host && DIGEST.test(host.entry.initialRepositoryDigest) ? host.entry.initialRepositoryDigest : null,
    workflowOutcome: 'not-observed',
    expectedWait: host?.expectedWait ?? null,
    blocked: 'prerequisite-unavailable',
    effects: 'none',
    usage: 'unavailable',
    diagnostic: safeText(`Preflight block ${caseId}: ${reasonCode}`, MAX_DIAGNOSTIC),
    artifacts: [],
    limitations: safeList([`Preflight block ${reasonCode}; no graph dispatch occurred.`]),
  };
}

/**
 * `effects` is `'observed'` when the route returned owner state and `'uncertain'` otherwise:
 * a graph call may have dispatched before returning no state. Also `shortcut:` host usage is
 * read from the authoritative final report only; owner accounting beyond it stays `uncertain`.
 */
function returnedModelFor(ports: Pick<UC03GraphPorts, 'modelPort'> | undefined, result: UC03WorkflowResult, requestedModel: string): string | null {
  const state = result.state;
  const modelPort = ports?.modelPort;
  if (!state || !(modelPort instanceof HostModelPortV02) || !isDeepSeekTransport(modelPort.options.transport)) return null;
  const identity = modelPort.options.transport.identityForRun(state.taskId, state.runId);
  return identity?.requested === requestedModel && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identity.returned) ? identity.returned : null;
}

function observationFor(host: WorkflowCaseHost, result: UC03WorkflowResult, ports: UC03GraphPortsV02 | undefined, requestedModel: string): WorkflowObservation {
  const state = result.state;
  const outcome = lifecycleOf(result.outcome);
  const report = result.finalReport;
  // The graph's structured diagnostic is flattened to this report's single string field.
  // shortcut: evidenceRefs and milestone kinds are dropped here; carry them structurally when the report shape next versions.
  const codes = result.diagnostic === undefined ? '' : ` [${result.diagnostic.component}/${result.diagnostic.attribution}/${result.diagnostic.reasonCode}]`;
  return {
    repositoryId: state?.repositoryId ?? host.task.repositoryId,
    taskId: state?.taskId ?? null,
    runId: state?.runId ?? null,
    returnedModel: returnedModelFor(ports ?? host.ports, result, requestedModel),
    graderDigest: host.entry.grader.digest,
    initialRepositoryDigest: host.entry.initialRepositoryDigest,
    workflowOutcome: outcome,
    expectedWait: host.expectedWait,
    blocked: null,
    effects: state === null ? 'uncertain' : 'observed',
    usage: usageOf(report?.usage !== undefined, state !== null),
    diagnostic: safeText(`UC-03 outcome ${outcome}${state ? ` at ${state.node}` : ''}${codes}`, MAX_DIAGNOSTIC),
    artifacts: safeList([...(report?.evidence.verificationRefs ?? []), ...(report?.evidence.reviewRef ? [report.evidence.reviewRef] : [])]),
    limitations: safeList(report === undefined ? ['No authoritative final report was produced.'] : []),
  };
}

/** Builds the safe observation and attaches private snapshot evidence for an already completed graph result. */
export async function observeAndGradeWorkflowResult(
  host: WorkflowCaseHost,
  result: UC03WorkflowResult,
  ports: UC03GraphPortsV02 | undefined,
  requestedModel: string,
  mode: WorkflowCaseContext['mode'],
  generation?: object | undefined,
  trustedExpectedContext?: TrustedHostExpectedContext | undefined,
): Promise<WorkflowObservation> {
  const observation = observationFor(host, result, ports, requestedModel);
  // The existing grader is explicitly controlled-only. Real repair acceptance still needs its
  // separately admitted isolation delivery and cannot borrow this injected mock boundary.
  if (mode === 'mock' && host.workflowEvidence) {
    const repository = ports?.repositoryPort ?? host.ports?.repositoryPort;
    let retainedBaseline: BaselineEvidenceCandidate | undefined;
    const finalState = result.executionEvidence?.finalState;
    if (
      result.executionEvidence?.baseline === undefined && finalState && generation && trustedExpectedContext?.statePort &&
      ports?.statePort && ports.hostAuthority
    ) {
      const retained = await reuseClarificationBaseline({
        generation,
        task: host.task,
        state: finalState,
        statePort: ports.statePort,
        hostAuthority: ports.hostAuthority,
        expectedContext: trustedExpectedContext,
      });
      if (retained.ok) retainedBaseline = retained.baseline;
    }
    await produceWorkflowEvidence({ caseId: host.entry.caseId, task: host.task, result, observation, repository, statePort: ports?.statePort, host: host.workflowEvidence, retainedBaseline });
  }
  return observation;
}

/** Host-held map from public case id to the task, ports and pinned wait it should observe. */
export function createWorkflowDriver(catalog: ReadonlyMap<string, WorkflowCaseHost>): WorkflowDriver {
  if (!(catalog instanceof Map)) throw new Error('Invalid workflow driver catalog');
  const hosts = new Map(catalog);
  const productionRoutes = new Map<string, Readonly<{ ports: UC03GraphPortsV02; config: UC03GraphConfigV02 }> | null>();
  const constructedControlledRoutes = new Map<string, Readonly<{ ports: UC03GraphPortsV02; config: UC03GraphConfigV02 }> | null>();
  for (const [caseId, host] of hosts) {
    if (typeof caseId !== 'string' || !host || host.entry.caseId !== caseId) throw new Error('Invalid workflow driver catalog entry');
    if (host.controlled && 'readiness' in host.controlled) {
      try {
        const { readiness, coderBudget } = host.controlled;
        if (readiness.status !== 'controlled-ready' || readiness.config.generation !== undefined || host.production) {
          constructedControlledRoutes.set(caseId, null);
          continue;
        }
        const generation = createHostCoderGeneration({
          model: readiness.ports.modelPort,
          repository: readiness.ports.repositoryPort,
          guardedRead: readiness.ports.guardedRead,
          admissionContextForCheck: readiness.config.trustedExpectedContext.admissionContextForCheck,
          budget: coderBudget,
        });
        constructedControlledRoutes.set(caseId, { ports: readiness.ports, config: { ...readiness.config, generation } });
      } catch {
        constructedControlledRoutes.set(caseId, null);
      }
    }
    if (host.production) {
      if (host.controlled && 'readiness' in host.controlled) {
        productionRoutes.set(caseId, null);
        continue;
      }
      try {
        if (!('readiness' in host.production)) {
          // Preserve source compatibility for prewired callers, but do not treat that shape as the
          // host-bound construction path or dispatch it through a real evaluator.
          productionRoutes.set(caseId, null);
          continue;
        }
        const { readiness, coderBudget } = host.production;
        if (readiness.status !== 'ready' || readiness.config.generation !== undefined) {
          productionRoutes.set(caseId, null);
          continue;
        }
        const generation = createHostCoderGeneration({
          model: readiness.ports.modelPort,
          repository: readiness.ports.repositoryPort,
          guardedRead: readiness.ports.guardedRead,
          admissionContextForCheck: readiness.config.trustedExpectedContext.admissionContextForCheck,
          budget: coderBudget,
        });
        productionRoutes.set(caseId, { ports: readiness.ports, config: { ...readiness.config, generation } });
      } catch {
        productionRoutes.set(caseId, null);
      }
    }
  }
  return {
    async executeCase(spec: EvaluationCaseSpec, context: WorkflowCaseContext): Promise<WorkflowObservation> {
      const host = hosts.get(spec.caseId);
      if (host === undefined) return blockedObservation(spec.caseId, undefined, 'UNKNOWN_CASE');
      if (host.entry.caseId !== spec.caseId) return blockedObservation(spec.caseId, host, 'CATALOG_MISMATCH');
      if (!DIGEST.test(host.entry.caseDigest) || !DIGEST.test(host.entry.publicTaskDigest) || !DIGEST.test(host.entry.initialRepositoryDigest) || !DIGEST.test(host.entry.grader.digest)) {
        return blockedObservation(spec.caseId, host, 'MISSING_DIGEST');
      }
      if (!DIGEST.test(context.profileDigest) || !DIGEST.test(context.configDigest) || !DIGEST.test(context.pricingDigest)) {
        return blockedObservation(spec.caseId, host, 'MISSING_DIGEST');
      }
      // Neither entry throws; a real port failure is still a possible dispatch, hence uncertain effects.
      if (host.controlled) {
        if (context.mode !== 'mock' || host.production || host.ports) return blockedObservation(spec.caseId, host, 'CONTROLLED_ROUTE_ONLY');
        if ('readiness' in host.controlled) {
          const route = constructedControlledRoutes.get(spec.caseId);
          if (!route) return blockedObservation(spec.caseId, host, 'HOST_CODER_UNAVAILABLE');
          return observeAndGradeWorkflowResult(host, await runControlledUC03GraphV02(host.task, route.ports, route.config), route.ports, context.requestedModel, context.mode, route.config.generation, route.config.trustedExpectedContext);
        }
        return observeAndGradeWorkflowResult(host, await runControlledUC03GraphV02(host.task, host.controlled.ports, host.controlled.config), host.controlled.ports, context.requestedModel, context.mode, host.controlled.config.generation, host.controlled.config.trustedExpectedContext);
      }
      if (host.production) {
        if (context.mode !== 'real' || host.ports) return blockedObservation(spec.caseId, host, 'PRODUCTION_ROUTE_REQUIRES_REAL_MODE');
        const route = productionRoutes.get(spec.caseId);
        if (!route) return blockedObservation(spec.caseId, host, 'HOST_CODER_UNAVAILABLE');
        return observeAndGradeWorkflowResult(host, await runUC03GraphV02(host.task, route.ports, route.config), route.ports, context.requestedModel, context.mode, route.config.generation, route.config.trustedExpectedContext);
      }
      if (!host.ports) return blockedObservation(spec.caseId, host, 'MISSING_ROUTE');
      return observeAndGradeWorkflowResult(host, await runUC03Graph(host.task, host.ports, host.config), undefined, context.requestedModel, context.mode, host.config?.generationV02, host.config?.trustedExpectedContext);
    },
  };
}
