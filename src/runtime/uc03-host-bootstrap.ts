/**
 * UC-03 production host bootstrap (T028, host-composition §1).
 *
 * Static assembly: it validates the operator-resolved identity, the pinned delivery revisions and
 * the callable surface, then returns `ready` or a bounded `unavailable`. It is synchronous and
 * effect-free by construction — no task, claim, reservation, workspace, provider call, command,
 * patch or approval mutation can happen here, because nothing is invoked.
 *
 * A `ready` result means assembly-ready only. It is not production authority, not G-OWNERS, and not
 * evidence that a real owner, profile or route exists. Behaviour and evidence binding happen after
 * service allocation, on the graph route itself.
 *
 * The operator pins a revision for every component, including the four this module builds. Pinning
 * a host-built adapter against itself is not proof of anything; what it does buy is that a swapped
 * or drifted guard/baseline/snapshot/context producer cannot arrive unnoticed after `ready`.
 *
 * Credentials stay inside the provider boundary: an identity key or value that looks like one is
 * refused, never echoed.
 */
import type { ExecutionGuardReadCapability } from '../foundation/repository-types.ts';
import type { RealContextSource } from '../approvals/real-context-provider.ts';
import {
  checkControlledPortsV02,
  checkProductionPortsV02,
  UC03_PRODUCTION_COMPONENTS_V02,
  UNPROVENANCED_COMPONENTS_V02,
  type UC03GraphConfigV02,
  type UC03GraphPortsV02,
  type UC03ProductionComponentV02,
} from '../uc03/graph-types-v02.ts';
import { composeControlledEvaluationPorts, composeEvaluationPorts, type OwnerDelivery } from './evaluation-composition.ts';

export type UC03HostComponent = UC03ProductionComponentV02 | 'registry';

export interface UC03HostPins {
  /** The pinned owner-delivery contract this host expects; not inferred from what arrives. */
  readonly contractVersion: string;
  /** Pinned revision for every component. A delivery at another revision is stale. */
  readonly revisions: Readonly<Partial<Record<UC03ProductionComponentV02, string>>>;
}

/** Tai-owned producers, constructed by the host before assembly. */
export interface UC03HostProducers {
  readonly guardedRead: ExecutionGuardReadCapability;
  readonly baselineEvidence: UC03GraphPortsV02['baselineEvidence'];
  readonly hostAuthority: UC03GraphPortsV02['hostAuthority'];
  readonly contextSource: RealContextSource;
}

export interface UC03HostInputs {
  readonly pins: UC03HostPins;
  /** UC-04/UC-05 public deliveries. The four Tai-owned producers come from `producers`. */
  readonly owner: readonly OwnerDelivery[];
  readonly producers: UC03HostProducers;
  /** Trusted expectations and per-turn resolvers, resolved by the operator. */
  readonly config: UC03GraphConfigV02;
  /** Operator-resolved profile/catalog/config/pricing references for the readiness report. */
  readonly identity: Readonly<Record<string, string>>;
}

export type UC03HostUnavailableReason =
  | Readonly<{ kind: 'component'; component: UC03HostComponent; reasonCode: 'incompatible-delivery' | 'stale-revision' | 'mock-delivery' | 'missing-port' | 'missing-method' | 'invalid-provenance' }>
  | Readonly<{ kind: 'identity'; reasonCode: 'unsafe-identity' | 'incomplete-identity' }>;

export type UC03HostReadiness =
  | Readonly<{ status: 'ready'; ports: UC03GraphPortsV02; config: UC03GraphConfigV02; identity: Readonly<Record<string, string>> }>
  | Readonly<{ status: 'unavailable'; reasons: readonly UC03HostUnavailableReason[] }>;

export type UC03ControlledHostReadiness =
  Readonly<{ status: 'controlled-ready'; ports: UC03GraphPortsV02; config: UC03GraphConfigV02; identity: Readonly<Record<string, string>> }> | Extract<UC03HostReadiness, { status: 'unavailable' }>;

/** A credential never belongs in a readiness identity; a key or value naming one is refused. */
const CREDENTIAL = /credential|secret|token|password|api[-_]?key/iu;
const REQUIRED_IDENTITY = ['profileId', 'profileDigest', 'configDigest', 'pricingDigest'] as const;
const IDENTITY_VALUE = /^[A-Za-z0-9._:/@-]{1,256}$/u;

const unavailable = (...reasons: readonly UC03HostUnavailableReason[]): UC03HostReadiness => ({ status: 'unavailable', reasons });

/**
 * Validate and assemble. Every bounded reason is returned, not just the first, so an operator sees
 * the whole gap in one pass.
 */
export function prepareUC03Host(inputs: UC03HostInputs): UC03HostReadiness {
  return prepareHost(inputs, 'real');
}

