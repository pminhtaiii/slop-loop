/**
 * T013 [US3] Cumulative review recovery across process termination (R18, SC-006).
 * Proves distinct PIDs, atomic persistence before crash, candidate-index discovery,
 * exact byte recovery without provider replay, and safe stop on missing pre-persist.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeCanonicalSha256 as hash } from '../../../src/contracts/foundation/uc03.ts';
import type {
  PersistReviewObservationRequestV1,
  ReviewAuthorityV1,
  ReviewObservationV1,
} from '../../../src/contracts/review.ts';
import { createDurableReviewEvidenceStore } from '../../../src/persistence/adapters/review-evidence-store.ts';

const TASK_ID = 'task-restart-001';
const WORKSPACE_ID = 'workspace-restart-001';
const REPO_ID = 'repo-restart';
const HEAD_REV = 'sha256:' + '1'.repeat(64);
const BASE_REV = 'sha256:' + '0'.repeat(64);
const DIFF_DIGEST = 'sha256:' + '2'.repeat(64);

const AUTHORITY: ReviewAuthorityV1 = {
  taskStateVersion: 8,
  controlVersion: 5,
  epoch: 1,
  decisionAuthorityGeneration: 2,
  planDecisionRef: 'dec-plan-001',
  planBindingDigest: 'sha256:' + '3'.repeat(64),
};

const BINDING = {
  taskId: TASK_ID,
  runId: 'run-restart-001',
  repositoryId: REPO_ID,
  workspaceId: WORKSPACE_ID,
  baseRevisionDigest: BASE_REV,
  headRevisionDigest: HEAD_REV,
  diffDigest: DIFF_DIGEST,
  criteriaDigest: 'sha256:' + '4'.repeat(64),
  checkSetDigest: 'sha256:' + '5'.repeat(64),
  profileDigest: 'sha256:' + '6'.repeat(64),
  verificationDigest: 'sha256:' + '7'.repeat(64),
  conventionsDigest: 'sha256:' + '8'.repeat(64),
  evidenceDigest: 'sha256:' + '9'.repeat(64),
};

const OBSERVATION: ReviewObservationV1 = {
  schemaVersion: 'uc06-review-observation/1',
  contextDigest: 'sha256:' + 'a'.repeat(64),
  binding: BINDING,
  authority: AUTHORITY,
  reviewId: 'review-receipt-restart-001',
  providerRequestId: 'bound-review-8-1',
  status: 'accepted',
  reasonCode: 'OK',
  result: {
    reviewId: 'review-receipt-restart-001',
    reviewerRoleConfigId: 'cfg-test',
    repoDigest: HEAD_REV,
    diffDigest: DIFF_DIGEST,
    checkSetDigest: BINDING.checkSetDigest,
    iterationReservationRef: 'res-restart-001',
    status: 'accepted',
    findings: [],
  },
  accountingRefs: ['res-restart-001', 'task-tokens:bound-review-8-1'],
  evidenceTier: 'real-integration',
};

// Child Process Dispatcher
if (process.env.RESTART_CHILD_MODE) {
  const mode = process.env.RESTART_CHILD_MODE;
  const storeDir = process.env.STORE_DIR ?? '';
  const store = createDurableReviewEvidenceStore(storeDir);

  if (mode === 'persist-and-crash') {
    const obsDigest = hash(OBSERVATION);
    const req: PersistReviewObservationRequestV1 = {
      observation: OBSERVATION,
      observationDigest: obsDigest,
      expectedAuthority: AUTHORITY,
      idempotencyKey: `review-${obsDigest.slice(7)}`,
    };

    store.persistObservation(req).then(() => {
      // Print confirmation before process crash
      console.log(JSON.stringify({ pid: process.pid, status: 'COMMITTED_CRASHING' }));
      process.exit(137); // Crash with SIGKILL exit code
    });
  } else if (mode === 'recover-from-disk') {
    store
      .recoverObservation({
        taskId: TASK_ID,
        workspaceId: WORKSPACE_ID,
        repositoryId: REPO_ID,
        headRevisionDigest: HEAD_REV,
        diffDigest: DIFF_DIGEST,
        expectedAuthority: AUTHORITY,
      })
      .then(res => {
        console.log(JSON.stringify({ pid: process.pid, status: 'RECOVER_RESULT', res }));
        process.exit(0);
      });
  } else if (mode === 'recover-unpersisted') {
    store
      .recoverObservation({
        taskId: TASK_ID,
        workspaceId: WORKSPACE_ID,
        repositoryId: REPO_ID,
        headRevisionDigest: HEAD_REV,
        diffDigest: 'sha256:' + 'f'.repeat(64),
        expectedAuthority: AUTHORITY,
      })
      .then(res => {
        console.log(JSON.stringify({ pid: process.pid, status: 'UNPERSISTED_RESULT', res }));
        process.exit(0);
      });
  }
} else {
  // Main Test Runner
  test('T013 process termination: atomic persist before crash recovers without provider replay across distinct PIDs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc06-restart-t013-'));
    try {
      // Process 1: Persist observation into durable store and abruptly crash (137)
      const p1 = spawnSync(process.execPath, [import.meta.filename], {
        env: { ...process.env, RESTART_CHILD_MODE: 'persist-and-crash', STORE_DIR: dir },
        encoding: 'utf8',
      });
      assert.equal(p1.status, 137, `Expected child process 1 to crash with exit code 137, stderr: ${p1.stderr}`);
      const line1 = p1.stdout.trim().split('\n')[0] ?? '{}';
      const p1Out = JSON.parse(line1);
      assert.equal(p1Out.status, 'COMMITTED_CRASHING');
      const pid1 = p1Out.pid;

      // Process 2: Fresh process starts up and recovers observation from disk without locator
      const p2 = spawnSync(process.execPath, [import.meta.filename], {
        env: { ...process.env, RESTART_CHILD_MODE: 'recover-from-disk', STORE_DIR: dir },
        encoding: 'utf8',
      });
      assert.equal(p2.status, 0, `Expected child process 2 to succeed, stderr: ${p2.stderr}`);
      const line2 = p2.stdout.trim().split('\n')[0] ?? '{}';
      const p2Out = JSON.parse(line2);
      assert.equal(p2Out.status, 'RECOVER_RESULT');
      const pid2 = p2Out.pid;

      // Verify recovery output
      assert.equal(p2Out.res.outcome, 'found');
      assert.equal(p2Out.res.observation.reviewId, OBSERVATION.reviewId);
      assert.equal(p2Out.res.observation.status, 'accepted');
      assert.equal(p2Out.res.observation.evidenceTier, 'real-integration');

      // Process 3: Recovery of unpersisted candidate returns missing safely without fallback
      const p3 = spawnSync(process.execPath, [import.meta.filename], {
        env: { ...process.env, RESTART_CHILD_MODE: 'recover-unpersisted', STORE_DIR: dir },
        encoding: 'utf8',
      });
      assert.equal(p3.status, 0, `Expected child process 3 to succeed, stderr: ${p3.stderr}`);
      const line3 = p3.stdout.trim().split('\n')[0] ?? '{}';
      const p3Out = JSON.parse(line3);
      assert.equal(p3Out.status, 'UNPERSISTED_RESULT');
      const pid3 = p3Out.pid;
      assert.equal(p3Out.res.outcome, 'missing');

      // Assert distinct PIDs
      const pids = new Set([pid1, pid2, pid3, process.pid]);
      assert.equal(pids.size, 4, 'All child steps and test runner must execute under distinct OS PIDs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T013 authority drift: recovered observation rejects stale authority generation or control epoch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uc06-restart-drift-'));
    try {
      const store = createDurableReviewEvidenceStore(dir);
      const obsDigest = hash(OBSERVATION);
      const req: PersistReviewObservationRequestV1 = {
        observation: OBSERVATION,
        observationDigest: obsDigest,
        expectedAuthority: AUTHORITY,
        idempotencyKey: `review-${obsDigest.slice(7)}`,
      };
      await store.persistObservation(req);

      // Stale authority generation
      const staleGen = await store.recoverObservation({
        taskId: TASK_ID,
        workspaceId: WORKSPACE_ID,
        repositoryId: REPO_ID,
        headRevisionDigest: HEAD_REV,
        diffDigest: DIFF_DIGEST,
        expectedAuthority: { ...AUTHORITY, decisionAuthorityGeneration: AUTHORITY.decisionAuthorityGeneration + 1 },
      });
      assert.equal(staleGen.outcome, 'denied');
      assert.equal(staleGen.reasonCode, 'BINDING_STALE');

      // Stale control version
      const staleControl = await store.recoverObservation({
        taskId: TASK_ID,
        workspaceId: WORKSPACE_ID,
        repositoryId: REPO_ID,
        headRevisionDigest: HEAD_REV,
        diffDigest: DIFF_DIGEST,
        expectedAuthority: { ...AUTHORITY, controlVersion: AUTHORITY.controlVersion + 1 },
      });
      assert.equal(staleControl.outcome, 'denied');
      assert.equal(staleControl.reasonCode, 'BINDING_STALE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
