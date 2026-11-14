/** Controlled in-memory owner supplement and graph fixture; no durable storage or real provider. */
import assert from 'node:assert/strict';
import {
  computeCanonicalSha256 as hash,
  computeCheckSetDigest,
  computeRequestContentDigest,
  type ProviderRequest,
  type BugTask,
  type ProviderAdmissionContextV02,
  type StateTransitionOptions,
  type TaskState,
  type VerificationResult,
} from '../../../../src/contracts/foundation/uc03.ts';
import type {
  PersistReviewObservationRequestV1,
  LoadReviewObservationRequestV1,
  RecoverReviewObservationRequestV1,
  ReviewEvidenceFoundV1,
  ReviewEvidencePortV1,
  ReviewProfileV1,
  PersistReviewObservationResultV1,
  LoadReviewObservationResultV1,
  RecoverReviewObservationResultV1,
} from '../../../../src/contracts/review.ts';
import { validatePersistReviewObservationRequest, validateLoadReviewObservationRequest, validateRecoverReviewObservationRequest } from '../../../../src/uc06/validation.ts';
import { prepareReviewContext, type PreparedReviewContext } from '../../../../src/uc06/context.ts';
import { createVerificationApprovalContext } from '../../../../src/uc03/post-patch-verification-authority.ts';
import { currentPlanBindingDigest } from '../../../../src/uc03/graph-patch-ancestry.ts';
import { reviewerContextDigest } from '../../../../src/foundation/reviewer.ts';
import { HostModelPortV02 } from '../../../../src/foundation/model-v02.ts';
import { createDeepSeekTransport, DEEPSEEK_REVIEW_PROMPT } from '../../../../src/foundation/deepseek-transport.ts';
import { createExecutionGuardV02 } from '../../../../src/foundation/execution-guard.ts';
import { createBaselineEvidenceAdapter } from '../../../../src/runtime/baseline-evidence-adapter.ts';
import type { BaselineEvidenceAcknowledgement, BaselineEvidenceCandidate } from '../../../../src/uc03/investigation-types.ts';
import { computeTestProtectionDigest } from '../../../../src/uc03/investigation-snapshot.ts';
import type { UC03GraphConfigV02, UC03GraphPortsV02 } from '../../../../src/uc03/graph-types-v02.ts';
import { MemoryStatePortV02 } from '../uc03/memory-state.ts';
import { ScriptedApprovalPort } from '../uc03/scripted-approval.ts';
import { FakeRepositoryPort } from '../uc03/fake-repository.ts';
import { createGraphRepositoryPort, createGraphTaskState } from '../uc03/graph-fixtures.ts';
import { createFixtureBugTask, createFixtureExecutorIdentityV02, createFixturePolicyAuthorityRefV02, createFixtureProviderAdmissionReceiptV02 } from '../uc03/port-fixtures.ts';
import {
  createTestProviderRequest,
  createTestProviderAdmissionContextV02,
  createTestProviderAdmissionTrustedContextV02,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryAdmissionTrustedContextV02,
  createTestRepositoryCommandAdmissionContextV02,
} from '../uc03/state-fixtures.ts';
import { createResourceReservationRefs, createMockHostAuthority } from '../uc03/controlled-route.ts';

const denied = { outcome: 'denied', reasonCode: 'BINDING_STALE' } as const;
const copy = <T>(value: T): T => structuredClone(value);

