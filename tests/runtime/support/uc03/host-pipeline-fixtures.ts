import type { TaskState } from '../../../../src/contracts/foundation/uc03.ts';
import type { OwnerDelivery } from '../../../../src/runtime/evaluation-composition.ts';
import type { UC03HostInputs } from '../../../../src/runtime/uc03-host-bootstrap.ts';
import { REQUIRED_PORTS_V02_METHODS, UC03_PRODUCTION_COMPONENTS_V02, portDeclarationsV02, type UC03GraphConfigV02, type UC03ProductionComponentV02 } from '../../../../src/uc03/graph-types-v02.ts';

const CONTRACT = 'uc03-owner-delivery/1';
const REVISION = 'a'.repeat(40);
const HOST_COMPONENTS = ['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource'] as const;
const OWNER_COMPONENTS = UC03_PRODUCTION_COMPONENTS_V02.filter(component => !(HOST_COMPONENTS as readonly string[]).includes(component));

export interface ControlledHostFixture {
  readonly inputs: UC03HostInputs;
  readonly calls: string[];
}

/** Mock-only boundary deliveries; only task reload has behavior for the paused-route witness. */
export function controlledHostFixture(
  taskState: TaskState,
  config: UC03GraphConfigV02,
  ownerAdapters: Partial<Record<UC03ProductionComponentV02, object>> = {},
  hostAdapters: Partial<Record<(typeof HOST_COMPONENTS)[number], object>> = {},
): ControlledHostFixture {
  const calls: string[] = [];
  const owner = OWNER_COMPONENTS.map(component => {
    const injected = ownerAdapters[component];
    const adapter: Record<string, unknown> = injected ? (injected as Record<string, unknown>) : { provenance: 'mock', ...portDeclarationsV02(component) };
    if (!injected) {
      for (const method of REQUIRED_PORTS_V02_METHODS[component]) {
        adapter[method] = async (..._args: unknown[]) => {
          calls.push(`${component}.${method}`);
          return component === 'statePort' && method === 'loadTask' && taskState.taskId === _args[0] ? structuredClone(taskState) : undefined;
        };
      }
    }
    return { component, id: `${component}-controlled`, contractVersion: CONTRACT, revision: REVISION, provenance: 'mock', adapter } as OwnerDelivery;
  });
  const producers = {
    guardedRead: { provenance: 'mock', mediateRead: async () => undefined },
    baselineEvidence: { provenance: 'mock', persistBaselineEvidence: async () => undefined, loadBaselineEvidence: async () => null },
    hostAuthority: { loadSnapshot: async () => undefined },
    contextSource: { provenance: 'mock', observe: async () => undefined },
    ...hostAdapters,
  } as never;
  return {
    inputs: {
      pins: { contractVersion: CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, REVISION])) },
      owner,
      producers,
      config,
      identity: { profileId: 'controlled-profile', profileDigest: 'sha256:' + 'b'.repeat(64), configDigest: 'sha256:' + 'b'.repeat(64), pricingDigest: 'sha256:' + 'b'.repeat(64) },
    },
    calls,
  };
}
