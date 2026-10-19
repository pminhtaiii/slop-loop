import assert from 'node:assert/strict';
import test from 'node:test';
import { type ApprovalBindingContext, type ReviewResult, computeCanonicalSha256, validateReviewResult } from '../../../src/contracts/foundation/uc03.ts';
import { MemoryStatePort } from '../support/uc03/memory-state.ts';
import { ScriptedApprovalPort } from '../support/uc03/scripted-approval.ts';
import { ScriptedModelPort } from '../support/uc03/scripted-model.ts';
import { ScriptedReviewerPort } from '../support/uc03/scripted-reviewer.ts';
import { FakeRepositoryPort } from '../support/uc03/fake-repository.ts';
import { createTestTaskState, createTestApprovalBinding, createTestProviderUsage } from '../support/uc03/state-fixtures.ts';
import { createFixtureAdmissionContext, createFixtureReviewerRequest, createFixtureTaskState, createFixtureBugTask, createFixtureCheckDefinition } from '../support/uc03/port-fixtures.ts';

type Scenario = 'missing' | 'exhausted' | 'malformed' | 'stale' | 'valid';
interface Profile { readonly name: string; readonly cases: Partial<Record<Scenario, () => Promise<void>>> }

const binding = createTestApprovalBinding({ status: 'approved' });
const freshness: ApprovalBindingContext = { currentTaskId: binding.taskId, currentWorkspaceId: binding.workspaceId, currentRepositoryRevisionDigest: binding.repositoryRevisionDigest, currentPolicyId: binding.policyId, currentPolicyVersion: binding.policyVersion, currentNormalizedActionDigest: binding.normalizedActionDigest };
const profiles: readonly Profile[] = [
  { name: 'state', cases: {
    missing: async () => { await assert.rejects(new MemoryStatePort().recover('missing'), /No checkpoint/); },
    exhausted: async () => { const state = createTestTaskState(); const port = new MemoryStatePort({ initialTaskState: state }); await assert.rejects(port.reserve('task', 'replan', 4, 'over-limit')); },
    malformed: async () => { const state = createTestTaskState(); await assert.rejects(new MemoryStatePort().transition({ ...state, stateVersion: NaN }, 0)); },
    stale: async () => {
      const state = createTestTaskState(); const port = new MemoryStatePort({ initialTaskState: state });
      await port.transition({ ...state, stateVersion: 2, node: 'Investigate' }, 1);
      await assert.rejects(port.transition({ ...state, stateVersion: 2, node: 'Investigate' }, 1));
      assert.equal((await port.recover(state.taskId)).stateVersion, 1, 'uncheckpointed live state is not recovery evidence');
    },
    valid: async () => {
      const state = createTestTaskState();
      const reservation = { proposalId: 'strategy', taskId: state.taskId, configurationId: state.taskContext?.configId ?? '', priorCount: 0, nextCount: 1, reservationId: 'res-task-replan-strategy' };
      const port = new MemoryStatePort({ initialTaskState: state, transitionContexts: { 2: { replanReservation: reservation } } });
      await port.reserve('task', 'tokens', 100, 'provider');
      await port.settle('provider', createTestProviderUsage({ inputTokens: 1, outputTokens: 0, billableTokens: 1 }));
      await port.reserve('task', 'replan', 1, 'strategy');
      const loaded = await port.loadTask(state.taskId); assert.ok(loaded);
      const next = { ...loaded, stateVersion: 2, node: 'Investigate' as const, replanCount: 1, planVersion: 2 };
      await port.transition(next, 1); await port.checkpoint(next);
      assert.equal((await port.recover(state.taskId)).budgetLedgers?.find(l => l.scope === 'task' && l.kind === 'tokens')?.consumed, 1);
      await assert.rejects(port.transition(next, 1), /CAS/);
      await assert.rejects(port.checkpoint(state));
    },
  } },
  // Decisions are identity-keyed, not consumable queues: exhaustion does not apply.
  { name: 'approval', cases: {
    missing: async () => { await assert.rejects(new ScriptedApprovalPort().requestDecision(binding), /Unscripted/); },
    malformed: async () => { assert.throws(() => new ScriptedApprovalPort({ decisions: [{ ...binding, decisionId: '' }] })); },
    stale: async () => { const port = new ScriptedApprovalPort({ decisions: [binding] }); assert.equal(await port.validateBinding(binding, { ...freshness, currentPolicyVersion: 'stale' }), false); },
    valid: async () => { const port = new ScriptedApprovalPort({ decisions: [binding], currentContext: freshness }); assert.equal(await port.validateBinding(await port.requestDecision(binding)), true); },
  } },
  { name: 'repository', cases: {
    missing: async () => { await assert.rejects(new FakeRepositoryPort().runTests(createFixtureCheckDefinition()), /SCRIPT_EXHAUSTED/); },
    exhausted: async () => { const port = new FakeRepositoryPort(); const check = createFixtureCheckDefinition(); port.setTestResult(check.checkId, { checkId: check.checkId, outcome: 'pass', durationMs: 1 }); await port.runTests(check); await assert.rejects(port.runTests({ ...check, checkId: 'not-scripted' }), /SCRIPT_EXHAUSTED/); },
    malformed: async () => { const port = new FakeRepositoryPort({ testResults: { default: { checkId: 'check', outcome: 'pass', durationMs: -1 } } }); await assert.rejects(port.runTests(createFixtureCheckDefinition()), /INVALID_CHECK_RESULT/); },
    stale: async () => { const port = new FakeRepositoryPort(); const before = port.currentRevision; const result = await port.applyPatch({ actionId: 'patch', kind: 'apply_patch', baseRevisionDigest: 'sha256:stale', targetPaths: ['src/a.py'], patchContent: 'change' }); assert.equal(result.applied, false); assert.equal(port.currentRevision, before); },
    valid: async () => { const check = createFixtureCheckDefinition(); const port = new FakeRepositoryPort({ testResults: { [check.checkId]: { checkId: check.checkId, outcome: 'pass', durationMs: 1 } } }); assert.equal((await port.runTests(check)).outcome, 'pass'); },
  } },
];

