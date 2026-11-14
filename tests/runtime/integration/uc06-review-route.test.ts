import assert from 'node:assert/strict';
import test from 'node:test';
import { controlledGeneratedPlanFixture } from '../support/uc03/controlled-host-journey.ts';
import { prepareControlledUC03Host } from '../../../src/runtime/uc03-host-bootstrap.ts';
import { runControlledUC03GraphV02 } from '../../../src/uc03/graph-v02.ts';
import { controlledReviewFixture, controlledReviewCompletion } from '../support/uc06/review-evidence.ts';
import type { ReviewEvidencePortV1, PersistReviewObservationRequestV1, LoadReviewObservationRequestV1, ReviewEvidenceFoundV1 } from '../../../src/contracts/review.ts';
import { computeCanonicalSha256 as hash, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { createRuntimeReviewer } from '../../../src/foundation/reviewer.ts';

type Fixture = Awaited<ReturnType<typeof controlledGeneratedPlanFixture>>;
async function approve(fixture: Fixture) {
  const ready = prepareControlledUC03Host(fixture.host.inputs);
  assert.equal(ready.status, 'controlled-ready');
  if (ready.status !== 'controlled-ready') throw new Error('missing controlled ports');
  await runControlledUC03GraphV02(fixture.task, ready.ports, ready.config);
  for (const prefix of ['dec-plan-', 'dec-verify-']) {
    const decision = fixture.route.approvalPort.getRecordedBindings().find(binding => binding.decisionId.startsWith(prefix));
    assert.ok(decision);
    const owner = await fixture.statePort.readVerificationAuthoritySnapshot(fixture.task.taskId);
    assert.ok(owner);
    const authorityRef = { ...owner.policyIdentity, decisionAuthorityGeneration: owner.decisionAuthorityGeneration + 1 };
    assert.equal((await fixture.statePort.publishAuthority({ authorityRef })).status, 'published');
    fixture.route.approvalPort.setV02AuthorityRef(authorityRef);
    fixture.route.approvalPort.scriptDecision({ ...decision, status: 'approved' });
    if (prefix === 'dec-plan-') assert.equal((await runControlledUC03GraphV02(fixture.task, ready.ports, ready.config)).outcome, 'pending-approval');
  }
  fixture.route.repositoryPort.setCommandResult('pytest -q tests/test_calculator.py -k test_divide_zero', { exitCode: 0, stdout: '1 passed', stderr: '' });
  return ready;
}

test('opted-in actual graph refuses a missing observation owner before reviewer dispatch', async () => {
  const fixture = await controlledGeneratedPlanFixture();
  const ready = await approve(fixture);
  const result = await runControlledUC03GraphV02(fixture.task, ready.ports, { ...ready.config, reviewContext: () => undefined });
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(fixture.statePort.getJournalSnapshot().claims.filter(claim => claim.claimId.startsWith('claim-provider-')).length, 0);
  assert.equal((await fixture.statePort.loadTask(fixture.task.taskId))?.latestReviewRef, undefined);
});

async function approveReview(fixture: Awaited<ReturnType<typeof controlledReviewFixture>>) {
  const pending = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(pending.outcome, 'pending-approval', JSON.stringify(pending));
  const d1 = fixture.approval.getRecordedBindings().find(binding => binding.decisionId.startsWith('dec-verify-'));
  const owner = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(d1 && owner);
  const authorityRef = { ...owner.policyIdentity, decisionAuthorityGeneration: owner.decisionAuthorityGeneration + 1 };
  assert.equal((await fixture.owner.publishAuthority({ authorityRef })).status, 'published');
  fixture.approval.setV02AuthorityRef(authorityRef);
  fixture.approval.scriptDecision({ ...d1, status: 'approved' });
}

test('actual graph passes one prepared context through owner admission into reviewer/model/HTTP', async () => {
  const fixture = await controlledReviewFixture();
  await approveReview(fixture);
  const result = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(fixture.requests.length, 1, JSON.stringify(result));
  assert.equal(fixture.evidence.calls.filter(c => c.operation === 'persist').length, 1);
  assert.equal([...fixture.evidence.records.values()][0]?.observation.status, 'accepted');
  assert.ok(JSON.stringify(fixture.requests[0]).includes('review/context.json'));
  assert.equal(fixture.owner.getJournalSnapshot().claims.filter(c => c.claimId.startsWith('claim-bound-review-')).length, 1);
});

async function completingFixture() {
  const probe = await controlledReviewFixture();
  await approveReview(probe);
  const result = await runControlledUC03GraphV02(probe.task, probe.ports, probe.config);
  assert.equal(probe.evidence.records.size, 1, JSON.stringify({ reasons: result.reasons, calls: probe.evidence.calls, requests: probe.requests.length }));
  const fixture = await controlledReviewFixture(controlledReviewCompletion(probe));
  await approveReview(fixture);
  return fixture;
}

function resumeFromTaskState(fixture: Awaited<ReturnType<typeof controlledReviewFixture>>, state: TaskState) {
  const fresh = fixture.freshConsumer();
  return runControlledUC03GraphV02(fixture.task, fresh.ports, fresh.config, structuredClone(state));
}

test('Verify→Review→Deliver freshly loads acknowledged observation at both completion boundaries', async () => {
  const fixture = await completingFixture();
  const result = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(result.outcome, 'COMPLETED', JSON.stringify(result.reasons));
  assert.equal(result.state?.node, 'Deliver');
  assert.equal(result.finalReport?.isComplete, true);
  assert.equal(fixture.evidence.calls.filter(c => c.operation === 'load').length, 2);
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(await fixture.owner.loadTask(fixture.task.taskId), result.state);
  assert.deepEqual(fixture.contextPhases, ['prepare', 'completion', 'completion']);
  assert.equal(fixture.evidence.admissions.length, 1);
  const sent = fixture.requests[0] as { messages: { content: string }[] };
  const message = sent.messages[0];
  assert.ok(message);
  const user = JSON.parse(message.content) as { untrustedEvidence: { path: string; content: string }[]; request: { contextDigest: string } };
  assert.equal(user.untrustedEvidence.find(e => e.path === 'review/context.json')?.content, JSON.stringify(fixture.evidence.admissions[0]?.prepared.context));
  assert.equal(user.request.contextDigest, fixture.evidence.admissions[0]?.context.providerRequest.contextDigest);
});

test('lost ACK after atomic observation/index commit recovers from TaskState only without provider replay', async () => {
  const fixture = await completingFixture();
  fixture.evidence.loseAckOnce = true;
  const first = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(first.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(fixture.evidence.records.size, 1);
  const taskStateOnly = await fixture.owner.loadTask(fixture.task.taskId);
  assert.ok(taskStateOnly);
  assert.equal(taskStateOnly.node, 'Review');
  assert.equal(taskStateOnly.latestReviewRef, undefined);
  assert.equal(fixture.requests.length, 1);
  const charges = fixture.owner.getLedgers().map(l => ({ scope: l.scope, kind: l.kind, consumed: l.consumed, reservations: l.reservations }));
  const recovered = await resumeFromTaskState(fixture, taskStateOnly);
  assert.equal(recovered.outcome, 'COMPLETED', JSON.stringify(recovered.reasons));
  assert.equal(recovered.state?.node, 'Deliver');
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(
    fixture.owner.getLedgers().map(l => ({ scope: l.scope, kind: l.kind, consumed: l.consumed, reservations: l.reservations })),
    charges,
  );
  const discovery = fixture.evidence.calls.find(c => c.operation === 'recover')?.request;
  assert.ok(discovery && typeof discovery === 'object');
  assert.equal(Object.hasOwn(discovery, 'providerRequestId'), false);
  assert.equal(Object.hasOwn(discovery, 'contextDigest'), false);
  assert.equal(Object.hasOwn(discovery, 'observationDigest'), false);
});

for (const boundary of [0, 1]) {
  for (const material of ['profile', 'convention', 'source'] as const) {
    test(`${material} drift at completion lookup ${boundary + 1} cannot reuse the old acknowledgment`, async () => {
      const fixture = await completingFixture();
      const load = fixture.evidence.loadObservation.bind(fixture.evidence);
      let lookups = 0;
      fixture.evidence.loadObservation = async request => {
        const reply = await load(request);
        if (lookups++ === boundary) {
          if (material === 'profile') fixture.material.profile = { ...fixture.material.profile, profileVersion: '2' };
          else if (material === 'convention') fixture.material.convention = 'A different current approved convention.';
          else fixture.material.source = 'A different current selected source excerpt.';
        }
        return reply;
      };
      const result = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
      assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
      assert.notEqual(result.finalReport?.isComplete, true);
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.owner.getJournalSnapshot().claims.filter(c => c.claimId.startsWith('claim-bound-review-')).length, 1);
    });
  }
}

test('pause after owner commit cannot advance the graph CAS using the earlier acknowledgment', async () => {
  const fixture = await completingFixture();
  const persist = fixture.evidence.persistObservation.bind(fixture.evidence);
  fixture.evidence.persistObservation = async request => {
    const reply = await persist(request);
    assert.equal(await fixture.owner.setTaskControl(fixture.task.taskId, 'paused', 'pause-after-review-commit'), true);
    return reply;
  };
  const result = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal((await fixture.owner.loadTask(fixture.task.taskId))?.node, 'Review');
  assert.equal((await fixture.owner.loadTask(fixture.task.taskId))?.latestReviewRef, undefined);
  assert.equal(fixture.requests.length, 1);
});

function portAdapter(fixture: Awaited<ReturnType<typeof controlledReviewFixture>>): ReviewEvidencePortV1 {
  return {
    reviewEvidenceApiVersion: 'uc06-review-evidence/1',
    provenance: 'mock',
    persistObservation: r => fixture.evidence.persistObservation(r),
    loadObservation: r => fixture.evidence.loadObservation(r),
    recoverObservation: r => fixture.evidence.recoverObservation(r),
  };
}

for (const fault of ['wrong-version', 'wrong-tier', 'missing-method', 'missing-context', 'throw-context', 'wrong-prompt'] as const) {
  test(`bound graph refuses ${fault} with zero reviewer effects`, async () => {
    const fixture = await completingFixture();
    const port = portAdapter(fixture);
    const configured = { ...fixture.config };
    if (fault === 'wrong-version') configured.reviewEvidence = { ...port, reviewEvidenceApiVersion: 'other/1' } as unknown as ReviewEvidencePortV1;
    if (fault === 'wrong-tier') configured.reviewEvidence = { ...port, provenance: 'real' };
    if (fault === 'missing-method') configured.reviewEvidence = { ...port, recoverObservation: undefined } as unknown as ReviewEvidencePortV1;
    if (fault === 'missing-context') configured.reviewContext = () => undefined;
    if (fault === 'throw-context')
      configured.reviewContext = () => {
        throw new Error('controlled untrusted error payload');
      };
    if (fault === 'wrong-prompt') {
      const prompt = fixture.config.reviewPrompt;
      assert.ok(prompt);
      configured.reviewPrompt = { ...prompt, digest: hash('other template') };
    }
    const result = await runControlledUC03GraphV02(fixture.task, fixture.ports, configured);
    assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.evidence.records.size, 0);
    assert.equal(fixture.owner.getJournalSnapshot().claims.filter(c => c.claimId.startsWith('claim-bound-review-')).length, 0);
    assert.equal((await fixture.owner.loadTask(fixture.task.taskId))?.latestReviewRef, undefined);
    assert.equal(JSON.stringify(result).includes('untrusted error payload'), false);
  });
}

