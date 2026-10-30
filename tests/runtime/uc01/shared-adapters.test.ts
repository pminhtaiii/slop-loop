import assert from 'node:assert/strict';
import test from 'node:test';
import { BudgetTracker } from '../../../src/persistence/accounting.ts';
import { UC01AccountingAdapter } from '../../../src/persistence/adapters/uc01-adapter.ts';
import { createUC04AccountingProjection, projectFoundationFinding } from '../../../src/uc01/shared-adapters.ts';
import { fixtureLimits, sha256Text, type Usage } from '../../../src/uc01/contracts.ts';
import type { OperationContext, ReserveCeiling } from '../../../src/uc01/assess.ts';
import { operationContextDigest } from '../support/uc01/ports.ts';

const context: OperationContext = { taskId: 'task', runId: 'run', invocationId: 'invocation', repositoryId: 'repo', workspaceId: 'workspace',
  repositorySnapshotDigest: 'a'.repeat(64), configId: 'config', configVersion: '1', policyId: 'policy', policyVersion: '1',
  operationId: 'operation', requestId: 'request', accountingRef: 'account', deadlineEpochMs: 1000, limits: fixtureLimits };
const ceiling: ReserveCeiling = { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUnits: 3, pricingId: 'pricing' };
const admission = { kind: 'admitted' as const, admissionRef: 'admission', requestId: context.requestId, contextDigest: operationContextDigest(context) };
function fixture() {
  const tracker = new BudgetTracker([
    { scope: 'task', kind: 'tokens', limit: 1000, consumed: 0, reservations: [], configurationId: 'config', version: 1 },
    { scope: 'task', kind: 'cost', limit: 20, consumed: 0, reservations: [], configurationId: 'config', version: 1 },
  ]);
  return { tracker, projection: createUC04AccountingProjection(new UC01AccountingAdapter(tracker), context, () => 100) };
}

test('delivered UC04 accounting reserve and settle project to exact consumer-v1 envelopes', async () => {
  const { projection, tracker } = fixture();
  assert.deepEqual(await projection.reserve(context, admission, ceiling), { kind: 'reserved', reservationRef: 'request', requestId: 'request' });
  assert.deepEqual(await projection.settle(context, 'request', { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUnits: 1,
    state: 'settled', reservationRef: 'request' }), { kind: 'settled', accountingRef: 'account' });
  assert.equal(tracker.getConsumed('task', 'tokens'), 30);
  assert.equal(tracker.getConsumed('task', 'cost'), 1);
  assert.equal(projection.productionEligible, false);
});

test('foreign accounting binding and forged admission reject before UC04 reservation effects', async () => {
  for (const [operation, receipt] of [[{ ...context, taskId: 'foreign' }, admission], [context, { ...admission, contextDigest: 'b'.repeat(64) }]] as const) {
    const { projection, tracker } = fixture();
    assert.deepEqual(await projection.reserve(operation, receipt, ceiling), { kind: 'failure', status: 'conflict',
      reasonCode: 'accounting-binding', eventRef: 'uc04-accounting' });
    assert.equal(tracker.getAvailable('task', 'tokens'), 1000);
    assert.equal(tracker.getAvailable('task', 'cost'), 20);
  }
});

test('settlement rejects unbound reservations, foreign contexts and replay without releasing another reservation', async () => {
  const { projection, tracker } = fixture();
  await projection.reserve(context, admission, ceiling);
  const usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUnits: 1, state: 'settled' as const, reservationRef: 'request' };
  for (const [operation, reference] of [[context, 'unknown'], [{ ...context, runId: 'foreign' }, 'request']] as const) {
    assert.deepEqual(await projection.settle(operation, reference, usage), { kind: 'failure', status: 'conflict',
      reasonCode: 'reservation-binding', eventRef: 'uc04-accounting' });
    assert.equal(tracker.getAvailable('task', 'tokens'), 850);
  }
  await projection.settle(context, 'request', usage);
  assert.deepEqual(await projection.settle(context, 'request', usage), { kind: 'failure', status: 'conflict',
    reasonCode: 'reservation-binding', eventRef: 'uc04-accounting' });
  assert.equal(tracker.getConsumed('task', 'tokens'), 30);
});

test('malformed usage retains full UC04 reservation ceiling and returns uncertainty', async () => {
  const { projection, tracker } = fixture();
  await projection.reserve(context, admission, ceiling);
  assert.deepEqual(await projection.settle(context, 'request', { inputTokens: 20, outputTokens: 10, totalTokens: 999,
    costUnits: 0, state: 'settled', reservationRef: 'request' }), { kind: 'failure', status: 'uncertain',
    reasonCode: 'usage-uncertain', eventRef: 'uc04-accounting' });
  assert.equal(tracker.getConsumed('task', 'tokens'), 150);
  assert.equal(tracker.getConsumed('task', 'cost'), 3);
});

test('missing usage is conservatively charged through actual UC04 accounting', async () => {
  const { projection, tracker } = fixture();
  await projection.reserve(context, admission, ceiling);
  // Exercise the runtime boundary; external adapters can violate their static return type.
  assert.deepEqual(await projection.settle(context, 'request', null as unknown as Usage), { kind: 'failure', status: 'uncertain',
    reasonCode: 'usage-uncertain', eventRef: 'uc04-accounting' });
  assert.equal(tracker.getConsumed('task', 'tokens'), 150);
  assert.equal(tracker.getConsumed('task', 'cost'), 3);
});