for (const role of ['coder', 'reviewer'] as const) {
  for (const scenario of ['missing', 'exhausted', 'malformed', 'stale', 'valid'] as const) {
    test(`port conformance: ${role} / ${scenario}`, async () => {
      const { context, request } = createFixtureAdmissionContext(role === 'reviewer' ? { request: createFixtureReviewerRequest() } : undefined);
      if (role === 'coder') {
        const port = new ScriptedModelPort({ admissionContext: context });
        if (scenario !== 'missing') port.queueResponse(scenario === 'malformed'
          ? { outcome: 'invalid', errors: [{ path: 'proposal', code: 'INVALID', message: 'scripted invalid output' }], observedUsage: createTestProviderUsage() }
          : { outcome: 'observed', result: { proposal: { proposalId: 'proposal', content: 'explicit' }, observedUsage: createTestProviderUsage() } });
        const invoke = (): ReturnType<ScriptedModelPort['propose']> => port.propose(createFixtureTaskState(), [], scenario === 'stale' ? { ...request, configId: 'stale' } : request);
        const first = await invoke();
        assert.equal(first.outcome, scenario === 'missing' || scenario === 'stale' ? 'denied' : scenario === 'malformed' ? 'invalid' : 'observed');
        if (scenario === 'exhausted') assert.equal((await invoke()).outcome, 'denied');
        assert.equal(port.simulatedDispatches, scenario === 'missing' || scenario === 'stale' ? 0 : 1);
      } else {
        const task = createFixtureBugTask(); const port = new ScriptedReviewerPort({ admissionContext: context });
        const response: ReviewResult = { reviewId: scenario === 'malformed' ? '' : 'review', reviewerRoleConfigId: request.configId, repoDigest: task.initialRevisionDigest, diffDigest: computeCanonicalSha256('diff'), checkSetDigest: computeCanonicalSha256(task.requiredChecks.map(c => c.checkId)), status: 'accepted', findings: [], iterationReservationRef: request.reservationRef };
        if (scenario !== 'missing') port.queueResponse(response);
        const invoke = (): ReturnType<ScriptedReviewerPort['review']> => port.review(task, 'diff', [], scenario === 'stale' ? { ...request, configId: 'stale' } : request);
        if (scenario === 'missing' || scenario === 'stale') await assert.rejects(invoke());
        else {
          const result = await invoke();
          assert.equal(validateReviewResult(result).ok, scenario !== 'malformed', 'malformed scripted fixtures must still be rejected by the canonical consumer validator');
          if (scenario === 'exhausted') await assert.rejects(invoke(), /SCRIPT_EXHAUSTED/);
        }
        assert.equal(port.simulatedDispatches, scenario === 'missing' || scenario === 'stale' ? 0 : 1);
      }
    });
  }
}
for (const profile of profiles) {
  for (const [scenario, run] of Object.entries(profile.cases)) test(`port conformance: ${profile.name} / ${scenario}`, run);
}
