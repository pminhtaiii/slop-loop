/**
 * UC-03 production (v0.2) graph surface — T020.
 *
 * These types name the exact production seams so a v0.1 port, a partially-implemented adapter or a
 * mock cannot stand in for one. The shared graph types retain legacy controlled behavior alongside
 * the explicit v0.2 entry.
 *
 * `StatePort` and `RepositoryPort` are structurally rejected by `StatePortV02`/`RepositoryPortV02`
 * (extra required methods; `applyPatch` must return an `executionReceipt`), so those two need no
 * cast to be safe. `ExecutionGuard`, `ModelPort` and `ApprovalPort` *are* assignable across
 * versions — TypeScript accepts a narrower-arity function in a wider slot — so the model and guard
 * members of `UC03GraphPortsV02` also require a version marker, and `checkPortsV02` re-checks it.
 * `ApprovalPort`'s production status rests on `checkProductionPortsV02` alone. All are covered by
 * the compile fixture in `tests/runtime/contract/uc03-production-ports.test.ts`.
 *
 * See `specs/007-runtime-evaluation-integration/contracts/host-composition.md` §1/§2/§4.
 */
import type {
  ApprovalPort,
  FixPlan,
  ModelPort,
  PortProvenance,
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
import type { InvestigationConfigPort, TrustedHostExpectedContext, TrustedHostPort, BaselineEvidenceWriter } from './investigation.ts';
import type { CoderAgentV02, CoderTurnInputV02 } from './agent-types.ts';
import type { TrustedReplanDirection } from './repair-types.ts';
import type { UC03CoderAdmissionResolver, UC03GraphConfig, UC03ReviewerAdmissionResolver, UC03ReviewerPort } from './graph-types.ts';

/**
 * Production baseline evidence. §3 requires lookup, though the consumer interface keeps it
 * optional for controlled writers — without it a TaskState-only continuation cannot restore the
 * evidence 007's investigation stage depends on.
 */
export interface UC03ProductionBaselinePort extends BaselineEvidenceWriter {
  readonly provenance: PortProvenance;
  loadBaselineEvidence: NonNullable<BaselineEvidenceWriter['loadBaselineEvidence']>;
}

/**
 * Version markers. A v0.1 `ModelPort`/`ExecutionGuard` has the same method names with narrower
 * arity, so structural typing alone admits it; these markers are what the production surface and
 * the runtime guard actually separate the versions by. Same mechanism as the repository and state
 * adapters (`executionGuardApiVersion`).
 */
export interface UC03ProductionModelPortV02 extends ModelPortV02 {
  readonly modelPortApiVersion: '0.2.0';
}

export interface UC03ProductionExecutionGuardV02 extends ExecutionGuardV02 {
  readonly executionGuardApiVersion: '0.2.0';
}

/** Reviewer ingress is the same canonical model boundary in a distinct role — never a second transport. */
export interface UC03ReviewerModelPortV02 extends UC03ProductionModelPortV02 {
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
  readonly modelPort: UC03ProductionModelPortV02;
  readonly reviewerModelPort: UC03ReviewerModelPortV02;
  readonly executionGuard: UC03ProductionExecutionGuardV02;
  readonly guardedRead: ExecutionGuardReadCapability;
  readonly baselineEvidence: UC03ProductionBaselinePort;
  readonly hostAuthority: TrustedHostPort;
  readonly configPort: InvestigationConfigPort;
  readonly contextSource: RealContextSource;
  readonly replanPort: MaterialReplanPortV02;
}

/** Host wiring for the v0.2 route. Each turn resolves a fresh owner admission; the agent does not claim. */
export interface UC03GraphGenerationV02 {
  /** Explicit controlled callers may supply a single prewired agent. */
  readonly agent?: CoderAgentV02 | undefined;
  /** Production host construction selects the same run-scoped agent before each counter snapshot. */
  readonly agentFor?: ((input: CoderTurnInputV02) => CoderAgentV02) | undefined;
}

/** The T034 reviewer uses a bound request/context bundle; ModelPortV02 owns its claim. */
export type UC03ReviewerAdmissionResolverV02 = UC03ReviewerAdmissionResolver;

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
  reasonCode: 'missing-port' | 'missing-method' | 'invalid-provenance' | 'missing-version-marker' | 'wrong-provider-role';
}>;

