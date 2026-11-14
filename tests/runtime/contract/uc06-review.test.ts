import assert from 'node:assert/strict';
import test from 'node:test';
import { REVIEW_SCHEMAS } from '../../../src/contracts/review.ts';
import {
  validateReviewProfile,
  validateReviewBinding,
  validateReviewContext,
  validateReviewContextAdmission,
  validateReviewDiff,
  validateReviewOutput,
  validateReviewObservation,
  validatePersistReviewObservationRequest,
} from '../../../src/uc06/validation.ts';
import { computeCanonicalSha256 as hash } from '../../../src/contracts/foundation/uc03.ts';
import {
  validateReviewEvidenceAck,
  validateLoadReviewObservationRequest,
  validateRecoverReviewObservationRequest,
  validatePersistReviewObservationResult,
  validateLoadReviewObservationResult,
  validateRecoverReviewObservationResult,
} from '../../../src/uc06/validation.ts';
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
test('schema descriptors are deeply immutable', () => {
  assert.equal(Object.isFrozen(REVIEW_SCHEMAS), true);
  assert.equal(Object.isFrozen(REVIEW_SCHEMAS['profile']), true);
});

test('accepts an explicit finite reviewer profile without inventing defaults', () => {
  assert.equal(validateReviewProfile(profile).ok, true);
});
const sha = 'sha256:' + 'a'.repeat(64);
const authority = { taskStateVersion: 1, controlVersion: 2, epoch: 1, decisionAuthorityGeneration: 1, planDecisionRef: 'D1', planBindingDigest: sha };
const diff = '--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-old\n+new\n';
function fixture() {
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
  return { context: { ...body, contextDigest: hash(body) }, sourceEvidence };
}
test('accepts a complete immutable context with internally consistent identities', () => {
  const f = fixture();
  const result = validateReviewContext(f.context);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(Object.isFrozen(result.value.binding), true);
    assert.notEqual(result.value, f.context);
  }
});
test('accepts ordinary identifiers with an embedded sk- substring through context admission', () => {
  const f = fixture();
  const binding = { ...f.context.binding, taskId: 'task-independent' };
  assert.equal(validateReviewBinding(binding).ok, true);
  const { contextDigest, ...body } = { ...f.context, binding };
  const context = { ...body, contextDigest: hash(body) };
  assert.notEqual(context.contextDigest, contextDigest);
  assert.equal(validateReviewContext(context).ok, true);
  assert.equal(validateReviewContextAdmission(context, { binding, authority, sourceEvidence: f.sourceEvidence, requiredCheckIds: ['check'] }).ok, true);
  assert.equal(validateReviewProfile({ ...profile, profileId: 'task-independent' }).ok, true);
});

