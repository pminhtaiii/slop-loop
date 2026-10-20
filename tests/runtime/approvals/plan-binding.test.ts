import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePlanBinding } from '../../../src/approvals/plan-binding.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const binding = { decisionId: 'decision-1', actionKind: 'fix_plan', normalizedActionDigest: digest, taskId: 'task-1', workspaceId: 'workspace-1', repositoryRevisionDigest: digest, policyId: 'policy-1', policyVersion: '1', planVersion: 1, strategyDigest: digest, baselineRef: 'baseline-1', evidenceRefs: ['evidence-1'], criteriaDigest: digest, checkSetDigest: digest, status: 'approved' };
const context = { currentTaskId: 'task-1', currentWorkspaceId: 'workspace-1', currentRepositoryRevisionDigest: digest, currentPolicyId: 'policy-1', currentPolicyVersion: '1', currentNormalizedActionDigest: digest, currentPlanVersion: 1, currentStrategyDigest: digest, currentBaselineRef: 'baseline-1', currentEvidenceRefs: ['evidence-1'], currentCriteriaDigest: digest, currentCheckSetDigest: digest };

test('exact approved plan evaluates fresh without changing the original decision', () => {
  const original = structuredClone(binding);
  assert.deepEqual(evaluatePlanBinding(binding, context), { status: 'valid', reasonCodes: [] });
  assert.deepEqual(binding, original);
});

test('each canonical freshness dimension reports its concrete changed binding', () => {
  const changes = [
    ['currentTaskId', 'task-other', 'taskId'], ['currentWorkspaceId', 'workspace-other', 'workspaceId'],
    ['currentRepositoryRevisionDigest', `sha256:${'b'.repeat(64)}`, 'repositoryRevisionDigest'],
    ['currentPolicyId', 'policy-other', 'policyId'], ['currentPolicyVersion', '2', 'policyVersion'],
    ['currentNormalizedActionDigest', `sha256:${'b'.repeat(64)}`, 'normalizedActionDigest'],
    ['currentPlanVersion', 2, 'planVersion'], ['currentStrategyDigest', `sha256:${'b'.repeat(64)}`, 'strategyDigest'],
    ['currentBaselineRef', 'baseline-new', 'baselineRef'], ['currentEvidenceRefs', ['evidence-new'], 'evidenceRefs'],
    ['currentCriteriaDigest', `sha256:${'b'.repeat(64)}`, 'criteriaDigest'], ['currentCheckSetDigest', `sha256:${'b'.repeat(64)}`, 'checkSetDigest'],
  ] as const;
  for (const [field, value, reason] of changes) {
    assert.deepEqual(evaluatePlanBinding(binding, { ...context, [field]: value }), { status: 'stale', reasonCodes: [`changed-${reason}`] }, field);
  }
});

test('missing context and non-data input deny freshness without invoking accessors', () => {
  let reads = 0;
  const accessor = Object.defineProperty({ ...context }, 'currentTaskId', { enumerable: true, get: () => { reads += 1; return 'task-1'; } });
  for (const raw of [undefined, null, [], {}, accessor, new Proxy(context, {})]) {
    assert.equal(evaluatePlanBinding(binding, raw).status, 'denied');
  }
  for (const field of Object.keys(context)) {
    const missing = Object.fromEntries(Object.entries(context).filter(([key]) => key !== field));
    assert.equal(evaluatePlanBinding(binding, missing).status, 'denied', field);
  }
  const badBinding = Object.defineProperty({ ...binding }, 'taskId', { enumerable: true, get: () => { reads += 1; return 'task-1'; } });
  assert.equal(evaluatePlanBinding(badBinding, context).status, 'denied');
  assert.equal(reads, 0);
});

test('malformed evidence contexts deny freshness rather than granting authority or throwing', () => {
  for (const evidence of [Array(1), 'e', 'evidence-1', 1, {}, { length: 1 }, [undefined], ['evidence-1', 'evidence-1']]) {
    assert.notEqual(evaluatePlanBinding(binding, { ...context, currentEvidenceRefs: evidence }).status, 'valid');
  }
});

test('freshness context rejects fields outside the canonical vocabulary', () => {
  for (const field of ['unexpectedAuthority', 'approval', 'constructor']) {
    assert.deepEqual(evaluatePlanBinding(binding, { ...context, [field]: true }), { status: 'denied', reasonCodes: ['unknown-binding-context-field'] });
  }
});
