import { PatchOutcomePendingError } from '../../../src/foundation/repository-outcome.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import type { BugTask } from '../../../src/contracts/foundation/uc03.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import { resolveRealTierAssembly } from '../../../src/runtime/real-tier-assembly.ts';
import { bindRealTierTask } from '../../../src/runtime/real-tier-task-binding.ts';
import { UC03_PRODUCTION_COMPONENTS_V02 } from '../../../src/uc03/graph-types-v02.ts';
import { sha256Text } from '../../../src/uc01/contracts.ts';
import { createScanFixture } from '../unit/real-tier-scan-fixtures.ts';
import { createVolumeSpawn } from '../support/docker-volume-spawn.ts';
import { mirrorRealTierWorkspace } from '../../../src/runtime/real-tier-workspace.ts';
import { ControlledRepositoryTools } from '../../../src/foundation/repository-tools.ts';
import { createRefusingPatchRecoveryHandoff } from '../../../src/foundation/durable-recovery-handoffs.ts';
import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
import { createTestAdmissionTaskStateV02, createTestRepositoryAdmissionContextV02 } from '../support/uc03/state-fixtures.ts';

const fixture = createScanFixture('mirror-', 'mirror-profile-fixture');

async function setup(fault?: 'timeout' | 'truncated' | 'measurement' | 'allocation', binary = false) {
  const root = mkdtempSync(join(tmpdir(), 'mirror-case-'));
  const repositoryRoot = join(root, 'repository');
  mkdirSync(join(repositoryRoot, 'src'), { recursive: true });
  writeFileSync(join(repositoryRoot, 'src/calc.py'), 'value = 1\n');
  if (binary) writeFileSync(join(repositoryRoot, 'asset.bin'), Buffer.from([0, 255, 128, 10]));
  const filesystem = new WorkspaceFilesystemPort({ root: repositoryRoot });
  const revision = await filesystem.getCurrentRevisionDigest();
  const task: BugTask = {
    taskId: 'task-mirror',
    repositoryId: 'repo-mirror',
    initialRevisionDigest: revision,
    goal: 'Correct the value',
    observedBehavior: 'one',
    expectedBehavior: 'two',
    reproduction: 'pytest',
    acceptanceCriteria: ['value is two'],
    constraints: [],
    requiredChecks: [{ checkId: 'check-value', executable: 'pytest', argv: ['tests/test_calc.py'], purpose: 'reproduction', workingDirectory: '.', timeoutMs: 1000, maxOutputBytes: 4096 }],
    limits: { timeoutMs: 1000, maxOutputBytes: 4096, maxCpuCores: 1, maxMemoryBytes: 1048576, maxPids: 16 },
    budgetLimits: { maxReplanCount: 3, maxTokens: 1000, maxCostUsd: 1, maxRepairAttempts: 2, maxReviewIterations: 2 },
    configId: 'config-mirror',
    configVersion: '1.0.0',
  };
  const document = JSON.stringify({ task, repositoryRoot: 'repository' });
  const fixturePath = join(root, 'case.json');
  writeFileSync(fixturePath, document);
  const catalogPath = join(root, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ catalog: [{ caseId: 'C01', fixturePath, fixtureDigest: sha256Text(document), initialRepositoryDigest: revision.slice(7) }] }));
  const docker = createVolumeSpawn();
  const assembly = resolveRealTierAssembly({
    env: fixture.envOf({ catalog: { path: catalogPath } }),
    stateRoot: join(root, 'state'),
    revision: 'a'.repeat(40),
    spawn: async (command, args, options) => {
      if (fault === 'allocation' && args[0] === 'volume' && args[1] === 'create' && docker.volumes.size === 1) return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
      const result = await docker.spawn(command, args, options);
      if (options.stdin === undefined) return result;
      if (fault === 'timeout') return { ...result, exitCode: null, timedOut: true };
      if (fault === 'truncated') return { ...result, truncated: true };
      if (fault === 'measurement') return { ...result, stdout: JSON.stringify({ entries: [] }) };
      return result;
    },
    fetch: async () => {
      throw new Error('unexpected request');
    },
  });
  assert.equal(assembly.status, 'assembly-ready');
  if (assembly.status !== 'assembly-ready') throw new Error('assembly unavailable');
  const options = {
    caseId: 'C01',
    pins: { contractVersion: 'uc03-host-composition/2', revisions: Object.fromEntries(UC03_PRODUCTION_COMPONENTS_V02.map(component => [component, assembly.revision])) },
    identity: { profileId: 'mirror-profile', profileDigest: assembly.metadata.profileDigest, configDigest: revision, pricingDigest: revision },
    retainedRoot: join(root, 'retained'),
  };
  return { root, repositoryRoot, filesystem, task, revision, assembly, docker, options };
}

