import { isAdmittedForProduction, type PortProvenance } from '../contracts/foundation/uc03/v01/ports.ts';
import type { UC03GraphPorts } from '../uc03/graph-types.ts';

/**
 * UC-03 real-tier port composition (T006).
 *
 * Composes already-delivered owner capabilities into `UC03GraphPorts`. It implements no owner:
 * state, approval, repository, model and reviewer arrive as injected deliveries, and UC-04/UC-05
 * remain external. A delivery is admitted only when its declared contract version, revision and
 * callable surface match what this composition requires; anything missing or incompatible denies
 * before the graph can produce an effect.
 *
 * G-AUTH note: a `ready` real composition is a prerequisite for G-OWNERS, not evidence of it.
 * Nothing here establishes that a real owner, profile or route exists.
 */

export const EVALUATION_COMPOSITION_VERSION = 'uc03-evaluation-composition/1';

/**
 * Required capability per port, matching what the graph actually calls. State covers durable
 * reservation, settlement and charged uncertainty; repository covers admitted evidence reads.
 */
const REQUIRED_METHODS = {
  statePort: ['loadTask', 'transition', 'reserve', 'settle', 'reconcileUncertain'],
  approvalPort: ['classify', 'requestDecision', 'validateBinding', 'resolve'],
  repositoryPort: ['listDir', 'readFile', 'searchCode', 'runTests', 'inspectDiff'],
  modelPort: ['propose'],
  reviewerPort: ['review'],
} as const;

type Component = keyof typeof REQUIRED_METHODS;
type ComponentPort<K extends Component> = NonNullable<UC03GraphPorts[K]>;
const COMPONENTS = Object.keys(REQUIRED_METHODS) as readonly Component[];

/** One public owner delivery, supplied by the trusted host — never by task or model input. */
export type OwnerDelivery = {
  readonly [K in Component]: Readonly<{
    component: K;
    id: string;
    contractVersion: string;
    revision: string;
    provenance: PortProvenance;
    adapter: ComponentPort<K>;
  }>;
}[Component];

export type EvaluationComposition = Readonly<{
  version: typeof EVALUATION_COMPOSITION_VERSION;
  deliveries: Readonly<Partial<Record<Component, string>>>;
  revisions: Readonly<Record<string, string>>;
}>;

export type CompositionResult =
  Readonly<{ status: 'ready'; ports: UC03GraphPorts; composition: EvaluationComposition }> | Readonly<{ status: 'denied'; reasonCode: 'incompatible-delivery'; component: Component | 'registry' }>;

const REVISION = /^[a-f0-9]{40,64}$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const CONTRACT_VERSION = /^[A-Za-z0-9._:/-]{1,128}$/u;

/**
 * Compose a real-tier graph. Denies before any effect when a delivery is missing, ambiguous,
 * version-incompatible or cannot satisfy production admission.
 *
 * `contractVersion` is the pinned owner delivery contract this host expects; it is not inferred
 * from whatever the delivery happens to declare.
 */
export function composeEvaluationPorts(deliveries: readonly OwnerDelivery[], contractVersion: string): CompositionResult {
  const denied = (component: Component | 'registry'): CompositionResult => ({ status: 'denied', reasonCode: 'incompatible-delivery', component });
  if (!Array.isArray(deliveries) || !CONTRACT_VERSION.test(contractVersion)) return denied('registry');

  const byComponent = new Map<string, OwnerDelivery>();
  const ids = new Set<string>();
  for (const delivery of deliveries) {
    const candidate: unknown = delivery;
    if (typeof candidate !== 'object' || candidate === null) return denied('registry');
    // Duplicate component or id means the trusted host published an ambiguous registry.
    if (byComponent.has(delivery.component) || ids.has(delivery.id)) return denied('registry');
    byComponent.set(delivery.component, delivery);
    ids.add(delivery.id);
  }

  const ports: Record<string, unknown> = {};
  const revisions: Record<string, string> = {};
  const selected: Partial<Record<Component, string>> = {};
  for (const component of COMPONENTS) {
    const delivery = byComponent.get(component);
    if (delivery === undefined) return denied(component);
    const adapter: unknown = delivery.adapter;
    if (
      typeof adapter !== 'object' ||
      adapter === null ||
      !SAFE_ID.test(delivery.id) ||
      delivery.contractVersion !== contractVersion ||
      !REVISION.test(delivery.revision) ||
      REQUIRED_METHODS[component].some(method => typeof Reflect.get(adapter, method) !== 'function')
    ) {
      return denied(component);
    }
    ports[component] = adapter;
    revisions[delivery.id] = delivery.revision;
    selected[component] = delivery.id;
  }

  // Independent of the deliveries' own declarations: every port must pass the same production
  // admission the graph applies, so a mock adapter can never ride along in a real-tier composition.
  const graphPorts = ports as unknown as UC03GraphPorts;
  if (!isAdmittedForProduction([graphPorts.statePort, graphPorts.approvalPort, graphPorts.repositoryPort, graphPorts.modelPort, graphPorts.reviewerPort])) {
    return denied('registry');
  }

  return {
    status: 'ready',
    ports: graphPorts,
    composition: { version: EVALUATION_COMPOSITION_VERSION, deliveries: Object.freeze(selected), revisions: Object.freeze(revisions) },
  };
}
