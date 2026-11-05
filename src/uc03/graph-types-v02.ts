/**
 * UC-03 production (v0.2) graph surface — T020.
 *
 * Additive only: `UC03GraphPorts` in `graph-types.ts` still types every controlled caller and is not
 * widened. These types name the exact production seams so a v0.1 port, a partially-implemented
 * adapter or a mock cannot stand in for one.
 *
 * `StatePort` and `RepositoryPort` are structurally rejected by `StatePortV02`/`RepositoryPortV02`
 * (extra required methods; `applyPatch` must return an `executionReceipt`), so those two need no
 * cast to be safe. `ExecutionGuard`, `ModelPort` and `ApprovalPort` *are* assignable across
 * versions — TypeScript accepts a narrower-arity function in a wider slot — so their production
 * status rests on `checkProductionPortsV02` at assembly, not on the type system. Both are covered by
 * the compile fixture in `tests/runtime/contract/uc03-production-ports.test.ts`.
 *
 * See `specs/007-runtime-evaluation-integration/contracts/host-composition.md` §1/§2/§4.
 */
import type {
  ApprovalPort,
  ClaimReceiptV02,
  FixPlan,
  ModelPort,
  PortProvenance,
  ProviderAdmissionContextV02,
  RepositoryPort,
  StatePort,
  StatePortV02,
  StateTransitionOptions,
  TaskState,
  RepositoryPortV02,
  ModelPortV02,
  ExecutionGuardV02,
} from '../contracts/foundation/uc03.ts';
import type { RealContextSource } from '../approvals/real-context-provider.ts';
import type { ExecutionGuardReadCapability } from '../foundation/repository-types.ts';
import type { InvestigationConfigPort, TrustedHostPort, BaselineEvidenceWriter } from './investigation.ts';
import type { CoderAgentV02 } from './agent-types.ts';
import type { TrustedReplanDirection } from './repair-types.ts';
import type { UC03CoderAdmissionResolver, UC03GraphConfig, UC03ReviewerPort } from './graph-types.ts';

/**
 * Production baseline evidence. §3 requires lookup, though the consumer interface keeps it
 * optional for controlled writers — without it a TaskState-only continuation cannot restore the
 * evidence 007's investigation stage depends on.
 */
export interface UC03ProductionBaselinePort extends BaselineEvidenceWriter {
  readonly provenance: PortProvenance;
  loadBaselineEvidence: NonNullable<BaselineEvidenceWriter['loadBaselineEvidence']>;
}

/** Reviewer ingress is the same canonical model boundary in a distinct role — never a second transport. */
export interface UC03ReviewerModelPortV02 extends ModelPortV02 {
  readonly providerRole: 'reviewer';
}

/** §4: the UC-04-owned material-replan transaction. Not an addition to `StatePort`. */
export interface MaterialReplanRequestV02 {
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly configurationId: string;
  readonly configurationVersion: string;
  readonly proposalId: string;
  /** Canonical candidate payload; the owner verifies this digest before any mutation. */
  readonly candidatePlan: FixPlan;
  readonly candidatePlanDigest: string;
  readonly priorPlanVersion: number;
  readonly priorStateVersion: number;
  readonly priorReplanCount: number;
  readonly expectedNextReplanCount: number;
  readonly direction: TrustedReplanDirection;
}

export type MaterialReplanResultV02 =
  | { readonly outcome: 'accepted'; readonly state: TaskState; readonly reservationReceipt: string; readonly transitionReceipt: string }
  | { readonly outcome: 'already-accepted'; readonly state: TaskState; readonly reservationReceipt: string; readonly transitionReceipt: string }
  | { readonly outcome: 'denied'; readonly reason: string }
  | { readonly outcome: 'uncertain'; readonly operationRef: string };

export interface MaterialReplanPortV02 {
  readonly provenance: PortProvenance;
  accept(request: MaterialReplanRequestV02): Promise<MaterialReplanResultV02>;
}

/**
 * The complete production dependency set. Every member is required: an assembled production route
 * that is missing one of these has no defined behaviour, so it must refuse before any effect rather
 * than run with the gap.
 */
export interface UC03GraphPortsV02 {
  readonly statePort: StatePortV02;
  readonly approvalPort: ApprovalPort;
  readonly repositoryPort: RepositoryPortV02;
  /** Coder role. */
  readonly modelPort: ModelPortV02;
  readonly reviewerModelPort: UC03ReviewerModelPortV02;
  readonly executionGuard: ExecutionGuardV02;
  readonly guardedRead: ExecutionGuardReadCapability;
  readonly baselineEvidence: UC03ProductionBaselinePort;
  readonly hostAuthority: TrustedHostPort;
  readonly configPort: InvestigationConfigPort;
  readonly contextSource: RealContextSource;
  readonly replanPort: MaterialReplanPortV02;
}

/** Host wiring for the v0.2 route. Each turn resolves a fresh owner admission; the agent does not claim. */
export interface UC03GraphGenerationV02 {
  readonly agent: CoderAgentV02;
}