test('still refuses credential tokens and protected content in identifiers and finding messages', () => {
  const finding = { file: 'src/a.py', line: 1, side: 'new', severity: 'error', message: 'The task-independent result violates the requirement.', evidenceRef: 'source' };
  assert.equal(validateReviewOutput({ status: 'findings', findings: [finding] }, fixture().context, diff).ok, true);
  for (const secret of [
    'sk-exampleCredential',
    'SK-exampleCredential',
    'api_key=exampleCredential',
    'token=exampleCredential',
    'password=exampleCredential',
    'bearer exampleCredential',
    'MARKER_SECRET',
    'SECRET_KEY',
    'BEGIN PRIVATE KEY',
  ]) {
    assert.equal(validateReviewBinding({ ...fixture().context.binding, taskId: secret }).ok, false);
    for (const message of [secret, `The task-independent result leaked ${secret}.`, `Credential: "${secret}".`])
      assert.equal(validateReviewOutput({ status: 'findings', findings: [{ ...finding, message }] }, fixture().context, diff).ok, false);
  }
});
test('validates real changed lines and an evidence-backed finding', () => {
  const result = validateReviewDiff(diff, 49152);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value['src/a.py'], { oldLines: [1], newLines: [1] });
  assert.equal(
    validateReviewOutput(
      { status: 'findings', findings: [{ file: 'src/a.py', line: 1, side: 'new', severity: 'error', message: 'The changed result violates the expected task behavior.', evidenceRef: 'source' }] },
      fixture().context,
      diff,
    ).ok,
    true,
  );
});
test('admits ordinary identifiers in changed source lines while refusing protected diff content', () => {
  const patch = diff.replace('+new', '+task-independent');
  const result = validateReviewDiff(patch, 49152);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value['src/a.py'], { oldLines: [1], newLines: [1] });
  for (const secret of [
    'sk-exampleCredential',
    'SK-exampleCredential',
    'token=exampleCredential',
    'api_key=exampleCredential',
    'password=exampleCredential',
    'bearer exampleCredential',
    'MARKER_SECRET',
    'SECRET_KEY',
    'UNAPPROVED_CONTEXT',
    'BEGIN PRIVATE KEY',
  ]) {
    for (const line of [`+${secret}`, `+task-independent ${secret}`, `-${secret}`]) assert.equal(validateReviewDiff(diff.replace(line.startsWith('+') ? '+new' : '-old', line), 49152).ok, false);
  }
});
function observation() {
  const c = fixture().context;
  return {
    schemaVersion: 'uc06-review-observation/1' as const,
    contextDigest: c.contextDigest,
    binding: c.binding,
    authority: c.authority,
    reviewId: 'review',
    providerRequestId: 'provider',
    status: 'accepted' as const,
    reasonCode: 'OK' as const,
    result: {
      reviewId: 'review',
      reviewerRoleConfigId: 'reviewer',
      repoDigest: sha,
      diffDigest: c.binding.diffDigest,
      checkSetDigest: c.binding.checkSetDigest,
      status: 'accepted' as const,
      findings: [],
      iterationReservationRef: 'reservation',
    },
    accountingRefs: ['reservation'],
    evidenceTier: 'controlled' as const,
  };
}
test('validates observed settlement metadata and exact immutable persist payload', () => {
  const o = observation();
  assert.equal(validateReviewObservation(o).ok, true);
  assert.equal(validatePersistReviewObservationRequest({ observation: o, observationDigest: hash(o), expectedAuthority: authority, idempotencyKey: 'persist' }).ok, true);
});
test('refuses unconfigured bounds, inherited/accessor inputs, secret content and unknown fields without invoking getters', () => {
  for (const bad of [
    { ...profile, maxDiffBytes: 0 },
    { ...profile, maxFindings: Infinity },
    { ...profile, maxOutputBytes: 0.5 },
    { ...profile, maxResponseBytes: 1 },
    { ...profile, extra: true },
    { ...profile, profileId: 'token=secretvalue' },
  ])
    assert.equal(validateReviewProfile(bad).ok, false);
  let getters = 0;
  const hostile = { ...profile };
  Object.defineProperty(hostile, 'profileId', {
    get() {
      getters++;
      throw new Error('forbidden');
    },
    enumerable: true,
  });
  assert.equal(validateReviewProfile(hostile).ok, false);
  assert.equal(getters, 0);
  assert.equal(validateReviewProfile(Object.create(profile)).ok, false);
});
test('never accepts wrong lines/sides/evidence or silently drops contradictory findings', () => {
  const finding = { file: 'src/a.py', line: 1, side: 'new', severity: 'error', message: 'The result violates the task requirement.', evidenceRef: 'source' };
  for (const altered of [
    { ...finding, file: 'src/other.py' },
    { ...finding, line: 2 },
    { ...finding, line: Number.MAX_SAFE_INTEGER + 1 },
    { ...finding, side: 'left' },
    { ...finding, evidenceRef: 'invented' },
    { ...finding, evidenceRef: undefined },
    { ...finding, revision: sha },
    { ...finding, message: 'token=secretvalue' },
  ])
    assert.equal(validateReviewOutput({ status: 'findings', findings: [altered] }, fixture().context, diff).ok, false);
  assert.equal(validateReviewOutput({ status: 'accepted', findings: [finding] }, fixture().context, diff).ok, false);
  assert.equal(validateReviewOutput({ status: 'findings', findings: [] }, fixture().context, diff).ok, false);
  assert.equal(validateReviewOutput({ status: 'accepted', findings: [], actions: [{ kind: 'write' }] }, fixture().context, diff).ok, false);
});
test('refuses whole unsupported diffs, mixed metadata and overflowing/malformed hunk coordinates', () => {
  for (const bad of [
    '',
    diff + 'GIT binary patch\n',
    diff + 'old mode 100644\n',
    diff.replace('b/src/a.py', 'b/src/b.py'),
    diff.replace('@@ -1 +1 @@', '@@ -9007199254740991,2 +1,2 @@'),
    diff.replace('-old\n', ''),
    diff.replace('src/a.py', '../a.py'),
    diff + '--- a/extra.py\n+++ b/extra.py\n',
  ])
    assert.equal(validateReviewDiff(bad, 49152).ok, false, bad);
  assert.equal(validateReviewDiff(diff, 1).ok, false);
});
test('requires consistent unchanged prefixes and gaps across complete diff hunks', () => {
  const headers = '--- a/src/a.py\n+++ b/src/a.py\n';
  for (const patch of ['--- /dev/null\n+++ b/src/a.py\n@@ -0,0 +42 @@\n+new\n', '--- a/src/a.py\n+++ /dev/null\n@@ -42 +0,0 @@\n-old\n', diff + '@@ -3 +42 @@\n-old\n+new\n'])
    assert.equal(validateReviewDiff(patch, 49152).ok, false, patch);
  for (const patch of [diff + '@@ -3 +3 @@\n-old\n+new\n', headers + '@@ -1,0 +2 @@\n+inserted\n@@ -3 +4 @@\n-old\n+new\n', headers + '@@ -2 +1,0 @@\n-removed\n@@ -4 +3 @@\n-old\n+new\n'])
    assert.equal(validateReviewDiff(patch, 49152).ok, true, patch);
});
function evidenceFixture() {
  const o = observation(),
    observationDigest = hash(o);
  const ack = {
    schemaVersion: 'uc06-review-evidence/1' as const,
    receiptId: 'receipt',
    taskId: 'task',
    runId: 'run',
    repositoryId: 'repo',
    workspaceId: 'ws',
    headRevisionDigest: sha,
    diffDigest: o.binding.diffDigest,
    contextDigest: o.contextDigest,
    providerRequestId: 'provider',
    observationDigest,
    storeRecordVersion: 1,
    committed: true as const,
  };
  return {
    o,
    ack,
    persist: { observation: o, observationDigest, expectedAuthority: authority, idempotencyKey: 'persist' },
    load: { taskId: 'task', runId: 'run', providerRequestId: 'provider', contextDigest: o.contextDigest, observationDigest, expectedAuthority: authority },
    recover: { taskId: 'task', workspaceId: 'ws', repositoryId: 'repo', headRevisionDigest: sha, diffDigest: o.binding.diffDigest, expectedAuthority: authority },
  };
}
test('accepts exact acknowledged evidence roundtrip and recovery without graph-only locators', () => {
  const f = evidenceFixture();
  assert.equal(validateReviewEvidenceAck(f.ack, f.o).ok, true);
  assert.equal(validateLoadReviewObservationRequest(f.load).ok, true);
  assert.equal(validateRecoverReviewObservationRequest(f.recover).ok, true);
  assert.equal(validatePersistReviewObservationResult({ outcome: 'acknowledged', ack: f.ack }, f.persist).ok, true);
  assert.equal(validateLoadReviewObservationResult({ outcome: 'found', observation: f.o, ack: f.ack }, f.load).ok, true);
  assert.equal(validateRecoverReviewObservationResult({ outcome: 'found', observation: f.o, ack: f.ack }, f.recover).ok, true);
});

