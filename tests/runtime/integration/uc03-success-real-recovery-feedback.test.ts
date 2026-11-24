/**
 * Feedback regressions for PR249 recovery findings CR249-REF, CR249-SCAN, CR249-IO.
 */
import assert from 'node:assert/strict';
import fs, { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeCanonicalSha256 } from '../../../src/contracts/foundation/uc03.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { createBaselineEvidenceStore } from '../../../src/persistence/adapters/baseline-evidence-store.ts';
import type { BaselineEvidenceCandidate } from '../../../src/uc03/investigation-types.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';
import { runCampaign, type CampaignOptions } from './uc03-success-real-run.ts';

function baseCampaignOptions(stateRoot: string, evidenceDir: string): Omit<CampaignOptions, 'mode'> {
  const fixture = createScanFixture('recovery-fb-', 'controlled-recovery-fb-key');
  return {
    env: fixture.envOf(),
    repositoryRoot: process.cwd(),
    candidateSha: '87ea41566aa2effdb98d48daa4da6c46b6ec37d4',
    stateRoot,
    evidenceDir,
  };
}

async function seedSettledBaselineStore(targetDir: string): Promise<string> {
  const store = new DurableStore(targetDir);
  await store.init();
  const baselineStore = createBaselineEvidenceStore({ store });
  const check: BaselineEvidenceCandidate['requiredChecks'][number] = {
    checkId: 'chk-1',
    executable: 'pytest',
    argv: ['tests/test_app.py'],
    purpose: 'reproduction',
    workingDirectory: '/workspace',
    timeoutMs: 1000,
    maxOutputBytes: 1024,
  };
  const candidate: BaselineEvidenceCandidate = {
    taskId: 'task-fb-001',
    workspaceId: 'workspace-fb-001',
    repositoryId: 'repo-fb-001',
    acceptanceCriteria: ['criteria-1'],
    criteriaDigest: 'sha256:' + 'b'.repeat(64),
    requiredChecks: [check],
    expectedPassingCheckIds: ['chk-1'],
    reproductionCheckId: 'chk-1',
    expectedTestFiles: ['tests/test_app.py'],
    repositorySnapshotDigest: 'sha256:' + 'a'.repeat(64),
    checkSetDigest: 'sha256:' + 'c'.repeat(64),
    reproductionFailureSignature: 'AssertionError: failure',
    checkResults: [{ checkId: 'chk-1', outcome: 'fail' }],
    testProtectionDigest: 'sha256:' + 'd'.repeat(64),
  };
  await baselineStore.persist({ content: candidate, contentDigest: computeCanonicalSha256(candidate) });
  const [keyHash] = readdirSync(join(targetDir, 'baseline-evidence'));
  assert.ok(keyHash);
  const rec = JSON.parse(readFileSync(join(targetDir, 'baseline-evidence', keyHash, 'record.json'), 'utf8')) as { operationRef: string };
  return rec.operationRef;
}

async function runResume(baseDir: string, resumeRef: string, onFetch?: () => void, onSpawn?: () => void) {
  return runCampaign({
    ...baseCampaignOptions(baseDir, join(baseDir, 'evidence')),
    mode: 'resume',
    resumeRef,
    fetch: async () => {
      onFetch?.();
      throw new Error('forbidden fetch');
    },
    spawn: async () => {
      onSpawn?.();
      throw new Error('forbidden spawn');
    },
  });
}

