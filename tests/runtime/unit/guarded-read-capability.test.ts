/**
 * T021 — fenced guarded reads.
 *
 * The capability is a producer: it validates an operation, observes current owner control/policy,
 * admits dispatch through the owner's fence, then invokes the closure exactly once. A control that
 * changed between observation and dispatch denies instead of executing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GuardedReadDenial,
  createGuardedReadCapability,
  type GuardedReadCapabilityOptions,
  type GuardedReadControlObservation,
  type GuardedReadFenceReceipt,
  type GuardedReadOwnerPort,
} from '../../../src/foundation/guarded-read-capability.ts';
import type { GuardedReadOperation } from '../../../src/foundation/repository-types.ts';

const taskId = 'task-guarded';
const workspaceId = 'ws-guarded';
const repositoryId = 'repo-guarded';
const revision = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const policy = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function runnableControl(overrides: Partial<GuardedReadControlObservation> = {}): GuardedReadControlObservation {
  return {
    taskId,
    workspaceId,
    repositoryId,
    revisionDigest: revision,
    controlVersion: 3,
    mode: 'runnable',
    holdRef: null,
    fencingGeneration: 5,
    policyDigest: policy,
    readAllowed: true,
    ...overrides,
  };
}

interface FakeOwner {
  control: GuardedReadControlObservation;
  writes: number;
  observeCalls: number;
  fenceCalls: number;
  events: string[];
  beforeFence?: (() => void) | undefined;
  owner: GuardedReadOwnerPort;
}

/** Mirrors an owner store: fence validates the observation against current control atomically. */
function fakeOwner(initial: GuardedReadControlObservation = runnableControl()): FakeOwner {
  const fake: FakeOwner = { control: initial, writes: 0, observeCalls: 0, fenceCalls: 0, events: [], owner: undefined as unknown as GuardedReadOwnerPort };
  fake.owner = {
    observeReadControl: () => {
      fake.observeCalls += 1;
      fake.events.push('observe');
      return { ...fake.control };
    },
    fenceReadControl: observation => {
      fake.fenceCalls += 1;
      fake.events.push('fence');
      fake.beforeFence?.();
      const current = fake.control;
      if (
        current.taskId !== observation.taskId ||
        current.workspaceId !== observation.workspaceId ||
        current.repositoryId !== observation.repositoryId ||
        current.revisionDigest !== observation.revisionDigest ||
        current.controlVersion !== observation.controlVersion ||
        current.mode !== observation.mode ||
        current.holdRef !== observation.holdRef ||
        current.fencingGeneration !== observation.fencingGeneration ||
        current.policyDigest !== observation.policyDigest ||
        current.readAllowed !== observation.readAllowed
      ) {
        return null;
      }
      fake.writes += 1;
      const receipt: GuardedReadFenceReceipt = {
        receiptId: `fence-${current.controlVersion}`,
        taskId: current.taskId,
        workspaceId: current.workspaceId,
        repositoryId: current.repositoryId,
        revisionDigest: current.revisionDigest,
        controlVersion: current.controlVersion,
        fencingGeneration: current.fencingGeneration,
        policyDigest: current.policyDigest,
      };
      return receipt;
    },
  };
  return fake;
}

function options(owner: FakeOwner, overrides: Partial<GuardedReadCapabilityOptions> = {}): GuardedReadCapabilityOptions {
  return {
    capabilityId: 'guard-read-1',
    taskId,
    workspaceId,
    repositoryId,
    expectedRevisionDigest: revision,
    policyDigest: policy,
    bounds: { maxPathLength: 512, maxQueryLength: 256 },
    owner: owner.owner,
    provenance: 'mock',
    ...overrides,
  };
}

function witness(): { calls: number; execute: () => Promise<string> } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    execute: async () => {
      state.calls += 1;
      return 'ok';
    },
  };
}

async function denial(promise: Promise<unknown>, reasonCode: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof GuardedReadDenial, 'denial must be a typed GuardedReadDenial');
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

test('guarded read: read-only closure is invoked exactly once after observe and fence', async () => {
  const owner = fakeOwner();
  const capability = createGuardedReadCapability(options(owner));
  const execute = witness();

  assert.equal(await capability.mediateRead({ kind: 'read', targetPath: 'src/index.ts', execute: execute.execute }), 'ok');
  assert.equal(execute.calls, 1);
  assert.deepEqual(owner.events, ['observe', 'fence']);
  assert.equal(owner.writes, 1);
});

