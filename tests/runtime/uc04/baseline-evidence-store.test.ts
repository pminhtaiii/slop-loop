/**
 * T041 — the durable UC-04 baseline evidence store (real-tier contract §(b)2–3).
 *
 * Every row goes through `createBaselineEvidenceAdapter`, the real consumer, and a fresh store
 * instance over the same directory is what proves the content came from bytes rather than memory.
 * The two failure paths a filesystem cannot be made to produce on demand (a failed rename and a
 * rename that committed before its acknowledgement was lost) use the store's documented write seam.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { computeCanonicalSha256, computeCheckSetDigest, type CheckDefinition } from '../../../src/contracts/foundation/uc03.ts';
import { BASELINE_OPERATION_PREFIX, createBaselineEvidenceStore, type BaselineEvidenceStore } from '../../../src/persistence/adapters/baseline-evidence-store.ts';
import { atomicWrite, DurableStore } from '../../../src/persistence/store.ts';
import { createBaselineEvidenceAdapter } from '../../../src/runtime/baseline-evidence-adapter.ts';
import type { BaselineEvidenceAcknowledgement, BaselineEvidenceCandidate, BaselineEvidenceWriteRequest } from '../../../src/uc03/investigation-types.ts';

const ROOT = 'baseline-evidence';

const requiredChecks: readonly CheckDefinition[] = Object.freeze([
  Object.freeze({ checkId: 'check-repro', executable: 'python', argv: Object.freeze(['-m', 'pytest', 'tests/test_bug.py']), purpose: 'reproduction' as const }),
  Object.freeze({ checkId: 'check-regression', executable: 'python', argv: Object.freeze(['-m', 'pytest', 'tests/test_ok.py']), purpose: 'regression' as const }),
]);

function candidate(criteria: readonly string[] = ['the reported defect no longer reproduces']): BaselineEvidenceCandidate {
  return {
    taskId: 'task-1',
    workspaceId: 'workspace-1',
    repositoryId: 'repo-1',
    acceptanceCriteria: criteria,
    criteriaDigest: computeCanonicalSha256(criteria),
    requiredChecks,
    expectedPassingCheckIds: ['check-regression'],
    reproductionCheckId: 'check-repro',
    expectedTestFiles: ['tests/test_bug.py', 'tests/test_ok.py'],
    repositorySnapshotDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    checkSetDigest: computeCheckSetDigest(requiredChecks),
    reproductionFailureSignature: 'AssertionError: expected 1 got 2',
    checkResults: [
      { checkId: 'check-repro', outcome: 'fail' as const },
      { checkId: 'check-regression', outcome: 'pass' as const },
    ],
    testProtectionDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  };
}

function writeRequest(content: BaselineEvidenceCandidate): BaselineEvidenceWriteRequest {
  return { content, contentDigest: computeCanonicalSha256(content) };
}

function expectedAcknowledgement(evidenceId: string, content: BaselineEvidenceCandidate): BaselineEvidenceAcknowledgement {
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

async function stateDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'uc04-baseline-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

type CommitRecord = NonNullable<Parameters<typeof createBaselineEvidenceStore>[0]['commitRecord']>;

function storeAt(dir: string, commitRecord?: CommitRecord): BaselineEvidenceStore {
  return createBaselineEvidenceStore({ store: new DurableStore(dir), ...(commitRecord ? { commitRecord } : {}) });
}

function countingStore(dir: string, writes: string[]): BaselineEvidenceStore {
  return storeAt(dir, async ({ recordPath }, text) => {
    await atomicWrite(recordPath, text);
    writes.push(recordPath);
  });
}

async function soleRecordPath(dir: string): Promise<string> {
  const [entry] = await readdir(join(dir, ROOT));
  assert.ok(entry, 'expected exactly one stored baseline record');
  return join(dir, ROOT, entry, 'record.json');
}

async function storedOperationRef(dir: string): Promise<string> {
  const record = JSON.parse(await readFile(await soleRecordPath(dir), 'utf8')) as { operationRef: string };
  return record.operationRef;
}

function uncertainRef(outcome: unknown): string {
  assert.ok(typeof outcome === 'object' && outcome !== null && (outcome as { outcome?: unknown }).outcome === 'uncertain');
  const ref = (outcome as { operationRef?: unknown }).operationRef;
  assert.ok(typeof ref === 'string' && ref.startsWith(BASELINE_OPERATION_PREFIX));
  return ref;
}

test('a durable write acknowledges only after the bytes exist', async t => {
  const dir = await stateDir(t);
  const writes: string[] = [];
  const adapter = createBaselineEvidenceAdapter(countingStore(dir, writes));
  const content = candidate();

  const acknowledgement = await adapter.persistBaselineEvidence(writeRequest(content));

  assert.deepEqual(acknowledgement, expectedAcknowledgement(acknowledgement.evidenceId, content));
  assert.equal(writes.length, 1);
  assert.match(await readFile(await soleRecordPath(dir), 'utf8'), new RegExp(acknowledgement.evidenceId));
});

test('replaying identical content returns the same acknowledgement and writes nothing further', async t => {
  const dir = await stateDir(t);
  const writes: string[] = [];
  const adapter = createBaselineEvidenceAdapter(countingStore(dir, writes));
  const request = writeRequest(candidate());

  const first = await adapter.persistBaselineEvidence(request);
  assert.deepEqual(await adapter.persistBaselineEvidence(request), first);
  assert.equal(writes.length, 1);

  const freshWrites: string[] = [];
  assert.deepEqual(await createBaselineEvidenceAdapter(countingStore(dir, freshWrites)).persistBaselineEvidence(request), first);
  assert.equal(freshWrites.length, 0);
});

test('the same evidence identity with different content is denied and leaves the stored bytes unchanged', async t => {
  const dir = await stateDir(t);
  const store = storeAt(dir);
  const adapter = createBaselineEvidenceAdapter(store);
  await adapter.persistBaselineEvidence(writeRequest(candidate()));
  const before = await readFile(await soleRecordPath(dir), 'utf8');

  const changed = candidate(['a different acceptance criterion']);
  await assert.rejects(adapter.persistBaselineEvidence(writeRequest(changed)), /BASELINE_EVIDENCE_WRITE_DENIED/);
  assert.equal((await store.persist(writeRequest(changed))).outcome, 'denied');
  assert.equal(await readFile(await soleRecordPath(dir), 'utf8'), before);
});

test('a simulated failed rename is uncertain with an operationRef issued before the write', async t => {
  const dir = await stateDir(t);
  const attempted: string[] = [];
  const store = storeAt(dir, async ({ pendingPath }, text) => {
    attempted.push(text);
    await atomicWrite(pendingPath, text);
    throw new Error('simulated rename failure');
  });

  const ref = uncertainRef(await store.persist(writeRequest(candidate())));

  const [text] = attempted;
  assert.ok(text, 'the record bytes are issued before the durable write is attempted');
  assert.equal((JSON.parse(text) as { operationRef: string }).operationRef, ref);
});

test('load from a fresh store instance returns byte-identical content and acknowledgement', async t => {
  const dir = await stateDir(t);
  const content = candidate();
  const persisted = await createBaselineEvidenceAdapter(storeAt(dir)).persistBaselineEvidence(writeRequest(content));

  const loaded = await createBaselineEvidenceAdapter(storeAt(dir)).loadBaselineEvidence(content.taskId, content.workspaceId, content.repositoryId, persisted.evidenceId);

  assert.ok(loaded, 'expected the persisted baseline to load');
  assert.deepEqual(loaded.content, content);
  assert.deepEqual(loaded.acknowledgement, persisted);
});

test('unknown evidence is missing', async t => {
  const adapter = createBaselineEvidenceAdapter(storeAt(await stateDir(t)));
  assert.equal(await adapter.loadBaselineEvidence('task-1', 'workspace-1', 'repo-1', 'evidence-unknown'), null);
});

test('a corrupt stored file is uncertain, not missing', async t => {
  const dir = await stateDir(t);
  const content = candidate();
  const persisted = await createBaselineEvidenceAdapter(storeAt(dir)).persistBaselineEvidence(writeRequest(content));
  await writeFile(await soleRecordPath(dir), '{not-json');

  const adapter = createBaselineEvidenceAdapter(storeAt(dir));
  await assert.rejects(adapter.loadBaselineEvidence(content.taskId, content.workspaceId, content.repositoryId, persisted.evidenceId), /BASELINE_EVIDENCE_LOOKUP_UNCERTAIN/);
});

test('a lost acknowledgement resolves committed with the clean write acknowledgement and no further write', async t => {
  const dir = await stateDir(t);
  const cleanDir = await stateDir(t);
  const content = candidate();
  const request = writeRequest(content);
  const clean = await createBaselineEvidenceAdapter(storeAt(cleanDir)).persistBaselineEvidence(request);

  const lost = storeAt(dir, async ({ recordPath }, text) => {
    await atomicWrite(recordPath, text);
    throw new Error('lost acknowledgement after the rename committed');
  });
  const ref = uncertainRef(await lost.persist(request));

  const verifyWrites: string[] = [];
  const resolved = await countingStore(dir, verifyWrites).lookupWrite(ref);

  assert.ok(resolved.outcome === 'committed', `expected a committed write, got ${resolved.outcome}`);
  assert.deepEqual(resolved.acknowledgement, clean);
  assert.equal(verifyWrites.length, 0);
});

test('neither a final nor a temporary file resolves absent', async t => {
  const dir = await stateDir(t);
  const store = storeAt(dir, async () => {
    throw new Error('write abandoned before any bytes landed');
  });
  const ref = uncertainRef(await store.persist(writeRequest(candidate())));

  assert.deepEqual(await storeAt(dir).lookupWrite(ref), { outcome: 'absent' });
});

test('a leftover temporary file resolves unknown', async t => {
  const dir = await stateDir(t);
  const store = storeAt(dir, async ({ pendingPath }, text) => {
    await atomicWrite(pendingPath, text);
    throw new Error('write abandoned before the rename');
  });
  const ref = uncertainRef(await store.persist(writeRequest(candidate())));

  assert.deepEqual(await storeAt(dir).lookupWrite(ref), { outcome: 'unknown' });
});

test('a stored record whose bytes no longer match its digest resolves unknown', async t => {
  const dir = await stateDir(t);
  await storeAt(dir).persist(writeRequest(candidate()));
  const path = await soleRecordPath(dir);
  const ref = await storedOperationRef(dir);
  const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  record['contentDigest'] = `sha256:${'0'.repeat(64)}`;
  await writeFile(path, JSON.stringify(record));

  assert.deepEqual(await storeAt(dir).lookupWrite(ref), { outcome: 'unknown' });
});

test('an unreadable stored record resolves unknown rather than rejecting', async t => {
  const dir = await stateDir(t);
  await storeAt(dir).persist(writeRequest(candidate()));
  const path = await soleRecordPath(dir);
  const ref = await storedOperationRef(dir);
  await rm(path);
  await mkdir(path);

  assert.deepEqual(await storeAt(dir).lookupWrite(ref), { outcome: 'unknown' });
});

test('an unreadable evidence root resolves unknown rather than rejecting', async t => {
  const dir = await stateDir(t);
  await storeAt(dir).persist(writeRequest(candidate()));
  const ref = await storedOperationRef(dir);
  await rm(join(dir, ROOT), { recursive: true });
  await writeFile(join(dir, ROOT), 'not a directory');

  assert.deepEqual(await storeAt(dir).lookupWrite(ref), { outcome: 'unknown' });
});

test('load of an unreadable record is uncertain, not missing', async t => {
  const dir = await stateDir(t);
  const content = candidate();
  const persisted = await createBaselineEvidenceAdapter(storeAt(dir)).persistBaselineEvidence(writeRequest(content));
  const path = await soleRecordPath(dir);
  await rm(path);
  await mkdir(path);

  const adapter = createBaselineEvidenceAdapter(storeAt(dir));
  await assert.rejects(adapter.loadBaselineEvidence(content.taskId, content.workspaceId, content.repositoryId, persisted.evidenceId), /BASELINE_EVIDENCE_LOOKUP_UNCERTAIN/);
});

test('persist onto an unreadable record is uncertain with the issued operationRef', async t => {
  const dir = await stateDir(t);
  const request = writeRequest(candidate());
  await storeAt(dir).persist(request);
  const path = await soleRecordPath(dir);
  await rm(path);
  await mkdir(path);

  uncertainRef(await storeAt(dir).persist(request));
});

test('a foreign or malformed operationRef resolves unknown', async t => {
  const store = storeAt(await stateDir(t));
  assert.deepEqual(await store.lookupWrite('uc04-journal:claim-1'), { outcome: 'unknown' });
  assert.deepEqual(await store.lookupWrite(`${BASELINE_OPERATION_PREFIX}not-hex`), { outcome: 'unknown' });
});