// ----------------------------------------------------------------------------
// CR249-REF (baseline-ref): malformed baseline operationRef strings fail closed
// ----------------------------------------------------------------------------
test('CR249-REF: malformed baseline operationRef in committed record.json fails closed even alongside valid matching root', async () => {
  const cases = [
    { name: 'empty ref', ref: '' },
    { name: 'wrong prefix', ref: 'uc03-journal:' + 'a'.repeat(64) },
    { name: 'short hash', ref: 'uc04-baseline:1234abcd' },
    { name: 'long hash', ref: 'uc04-baseline:' + 'a'.repeat(65) },
    { name: 'invalid hex', ref: 'uc04-baseline:' + 'z'.repeat(64) },
    { name: 'uppercase hex', ref: 'uc04-baseline:' + 'A'.repeat(64) },
  ];
  for (const c of cases) {
    const baseDir = mkdtempSync(join(tmpdir(), 't054-ref-comm-'));
    const seedDir = mkdtempSync(join(tmpdir(), 't054-ref-seed-'));
    try {
      const validRef = await seedSettledBaselineStore(seedDir);
      mkdirSync(join(baseDir, 'campaign-valid', 'C01'), { recursive: true });
      cpSync(seedDir, join(baseDir, 'campaign-valid', 'C01', 'store'), { recursive: true });

      const corruptDir = join(baseDir, 'campaign-corrupt', 'C01', 'store', 'baseline-evidence', 'corrupt-entry');
      mkdirSync(corruptDir, { recursive: true });
      writeFileSync(join(corruptDir, 'record.json'), JSON.stringify({ operationRef: c.ref }), 'utf8');

      let fetches = 0;
      let spawns = 0;
      const res = await runResume(
        baseDir,
        validRef,
        () => fetches++,
        () => spawns++,
      );
      assert.equal(fetches, 0, `${c.name}: zero provider fetches`);
      assert.equal(spawns, 0, `${c.name}: zero docker spawns`);
      assert.equal(res.exitCode, 2, `${c.name}: malformed ref must block`);
      assert.equal(res.records[0]?.reasonCode, 'continuation-blocked');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
    }
  }
});

test('CR249-REF: malformed baseline operationRef in pending record.pending fails closed even alongside valid matching root', async () => {
  const cases = [
    { name: 'empty pending ref', ref: '' },
    { name: 'wrong prefix pending ref', ref: 'other-prefix:' + 'b'.repeat(64) },
    { name: 'bad length pending ref', ref: 'uc04-baseline:abc' },
    { name: 'uppercase pending ref', ref: 'uc04-baseline:' + 'F'.repeat(64) },
  ];
  for (const c of cases) {
    const baseDir = mkdtempSync(join(tmpdir(), 't054-ref-pend-'));
    const seedDir = mkdtempSync(join(tmpdir(), 't054-ref-seed-'));
    try {
      const validRef = await seedSettledBaselineStore(seedDir);
      mkdirSync(join(baseDir, 'campaign-valid', 'C01'), { recursive: true });
      cpSync(seedDir, join(baseDir, 'campaign-valid', 'C01', 'store'), { recursive: true });

      const corruptDir = join(baseDir, 'campaign-corrupt', 'C01', 'store', 'baseline-evidence', 'corrupt-pend');
      mkdirSync(corruptDir, { recursive: true });
      writeFileSync(join(corruptDir, 'record.pending'), JSON.stringify({ operationRef: c.ref }), 'utf8');

      const res = await runResume(baseDir, validRef);
      assert.equal(res.exitCode, 2, `${c.name}: malformed pending ref must block`);
      assert.equal(res.records[0]?.reasonCode, 'continuation-blocked');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
    }
  }
});