test('unknown observation commit retains operation uncertainty and refuses TaskState-only replay', async () => {
  const fixture = await completingFixture();
  fixture.evidence.skipCommitOnce = true;
  const persist = fixture.evidence.persistObservation.bind(fixture.evidence);
  let operationRef = '';
  fixture.evidence.persistObservation = async request => {
    const reply = await persist(request);
    if (reply.outcome === 'uncertain') operationRef = reply.operationRef;
    return reply;
  };
  const first = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(first.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(fixture.evidence.records.size, 0);
  const state = await fixture.owner.loadTask(fixture.task.taskId);
  assert.ok(state && operationRef);
  const written = fixture.evidence.calls.find(c => c.operation === 'persist')?.request as PersistReviewObservationRequestV1;
  const candidate = {
    taskId: state.taskId,
    workspaceId: state.workspaceId,
    repositoryId: state.repositoryId,
    headRevisionDigest: state.repositoryRevisionDigest,
    diffDigest: written.observation.binding.diffDigest,
    expectedAuthority: written.expectedAuthority,
    operationRef,
  };
  assert.deepEqual(await fixture.evidence.recoverObservation(candidate), { outcome: 'uncertain', operationRef });
  assert.equal((await fixture.evidence.recoverObservation({ ...candidate, operationRef: 'foreign-operation' })).outcome, 'denied');
  const resumed = await resumeFromTaskState(fixture, state);
  assert.equal(resumed.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(await fixture.owner.loadTask(fixture.task.taskId), state);
});

test('post-settlement pre-persist loss stays missing and preserves charges without dispatch or refund', async () => {
  const fixture = await completingFixture();
  fixture.evidence.loseBeforeCommitOnce = true;
  const first = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(first.outcome, 'IMPLEMENTED_UNVERIFIED');
  const state = await fixture.owner.loadTask(fixture.task.taskId);
  assert.ok(state);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.evidence.records.size, 0);
  assert.equal(fixture.owner.getLedgers().find(l => l.scope === 'task' && l.kind === 'tokens')?.consumed, 5);
  const second = await resumeFromTaskState(fixture, state);
  assert.equal(second.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(await fixture.owner.loadTask(fixture.task.taskId), state);
});

test('a lost graph CAS after acknowledged observation uses owner discovery without another provider call', async () => {
  const fixture = await completingFixture();
  const transition = fixture.owner.transition.bind(fixture.owner);
  let loseOnce = true;
  fixture.owner.transition = async (state, version) => {
    if (state.node === 'Deliver' && loseOnce) {
      loseOnce = false;
      throw new Error('controlled lost graph CAS');
    }
    return transition(state, version);
  };
  const first = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(first.outcome, 'IMPLEMENTED_UNVERIFIED');
  const state = await fixture.owner.loadTask(fixture.task.taskId);
  assert.ok(state);
  assert.equal(state.node, 'Review');
  assert.equal(state.latestReviewRef, undefined);
  const recovered = await resumeFromTaskState(fixture, state);
  assert.equal(recovered.outcome, 'COMPLETED', JSON.stringify(recovered.reasons));
  assert.equal(fixture.requests.length, 1);
});

test('TaskState-only Deliver consumer freshly rediscovers retained evidence with no model dispatch', async () => {
  const fixture = await completingFixture();
  assert.equal((await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config)).outcome, 'COMPLETED');
  const state = await fixture.owner.loadTask(fixture.task.taskId);
  assert.ok(state);
  const before = fixture.evidence.calls.filter(c => c.operation === 'load').length;
  const result = await resumeFromTaskState(fixture, state);
  assert.equal(result.outcome, 'COMPLETED', JSON.stringify(result.reasons));
  assert.ok(fixture.evidence.calls.filter(c => c.operation === 'load').length > before);
  assert.equal(fixture.requests.length, 1);
});

for (const fault of ['foreign-task', 'wrong-digest', 'unknown-field'] as const) {
  test(`forged persist acknowledgment ${fault} cannot authorize graph continuation`, async () => {
    const fixture = await completingFixture();
    const port = portAdapter(fixture);
    const configured = {
      ...fixture.config,
      reviewEvidence: {
        ...port,
        persistObservation: async (request: PersistReviewObservationRequestV1) => {
          const reply = await fixture.evidence.persistObservation(request);
          assert.equal(reply.outcome, 'acknowledged');
          if (reply.outcome !== 'acknowledged') return reply;
          const ack =
            fault === 'foreign-task' ? { ...reply.ack, taskId: 'foreign-task' } : fault === 'wrong-digest' ? { ...reply.ack, observationDigest: hash('other bytes') } : { ...reply.ack, extra: true };
          return { outcome: 'acknowledged' as const, ack };
        },
      },
    };
    const result = await runControlledUC03GraphV02(fixture.task, fixture.ports, configured);
    assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
    assert.equal((await fixture.owner.loadTask(fixture.task.taskId))?.node, 'Review');
    assert.equal((await fixture.owner.loadTask(fixture.task.taskId))?.latestReviewRef, undefined);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.owner.getLedgers().find(l => l.scope === 'task' && l.kind === 'tokens')?.consumed, 5);
  });
}