/**
 * Properties a component's v0.2 adapter must declare for `checkPortsV02` to admit it, beyond its
 * methods. A v0.1 adapter has every method name, so the marker is what separates the versions; the
 * reviewer seam additionally needs its role, since the coder's own `HostModelPortV02` carries the
 * same marker and would otherwise pass as the reviewer.
 */
const PORT_DECLARATIONS_V02: Readonly<Partial<Record<UC03ProductionComponentV02, Readonly<Record<string, string>>>>> = {
  modelPort: { modelPortApiVersion: '0.2.0' },
  reviewerModelPort: { modelPortApiVersion: '0.2.0', providerRole: 'reviewer' },
  executionGuard: { executionGuardApiVersion: '0.2.0' },
};

/** The properties a component's v0.2 adapter must declare, if any. Fixtures spread this to build real shells. */
export function portDeclarationsV02(component: UC03ProductionComponentV02): Readonly<Record<string, string>> {
  return PORT_DECLARATIONS_V02[component] ?? {};
}

/** Host wiring for the v0.2 production route. No `mode`: this entry is production by construction. */
export interface UC03GraphConfigV02 {
  readonly generation?: UC03GraphGenerationV02 | undefined;
  readonly recursionLimit?: number | undefined;
  readonly coderAdmission?: UC03CoderAdmissionResolver | undefined;
  readonly reviewerAdmission?: UC03ReviewerAdmissionResolverV02 | undefined;
  readonly trustedExpectedContext: TrustedHostExpectedContext;
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
 * Components whose contract declares no `provenance`. `TrustedHostPort` is `{ loadSnapshot }` and
 * `InvestigationConfigPort` makes provenance optional, so demanding one here would refuse the real
 * producers this feature ships. Their authority is host wiring plus the pinned revision, not a label.
 */
export const UNPROVENANCED_COMPONENTS_V02: readonly UC03ProductionComponentV02[] = ['hostAuthority', 'configPort'];

/**
 * Runtime counterpart to the compile-time contract: a substituted or half-implemented delivery is
 * refused here before the graph can produce an effect. Provenance is checked separately so a mock
 * is named as such instead of being reported as a missing method.
 */
export function checkProductionPortsV02(candidate: unknown): ProductionPortRejectionV02 | null {
  return checkPortsV02(candidate, 'real');
}

/** Controlled assembly admits only mock effects and cannot establish production authority. */
export function checkControlledPortsV02(candidate: unknown): ProductionPortRejectionV02 | null {
  return checkPortsV02(candidate, 'mock');
}

/** Own-property read, as in `cutover.ts`: a getter or an inherited value does not count. */
function isOwnDeclaration(port: Record<string, unknown>, key: string, value: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(port, key);
  return descriptor !== undefined && 'value' in descriptor && descriptor.value === value;
}

function checkPortsV02(candidate: unknown, provenance: 'real' | 'mock'): ProductionPortRejectionV02 | null {
  if (typeof candidate !== 'object' || candidate === null) return { status: 'rejected', component: 'statePort', reasonCode: 'missing-port' };
  const ports = candidate as Record<string, unknown>;
  for (const component of UC03_PRODUCTION_COMPONENTS_V02) {
    const port = ports[component] as Record<string, unknown> | null | undefined;
    if (typeof port !== 'object' || port === null) return { status: 'rejected', component, reasonCode: 'missing-port' };
    if (!UNPROVENANCED_COMPONENTS_V02.includes(component) && port['provenance'] !== provenance) return { status: 'rejected', component, reasonCode: 'invalid-provenance' };
    for (const method of REQUIRED_PORTS_V02_METHODS[component]) {
      if (typeof port[method] !== 'function') return { status: 'rejected', component, reasonCode: 'missing-method' };
    }
    // A v0.1 adapter has every method name; only these declarations separate it from v0.2.
    for (const [key, declared] of Object.entries(portDeclarationsV02(component))) {
      if (!isOwnDeclaration(port, key, declared)) {
        return { status: 'rejected', component, reasonCode: key === 'providerRole' ? 'wrong-provider-role' : 'missing-version-marker' };
      }
    }
  }
  return null;
}
