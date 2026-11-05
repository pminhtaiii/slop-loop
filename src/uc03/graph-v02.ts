/**
 * v0.2 production graph entry (T027, host-composition §2).
 *
 * The only entry that takes `UC03GraphPortsV02` explicitly. It refuses on a port that is missing,
 * half-implemented or mock before any effect, then delegates the run to the shared `runUC03Graph`
 * so there is one invoke/failure-attribution implementation, not two.
 *
 * A controlled delivery cannot reach `ready` here: every controlled fixture declares
 * `provenance: 'mock'` while `checkProductionPortsV02` demands `'real'`. These tests witness the
 * refusal path only — they are not G-OWNERS, G-ROUTE or G-REAL evidence.
 */
import type { BugTask, TaskState } from '../contracts/foundation/uc03.ts';
import { createEvaluationDiagnostic } from '../runtime/evaluation-diagnostics.ts';
import { createRuntimeReviewer } from '../foundation/reviewer.ts';
import { buildUC03Graph, runUC03Graph, type UC03WorkflowApp } from './graph.ts';
import { checkControlledPortsV02, checkProductionPortsV02, type ProductionPortRejectionV02, type UC03GraphConfigV02, type UC03GraphPortsV02 } from './graph-types-v02.ts';
import type { UC03GraphConfig, UC03GraphPorts, UC03WorkflowResult } from './graph-types.ts';

/** One name for the refusal contract on this route; the check itself lives beside the port types. */
export function refuseProductionPorts(candidate: unknown): ProductionPortRejectionV02 | null {
  return checkProductionPortsV02(candidate);
}

function assemblePorts(ports: UC03GraphPortsV02): UC03GraphPorts {
  return {
    statePort: ports.statePort,
    approvalPort: ports.approvalPort,
    repositoryPort: ports.repositoryPort,
    modelPort: ports.modelPort,
    // The reviewer port receives no owner state and a revision digest is not derivable from diff
    // text, so the current authoritative owner revision is the only honest source. A missing task
    // yields undefined and the reviewer's own REPO_DIGEST_UNAVAILABLE guard refuses before dispatch.
    reviewerPort: createRuntimeReviewer({
      model: ports.reviewerModelPort,
      resolveRepoDigest: async task => (await ports.statePort.loadTask(task.taskId))?.repositoryRevisionDigest,
    }),
    executionGuard: ports.executionGuard,
    baselineEvidenceWriter: ports.baselineEvidence,
    hostAuthority: ports.hostAuthority,
    configPort: ports.configPort,
    replanPort: ports.replanPort,
  };
}

function assembleConfig(config: UC03GraphConfigV02, mode: 'production' | 'controlled' = 'production'): UC03GraphConfig {
  return {
    mode,
    // No supplied answer: the production route never accepts plan/patch/replan bytes from config,
    // and a configured generation attempt refuses one (REAL_PROFILE_SUPPLIED_ANSWER_REFUSED).
    generationV02: config.generation,
    trustedExpectedContext: config.trustedExpectedContext,
    trustedDirection: config.trustedDirection,
    trustedTransitionContext: config.trustedTransitionContext,
    admissionContext: config.admissionContext,
    reviewerAdmission: config.reviewerAdmission,
    coderAdmission: config.coderAdmission,
  };
}

/** Assembly only — no admission check, so a controlled caller can build and inspect the route. */
export function createProductionRoute(ports: UC03GraphPortsV02, config: UC03GraphConfigV02): UC03WorkflowApp {
  return buildUC03Graph(assemblePorts(ports), assembleConfig(config));
}

export async function runUC03GraphV02(task: BugTask, ports: UC03GraphPortsV02, config: UC03GraphConfigV02, initialState?: TaskState): Promise<UC03WorkflowResult> {
  const rejection = refuseProductionPorts(ports);
  if (rejection) {
    return {
      outcome: 'INCOMPLETE',
      state: null,
      reasons: [`PRODUCTION_ADMISSION_REFUSED: ${rejection.component} ${rejection.reasonCode} — all effectful ports must declare real provenance and satisfy the v0.2 surface`],
      milestones: [],
      diagnostic: createEvaluationDiagnostic({
        stage: 'preflight',
        component: 'workflow',
        attribution: 'integration',
        attributionConfidence: 'observed',
        reasonCode: 'production-admission-refused',
        limitations: ['Refusal observes port provenance declarations and callable surface only; no effectful component was exercised'],
      }),
    };
  }
  // The shared runner owns invoke, the production admission gate and failure attribution.
  return runUC03Graph(task, assemblePorts(ports), assembleConfig(config), initialState);
}

/** Mock-only entry for contract witnesses; production admission remains a separate path. */
export async function runControlledUC03GraphV02(task: BugTask, ports: UC03GraphPortsV02, config: UC03GraphConfigV02, initialState?: TaskState): Promise<UC03WorkflowResult> {
  const rejection = checkControlledPortsV02(ports);
  if (rejection) return { outcome: 'INCOMPLETE', state: null, reasons: [`CONTROLLED_ADMISSION_REFUSED: ${rejection.component} ${rejection.reasonCode}`], milestones: [] };
  return runUC03Graph(task, assemblePorts(ports), assembleConfig(config, 'controlled'), initialState);
}
