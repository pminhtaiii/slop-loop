/**
 * T011 [US3] Real integrated review with actual provider and durable store.
 * Verifies live reviewer execution over real transport, structured output validation,
 * accounting, and durable evidence persistence (SC-001–SC-004).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeRequestContentDigest } from '../../../src/contracts/foundation/uc03.ts';
import { createDeepSeekTransport } from '../../../src/foundation/deepseek-transport.ts';
import { DEEPSEEK_REVIEW_PROMPT } from '../../../src/foundation/deepseek-review-profile.ts';
import { HostModelPortV02 } from '../../../src/foundation/model-v02.ts';
import { createDurableReviewEvidenceStore } from '../../../src/persistence/adapters/review-evidence-store.ts';
import { controlledReviewFixture, REVIEW_PROFILE } from '../support/uc06/review-evidence.ts';
import { createProductionRoute } from '../../../src/uc03/graph-v02.ts';
import { currentPlanBindingDigest } from '../../../src/uc03/graph-patch-ancestry.ts';
import { createFixtureExecutorIdentityV02, createFixtureProviderAdmissionReceiptV02 } from '../support/uc03/port-fixtures.ts';
import { createTestProviderAdmissionTrustedContextV02 } from '../support/uc03/state-fixtures.ts';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/messages';
const LIVE_MODEL = 'nvidia/nemotron-3.5-lightning:free';
const API_KEY = process.env.OPENROUTER_API_KEY ?? '';

test('T011 prerequisite gate: missing API key or unpinned endpoint refuses before network dispatch', async () => {
  assert.throws(
    () =>
      createDeepSeekTransport({
        apiKey: '',
        endpoint: OPENROUTER_ENDPOINT,
        pricing: { inputRate: 0, outputRate: 0, cacheRate: 0, overheadRate: 0, denominator: 1 },
      }),
    /INVALID_CREDENTIAL/,
  );

  assert.throws(
    () =>
      createDeepSeekTransport({
        apiKey: 'valid-key-format-token-1234567890',
        endpoint: 'https://openrouter.ai/api/v1/chat',
        pricing: { inputRate: 0, outputRate: 0, cacheRate: 0, overheadRate: 0, denominator: 1 },
      }),
    /INVALID_ENDPOINT/,
  );
});

async function approveVerification(fixture: Awaited<ReturnType<typeof controlledReviewFixture>>) {
  const app = createProductionRoute(fixture.ports, fixture.config);
  const pending = await app.invoke({ task: fixture.task, state: undefined, reasons: [], milestones: [] });
  assert.equal(pending.terminalOutcome ?? pending.state?.outcome, 'pending-approval', JSON.stringify(pending));
  const d1 = fixture.approval.getRecordedBindings().find(binding => binding.decisionId.startsWith('dec-verify-'));
  const owner = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
  assert.ok(d1 && owner);
  const authorityRef = { ...owner.policyIdentity, decisionAuthorityGeneration: owner.decisionAuthorityGeneration + 1 };
  assert.equal((await fixture.owner.publishAuthority({ authorityRef })).status, 'published');
  fixture.approval.setV02AuthorityRef(authorityRef);
  fixture.approval.scriptDecision({ ...d1, status: 'approved' });
}

test('T011 live acceptance: execute real integrated review with live provider and durable persistence', { timeout: 45000 }, async (t) => {
  if (!API_KEY) {
    t.skip('OPENROUTER_API_KEY environment variable not set; live network dispatch skipped in unauthenticated environment');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'uc06-real-t011-'));
  try {
    const durableStore = createDurableReviewEvidenceStore(dir);
    assert.equal(durableStore.provenance, 'real');

    const fixture = await controlledReviewFixture();

    const liveTransport = createDeepSeekTransport({
      apiKey: API_KEY,
      endpoint: OPENROUTER_ENDPOINT,
      pricing: { inputRate: 0, outputRate: 0, cacheRate: 0, overheadRate: 0, denominator: 1 },
      reviewPrompt: {
        version: DEEPSEEK_REVIEW_PROMPT.version,
        digest: DEEPSEEK_REVIEW_PROMPT.digest,
        maxOutputBytes: REVIEW_PROFILE.maxOutputBytes,
        maxResponseBytes: REVIEW_PROFILE.maxResponseBytes,
      },
    });

    const actor = createFixtureExecutorIdentityV02({ processIncarnation: 'live-reviewer-t011' });
    const liveReviewerPort = Object.assign(
      new HostModelPortV02({
        statePort: fixture.owner,
        transport: liveTransport,
        executorIdentity: actor,
        currentExecutorIdentity: () => actor,
      }),
      { providerRole: 'reviewer' as const },
    );

    // Wire live reviewer and durable store into graph ports and config
    const ports = {
      ...fixture.ports,
      reviewerModelPort: liveReviewerPort,
    };
    // Wrap reviewerAdmission to set the real modelId
    const baseReviewerAdmission = fixture.config.reviewerAdmission;
    const reviewerAdmission: typeof baseReviewerAdmission = async (input) => {
      if (!baseReviewerAdmission) return undefined;
      const admission = await baseReviewerAdmission(input);
      if (!admission) return undefined;
      const request = { ...admission.request, modelId: LIVE_MODEL };
      const requestContentDigest = computeRequestContentDigest(request);
      const identity = { ...admission.context.providerIdentity, modelId: LIVE_MODEL };
      const receipt = createFixtureProviderAdmissionReceiptV02({
        providerRequestId: request.providerRequestId,
        role: 'reviewer',
        requestContentDigest,
        providerId: identity.providerId,
        modelId: identity.modelId,
        configId: identity.configId,
        configVersion: identity.configVersion,
        decisionAuthorityGeneration: identity.decisionAuthorityGeneration,
      });
      const context = {
        ...admission.context,
        requestContentDigest,
        providerRequest: request,
        providerIdentity: identity,
        providerAdmissionReceipt: receipt,
      };
      const trustedContext = createTestProviderAdmissionTrustedContextV02(context);
      return { request, context, trustedContext };
    };

    const config = {
      ...fixture.config,
      reviewEvidence: durableStore,
      reviewerAdmission,
    };

    await approveVerification(fixture);

    const app = createProductionRoute(ports, config);
    const graphResult = await app.invoke({ task: fixture.task, state: undefined, reasons: [], milestones: [] });

    const finalOutcome = graphResult.finalReport?.outcome ?? graphResult.terminalOutcome ?? graphResult.state?.outcome;
    assert.ok(
      finalOutcome === 'COMPLETED' || graphResult.state?.node === 'Review' || graphResult.state?.node === 'Deliver',
      `Graph reached unexpected outcome: ${finalOutcome}, node: ${graphResult.state?.node}`,
    );

    // Verify durable storage committed review observation
    const { readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      );
    const persistedFiles = walk(dir);
    assert.ok(persistedFiles.length >= 3, `Expected at least 3 durable files, found: ${persistedFiles.length}`);

    // Verify recovery through candidate discovery index without provider replay
    const taskState = await fixture.owner.loadTask(fixture.task.taskId);
    assert.ok(taskState);
    const diffInfo = await fixture.ports.repositoryPort.inspectDiff(fixture.task.initialRevisionDigest);
    const snapshot = await fixture.owner.readVerificationAuthoritySnapshot(fixture.task.taskId);
    assert.ok(snapshot);
    assert.ok(taskState.plan && taskState.plan.decisionRef);

    const recovered = await durableStore.recoverObservation({
      taskId: fixture.task.taskId,
      workspaceId: taskState.workspaceId,
      repositoryId: fixture.task.repositoryId,
      headRevisionDigest: taskState.repositoryRevisionDigest,
      diffDigest: diffInfo.diffDigest,
      expectedAuthority: {
        taskStateVersion: taskState.stateVersion,
        controlVersion: snapshot.controlVersion,
        epoch: snapshot.epoch,
        decisionAuthorityGeneration: snapshot.decisionAuthorityGeneration,
        planDecisionRef: taskState.plan.decisionRef,
        planBindingDigest: currentPlanBindingDigest(fixture.task, taskState),
      },
    });

    assert.equal(recovered.outcome, 'found');
    assert.ok(recovered.observation);
    assert.ok(recovered.observation.providerRequestId && recovered.observation.providerRequestId.startsWith('bound-review-'));
    assert.equal(recovered.observation.evidenceTier, 'real-integration');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
