import assert from 'node:assert/strict';
import test from 'node:test';
import { IntakeBinder } from '../../../src/uc01/intake.ts';
import { UC01_PUBLIC_CASES, publicEvidenceForCase, trustedCatalogForCase } from '../support/uc01/fixtures.ts';
import { fixtureLimits, sha256Text, type TrustedContext } from '../../../src/uc01/contracts.ts';

const record = UC01_PUBLIC_CASES.find(entry => entry.caseId === 'UC-01:C02:all-users-locked-out');
assert.ok(record);
const invocation = record.input.invocation;
const context: TrustedContext = { taskId: invocation.taskId, runId: invocation.runId, repositoryId: invocation.repositoryId,
  workspaceId: 'workspace', repositorySnapshotDigest: record.input.repositorySnapshotDigest,
  configId: 'uc01-fixture-v1', configVersion: '1', policyId: 'fixture-policy-no-dispatch', policyVersion: '1',
  catalog: trustedCatalogForCase(record.caseId), limits: fixtureLimits, accountingRef: 'account',
  evidenceRegistry: publicEvidenceForCase(record.caseId), continuation: undefined };

test('C02 binds exactly the original report and application-selected repository', () => {
  const result = new IntakeBinder().bind(invocation, context);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.invocation, invocation);
});

test('C15 protected report is rejected before admitted context can be used', () => {
  const report = 'api_key="sk-fixture-protected-0123456789"';
  const input = { ...invocation, issue: { ...invocation.issue, originalReport: report, reportDigest: sha256Text(report) } };
  const trusted = { ...context, evidenceRegistry: context.evidenceRegistry.map(entry => ({ ...entry, contentDigest: sha256Text(report) })) };
  const result = new IntakeBinder().bind(input, trusted);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reasonCode, 'protected-content');
});

test('C08 a supplied source-shaped snippet remains reporter origin with its own exact digest', () => {
  const content = 'src/session.ts:1 claims every login fails; supplied text has not been read from the repository.';
  const supplied = { id: 'snippet', sourceRef: 'reporter-snippet', content, digest: sha256Text(content) };
  const entry = { id: 'snippet', kind: 'reporter' as const, sourceRef: supplied.sourceRef, contentDigest: supplied.digest,
    safeExcerptRef: 'snippet-reference', provenance: 'mock' as const, repository: undefined, questionId: undefined };
  const trusted = { ...context, evidenceRegistry: [...context.evidenceRegistry, entry] };
  const result = new IntakeBinder({ resolveExcerpt: () => content }).bind({ ...invocation, suppliedEvidence: [supplied] }, trusted);
  assert.equal(result.ok, true);
  if (result.ok) {
    const admitted = new IntakeBinder({ resolveExcerpt: () => content }).admit(entry, fixtureLimits.inputBytes);
    assert.equal(admitted.ok, true);
    if (admitted.ok) assert.deepEqual({ kind: admitted.value.evidence.kind, repository: admitted.value.evidence.repository }, { kind: 'reporter', repository: undefined });
  }
});

test('C22 changed report digest, extra issue and empty report fail input admission', () => {
  for (const input of [
    { ...invocation, issue: { ...invocation.issue, reportDigest: '0'.repeat(64) } },
    { ...invocation, issues: [invocation.issue] },
    { ...invocation, issue: { ...invocation.issue, originalReport: '', reportDigest: sha256Text('') } },
  ]) assert.equal(new IntakeBinder().bind(input, context).ok, false);
});