test('controlled observation owner replays exact bytes, conflicts on a reused key and rejects cross-candidate recovery', async () => {
  const fixture = await completingFixture();
  fixture.evidence.loseAckOnce = true;
  await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  const request = fixture.evidence.calls.find(c => c.operation === 'persist')?.request as PersistReviewObservationRequestV1;
  const first = await fixture.evidence.persistObservation(request),
    replay = await fixture.evidence.persistObservation(structuredClone(request));
  assert.equal(first.outcome, 'acknowledged');
  assert.deepEqual(replay, first);
  assert.equal(fixture.evidence.records.size, 1);
  const conflicting = { ...request.observation, accountingRefs: [...request.observation.accountingRefs].reverse() };
  assert.equal((await fixture.evidence.persistObservation({ ...request, observation: conflicting, observationDigest: hash(conflicting) })).outcome, 'conflict');
  const b = request.observation.binding,
    candidate = {
      taskId: b.taskId,
      repositoryId: b.repositoryId,
      workspaceId: b.workspaceId,
      headRevisionDigest: b.headRevisionDigest,
      diffDigest: b.diffDigest,
      expectedAuthority: request.expectedAuthority,
    };
  for (const field of ['taskId', 'workspaceId', 'repositoryId', 'headRevisionDigest', 'diffDigest'] as const) {
    const value = field.endsWith('Digest') ? hash('foreign-candidate') : 'foreign-identity';
    assert.equal((await fixture.evidence.recoverObservation({ ...candidate, [field]: value })).outcome, 'denied', field);
  }
  const found = await fixture.evidence.recoverObservation(candidate);
  assert.equal(found.outcome, 'found');
  if (found.outcome !== 'found') assert.fail('owner discovery missing');
  const loaded = await fixture.evidence.loadObservation({
    taskId: b.taskId,
    runId: b.runId,
    providerRequestId: found.ack.providerRequestId,
    contextDigest: found.ack.contextDigest,
    observationDigest: found.ack.observationDigest,
    expectedAuthority: request.expectedAuthority,
  });
  assert.deepEqual(loaded, found);
  assert.equal(fixture.requests.length, 1);
});