test('guarded read: valid list and search read paths are admitted', async () => {
  const owner = fakeOwner();
  const capability = createGuardedReadCapability(options(owner));

  const listed = await capability.mediateRead({ kind: 'list', targetPath: '.', execute: async () => ['src'] });
  assert.deepEqual(listed, ['src']);
  const found = await capability.mediateRead({ kind: 'search', query: 'needle', execute: async () => ['src/a.ts'] });
  assert.deepEqual(found, ['src/a.ts']);
  assert.equal(owner.observeCalls, 2);
});

test('guarded read: unknown operation kind denies before any observation or closure', async () => {
  const owner = fakeOwner();
  const capability = createGuardedReadCapability(options(owner));
  const execute = witness();

  await denial(capability.mediateRead({ kind: 'delete', targetPath: 'src/a.ts', execute: execute.execute } as unknown as GuardedReadOperation<string>), 'UNSUPPORTED_READ_KIND');
  assert.equal(execute.calls, 0);
  assert.equal(owner.observeCalls, 0);
});

test('guarded read: trajectory task/workspace/repository mismatch denies without dispatch', async () => {
  for (const field of ['taskId', 'workspaceId', 'repositoryId'] as const) {
    const owner = fakeOwner(runnableControl({ [field]: 'other-identity' }));
    const capability = createGuardedReadCapability(options(owner));
    const execute = witness();
    await denial(capability.mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: execute.execute }), 'READ_CONTROL_MISMATCH');
    assert.equal(execute.calls, 0);
  }
});

test('guarded read: revision drift denies without dispatch', async () => {
  const owner = fakeOwner(runnableControl({ revisionDigest: `sha256:${'c'.repeat(64)}` }));
  const capability = createGuardedReadCapability(options(owner));
  const execute = witness();

  await denial(capability.mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: execute.execute }), 'READ_REVISION_MISMATCH');
  assert.equal(execute.calls, 0);
});

test('guarded read: paused, held, fenced and ended control deny without dispatch', async () => {
  const cases: readonly [Partial<GuardedReadControlObservation>, string][] = [
    [{ mode: 'paused' }, 'READ_CONTROL_NOT_RUNNABLE'],
    [{ mode: 'recovery' }, 'READ_CONTROL_NOT_RUNNABLE'],
    [{ holdRef: 'hold-9' }, 'READ_CONTROL_HELD'],
    [{ fencingGeneration: 0 }, 'INVALID_READ_CONTROL'],
  ];
  for (const [override, reasonCode] of cases) {
    const owner = fakeOwner(runnableControl(override));
    const capability = createGuardedReadCapability(options(owner));
    const execute = witness();
    await denial(capability.mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: execute.execute }), reasonCode);
    assert.equal(execute.calls, 0);
    assert.equal(owner.writes, 0);
  }
});

test('guarded read: current read policy denial and policy substitution deny', async () => {
  const deniedOwner = fakeOwner(runnableControl({ readAllowed: false }));
  const deniedExecute = witness();
  await denial(createGuardedReadCapability(options(deniedOwner)).mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: deniedExecute.execute }), 'READ_POLICY_DENIED');
  assert.equal(deniedExecute.calls, 0);

  const substituted = fakeOwner(runnableControl({ policyDigest: `sha256:${'d'.repeat(64)}` }));
  const substitutedExecute = witness();
  await denial(createGuardedReadCapability(options(substituted)).mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: substitutedExecute.execute }), 'READ_POLICY_MISMATCH');
  assert.equal(substitutedExecute.calls, 0);
});