/** Controlled protocol owner. Latest journal-backed request wins even when its evidence is missing. */
export class ControlledReviewEvidence implements ReviewEvidencePortV1 {
  readonly reviewEvidenceApiVersion = 'uc06-review-evidence/1' as const;
  readonly provenance = 'mock' as const;
  readonly calls: { operation: 'persist' | 'load' | 'recover'; request: unknown }[] = [];
  readonly admissions: { context: ProviderAdmissionContextV02; prepared: PreparedReviewContext }[] = [];
  readonly records = new Map<string, ReviewEvidenceFoundV1>();
  private readonly keys = new Map<string, string>();
  private readonly discovery = new Map<string, string>();
  private readonly pending = new Map<string, PersistReviewObservationRequestV1>();
  loseAckOnce = false;
  skipCommitOnce = false;
  loseBeforeCommitOnce = false;
  readonly owner: MemoryStatePortV02;
  constructor(owner: MemoryStatePortV02) {
    this.owner = owner;
  }
  register(context: ProviderAdmissionContextV02, prepared: PreparedReviewContext): void {
    this.admissions.push(copy({ context, prepared }));
  }
  private async current(expected: PersistReviewObservationRequestV1['expectedAuthority'], taskId: string) {
    const state = await this.owner.loadTask(taskId),
      snapshot = await this.owner.readVerificationAuthoritySnapshot(taskId);
    return state &&
      snapshot &&
      snapshot.controlMode === 'runnable' &&
      snapshot.holdRef === null &&
      snapshot.activeClaimId === null &&
      expected.taskStateVersion === state.stateVersion &&
      expected.controlVersion === snapshot.controlVersion &&
      expected.epoch === snapshot.epoch &&
      expected.decisionAuthorityGeneration === snapshot.decisionAuthorityGeneration &&
      expected.planDecisionRef === state.plan?.decisionRef &&
      expected.planBindingDigest === currentPlanBindingDigest(state.taskContext ?? createFixtureBugTask(), state)
      ? state
      : undefined;
  }
  private settled(id: string | null) {
    if (!id) return false;
    const journal = this.owner.getJournalSnapshot(),
      claim = journal.claims.find(c => c.claimId === `claim-${id}`);
    const attempts = journal.attempts.filter(a => a.claimId === claim?.claimId),
      outcomes = journal.outcomes.filter(o => o.claimId === claim?.claimId);
    return claim?.status === 'settled' && attempts.length === 1 && outcomes.length === 1 && outcomes[0]?.outcome === 'observed' && attempts[0]?.outcomeReceiptId === outcomes[0].receiptId;
  }
  async persistObservation(request: PersistReviewObservationRequestV1): Promise<PersistReviewObservationResultV1> {
    this.calls.push({ operation: 'persist', request: copy(request) });
    if (!validatePersistReviewObservationRequest(request).ok) return denied;
    const state = await this.current(request.expectedAuthority, request.observation.binding.taskId);
    const admission = this.admissions.find(a => a.context.providerRequestId === request.observation.providerRequestId);
    if (
      !state ||
      !admission ||
      !this.settled(request.observation.providerRequestId) ||
      hash(admission.prepared.context.binding) !== hash(request.observation.binding) ||
      admission.prepared.context.contextDigest !== request.observation.contextDigest
    )
      return denied;
    const prior = this.keys.get(request.idempotencyKey);
    if (prior && prior !== request.observationDigest) return { outcome: 'conflict', reasonCode: 'MODEL_OUTPUT_INVALID' } as const;
    const existing = this.records.get(request.observationDigest);
    if (existing) return { outcome: 'acknowledged', ack: copy(existing.ack) } as const;
    const operationRef = `operation-${request.idempotencyKey}`;
    if (this.loseBeforeCommitOnce) {
      this.loseBeforeCommitOnce = false;
      throw new Error('CONTROLLED_COMMIT_UNAVAILABLE');
    }
    if (this.skipCommitOnce) {
      this.skipCommitOnce = false;
      this.pending.set(operationRef, copy(request));
      return { outcome: 'uncertain', operationRef } as const;
    }
    const b = request.observation.binding;
    const ack = {
      schemaVersion: 'uc06-review-evidence/1' as const,
      receiptId: `review-receipt-${this.records.size + 1}`,
      taskId: b.taskId,
      runId: b.runId,
      repositoryId: b.repositoryId,
      workspaceId: b.workspaceId,
      headRevisionDigest: b.headRevisionDigest,
      diffDigest: b.diffDigest,
      contextDigest: request.observation.contextDigest,
      providerRequestId: request.observation.providerRequestId,
      observationDigest: request.observationDigest,
      storeRecordVersion: this.records.size + 1,
      committed: true as const,
    };
    // Observation, ACK and candidate discovery index are one synchronous commit before possible lost ACK.
    this.records.set(request.observationDigest, copy({ outcome: 'found', observation: request.observation, ack }));
    this.keys.set(request.idempotencyKey, request.observationDigest);
    this.discovery.set(hash([request.observation.binding, request.observation.providerRequestId]), request.observationDigest);
    if (this.loseAckOnce) {
      this.loseAckOnce = false;
      return { outcome: 'uncertain', operationRef } as const;
    }
    return { outcome: 'acknowledged', ack: copy(ack) } as const;
  }
  async loadObservation(request: LoadReviewObservationRequestV1): Promise<LoadReviewObservationResultV1> {
    this.calls.push({ operation: 'load', request: copy(request) });
    if (!validateLoadReviewObservationRequest(request).ok || !(await this.current(request.expectedAuthority, request.taskId))) return denied;
    const record = this.records.get(request.observationDigest);
    if (!record) return { outcome: 'missing' } as const;
    return record.ack.taskId === request.taskId &&
      record.ack.runId === request.runId &&
      record.ack.providerRequestId === request.providerRequestId &&
      record.ack.contextDigest === request.contextDigest &&
      this.settled(request.providerRequestId)
      ? copy(record)
      : denied;
  }
  async recoverObservation(request: RecoverReviewObservationRequestV1): Promise<RecoverReviewObservationResultV1> {
    this.calls.push({ operation: 'recover', request: copy(request) });
    if (!validateRecoverReviewObservationRequest(request).ok) return denied;
    const current = await this.current(request.expectedAuthority, request.taskId);
    if (!current || request.workspaceId !== current.workspaceId || request.repositoryId !== current.repositoryId || request.headRevisionDigest !== current.repositoryRevisionDigest) return denied;
    const journal = this.owner.getJournalSnapshot();
    const latest = [...journal.claims]
      .reverse()
      .map(c => this.admissions.find(a => `claim-${a.context.providerRequestId}` === c.claimId))
      .find(
        a =>
          a &&
          ['taskId', 'repositoryId', 'workspaceId', 'headRevisionDigest'].every(
            k => a.prepared.context.binding[k as keyof typeof a.prepared.context.binding] === request[k as keyof RecoverReviewObservationRequestV1],
          ),
      );
    if (!latest) return { outcome: 'missing' } as const;
    if (latest.prepared.context.binding.diffDigest !== request.diffDigest) return denied;
    const discovered = this.discovery.get(hash([latest.prepared.context.binding, latest.context.providerRequestId]));
    const record = discovered ? this.records.get(discovered) : undefined;
    const pending = [...this.pending.entries()].find(([, r]) => r.observation.providerRequestId === latest.context.providerRequestId);
    if (pending) return !request.operationRef || request.operationRef === pending[0] ? ({ outcome: 'uncertain', operationRef: pending[0] } as const) : denied;
    if (request.operationRef && request.operationRef !== `operation-review-${record?.ack.observationDigest.slice(7)}`) return denied;
    if (!this.settled(latest.context.providerRequestId)) return { outcome: 'uncertain', operationRef: 'operation-review-pending' } as const;
    return record ? copy(record) : ({ outcome: 'missing' } as const);
  }
}

