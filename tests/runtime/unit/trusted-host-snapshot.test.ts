/**
 * The trusted snapshot producer measures real workspace bytes; every claim the
 * request makes is compared against that measurement, and a refusal is total.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { computeCanonicalSha256, computeCheckSetDigest } from '../../../src/contracts/foundation/uc03.ts';
import type { CheckDefinition } from '../../../src/contracts/foundation/uc03.ts';
import { WorkspaceFilesystemPort } from '../../../src/foundation/host-filesystem-port.ts';
import type { TrustedFilesystemPort } from '../../../src/foundation/repository-types.ts';
import { createTrustedHostSnapshot, TrustedHostSnapshotError } from '../../../src/runtime/trusted-host-snapshot.ts';
import type { TrustedHostSnapshotRequest } from '../../../src/uc03/investigation-types.ts';
import { validateHostSnapshotFacts } from '../../../src/uc03/investigation-snapshot.ts';

const TASK_ID = 'task-1';
const WORKSPACE_ID = 'ws-1';
const REPOSITORY_ID = 'repo-1';
const CRITERIA = ['the bug is fixed'];
const CHECKS: readonly CheckDefinition[] = [{ checkId: 'repro', executable: 'pytest', argv: ['tests/test_a.py'], purpose: 'reproduction' }];
const INVENTORY = ['tests/test_a.py', 'tests/test_b.py'];

function withWorkspace(run: (root: string, t: TestContext) => Promise<void>): (t: TestContext) => Promise<void> {
  return async t => {
    const root = mkdtempSync(join(tmpdir(), 'uc03-trusted-snapshot-'));
    try {
      mkdirSync(join(root, 'tests'));
      writeFileSync(join(root, 'tests', 'test_a.py'), 'def test_a():\n    assert True\n');
      writeFileSync(join(root, 'tests', 'test_b.py'), 'def test_b():\n    assert True\n');
      await run(root, t);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function producer(filesystem: TrustedFilesystemPort, overrides: Partial<Parameters<typeof createTrustedHostSnapshot>[0]> = {}) {
  return createTrustedHostSnapshot({
    filesystem,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    acceptanceCriteria: CRITERIA,
    requiredChecks: CHECKS,
    expectedTestFiles: INVENTORY,
    maxFileBytes: 4096,
    ...overrides,
  });
}

async function request(filesystem: TrustedFilesystemPort, overrides: Partial<TrustedHostSnapshotRequest> = {}): Promise<TrustedHostSnapshotRequest> {
  return {
    taskId: TASK_ID,
    workspaceId: WORKSPACE_ID,
    repositoryId: REPOSITORY_ID,
    expectedRevisionDigest: await filesystem.getCurrentRevisionDigest(),
    expectedCriteriaDigest: computeCanonicalSha256(CRITERIA),
    expectedCheckSetDigest: computeCheckSetDigest(CHECKS),
    expectedTestFiles: INVENTORY,
    ...overrides,
  };
}

test(
  'trusted snapshot: measured revision, check set and file bytes satisfy the existing validator',
  withWorkspace(async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    const snapshot = await producer(filesystem).loadSnapshot(await request(filesystem));

    assert.equal(snapshot.currentRevision, await filesystem.getCurrentRevisionDigest());
    assert.equal(snapshot.checkSetDigest, computeCheckSetDigest(CHECKS));
    assert.deepEqual(snapshot.expectedTestFiles, INVENTORY);
    assert.deepEqual(
      snapshot.testFiles.map(file => file.path),
      INVENTORY,
    );

    const validation = validateHostSnapshotFacts(
      snapshot,
      {
        taskId: TASK_ID,
        workspaceId: WORKSPACE_ID,
        repositoryId: REPOSITORY_ID,
        revisionDigest: snapshot.currentRevision,
        criteriaDigest: computeCanonicalSha256(CRITERIA),
        checkSetDigest: computeCheckSetDigest(CHECKS),
        expectedTestFiles: INVENTORY,
      },
      CHECKS,
    );
    assert.deepEqual(validation.ok, true, validation.ok ? '' : validation.reason);
  }),
);

test(
  'trusted snapshot: an expected revision digest that is only a claim is refused',
  withWorkspace(async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    const forged = computeCanonicalSha256('forged');
    const forgedRequest = await request(filesystem, { expectedRevisionDigest: forged });
    await assert.rejects(async () => producer(filesystem).loadSnapshot(forgedRequest), /REVISION_MISMATCH/);
  }),
);

test(
  'trusted snapshot: a changed protected test is measured, a missing one refuses the whole snapshot',
  withWorkspace(async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    const authority = producer(filesystem);

    writeFileSync(join(root, 'tests', 'test_a.py'), 'def test_a():\n    assert False\n');
    const changed = await authority.loadSnapshot(await request(filesystem));
    assert.equal(changed.testFiles[0]?.content, 'def test_a():\n    assert False\n', 'measured bytes, not a claimed digest');

    writeFileSync(join(root, 'tests', 'test_a.py'), 'def test_a():\n    assert True\n');
    rmSync(join(root, 'tests', 'test_b.py'));
    await assert.rejects(async () => authority.loadSnapshot(await request(filesystem)), /MISSING_FILE/);
  }),
);

test(
  'trusted snapshot: a link out of the workspace is a linked escape, not a measured file',
  withWorkspace(async (root, t) => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    rmSync(join(root, 'tests', 'test_b.py'));
    const outside = mkdtempSync(join(tmpdir(), 'uc03-trusted-snapshot-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'test_b.py'), 'def test_b():\n    assert True\n');
    if (process.platform === 'win32') {
      // A junction needs no elevation; a file symlink may.
      try {
        symlinkSync(outside, join(root, 'tests', 'test_b.py'), 'junction');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return t.skip(`cannot create a link without elevation: ${String(error)}`);
        throw error;
      }
    } else {
      symlinkSync(join(outside, 'test_b.py'), join(root, 'tests', 'test_b.py'), 'file');
    }

    await assert.rejects(async () => producer(filesystem).loadSnapshot(await request(filesystem)), /LINKED_ESCAPE/);
  }),
);

test(
  'trusted snapshot: an oversized or unreadable file refuses rather than truncating',
  withWorkspace(async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    writeFileSync(join(root, 'tests', 'test_b.py'), 'x'.repeat(5000));
    await assert.rejects(async () => producer(filesystem).loadSnapshot(await request(filesystem)), /OVERSIZED_FILE/);

    writeFileSync(join(root, 'tests', 'test_b.py'), 'def test_b():\n    assert True\n');
    const unreadable: TrustedFilesystemPort = Object.create(filesystem);
    Object.assign(unreadable, {
      readTextFile: async (path: string, maxBytes?: number) => {
        if (path === 'tests/test_b.py') throw new Error('EACCES');
        return filesystem.readTextFile(path, maxBytes);
      },
    });
    await assert.rejects(async () => producer(unreadable).loadSnapshot(await request(filesystem)), /UNREADABLE_FILE/);
  }),
);

test(
  'trusted snapshot: revision drift during measurement refuses with no partial snapshot',
  withWorkspace(async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    let revisionReads = 0;
    const drifting: TrustedFilesystemPort = Object.create(filesystem);
    Object.assign(drifting, {
      getCurrentRevisionDigest: async () => {
        revisionReads += 1;
        // The first read measures; the second observes a concurrent write.
        if (revisionReads === 2) writeFileSync(join(root, 'tests', 'test_a.py'), 'def test_a():\n    assert "drift"\n');
        return filesystem.getCurrentRevisionDigest();
      },
    });

    await assert.rejects(async () => producer(drifting).loadSnapshot(await request(filesystem)), /REVISION_DRIFT/);
  }),
);

test(
  'trusted snapshot: request traversal, foreign identity and inventory substitution refuse',
  withWorkspace(async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    const authority = producer(filesystem);

    await assert.rejects(async () => authority.loadSnapshot(await request(filesystem, { expectedTestFiles: ['../etc/passwd'] })), /INVALID_REQUEST/);
    await assert.rejects(async () => authority.loadSnapshot(await request(filesystem, { workspaceId: 'other-ws' })), /IDENTITY_MISMATCH/);
    await assert.rejects(async () => authority.loadSnapshot(await request(filesystem, { repositoryId: 'other-repo' })), /IDENTITY_MISMATCH/);
    await assert.rejects(async () => authority.loadSnapshot(await request(filesystem, { expectedTestFiles: ['tests/test_a.py'] })), /INVALID_REQUEST/);
  }),
);

test(
  'trusted snapshot: a refused path is reported by index and never echoed',
  withWorkspace(async root => {
    const filesystem = new WorkspaceFilesystemPort({ root });
    const authority = producer(filesystem);
    // Newlines, terminal escapes and traversal all fail canonicalization; none may reach the refusal message.
    const invalid = 'FORGED_INVALID\n\u001b[31m/../escape';
    const canonical = 'FORGED_CONTROL\n\u001b[31m.py';
    const refusal = (code: string) => (error: unknown) => {
      assert.ok(error instanceof TrustedHostSnapshotError);
      assert.equal(error.code, code);
      assert.ok(!error.message.includes('FORGED_'), 'the refused input is not echoed into the message');
      return true;
    };

    await assert.rejects(async () => producer(filesystem, { expectedTestFiles: ['tests/test_a.py', invalid] }), refusal('INVALID_CONFIGURATION'));
    await assert.rejects(async () => producer(filesystem, { expectedTestFiles: [canonical, canonical] }), refusal('INVALID_CONFIGURATION'));
    await assert.rejects(async () => authority.loadSnapshot(await request(filesystem, { expectedTestFiles: ['tests/test_a.py', invalid] })), refusal('INVALID_REQUEST'));
    await assert.rejects(async () => authority.loadSnapshot(await request(filesystem, { expectedTestFiles: ['tests/test_a.py', canonical] })), refusal('INVALID_REQUEST'));
  }),
);

test('trusted snapshot: an unsupported platform is an explicit refusal', async () => {
  const platform = process.platform;
  let refusal: unknown;
  const filesystem: TrustedFilesystemPort = {
    provenance: 'real',
    stat: async () => ({ isFile: true, isDirectory: false, isSymbolicLink: false, size: 0 }),
    lstat: async () => ({ isFile: true, isDirectory: false, isSymbolicLink: false, size: 0 }),
    realpath: async path => path,
    readDir: async () => [],
    readTextFile: async () => '',
    getCurrentRevisionDigest: async () => `sha256:${'0'.repeat(64)}`,
  };
  const authority = producer(filesystem);
  const snapshotRequest = await request(filesystem);
  try {
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    refusal = await Promise.resolve(authority.loadSnapshot(snapshotRequest)).then(
      () => undefined,
      (error: unknown) => error,
    );
  } finally {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
  assert.match(String(refusal), /UNSUPPORTED_PLATFORM/);
});