test('guarded read: malformed paths and queries deny before observation', async () => {
  const owner = fakeOwner();
  const capability = createGuardedReadCapability(options(owner));
  const execute = witness();

  for (const targetPath of ['../etc/passwd', '/abs/path', 'src\\a.ts', 'src/../a.ts', 'src//a.ts', 'src/a.ts/']) {
    await denial(capability.mediateRead({ kind: 'read', targetPath, execute: execute.execute }), 'INVALID_READ_PATH');
  }
  await denial(capability.mediateRead({ kind: 'read', execute: execute.execute }), 'INVALID_READ_PATH');
  await denial(capability.mediateRead({ kind: 'list', targetPath: 'x'.repeat(513), execute: execute.execute }), 'INVALID_READ_PATH');
  await denial(capability.mediateRead({ kind: 'search', execute: execute.execute }), 'INVALID_READ_QUERY');
  await denial(capability.mediateRead({ kind: 'search', query: '', execute: execute.execute }), 'INVALID_READ_QUERY');
  await denial(capability.mediateRead({ kind: 'search', query: 'q'.repeat(257), execute: execute.execute }), 'INVALID_READ_QUERY');
  await denial(capability.mediateRead({ kind: 'search', query: 'a\0b', execute: execute.execute }), 'INVALID_READ_QUERY');
  await denial(capability.mediateRead({ kind: 'list', query: 'ignored', execute: execute.execute }), 'INVALID_READ_QUERY');

  assert.equal(execute.calls, 0);
  assert.equal(owner.observeCalls, 0);
});

test('guarded read: protected paths deny with the protected reason code', async () => {
  const capability = createGuardedReadCapability(options(fakeOwner()));
  for (const targetPath of ['.env.local', '.git/config', 'eval/uc03/private/case.json', 'secrets.json']) {
    await denial(capability.mediateRead({ kind: 'read', targetPath, execute: async () => 'x' }), 'PROTECTED_READ_PATH');
  }
});

test('guarded read: race witness — control fences between observation and dispatch', async () => {
  const owner = fakeOwner();
  const execute = witness();
  // The witness mutates owner control after the observation is taken but before the fence runs.
  owner.beforeFence = () => {
    owner.control = { ...owner.control, mode: 'paused', holdRef: 'hold-race', controlVersion: owner.control.controlVersion + 1, fencingGeneration: owner.control.fencingGeneration + 1 };
  };
  const capability = createGuardedReadCapability(options(owner));

  await denial(capability.mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: execute.execute }), 'READ_FENCED');
  assert.equal(execute.calls, 0);
  assert.equal(owner.observeCalls, 1);
  assert.equal(owner.fenceCalls, 1);
  assert.equal(owner.writes, 0);
  // The persisted owner control is the fenced state the witness wrote; denial did not rewrite it.
  assert.equal(owner.control.mode, 'paused');
  assert.equal(owner.control.controlVersion, 4);
});

test('guarded read: read-policy flip between observation and fence denies dispatch', async () => {
  const owner = fakeOwner();
  const execute = witness();
  // Only the policy decision changes; every other fenced field stays current.
  owner.beforeFence = () => {
    owner.control = { ...owner.control, readAllowed: false };
  };
  const capability = createGuardedReadCapability(options(owner));

  await denial(capability.mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: execute.execute }), 'READ_FENCED');
  assert.equal(execute.calls, 0);
  assert.equal(owner.writes, 0);
});

test('guarded read: fence receipt that does not match the observation denies', async () => {
  const owner = fakeOwner();
  owner.owner = {
    observeReadControl: () => ({ ...owner.control }),
    fenceReadControl: () => ({
      receiptId: 'fence-stale',
      taskId,
      workspaceId,
      repositoryId,
      revisionDigest: revision,
      controlVersion: 2,
      fencingGeneration: 5,
      policyDigest: policy,
    }),
  };
  const execute = witness();
  await denial(createGuardedReadCapability(options(owner)).mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: execute.execute }), 'READ_FENCE_MISMATCH');
  assert.equal(execute.calls, 0);
});

test('guarded read: missing fencing protocol refuses construction', () => {
  const incomplete = { observeReadControl: () => runnableControl() } as unknown as GuardedReadOwnerPort;
  assert.throws(() => createGuardedReadCapability(options(fakeOwner(), { owner: incomplete })), /MISSING_READ_FENCING_PROTOCOL/);
});

test('guarded read: missing or non-finite bounds refuse construction', () => {
  const owner = fakeOwner();
  assert.throws(() => createGuardedReadCapability(options(owner, { bounds: undefined as unknown as GuardedReadCapabilityOptions['bounds'] })), /MISSING_READ_BOUNDS/);
  assert.throws(() => createGuardedReadCapability(options(owner, { bounds: { maxPathLength: 0, maxQueryLength: 256 } })), /INVALID_READ_BOUNDS/);
  assert.throws(() => createGuardedReadCapability(options(owner, { bounds: { maxPathLength: 512, maxQueryLength: Number.POSITIVE_INFINITY } })), /INVALID_READ_BOUNDS/);
  assert.throws(() => createGuardedReadCapability(options(owner, { bounds: { maxPathLength: 1.5, maxQueryLength: 256 } })), /INVALID_READ_BOUNDS/);
});

