import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ApprovalBindingContext,
  type ReviewResult,
  type ApplyPatchAction,
  type NormalizedAction,
  computeCanonicalSha256,
  computeActionDigest,
  validateReviewResult,
  type RepositoryAdmissionContextV02,
  type ProviderAdmissionContextV02,
} from '../../../src/contracts/foundation/uc03.ts';
import { MemoryStatePort } from '../support/uc03/memory-state.ts';
import { ScriptedApprovalPort, ScriptedApprovalPortV02 } from '../support/uc03/scripted-approval.ts';
import { ScriptedModelPort, ScriptedModelPortV02 } from '../support/uc03/scripted-model.ts';
import { ScriptedReviewerPort, ScriptedReviewerPortV02 } from '../support/uc03/scripted-reviewer.ts';
import { FakeRepositoryPort, FakeRepositoryPortV02 } from '../support/uc03/fake-repository.ts';
import { createTestTaskState, createTestApprovalBinding, createTestProviderUsage } from '../support/uc03/state-fixtures.ts';
import {
  createFixtureAdmissionContext,
  createFixtureReviewerRequest,
  createFixtureProviderRequest,
  createFixtureTaskState,
  createFixtureBugTask,
  createFixtureCheckDefinition,
  createFixtureProviderAdmissionContextV02,
  createFixtureRepositoryAdmissionContextV02,
  createFixturePolicyAuthorityRefV02,
  createFixturePolicyEvaluationReceiptV02,
  createFixtureActionDecisionReceiptV02,
  createFixtureRepositoryCommandAdmissionContextV02,
} from '../support/uc03/port-fixtures.ts';

// ============================================================================
// v0.1 Compatibility Port Conformance Tests
// ============================================================================

type Scenario = 'missing' | 'exhausted' | 'malformed' | 'stale' | 'valid';
interface Profile { readonly name: string; readonly cases: Partial<Record<Scenario, () => Promise<void>>> }

const binding = createTestApprovalBinding({ status: 'approved' });
const freshness: ApprovalBindingContext = {
  currentTaskId: binding.taskId,
  currentWorkspaceId: binding.workspaceId,
  currentRepositoryRevisionDigest: binding.repositoryRevisionDigest,
  currentPolicyId: binding.policyId,
  currentPolicyVersion: binding.policyVersion,
  currentNormalizedActionDigest: binding.normalizedActionDigest,
};

const v01Profiles: readonly Profile[] = [
  {
    name: 'state',
    cases: {
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
    },
  },
  {
    name: 'approval',
    cases: {
      missing: async () => { await assert.rejects(new ScriptedApprovalPort().requestDecision(binding), /Unscripted/); },
      malformed: async () => { assert.throws(() => new ScriptedApprovalPort({ decisions: [{ ...binding, decisionId: '' }] })); },
      stale: async () => { const port = new ScriptedApprovalPort({ decisions: [binding] }); assert.equal(await port.validateBinding(binding, { ...freshness, currentPolicyVersion: 'stale' }), false); },
      valid: async () => { const port = new ScriptedApprovalPort({ decisions: [binding], currentContext: freshness }); assert.equal(await port.validateBinding(await port.requestDecision(binding)), true); },
    },
  },
  {
    name: 'repository',
    cases: {
      missing: async () => { await assert.rejects(new FakeRepositoryPort().runTests(createFixtureCheckDefinition()), /SCRIPT_EXHAUSTED/); },
      exhausted: async () => { const port = new FakeRepositoryPort(); const check = createFixtureCheckDefinition(); port.setTestResult(check.checkId, { checkId: check.checkId, outcome: 'pass', durationMs: 1 }); await port.runTests(check); await assert.rejects(port.runTests({ ...check, checkId: 'not-scripted' }), /SCRIPT_EXHAUSTED/); },
      malformed: async () => { const port = new FakeRepositoryPort({ testResults: { default: { checkId: 'check', outcome: 'pass', durationMs: -1 } } }); await assert.rejects(port.runTests(createFixtureCheckDefinition()), /INVALID_CHECK_RESULT/); },
      stale: async () => { const port = new FakeRepositoryPort(); const before = port.currentRevision; const result = await port.applyPatch({ actionId: 'patch', kind: 'apply_patch', baseRevisionDigest: 'sha256:stale', targetPaths: ['src/a.py'], patchContent: 'change' }); assert.equal(result.applied, false); assert.equal(port.currentRevision, before); },
      valid: async () => { const check = createFixtureCheckDefinition(); const port = new FakeRepositoryPort({ testResults: { [check.checkId]: { checkId: check.checkId, outcome: 'pass', durationMs: 1 } } }); assert.equal((await port.runTests(check)).outcome, 'pass'); },
    },
  },
];

