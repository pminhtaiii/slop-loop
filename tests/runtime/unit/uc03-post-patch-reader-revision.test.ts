/**
 * UC-03 post-patch repository reader revision regression tests (issue #221 item 3).
 * Verifies reads before patch use R0, reads after patch settles use the settled revision R1
 * recorded by the owner, and mid-read revision changes are refused.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ControlledRepositoryReader } from '../../../src/foundation/repository-read.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import type { ExecutionGuardReadCapability, GuardedReadOperation } from '../../../src/foundation/repository-types.ts';

const R0 = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const R1 = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';

function createMockGuardCapability(): ExecutionGuardReadCapability {
  return {
    provenance: 'mock',
    capabilityId: 'post-patch-read',
    workspaceId: 'workspace-post-patch',
    taskId: 'task-post-patch',
    mediateRead: async <T>(operation: GuardedReadOperation<T>): Promise<T> => operation.execute(),
  };
}

function setupWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'post-patch-read-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/calculator.py'), 'def add(a, b): return a + b\n');
  return { root };
}

test('Item 3: ControlledRepositoryReader reads before patch use R0', async () => {
  const { root } = setupWorkspace();
  try {
    const fsPort = new WorkspaceFilesystemPort({ root });
    const realR0 = await fsPort.getCurrentRevisionDigest();
    const reader = new ControlledRepositoryReader({
      guardCapability: createMockGuardCapability(),
      fsPort,
      limits: { maxExcerptBytes: 4096, maxResultCount: 16 },
      expectedRevisionDigest: realR0,
      workspaceRoot: root,
    });

    const evidence = await reader.readFile('src/calculator.py');
    assert.equal(evidence.revisionDigest, realR0);
    assert.match(evidence.boundedExcerpt, /def add/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class CustomRevisionFilesystemPort extends WorkspaceFilesystemPort {
  getDigestFn: () => Promise<string>;
  constructor(root: string, getDigestFn: () => Promise<string>) {
    super({ root });
    this.getDigestFn = getDigestFn;
  }
  override async getCurrentRevisionDigest(): Promise<string> {
    return this.getDigestFn();
  }
}

test('Item 3: fixed pre-patch revision R0 throws STALE_REVISION on post-patch reads (reproducing #221 defect)', async () => {
  const { root } = setupWorkspace();
  try {
    let currentDigest = R0;
    const fsPort = new CustomRevisionFilesystemPort(root, async () => currentDigest);

    // Old behavior: expectedRevisionDigest fixed to R0
    const reader = new ControlledRepositoryReader({
      guardCapability: createMockGuardCapability(),
      fsPort,
      limits: { maxExcerptBytes: 4096, maxResultCount: 16 },
      expectedRevisionDigest: R0,
      workspaceRoot: root,
    });

    // Before patch: matches R0
    const beforePatch = await reader.readFile('src/calculator.py');
    assert.equal(beforePatch.revisionDigest, R0);

    // After patch settles: filesystem reports R1
    currentDigest = R1;

    // Fixed R0 reader must throw STALE_REVISION
    await assert.rejects(
      async () => {
        await reader.readFile('src/calculator.py');
      },
      /STALE_REVISION: REVISION_DRIFT: Expected revision sha256:000000.* but got sha256:111111/,
      'Fixed R0 reader must refuse post-patch read with STALE_REVISION',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Item 3: dynamic revision source resolves settled patch revision R1 after patch settles', async () => {
  const { root } = setupWorkspace();
  try {
    let currentFsDigest = R0;
    let settledOwnerRevision = R0;

    const fsPort = new CustomRevisionFilesystemPort(root, async () => currentFsDigest);

    // New behavior: expectedRevisionDigest dynamically takes owner's settled revision
    const reader = new ControlledRepositoryReader({
      guardCapability: createMockGuardCapability(),
      fsPort,
      limits: { maxExcerptBytes: 4096, maxResultCount: 16 },
      expectedRevisionDigest: () => settledOwnerRevision,
      workspaceRoot: root,
    });

    // 1. Pre-patch read uses R0
    const prePatch = await reader.readFile('src/calculator.py');
    assert.equal(prePatch.revisionDigest, R0);

    // 2. Patch settles: owner records R1, filesystem updates to R1
    settledOwnerRevision = R1;
    currentFsDigest = R1;

    // Post-patch read now succeeds at R1 without STALE_REVISION
    const postPatch = await reader.readFile('src/calculator.py');
    assert.equal(postPatch.revisionDigest, R1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Item 3: a read whose revision drifts mid-read is refused with REVISION_DRIFT', async () => {
  const { root } = setupWorkspace();
  try {
    let callCount = 0;
    const fsPort = new CustomRevisionFilesystemPort(root, async () => {
      callCount++;
      // First check returns R0; subsequent check mid-read returns R1
      return callCount === 1 ? R0 : R1;
    });

    const reader = new ControlledRepositoryReader({
      guardCapability: createMockGuardCapability(),
      fsPort,
      limits: { maxExcerptBytes: 4096, maxResultCount: 16 },
      expectedRevisionDigest: () => (callCount <= 1 ? R0 : R1),
      workspaceRoot: root,
    });

    // Read must be refused because revision changed mid-read
    await assert.rejects(
      async () => {
        await reader.readFile('src/calculator.py');
      },
      /REVISION_DRIFT: Revision changed from .* to .* (before|during) read/,
      'Mid-read revision change must be refused',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