test('a latest settled request without an observation cannot fall back to an older accepted index', async () => {
  const fixture = await completingFixture();
  fixture.evidence.loseAckOnce = true;
  await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  const state = await fixture.owner.loadTask(fixture.task.taskId);
  assert.ok(state);
  const diff = await fixture.ports.repositoryPort.inspectDiff(fixture.task.initialRevisionDigest);
  const prepared = await fixture.config.reviewContext?.({ task: fixture.task, state, diff, phase: 'prepare' });
  assert.ok(prepared);
  const admission = await fixture.config.reviewerAdmission?.({ task: fixture.task, state, diff, reviewContext: prepared.context, evidence: prepared.evidence });
  assert.ok(admission);
  const reviewer = createRuntimeReviewer({ model: fixture.ports.reviewerModelPort, resolveRepoDigest: () => state.repositoryRevisionDigest, resolveReviewContext: () => prepared });
  const later = await reviewer.review(fixture.task, diff.diff, prepared.evidence, admission.request, admission.context);
  assert.equal(later.status, 'accepted');
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.evidence.records.size, 1);
  const ownerState = await fixture.owner.loadTask(fixture.task.taskId);
  assert.ok(ownerState);
  const result = await resumeFromTaskState(fixture, ownerState);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(await fixture.owner.loadTask(fixture.task.taskId), ownerState);
  assert.equal(fixture.owner.getLedgers().find(l => l.scope === 'task' && l.kind === 'tokens')?.consumed, 10);
  assert.equal(fixture.owner.getJournalSnapshot().claims.filter(c => c.claimId.startsWith('claim-bound-review-') && c.status === 'settled').length, 2);
});