for (const role of ['coder', 'reviewer'] as const) {
  for (const scenario of ['missing', 'exhausted', 'malformed', 'stale', 'valid'] as const) {
    test(`[v0.1 compatibility] port conformance: ${role} / ${scenario}`, async () => {
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

for (const profile of v01Profiles) {
  for (const [scenario, run] of Object.entries(profile.cases)) {
    test(`[v0.1 compatibility] port conformance: ${profile.name} / ${scenario}`, run);
  }
}

// ============================================================================
// v0.2 Port Conformance Matrix Tests (T053 / T054)
// ============================================================================

for (const scenario of ['missing', 'exhausted', 'malformed', 'stale', 'valid'] as const) {
  test(`v0.2 port conformance: coder / ${scenario}`, async () => {
    const port = new ScriptedModelPortV02(new ScriptedModelPort());
    const request = createFixtureProviderRequest();
    const state = createFixtureTaskState();
    const validContext = createFixtureProviderAdmissionContextV02({ providerRequest: request });

    if (scenario === 'missing') {
      const res = await port.propose(state, [], request, undefined as unknown as ProviderAdmissionContextV02);
      assert.equal(res.outcome, 'denied');
      assert.equal(port.simulatedDispatches, 0);
    } else if (scenario === 'exhausted') {
      // Empty response queue
      const res = await port.propose(state, [], request, validContext);
      assert.equal(res.outcome, 'denied');
      assert.match(res.reason ?? '', /SCRIPT_EXHAUSTED/);
    } else if (scenario === 'malformed') {
      const malformedContext = { ...validContext, schemaVersion: 'invalid-version' } as unknown as ProviderAdmissionContextV02;
      const res = await port.propose(state, [], request, malformedContext);
      assert.equal(res.outcome, 'denied');
      assert.equal(port.simulatedDispatches, 0);
    } else if (scenario === 'stale') {
      const staleContext = createFixtureProviderAdmissionContextV02({
        providerRequest: createFixtureProviderRequest({ providerRequestId: 'other-id' }),
      });
      const res = await port.propose(state, [], request, staleContext);
      assert.equal(res.outcome, 'denied');
      assert.equal(port.simulatedDispatches, 0);
    } else {
      // valid
      port.queueResponse({
        outcome: 'observed',
        result: { proposal: { proposalId: 'p1', content: 'fix' }, observedUsage: createTestProviderUsage() },
      });
      const res = await port.propose(state, [], request, validContext);
      assert.equal(res.outcome, 'observed');
      assert.equal(port.simulatedDispatches, 1);
    }
  });

  test(`v0.2 port conformance: reviewer / ${scenario}`, async () => {
    const port = new ScriptedReviewerPortV02(new ScriptedReviewerPort());
    const request = createFixtureReviewerRequest();
    const task = createFixtureBugTask();
    const diff = 'diff content';
    const validContext = createFixtureProviderAdmissionContextV02({
      providerRequest: request,
      role: 'reviewer',
    });

    if (scenario === 'missing') {
      await assert.rejects(
        async () => port.review(task, diff, [], request, undefined as unknown as ProviderAdmissionContextV02),
        /MISSING_ADMISSION_CONTEXT/
      );
      assert.equal(port.simulatedDispatches, 0);
    } else if (scenario === 'exhausted') {
      // No scripted response queued
      await assert.rejects(
        async () => port.review(task, diff, [], request, validContext),
        /SCRIPT_EXHAUSTED/
      );
    } else if (scenario === 'malformed') {
      const malformedContext = { ...validContext, schemaVersion: 'bad' } as unknown as ProviderAdmissionContextV02;
      await assert.rejects(
        async () => port.review(task, diff, [], request, malformedContext),
        /INVALID_ADMISSION_CONTEXT/
      );
      assert.equal(port.simulatedDispatches, 0);
    } else if (scenario === 'stale') {
      const staleContext = createFixtureProviderAdmissionContextV02({
        providerRequest: createFixtureReviewerRequest({ providerRequestId: 'mismatched-id' }),
        role: 'reviewer',
      });
      await assert.rejects(
        async () => port.review(task, diff, [], request, staleContext),
        /CONTEXT_IDENTITY_MISMATCH/
      );
      assert.equal(port.simulatedDispatches, 0);
    } else {
      // valid
      port.queueResponse({
        reviewId: 'rev-01',
        reviewerRoleConfigId: request.configId,
        repoDigest: task.initialRevisionDigest,
        diffDigest: computeCanonicalSha256(diff),
        checkSetDigest: computeCanonicalSha256([]),
        status: 'accepted',
        findings: [],
        iterationReservationRef: request.reservationRef,
      });
      const res = await port.review(task, diff, [], request, validContext);
      assert.equal(res.status, 'accepted');
      assert.equal(port.simulatedDispatches, 1);
    }
  });

  test(`v0.2 port conformance: repository / ${scenario}`, async () => {
    const underlying = new FakeRepositoryPort();
    const port = new FakeRepositoryPortV02(underlying);
    const patch: ApplyPatchAction = {
      actionId: 'patch-conf',
      kind: 'apply_patch',
      patchContent: '+change',
      targetPaths: ['src/calculator.py'],
      baseRevisionDigest: port.currentRevision,
    };
    const validContext = createFixtureRepositoryAdmissionContextV02({
      action: patch,
      canonicalRevision: port.currentRevision,
    });

    if (scenario === 'missing') {
      const res = await port.applyPatch(patch, {} as unknown as RepositoryAdmissionContextV02);
      assert.equal(res.applied, false);
      assert.deepEqual(underlying.patches, []);
    } else if (scenario === 'exhausted') {
      const check = createFixtureCheckDefinition({ checkId: 'unscripted' });
      const action: NormalizedAction = {
        actionId: check.checkId,
        kind: 'run_command',
        executable: check.executable,
        argv: check.argv,
        workingDirectory: check.workingDirectory ?? '',
        ...(check.purpose !== undefined ? { purpose: check.purpose } : {}),
      };
      const commandContext = createFixtureRepositoryCommandAdmissionContextV02({
        action,
        canonicalRevision: port.currentRevision,
        checkId: check.checkId,
      });
      await assert.rejects(
        async () => port.runTests(check, commandContext),
        /SCRIPT_EXHAUSTED/
      );
    } else if (scenario === 'malformed') {
      const malformedContext = { ...validContext, schemaVersion: '0.1.0' } as unknown as RepositoryAdmissionContextV02;
      const res = await port.applyPatch(patch, malformedContext);
      assert.equal(res.applied, false);
    } else if (scenario === 'stale') {
      const staleContext = createFixtureRepositoryAdmissionContextV02({
        canonicalRevision: 'sha256:stale-rev',
      });
      const res = await port.applyPatch(patch, staleContext);
      assert.equal(res.applied, false);
    } else {
      // valid
      const res = await port.applyPatch(patch, validContext);
      assert.equal(res.applied, true);
      assert.equal(underlying.patches.length, 1);
    }
  });

  test(`v0.2 port conformance: approval / ${scenario}`, async () => {
    const action: NormalizedAction = {
      actionId: `approval-${scenario}`,
      kind: 'run_command',
      executable: 'pytest',
      argv: [],
      workingDirectory: 'tests',
    };
    const auth = createFixturePolicyAuthorityRefV02({ decisionAuthorityGeneration: 1 });
    const context = createFixtureRepositoryCommandAdmissionContextV02({
      action,
      canonicalRevision: 'sha256:current-policy-revision',
      policyAuthorityRef: auth,
    });
    const evaluation = createCurrentPolicyEvaluation(action, context, auth, 'APPROVAL_REQUIRED');

    if (scenario === 'missing') {
      const port = new ScriptedApprovalPortV02(new ScriptedApprovalPort({ v02Evaluations: [evaluation] }));
      await assert.rejects(port.evaluatePolicyV02(action, context), /MISSING_CURRENT_AUTHORITY/);
      assert.equal(await port.validateBindingV02(evaluation), false);
    } else if (scenario === 'exhausted') {
      const port = new ScriptedApprovalPortV02(new ScriptedApprovalPort({ v02AuthorityRef: auth, v02Evaluations: [evaluation] }));
      assert.strictEqual(await port.evaluatePolicyV02(action, context), evaluation);
      await assert.rejects(port.requestDecisionV02(evaluation), /UNSCRIPTED_CURRENT_DECISION/);
    } else if (scenario === 'malformed') {
      const port = new ScriptedApprovalPortV02(new ScriptedApprovalPort({ v02AuthorityRef: auth, v02Evaluations: [evaluation] }));
      const malformed = { ...evaluation, receiptDigest: 'sha256:malformed' };
      assert.equal(await port.validateBindingV02(malformed, auth), false);
    } else if (scenario === 'stale') {
      const staleAuth = createFixturePolicyAuthorityRefV02({ decisionAuthorityGeneration: 2 });
      const port = new ScriptedApprovalPortV02(new ScriptedApprovalPort({ v02AuthorityRef: auth, v02Evaluations: [evaluation] }));
      assert.equal(await port.validateBindingV02(evaluation, staleAuth), false);
    } else {
      const decision = createFixtureActionDecisionReceiptV02({
        decisionId: `decision-${scenario}`,
        actionDigest: evaluation.actionDigest,
        evaluationReceiptRef: evaluation.receiptId,
        decisionAuthorityGeneration: evaluation.decisionAuthorityGeneration,
      });
      const port = new ScriptedApprovalPortV02(new ScriptedApprovalPort({
        v02AuthorityRef: auth,
        v02Evaluations: [evaluation],
        v02Decisions: [decision],
      }));
      assert.strictEqual(await port.evaluatePolicyV02(action, context), evaluation);
      assert.strictEqual(await port.requestDecisionV02(evaluation), decision);
      assert.equal(await port.validateBindingV02(decision, auth), true);
    }
  });
}

function createCurrentPolicyEvaluation(
  action: NormalizedAction,
  context: RepositoryAdmissionContextV02,
  authority: ReturnType<typeof createFixturePolicyAuthorityRefV02>,
  result: 'ALLOWED' | 'APPROVAL_REQUIRED' | 'FORBIDDEN',
) {
  const actionDigest = computeActionDigest(action);
  return createFixturePolicyEvaluationReceiptV02({
    receiptId: `policy-${action.actionId}`,
    actionDigest,
    freshnessContextDigest: computeCanonicalSha256({
      actionDigest,
      canonicalRevision: context.canonicalRevision,
      policyAuthorityRef: authority,
    }),
    policyId: authority.policyId,
    policyVersion: authority.policyVersion,
    configId: authority.configId,
    configVersion: authority.configVersion,
    decisionAuthorityGeneration: authority.decisionAuthorityGeneration,
    result,
  });
}