test('C01 binding fills the canonical repository, admits a measured view and resumes without a second fill', async () => {
  const h = await setup();
  const bound = await bindRealTierTask(h.assembly, h.options);
  assert.equal(bound.status, 'task-bound', JSON.stringify(bound));
  if (bound.status !== 'task-bound') return;
  const workspace = h.assembly.workspaceManager.getWorkspace(bound.ids.workspaceId);
  assert.ok(workspace);
  assert.deepEqual([...(h.docker.volumes.get(workspace.repoVolumeId) ?? [])], [['src/calc.py', Buffer.from('value = 1\n')]]);
  assert.equal(h.assembly.workspaceManager.getCanonicalRevision(bound.ids.workspaceId), h.revision);
  const issued = await h.assembly.workspaceManager.admitMeasuredCommandView({
    workspaceId: bound.ids.workspaceId,
    expectedRevisionDigest: h.revision,
    ownerView: {
      canonicalRevision: h.revision,
      exclusionsPolicyVersion: '0.1.0',
      scratchIdentity: workspace.scratchVolumeId,
      admittedFiles: [{ path: 'src/calc.py', digest: `sha256:${sha256Text('value = 1\n')}` }],
      mountedReadOnly: true,
      isolationProfileRef: h.assembly.profile.image.label,
    },
    trustedIsolationProfileRef: h.assembly.profile.image.label,
  });
  assert.ok(issued.measured);
  const fills = h.docker.calls.filter(call => call.options.stdin !== undefined).length;
  const allocations = h.docker.calls.filter(call => call.args[0] === 'volume' && call.args[1] === 'create').length;
  assert.equal((await bindRealTierTask(h.assembly, h.options)).status, 'task-bound');
  assert.equal(h.docker.calls.filter(call => call.options.stdin !== undefined).length, fills);
  assert.equal(h.docker.calls.filter(call => call.args[0] === 'volume' && call.args[1] === 'create').length, allocations);
  const helper = h.docker.calls.find(call => call.options.stdin !== undefined);
  assert.ok(helper);
  for (const flag of [
    '--network=none',
    '--read-only',
    `--user=${h.assembly.profile.image.user}`,
    `--memory=${h.assembly.profile.limits.memoryBytes}`,
    `--cpus=${h.assembly.profile.limits.cpus}`,
    `--pids-limit=${h.assembly.profile.limits.processes}`,
    h.assembly.profile.image.imageId,
  ])
    assert.ok(helper.args.includes(flag));
  assert.equal(helper.options.timeoutMs, h.assembly.profile.limits.commandTimeoutMs);
  assert.equal(helper.options.maxOutputBytes, h.assembly.profile.limits.outputBytes);
});

test('drift refuses binding and releases both volumes', async () => {
  const h = await setup();
  writeFileSync(join(h.repositoryRoot, 'src/calc.py'), 'value = 7\n');
  const result = await bindRealTierTask(h.assembly, h.options);
  assert.deepEqual(result, { status: 'unavailable', reasonCode: 'binding-unavailable', path: '$' });
  assert.equal(h.docker.volumes.size, 0);
  assert.equal(h.docker.calls.filter(call => call.args[1] === 'rm').length, 2);
});

test('protected paths and protected content never enter a helper payload', async () => {
  const h = await setup();
  writeFileSync(join(h.repositoryRoot, '.env'), 'excluded fixture');
  writeFileSync(join(h.repositoryRoot, 'notes.txt'), ['MARKER', 'SECRET'].join('_'));
  assert.equal((await bindRealTierTask(h.assembly, h.options)).status, 'unavailable');
  const payloads = h.docker.calls.flatMap(call => (call.options.stdin === undefined ? [] : [JSON.parse(call.options.stdin) as { files: { path: string }[] }]));
  assert.deepEqual(
    payloads.flatMap(payload => payload.files.map(file => file.path)),
    ['src/calc.py'],
  );
  assert.equal(h.docker.volumes.size, 0);
});