/** An owner-issued reviewer admission, resolved per review request. */
export interface UC03ReviewerAdmissionV02 {
  readonly provision: ProviderAdmissionContextV02;
  readonly claim: ClaimReceiptV02;
}

export type UC03ReviewerAdmissionResolverV02 = (request: {
  readonly task: TaskState;
  readonly diff: { readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] };
}) => Promise<UC03ReviewerAdmissionV02 | undefined> | UC03ReviewerAdmissionV02 | undefined;

/**
 * Per-port callable surface used by the runtime guard. Kept beside the interfaces so a new required
 * method is added once, not in every consumer's own check.
 */
export const REQUIRED_PORTS_V02_METHODS = {
  statePort: ['loadTask', 'transition', 'claim', 'beginAttempt', 'recordOutcome', 'reconcileObservedOutcome', 'reconcileUncertain', 'closeUnattemptedClaim', 'checkpoint', 'recover'],
  approvalPort: ['classify', 'requestDecision', 'validateBinding', 'resolve'],
  repositoryPort: ['listDir', 'readFile', 'searchCode', 'applyPatch', 'runCommand', 'runTests', 'inspectDiff'],
  modelPort: ['propose'],
  reviewerModelPort: ['propose'],
  executionGuard: ['validateAndExecute'],
  guardedRead: ['mediateRead'],
  baselineEvidence: ['persistBaselineEvidence', 'loadBaselineEvidence'],
  hostAuthority: ['loadSnapshot'],
  configPort: ['loadConfig'],
  contextSource: ['observe'],
  replanPort: ['accept'],
} as const satisfies Readonly<Record<keyof UC03GraphPortsV02 | 'configPort', readonly string[]>>;

export type UC03ProductionComponentV02 = keyof typeof REQUIRED_PORTS_V02_METHODS;
export const UC03_PRODUCTION_COMPONENTS_V02 = Object.keys(REQUIRED_PORTS_V02_METHODS) as readonly UC03ProductionComponentV02[];

export type ProductionPortRejectionV02 = Readonly<{
  status: 'rejected';
  component: UC03ProductionComponentV02;
  reasonCode: 'missing-port' | 'missing-method' | 'invalid-provenance';
}>;

/** Host wiring for the v0.2 production route. No `mode`: this entry is production by construction. */
export interface UC03GraphConfigV02 {
  readonly generation?: UC03GraphGenerationV02 | undefined;
  readonly coderAdmission?: UC03CoderAdmissionResolver | undefined;
  readonly reviewerAdmission?: UC03ReviewerAdmissionResolverV02 | undefined;
  readonly trustedDirection?: TrustedReplanDirection | undefined;
  readonly trustedTransitionContext?: StateTransitionOptions['trusted'] | undefined;
  readonly admissionContext?: UC03GraphConfig['admissionContext'];
}

/**
 * The intersection of the v0.1 and v0.2 dependency sets. `repositoryPort` is the narrowed member:
 * `runTests`/`applyPatch`/`runCommand` take an extra owner admission in v0.2, so only `inspectDiff`
 * is common. Both full port sets assign to this with zero casts, but it is NOT enough to type the
 * node factories: their bodies pass the ports to helpers that demand full `StatePort`/
 * `RepositoryPort` (`prepareFixPlanAndApproval`, `executeVerificationChecks`) and dereference
 * `reviewerPort`, which v0.2 does not have.
 */
export interface UC03RoutePorts {
  readonly statePort: Pick<StatePort, 'loadTask' | 'transition'>;
  readonly approvalPort: ApprovalPort;
  readonly repositoryPort: Pick<RepositoryPort, 'inspectDiff'>;
  readonly modelPort: ModelPort | ModelPortV02;
  readonly reviewerPort?: UC03ReviewerPort | undefined;
  readonly executionGuard?: ExecutionGuardV02 | undefined;
  readonly baselineEvidenceWriter?: BaselineEvidenceWriter | undefined;
  readonly hostAuthority?: TrustedHostPort | undefined;
  readonly configPort?: InvestigationConfigPort | undefined;
}

/**
 * Runtime counterpart to the compile-time contract: a substituted or half-implemented delivery is
 * refused here before the graph can produce an effect. Provenance is checked separately so a mock
 * is named as such instead of being reported as a missing method.
 */
export function checkProductionPortsV02(candidate: unknown): ProductionPortRejectionV02 | null {
  if (typeof candidate !== 'object' || candidate === null) return { status: 'rejected', component: 'statePort', reasonCode: 'missing-port' };
  const ports = candidate as Record<string, unknown>;
  for (const component of UC03_PRODUCTION_COMPONENTS_V02) {
    const port = ports[component] as Record<string, unknown> | null | undefined;
    if (typeof port !== 'object' || port === null) return { status: 'rejected', component, reasonCode: 'missing-port' };
    if (port['provenance'] !== 'real') return { status: 'rejected', component, reasonCode: 'invalid-provenance' };
    for (const method of REQUIRED_PORTS_V02_METHODS[component]) {
      if (typeof port[method] !== 'function') return { status: 'rejected', component, reasonCode: 'missing-method' };
    }
  }
  return null;
}