test('invalid ceiling and expired operation fail before changing UC04 ledgers', async () => {
  const { projection, tracker } = fixture();
  assert.deepEqual(await projection.reserve(context, admission, { ...ceiling, inputTokens: -10 }), { kind: 'failure',
    status: 'invalid-input', reasonCode: 'invalid-reservation-profile', eventRef: 'uc04-accounting' });
  const expired = { ...context, deadlineEpochMs: 100 };
  assert.deepEqual(await projection.reserve(expired, { ...admission, contextDigest: operationContextDigest(expired) }, ceiling), {
    kind: 'failure', status: 'timeout', reasonCode: 'deadline-exceeded', eventRef: 'uc04-accounting' });
  assert.equal(tracker.getAvailable('task', 'tokens'), 1000);
  assert.equal(tracker.getAvailable('task', 'cost'), 20);
});

test('UC04 reservation exhaustion stays exhausted and unavailable settlement stays uncertain with safe diagnostics', async () => {
  const { projection } = fixture();
  assert.deepEqual(await projection.reserve(context, admission, { ...ceiling, inputTokens: 900, outputTokens: 150, totalTokens: 1050 }), { kind: 'failure',
    status: 'exhausted', reasonCode: 'call-budget-exhausted', eventRef: 'uc04-accounting' });
  class InterruptedAdapter extends UC01AccountingAdapter {
    override async settle(): Promise<never> { throw new Error('private transport content'); }
  }
  const tracker = new BudgetTracker([
    { scope: 'task', kind: 'tokens', limit: 1000, consumed: 0, reservations: [], configurationId: 'config', version: 1 },
    { scope: 'task', kind: 'cost', limit: 20, consumed: 0, reservations: [], configurationId: 'config', version: 1 },
  ]);
  const interrupted = createUC04AccountingProjection(new InterruptedAdapter(tracker), context, () => 100);
  await interrupted.reserve(context, admission, ceiling);
  assert.deepEqual(await interrupted.settle(context, 'request', { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUnits: 1,
    state: 'settled', reservationRef: 'request' }), { kind: 'failure', status: 'uncertain', reasonCode: 'settlement-uncertain', eventRef: 'uc04-accounting' });
  assert.equal(tracker.getAvailable('task', 'tokens'), 850);
});

test('UC04 generic reservation-failed cannot be mistaken for proven budget exhaustion', async () => {
  const { projection } = fixture();
  assert.deepEqual(await projection.reserve(context, admission, { ...ceiling, costUnits: 21 }), { kind: 'failure',
    status: 'uncertain', reasonCode: 'reservation-uncertain', eventRef: 'uc04-accounting' });
});

test('Foundation SourceEvidence projection preserves canonical fields and requires independently verified locator', () => {
  const source = { path: 'src/auth.ts', revisionDigest: context.repositorySnapshotDigest, boundedExcerpt: 'return true;', resultCount: 1, truncated: true };
  const location = { repositoryId: context.repositoryId, snapshotDigest: context.repositorySnapshotDigest, path: 'src/auth.ts',
    fileDigest: 'b'.repeat(64), startLine: 5, endLine: 5 };
  assert.deepEqual(projectFoundationFinding(source, { location, safeExcerptRef: 'verified-excerpt', excerptDigest: sha256Text(source.boundedExcerpt), provenance: 'real' }, context),
    { source, location, safeExcerptRef: 'verified-excerpt', provenance: 'real' });
  assert.deepEqual(projectFoundationFinding(source, undefined, context), { kind: 'failure', status: 'error',
    reasonCode: 'repository-locator-required', eventRef: 'foundation-evidence' });
});

test('Foundation projection rejects stale snapshot, forged excerpt digest, protected content and invented line spans', () => {
  const source = { path: 'src/auth.ts', revisionDigest: context.repositorySnapshotDigest, boundedExcerpt: 'return true;', resultCount: 1, truncated: false };
  const location = { repositoryId: context.repositoryId, snapshotDigest: context.repositorySnapshotDigest, path: 'src/auth.ts',
    fileDigest: 'b'.repeat(64), startLine: 5, endLine: 5 };
  const receipt = { location, safeExcerptRef: 'verified-excerpt', excerptDigest: sha256Text(source.boundedExcerpt), provenance: 'real' };
  for (const [input, locator] of [
    [{ ...source, revisionDigest: 'c'.repeat(64) }, receipt],
    [source, { ...receipt, excerptDigest: 'd'.repeat(64) }],
    [source, { ...receipt, location: { ...location, endLine: 4 } }],
    [source, { ...receipt, location: { ...location, path: 'src/other.ts' } }],
    [{ ...source, path: '.env' }, { ...receipt, location: { ...location, path: '.env' } }],
  ] as const) {
    assert.deepEqual(projectFoundationFinding(input, locator, context), { kind: 'failure', status: 'error',
      reasonCode: 'repository-locator-required', eventRef: 'foundation-evidence' });
  }
});
