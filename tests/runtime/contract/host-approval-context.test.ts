import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskState as DurableTaskState } from '../../../src/persistence/contracts.ts';
import { DEFAULT_POLICY_PROFILE } from '../../../src/persistence/adapters/approval-types.ts';
import { createHostApprovalContextProvider } from '../../../src/runtime/host-approval-context.ts';
import { prepareUC03Host, type UC03HostInputs } from '../../../src/runtime/uc03-host-bootstrap.ts';
import type { OwnerDelivery } from '../../../src/runtime/evaluation-composition.ts';
import { REQUIRED_PORTS_V02_METHODS, UC03_PRODUCTION_COMPONENTS_V02, portDeclarationsV02 } from '../../../src/uc03/graph-types-v02.ts';
import type { RealContextSource } from '../../../src/approvals/real-context-provider.ts';

const REVISION = 'a'.repeat(40);
const HASH = `sha256:${'b'.repeat(64)}`;
const CONTRACT = 'uc03-owner-delivery/1';
const HOST_COMPONENTS = ['guardedRead', 'baselineEvidence', 'hostAuthority', 'contextSource'] as const;
const OWNER_COMPONENTS = UC03_PRODUCTION_COMPONENTS_V02.filter(component => !(HOST_COMPONENTS as readonly string[]).includes(component));

function readyInputs(source: RealContextSource): UC03HostInputs {
  const owner = OWNER_COMPONENTS.map(component => {
    const adapter: Record<string, unknown> = { provenance: 'real', ...portDeclarationsV02(component) };
    for (const method of REQUIRED_PORTS_V02_METHODS[component]) adapter[method] = async () => undefined;
    return { component, id: `${component}-id`, contractVersion: CONTRACT, revision: REVISION, provenance: 'real', adapter } as OwnerDelivery;
  });
  return {
    pins: { contractVersion: CONTRACT, revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, REVISION])) },
    owner,
    producers: {
      guardedRead: { provenance: 'real', mediateRead: async () => undefined } as never,
      baselineEvidence: { provenance: 'real', persistBaselineEvidence: async () => undefined, loadBaselineEvidence: async () => null } as never,
      hostAuthority: { loadSnapshot: async () => undefined } as never,
      contextSource: source,
    },
    config: {
      trustedExpectedContext: {
        taskId: 'task-a',
        workspaceId: 'workspace-a',
        repositoryId: 'repo-a',
        revisionDigest: HASH,
        criteriaDigest: HASH,
        checkSetDigest: HASH,
        expectedTestFiles: ['tests/test_a.py'],
      },
    },
    identity: { profileId: 'profile-a', profileDigest: HASH, configDigest: HASH, pricingDigest: HASH },
  };
}

test('host approval context uses the exact context source from validated readiness', async () => {
  const observed: string[] = [];
  const source: RealContextSource = {
    provenance: 'real',
    observe: (taskId, actionId) => {
      observed.push(`${taskId}:${actionId}`);
      return null;
    },
  };
  const readiness = prepareUC03Host(readyInputs(source));
  assert.equal(readiness.status, 'ready');
  if (readiness.status !== 'ready') return;

  let loaded = false;
  const provider = createHostApprovalContextProvider(readiness, {
    durable: {
      loadTask: async () => {
        loaded = true;
        return { taskId: 'task-a', runId: 'run-a', workspaceId: 'workspace-a', repositoryId: 'repo-a' } as unknown as DurableTaskState;
      },
    },
    approvals: { provenance: 'real', profile: DEFAULT_POLICY_PROFILE, readRequest: () => ({ safe: { outcome: 'denied' } }) } as never,
  });

  assert.equal(loaded, false);
  assert.deepEqual(observed, []);
  await assert.rejects(provider.loadForAction('task-a', 'action-a'), /real-context-unknown-action/u);
  assert.equal(loaded, true);
  assert.deepEqual(observed, ['task-a:action-a']);
});

test('host approval context refuses unavailable readiness before owner access', () => {
  let ownerCalls = 0;
  assert.throws(
    () =>
      createHostApprovalContextProvider(
        { status: 'unavailable', reasons: [] },
        {
          durable: {
            loadTask: async () => {
              ownerCalls += 1;
              return null;
            },
          },
          approvals: {
            provenance: 'real',
            profile: DEFAULT_POLICY_PROFILE,
            readRequest: () => {
              ownerCalls += 1;
              return undefined;
            },
          } as never,
        },
      ),
    /HOST_APPROVAL_CONTEXT_NOT_READY/u,
  );
  assert.equal(ownerCalls, 0);
});
