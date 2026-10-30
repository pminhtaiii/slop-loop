import assert from 'node:assert/strict';
import test from 'node:test';
import { composeIssueAssessor, COMPOSITION_VERSION, type AdapterDelivery, type CompositionConfiguration } from '../../../src/uc01/compose.ts';
import { fixtureLimits, sha256Text, type TrustedContext, type Usage } from '../../../src/uc01/contracts.ts';
import { UC01_PUBLIC_CASES, publicEvidenceForCase, trustedCatalogForCase } from '../support/uc01/fixtures.ts';
import { operationContextDigest, type OperationContext, type ModelRequest } from '../support/uc01/ports.ts';

function harness() {
  const selected = UC01_PUBLIC_CASES.find(item => item.caseId === 'UC-01:C02:all-users-locked-out'); assert.ok(selected);
  const invocation = selected.input.invocation;
  const context: TrustedContext = { taskId: invocation.taskId, runId: invocation.runId, repositoryId: invocation.repositoryId,
    workspaceId: 'workspace', repositorySnapshotDigest: selected.input.repositorySnapshotDigest, configId: 'real-config', configVersion: '1',
    policyId: 'policy', policyVersion: '1', catalog: trustedCatalogForCase(selected.caseId), limits: fixtureLimits, accountingRef: 'account',
    evidenceRegistry: publicEvidenceForCase(selected.caseId).filter(item => item.kind === 'reporter').map(item => ({ ...item, provenance: 'real' })), continuation: undefined };
  const calls: string[] = []; const settlements: Usage[] = [];
  const model = { async proposeAssessment(_operation: OperationContext, _admission: unknown, request: ModelRequest): Promise<unknown> {
    calls.push('model'); const evidenceId = request.evidence[0]?.evidence.id; assert.ok(evidenceId);
    const dimension = { summary: 'Reported widespread loss without workaround', known: true, evidenceIds: [evidenceId] };
    return { kind: 'assessment', proposal: { classification: { value: 'defect', assertionIds: ['report'] },
      severity: { value: 'P0', functionality: dimension, affectedUsers: dimension, workaround: dimension, assertionIds: ['report'] },
      destination: { value: 'undetermined', assertionIds: ['unknown'] },
      assertions: [{ id: 'report', text: 'Reporter claims existing sign-in is unavailable.', basis: 'fact', evidenceIds: [evidenceId] },
        { id: 'unknown', text: 'Destination unknown', basis: 'unknown', evidenceIds: [] }], uncertainties: ['Reporter-only'], evidenceIds: [evidenceId], questions: [] },
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUnits: 2, state: 'settled', reservationRef: request.reservationRef } };
  } };
  const components = {
    policy: { async guard(operation: OperationContext) { calls.push('guard'); return { kind: 'admitted', admissionRef: 'admission', requestId: operation.requestId, contextDigest: operationContextDigest(operation) }; } },
    accounting: { async reserve(operation: OperationContext) { calls.push('reserve'); return { kind: 'reserved', reservationRef: 'reservation', requestId: operation.requestId }; },
      async settle(_operation: OperationContext, _ref: string, usage: Usage) { calls.push('settle'); settlements.push(usage); return { kind: 'settled', accountingRef: 'account' }; } },
    model, repository: { async readEvidence(): Promise<unknown> { throw new Error('No read requested'); }, async searchEvidence(): Promise<unknown> { throw new Error('No search requested'); } },
    continuation: { async bindContinuation() { throw new Error('No questions'); }, async resolveContinuation() { throw new Error('No continuation'); } },
    telemetry: { async emitSafeEvent() { calls.push('event'); return { eventRef: 'event' }; } },
    excerpts: { resolveExcerpt(entry: { sourceRef: string }) { return entry.sourceRef === invocation.issue.id ? invocation.issue.originalReport : undefined; } },
  };
  const capabilities = { policy: ['bound-action-policy', 'current-snapshot', 'cumulative-operation-limits'],
    accounting: ['durable-task-run-reservation', 'uncertain-ceiling-retained', 'restart-reconciliation'], model: ['triage-role', 'bounded-provider-dispatch', 'usage-and-pricing'],
    repository: ['guarded-read-search', 'verified-locators', 'protected-content'], continuation: ['durable-immutable-binding'], telemetry: ['sanitized-events'], excerpts: ['digest-bound-excerpts'] };
  // Controlled adapters exercise admission/controller behavior; these receipts are synthetic, not real delivery evidence.
  const registry = Object.entries(components).map(([component, adapter]) => ({ id: component, component, adapter,
    contractVersion: 'uc01-consumer-v1', revision: 'a'.repeat(40), provenance: 'real', evidenceRef: 'controlled-conformance-only',
    capabilities: capabilities[component as keyof typeof capabilities] })) as AdapterDelivery[];
  const config: CompositionConfiguration = { version: COMPOSITION_VERSION,
    selected: { policy: 'policy', accounting: 'accounting', model: 'model', repository: 'repository', continuation: 'continuation', telemetry: 'telemetry', excerpts: 'excerpts' },
    profile: { profileId: 'uc01-production-v1', binding: context, catalogDigest: sha256Text(JSON.stringify(context.catalog)), limits: fixtureLimits,
      pricing: { pricingId: 'integer-pricing', inputRate: 1, outputRate: 2, denominator: 20 } },
    ceiling: { inputTokens: 500, outputTokens: 250, totalTokens: 750, costUnits: 50, pricingId: 'integer-pricing' } };
  return { invocation, context, config, registry, calls, settlements, components };
}

