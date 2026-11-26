import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeCanonicalSha256 as hash } from '../../../src/contracts/foundation/uc03.ts';
import { createDurableReviewEvidenceStore, DurableReviewEvidenceStore } from '../../../src/persistence/adapters/review-evidence-store.ts';
import type { ReviewObservationV1 } from '../../../src/contracts/review.ts';

const sha = 'sha256:' + 'a'.repeat(64);
const authority = { taskStateVersion: 1, controlVersion: 2, epoch: 1, decisionAuthorityGeneration: 1, planDecisionRef: 'D1', planBindingDigest: sha };
const diff = '--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-old\n+new\n';
const profile = {
  profileId: 'profile',
  profileVersion: '1',
  promptVersion: '1',
  promptDigest: 'sha256:' + 'a'.repeat(64),
  requiredConventionPaths: [],
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

function makeFixture() {
  const sourceEvidence = [{ path: 'src/a.py', revisionDigest: sha, boundedExcerpt: 'new', resultCount: 1, truncated: false }];
  const evidence = [{ evidenceRef: 'source', path: 'src/a.py', revisionDigest: sha, contentDigest: hash('new'), kind: 'source' as const }];
  const verification = {
    baselineRef: 'baseline',
    results: [{ evidenceId: 'check-result', checkId: 'check', phase: 'focused' as const, outcome: 'pass' as const, repoDigest: sha, diffDigest: hash(diff), contentDigest: sha }],
  };
  const binding = {
    taskId: 'task',
    runId: 'run',
    repositoryId: 'repo',
    workspaceId: 'ws',
    baseRevisionDigest: sha,
    headRevisionDigest: sha,
    diffDigest: hash(diff),
    criteriaDigest: sha,
    checkSetDigest: sha,
    verificationDigest: hash(verification),
    conventionsDigest: hash([]),
    evidenceDigest: hash(sourceEvidence),
    profileDigest: hash(profile),
  };
  const body = { schemaVersion: 'uc06-review-context/1' as const, binding, authority, profile, verification, conventions: [], evidence };
  const context = { ...body, contextDigest: hash(body) };

  const obs: ReviewObservationV1 = {
    schemaVersion: 'uc06-review-observation/1',
    contextDigest: context.contextDigest,
    binding: context.binding,
    authority: context.authority,
    reviewId: 'review',
    providerRequestId: 'provider',
    status: 'accepted',
    reasonCode: 'OK',
    result: {
      reviewId: 'review',
      reviewerRoleConfigId: 'reviewer',
      repoDigest: sha,
      diffDigest: context.binding.diffDigest,
      checkSetDigest: context.binding.checkSetDigest,
      status: 'accepted',
      findings: [],
      iterationReservationRef: 'reservation',
    },
    accountingRefs: ['reservation'],
    evidenceTier: 'controlled',
  };

  return { context, obs };
}

test('DurableReviewEvidenceStore: persist, load, and recover across fresh store instances', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uc04-review-store-'));
  try {
    const store1 = createDurableReviewEvidenceStore(dir);
    assert.equal(store1.reviewEvidenceApiVersion, 'uc06-review-evidence/1');
    assert.equal(store1.provenance, 'real');

    const { obs } = makeFixture();
    const oDigest = hash(obs);

    const persistRes = await store1.persistObservation({
      observation: obs,
      observationDigest: oDigest,
      expectedAuthority: authority,
      idempotencyKey: 'idem-key-1',
    });

    assert.equal(persistRes.outcome, 'acknowledged');
    if (persistRes.outcome !== 'acknowledged') throw new Error('Expected acknowledged');
    assert.equal(persistRes.ack.taskId, 'task');
    assert.equal(persistRes.ack.observationDigest, oDigest);
    assert.equal(persistRes.ack.committed, true);

    // Idempotent re-persist with same digest returns same ack
    const replayRes = await store1.persistObservation({
      observation: obs,
      observationDigest: oDigest,
      expectedAuthority: authority,
      idempotencyKey: 'idem-key-1',
    });
    assert.equal(replayRes.outcome, 'acknowledged');
    if (replayRes.outcome === 'acknowledged') {
      assert.equal(replayRes.ack.receiptId, persistRes.ack.receiptId);
    }

    // Conflicting persist with same key and different digest returns conflict
    assert.ok(obs.result);
    const obsConflict: ReviewObservationV1 = {
      ...obs,
      reviewId: 'review-2',
      providerRequestId: 'provider-2',
      result: {
        ...obs.result,
        reviewId: 'review-2',
      },
    };
    const conflictRes = await store1.persistObservation({
      observation: obsConflict,
      observationDigest: hash(obsConflict),
      expectedAuthority: authority,
      idempotencyKey: 'idem-key-1',
    });
    assert.equal(conflictRes.outcome, 'conflict');

    // Fresh instance over same baseDir (simulating process restart)
    const store2 = new DurableReviewEvidenceStore(dir);

    // Exact load from disk
    const loadRes = await store2.loadObservation({
      taskId: 'task',
      runId: 'run',
      providerRequestId: 'provider',
      contextDigest: obs.contextDigest,
      observationDigest: oDigest,
      expectedAuthority: authority,
    });

    assert.equal(loadRes.outcome, 'found');
    if (loadRes.outcome === 'found') {
      assert.deepEqual(loadRes.observation, obs);
      assert.equal(loadRes.ack.receiptId, persistRes.ack.receiptId);
    }

    // Candidate recovery without graph locator
    const recoverRes = await store2.recoverObservation({
      taskId: 'task',
      workspaceId: 'ws',
      repositoryId: 'repo',
      headRevisionDigest: sha,
      diffDigest: obs.binding.diffDigest,
      expectedAuthority: authority,
    });

    assert.equal(recoverRes.outcome, 'found');
    if (recoverRes.outcome === 'found') {
      assert.deepEqual(recoverRes.observation, obs);
      assert.equal(recoverRes.ack.observationDigest, oDigest);
    }

    // Missing candidate returns missing
    const missingRes = await store2.recoverObservation({
      taskId: 'task',
      workspaceId: 'ws',
      repositoryId: 'repo',
      headRevisionDigest: sha,
      diffDigest: 'sha256:' + '9'.repeat(64),
      expectedAuthority: authority,
    });
    assert.equal(missingRes.outcome, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