for (const boundary of [0, 1]) {
  for (const fault of ['missing', 'foreign', 'forged', 'uncertain'] as const) {
    test(`${fault} owner reply at completion ${boundary + 1} withholds current completion`, async () => {
      const fixture = await completingFixture(),
        port = portAdapter(fixture);
      let lookups = 0;
      const configured = {
        ...fixture.config,
        reviewEvidence: {
          ...port,
          loadObservation: async (request: LoadReviewObservationRequestV1) => {
            const reply = await port.loadObservation(request);
            if (lookups++ !== boundary || reply.outcome !== 'found') return reply;
            if (fault === 'missing') return { outcome: 'missing' as const };
            if (fault === 'foreign') return { ...reply, ack: { ...reply.ack, taskId: 'foreign-task' } };
            if (fault === 'forged') return { ...reply, observation: { ...reply.observation, binding: { ...reply.observation.binding, criteriaDigest: hash('foreign criteria') } } };
            return { outcome: 'uncertain', operationRef: 'operation-unresolved' } as unknown as ReviewEvidenceFoundV1;
          },
        },
      };
      const result = await runControlledUC03GraphV02(fixture.task, fixture.ports, configured);
      assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
      assert.notEqual(result.finalReport?.isComplete, true);
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.owner.getLedgers().find(l => l.scope === 'task' && l.kind === 'tokens')?.consumed, 5);
    });
  }
}

