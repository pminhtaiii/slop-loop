/**
 * T040 read fencing: the owner fence issues a receipt only for the persisted control head it just
 * observed, so a pause, hold, epoch or policy drift after observation refuses the read before its
 * closure runs. Durable store over a temp directory; no Docker or provider.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { PolicyAuthorityRefV02, RepositoryAdmissionContextV02, TaskState } from '../../../src/contracts/foundation/uc03.ts';
import { createGuardedReadCapability, type GuardedReadOwnerPort } from '../../../src/foundation/guarded-read-capability.ts';
import { DurableStore } from '../../../src/persistence/store.ts';
import { DurableStatePortV02 } from '../../../src/persistence/adapters/state-port-v02.ts';
import { StatePortStore } from '../../../src/persistence/adapters/state-port-v02-storage.ts';
import type { ControlRecordV02 } from '../../../src/persistence/adapters/state-port-v02-types.ts';
import { createStateReadFence, stateReadPolicyDigest, type StateReadFenceBinding } from '../../../src/persistence/adapters/state-port-v02-read-fence.ts';
import { createTestAdmissionTaskStateV02, createTestRepositoryCommandAdmissionContextV02 } from '../support/uc03/state-fixtures.ts';

const context: RepositoryAdmissionContextV02 = createTestRepositoryCommandAdmissionContextV02();
const binding: StateReadFenceBinding = { taskId: context.taskId, workspaceId: context.workspaceId, repositoryId: context.repositoryId };
const FOREIGN_AUTHORITY: PolicyAuthorityRefV02 = { ...context.policyAuthorityRef, configVersion: '2.0.0', decisionAuthorityGeneration: 4 };

function seedTask(): TaskState {
  const task = createTestAdmissionTaskStateV02(context);
  return {
    ...task,
    budgetLedgers: [...(task.budgetLedgers ?? []), { scope: 'task', kind: 'timeoutMs', limit: 60_000, consumed: 0, reservations: [], unit: 'count', configurationId: 'config-v1', version: 1 }],
  };
}

async function openPort(baseDir: string): Promise<DurableStatePortV02> {
  const store = new DurableStore(baseDir);
  await store.init();
  const port = new DurableStatePortV02({
    store,
    initialControl: { controlVersion: context.expectedControlVersion, epoch: context.expectedEpoch, activeAuthorityRef: context.policyAuthorityRef },
  });
  await port.transition(seedTask(), 0);
  // A claimed task carries a persisted, authority-bearing control head; seed the same shape.
  await new StatePortStore(store).writeControl(context.taskId, SEEDED_CONTROL);
  return port;
}

const SEEDED_CONTROL: ControlRecordV02 = {
  controlVersion: context.expectedControlVersion,
  epoch: context.expectedEpoch,
  mode: 'runnable',
  holdRef: null,
  holdEventDigest: null,
  activeAuthorityRef: context.policyAuthorityRef,
  activeClaimId: null,
};

function capability(task: TaskState, owner: GuardedReadOwnerPort): ReturnType<typeof createGuardedReadCapability> {
  return createGuardedReadCapability({
    capabilityId: 'uc04-real-read-1',
    taskId: binding.taskId,
    workspaceId: binding.workspaceId,
    repositoryId: binding.repositoryId,
    expectedRevisionDigest: task.repositoryRevisionDigest,
    policyDigest: stateReadPolicyDigest(binding.taskId, context.policyAuthorityRef),
    bounds: { maxPathLength: 512, maxQueryLength: 256 },
    provenance: 'real',
    owner,
  });
}

function readOperation(onExecute: () => void): { kind: 'read'; targetPath: string; execute: () => Promise<string> } {
  return {
    kind: 'read',
    targetPath: 'src/calculator.py',
    execute: () => {
      onExecute();
      return Promise.resolve('bounded-excerpt');
    },
  };
}

test('state read fence: a runnable task admits one read through the owner protocol', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-read-fence-pass-'));
  try {
    const port = await openPort(baseDir);
    const task = (await port.loadTask(binding.taskId)) as TaskState;
    const owner = createStateReadFence(port, binding);
    const observation = await owner.observeReadControl();
    assert.equal(observation.mode, 'runnable');
    assert.equal(observation.holdRef, null);
    assert.equal(observation.readAllowed, true);
    assert.equal(observation.controlVersion, context.expectedControlVersion);
    assert.equal(observation.fencingGeneration, context.expectedEpoch);
    assert.equal(observation.revisionDigest, task.repositoryRevisionDigest);
    assert.equal(observation.policyDigest, stateReadPolicyDigest(binding.taskId, context.policyAuthorityRef));

    let calls = 0;
    const cap = capability(task, owner);
    assert.equal(await cap.mediateRead(readOperation(() => (calls += 1))), 'bounded-excerpt');
    assert.equal(calls, 1, 'the closure must run exactly once');
    const receipt = await owner.fenceReadControl(await owner.observeReadControl());
    assert.ok(receipt, 'the unchanged head must still fence');
    assert.equal(receipt.controlVersion, observation.controlVersion);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('state read fence: a pause between observation and fence refuses the read and its closure', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-read-fence-pause-'));
  try {
    // Direct: an observation taken while runnable is refused once the task pauses.
    const directPort = await openPort(join(baseDir, 'direct'));
    const task = (await directPort.loadTask(binding.taskId)) as TaskState;
    const directOwner = createStateReadFence(directPort, binding);
    const observation = await directOwner.observeReadControl();
    assert.equal(observation.mode, 'runnable');
    assert.equal(await directPort.setTaskControl(binding.taskId, 'paused', 'pause-t040-read-1'), true);
    assert.equal(await directOwner.fenceReadControl(observation), null, 'a paused task must not keep its observation current');

    // The same race through the capability: the closure never runs and no receipt is issued.
    const racePort = await openPort(join(baseDir, 'race'));
    const raceOwner = createStateReadFence(racePort, binding);
    const racing: GuardedReadOwnerPort = {
      observeReadControl: () => raceOwner.observeReadControl(),
      fenceReadControl: async observed => {
        await racePort.setTaskControl(binding.taskId, 'paused', 'pause-t040-read-2');
        return raceOwner.fenceReadControl(observed);
      },
    };
    let calls = 0;
    await assert.rejects(() => capability(task, racing).mediateRead(readOperation(() => (calls += 1))), /READ_FENCED/);
    assert.equal(calls, 0, 'no closure may run without a current fence receipt');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('state read fence: a persisted control write after observation refuses the fence', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-read-fence-drift-'));
  try {
    const port = await openPort(baseDir);
    const state = new StatePortStore(port.store);
    const owner = createStateReadFence(port, binding);

    const epochDrift = await owner.observeReadControl();
    await state.writeControl(binding.taskId, { ...SEEDED_CONTROL, epoch: SEEDED_CONTROL.epoch + 1 });
    assert.equal(await owner.fenceReadControl(epochDrift), null, 'an epoch change must refuse the observed read');

    const policyDrift = await owner.observeReadControl();
    await state.writeControl(binding.taskId, { ...SEEDED_CONTROL, epoch: SEEDED_CONTROL.epoch + 1, activeAuthorityRef: FOREIGN_AUTHORITY });
    assert.equal(await owner.fenceReadControl(policyDrift), null, 'a policy authority change must refuse the observed read');

    const holdDrift = await owner.observeReadControl();
    assert.equal(holdDrift.mode, 'runnable', 'the seeded head is readable before the hold');
    assert.equal(await port.setTaskControl(binding.taskId, 'paused', 'hold-t040-read-1'), true);
    const held = await owner.observeReadControl();
    assert.equal(held.readAllowed, false, 'a held task must not advertise a readable control');
    assert.equal(await owner.fenceReadControl(holdDrift), null, 'a hold change must refuse the observed read');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('state read fence: a foreign task, workspace or repository is refused', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-read-fence-foreign-'));
  try {
    const port = await openPort(baseDir);
    const task = (await port.loadTask(binding.taskId)) as TaskState;
    let calls = 0;

    const foreignWorkspace = createStateReadFence(port, { ...binding, workspaceId: 'workspace-foreign' });
    await assert.rejects(() => capability(task, foreignWorkspace).mediateRead(readOperation(() => (calls += 1))), /STATE_READ_FENCE_FOREIGN/);
    await assert.rejects(() => Promise.resolve(createStateReadFence(port, { ...binding, repositoryId: 'repo-foreign' }).observeReadControl()), /STATE_READ_FENCE_FOREIGN/);
    await assert.rejects(() => Promise.resolve(createStateReadFence(port, { ...binding, taskId: 'task-t040-absent' }).observeReadControl()), /STATE_READ_FENCE_UNAVAILABLE/);

    // A capability bound to another repository refuses the persisted identity even with a matching owner.
    const owner = createStateReadFence(port, binding);
    const foreignCap = createGuardedReadCapability({
      capabilityId: 'uc04-real-read-2',
      taskId: binding.taskId,
      workspaceId: binding.workspaceId,
      repositoryId: 'repo-foreign',
      expectedRevisionDigest: task.repositoryRevisionDigest,
      policyDigest: stateReadPolicyDigest(binding.taskId, context.policyAuthorityRef),
      bounds: { maxPathLength: 512, maxQueryLength: 256 },
      provenance: 'real',
      owner,
    });
    await assert.rejects(() => foreignCap.mediateRead(readOperation(() => (calls += 1))), /READ_CONTROL_MISMATCH/);
    assert.equal(calls, 0, 'no refused read may run its closure');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('state read fence: no published policy authority refuses the observation', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-read-fence-nopolicy-'));
  try {
    const port = await openPort(baseDir);
    const state = new StatePortStore(port.store);
    await state.writeControl(binding.taskId, {
      controlVersion: context.expectedControlVersion,
      epoch: context.expectedEpoch,
      mode: 'runnable',
      holdRef: null,
      holdEventDigest: null,
      activeAuthorityRef: null,
      activeClaimId: null,
    });
    await assert.rejects(() => Promise.resolve(createStateReadFence(port, binding).observeReadControl()), /STATE_READ_FENCE_UNAVAILABLE/);
    assert.throws(() => createStateReadFence(port, { ...binding, taskId: '../escape' }), /MISSING_READ_FENCE_BINDING/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('state read fence: runnable heads reject an orphaned hold digest', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'uc04-read-fence-orphan-'));
  try {
    const port = await openPort(baseDir);
    const state = new StatePortStore(port.store);
    assert.ok(state.readControlHead(binding.taskId));
    await state.writeControl(binding.taskId, { ...SEEDED_CONTROL, holdEventDigest: `sha256:${'a'.repeat(64)}` });
    assert.equal(state.readControlHead(binding.taskId), null);
    await state.writeControl(binding.taskId, SEEDED_CONTROL);
    assert.ok(state.readControlHead(binding.taskId));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