export const REVIEW_PROFILE: ReviewProfileV1 = {
  profileId: 'controlled-review',
  profileVersion: '1',
  promptVersion: DEEPSEEK_REVIEW_PROMPT.version,
  promptDigest: DEEPSEEK_REVIEW_PROMPT.digest,
  requiredConventionPaths: ['CONVENTIONS.md'],
  optionalEvidenceRefs: [],
  maxDiffBytes: 49152,
  maxContextBytes: 65536,
  maxEvidenceItems: 32,
  maxEvidenceBytes: 32768,
  maxFindings: 16,
  maxMessageBytes: 2048,
  maxOutputBytes: 16384,
  maxResponseBytes: 131072,
};
let fixtureSequence = 0;

export interface ControlledReviewFixture {
  readonly task: BugTask;
  readonly owner: MemoryStatePortV02;
  readonly approval: ScriptedApprovalPort;
  readonly ports: UC03GraphPortsV02;
  readonly config: UC03GraphConfigV02;
  readonly evidence: ControlledReviewEvidence;
  readonly requests: Record<string, unknown>[];
  readonly checks: VerificationResult[];
  readonly material: { profile: ReviewProfileV1; convention: string; source: string };
  readonly response: { content: string; fail: boolean };
  readonly contextPhases: string[];
  readonly baseline: { readonly content: BaselineEvidenceCandidate; readonly acknowledgement: BaselineEvidenceAcknowledgement };
  readonly prepared: () => PreparedReviewContext | undefined;
  readonly freshConsumer: () => { readonly ports: UC03GraphPortsV02; readonly config: UC03GraphConfigV02 };
}