test('C20 admitted production profile uses explicit pricing and real provenance', async () => {
  const h = harness(); const composed = composeIssueAssessor(h.config, h.registry, () => 100);
  assert.equal(composed.status, 'ready'); if (composed.status !== 'ready') return;
  const result = await composed.assessor.assessIssue(h.invocation, h.context);
  assert.equal(result.status, 'assessed');
  if (result.status === 'assessed') assert.equal(result.assessment.provenance, 'real');
  assert.equal(h.settlements[0]?.costUnits, 2);
});

for (const component of ['policy', 'accounting', 'model', 'repository', 'continuation', 'telemetry', 'excerpts'] as const) {
  for (const defect of ['missing', 'mock', 'version', 'revision', 'capability', 'evidence', 'method'] as const) {
    test(`C20 rejects ${component} ${defect} before component effects`, () => {
      const h = harness();
      const registry = h.registry.flatMap(delivery => {
        if (delivery.component !== component) return [delivery];
        if (defect === 'missing') return [];
        return [{ ...delivery, ...(defect === 'mock' ? { provenance: 'mock' } : defect === 'version' ? { contractVersion: 'wrong-version' }
          : defect === 'revision' ? { revision: 'unversioned' } : defect === 'capability' ? { capabilities: [] }
            : defect === 'evidence' ? { evidenceRef: '' } : { adapter: {} }) }];
      });
      assert.equal(composeIssueAssessor(h.config, registry as AdapterDelivery[]).status, 'denied');
      assert.deepEqual(h.calls, []);
    });
  }
}

for (const field of ['workspaceId', 'policyVersion', 'configVersion', 'accountingRef', 'runId', 'repositorySnapshotDigest'] as const) {
  test(`C20 context drift in ${field} refuses before guard/reservation/provider`, async () => {
    const h = harness(); const composed = composeIssueAssessor(h.config, h.registry, () => 100); assert.equal(composed.status, 'ready');
    if (composed.status !== 'ready') return;
    const changed = { ...h.context, [field]: field === 'repositorySnapshotDigest' ? 'b'.repeat(64) : 'changed' };
    const result = await composed.assessor.assessIssue(h.invocation, changed);
    assert.notEqual(result.status, 'assessed'); assert.deepEqual(h.calls, ['event']);
  });
}

test('C20 mock evidence cannot be relabelled as real through composition', async () => {
  const h = harness(); const composed = composeIssueAssessor(h.config, h.registry, () => 100); assert.equal(composed.status, 'ready');
  if (composed.status !== 'ready') return;
  const result = await composed.assessor.assessIssue(h.invocation, { ...h.context,
    evidenceRegistry: h.context.evidenceRegistry.map(entry => ({ ...entry, provenance: 'mock' })) });
  assert.equal(result.status, 'denied'); assert.deepEqual(h.calls, ['event']);
});

test('C20 unpriced usage retains the full ceiling and cannot become an assessment', async () => {
  const h = harness();
  const propose = h.components.model.proposeAssessment;
  h.components.model.proposeAssessment = async (...args) => {
    const response = await propose(...args);
    assert.ok(response && typeof response === 'object' && 'usage' in response);
    return { ...response, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUnits: 30, state: 'settled', reservationRef: 'reservation' } };
  };
  const composed = composeIssueAssessor(h.config, h.registry, () => 100); assert.equal(composed.status, 'ready');
  if (composed.status !== 'ready') return;
  const result = await composed.assessor.assessIssue(h.invocation, h.context);
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(h.settlements[0], { inputTokens: 500, outputTokens: 250, totalTokens: 750, costUnits: 50, state: 'uncertain', reservationRef: 'reservation' });
});