test('accepts Git textual additions and deletions with exact changed sides', () => {
  for (const added of [true, false]) {
    const patch = gitFileDiff(added);
    const result = validateReviewDiff(patch, 49152);
    assert.equal(result.ok, true, patch);
    if (result.ok) assert.deepEqual(result.value['src/a.py'], { oldLines: added ? [] : [1], newLines: added ? [1] : [] });
    assert.equal(validateReviewDiff(patch.replace(/^(new|deleted) file mode 100644\nindex abc\.\.def\n/mu, ''), 49152).ok, true);
  }
  assert.equal(validateReviewDiff('diff --git a/src/a.py b/src/a.py\nindex abc..def 100644\n' + diff, 49152).ok, true);
});
function gitFileDiff(added: boolean): string {
  return (
    'diff --git a/src/a.py b/src/a.py\n' +
    (added ? 'new' : 'deleted') +
    ' file mode 100644\nindex abc..def\n' +
    (added ? '--- /dev/null\n+++ b/src/a.py\n@@ -0,0 +1 @@\n+new\n' : '--- a/src/a.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n')
  );
}

for (const added of [true, false]) {
  test(`refuses nonzero /dev/null hunk origins for textual ${added ? 'additions' : 'deletions'}`, () => {
    const gitPatch = gitFileDiff(added);
    const barePatch = gitPatch.slice(gitPatch.indexOf('--- '));
    for (const patch of [gitPatch, barePatch]) {
      const valid = validateReviewDiff(patch, 49152);
      assert.equal(valid.ok, true);
      if (valid.ok) assert.deepEqual(valid.value['src/a.py'], { oldLines: added ? [] : [1], newLines: added ? [1] : [] });
      for (const origin of [1, 42, Number.MAX_SAFE_INTEGER]) {
        const malformed = patch.replace(added ? '-0,0' : '+0,0', `${added ? '-' : '+'}${origin},0`);
        assert.equal(validateReviewDiff(malformed, 49152).ok, false, malformed);
        assert.equal(validateReviewDiff(diff + malformed.replaceAll('src/a.py', 'src/extra.py'), 49152).ok, false, 'A malformed entry must reject the whole diff');
      }
    }
  });
}
test('refuses contradictory, repeated and unsupported Git file metadata', () => {
  for (const added of [true, false]) {
    const patch = gitFileDiff(added);
    for (const bad of [
      patch.replace('index abc..def', 'index abc..def 100644'),
      patch.replace('index abc..def\n', ''),
      patch.replace('file mode 100644', 'file mode 120000'),
      patch.replace('index abc..def', 'new file mode 100644\nindex abc..def'),
      patch.replace('index abc..def', 'deleted file mode 100644\nindex abc..def'),
      patch.replace(added ? 'new file mode' : 'deleted file mode', added ? 'deleted file mode' : 'new file mode'),
      patch.replace('/dev/null', added ? 'a/src/a.py' : 'b/src/a.py'),
      patch.replace('diff --git a/src/a.py b/src/a.py\n', ''),
    ])
      assert.equal(validateReviewDiff(bad, 49152).ok, false, bad);
  }
});
test('refuses forged and mismatched evidence ACK fields', () => {
  const f = evidenceFixture();
  for (const [key, value] of Object.entries({
    committed: false,
    storeRecordVersion: 0,
    receiptId: '',
    extra: true,
    taskId: 'other',
    runId: 'other',
    repositoryId: 'other',
    workspaceId: 'other',
    headRevisionDigest: hash('other'),
    diffDigest: hash('other'),
    contextDigest: hash('other'),
    providerRequestId: 'other',
    observationDigest: hash('other'),
  })) {
    const ack = { ...f.ack, [key]: value };
    assert.equal(validateReviewEvidenceAck(ack, f.o).ok, false, key);
    assert.equal(validateLoadReviewObservationResult({ outcome: 'found', observation: f.o, ack }, f.load).ok, false, key);
    assert.equal(validateRecoverReviewObservationResult({ outcome: 'found', observation: f.o, ack }, f.recover).ok, false, key);
  }
});
test('refuses found evidence for different locators, candidates and authority', () => {
  const f = evidenceFixture();
  const found = { outcome: 'found', observation: f.o, ack: f.ack };
  for (const [key, value] of Object.entries({ taskId: 'other', runId: 'other', providerRequestId: 'other', contextDigest: hash('other'), observationDigest: hash('other') }))
    assert.equal(validateLoadReviewObservationResult(found, { ...f.load, [key]: value }).ok, false, key);
  for (const [key, value] of Object.entries({ taskId: 'other', workspaceId: 'other', repositoryId: 'other', headRevisionDigest: hash('other'), diffDigest: hash('other') }))
    assert.equal(validateRecoverReviewObservationResult(found, { ...f.recover, [key]: value }).ok, false, key);
  for (const [key, value] of Object.entries({ taskStateVersion: 0, controlVersion: 1, epoch: 0, decisionAuthorityGeneration: 0, planDecisionRef: 'other', planBindingDigest: hash('other') })) {
    const expectedAuthority = { ...authority, [key]: value };
    assert.equal(validateLoadReviewObservationResult(found, { ...f.load, expectedAuthority }).ok, false, key);
    assert.equal(validateRecoverReviewObservationResult(found, { ...f.recover, expectedAuthority }).ok, false, key);
  }
});
test('refuses contradictory observations and mismatched result/accounting bindings', () => {
  const o = observation();
  for (const bad of [
    { ...o, result: null },
    { ...o, reviewId: null },
    { ...o, providerRequestId: null },
    { ...o, accountingRefs: [] },
    { ...o, accountingRefs: ['other'] },
    { ...o, reasonCode: 'FINDINGS' },
    { ...o, status: 'findings' },
    { ...o, status: 'blocked', reasonCode: 'MODEL_OUTPUT_INVALID' },
    { ...o, status: 'stale', reasonCode: 'MODEL_OUTPUT_INVALID' },
    { ...o, status: 'uncertain', reasonCode: 'MODEL_OUTPUT_INVALID' },
    { ...o, status: 'invalid', reasonCode: 'MODEL_OUTPUT_INVALID' },
    ...['reviewId', 'repoDigest', 'diffDigest', 'checkSetDigest'].map(key => ({
      ...o,
      result: { ...o.result, [key]: key === 'reviewId' ? 'other' : hash('other') },
    })),
  ])
    assert.equal(validateReviewObservation(bad).ok, false, JSON.stringify(bad));
});
test('admits exact host context and refuses binding, excerpts, limits and required checks', () => {
  const f = fixture();
  const source = f.sourceEvidence[0];
  assert.ok(source);
  const trusted = { binding: f.context.binding, authority, sourceEvidence: f.sourceEvidence, requiredCheckIds: ['check'] };
  assert.equal(validateReviewContextAdmission(f.context, trusted).ok, true);
  for (const bad of [
    { ...trusted, binding: { ...trusted.binding, taskId: 'other' } },
    { ...trusted, authority: { ...authority, epoch: 0 } },
    { ...trusted, sourceEvidence: [{ ...source, boundedExcerpt: 'different' }] },
    { ...trusted, requiredCheckIds: [] },
    { ...trusted, requiredCheckIds: ['missing'] },
    { ...trusted, requiredCheckIds: ['check', 'check'] },
  ])
    assert.equal(validateReviewContextAdmission(f.context, bad).ok, false);
  // Rehash altered supplied evidence so admission must check its content, not just the outer digest.
  for (const change of [{ boundedExcerpt: 'different' }, { truncated: true }, { revisionDigest: hash('other') }, { path: 'src/other.py' }]) {
    const sourceEvidence: typeof f.sourceEvidence = [{ ...source, ...change }];
    const binding = { ...f.context.binding, evidenceDigest: hash(sourceEvidence) };
    const { contextDigest, ...body } = { ...f.context, binding };
    const context = { ...body, contextDigest: hash(body) };
    assert.notEqual(context.contextDigest, contextDigest);
    assert.equal(validateReviewContext(context).ok, true);
    assert.equal(validateReviewContextAdmission(context, { ...trusted, binding, sourceEvidence }).ok, false);
  }
  const limitedProfile = { ...profile, maxEvidenceBytes: 2 };
  const binding = { ...f.context.binding, profileDigest: hash(limitedProfile) };
  const { contextDigest, ...body } = { ...f.context, profile: limitedProfile, binding };
  const context = { ...body, contextDigest: hash(body) };
  assert.notEqual(context.contextDigest, contextDigest);
  assert.equal(validateReviewContext(context).ok, true);
  assert.equal(validateReviewContextAdmission(context, { ...trusted, binding }).ok, false);
});
