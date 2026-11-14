/** Host-owned composition of the validated context source with accepted durable UC-04/UC-05 backing. */

import { createRealContextProvider, type RealContextSource } from '../approvals/real-context-provider.ts';
import type { DurableApprovalStore } from '../persistence/adapters/approval-store-adapter.ts';
import type { DurableStore } from '../persistence/store.ts';
import { checkProductionPortsV02 } from '../uc03/graph-types-v02.ts';
import type { UC03HostReadiness } from './uc03-host-bootstrap.ts';

export interface HostApprovalContextBacking {
  readonly durable: Pick<DurableStore, 'loadTask'>;
  readonly approvals: Pick<DurableApprovalStore, 'provenance' | 'profile' | 'readRequest'>;
}

export function createHostApprovalContextProvider(readiness: UC03HostReadiness, backing: HostApprovalContextBacking): ReturnType<typeof createRealContextProvider> {
  if (readiness?.status !== 'ready') throw new Error('HOST_APPROVAL_CONTEXT_NOT_READY');
  if (checkProductionPortsV02(readiness.ports) !== null) throw new Error('HOST_APPROVAL_CONTEXT_PORTS_UNAVAILABLE');
  if (typeof backing?.durable?.loadTask !== 'function') throw new Error('HOST_APPROVAL_CONTEXT_DURABLE_REQUIRED');
  if (
    backing.approvals?.provenance !== 'real' ||
    typeof backing.approvals.readRequest !== 'function' ||
    typeof backing.approvals.profile?.policyIdentity?.policyId !== 'string' ||
    typeof backing.approvals.profile.policyIdentity.policyVersion !== 'string'
  )
    throw new Error('HOST_APPROVAL_CONTEXT_APPROVALS_REQUIRED');
  const source: RealContextSource = readiness.ports.contextSource;
  if (source.provenance !== 'real' || typeof source.observe !== 'function') throw new Error('HOST_APPROVAL_CONTEXT_SOURCE_UNAVAILABLE');
  return createRealContextProvider({ durable: backing.durable, approvals: backing.approvals, source });
}
