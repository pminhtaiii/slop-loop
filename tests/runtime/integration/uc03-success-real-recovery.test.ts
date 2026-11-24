/**
 * Regression and boundary tests for real-tier campaign recovery routing (Feature 007 T054, MERGER-001).
 *
 * Verifies that:
 * 1. Default runCampaign resume discovers committed operations in isolated campaign/case stores.
 * 2. Legacy base-root operations remain discoverable.
 * 3. Duplicate same-named operations across multiple roots fail closed (continuation-blocked).
 * 4. Corrupt or unreadable matching records fail closed (continuation-blocked).
 * 5. Linked or escaping storage roots fail closed (continuation-blocked).
 * 6. Baseline evidence operation refs in isolated roots are routed to baseline owner.
 * 7. Unknown or unsupported operation refs refuse continuation.
 * 8. Custom assemble seams and zero-effect constraints are preserved.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeCanonicalSha256, type RepositoryAdmissionContextV02, type RunCommandAction, type TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { journalOperationRef } from '../../../src/persistence/adapters/state-port-v02-operation-lookup.ts';
import { createBaselineEvidenceStore } from '../../../src/persistence/adapters/baseline-evidence-store.ts';
import type { BaselineEvidenceCandidate } from '../../../src/uc03/investigation-types.ts';
import {
  createTestAction,
  createTestAdmissionTaskStateV02,
  createTestExecutorIdentityV02,
  createTestRepositoryCommandAdmissionContextV02,
  createTestRepositoryOutcomeReceiptV02,
} from '../support/uc03/state-fixtures.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';
import { runCampaign, type CampaignOptions } from './uc03-success-real-run.ts';
import type { RealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';

const SHARED_ACTION: RunCommandAction = createTestAction({
  actionId: 'check-reproduction',
  argv: ['-q', 'tests/test_calculator.py', '-k', 'test_divide_zero'],
  purpose: 'Reproduce calculator bug across tasks',
});

function seedTask(ctx: RepositoryAdmissionContextV02): TaskState {
  const task = createTestAdmissionTaskStateV02(ctx);
  return {
    ...task,
    budgetLedgers: [
      ...(task.budgetLedgers ?? []),
      {
        scope: 'task',
        kind: 'timeoutMs',
        limit: 60_000,
        consumed: 0,
        reservations: [],
        unit: 'count',
        configurationId: 'config-v1',
        version: 1,
      },
    ],
  };
}

async function seedSettledJournalStore(targetDir: string, taskId = 'owner-task-alpha'): Promise<string> {
  const store = new DurableStore(targetDir);
  await store.init();
  const ctx = createTestRepositoryCommandAdmissionContextV02({
    taskId,
    runId: 'run-001',
    workspaceId: 'workspace-001',
    action: SHARED_ACTION,
  });
  const port = new DurableStatePortV02({
    store,
    taskId,
    initialControl: {
      controlVersion: ctx.expectedControlVersion,
      epoch: ctx.expectedEpoch,
      activeAuthorityRef: ctx.policyAuthorityRef,
    },
  });
  await port.transition(seedTask(ctx), 0);
  const claim = await port.claim(ctx);
  const executor = createTestExecutorIdentityV02({ payloadDigest: ctx.actionDigest });
  const attempt = await port.beginAttempt(claim.claimId, executor);
  const outcome = createTestRepositoryOutcomeReceiptV02(claim, attempt, ctx);
  await port.recordOutcome(outcome);
  return journalOperationRef(claim.claimId);
}

function baseCampaignOptions(stateRoot: string, evidenceDir: string): Omit<CampaignOptions, 'mode'> {
  const fixture = createScanFixture('recovery-test-', 'controlled-recovery-key');
  return {
    env: fixture.envOf(),
    repositoryRoot: process.cwd(),
    candidateSha: '87ea41566aa2effdb98d48daa4da6c46b6ec37d4',
    stateRoot,
    evidenceDir,
  };
}

test('MERGER-001 regression: resume discovers committed journal operation in isolated campaign/case root', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-rec-iso-'));
  const seedDir = mkdtempSync(join(tmpdir(), 't054-rec-seed-'));
  try {
    const ref = await seedSettledJournalStore(seedDir);
    const caseStore = join(baseDir, 'campaign-prior', 'C01', 'store');
    mkdirSync(join(baseDir, 'campaign-prior', 'C01'), { recursive: true });
    cpSync(seedDir, caseStore, { recursive: true });

    let fetches = 0;
    let spawns = 0;
    const baseOpts = baseCampaignOptions(baseDir, join(baseDir, 'evidence'));
    const result = await runCampaign({
      ...baseOpts,
      mode: 'resume',
      resumeRef: ref,
      fetch: async () => {
        fetches += 1;
        throw new Error('forbidden fetch');
      },
      spawn: async () => {
        spawns += 1;
        throw new Error('forbidden spawn');
      },
    });

    assert.equal(fetches, 0, 'must make zero provider fetches');
    assert.equal(spawns, 0, 'must make zero docker spawns');
    assert.equal(result.exitCode, 0, 'resume must discover committed case operation and exit 0');
    assert.deepEqual(
      result.records.map(r => [r.stage, r.outcome, r.facts?.['decision']]),
      [['recovery', 'pass', 'resume']],
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});

test('legacy compatibility: resume discovers committed operation in legacy base root', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-rec-leg-'));
  const seedDir = mkdtempSync(join(tmpdir(), 't054-rec-seed-'));
  try {
    const ref = await seedSettledJournalStore(seedDir);
    const legacyStore = join(baseDir, 'store');
    mkdirSync(baseDir, { recursive: true });
    cpSync(seedDir, legacyStore, { recursive: true });

    let fetches = 0;
    let spawns = 0;
    const baseOpts = baseCampaignOptions(baseDir, join(baseDir, 'evidence'));
    const result = await runCampaign({
      ...baseOpts,
      mode: 'resume',
      resumeRef: ref,
      fetch: async () => {
        fetches += 1;
        throw new Error('forbidden fetch');
      },
      spawn: async () => {
        spawns += 1;
        throw new Error('forbidden spawn');
      },
    });

    assert.equal(fetches, 0);
    assert.equal(spawns, 0);
    assert.equal(result.exitCode, 0, 'legacy base-root resume must succeed');
    assert.equal(result.records[0]?.outcome, 'pass');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});

test('ambiguity refusal: duplicate same-named operation across multiple roots blocks continuation', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-rec-dup-'));
  const seedDir = mkdtempSync(join(tmpdir(), 't054-rec-seed-'));
  try {
    const ref = await seedSettledJournalStore(seedDir);
    // Seed in two distinct campaign roots
    const root1 = join(baseDir, 'campaign-1', 'C01', 'store');
    const root2 = join(baseDir, 'campaign-2', 'C01', 'store');
    mkdirSync(join(baseDir, 'campaign-1', 'C01'), { recursive: true });
    mkdirSync(join(baseDir, 'campaign-2', 'C01'), { recursive: true });
    cpSync(seedDir, root1, { recursive: true });
    cpSync(seedDir, root2, { recursive: true });

    const baseOpts = baseCampaignOptions(baseDir, join(baseDir, 'evidence'));
    const result = await runCampaign({
      ...baseOpts,
      mode: 'resume',
      resumeRef: ref,
      fetch: async () => {
        throw new Error('forbidden fetch');
      },
      spawn: async () => {
        throw new Error('forbidden spawn');
      },
    });

    assert.equal(result.exitCode, 2, 'duplicate operation across roots must block');
    assert.equal(result.records[0]?.outcome, 'fail');
    assert.equal(result.records[0]?.reasonCode, 'continuation-blocked');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});

test('fail closed: corrupt or unreadable candidate matching record blocks continuation', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-rec-corrupt-'));
  try {
    const caseStore = join(baseDir, 'campaign-1', 'C01', 'store');
    const claimPath = join(caseStore, 'claims', 'owner-task-alpha', 'claim-check-reproduction.json');
    mkdirSync(join(caseStore, 'claims', 'owner-task-alpha'), { recursive: true });
    writeFileSync(claimPath, '{"broken": json invalid', 'utf8');

    const baseOpts = baseCampaignOptions(baseDir, join(baseDir, 'evidence'));
    const result = await runCampaign({
      ...baseOpts,
      mode: 'resume',
      resumeRef: 'uc04-journal:claim-check-reproduction',
      fetch: async () => {
        throw new Error('forbidden fetch');
      },
      spawn: async () => {
        throw new Error('forbidden spawn');
      },
    });

    assert.equal(result.exitCode, 2, 'corrupt candidate matching record must fail closed');
    assert.equal(result.records[0]?.reasonCode, 'continuation-blocked');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('containment: escaping or symlinked storage root blocks continuation', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-rec-escape-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 't054-rec-outside-'));
  try {
    const ref = await seedSettledJournalStore(outsideDir);
    // Create symlink pointing outside baseDir
    const symlinkTarget = join(baseDir, 'campaign-symlink');
    try {
      symlinkSync(outsideDir, symlinkTarget, 'dir');
    } catch {
      // On platforms where symlink requires elevated privilege, create junction or test relative escape
      return;
    }

    const baseOpts = baseCampaignOptions(baseDir, join(baseDir, 'evidence'));
    const result = await runCampaign({
      ...baseOpts,
      mode: 'resume',
      resumeRef: ref,
      fetch: async () => {
        throw new Error('forbidden fetch');
      },
      spawn: async () => {
        throw new Error('forbidden spawn');
      },
    });

    assert.equal(result.exitCode, 2, 'escaping or symlinked storage root must block');
    assert.equal(result.records[0]?.reasonCode, 'continuation-blocked');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('containment: linked claims below a regular store cannot supply a resume record', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-rec-nested-link-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 't054-rec-foreign-'));
  try {
    const ref = await seedSettledJournalStore(outsideDir);
    const storeDir = join(baseDir, 'campaign-linked', 'C01', 'store');
    mkdirSync(storeDir, { recursive: true });
    symlinkSync(join(outsideDir, 'claims'), join(storeDir, 'claims'), 'junction');
    const result = await runCampaign({ ...baseCampaignOptions(baseDir, join(baseDir, 'evidence')), mode: 'resume', resumeRef: ref });
    assert.equal(result.exitCode, 2, 'linked claim directories must not authorize resume');
    assert.equal(result.records[0]?.reasonCode, 'continuation-blocked');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('baseline operation routing: routes committed baseline evidence to baseline owner', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-rec-base-'));
  try {
    const caseStoreDir = join(baseDir, 'campaign-baseline', 'C01', 'store');
    const store = new DurableStore(caseStoreDir);
    await store.init();
    const baselineStore = createBaselineEvidenceStore({ store });

    const candidate: BaselineEvidenceCandidate = {
      taskId: 'task-test-001',
      workspaceId: 'workspace-test-001',
      repositoryId: 'repo-test-001',
      acceptanceCriteria: ['criteria-1'],
      criteriaDigest: 'sha256:' + 'b'.repeat(64),
      requiredChecks: [
        { checkId: 'check-1', executable: 'pytest', argv: ['tests/test_calculator.py'], purpose: 'reproduction', workingDirectory: '/workspace', timeoutMs: 1000, maxOutputBytes: 1024 },
      ],
      expectedPassingCheckIds: ['check-1'],
      reproductionCheckId: 'check-1',
      expectedTestFiles: ['tests/test_calculator.py'],
      repositorySnapshotDigest: 'sha256:' + 'a'.repeat(64),
      checkSetDigest: 'sha256:' + 'c'.repeat(64),
      reproductionFailureSignature: 'AssertionError: failure',
      checkResults: [{ checkId: 'check-1', outcome: 'fail' }],
      testProtectionDigest: 'sha256:' + 'd'.repeat(64),
    };
    const persistResult = await baselineStore.persist({
      content: candidate,
      contentDigest: computeCanonicalSha256(candidate),
    });
    assert.equal(persistResult.outcome, 'durable');

    // Retrieve the generated operationRef from record.json
    const entries = await import('node:fs/promises').then(fs => fs.readdir(join(caseStoreDir, 'baseline-evidence')));
    assert.ok(entries.length > 0);
    const keyHash = entries[0];
    assert.ok(keyHash);
    const recordJson = JSON.parse(readFileSync(join(caseStoreDir, 'baseline-evidence', keyHash, 'record.json'), 'utf8')) as { operationRef: string };
    const ref = recordJson.operationRef;
    assert.ok(ref.startsWith('uc04-baseline:'));

    const baseOpts = baseCampaignOptions(baseDir, join(baseDir, 'evidence'));
    const result = await runCampaign({
      ...baseOpts,
      mode: 'resume',
      resumeRef: ref,
      fetch: async () => {
        throw new Error('forbidden fetch');
      },
      spawn: async () => {
        throw new Error('forbidden spawn');
      },
    });

    assert.equal(result.exitCode, 0, 'committed baseline operation in isolated root must resume');
    assert.equal(result.records[0]?.outcome, 'pass');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('refusal: unknown or unsupported ref blocks with zero effects', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-rec-unknown-'));
  try {
    const baseOpts = baseCampaignOptions(baseDir, join(baseDir, 'evidence'));
    const result = await runCampaign({
      ...baseOpts,
      mode: 'resume',
      resumeRef: 'unknown-prefix:some-ref',
      fetch: async () => {
        throw new Error('forbidden fetch');
      },
      spawn: async () => {
        throw new Error('forbidden spawn');
      },
    });

    assert.equal(result.exitCode, 2, 'unsupported ref must block');
    assert.equal(result.records[0]?.reasonCode, 'continuation-blocked');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('seam preservation: custom assemble double without filesystem state remains supported', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-rec-custom-'));
  try {
    const baseOpts = baseCampaignOptions(baseDir, join(baseDir, 'evidence'));
    const customAssemble = () =>
      ({
        status: 'assembly-ready' as const,
        metadata: {
          profileDigest: 'sha256:' + '1'.repeat(64),
          endpointDigest: 'sha256:' + '2'.repeat(64),
          endpointScheme: 'https' as const,
          insecureHttpAcknowledged: false,
          model: 'cmc/deepseek/deepseek-v4.1-flash',
          imageId: 'sha256:' + '3'.repeat(64),
        },
        owners: { recoveryGate: { decide: async () => 'resume' as const } },
      }) as unknown as RealTierAssembly;

    const result = await runCampaign({
      ...baseOpts,
      mode: 'resume',
      resumeRef: 'uc04-journal:claim-recorded',
      assemble: customAssemble,
      fetch: async () => {
        throw new Error('forbidden fetch');
      },
      spawn: async () => {
        throw new Error('forbidden spawn');
      },
    });

    assert.equal(result.exitCode, 0, 'custom assemble double must be preserved');
    assert.equal(result.records[0]?.outcome, 'pass');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

async function seedSettledBaselineStore(targetDir: string): Promise<string> {
  const store = new DurableStore(targetDir);
  await store.init();
  const baselineStore = createBaselineEvidenceStore({ store });
  const candidate: BaselineEvidenceCandidate = {
    taskId: 'task-test-001',
    workspaceId: 'workspace-test-001',
    repositoryId: 'repo-test-001',
    acceptanceCriteria: ['criteria-1'],
    criteriaDigest: 'sha256:' + 'b'.repeat(64),
    requiredChecks: [{ checkId: 'check-1', executable: 'pytest', argv: ['tests/test_calculator.py'], purpose: 'reproduction', workingDirectory: '/workspace', timeoutMs: 1000, maxOutputBytes: 1024 }],
    expectedPassingCheckIds: ['check-1'],
    reproductionCheckId: 'check-1',
    expectedTestFiles: ['tests/test_calculator.py'],
    repositorySnapshotDigest: 'sha256:' + 'a'.repeat(64),
    checkSetDigest: 'sha256:' + 'c'.repeat(64),
    reproductionFailureSignature: 'AssertionError: failure',
    checkResults: [{ checkId: 'check-1', outcome: 'fail' }],
    testProtectionDigest: 'sha256:' + 'd'.repeat(64),
  };
  await baselineStore.persist({
    content: candidate,
    contentDigest: computeCanonicalSha256(candidate),
  });
  const baselineDir = join(targetDir, 'baseline-evidence');
  const [keyHash] = readdirSync(baselineDir);
  assert.ok(keyHash);
  const recordJson = JSON.parse(readFileSync(join(baselineDir, keyHash, 'record.json'), 'utf8')) as { operationRef: string };
  return recordJson.operationRef;
}

test('CR247-001 regression: malformed baseline records fail closed and do not skip to valid root', async () => {
  const malformedCases = [
    { name: 'record.json is array', file: 'record.json', content: '[]' },
    { name: 'record.json is empty object', file: 'record.json', content: '{}' },
    { name: 'record.json has non-string operationRef', file: 'record.json', content: JSON.stringify({ operationRef: 12345 }) },
    { name: 'record.pending is array', file: 'record.pending', content: '[]' },
    { name: 'record.pending is empty object', file: 'record.pending', content: '{}' },
    { name: 'record.pending has non-string operationRef', file: 'record.pending', content: JSON.stringify({ operationRef: true }) },
  ];

  for (const c of malformedCases) {
    const baseDir = mkdtempSync(join(tmpdir(), 't054-rec-cr001-'));
    const seedDir = mkdtempSync(join(tmpdir(), 't054-rec-cr001-seed-'));
    try {
      const ref = await seedSettledBaselineStore(seedDir);
      const validStore = join(baseDir, 'campaign-valid', 'C01', 'store');
      mkdirSync(join(baseDir, 'campaign-valid', 'C01'), { recursive: true });
      cpSync(seedDir, validStore, { recursive: true });

      const corruptDir = join(baseDir, 'campaign-corrupt', 'C01', 'store', 'baseline-evidence', 'corrupthash123');
      mkdirSync(corruptDir, { recursive: true });
      writeFileSync(join(corruptDir, c.file), c.content, 'utf8');

      let fetches = 0;
      let spawns = 0;
      const baseOpts = baseCampaignOptions(baseDir, join(baseDir, 'evidence'));
      const result = await runCampaign({
        ...baseOpts,
        mode: 'resume',
        resumeRef: ref,
        fetch: async () => {
          fetches += 1;
          throw new Error('forbidden fetch');
        },
        spawn: async () => {
          spawns += 1;
          throw new Error('forbidden spawn');
        },
      });

      assert.equal(fetches, 0, `${c.name}: must make zero provider fetches`);
      assert.equal(spawns, 0, `${c.name}: must make zero docker spawns`);
      assert.equal(result.exitCode, 2, `${c.name}: malformed baseline record must block`);
      assert.equal(result.records[0]?.outcome, 'fail');
      assert.equal(result.records[0]?.reasonCode, 'continuation-blocked');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
    }
  }
});

test('CR247-001 positive: unrelated valid baseline operation remains absent and matching owner resumes', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 't054-rec-cr001-pos-'));
  const seedDir = mkdtempSync(join(tmpdir(), 't054-rec-cr001-pos-seed-'));
  try {
    const ref = await seedSettledBaselineStore(seedDir);
    const validStore = join(baseDir, 'campaign-valid', 'C01', 'store');
    mkdirSync(join(baseDir, 'campaign-valid', 'C01'), { recursive: true });
    cpSync(seedDir, validStore, { recursive: true });

    const otherDir = join(baseDir, 'campaign-other', 'C01', 'store', 'baseline-evidence', 'otherhash456');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'record.json'), JSON.stringify({ operationRef: 'uc04-baseline:' + 'f'.repeat(64) }), 'utf8');

    let fetches = 0;
    let spawns = 0;
    const baseOpts = baseCampaignOptions(baseDir, join(baseDir, 'evidence'));
    const result = await runCampaign({
      ...baseOpts,
      mode: 'resume',
      resumeRef: ref,
      fetch: async () => {
        fetches += 1;
        throw new Error('forbidden fetch');
      },
      spawn: async () => {
        spawns += 1;
        throw new Error('forbidden spawn');
      },
    });

    assert.equal(fetches, 0);
    assert.equal(spawns, 0);
    assert.equal(result.exitCode, 0, 'unrelated valid baseline operation must not block matching resume');
    assert.equal(result.records[0]?.outcome, 'pass');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
});

for (const target of ['legacy', 'case'] as const) {
  test(`CR247-002 regression: file symlink at ${target} store blocks continuation before isDirectory`, async t => {
    const baseDir = mkdtempSync(join(tmpdir(), `t054-rec-cr002-${target}-`));
    const seedDir = mkdtempSync(join(tmpdir(), 't054-rec-cr002-seed-'));
    const targetFile = join(baseDir, 'dummy-target.txt');
    writeFileSync(targetFile, 'not-a-directory', 'utf8');

    let linkPath: string;
    if (target === 'legacy') {
      linkPath = join(baseDir, 'store');
    } else {
      const linkedCaseDir = join(baseDir, 'campaign-linked', 'C01');
      mkdirSync(linkedCaseDir, { recursive: true });
      linkPath = join(linkedCaseDir, 'store');
    }

    try {
      symlinkSync(targetFile, linkPath, 'file');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows file symlink requires developer mode (EPERM)');
        rmSync(baseDir, { recursive: true, force: true });
        rmSync(seedDir, { recursive: true, force: true });
        return;
      }
      throw err;
    }

    try {
      const ref = await seedSettledJournalStore(seedDir);
      const validStore = join(baseDir, 'campaign-valid', 'C01', 'store');
      mkdirSync(join(baseDir, 'campaign-valid', 'C01'), { recursive: true });
      cpSync(seedDir, validStore, { recursive: true });

      let fetches = 0;
      let spawns = 0;
      const baseOpts = baseCampaignOptions(baseDir, join(baseDir, 'evidence'));
      const result = await runCampaign({
        ...baseOpts,
        mode: 'resume',
        resumeRef: ref,
        fetch: async () => {
          fetches += 1;
          throw new Error('forbidden fetch');
        },
        spawn: async () => {
          spawns += 1;
          throw new Error('forbidden spawn');
        },
      });

      assert.equal(fetches, 0);
      assert.equal(spawns, 0);
      assert.equal(result.exitCode, 2, `${target} store file symlink must block continuation`);
      assert.equal(result.records[0]?.reasonCode, 'continuation-blocked');
      assert.equal(readFileSync(targetFile, 'utf8'), 'not-a-directory', 'state bytes preserved');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(seedDir, { recursive: true, force: true });
    }
  });
}
