import assert from 'node:assert/strict';
import test from 'node:test';
import { composeEvaluationPorts, EVALUATION_COMPOSITION_VERSION, type OwnerDelivery } from '../../../src/runtime/evaluation-composition.ts';
import { MemoryStatePort } from '../support/uc03/memory-state.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';
import { ScriptedModelPort } from '../support/uc03/scripted-model.ts';
import { ScriptedReviewerPort } from '../support/uc03/scripted-reviewer.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';

const CONTRACT = 'uc03-owner-delivery/1';
const REV = 'a'.repeat(40);

function port(component: OwnerDelivery['component'], provenance: 'real' | 'mock' = 'real', id = `${component}-id`): OwnerDelivery {
  const adapter =
    component === 'statePort'
      ? new MemoryStatePort()
      : component === 'approvalPort'
        ? new ScriptedApprovalPort()
        : component === 'modelPort'
          ? new ScriptedModelPort()
          : component === 'reviewerPort'
            ? new ScriptedReviewerPort()
            : new FakeRepositoryPort();
  Object.defineProperty(adapter, 'provenance', { value: provenance });
  return { component, id, contractVersion: CONTRACT, revision: REV, provenance, adapter } as unknown as OwnerDelivery;
}

function allReal(): OwnerDelivery[] {
  return [port('statePort'), port('approvalPort'), port('repositoryPort'), port('modelPort'), port('reviewerPort')];
}

test('a complete, compatible real delivery set composes', () => {
  const result = composeEvaluationPorts(allReal(), CONTRACT);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.composition.version, EVALUATION_COMPOSITION_VERSION);
  assert.equal(result.composition.deliveries.modelPort, 'modelPort-id');
  assert.equal(result.composition.revisions['modelPort-id'], REV);
  assert.equal(result.ports.reviewerPort.provenance, 'real');
});

test('a missing component denies before any effect and names the component', () => {
  const result = composeEvaluationPorts(allReal().slice(0, 4), CONTRACT);
  assert.deepEqual(result, { status: 'denied', reasonCode: 'incompatible-delivery', component: 'reviewerPort' });
});

test('any mock port denies: declared provenance alone cannot make a real composition', () => {
  const deliveries = allReal().map(delivery => (delivery.component === 'modelPort' ? port('modelPort', 'mock') : delivery));
  assert.deepEqual(composeEvaluationPorts(deliveries, CONTRACT), { status: 'denied', reasonCode: 'incompatible-delivery', component: 'registry' });
});

/** Replace one component's delivery, keeping the rest intact. */
function over(component: OwnerDelivery['component'], patch: Record<string, unknown>): OwnerDelivery[] {
  return allReal().map(delivery => (delivery.component === component ? ({ ...delivery, ...patch } as OwnerDelivery) : delivery));
}

test('a delivery pinned to another contract version denies', () => {
  const result = composeEvaluationPorts(over('repositoryPort', { contractVersion: 'uc03-owner-delivery/2' }), CONTRACT);
  assert.deepEqual(result, { status: 'denied', reasonCode: 'incompatible-delivery', component: 'repositoryPort' });
});

test('an adapter missing a required method, a duplicate component or a bad revision all deny', () => {
  const missingMethod = over('approvalPort', { adapter: { classify: () => undefined } as unknown as OwnerDelivery['adapter'] });
  assert.deepEqual(composeEvaluationPorts(missingMethod, CONTRACT), { status: 'denied', reasonCode: 'incompatible-delivery', component: 'approvalPort' });

  // Settlement and charged uncertainty are required state capability, not optional.
  const noSettlement = over('statePort', {
    adapter: { loadTask: () => undefined, transition: () => undefined, reserve: () => undefined } as unknown as OwnerDelivery['adapter'],
  });
  assert.deepEqual(composeEvaluationPorts(noSettlement, CONTRACT), { status: 'denied', reasonCode: 'incompatible-delivery', component: 'statePort' });

  const duplicate = [...allReal(), port('statePort', 'real', 'statePort-other')];
  assert.deepEqual(composeEvaluationPorts(duplicate, CONTRACT), { status: 'denied', reasonCode: 'incompatible-delivery', component: 'registry' });

  const badRevision = over('statePort', { revision: 'not-a-revision' });
  assert.deepEqual(composeEvaluationPorts(badRevision, CONTRACT), { status: 'denied', reasonCode: 'incompatible-delivery', component: 'statePort' });
});