test('C20 replacing an admitted registry method cannot replace the captured provider', async () => {
  const h = harness(); const composed = composeIssueAssessor(h.config, h.registry, () => 100); assert.equal(composed.status, 'ready');
  if (composed.status !== 'ready') return;
  h.components.model.proposeAssessment = async () => { throw new Error('replacement must not run'); };
  assert.equal((await composed.assessor.assessIssue(h.invocation, h.context)).status, 'assessed');
});

test('C20 catalog changes under an unchanged config identity refuse before constrained activity', async () => {
  const h = harness(); const composed = composeIssueAssessor(h.config, h.registry, () => 100); assert.equal(composed.status, 'ready');
  if (composed.status !== 'ready') return;
  const result = await composed.assessor.assessIssue(h.invocation, { ...h.context, catalog: { ...h.context.catalog, destinations: [] } });
  assert.equal(result.status, 'denied'); assert.deepEqual(h.calls, ['event']);
});

test('C20 real read evidence preserves source provenance and independently supplied locator', async () => {
  const h = harness(); const propose = h.components.model.proposeAssessment; let turns = 0;
  h.components.model.proposeAssessment = async (...args) => {
    if (turns++ > 0) { assert.equal(args[2].evidence.at(-1)?.evidence.provenance, 'real'); return propose(...args); }
    return { kind: 'tool-request', request: { kind: 'read', path: 'src/auth.ts' },
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUnits: 2, state: 'settled', reservationRef: 'reservation' } };
  };
  h.components.repository.readEvidence = async () => ({ kind: 'read', finding: {
    source: { path: 'src/auth.ts', revisionDigest: h.context.repositorySnapshotDigest, boundedExcerpt: 'Approved source', resultCount: 1, truncated: false },
    location: { repositoryId: h.context.repositoryId, snapshotDigest: h.context.repositorySnapshotDigest, path: 'src/auth.ts', fileDigest: 'f'.repeat(64), startLine: 1, endLine: 1 },
    safeExcerptRef: 'source-excerpt', provenance: 'real',
  } });
  h.components.excerpts.resolveExcerpt = entry => entry.sourceRef === h.invocation.issue.id ? h.invocation.issue.originalReport : 'Approved source';
  const composed = composeIssueAssessor(h.config, h.registry, () => 100); assert.equal(composed.status, 'ready');
  if (composed.status !== 'ready') return;
  const result = await composed.assessor.assessIssue(h.invocation, h.context);
  assert.equal(result.status, 'assessed'); assert.equal(turns, 2);
});

test('C20 current registry cannot upgrade an explicitly mock component', () => {
  const h = harness(); Object.assign(h.components.model, { provenance: 'mock' });
  assert.equal(composeIssueAssessor(h.config, h.registry).status, 'denied'); assert.deepEqual(h.calls, []);
});

test('C20 non-production accounting projection is rejected despite an asserted real receipt', () => {
  const h = harness(); Object.assign(h.components.accounting, { productionEligible: false });
  assert.equal(composeIssueAssessor(h.config, h.registry).status, 'denied'); assert.deepEqual(h.calls, []);
});

test('production invocation stops before a reservation can exceed cumulative token allowance', async () => {
  const h = harness(); const limits = { ...fixtureLimits, inputTokens: 1000, outputTokens: 500, totalTokens: 1500 };
  h.components.model.proposeAssessment = async (_operation, _admission, request) => ({ kind: 'tool-request', request: { kind: 'search', query: 'auth' },
    usage: { inputTokens: 500, outputTokens: 250, totalTokens: 750, costUnits: 50, state: 'settled', reservationRef: request.reservationRef } });
  h.components.repository.searchEvidence = async () => ({ kind: 'search', findings: [], truncated: false });
  const composed = composeIssueAssessor({ ...h.config, profile: { ...h.config.profile, limits } }, h.registry, () => 100);
  assert.equal(composed.status, 'ready'); if (composed.status !== 'ready') return;
  const result = await composed.assessor.assessIssue(h.invocation, { ...h.context, limits });
  assert.equal(result.status, 'exhausted');
  assert.equal(h.calls.filter(call => call === 'reserve').length, 2);
});
