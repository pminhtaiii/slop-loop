/*
 * CONTROLLED TIER ONLY. These tests exercise an injected stand-in owner delivery; they prove the
 * adapter's validation and refusal behaviour, nothing about durability. A controlled acknowledgement
 * is not restart/durability evidence: actual owner durability and recovery remain with the accepted
 * UC-04 public writer, which is an external prerequisite (T023 acceptance).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCanonicalSha256, computeCheckSetDigest, type CheckDefinition } from '../../../src/contracts/foundation/uc03.ts';
import {
  createBaselineEvidenceAdapter,
  type OwnerBaselineEvidenceDelivery,
  type OwnerBaselineLoadOutcome,
  type OwnerBaselineLookupRequest,
  type OwnerBaselineWriteOutcome,
} from '../../../src/runtime/baseline-evidence-adapter.ts';
import type { BaselineEvidenceAcknowledgement, BaselineEvidenceCandidate, BaselineEvidenceWriteRequest } from '../../../src/uc03/investigation-types.ts';

const requiredChecks: readonly CheckDefinition[] = Object.freeze([
  Object.freeze({ checkId: 'check-repro', executable: 'python', argv: Object.freeze(['-m', 'pytest', 'tests/test_bug.py']), purpose: 'reproduction' as const }),
  Object.freeze({ checkId: 'check-regression', executable: 'python', argv: Object.freeze(['-m', 'pytest', 'tests/test_ok.py']), purpose: 'regression' as const }),
]);

function makeCandidate(overrides: Partial<Record<keyof BaselineEvidenceCandidate, unknown>> = {}): BaselineEvidenceCandidate {
  const acceptanceCriteria = ['the reported defect no longer reproduces'];
  const base: BaselineEvidenceCandidate = {
    taskId: 'task-1',
    workspaceId: 'workspace-1',
    repositoryId: 'repo-1',
    acceptanceCriteria,
    criteriaDigest: computeCanonicalSha256(acceptanceCriteria),
    requiredChecks,
    expectedPassingCheckIds: ['check-regression'],
    reproductionCheckId: 'check-repro',
    expectedTestFiles: ['tests/test_bug.py', 'tests/test_ok.py'],
    repositorySnapshotDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    checkSetDigest: computeCheckSetDigest(requiredChecks),
    reproductionFailureSignature: 'AssertionError: expected 1 got 2',
    checkResults: Object.freeze([Object.freeze({ checkId: 'check-repro', outcome: 'fail' as const }), Object.freeze({ checkId: 'check-regression', outcome: 'pass' as const })]),
    testProtectionDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  };
  return { ...base, ...overrides } as BaselineEvidenceCandidate;
}

function makeAck(content: BaselineEvidenceCandidate, evidenceId: string): BaselineEvidenceAcknowledgement {
  return {
    evidenceId,
    taskId: content.taskId,
    workspaceId: content.workspaceId,
    repositoryId: content.repositoryId,
    contentDigest: computeCanonicalSha256(content),
    repositorySnapshotDigest: content.repositorySnapshotDigest,
    criteriaDigest: content.criteriaDigest,
    checkSetDigest: content.checkSetDigest,
    testProtectionDigest: content.testProtectionDigest,
    reproductionCheckId: content.reproductionCheckId,
    expectedPassingCheckIds: [...content.expectedPassingCheckIds],
    expectedTestFiles: [...content.expectedTestFiles],
    requiredCheckIds: content.requiredChecks.map(check => check.checkId),
  };
}

interface RecordingDelivery {
  readonly delivery: OwnerBaselineEvidenceDelivery;
  readonly writes: BaselineEvidenceWriteRequest[];
  readonly loads: OwnerBaselineLookupRequest[];
}

function recordingDelivery(persist: (request: BaselineEvidenceWriteRequest) => OwnerBaselineWriteOutcome, load?: (request: OwnerBaselineLookupRequest) => OwnerBaselineLoadOutcome): RecordingDelivery {
  const writes: BaselineEvidenceWriteRequest[] = [];
  const loads: OwnerBaselineLookupRequest[] = [];
  const delivery: OwnerBaselineEvidenceDelivery = {
    provenance: 'real',
    persist(request) {
      writes.push(request);
      return persist(request);
    },
    ...(load
      ? {
          load(request: OwnerBaselineLookupRequest) {
            loads.push(request);
            return load(request);
          },
        }
      : {}),
  };
  return { delivery, writes, loads };
}

function durableAck(evidenceId: string): (request: BaselineEvidenceWriteRequest) => OwnerBaselineWriteOutcome {
  return request => ({ outcome: 'durable', acknowledgement: makeAck(request.content, evidenceId) });
}

function writeRequest(content: BaselineEvidenceCandidate): BaselineEvidenceWriteRequest {
  return { content, contentDigest: computeCanonicalSha256(content) };
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof Error && error.message.startsWith(`${code}:`));
}

test('a durable owner write returns the exact canonical acknowledgement', async () => {
  const content = makeCandidate();
  const { delivery, writes } = recordingDelivery(durableAck('evidence-1'));
  const adapter = createBaselineEvidenceAdapter(delivery);

  const request = writeRequest(content);
  const acknowledgement = await adapter.persistBaselineEvidence(request);

  assert.deepEqual(acknowledgement, makeAck(content, 'evidence-1'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0], request, 'the owner receives the request unchanged, not a rebuilt copy');
});

test('an invalid canonical candidate is refused before the owner is called', async () => {
  const { delivery, writes } = recordingDelivery(durableAck('evidence-1'));
  const adapter = createBaselineEvidenceAdapter(delivery);

  // criteriaDigest does not match the criteria it claims.
  await rejectsWithCode(adapter.persistBaselineEvidence(writeRequest(makeCandidate({ criteriaDigest: 'sha256:00' }))), 'BASELINE_EVIDENCE_INVALID_CANDIDATE');
  // checkSetDigest substituted for the declared checks.
  await rejectsWithCode(adapter.persistBaselineEvidence(writeRequest(makeCandidate({ checkSetDigest: 'sha256:00' }))), 'BASELINE_EVIDENCE_INVALID_CANDIDATE');
  // Protected test path.
  await rejectsWithCode(adapter.persistBaselineEvidence(writeRequest(makeCandidate({ expectedTestFiles: ['tests/test_bug.py', '.env'] }))), 'BASELINE_EVIDENCE_INVALID_CANDIDATE');
  // Partial payload missing a canonical field.
  const partial = { ...makeCandidate() } as Record<string, unknown>;
  delete partial['testProtectionDigest'];
  await rejectsWithCode(
    adapter.persistBaselineEvidence({ content: partial as unknown as BaselineEvidenceCandidate, contentDigest: computeCanonicalSha256(partial) }),
    'BASELINE_EVIDENCE_INVALID_CANDIDATE',
  );
  // Request digest that does not match the candidate.
  await rejectsWithCode(adapter.persistBaselineEvidence({ content: makeCandidate(), contentDigest: 'sha256:00' }), 'BASELINE_EVIDENCE_DIGEST_MISMATCH');

  assert.equal(writes.length, 0, 'no invalid candidate reaches the owner');
});

test('an uncertain write blocks and never reports synthetic success', async () => {
  const { delivery } = recordingDelivery(() => ({ outcome: 'uncertain', operationRef: 'op-9' }));
  const adapter = createBaselineEvidenceAdapter(delivery);
  await rejectsWithCode(adapter.persistBaselineEvidence(writeRequest(makeCandidate())), 'BASELINE_EVIDENCE_WRITE_UNCERTAIN');
});

test('a denied write blocks', async () => {
  const { delivery } = recordingDelivery(() => ({ outcome: 'denied', reason: 'policy refused' }));
  const adapter = createBaselineEvidenceAdapter(delivery);
  await rejectsWithCode(adapter.persistBaselineEvidence(writeRequest(makeCandidate())), 'BASELINE_EVIDENCE_WRITE_DENIED');
});

test('a forged, stale, or partial acknowledgement blocks', async () => {
  const content = makeCandidate();
  const honest = makeAck(content, 'evidence-1');
  const forged: readonly unknown[] = [
    { ...honest, contentDigest: computeCanonicalSha256({ ...content, taskId: 'substituted' }) },
    { ...honest, taskId: 'task-stale' },
    { ...honest, repositorySnapshotDigest: 'sha256:33' },
    { ...honest, testProtectionDigest: 'sha256:33' },
    { ...honest, expectedTestFiles: ['tests/test_bug.py'] },
    { ...honest, requiredCheckIds: ['check-repro'] },
    { ...honest, evidenceId: '   ' },
    (() => {
      const partial: Record<string, unknown> = { ...honest };
      delete partial['expectedPassingCheckIds'];
      return partial;
    })(),
    { ...honest, unexpected: 'field' },
  ];
  for (const acknowledgement of forged) {
    const { delivery } = recordingDelivery(() => ({ outcome: 'durable', acknowledgement }));
    const adapter = createBaselineEvidenceAdapter(delivery);
    await rejectsWithCode(adapter.persistBaselineEvidence(writeRequest(content)), 'BASELINE_EVIDENCE_ACKNOWLEDGEMENT_MISMATCH');
  }
});

test('a duplicate evidence ID bound to different content blocks', async () => {
  const first = makeCandidate();
  const second = makeCandidate({ reproductionFailureSignature: 'AssertionError: a different failure' });
  const { delivery } = recordingDelivery(request => ({ outcome: 'durable', acknowledgement: makeAck(request.content, 'evidence-1') }));
  const adapter = createBaselineEvidenceAdapter(delivery);

  await adapter.persistBaselineEvidence(writeRequest(first));
  await rejectsWithCode(adapter.persistBaselineEvidence(writeRequest(second)), 'BASELINE_EVIDENCE_CONFLICT');
});

test('lookup returns the same bound content and acknowledgement', async () => {
  const content = makeCandidate();
  const acknowledgement = makeAck(content, 'evidence-1');
  const { delivery, loads } = recordingDelivery(durableAck('evidence-1'), () => ({ outcome: 'found', content, acknowledgement }));
  const adapter = createBaselineEvidenceAdapter(delivery);

  await adapter.persistBaselineEvidence(writeRequest(content));
  const loaded = await adapter.loadBaselineEvidence('task-1', 'workspace-1', 'repo-1', 'evidence-1');

  assert.deepEqual(loaded, { content, acknowledgement });
  assert.deepEqual(loads, [{ taskId: 'task-1', workspaceId: 'workspace-1', repositoryId: 'repo-1', evidenceId: 'evidence-1' }]);
});

test('an absent owner lookup and an explicit missing result are refusals, not silent undefined', async () => {
  const noLookup = createBaselineEvidenceAdapter(recordingDelivery(durableAck('evidence-1')).delivery);
  await rejectsWithCode(noLookup.loadBaselineEvidence('task-1', 'workspace-1', 'repo-1', 'evidence-1'), 'BASELINE_EVIDENCE_LOOKUP_UNAVAILABLE');

  const missing = createBaselineEvidenceAdapter(recordingDelivery(durableAck('evidence-1'), () => ({ outcome: 'missing' })).delivery);
  assert.equal(await missing.loadBaselineEvidence('task-1', 'workspace-1', 'repo-1', 'evidence-1'), null);

  const uncertain = createBaselineEvidenceAdapter(recordingDelivery(durableAck('evidence-1'), () => ({ outcome: 'uncertain', reason: 'owner unavailable' })).delivery);
  await rejectsWithCode(uncertain.loadBaselineEvidence('task-1', 'workspace-1', 'repo-1', 'evidence-1'), 'BASELINE_EVIDENCE_LOOKUP_UNCERTAIN');
});

test('a delivery whose load reads its own receiver is called bound', async () => {
  const content = makeCandidate();
  const self = {
    provenance: 'real' as const,
    content,
    persist(request: BaselineEvidenceWriteRequest): OwnerBaselineWriteOutcome {
      return { outcome: 'durable', acknowledgement: makeAck(request.content, 'evidence-1') };
    },
    load(request: OwnerBaselineLookupRequest): OwnerBaselineLoadOutcome {
      return request.evidenceId === 'evidence-1' ? { outcome: 'found', content: this.content, acknowledgement: makeAck(this.content, 'evidence-1') } : { outcome: 'missing' };
    },
  };
  const adapter = createBaselineEvidenceAdapter(self);

  await adapter.persistBaselineEvidence(writeRequest(content));
  const loaded = await adapter.loadBaselineEvidence('task-1', 'workspace-1', 'repo-1', 'evidence-1');

  assert.deepEqual(loaded, { content, acknowledgement: makeAck(content, 'evidence-1') });
});

test('a lookup for another task, a substituted digest, or a conflicting ID blocks', async () => {
  const content = makeCandidate();
  const acknowledgement = makeAck(content, 'evidence-1');
  // The last case is deliberately outside the declared union: an owner lookup must refuse an
  // untyped outcome rather than treat it as absence.
  const cases: readonly (() => OwnerBaselineLoadOutcome)[] = [
    () => ({ outcome: 'found', content: makeCandidate({ taskId: 'task-2' }), acknowledgement: makeAck(makeCandidate({ taskId: 'task-2' }), 'evidence-1') }),
    () => ({ outcome: 'found', content: makeCandidate({ testProtectionDigest: 'sha256:44' }), acknowledgement }),
    () => ({ outcome: 'found', content, acknowledgement: { ...acknowledgement, contentDigest: 'sha256:44' } }),
    () => ({ outcome: 'found', content, acknowledgement: makeAck(content, 'evidence-other') }),
    // Deliberately outside the declared union: an out-of-contract outcome must refuse, not read as absence.
    () => ({ outcome: 'denied' }) as unknown as OwnerBaselineLoadOutcome,
  ];
  for (const lookup of cases) {
    const adapter = createBaselineEvidenceAdapter(recordingDelivery(durableAck('evidence-1'), lookup).delivery);
    await assert.rejects(adapter.loadBaselineEvidence('task-1', 'workspace-1', 'repo-1', 'evidence-1'));
  }

  // Same ID, different content than the one already written through this adapter.
  const conflictingContent = makeCandidate({ reproductionFailureSignature: 'AssertionError: different' });
  const conflict = createBaselineEvidenceAdapter(
    recordingDelivery(durableAck('evidence-1'), () => ({ outcome: 'found', content: conflictingContent, acknowledgement: makeAck(conflictingContent, 'evidence-1') })).delivery,
  );
  await conflict.persistBaselineEvidence(writeRequest(content));
  await rejectsWithCode(conflict.loadBaselineEvidence('task-1', 'workspace-1', 'repo-1', 'evidence-1'), 'BASELINE_EVIDENCE_CONFLICT');
});