test('guarded read: invalid adapter identity, revision or policy digest refuses construction', () => {
  const owner = fakeOwner();
  assert.throws(() => createGuardedReadCapability(options(owner, { taskId: '' })), /INVALID_GUARDED_READ_IDENTITY/);
  assert.throws(() => createGuardedReadCapability(options(owner, { expectedRevisionDigest: '' })), /INVALID_EXPECTED_REVISION/);
  assert.throws(() => createGuardedReadCapability(options(owner, { policyDigest: 'not-a-digest' })), /INVALID_READ_POLICY_DIGEST/);
});

test('guarded read: concurrent reads observe control under the same serialized tail', async () => {
  const owner = fakeOwner();
  const capability = createGuardedReadCapability(options(owner));
  const execute = witness();

  const results = await Promise.all([
    capability.mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: execute.execute }),
    capability.mediateRead({ kind: 'read', targetPath: 'src/b.ts', execute: execute.execute }),
  ]);
  assert.deepEqual(results, ['ok', 'ok']);
  assert.equal(execute.calls, 2);
  assert.deepEqual(owner.events, ['observe', 'fence', 'observe', 'fence']);
});

test('guarded read: a pending closure does not serialize later reads', { timeout: 5000 }, async () => {
  const owner = fakeOwner();
  const capability = createGuardedReadCapability(options(owner));
  let releaseSlow: () => void = () => undefined;
  const slowSettled = new Promise<void>(resolve => {
    releaseSlow = resolve;
  });

  const slow = capability.mediateRead({
    kind: 'read',
    targetPath: 'src/a.ts',
    execute: async () => {
      await slowSettled;
      return 'slow';
    },
  });
  // The tail must release once the closure is invoked, so the next read observes and fences without waiting.
  await Promise.resolve();
  assert.equal(await capability.mediateRead({ kind: 'read', targetPath: 'src/b.ts', execute: async () => 'fast' }), 'fast');
  assert.deepEqual(owner.events, ['observe', 'fence', 'observe', 'fence']);

  releaseSlow();
  assert.equal(await slow, 'slow');
});

test('guarded read: a path rejected before chaining does not wedge later reads', async () => {
  const owner = fakeOwner();
  const capability = createGuardedReadCapability(options(owner));
  await denial(capability.mediateRead({ kind: 'read', targetPath: '../a.ts', execute: async () => 'never' }), 'INVALID_READ_PATH');

  const execute = witness();
  assert.equal(await capability.mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: execute.execute }), 'ok');
  assert.equal(execute.calls, 1);
});

test('guarded read: a fenced denial inside dispatch does not wedge later reads', async () => {
  const owner = fakeOwner();
  const capability = createGuardedReadCapability(options(owner));
  // Release the serialized chain: a later read must not inherit this rejection.
  owner.beforeFence = () => {
    owner.control = { ...owner.control, mode: 'paused' };
  };
  await denial(capability.mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: async () => 'never' }), 'READ_FENCED');
  owner.beforeFence = undefined;
  owner.control = { ...owner.control, mode: 'runnable' };

  const execute = witness();
  assert.equal(await capability.mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: execute.execute }), 'ok');
  assert.equal(execute.calls, 1);
});

test('guarded read: a rejecting closure does not wedge later reads', async () => {
  const owner = fakeOwner();
  const capability = createGuardedReadCapability(options(owner));
  const failure = new Error('reader exploded');
  await assert.rejects(capability.mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: async () => Promise.reject(failure) }), error => error === failure);

  const execute = witness();
  assert.equal(await capability.mediateRead({ kind: 'read', targetPath: 'src/a.ts', execute: execute.execute }), 'ok');
  assert.equal(execute.calls, 1);
});

test('guarded read: no execute-through surface is exposed', () => {
  const capability = createGuardedReadCapability(options(fakeOwner()));
  assert.equal(typeof capability.mediateRead, 'function');
  for (const name of ['runCommand', 'applyPatch', 'execute', 'runTests', 'shell', 'dispatch']) {
    assert.equal(name in capability, false, `${name} must not be exposed`);
  }
});