test('current actionable findings persist before existing Repair and stop without new action authority', async () => {
  const fixture = await completingFixture();
  fixture.response.content = JSON.stringify({
    status: 'findings',
    findings: [
      {
        file: 'src/calculator.py',
        line: 1,
        side: 'old',
        severity: 'warning',
        message: 'Removing this behavior without preserving the public contract violates the admitted convention.',
        evidenceRef: 'convention-current',
      },
    ],
  });
  const transition = fixture.owner.transition.bind(fixture.owner);
  let persistedBeforeRepair = false;
  fixture.owner.transition = async (state, version) => {
    if (state.node === 'Repair') {
      persistedBeforeRepair = [...fixture.evidence.records.values()].some(r => r.observation.status === 'findings');
    }
    return transition(state, version);
  };
  const result = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal(persistedBeforeRepair, true);
  assert.equal((await fixture.owner.loadTask(fixture.task.taskId))?.node, 'Repair');
  assert.equal([...fixture.evidence.records.values()][0]?.observation.status, 'findings');
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.owner.getJournalSnapshot().claims.filter(c => c.claimId === 'claim-controlled-patch').length, 1);
});

test('invalid observed verdict is retained as invalid audit, charged and never enters repair or delivery', async () => {
  const fixture = await completingFixture();
  fixture.response.content = 'controlled invalid verdict text';
  const result = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.equal((await fixture.owner.loadTask(fixture.task.taskId))?.node, 'Review');
  assert.equal((await fixture.owner.loadTask(fixture.task.taskId))?.latestReviewRef, undefined);
  assert.equal([...fixture.evidence.records.values()][0]?.observation.status, 'invalid');
  assert.equal(fixture.owner.getLedgers().find(l => l.scope === 'task' && l.kind === 'tokens')?.consumed, 5);
  assert.equal(JSON.stringify(result).includes(fixture.response.content), false);
  assert.equal(fixture.requests.length, 1);
});

test('unknown provider usage keeps its owner hold and TaskState-only continuation cannot dispatch again', async () => {
  const fixture = await completingFixture();
  fixture.response.fail = true;
  const result = await runControlledUC03GraphV02(fixture.task, fixture.ports, fixture.config);
  assert.equal(result.outcome, 'IMPLEMENTED_UNVERIFIED');
  const state = await fixture.owner.loadTask(fixture.task.taskId);
  assert.ok(state);
  assert.equal(fixture.owner.getJournalSnapshot().claims.find(c => c.claimId.startsWith('claim-bound-review-'))?.status, 'uncertain');
  assert.ok(
    fixture.owner
      .getLedgers()
      .filter(l => l.kind === 'tokens')
      .every(l => l.reservations.length > 0),
  );
  assert.equal(fixture.evidence.records.size, 0);
  const resumed = await resumeFromTaskState(fixture, state);
  assert.equal(resumed.outcome, 'IMPLEMENTED_UNVERIFIED');
  assert.deepEqual(await fixture.owner.loadTask(fixture.task.taskId), state);
  assert.equal(fixture.requests.length, 1);
});

test('a missing post-ACK completion lookup stops at Review and later owner recovery can complete without replay', async () => {
  const fixture = await completingFixture(),
    port = portAdapter(fixture);
  const configured = { ...fixture.config, reviewEvidence: { ...port, loadObservation: async () => ({ outcome: 'missing' as const }) } };
  const first = await runControlledUC03GraphV02(fixture.task, fixture.ports, configured);
  assert.equal(first.outcome, 'IMPLEMENTED_UNVERIFIED');
  const state = await fixture.owner.loadTask(fixture.task.taskId);
  assert.ok(state);
  assert.equal(state.node, 'Review');
  assert.equal(state.latestReviewRef, undefined);
  assert.equal((await resumeFromTaskState(fixture, state)).outcome, 'COMPLETED');
  assert.equal(fixture.requests.length, 1);
});