/** Start with an actually settled controlled patch, then exercise the real graph's Verify→Review. */
export async function controlledReviewFixture(completion?: NonNullable<StateTransitionOptions['trusted']>): Promise<ControlledReviewFixture> {
  const material = { profile: copy(REVIEW_PROFILE), convention: 'Preserve public behavior.', source: '' };
  const contextPhases: string[] = [];
  const response = { content: '{"status":"accepted","findings":[]}', fail: false };
  const task = createFixtureBugTask(),
    original = createGraphTaskState(task, { node: 'Patch', stateVersion: 4 });
  const baselineRef = 'baseline-review-original',
    d0 = 'decision-review-original';
  const plan = {
    planVersion: original.planVersion,
    diagnosis: 'The zero denominator is unguarded.',
    suspectedCauseLocations: ['src/calculator.py'],
    evidenceRefs: [baselineRef],
    strategy: 'Reject a zero denominator.',
    scopedChanges: ['src/calculator.py'],
    checkSetDigest: computeCheckSetDigest(task.requiredChecks),
    baselineRef,
    strategyDigest: hash('Reject a zero denominator.'),
    decisionRef: d0,
  };
  const state: TaskState = { ...original, plan, activeDecisionId: d0, approvalDecisionRefs: [d0], evidenceRefs: [baselineRef] };
  const authority = createFixturePolicyAuthorityRefV02({ policyId: task.configId, configId: task.configId, decisionAuthorityGeneration: 3 });
  const approvalContext = createVerificationApprovalContext(task, state, authority, 3, d0);
  assert.ok(approvalContext);
  const f = approvalContext.approvalContext;
  const approval = new ScriptedApprovalPort({
    currentContext: f,
    v02AuthorityRef: authority,
    decisions: [
      {
        decisionId: d0,
        actionKind: 'fix_plan',
        normalizedActionDigest: f.currentNormalizedActionDigest,
        taskId: task.taskId,
        workspaceId: state.workspaceId,
        repositoryRevisionDigest: task.initialRevisionDigest,
        policyId: authority.policyId,
        policyVersion: authority.policyVersion,
        planVersion: plan.planVersion,
        strategyDigest: plan.strategyDigest,
        baselineRef,
        evidenceRefs: [baselineRef],
        criteriaDigest: hash(task.acceptanceCriteria),
        checkSetDigest: plan.checkSetDigest,
        status: 'approved',
      },
    ],
  });
  const owner = new MemoryStatePortV02({
    initialTaskState: state,
    initialControlVersion: 1,
    initialEpoch: 1,
    initialAuthorityRef: authority,
    verificationApprovalVerifier: approval,
    transitionContexts: completion ? { 9: completion } : {},
  });
  const raw = new FakeRepositoryPort({
    initialRevision: task.initialRevisionDigest,
    initialFiles: { 'src/calculator.py': 'old', 'tests/test_calculator.py': 'def test_divide(): pass\n' },
    commandResults: { default: { exitCode: 0, stdout: '1 passed', stderr: '' } },
  });
  raw.setStatePort(owner);
  raw.setTestResult(task.requiredChecks[0]?.checkId ?? '', { checkId: task.requiredChecks[0]?.checkId ?? '', outcome: 'pass', outputExcerpt: '1 passed', durationMs: 1 });
  const repository = createGraphRepositoryPort(raw, owner),
    guard = createExecutionGuardV02({ ports: { statePort: owner, repositoryPort: repository, approvalPort: approval } });
  const diff = '--- a/src/calculator.py\n+++ b/src/calculator.py\n@@ -1 +1 @@\n-old\n+new\n';
  const patch = { actionId: 'controlled-patch', kind: 'apply_patch' as const, patchContent: diff, targetPaths: ['src/calculator.py'], baseRevisionDigest: task.initialRevisionDigest };
  const patchContext = createTestRepositoryAdmissionContextV02({
    taskId: task.taskId,
    runId: state.runId,
    workspaceId: state.workspaceId,
    repositoryId: task.repositoryId,
    canonicalRevision: task.initialRevisionDigest,
    expectedTaskStateVersion: state.stateVersion,
    expectedControlVersion: 1,
    expectedEpoch: 1,
    runnableNode: 'Patch',
    planDecisionRef: d0,
    planBindingDigest: currentPlanBindingDigest(task, state),
    policyAuthorityRef: authority,
    action: patch,
    baseRevision: task.initialRevisionDigest,
    targetPaths: patch.targetPaths,
    patchDigest: hash(diff),
    reservationRefs: ['patch-slot-review'],
  });
  assert.equal(createTestRepositoryAdmissionTrustedContextV02(patchContext).taskId, task.taskId);
  const patched = await repository.applyPatch(patch, patchContext);
  assert.equal(patched.applied, true);
  material.source = (await raw.readFile('src/calculator.py')).boundedExcerpt;
  const host = createMockHostAuthority(),
    content: BaselineEvidenceCandidate = {
      taskId: task.taskId,
      workspaceId: state.workspaceId,
      repositoryId: task.repositoryId,
      acceptanceCriteria: task.acceptanceCriteria,
      criteriaDigest: hash(task.acceptanceCriteria),
      requiredChecks: task.requiredChecks,
      expectedPassingCheckIds: [],
      reproductionCheckId: task.requiredChecks[0]?.checkId ?? '',
      expectedTestFiles: ['tests/test_calculator.py'],
      repositorySnapshotDigest: task.initialRevisionDigest,
      checkSetDigest: plan.checkSetDigest,
      reproductionFailureSignature: 'original-division-failure',
      checkResults: [{ checkId: task.requiredChecks[0]?.checkId ?? '', outcome: 'fail' }],
      testProtectionDigest: computeTestProtectionDigest([{ path: 'tests/test_calculator.py', content: 'def test_divide(): pass\n' }]),
    };
  const ack: BaselineEvidenceAcknowledgement = {
    evidenceId: baselineRef,
    taskId: task.taskId,
    workspaceId: state.workspaceId,
    repositoryId: task.repositoryId,
    contentDigest: hash(content),
    repositorySnapshotDigest: content.repositorySnapshotDigest,
    criteriaDigest: content.criteriaDigest,
    checkSetDigest: content.checkSetDigest,
    testProtectionDigest: content.testProtectionDigest,
    reproductionCheckId: content.reproductionCheckId,
    expectedPassingCheckIds: [],
    expectedTestFiles: content.expectedTestFiles,
    requiredCheckIds: task.requiredChecks.map(c => c.checkId),
  };
  const baseline = createBaselineEvidenceAdapter({
    provenance: 'mock',
    persist: () => ({ outcome: 'durable', acknowledgement: ack }),
    load: request => (request.evidenceId === ack.evidenceId ? { outcome: 'found', content, acknowledgement: ack } : { outcome: 'missing' }),
  });
  const evidence = new ControlledReviewEvidence(owner),
    requests: Record<string, unknown>[] = [];
  const transport = createDeepSeekTransport({
    endpoint: 'https://api.deepseek.com/anthropic/v1/messages',
    apiKey: 'controlled-host-fixture-key',
    pricing: { inputRate: 1, outputRate: 1, cacheRate: 1, overheadRate: 0, denominator: 1000000 },
    reviewPrompt: { ...DEEPSEEK_REVIEW_PROMPT, maxOutputBytes: REVIEW_PROFILE.maxOutputBytes, maxResponseBytes: REVIEW_PROFILE.maxResponseBytes },
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (response.fail) throw new Error('Controlled provider response unavailable');
      return new Response(
        JSON.stringify({
          id: 'controlled-review-response',
          type: 'message',
          role: 'assistant',
          model: 'model-test-01',
          content: [{ type: 'text', text: response.content }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
      );
    },
  });
  const actor = createFixtureExecutorIdentityV02({ processIncarnation: `controlled-bound-reviewer-${++fixtureSequence}` });
  // Explicit controlled wrapper: fake HTTP does not become real provenance via the transport brand.
  const reviewer = Object.assign(
    new HostModelPortV02({ statePort: owner, transport: { execute: payload => transport.execute(payload) }, executorIdentity: actor, currentExecutorIdentity: () => actor }),
    { providerRole: 'reviewer' as const },
  );
  const checks: VerificationResult[] = [];
  let admissionSequence = 0;
  let prepared: PreparedReviewContext | undefined;
  const resolveCurrentMaterial: NonNullable<UC03GraphConfigV02['reviewContext']> = async ({ state: current, diff: currentDiff }) => {
    contextPhases.push('completion');
    const snapshot = await owner.readVerificationAuthoritySnapshot(task.taskId),
      journal = owner.getJournalSnapshot();
    assert.ok(snapshot && current.plan?.decisionRef);
    const currentChecks = task.requiredChecks.map(check => {
      const actionId = `action-verify-${check.checkId}`;
      assert.equal(journal.claims.find(c => c.claimId === `claim-${actionId}`)?.status, 'settled');
      const evidenceId = current.evidenceRefs.find(ref => ref.startsWith(`evidence-verif-${check.checkId}-`));
      assert.ok(evidenceId);
      return {
        evidenceId,
        taskId: task.taskId,
        runId: current.runId,
        actionId,
        phase: check.purpose === 'reproduction' ? ('focused' as const) : check.purpose,
        repoDigest: current.repositoryRevisionDigest,
        diffDigest: currentDiff.diffDigest,
        commandIdentity: `${check.executable} ${check.argv.join(' ')}`,
        outcome: 'pass' as const,
        testedIds: [check.checkId],
        diagnosticRefs: ['execution-guard:success'],
      };
    });
    const excerpts = [
      { path: 'CONVENTIONS.md', revisionDigest: current.repositoryRevisionDigest, boundedExcerpt: material.convention, resultCount: 1, truncated: false },
      { path: 'src/calculator.py', revisionDigest: current.repositoryRevisionDigest, boundedExcerpt: material.source, resultCount: 1, truncated: false },
    ];
    const conventions = [{ evidenceRef: 'convention-current', path: 'CONVENTIONS.md', revisionDigest: current.repositoryRevisionDigest, contentDigest: hash(material.convention) }];
    const verification = {
      baselineRef: ack.evidenceId,
      results: task.requiredChecks.map(check => {
        const result = currentChecks.find(r => r.testedIds.includes(check.checkId));
        assert.ok(result);
        return {
          evidenceId: result.evidenceId,
          checkId: check.checkId,
          phase: result.phase,
          outcome: 'pass' as const,
          repoDigest: result.repoDigest,
          diffDigest: result.diffDigest,
          contentDigest: hash(result),
        };
      }),
    };
    const body = {
      schemaVersion: 'uc06-review-context/1' as const,
      profile: material.profile,
      verification,
      evidence: [
        ...conventions.map(c => ({ ...c, kind: 'convention' as const })),
        { evidenceRef: 'source-current', path: 'src/calculator.py', revisionDigest: current.repositoryRevisionDigest, contentDigest: hash(material.source), kind: 'source' as const },
      ],
      conventions,
      binding: {
        taskId: task.taskId,
        runId: current.runId,
        repositoryId: task.repositoryId,
        workspaceId: current.workspaceId,
        baseRevisionDigest: task.initialRevisionDigest,
        headRevisionDigest: current.repositoryRevisionDigest,
        diffDigest: currentDiff.diffDigest,
        criteriaDigest: hash({ acceptanceCriteria: task.acceptanceCriteria, constraints: task.constraints }),
        checkSetDigest: computeCheckSetDigest(task.requiredChecks),
        profileDigest: hash(material.profile),
        verificationDigest: hash(verification),
        conventionsDigest: hash(conventions),
        evidenceDigest: hash(excerpts),
      },
      authority: {
        taskStateVersion: current.stateVersion,
        controlVersion: snapshot.controlVersion,
        epoch: snapshot.epoch,
        decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration,
        planDecisionRef: current.plan.decisionRef,
        planBindingDigest: currentPlanBindingDigest(task, current),
      },
    };
    return { context: { ...body, contextDigest: hash(body) }, evidence: excerpts };
  };
  const config: UC03GraphConfigV02 = {
    trustedExpectedContext: {
      taskId: task.taskId,
      workspaceId: state.workspaceId,
      repositoryId: task.repositoryId,
      revisionDigest: task.initialRevisionDigest,
      criteriaDigest: hash(task.acceptanceCriteria),
      checkSetDigest: plan.checkSetDigest,
      expectedTestFiles: ['tests/test_calculator.py'],
      statePort: owner,
      executionGuard: guard,
      admissionContextForCheck: async ({ check, action, currentState }) => {
        const s = await owner.readVerificationAuthoritySnapshot(task.taskId);
        assert.ok(s);
        raw.setExecutorIdentity(createFixtureExecutorIdentityV02({ payloadDigest: hash(action) }));
        return createTestRepositoryCommandAdmissionContextV02({
          taskId: task.taskId,
          runId: currentState.runId,
          workspaceId: currentState.workspaceId,
          repositoryId: task.repositoryId,
          canonicalRevision: currentState.repositoryRevisionDigest,
          expectedTaskStateVersion: currentState.stateVersion,
          expectedControlVersion: s.controlVersion,
          expectedEpoch: s.epoch,
          policyAuthorityRef: { ...s.policyIdentity, decisionAuthorityGeneration: s.decisionAuthorityGeneration },
          action,
          reservationRefs: createResourceReservationRefs(action.actionId),
          runnableNode: 'Verify',
          planApplicability: 'approved-plan',
          taskCriteriaDigest: hash(task.acceptanceCriteria),
          checkSetDigest: plan.checkSetDigest,
          checkId: check.checkId,
          testPath: 'tests/test_calculator.py',
          planBindingDigest: currentPlanBindingDigest(task, currentState),
          planDecisionRef: currentState.plan?.decisionRef,
        });
      },
    },
    trustedTransitionContext: completion,
    reviewEvidence: evidence,
    reviewPrompt: transport.reviewPrompt,
    reviewContext: async ({ state: current, diff: currentDiff, phase }) => {
      if (phase === 'completion') return resolveCurrentMaterial({ task, state: current, diff: currentDiff, phase });
      contextPhases.push(phase ?? 'prepare');
      const snapshot = await owner.readVerificationAuthoritySnapshot(task.taskId),
        ancestry = await owner.readSettledPatchAncestry({ taskId: task.taskId, runId: current.runId, resultingRepositoryRevisionDigest: current.repositoryRevisionDigest });
      assert.ok(snapshot && ancestry && current.plan);
      const currentDecision = current.plan.decisionRef;
      assert.ok(currentDecision);
      const journal = owner.getJournalSnapshot();
      checks.splice(
        0,
        checks.length,
        ...task.requiredChecks.map(check => {
          const actionId = `action-verify-${check.checkId}`;
          assert.equal(journal.claims.find(c => c.claimId === `claim-${actionId}`)?.status, 'settled');
          const evidenceId = current.evidenceRefs.find(ref => ref.startsWith(`evidence-verif-${check.checkId}-`));
          assert.ok(evidenceId);
          return {
            evidenceId,
            taskId: task.taskId,
            runId: current.runId,
            actionId,
            phase: check.purpose === 'reproduction' ? ('focused' as const) : check.purpose,
            repoDigest: current.repositoryRevisionDigest,
            diffDigest: currentDiff.diffDigest,
            commandIdentity: `${check.executable} ${check.argv.join(' ')}`,
            outcome: 'pass' as const,
            testedIds: [check.checkId],
            diagnosticRefs: ['execution-guard:success'],
          };
        }),
      );
      const cc = createVerificationApprovalContext(task, current, snapshot.policyIdentity, snapshot.decisionAuthorityGeneration, currentDecision);
      const originalState = ancestry.originalTaskState,
        oa = ancestry.originalAuthorityRef;
      const hc = createVerificationApprovalContext(task, originalState, oa, oa.decisionAuthorityGeneration, originalState.plan?.decisionRef ?? '', 'historical-patch');
      assert.ok(cc && hc);
      const result = prepareReviewContext({
        task,
        state: current,
        repository: { baseRevisionDigest: task.initialRevisionDigest, headRevisionDigest: current.repositoryRevisionDigest, diff: currentDiff.diff, diffDigest: currentDiff.diffDigest },
        authoritySnapshot: snapshot,
        currentApproval: await owner.resolvePlanDecisionInContext(currentDecision, cc),
        historicalApproval: await owner.resolvePlanDecisionInContext(originalState.plan?.decisionRef ?? '', hc),
        ancestry,
        baseline: { content, acknowledgement: ack },
        verificationResults: checks,
        acknowledgedChecks: checks,
        profile: material.profile,
        requiredSourcePaths: [],
        evidence: [
          {
            evidenceRef: 'convention-current',
            kind: 'convention',
            source: { path: 'CONVENTIONS.md', revisionDigest: current.repositoryRevisionDigest, boundedExcerpt: material.convention, resultCount: 1, truncated: false },
          },
          {
            evidenceRef: 'source-current',
            kind: 'source',
            source: { path: 'src/calculator.py', revisionDigest: current.repositoryRevisionDigest, boundedExcerpt: material.source, resultCount: 1, truncated: false },
          },
        ],
      });
      assert.equal(result.status, 'ready', JSON.stringify(result));
      if (result.status !== 'ready') return undefined;
      prepared = result;
      return result;
    },
    reviewerAdmission: async ({ state: current, diff: currentDiff, reviewContext, evidence: excerpts }) => {
      const snapshot = await owner.readVerificationAuthoritySnapshot(task.taskId);
      assert.ok(snapshot);
      if (!prepared || !reviewContext || !excerpts) return undefined;
      const digest = reviewerContextDigest(task, currentDiff.diff, excerpts, current.repositoryRevisionDigest, { runId: current.runId, expectedTaskStateVersion: current.stateVersion }, reviewContext);
      assert.ok(digest);
      const request: ProviderRequest = createTestProviderRequest({
        providerRequestId: `bound-review-${current.stateVersion}-${++admissionSequence}`,
        taskId: task.taskId,
        runId: current.runId,
        role: 'reviewer',
        purpose: 'final-review',
        contextDigest: digest,
        configId: snapshot.policyIdentity.configId,
        pricingPolicyId: snapshot.policyIdentity.policyId,
        reservationRef: `bound-review-allowance-${current.stateVersion}`,
      });
      const identity = {
        providerId: request.providerId,
        modelId: request.modelId,
        configId: request.configId,
        configVersion: snapshot.policyIdentity.configVersion,
        pricingPolicyId: request.pricingPolicyId,
        pricingPolicyVersion: snapshot.policyIdentity.policyVersion,
        issuerKeyRef: snapshot.policyIdentity.issuerKeyRef,
        decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration,
      };
      const receipt = createFixtureProviderAdmissionReceiptV02({
        providerRequestId: request.providerRequestId,
        role: 'reviewer',
        requestContentDigest: computeRequestContentDigest(request),
        providerId: identity.providerId,
        modelId: identity.modelId,
        configId: identity.configId,
        configVersion: identity.configVersion,
        decisionAuthorityGeneration: identity.decisionAuthorityGeneration,
      });
      const admission = createTestProviderAdmissionContextV02({
        providerRequest: request,
        providerIdentity: identity,
        providerAdmissionReceipt: receipt,
        taskId: task.taskId,
        runId: current.runId,
        runnableNode: 'Review',
        role: 'reviewer',
        expectedTaskStateVersion: current.stateVersion,
        expectedControlVersion: snapshot.controlVersion,
        expectedEpoch: snapshot.epoch,
        planApplicability: 'approved-plan',
        planDecisionRef: current.plan?.decisionRef,
        planBindingDigest: currentPlanBindingDigest(task, current),
        budgetRefs: [
          `task-tokens:${request.providerRequestId}`,
          `task-cost:${request.providerRequestId}`,
          `run-tokens:${request.providerRequestId}`,
          `run-cost:${request.providerRequestId}`,
          `task-iteration:${request.providerRequestId}`,
        ],
      });
      evidence.register(admission, prepared);
      return { request, context: admission, trustedContext: createTestProviderAdmissionTrustedContextV02(admission) };
    },
  };
  const ports: UC03GraphPortsV02 = {
    statePort: owner,
    approvalPort: approval,
    repositoryPort: repository,
    modelPort: new HostModelPortV02({
      statePort: owner,
      transport: {
        execute: async () => {
          throw new Error('Unexpected coder dispatch');
        },
      },
    }),
    reviewerModelPort: reviewer,
    executionGuard: guard,
    guardedRead: {
      capabilityId: 'unused-read',
      taskId: task.taskId,
      workspaceId: state.workspaceId,
      provenance: 'mock',
      mediateRead: async () => {
        throw new Error('Unexpected source read');
      },
    },
    baselineEvidence: baseline,
    hostAuthority: host,
    configPort: { loadConfig: async () => ({ configId: task.configId, configVersion: task.configVersion }) },
    contextSource: { provenance: 'mock', observe: () => null },
    replanPort: { provenance: 'mock', accept: async () => ({ outcome: 'denied', reason: 'not admitted' }) },
  };
  const freshConsumer = () => {
    const freshActor = createFixtureExecutorIdentityV02({ processIncarnation: `controlled-bound-reviewer-${++fixtureSequence}` });
    const freshModel = Object.assign(
      new HostModelPortV02({ statePort: owner, transport: { execute: payload => transport.execute(payload) }, executorIdentity: freshActor, currentExecutorIdentity: () => freshActor }),
      { providerRole: 'reviewer' as const },
    );
    return {
      ports: { ...ports, reviewerModelPort: freshModel },
      config: {
        ...config,
        reviewContext: resolveCurrentMaterial,
        reviewerAdmission: async () => {
          throw new Error('Recovery must not mint provider admission');
        },
      },
    };
  };
  return { task, owner, approval, ports, config, evidence, requests, checks, material, response, contextPhases, baseline: { content, acknowledgement: ack }, prepared: () => prepared, freshConsumer };
}

/** Independently retained controlled owner completion facts, reused by fresh consumers. */
export function controlledReviewCompletion(fixture: Awaited<ReturnType<typeof controlledReviewFixture>>): NonNullable<StateTransitionOptions['trusted']> {
  const observation = [...fixture.evidence.records.values()].at(-1)?.observation;
  assert.ok(observation?.result && observation.result.status === 'accepted');
  const result = observation.result,
    b = observation.binding,
    baseline = fixture.baseline;
  return {
    completion: {
      taskId: b.taskId,
      runId: b.runId,
      repositoryRevisionDigest: b.headRevisionDigest,
      diffDigest: b.diffDigest,
      checkSetDigest: b.checkSetDigest,
      baselineRef: baseline.acknowledgement.evidenceId,
      criteriaDigest: hash(fixture.task.acceptanceCriteria),
      authorizedDiffDigest: b.diffDigest,
      protectedTestsDigest: baseline.content.testProtectionDigest,
      originalProtectedTestsDigest: baseline.content.testProtectionDigest,
      reviewerRoleConfigId: result.reviewerRoleConfigId,
      reviewIterationReservationRef: result.iterationReservationRef,
      checks: copy(fixture.checks),
      review: result,
    },
  };
}