/** Separate mock-only assembly; its tagged result never issues real evaluation admission. */
export function prepareControlledUC03Host(inputs: UC03HostInputs): UC03ControlledHostReadiness {
  const result = prepareHost(inputs, 'mock');
  return result.status === 'ready' ? { ...result, status: 'controlled-ready' } : result;
}

function prepareHost(inputs: UC03HostInputs, provenance: 'real' | 'mock'): UC03HostReadiness {
  const candidate: unknown = inputs;
  if (typeof candidate !== 'object' || candidate === null) return unavailable({ kind: 'identity', reasonCode: 'incomplete-identity' });
  const { pins, owner, producers, config, identity } = inputs;
  if (typeof pins !== 'object' || pins === null || typeof config !== 'object' || config === null || typeof producers !== 'object' || producers === null) {
    return unavailable({ kind: 'identity', reasonCode: 'incomplete-identity' });
  }
  if (typeof pins.revisions !== 'object' || pins.revisions === null || Array.isArray(pins.revisions) || !Array.isArray(owner)) {
    return unavailable({ kind: 'component', component: 'registry', reasonCode: 'incompatible-delivery' });
  }

  const identityError = checkIdentity(identity);
  if (identityError) return unavailable(identityError);

  // Pins decide what is expected before anything is composed, so a drifted set is named as stale
  // rather than as an incompatible one.
  const stale: UC03HostUnavailableReason[] = [];
  const staleFor = (component: UC03ProductionComponentV02): void => {
    if (!stale.some(reason => reason.kind === 'component' && reason.component === component)) stale.push({ kind: 'component', component, reasonCode: 'stale-revision' });
  };
  UC03_PRODUCTION_COMPONENTS_V02.filter(component => !isRevision(pins.revisions[component])).forEach(staleFor);
  const deliveries: readonly OwnerDelivery[] = [...owner, ...hostDeliveries(producers, pins, provenance)];
  for (const delivery of deliveries) {
    if (typeof delivery !== 'object' || delivery === null) return unavailable({ kind: 'component', component: 'registry', reasonCode: 'incompatible-delivery' });
    if (pins.revisions[delivery.component] !== delivery.revision) staleFor(delivery.component);
  }
  if (stale.length > 0) return unavailable(...stale);

  const composition = provenance === 'real' ? composeEvaluationPorts(deliveries, pins.contractVersion) : composeControlledEvaluationPorts(deliveries, pins.contractVersion);
  if (composition.status === 'denied') {
    return unavailable({ kind: 'component', component: composition.component, reasonCode: 'incompatible-delivery' });
  }

  const rejection = provenance === 'real' ? checkProductionPortsV02(composition.ports) : checkControlledPortsV02(composition.ports);
  if (rejection) return unavailable({ kind: 'component', component: rejection.component, reasonCode: rejection.reasonCode });

  const mock = UC03_PRODUCTION_COMPONENTS_V02.filter(
    component => !UNPROVENANCED_COMPONENTS_V02.includes(component) && (composition.ports[component] as { readonly provenance?: unknown }).provenance === 'mock',
  );
  if (provenance === 'real' && mock.length > 0) return unavailable(...mock.map(component => ({ kind: 'component', component, reasonCode: 'mock-delivery' }) as const));

  return { status: 'ready', ports: composition.ports, config, identity: Object.freeze({ ...identity }) };
}

const REVISION = /^[a-f0-9]{40,64}$/u;
const isRevision = (value: unknown): value is string => typeof value === 'string' && REVISION.test(value);

/** The Tai-owned producers as deliveries, so one composition path validates all twelve. */
function hostDeliveries(producers: UC03HostProducers, pins: UC03HostPins, provenance: 'real' | 'mock'): OwnerDelivery[] {
  const port = producers as unknown as Record<string, unknown>;
  return Object.entries(port).map(
    ([component, adapter]) =>
      ({
        component,
        id: `host-${component}`,
        contractVersion: pins.contractVersion,
        revision: pins.revisions[component as UC03ProductionComponentV02] ?? '',
        provenance,
        adapter,
      }) as OwnerDelivery,
  );
}

function checkIdentity(identity: Readonly<Record<string, string>> | undefined): UC03HostUnavailableReason | null {
  if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) return { kind: 'identity', reasonCode: 'incomplete-identity' };
  if (Object.entries(identity).some(([key, value]) => CREDENTIAL.test(key) || CREDENTIAL.test(String(value)))) return { kind: 'identity', reasonCode: 'unsafe-identity' };
  // Profile/route/containment references stay optional: their absence is a named gate, not an
  // assembly gap. These four are what the readiness report itself has to state.
  const missing = REQUIRED_IDENTITY.filter(key => typeof identity[key] !== 'string' || !IDENTITY_VALUE.test(identity[key]));
  return missing.length === 0 ? null : { kind: 'identity', reasonCode: 'incomplete-identity' };
}