for (const failMirror of [false, true])
  test(`a settled patch mirrors before lease release (retry: ${failMirror})`, async () => {
    const h = await setup();
    const bound = await bindRealTierTask(h.assembly, h.options);
    assert.equal(bound.status, 'task-bound');
    if (bound.status !== 'task-bound') return;
    const allocated = h.assembly.workspaceManager.getWorkspace(bound.ids.workspaceId);
    assert.ok(allocated);
    const volume = h.docker.volumes.get(allocated.repoVolumeId);
    assert.ok(volume);
    volume.set('stale.py', Buffer.from('old volume file'));
    const patch = {
      actionId: 'patch-mirror',
      kind: 'apply_patch' as const,
      patchContent: '--- a/src/calc.py\n+++ b/src/calc.py\n@@ -1 +1 @@\n-value = 1\n+value = 2\n',
      targetPaths: ['src/calc.py'],
      baseRevisionDigest: h.revision,
    };
    const context = createTestRepositoryAdmissionContextV02({ ...bound.ids, repositoryId: h.task.repositoryId, canonicalRevision: h.revision, action: patch, targetPaths: patch.targetPaths });
    const journal = new MemoryStatePortV02({
      initialTaskState: createTestAdmissionTaskStateV02(context),
      initialAuthorityRef: context.policyAuthorityRef,
      initialControlVersion: context.expectedControlVersion,
      initialEpoch: context.expectedEpoch,
    });
    let mirrored = false;
    let failOnce = failMirror;
    const tools = new ControlledRepositoryTools({
      guardCapability: { provenance: 'mock', capabilityId: 'mirror-read', taskId: bound.ids.taskId, workspaceId: bound.ids.workspaceId, mediateRead: async operation => operation.execute() },
      fsPort: h.filesystem,
      limits: { maxExcerptBytes: 4096, maxResultCount: 16 },
      statePort: journal,
      workspaceManager: h.assembly.workspaceManager,
      adapterIdentity: 'mirror-test',
      processIncarnation: 'mirror-incarnation',
      fencingGeneration: 1,
      patchRecoveryHandoff: createRefusingPatchRecoveryHandoff(),
      unattemptedClaimClosureHandoff: {
        closeUnattemptedClaim: async () => {
          throw new Error('unexpected closure');
        },
      },
      attemptStartRecoveryHandoff: {
        queryAttemptStart: async () => {
          throw new Error('unexpected recovery');
        },
      },
      patchReceiver: async () => {
        writeFileSync(join(h.repositoryRoot, 'src/calc.py'), 'value = 2\n');
        const revision = await h.filesystem.getCurrentRevisionDigest();
        h.assembly.workspaceManager.setCanonicalRevision(bound.ids.workspaceId, revision);
        return { applied: true, newRevisionDigest: revision };
      },
      onSettledPatch: async revision => {
        assert.equal(journal.getJournalSnapshot().activeClaimId, null);
        assert.equal(h.assembly.workspaceManager.hasActiveWriterLease(bound.ids.workspaceId), true);
        if (failOnce) {
          failOnce = false;
          throw new Error('controlled mirror failure');
        }
        await mirrorRealTierWorkspace(h.assembly, bound.ids, h.filesystem, revision, 1_048_576);
        mirrored = true;
      },
    });
    if (failMirror) {
      const error = await tools.applyPatch(patch, context).catch((error: unknown) => error);
      assert.ok(error instanceof PatchOutcomePendingError);
      assert.equal(h.assembly.workspaceManager.hasActiveWriterLease(bound.ids.workspaceId), true);
      assert.deepEqual((await tools.recoverPatchOutcome(error.attemptId)).outcome, 'settled');
      assert.equal(journal.getJournalSnapshot().outcomes.length, 1);
    } else {
      const result = await tools.applyPatch(patch, context);
      assert.equal(result.executionReceipt.settlement.outcome, 'settled');
    }
    assert.equal(mirrored, true);
    const workspace = h.assembly.workspaceManager.getWorkspace(bound.ids.workspaceId);
    assert.ok(workspace);
    assert.deepEqual([...(h.docker.volumes.get(workspace.repoVolumeId) ?? [])], [['src/calc.py', Buffer.from('value = 2\n')]]);
    assert.equal(h.assembly.workspaceManager.getCanonicalRevision(bound.ids.workspaceId), await h.filesystem.getCurrentRevisionDigest());
    assert.equal(workspace.expectedRepoState, await h.filesystem.getCurrentRevisionDigest());
    assert.equal(h.assembly.workspaceManager.hasActiveWriterLease(bound.ids.workspaceId), false);
  });

for (const fault of ['timeout', 'truncated', 'measurement', 'allocation'] as const) {
  test(`failed setup releases canonical volumes (${fault})`, async () => {
    const h = await setup(fault);
    assert.equal((await bindRealTierTask(h.assembly, h.options)).status, 'unavailable');
    assert.equal(h.docker.volumes.size, 0);
    if (fault === 'timeout') assert.ok(h.docker.calls.some(call => call.args[0] === 'rm' && call.args[1] === '-f'));
  });
}

test('binding preserves raw binary file bytes', async () => {
  const h = await setup(undefined, true);
  const bound = await bindRealTierTask(h.assembly, h.options);
  assert.equal(bound.status, 'task-bound');
  if (bound.status !== 'task-bound') return;
  const workspace = h.assembly.workspaceManager.getWorkspace(bound.ids.workspaceId);
  assert.ok(workspace);
  assert.deepEqual(h.docker.volumes.get(workspace.repoVolumeId)?.get('asset.bin'), Buffer.from([0, 255, 128, 10]));
});