test('CR249-REF: wellformed unrelated baseline operationRef remains absent and valid matching root resumes', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-ref-unrel-'));
  const seedDir = mkdtempSync(join(tmpdir(), 't054-ref-seed-'));
  try {
    const validRef = await seedSettledBaselineStore(seedDir);
    mkdirSync(join(baseDir, 'campaign-valid', 'C01'), { recursive: true });
    cpSync(seedDir, join(baseDir, 'campaign-valid', 'C01', 'store'), { recursive: true });

    const unrelatedDir = join(baseDir, 'campaign-unrelated', 'C01', 'store', 'baseline-evidence', 'unrelated-entry');
    mkdirSync(unrelatedDir, { recursive: true });
    writeFileSync(join(unrelatedDir, 'record.json'), JSON.stringify({ operationRef: 'uc04-baseline:' + 'e'.repeat(64) }), 'utf8');

    let fetches = 0;
    let spawns = 0;
    const res = await runResume(
      baseDir,
      validRef,
      () => fetches++,
      () => spawns++,
    );
    assert.equal(fetches, 0);
    assert.equal(spawns, 0);
    assert.equal(res.exitCode, 0, 'wellformed unrelated ref must permit matching resume');
    assert.equal(res.records[0]?.outcome, 'pass');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// CR249-SCAN (complete-scan): all baseline entries inspected before present
// ----------------------------------------------------------------------------
test('CR249-SCAN: matching record.json does not mask corrupt sibling record.pending in same entry', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-scan-sib-'));
  const seedDir = mkdtempSync(join(tmpdir(), 't054-scan-seed-'));
  try {
    const validRef = await seedSettledBaselineStore(seedDir);
    const caseStore = join(baseDir, 'campaign-scan', 'C01', 'store');
    mkdirSync(join(baseDir, 'campaign-scan', 'C01'), { recursive: true });
    cpSync(seedDir, caseStore, { recursive: true });

    const [keyHash] = readdirSync(join(caseStore, 'baseline-evidence'));
    assert.ok(keyHash);
    writeFileSync(join(caseStore, 'baseline-evidence', keyHash, 'record.pending'), '{ corrupt json content: invalid', 'utf8');

    const res = await runResume(baseDir, validRef);
    assert.equal(res.exitCode, 2, 'matching record.json must not mask corrupt sibling record.pending');
    assert.equal(res.records[0]?.reasonCode, 'continuation-blocked');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});

test('CR249-SCAN: matching entry does not mask later corrupt sibling entry across ordering permutations', async () => {
  const permutations = [
    { name: 'matching first (01-matching, 02-corrupt)', matchKey: '01-matching', corruptKey: '02-corrupt' },
    { name: 'corrupt first (01-corrupt, 02-matching)', matchKey: '02-matching', corruptKey: '01-corrupt' },
  ];
  for (const perm of permutations) {
    const baseDir = mkdtempSync(join(tmpdir(), 't054-scan-perm-'));
    const seedDir = mkdtempSync(join(tmpdir(), 't054-scan-seed-'));
    try {
      const validRef = await seedSettledBaselineStore(seedDir);
      const caseStore = join(baseDir, 'campaign-perm', 'C01', 'store');
      mkdirSync(join(baseDir, 'campaign-perm', 'C01'), { recursive: true });
      cpSync(seedDir, caseStore, { recursive: true });

      const baselineDir = join(caseStore, 'baseline-evidence');
      const [seedKey] = readdirSync(baselineDir);
      assert.ok(seedKey);
      renameSync(join(baselineDir, seedKey), join(baselineDir, perm.matchKey));

      const corruptDir = join(baselineDir, perm.corruptKey);
      mkdirSync(corruptDir, { recursive: true });
      writeFileSync(join(corruptDir, 'record.json'), JSON.stringify({ operationRef: 'uc04-baseline:invalid-short' }), 'utf8');

      const res = await runResume(baseDir, validRef);
      assert.equal(res.exitCode, 2, `${perm.name}: must detect corrupt sibling regardless of ordering`);
      assert.equal(res.records[0]?.reasonCode, 'continuation-blocked');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
    }
  }
});

test('CR249-SCAN: matching entry does not mask linked sibling entry', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-scan-link-'));
  const foreignDir = mkdtempSync(join(tmpdir(), 't054-scan-foreign-'));
  try {
    const baselineDir = join(baseDir, 'campaign-link', 'C01', 'store', 'baseline-evidence');
    mkdirSync(join(baselineDir, '01-matching'), { recursive: true });
    const validRef = 'uc04-baseline:' + 'd'.repeat(64);
    writeFileSync(join(baselineDir, '01-matching', 'record.json'), JSON.stringify({ operationRef: validRef }), 'utf8');

    const linkedTarget = join(foreignDir, 'external-record');
    mkdirSync(linkedTarget, { recursive: true });
    writeFileSync(join(linkedTarget, 'record.json'), JSON.stringify({ operationRef: validRef }), 'utf8');
    symlinkSync(linkedTarget, join(baselineDir, '02-linked-sibling'), 'junction');

    const res = await runResume(baseDir, validRef);
    assert.equal(res.exitCode, 2, 'matching entry must not mask linked sibling entry');
    assert.equal(res.records[0]?.reasonCode, 'continuation-blocked');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(foreignDir, { recursive: true, force: true });
  }
});

test('CR249-SCAN: valid store with multiple entries resumes through unique original owner', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-scan-multi-'));
  const seedDir = mkdtempSync(join(tmpdir(), 't054-scan-seed-'));
  try {
    const validRef = await seedSettledBaselineStore(seedDir);
    const caseStore = join(baseDir, 'campaign-multi', 'C01', 'store');
    mkdirSync(join(baseDir, 'campaign-multi', 'C01'), { recursive: true });
    cpSync(seedDir, caseStore, { recursive: true });

    const baselineDir = join(caseStore, 'baseline-evidence');
    mkdirSync(join(baselineDir, 'extra-1'), { recursive: true });
    mkdirSync(join(baselineDir, 'extra-2'), { recursive: true });
    writeFileSync(join(baselineDir, 'extra-1', 'record.json'), JSON.stringify({ operationRef: 'uc04-baseline:' + '1'.repeat(64) }), 'utf8');
    writeFileSync(join(baselineDir, 'extra-2', 'record.json'), JSON.stringify({ operationRef: 'uc04-baseline:' + '2'.repeat(64) }), 'utf8');
    writeFileSync(join(baselineDir, 'extra-2', 'record.pending'), JSON.stringify({ operationRef: 'uc04-baseline:' + '3'.repeat(64) }), 'utf8');

    let fetches = 0;
    let spawns = 0;
    const res = await runResume(
      baseDir,
      validRef,
      () => fetches++,
      () => spawns++,
    );
    assert.equal(fetches, 0);
    assert.equal(spawns, 0);
    assert.equal(res.exitCode, 0, 'valid store with multiple wellformed entries resumes successfully');
    assert.equal(res.records[0]?.outcome, 'pass');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// CR249-IO (probe-refusal): lstat permission/IO failures translate to blocked
// ----------------------------------------------------------------------------
test('CR249-IO: unexpected lstat error at legacy store translates to blocked recovery decision without throwing', async t => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-io-leg-'));
  const seedDir = mkdtempSync(join(tmpdir(), 't054-io-seed-'));
  const originalLstat = fs.lstatSync;
  try {
    const validRef = await seedSettledBaselineStore(seedDir);
    const legacyStore = join(baseDir, 'store');
    mkdirSync(legacyStore, { recursive: true });

    t.mock.method(fs, 'lstatSync', ((path: fs.PathLike, options?: unknown) => {
      if (String(path) === legacyStore) throw Object.assign(new Error('EACCES: permission denied, lstat'), { code: 'EACCES' });
      return originalLstat(path, options as never);
    }) as typeof fs.lstatSync);

    let fetches = 0;
    let spawns = 0;
    const res = await runResume(
      baseDir,
      validRef,
      () => fetches++,
      () => spawns++,
    );
    assert.equal(fetches, 0, 'zero provider fetches');
    assert.equal(spawns, 0, 'zero docker spawns');
    assert.equal(res.exitCode, 2, 'unexpected legacy store lstat error must block rather than throw');
    assert.equal(res.records[0]?.reasonCode, 'continuation-blocked');
  } finally {
    t.mock.restoreAll();
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});

test('CR249-IO: unexpected lstat error at case storePath translates to blocked recovery decision without throwing', async t => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-io-case-'));
  const seedDir = mkdtempSync(join(tmpdir(), 't054-io-seed-'));
  const originalLstat = fs.lstatSync;
  try {
    const validRef = await seedSettledBaselineStore(seedDir);
    const caseStore = join(baseDir, 'campaign-target', 'C01', 'store');
    mkdirSync(join(baseDir, 'campaign-target', 'C01'), { recursive: true });

    t.mock.method(fs, 'lstatSync', ((path: fs.PathLike, options?: unknown) => {
      if (String(path) === caseStore) throw Object.assign(new Error('EIO: i/o error, lstat'), { code: 'EIO' });
      return originalLstat(path, options as never);
    }) as typeof fs.lstatSync);

    let fetches = 0;
    let spawns = 0;
    const res = await runResume(
      baseDir,
      validRef,
      () => fetches++,
      () => spawns++,
    );
    assert.equal(fetches, 0, 'zero provider fetches');
    assert.equal(spawns, 0, 'zero docker spawns');
    assert.equal(res.exitCode, 2, 'unexpected case store lstat error must block rather than throw');
    assert.equal(res.records[0]?.reasonCode, 'continuation-blocked');
  } finally {
    t.mock.restoreAll();
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});

test('CR249-IO: missing legacy store and missing case store remain absent without error', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-io-abs-'));
  try {
    mkdirSync(baseDir, { recursive: true });
    const res = await runResume(baseDir, 'uc04-baseline:' + '9'.repeat(64));
    assert.equal(res.exitCode, 2);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
