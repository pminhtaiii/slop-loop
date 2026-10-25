import { MemoryStatePortV02 } from '../support/uc03/memory-state.ts';
/**
 * UC-03 Phase 3 - Controlled Repository Tools Unit Tests (Slice A of T007)
 *
 * Owned path: tests/runtime/unit/repository-tools.test.ts
 * Feature: specs/001-verified-code-repair
 *
 * Tests the public read/list/search boundary of ControlledRepositoryTools:
 * - Traversal/absolute paths and link escapes fail closed with zero IO.
 * - Symlink and junction containment for files, ancestors, and directories.
 * - Protected files and embedded secrets are excluded/rejected.
 * - Stale revision detection, immediate pre-read TOCTOU recheck, and post-read drift revalidation.
 * - Required injected ExecutionGuard capability genuinely mediates effects (zero IO on denial).
 * - Missing guard/limits fail closed with zero IO.
 * - Explicit finite output/result bounds and SourceEvidence validation.
 * - Later mutation/execution methods remain fail-closed NOT_IMPLEMENTED.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ControlledRepositoryTools,
  ControlledRepositoryToolsV02,
  createRepositoryReceiverV02,
  containsProtectedContent,
  type TrustedFilesystemPort,
  type TrustedFilesystemEntry,
  type FileStat,
  type ExecutionGuardReadCapability,
  type GuardedReadOperation,
  type RepositoryReadLimits,
  type UnattemptedClaimClosureHandoffV02,
} from '../../../src/foundation/repository-tools.ts';
import {
  validateSourceEvidence,
  computeActionDigest,
  computeCanonicalSha256,
  type RunCommandAction,
  type ApplyPatchAction,
  type CheckDefinition,
  type CommandView,
} from '../../../src/contracts/foundation/uc03.ts';
import {
  computeDispatchClaimDigestV02,
  UC05_APPROVAL_SCHEMA_VERSION_V02,
  validateDispatchClaimV02,
} from '../../../src/contracts/approvals/contracts.ts';
import type { DispatchClaimV02 } from '../../../src/contracts/approvals/contracts.ts';
import { createApprovalControlV02 } from '../../../src/approvals/control.ts';
import type {
  RepositoryPortV02,
  RepositoryAdmissionContextV02,
  AdmissionContextV02,
  StatePortV02,
  AttemptReceiptV02,
  ExecutorIdentityV02,
  ClaimReceiptV02,
  AttemptOutcomeReceiptV02,
  AttemptReconciliationReceiptV02,
  RepositoryActionOutcomeReceiptV02,
  ClaimClosureReceiptV02,
  OutcomeRecordResultV02,
  ReconciliationResultV02,
  ClaimClosureResultV02,
  CommandViewV02,
  CommandFiniteBoundsV02,
  PatchFiniteBoundsV02,
} from '../../../src/contracts/foundation/uc03/ports-v02.ts';
import type { TaskState } from '../../../src/contracts/foundation/uc03/types.ts';
import type { JournalSnapshotV02 } from '../../../src/approvals/control-v02.ts';
import {
  createTestDiagnosticPatchAdmissionContextV02,
  createTestClaimClosureReceiptV02,
  createTestAdmissionTaskStateV02,
  createTestAdmissionTransitionContextsV02,
  createTestObservedReconciliationReceiptV02,
  createTestReconciliationValidationContextV02,
  createTestUncertainReconciliationReceiptV02,
  createTestRepositoryAdmissionContextV02,
  createTestRepositoryCommandAdmissionContextV02,
} from '../support/uc03/state-fixtures.ts';
import {
  DockerWorkspaceManager,
  StructuredCommandExecutor,
} from '../../../src/foundation/docker-workspace.ts';
import type {
  CanonicalRepositorySnapshot,
  ContainerExecutionOutput,
  DockerContainerPlan,
  DockerLifecycleController,
  MaterializeViewParams,
  StructuredExecutionResult,
} from '../../../src/foundation/docker-workspace.ts';

class RepositoryTestDockerController implements DockerLifecycleController {
  readonly provenance = 'mock' as const;
  private readonly volumes = new Set<string>();
  readonly executedPlans: DockerContainerPlan[] = [];
  snapshotRequests = 0;
  materializedViews = 0;
  snapshotToReturn?: CanonicalRepositorySnapshot;
  outputToReturn?: Partial<ContainerExecutionOutput>;
  executionFailure?: Error;

  async createVolume(id: string): Promise<void> { this.volumes.add(id); }
  async hasVolume(id: string): Promise<boolean> { return this.volumes.has(id); }
  async removeVolume(id: string): Promise<void> { this.volumes.delete(id); }

  async getCanonicalSnapshot(workspaceId: string): Promise<CanonicalRepositorySnapshot> {
    this.snapshotRequests += 1;
    if (!this.snapshotToReturn) throw new Error(`NO_SNAPSHOT_CONFIGURED: ${workspaceId}`);
    return this.snapshotToReturn;
  }

  async materializeView(params: MaterializeViewParams): Promise<void> { void params; this.materializedViews += 1; }

  async executeContainer(plan: DockerContainerPlan): Promise<ContainerExecutionOutput> {
    this.executedPlans.push(plan);
    if (this.executionFailure) throw this.executionFailure;
    return {
      exitCode: this.outputToReturn?.exitCode === undefined ? 0 : this.outputToReturn.exitCode,
      stdout: this.outputToReturn?.stdout ?? '',
      stderr: this.outputToReturn?.stderr ?? '',
      durationMs: this.outputToReturn?.durationMs ?? 50,
      timedOut: this.outputToReturn?.timedOut ?? false,
    };
  }
}

interface FakeFileRecord {
  readonly content: string;
  readonly isSymlink?: boolean | undefined;
  readonly linkTarget?: string | undefined;
  readonly realPath?: string | undefined;
}

class FakeHostFilesystemPort implements TrustedFilesystemPort {
  readonly provenance = 'mock' as const;
  private files = new Map<string, FakeFileRecord>();
  private currentRevision = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  // Spies
  statCalls: string[] = [];
  lstatCalls: string[] = [];
  realpathCalls: string[] = [];
  readDirCalls: string[] = [];
  readTextFileCalls: string[] = [];
  getRevisionCalls = 0;

  // Interceptors / hooks for simulating drift and resolution swapping
  onReadTextFile?: ((path: string) => Promise<void> | void) | undefined;
  onReadDir?: ((path: string) => Promise<void> | void) | undefined;
  onRealpath?: ((path: string) => string | undefined) | undefined;

  setFile(path: string, content: string, options?: { isSymlink?: boolean; linkTarget?: string; realPath?: string }): void {
    this.files.set(path, {
      content,
      isSymlink: options?.isSymlink ?? false,
      linkTarget: options?.linkTarget,
      realPath: options?.realPath ?? path,
    });
  }

  deleteFile(path: string): void {
    this.files.delete(path);
  }

  setRevision(rev: string): void {
    this.currentRevision = rev;
  }

  async stat(canonicalPath: string): Promise<FileStat> {
    this.statCalls.push(canonicalPath);
    if (canonicalPath === '' || canonicalPath === '.') {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0 };
    }
    const rec = this.files.get(canonicalPath);
    if (!rec) {
      const isDir = Array.from(this.files.keys()).some((k) => k.startsWith(`${canonicalPath}/`));
      if (isDir) {
        return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0 };
      }
      throw new Error(`ENOENT: no such file or directory, stat '${canonicalPath}'`);
    }
    return {
      isFile: !rec.isSymlink,
      isDirectory: false,
      isSymbolicLink: false,
      size: Buffer.byteLength(rec.content, 'utf-8'),
    };
  }

  async lstat(canonicalPath: string): Promise<FileStat> {
    this.lstatCalls.push(canonicalPath);
    if (canonicalPath === '' || canonicalPath === '.') {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0 };
    }
    const rec = this.files.get(canonicalPath);
    if (!rec) {
      const isDir = Array.from(this.files.keys()).some((k) => k.startsWith(`${canonicalPath}/`));
      if (isDir) {
        return { isFile: false, isDirectory: true, isSymbolicLink: false, size: 0 };
      }
      throw new Error(`ENOENT: no such file or directory, lstat '${canonicalPath}'`);
    }
    return {
      isFile: !rec.isSymlink,
      isDirectory: false,
      isSymbolicLink: rec.isSymlink ?? false,
      size: Buffer.byteLength(rec.content, 'utf-8'),
    };
  }

  async realpath(canonicalPath: string): Promise<string> {
    this.realpathCalls.push(canonicalPath);
    if (this.onRealpath) {
      const hooked = this.onRealpath(canonicalPath);
      if (hooked !== undefined) return hooked;
    }
    const rec = this.files.get(canonicalPath);
    if (rec?.realPath) return rec.realPath;

    // Component-level resolution through parent directory symlinks
    const segs = canonicalPath.split('/');
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join('/');
      const parentRec = this.files.get(parent);
      if (parentRec?.isSymlink && parentRec.realPath) {
        const rest = segs.slice(i).join('/');
        return `${parentRec.realPath}/${rest}`;
      }
    }

    return canonicalPath;
  }

  async readDir(canonicalPath: string): Promise<readonly TrustedFilesystemEntry[]> {
    this.readDirCalls.push(canonicalPath);
    if (this.onReadDir) {
      await this.onReadDir(canonicalPath);
    }
    const prefix = canonicalPath.length > 0 ? `${canonicalPath}/` : '';
    const entries = new Map<string, TrustedFilesystemEntry>();

    for (const [path, rec] of this.files.entries()) {
      if (prefix.length === 0 || path.startsWith(prefix)) {
        const sub = prefix.length === 0 ? path : path.slice(prefix.length);
        const seg = sub.split('/')[0];
        if (seg && !entries.has(seg)) {
          const isDir = sub.includes('/');
          entries.set(seg, {
            name: seg,
            isDirectory: isDir,
            isFile: !isDir && !rec.isSymlink,
            isSymbolicLink: !isDir && (rec.isSymlink ?? false),
          });
        }
      }
    }
    return Array.from(entries.values());
  }

  async readTextFile(canonicalPath: string, maxBytes?: number): Promise<string> {
    this.readTextFileCalls.push(canonicalPath);
    if (this.onReadTextFile) {
      await this.onReadTextFile(canonicalPath);
    }
    const rec = this.files.get(canonicalPath);
    if (!rec) {
      throw new Error(`ENOENT: no such file or directory, open '${canonicalPath}'`);
    }
    // Fixtures are already in memory; emulate rejection before returning content.
    if (maxBytes !== undefined && Buffer.byteLength(rec.content, 'utf-8') > maxBytes) {
      throw new Error('FILE_TOO_LARGE: Read exceeded byte limit');
    }
    return rec.content;
  }

  async getCurrentRevisionDigest(): Promise<string> {
    this.getRevisionCalls++;
    return this.currentRevision;
  }
}

class FakeGuardCapability implements ExecutionGuardReadCapability {
  readonly provenance = 'mock' as const;
  readonly capabilityId = 'cap-test-123';
  readonly workspaceId = 'ws-test';
  readonly taskId = 'task-test';

  allowOperations = true;
  denialReason = 'OPERATION_DENIED_BY_POLICY';
  mediatedOperations: GuardedReadOperation<unknown>[] = [];
  beforeExecute?: (() => Promise<void>) | undefined;

  async mediateRead<T>(operation: GuardedReadOperation<T>): Promise<T> {
    this.mediatedOperations.push(operation as GuardedReadOperation<unknown>);
    if (!this.allowOperations) {
      throw new Error(`GUARD_DENIED: ${this.denialReason}`);
    }
    await this.beforeExecute?.();
    return await operation.execute();
  }
}

function makeJournalSnapshot(overrides: Partial<JournalSnapshotV02> = {}): unknown {
  return {
    controlVersion: 2,
    epoch: 1,
    mode: 'runnable',
    holdRef: null,
    holdEventDigest: null,
    activeClaimId: null,
    activeAuthorityRef: null,
    claims: [],
    attempts: [],
    outcomes: [],
    reconciliations: [],
    closures: [],
    authorityPublications: [],
    controlEventRefs: [],
    fenceProofs: [],
    recoveryEvidencePredecessorReceiptIds: [],
    fencedIncarnations: [],
    ...overrides,
  };
}

class FakeTaskControlPortV02 {
  snapshot: unknown;

  constructor(snapshot: unknown = makeJournalSnapshot()) {
    this.snapshot = snapshot;
  }

  getJournalSnapshot(): unknown {
    return this.snapshot;
  }
}

describe('ControlledRepositoryTools (Slice T007-a)', () => {
  let fsPort: FakeHostFilesystemPort;
  let guard: FakeGuardCapability;
  const defaultLimits: RepositoryReadLimits = {
    maxExcerptBytes: 1024,
    maxResultCount: 20,
    maxFileSizeBytes: 1048576,
  };
  const validRevision = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    fsPort = new FakeHostFilesystemPort();
    fsPort.setFile('src/calc.py', 'def add(a, b):\n    return a + b\n');
    fsPort.setFile('tests/test_calc.py', 'from src.calc import add\ndef test_add():\n    assert add(1, 2) == 3\n');
    guard = new FakeGuardCapability();
  });

  describe('Initialization and dependency injection', () => {
    it('rejects missing guard capability with zero IO', () => {
      assert.throws(
        () =>
          new ControlledRepositoryTools({
            guardCapability: null as unknown as ExecutionGuardReadCapability,
            fsPort,
            limits: defaultLimits,
          }),
        /MISSING_GUARD_CAPABILITY/
      );
      assert.equal(fsPort.readTextFileCalls.length, 0);
      assert.equal(fsPort.statCalls.length, 0);
    });

    it('rejects missing filesystem port with zero IO', () => {
      assert.throws(
        () =>
          new ControlledRepositoryTools({
            guardCapability: guard,
            fsPort: null as unknown as TrustedFilesystemPort,
            limits: defaultLimits,
          }),
        /MISSING_FILESYSTEM_PORT/
      );
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });

    it('rejects missing or invalid limits with zero IO', () => {
      assert.throws(
        () =>
          new ControlledRepositoryTools({
            guardCapability: guard,
            fsPort,
            limits: null as unknown as RepositoryReadLimits,
          }),
        /MISSING_LIMITS/
      );
      assert.throws(
        () =>
          new ControlledRepositoryTools({
            guardCapability: guard,
            fsPort,
            limits: { maxExcerptBytes: -1, maxResultCount: 10 },
          }),
        /INVALID_LIMITS/
      );
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });

    it('adopts port provenance without fallback', () => {
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });
      assert.equal(tools.provenance, 'mock');
    });
  });

  describe('Path containment and traversal escapes (zero IO)', () => {
    it('rejects parent traversal in readFile with zero IO', async () => {
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(
        () => tools.readFile('../outside.py'),
        /WORKSPACE_ESCAPE/
      );
      await assert.rejects(
        () => tools.readFile('src/../../outside.py'),
        /WORKSPACE_ESCAPE/
      );
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });

    it('rejects absolute paths and backslashes in readFile with zero IO', async () => {
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(
        () => tools.readFile('/etc/passwd'),
        /WORKSPACE_ESCAPE/
      );
      await assert.rejects(
        () => tools.readFile('C:\\Windows\\system32'),
        /WORKSPACE_ESCAPE/
      );
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });

    it('rejects traversal in listDir with zero IO', async () => {
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(
        () => tools.listDir('../..'),
        /WORKSPACE_ESCAPE/
      );
      assert.equal(fsPort.readDirCalls.length, 0);
    });
  });

  describe('Symlink and junction containment', () => {
    it('rejects symlink pointing outside repository root', async () => {
      fsPort.setFile('symlink_outside.py', '', {
        isSymlink: true,
        linkTarget: '../../etc/passwd',
        realPath: '/outside/etc/passwd',
      });

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(
        () => tools.readFile('symlink_outside.py'),
        /WORKSPACE_ESCAPE/
      );
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });

    it('rejects symlink pointing to a protected file inside repository', async () => {
      fsPort.setFile('.env', 'API_KEY=12345');
      fsPort.setFile('symlink_env.py', '', {
        isSymlink: true,
        linkTarget: '.env',
        realPath: '.env',
      });

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(
        () => tools.readFile('symlink_env.py'),
        /FORBIDDEN_LINK_TARGET|PROTECTED_PATH_FORBIDDEN/
      );
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });

    it('rejects regular leaf under symlink parent escaping workspace with zero read IO', async () => {
      fsPort.setFile('linked-parent', '', {
        isSymlink: true,
        linkTarget: '/outside/directory',
        realPath: '/outside/directory',
      });
      fsPort.setFile('linked-parent/source.py', 'secret_content = 42');

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(
        () => tools.readFile('linked-parent/source.py'),
        /WORKSPACE_ESCAPE/
      );
      assert.equal(fsPort.readTextFileCalls.includes('linked-parent/source.py'), false);
    });

    it('rejects regular leaf under symlink parent pointing to protected path with zero read IO', async () => {
      fsPort.setFile('linked-git', '', {
        isSymlink: true,
        linkTarget: '.git',
        realPath: '.git',
      });
      fsPort.setFile('linked-git/config', '[core]\nrepositoryformatversion = 0');

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(
        () => tools.readFile('linked-git/config'),
        /FORBIDDEN_LINK_TARGET|PROTECTED_PATH_FORBIDDEN/
      );
      assert.equal(fsPort.readTextFileCalls.includes('linked-git/config'), false);
    });

    it('excludes linked directory escape in searchCode and never reads dir or leaf', async () => {
      fsPort.setFile('src/calc.py', 'def target_fn(): return 1');
      fsPort.setFile('linked-escape', '', {
        isSymlink: true,
        linkTarget: '/outside/escape',
        realPath: '/outside/escape',
      });
      fsPort.setFile('linked-escape/evil.py', 'def target_fn(): return 666');

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      const results = await tools.searchCode('target_fn');
      assert.equal(results.length, 1);
      assert.equal(results[0]?.path, 'src/calc.py');
      assert.equal(fsPort.readDirCalls.includes('linked-escape'), false);
      assert.equal(fsPort.readTextFileCalls.includes('linked-escape/evil.py'), false);
    });

    it('avoids string-prefix containment bugs with workspaceRoot (root vs sibling)', async () => {
      fsPort.setFile('src/escape.py', 'escaped code', {
        realPath: '/workspace-sibling/escape.py',
      });
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        workspaceRoot: '/workspace',
      });

      await assert.rejects(
        () => tools.readFile('src/escape.py'),
        /WORKSPACE_ESCAPE/
      );
      assert.equal(fsPort.readTextFileCalls.includes('src/escape.py'), false);

      fsPort.setFile('src/valid.py', 'def valid(): return True', {
        realPath: '/workspace/src/valid.py',
      });
      const evidence = await tools.readFile('src/valid.py');
      assert.equal(evidence.path, 'src/valid.py');
    });
  });

  describe('Protected path and content exclusion', () => {
    it('rejects reading protected files with zero IO', async () => {
      fsPort.setFile('.env', 'SECRET=xyz');
      fsPort.setFile('.git/config', '[core]');
      fsPort.setFile('id_rsa', 'SSH KEY');
      fsPort.setFile('eval/uc03/private/secret.py', 'hidden grading');

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(() => tools.readFile('.env'), /PROTECTED_PATH_FORBIDDEN/);
      await assert.rejects(() => tools.readFile('.git/config'), /PROTECTED_PATH_FORBIDDEN/);
      await assert.rejects(() => tools.readFile('id_rsa'), /PROTECTED_PATH_FORBIDDEN/);
      await assert.rejects(() => tools.readFile('eval/uc03/private/secret.py'), /PROTECTED_PATH_FORBIDDEN/);

      assert.equal(fsPort.readTextFileCalls.length, 0);
    });

    it('rejects reading file with embedded secret markers', async () => {
      fsPort.setFile('src/secrets.py', 'API_KEY = "MARKER_SECRET_alpha123"');
      fsPort.setFile('src/api_client.py', 'key = "sk-12345678901234567890123"');

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(
        () => tools.readFile('src/secrets.py'),
        /PROTECTED_CONTENT_FORBIDDEN/
      );
      await assert.rejects(
        () => tools.readFile('src/api_client.py'),
        /PROTECTED_CONTENT_FORBIDDEN/
      );
    });

    it('filters protected paths from listDir results', async () => {
      fsPort.setFile('.env', 'SECRET=1');
      fsPort.setFile('.git/HEAD', 'ref: refs/heads/main');
      fsPort.setFile('src/index.py', 'print(1)');

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      const entries = await tools.listDir('');
      assert.ok(!entries.includes('.env'));
      assert.ok(!entries.includes('.git'));
      assert.ok(entries.includes('src'));
    });

    it('rejects listing protected directories with zero IO', async () => {
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(() => tools.listDir('.git'), /PROTECTED_PATH_FORBIDDEN/);
      assert.equal(fsPort.readDirCalls.length, 0);
    });
  });

  describe('ExecutionGuard genuine mediation', () => {
    it('genuinely mediates readFile and produces zero IO on guard denial', async () => {
      guard.allowOperations = false;
      guard.denialReason = 'BUDGET_EXHAUSTED';

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(
        () => tools.readFile('src/calc.py'),
        /GUARD_DENIED: BUDGET_EXHAUSTED/
      );
      assert.equal(guard.mediatedOperations.length, 1);
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });

    it('genuinely mediates listDir and produces zero IO on guard denial', async () => {
      guard.allowOperations = false;

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(
        () => tools.listDir('src'),
        /GUARD_DENIED/
      );
      assert.equal(guard.mediatedOperations.length, 1);
      assert.equal(fsPort.readDirCalls.length, 0);
    });

    it('genuinely mediates searchCode and produces zero IO on guard denial', async () => {
      guard.allowOperations = false;

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(
        () => tools.searchCode('def add'),
        /GUARD_DENIED/
      );
      assert.equal(guard.mediatedOperations.length, 1);
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });
  });

  describe('Revision freshness, drift revalidation, and TOCTOU protection', () => {
    it('rejects readFile when initial revision is stale', async () => {
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        expectedRevisionDigest: validRevision,
      });

      fsPort.setRevision('sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210');

      await assert.rejects(
        () => tools.readFile('src/calc.py'),
        /STALE_REVISION/
      );
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });

    it('detects file disappearance on immediate pre-read recheck', async () => {
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(
        () => tools.readFile('src/non_existent.py'),
        /FILE_NOT_FOUND|ENOENT/
      );
    });

    it('rejects an in-workspace path swap before readFile performs IO', async () => {
      fsPort.setFile('src/flapping.py', 'initial safe content', { realPath: '/workspace/src/flapping.py' });
      let realpathCount = 0;
      fsPort.onRealpath = (p) => {
        if (p === 'src/flapping.py') {
          realpathCount++;
          if (realpathCount === 2) {
            return '/workspace/src/swapped.py';
          }
        }
        return undefined;
      };

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        workspaceRoot: '/workspace',
      });

      await assert.rejects(
        () => tools.readFile('src/flapping.py'),
        /TOCTOU_RESOLUTION_SWAP/
      );
      assert.equal(realpathCount, 2);
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });

    it('rejects readFile and leaks no evidence when revision mutates during awaited readTextFile', async () => {
      fsPort.setFile('src/calc.py', 'def add(a, b): return a + b');
      fsPort.onReadTextFile = () => {
        fsPort.setRevision('sha256:mutated-during-read-text-file');
      };

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        expectedRevisionDigest: validRevision,
      });

      await assert.rejects(
        () => tools.readFile('src/calc.py'),
        /REVISION_DRIFT/
      );
    });

    it('rejects listDir when revision mutates during awaited readDir', async () => {
      fsPort.onReadDir = () => {
        fsPort.setRevision('sha256:mutated-during-read-dir');
      };

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        expectedRevisionDigest: validRevision,
      });

      await assert.rejects(
        () => tools.listDir('src'),
        /REVISION_DRIFT/
      );
    });

    it('rejects searchCode and leaks no results when revision mutates during search execution', async () => {
      fsPort.setFile('src/calc.py', 'def search_target(): return 1');
      fsPort.setFile('src/other.py', 'def search_target(): return 2');
      let readCount = 0;
      fsPort.onReadTextFile = () => {
        readCount++;
        if (readCount >= 2) {
          fsPort.setRevision('sha256:drifted-revision-during-search');
        }
      };

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        expectedRevisionDigest: validRevision,
      });

      await assert.rejects(
        () => tools.searchCode('search_target'),
        /REVISION_DRIFT/
      );
    });
  });

  describe('Approved bounded excerpts and output limits', () => {
    it('returns validated SourceEvidence with current digest and bounded excerpt', async () => {
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        expectedRevisionDigest: validRevision,
      });

      const evidence = await tools.readFile('src/calc.py');
      assert.equal(evidence.path, 'src/calc.py');
      assert.equal(evidence.revisionDigest, validRevision);
      assert.equal(evidence.truncated, false);
      assert.equal(evidence.resultCount, 1);
      assert.ok(evidence.boundedExcerpt.includes('def add'));

      const validation = validateSourceEvidence(evidence, defaultLimits);
      assert.equal(validation.ok, true);
    });

    it('truncates oversized file content to maxExcerptBytes', async () => {
      const largeContent = 'A'.repeat(500);
      fsPort.setFile('src/large.py', largeContent);

      const tinyLimit: RepositoryReadLimits = {
        maxExcerptBytes: 100,
        maxResultCount: 10,
      };

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: tinyLimit,
        expectedRevisionDigest: validRevision,
      });

      const evidence = await tools.readFile('src/large.py');
      assert.equal(evidence.truncated, true);
      assert.ok(Buffer.byteLength(evidence.boundedExcerpt, 'utf-8') <= 100);

      const validation = validateSourceEvidence(evidence, tinyLimit);
      assert.equal(validation.ok, true);
    });

    it('truncates UTF-8 excerpts at code point boundaries within the byte limit', async () => {
      fsPort.setFile('src/utf8.py', '🙂中A');
      const tinyLimit: RepositoryReadLimits = { maxExcerptBytes: 6, maxResultCount: 10 };
      const tools = new ControlledRepositoryTools({ guardCapability: guard, fsPort, limits: tinyLimit });

      const evidence = await tools.readFile('src/utf8.py');

      assert.equal(evidence.boundedExcerpt, '🙂');
      assert.equal(evidence.truncated, true);
      assert.ok(Buffer.byteLength(evidence.boundedExcerpt, 'utf-8') <= tinyLimit.maxExcerptBytes);
      assert.equal(evidence.boundedExcerpt.includes('\uFFFD'), false);
      assert.equal(validateSourceEvidence(evidence, tinyLimit).ok, true);
    });

    it('skips files over maxFileSizeBytes before reading during searchCode', async () => {
      fsPort.setFile('src/oversized.py', 'target_query exceeds limit');
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: { maxExcerptBytes: 100, maxResultCount: 10, maxFileSizeBytes: 8 },
      });

      const results = await tools.searchCode('target_query');

      assert.equal(results.length, 0);
      assert.equal(fsPort.readTextFileCalls.includes('src/oversized.py'), false);
      assert.ok(fsPort.statCalls.includes('src/oversized.py'));
    });

    it('skips a file that grows beyond maxFileSizeBytes after stat during searchCode', async () => {
      fsPort.setFile('src/growing.py', 'target');
      fsPort.setFile('src/within-limit.py', 'target');
      fsPort.onReadTextFile = (path) => {
        if (path === 'src/growing.py') fsPort.setFile(path, 'target grows past the limit');
      };
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: { maxExcerptBytes: 100, maxResultCount: 10, maxFileSizeBytes: 8 },
      });

      const results = await tools.searchCode('target');

      assert.deepEqual(results.map((result) => result.path), ['src/within-limit.py']);
      assert.ok(fsPort.readTextFileCalls.includes('src/growing.py'));
    });

    it('rejects readFile when UTF-8 content grows beyond maxFileSizeBytes after stat', async () => {
      fsPort.setFile('src/growing.py', '中');
      fsPort.onReadTextFile = (path) => {
        if (path === 'src/growing.py') fsPort.setFile(path, '中文');
      };
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: { maxExcerptBytes: 100, maxResultCount: 10, maxFileSizeBytes: 4 },
      });

      await assert.rejects(() => tools.readFile('src/growing.py'), /FILE_TOO_LARGE/);
      assert.ok(fsPort.readTextFileCalls.includes('src/growing.py'));
    });

    it('admits UTF-8 content exactly at maxFileSizeBytes for readFile and searchCode', async () => {
      fsPort.setFile('src/exact.py', '🙂');
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: { maxExcerptBytes: 100, maxResultCount: 10, maxFileSizeBytes: 4 },
      });

      assert.equal((await tools.readFile('src/exact.py')).boundedExcerpt, '🙂');
      assert.deepEqual((await tools.searchCode('🙂')).map((result) => result.path), ['src/exact.py']);
    });

    it('limits searchCode results to maxResultCount and excludes protected files/secrets', async () => {
      fsPort.setFile('src/a.py', 'target_query line 1');
      fsPort.setFile('src/b.py', 'target_query line 2');
      fsPort.setFile('src/secret.py', 'target_query with MARKER_SECRET_999');
      fsPort.setFile('.env', 'target_query in env');

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: { maxExcerptBytes: 1000, maxResultCount: 1 },
      });

      const results = await tools.searchCode('target_query');
      assert.equal(results.length, 1);
      assert.ok(results[0]?.path === 'src/a.py' || results[0]?.path === 'src/b.py');
      assert.ok(!results.some((r) => r.path === '.env' || r.path === 'src/secret.py'));

      for (const res of results) {
        const valid = validateSourceEvidence(res);
        assert.equal(valid.ok, true);
      }
    });

    it('bounds listDir results to maxResultCount', async () => {
      fsPort.setFile('src/f1.py', '');
      fsPort.setFile('src/f2.py', '');
      fsPort.setFile('src/f3.py', '');

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: { maxExcerptBytes: 1000, maxResultCount: 2 },
      });

      const list = await tools.listDir('src');
      assert.equal(list.length, 2);
    });
  });

  describe('Fail-closed methods for later slices', () => {
    it('fails closed on applyPatch/runCommand/runTests/inspectDiff', async () => {
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });

      await assert.rejects(() => tools.applyPatch({} as never), /NOT_IMPLEMENTED/);
      await assert.rejects(() => tools.runCommand({} as never), /NOT_IMPLEMENTED/);
      await assert.rejects(() => tools.runTests({} as never), /NOT_IMPLEMENTED/);
      await assert.rejects(() => tools.inspectDiff('base-rev'), /NOT_IMPLEMENTED/);
    });
  });

  describe('containsProtectedContent helper', () => {
    it('detects embedded secrets and permits clean code', () => {
      assert.equal(containsProtectedContent('MARKER_SECRET_xyz'), true);
      assert.equal(containsProtectedContent('const key = "-----BEGIN RSA PRIVATE KEY-----"'), true);
      assert.equal(containsProtectedContent('Authorization: Bearer my-access-token-12345'), true);
      assert.equal(containsProtectedContent('def add(a, b): return a + b'), false);
    });
  });
});

/* ------------------------------------------------------------------
 * UC-03 v0.2.0 Repository Receiver Unit Tests (T049/T050)
 * ------------------------------------------------------------------ */

class FakeStatePortV02 implements StatePortV02 {
  readonly provenance = 'mock' as const;
  claimCalls: AdmissionContextV02[] = [];
  claimReceipts: ClaimReceiptV02[] = [];
  private readonly patchClaimIds = new Set<string>();
  beginAttemptCalls: { claimId: string; executor: ExecutorIdentityV02 }[] = [];
  attemptReceipts: AttemptReceiptV02[] = [];
  outcomeReceipts: AttemptOutcomeReceiptV02[] = [];
  observedReconciliations: AttemptReconciliationReceiptV02[] = [];
  uncertainReconciliations: AttemptReconciliationReceiptV02[] = [];
  recordOutcomeHandler?: ((receipt: AttemptOutcomeReceiptV02) => Promise<OutcomeRecordResultV02>) | undefined;
  observedReconciliationHandler?: ((receipt: AttemptReconciliationReceiptV02) => Promise<ReconciliationResultV02>) | undefined;
  uncertainReconciliationHandler?: ((receipt: AttemptReconciliationReceiptV02) => Promise<ReconciliationResultV02>) | undefined;
  attemptToReturn?: AttemptReceiptV02;
  beforeBeginAttempt?: (() => Promise<void>) | undefined;

  async beginAttempt(claimId: string, executor: ExecutorIdentityV02): Promise<AttemptReceiptV02> {
    this.beginAttemptCalls.push({ claimId, executor });
    await this.beforeBeginAttempt?.();
    if (this.attemptToReturn) {
      this.attemptReceipts.push(this.attemptToReturn);
      return this.attemptToReturn;
    }
    const isPatch = this.patchClaimIds.has(claimId);
    const receipt: AttemptReceiptV02 = {
      attemptId: `att-${claimId}`,
      claimId,
      taskId: 'task-test-1',
      executorIdentity: executor,
      preAttemptTaskStateVersion: 1,
      postBeginTaskStateVersion: isPatch ? 2 : 1,
      preAttemptControlVersion: 2,
      postBeginControlVersion: 3,
      epoch: 1,
      status: 'attempting',
    };
    this.attemptReceipts.push(receipt);
    return receipt;
  }

  async loadTask(taskId: string): Promise<TaskState | null> { void taskId; return null; }
  async transition(state: TaskState, expectedVersion: number): Promise<TaskState> { void expectedVersion; return state; }
  async claim(context: AdmissionContextV02): Promise<ClaimReceiptV02> {
    if (context.subjectKind !== 'repository-action' ||
      (context.action.kind !== 'apply_patch' && context.action.kind !== 'run_command')) {
      throw new Error('unsupported repository action');
    }
    this.claimCalls.push(context);
    const claimId = `claim-${context.action.actionId}`;
    if (context.action.kind === 'apply_patch') this.patchClaimIds.add(claimId);
    const unsigned = {
      claimId,
      claimDigest: '',
      taskId: context.taskId,
      runId: context.runId,
      subjectKind: context.subjectKind,
      planApplicability: context.planApplicability,
      preClaimTaskStateVersion: context.expectedTaskStateVersion,
      preClaimControlVersion: context.expectedControlVersion,
      postClaimControlVersion: context.expectedControlVersion + 1,
      epoch: context.expectedEpoch,
      status: 'claimed' as const,
      reservationRefs: [...context.reservationRefs],
    };
    const receipt = { ...unsigned, claimDigest: computeCanonicalSha256({ ...unsigned, claimDigest: undefined }) };
    this.claimReceipts.push(receipt);
    return receipt;
  }
  async recordOutcome(receipt: AttemptOutcomeReceiptV02): Promise<OutcomeRecordResultV02> {
    this.outcomeReceipts.push(receipt);
    return await (this.recordOutcomeHandler?.(receipt) ?? Promise.resolve({ outcome: 'settled', receiptId: receipt.receiptId }));
  }
  async reconcileObservedOutcome(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    this.observedReconciliations.push(receipt);
    if (!this.observedReconciliationHandler) throw new Error('not implemented');
    return await this.observedReconciliationHandler(receipt);
  }
  async reconcileUncertain(receipt: AttemptReconciliationReceiptV02): Promise<ReconciliationResultV02> {
    this.uncertainReconciliations.push(receipt);
    if (!this.uncertainReconciliationHandler) throw new Error('not implemented');
    return await this.uncertainReconciliationHandler(receipt);
  }
  async closeUnattemptedClaim(receipt: ClaimClosureReceiptV02): Promise<ClaimClosureResultV02> { void receipt; throw new Error('not implemented'); }
  async checkpoint(state: TaskState): Promise<void> { void state; }
  async recover(taskId: string): Promise<TaskState> { void taskId; throw new Error('not implemented'); }
}

interface TestAdmissionOverrides {
  readonly action?: RunCommandAction | ApplyPatchAction;
  readonly actionDigest?: string;
  readonly commandView?: CommandViewV02;
  readonly commandBounds?: CommandFiniteBoundsV02;
  readonly patchBounds?: PatchFiniteBoundsV02;
  readonly baseRevision?: string;
  readonly targetPaths?: readonly string[];
  readonly patchDigest?: string;
  readonly checkId?: string;
}

function createTestAdmissionContext(overrides: TestAdmissionOverrides = {}): RepositoryAdmissionContextV02 {
  const action = overrides.action ?? {
    actionId: 'act-cmd-1',
    kind: 'run_command',
    executable: 'pytest',
    argv: ['-q'],
    workingDirectory: '/workspace/repo',
  };
  const actionDigest = overrides.actionDigest ?? computeActionDigest(action);
  const canonicalRevision = action.kind === 'apply_patch'
    ? (overrides.baseRevision ?? action.baseRevisionDigest)
    : 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const common = {
      schemaVersion: '0.2.0' as const,
    subjectKind: 'repository-action' as const,
    taskStateSchemaVersion: 'uc03-task-state/0.1',
    expectedTaskStateVersion: 1,
    controlSchemaVersion: 'uc04-task-control/0.1',
    expectedControlVersion: 1,
    expectedEpoch: 1,
    taskId: 'task-test-1',
    runId: 'run-1',
    workspaceId: 'ws-test-1',
    repositoryId: 'repo-1',
    runnableNode: action.kind === 'apply_patch' ? 'Repair' : 'Investigate',
    canonicalRevision,
    executionProfileId: 'profile-uc03-test',
    action,
    actionDigest,
    policyAuthorityRef: {
      policyId: 'policy-1',
      policyVersion: '1',
      configId: 'config-1',
      configVersion: '1',
      issuerKeyRef: 'key-1',
      decisionAuthorityGeneration: 1,
    },
    policyEvaluationReceipt: {
      receiptId: 'rec-eval-1',
      receiptDigest: 'sha256:eval1',
      actionDigest,
      freshnessContextDigest: 'sha256:fresh1',
      policyId: 'policy-1',
      policyVersion: '1',
      configId: 'config-1',
      configVersion: '1',
      decisionAuthorityGeneration: 1,
      result: 'ALLOWED' as const,
    },
    reservationRefs: ['res-1'],
  };

  if (action.kind === 'apply_patch') {
    return {
      ...common,
      planApplicability: 'approved-plan',
      planBindingDigest: 'sha256:plan-binding-1',
      planDecisionRef: 'plan-decision-1',
      baseRevision: overrides.baseRevision ?? action.baseRevisionDigest,
      targetPaths: overrides.targetPaths ?? action.targetPaths,
      patchDigest: overrides.patchDigest ?? computeCanonicalSha256(action.patchContent),
      finiteBounds: overrides.patchBounds ?? { maxPatchBytes: 65536, maxChangedPaths: 5 },
    };
  }

  return {
    ...common,
    planApplicability: 'pre-plan-diagnostic',
    diagnosticPurpose: 'test repro',
    taskCriteriaDigest: 'sha256:crit1',
    checkSetDigest: 'sha256:set1',
    ...(overrides.checkId ? { checkId: overrides.checkId } : {}),
    commandView: overrides.commandView ?? {
      viewId: 'view-test-1',
      viewDigest: 'sha256:view-test-1',
      taskId: 'task-test-1',
      workspaceId: 'ws-test-1',
      canonicalRevision,
      admittedFiles: [],
      exclusionsPolicyVersion: '0.1.0',
      scratchIdentity: 'scratch-1',
      mountedReadOnly: true,
      isolationProfileRef: 'profile-uc03-test',
    },
    finiteBounds: overrides.commandBounds ?? {
      timeoutMs: 30000,
      maxOutputBytes: 65536,
      maxCpuSeconds: 10,
      maxMemoryBytes: 536870912,
      maxProcessCount: 5,
      isolationProfileRef: 'profile-uc03-test',
    },
  };
}

function createJournalBackedPatchContext(patch: ApplyPatchAction): RepositoryAdmissionContextV02 {
  return createTestRepositoryAdmissionContextV02({
    taskId: 'task-test-1',
    runId: 'run-1',
    workspaceId: 'ws-test-1',
    repositoryId: 'repo-1',
    canonicalRevision: patch.baseRevisionDigest,
    executionProfileId: 'profile-uc03-test',
    action: patch,
    actionDigest: computeActionDigest(patch),
    baseRevision: patch.baseRevisionDigest,
    targetPaths: [...patch.targetPaths],
    patchDigest: computeCanonicalSha256(patch.patchContent),
  });
}

function createTestPatchRecoveryHandoff() {
  return {
    async prepare(input: {
      readonly admission: RepositoryAdmissionContextV02;
      readonly claim: ClaimReceiptV02;
      readonly attempt: AttemptReceiptV02;
      readonly outcome: RepositoryActionOutcomeReceiptV02;
    }) {
      const receipt = input.outcome.outcome === 'observed'
        ? createTestObservedReconciliationReceiptV02(
            input.outcome,
            input.claim,
            input.attempt,
            input.admission,
            { expectedCurrentControlVersion: input.attempt.postBeginControlVersion + 1 },
          )
        : createTestUncertainReconciliationReceiptV02(
            input.outcome,
            input.claim,
            input.attempt,
            input.admission,
            { disposition: 'proven-not-dispatched' },
          );
      return {
        receipt,
        validationContext: createTestReconciliationValidationContextV02(
          receipt,
          input.outcome,
          input.claim,
          input.attempt,
          input.admission,
        ),
      };
    },
  };
}

interface TestRepositoryRecoveryBehavior {
  failNextPrepare?: boolean;
  conflictNextPrepare?: boolean;
}

function captureJournalAttempts(journal: MemoryStatePortV02, attempts: AttemptReceiptV02[]): void {
  const begin = journal.beginAttempt.bind(journal);
  journal.beginAttempt = async (claimId, executor) => {
    const attempt = await begin(claimId, executor);
    attempts.push(attempt);
    return attempt;
  };
}

function createJournalBackedAttemptStartRecoveryHandoff(
  journal: MemoryStatePortV02,
  attempts: readonly AttemptReceiptV02[],
) {
  return {
    async queryAttemptStart(request: {
      readonly recoveryId: string;
      readonly admission: RepositoryAdmissionContextV02;
      readonly claim: ClaimReceiptV02;
      readonly executorIdentity: ExecutorIdentityV02;
    }): Promise<unknown> {
      const snapshot = journal.getJournalSnapshot();
      const committed = attempts.find((attempt) => attempt.claimId === request.claim.claimId);
      if (committed && snapshot.attempts.some((attempt) =>
        attempt.claimId === request.claim.claimId && attempt.attemptId === committed.attemptId)) {
        return { outcome: 'committed', attempt: committed };
      }
      const claimState = snapshot.claims.find((claim) => claim.claimId === request.claim.claimId);
      if (!claimState || claimState.status !== 'claimed' || claimState.attemptId !== null ||
        snapshot.activeClaimId !== request.claim.claimId) return { outcome: 'unknown' };
      const eventRef = `attempt-start-${request.claim.claimId}`;
      if (!await journal.setTaskControl(request.admission.taskId, 'paused', eventRef)) return { outcome: 'unknown' };
      const fence = await journal.fenceClaimRecipient(request.claim.claimId, request.executorIdentity);
      if (!fence) return { outcome: 'unknown' };
      return {
        outcome: 'unattempted',
        claim: { ...request.claim, hasCommittedAttempt: false },
        closureReceipt: createTestClaimClosureReceiptV02(request.claim, fence.fencedExecutorIdentity, { reason: eventRef }),
      };
    },
  };
}

function createUnknownAttemptStartRecoveryHandoff() {
  return { async queryAttemptStart(): Promise<unknown> { return { outcome: 'unknown' }; } };
}

async function getAttemptStartRecoveryId(operation: () => Promise<unknown>): Promise<string> {
  const error = await operation().then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof Error, 'Attempt start should surface a pending recovery error');
  assert.equal(error.name, 'RepositoryAttemptStartPendingError');
  const recoveryId = (error as Error & { readonly recoveryId?: unknown }).recoveryId;
  assert.equal(typeof recoveryId, 'string', 'Pending error exposes the safe recovery identity');
  assert.match(recoveryId as string, /^attempt-start:/u);
  return recoveryId as string;
}

function createRefusingClaimClosureHandoff(): UnattemptedClaimClosureHandoffV02 {
  return { async closeUnattemptedClaim() { return { closed: false, receiptId: '' }; } };
}

function createUnavailableRecoveryHandoff() {
  return { async prepare() { throw new Error('NO_TRUSTED_RECOVERY_EVIDENCE'); } };
}

function createJournalBackedClaimClosureHandoff(journal: MemoryStatePortV02): UnattemptedClaimClosureHandoffV02 {
  return {
    async closeUnattemptedClaim({ admission, claim, recipientIdentity }) {
      const eventRef = `pause-${claim.claimId}`;
      if (!await journal.setTaskControl(admission.taskId, 'paused', eventRef)) return { closed: false, receiptId: '' };
      const snapshot = journal.getJournalSnapshot();
      if (!snapshot.holdEventDigest) return { closed: false, receiptId: '' };
      const result = await createApprovalControlV02({ taskId: admission.taskId, journal }).closeUnattemptedClaim({
        claim: createDispatchClaimForClosure(admission, claim),
        journalClaim: claim,
        recipientIdentity,
        pauseOrDenialEvent: { eventKind: 'pause', eventRef, eventDigest: snapshot.holdEventDigest },
      });
      return { closed: result.closed, receiptId: result.receipt?.receiptId ?? '' };
    },
  };
}

function createDispatchClaimForClosure(
  context: RepositoryAdmissionContextV02,
  journalClaim: ClaimReceiptV02,
): DispatchClaimV02 {
  const authority = context.policyAuthorityRef;
  const planFields = context.planApplicability === 'approved-plan'
    ? { planApplicability: context.planApplicability, planBindingDigest: context.planBindingDigest, planDecisionRef: context.planDecisionRef }
    : { planApplicability: context.planApplicability, diagnosticPurpose: context.diagnosticPurpose, taskCriteriaDigest: context.taskCriteriaDigest };
  const unsigned = {
    schemaVersion: UC05_APPROVAL_SCHEMA_VERSION_V02,
    claimId: journalClaim.claimId,
    claimDigest: '',
    taskId: journalClaim.taskId,
    runId: journalClaim.runId,
    taskStateSchemaVersion: context.taskStateSchemaVersion,
    expectedTaskStateVersion: journalClaim.preClaimTaskStateVersion,
    controlSchemaVersion: context.controlSchemaVersion,
    expectedControlVersion: journalClaim.preClaimControlVersion,
    expectedEpoch: journalClaim.epoch,
    policyIdentity: {
      policyId: authority.policyId,
      policyVersion: authority.policyVersion,
      configId: authority.configId,
      configVersion: authority.configVersion,
    },
    decisionRefs: context.actionDecisionReceipt
      ? [context.actionDecisionReceipt.decisionId]
      : [context.planDecisionRef ?? context.policyEvaluationReceipt.receiptId],
    reservationRefs: [...journalClaim.reservationRefs],
    phase: 'claimed' as const,
    resultRef: null,
    subjectKind: 'repository-action' as const,
    actionId: context.action.actionId,
    actionDigest: context.actionDigest,
    repositoryStateDigest: context.canonicalRevision,
    ...planFields,
  };
  const candidate = { ...unsigned, claimDigest: computeDispatchClaimDigestV02(unsigned) };
  const result = validateDispatchClaimV02(candidate);
  if (!result.ok) throw new Error('test-journal-dispatch-claim-invalid');
  return result.value;
}

function createJournalBackedRecoveryHandoff(
  journal: MemoryStatePortV02,
  behavior?: TestRepositoryRecoveryBehavior,
) {
  return {
    async prepare(input: {
      readonly admission: RepositoryAdmissionContextV02;
      readonly claim: ClaimReceiptV02;
      readonly attempt: AttemptReceiptV02;
      readonly outcome: RepositoryActionOutcomeReceiptV02;
    }) {
      if (input.outcome.outcome !== 'uncertain') throw new Error('unexpected-observed-recovery');
      if (behavior?.failNextPrepare) {
        behavior.failNextPrepare = false;
        throw new Error('trusted owner has not produced settled recovery evidence');
      }
      const eventRef = `pause-attempt-${input.attempt.attemptId}`;
      if (!await journal.setTaskControl(input.admission.taskId, 'paused', eventRef)) throw new Error('journal-pause-failed');
      const fence = await journal.fenceAttemptRecipient(input.claim.claimId, input.attempt.executorIdentity);
      if (!fence) throw new Error('journal-attempt-fence-failed');
      const snapshot = journal.getJournalSnapshot();
      const task = await journal.loadTask(input.admission.taskId);
      if (!task) throw new Error('journal-task-missing');
      const receipt = createTestUncertainReconciliationReceiptV02(
        input.outcome,
        input.claim,
        input.attempt,
        input.admission,
        {
          disposition: 'proven-not-dispatched',
          expectedCurrentTaskStateVersion: task.stateVersion,
          expectedCurrentControlVersion: snapshot.controlVersion + (behavior?.conflictNextPrepare ? 1 : 0),
          expectedCurrentEpoch: snapshot.epoch,
          adapterEvidenceRefs: fence.adapterEvidenceRefs,
          fencedRecipientIdentity: fence.recipientIdentity,
          fencingGeneration: fence.fencingGeneration,
          fencingProof: fence.proofRef,
          evidenceRefs: [...fence.adapterEvidenceRefs, fence.proofRef],
        },
      );
      return {
        receipt,
        validationContext: createTestReconciliationValidationContextV02(
          receipt,
          input.outcome,
          input.claim,
          input.attempt,
          input.admission,
        ),
      };
    },
  };
}

function createJournalForRepositoryAdmission(context: RepositoryAdmissionContextV02): MemoryStatePortV02 {
  const initialTaskState = createTestAdmissionTaskStateV02(context);
  return new MemoryStatePortV02({
    initialTaskState,
    transitionContexts: createTestAdmissionTransitionContextsV02(context, initialTaskState),
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
    initialAuthorityRef: context.policyAuthorityRef,
  });
}

function createJournalForRepositoryCommand(context: RepositoryAdmissionContextV02): MemoryStatePortV02 {
  if (context.action.kind !== 'run_command' || !context.finiteBounds) throw new Error('command-admission-required');
  const bounds = context.finiteBounds as CommandFiniteBoundsV02;
  const task = createTestAdmissionTaskStateV02(context);
  const resourceKinds = ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'] as const;
  const resourceLedgers = (['task', 'run'] as const).flatMap((scope) => resourceKinds.map((kind) => {
    const amount = bounds[kind];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw new Error(`missing-command-bound:${kind}`);
    return {
      scope,
      kind,
      limit: amount * 2,
      consumed: 0,
      reservations: [],
      unit: kind === 'maxMemoryBytes' ? 'bytes' : 'count',
      configurationId: context.policyAuthorityRef.configId,
      version: 1,
    };
  }));
  const initialTaskState = { ...task, budgetLedgers: [...(task.budgetLedgers ?? []), ...resourceLedgers] };
  return new MemoryStatePortV02({
    initialTaskState,
    transitionContexts: createTestAdmissionTransitionContextsV02(context, initialTaskState),
    initialControlVersion: context.expectedControlVersion,
    initialEpoch: context.expectedEpoch,
    initialAuthorityRef: context.policyAuthorityRef,
  });
}

describe('ControlledRepositoryTools v0.2 Receiver (T049/T050)', () => {
  const defaultLimits: RepositoryReadLimits = {
    maxExcerptBytes: 4096,
    maxResultCount: 50,
  };
  let fsPort: FakeHostFilesystemPort;
  let guard: FakeGuardCapability;
  let statePort: FakeStatePortV02;
  const canonicalRev = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(() => {
    fsPort = new FakeHostFilesystemPort();
    fsPort.setRevision(canonicalRev);
    guard = new FakeGuardCapability();
    statePort = new FakeStatePortV02();
  });

  async function createWorkspaceManager(): Promise<{ readonly manager: DockerWorkspaceManager; readonly controller: RepositoryTestDockerController }> {
    const controller = new RepositoryTestDockerController();
    const manager = new DockerWorkspaceManager({ controller });
    await manager.createWorkspace({
      taskId: 'task-test-1',
      workspaceId: 'ws-test-1',
      initialRevisionDigest: canonicalRev,
      profile: {
        profileId: 'profile-uc03-test',
        image: 'ghcr.io/test:0.1',
        imageDigest: canonicalRev,
        user: '1000:1000',
        readOnlyRootFilesystem: true,
        network: 'none',
        limits: { timeoutMs: 30000, maxMemoryBytes: 2147483648, maxCpuCores: 2, maxPids: 256 },
        mounts: [],
      },
    });
    return { manager, controller };
  }

  async function createJournalBackedCommandHarness(actionId: string, useTrustedRecovery = false) {
    const action: RunCommandAction = {
      actionId,
      kind: 'run_command',
      executable: 'pytest',
      argv: ['-q'],
      workingDirectory: '/workspace/repo',
    };
    const { manager, controller } = await createWorkspaceManager();
    fsPort.setFile('src/app.py', 'test');
    const reservationRefs = (['task', 'run'] as const).flatMap((scope) =>
      (['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'] as const)
        .map((kind) => `res-${actionId}-${scope}-${kind}`));
    const baseContext = createTestRepositoryCommandAdmissionContextV02({
      taskId: 'task-test-1',
      runId: 'run-1',
      workspaceId: 'ws-test-1',
      repositoryId: 'repo-1',
      canonicalRevision: canonicalRev,
      executionProfileId: 'profile-uc03-test',
      action,
      actionDigest: computeActionDigest(action),
      checkId: `chk-${actionId}`,
      reservationRefs,
    });
    const commandView = baseContext.commandView;
    if (!commandView) throw new Error('command-outcome-view-required');
    const context: RepositoryAdmissionContextV02 = baseContext;
    const admittedView: CommandView = {
      viewId: commandView.viewId,
      viewDigest: commandView.viewDigest,
      taskId: commandView.taskId,
      workspaceId: commandView.workspaceId,
      canonicalRevisionDigest: commandView.canonicalRevision,
      admittedFiles: commandView.admittedFiles,
      exclusionsPolicyVersion: commandView.exclusionsPolicyVersion,
      scratchIdentity: commandView.scratchIdentity,
      mountedReadOnly: true,
    };
    manager.getActiveCommandView = (workspaceId) => workspaceId === context.workspaceId ? admittedView : null;
    const journal = createJournalForRepositoryCommand(context);
    const attempts: AttemptReceiptV02[] = [];
    captureJournalAttempts(journal, attempts);
    const recoveryBehavior: TestRepositoryRecoveryBehavior = {};
    const attemptStartRecoveryHandoff = createJournalBackedAttemptStartRecoveryHandoff(journal, attempts);
    const profile = {
      profileId: 'profile-uc03-test',
      image: 'ghcr.io/test:0.1',
      imageDigest: canonicalRev,
      user: '1000:1000',
      readOnlyRootFilesystem: true as const,
      network: 'none' as const,
      limits: { timeoutMs: 30000, maxMemoryBytes: 2147483648, maxCpuCores: 2, maxPids: 256 },
      mounts: [],
    };
    const executor = new StructuredCommandExecutor({
      manager,
      controller,
      profile,
      adapterIdentity: 'command-outcome-executor',
      processIncarnation: `inc-${actionId}`,
      fencingGeneration: 1,
    });
    const tools = new ControlledRepositoryTools({
      guardCapability: guard,
      fsPort,
      limits: defaultLimits,
      statePort: journal,
      taskControl: journal,
      workspaceManager: manager,
      commandExecutor: executor,
      trustedCommandResourcePolicy: {
        isolationProfileRef: 'profile-uc03-test',
        limits: { timeoutMs: 30000, maxOutputBytes: 65536, maxCpuCores: 2, maxMemoryBytes: 2147483648, maxPids: 256 },
      },
      adapterIdentity: 'command-outcome-executor',
      processIncarnation: `inc-${actionId}`,
      fencingGeneration: 1,
      patchRecoveryHandoff: useTrustedRecovery
        ? createJournalBackedRecoveryHandoff(journal, recoveryBehavior)
        : createUnavailableRecoveryHandoff(),
      attemptStartRecoveryHandoff,
      unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
    });
    return { action, context, journal, tools, manager, controller, executor, attempts, attemptStartRecoveryHandoff, recoveryBehavior };
  }

  async function createJournalBackedPatchHarness(actionId: string) {
    const patch: ApplyPatchAction = {
      actionId,
      kind: 'apply_patch',
      patchContent: '--- a/src/app.py\n+++ b/src/app.py\n+changed\n',
      targetPaths: ['src/app.py'],
      baseRevisionDigest: canonicalRev,
    };
    const context = createTestRepositoryAdmissionContextV02({
      taskId: 'task-test-1',
      runId: 'run-1',
      workspaceId: 'ws-test-1',
      repositoryId: 'repo-1',
      canonicalRevision: canonicalRev,
      action: patch,
      actionDigest: computeActionDigest(patch),
      baseRevision: canonicalRev,
      targetPaths: [...patch.targetPaths],
      patchDigest: computeCanonicalSha256(patch.patchContent),
    });
    const { manager } = await createWorkspaceManager();
    const journal = createJournalForRepositoryAdmission(context);
    const attempts: AttemptReceiptV02[] = [];
    captureJournalAttempts(journal, attempts);
    const recoveryBehavior: TestRepositoryRecoveryBehavior = {};
    const attemptStartRecoveryHandoff = createJournalBackedAttemptStartRecoveryHandoff(journal, attempts);
    let patchCalls = 0;
    const tools = new ControlledRepositoryTools({
      guardCapability: guard,
      fsPort,
      limits: defaultLimits,
      statePort: journal,
      workspaceManager: manager,
      adapterIdentity: `patch-attempt-start-${actionId}`,
      processIncarnation: `inc-${actionId}`,
      fencingGeneration: 1,
      patchRecoveryHandoff: createJournalBackedRecoveryHandoff(journal, recoveryBehavior),
      attemptStartRecoveryHandoff,
      unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
      patchReceiver: async () => {
        patchCalls += 1;
        return { applied: true, newRevisionDigest: canonicalRev };
      },
    });
    return { patch, context, journal, tools, manager, attempts, recoveryBehavior, patchCalls: () => patchCalls };
  }

  it('diagnostic patch settles once without repair charge and preserves Investigate', async () => {
    const context = createTestDiagnosticPatchAdmissionContextV02();
    const initial = createTestAdmissionTaskStateV02(context);
    const journal = new MemoryStatePortV02({
      initialTaskState: initial,
      initialAuthorityRef: context.policyAuthorityRef,
      initialControlVersion: context.expectedControlVersion,
      initialEpoch: context.expectedEpoch,
    });
    const controller = new RepositoryTestDockerController();
    const manager = new DockerWorkspaceManager({ controller });
    await manager.createWorkspace({
      taskId: context.taskId, workspaceId: context.workspaceId,
      initialRevisionDigest: context.canonicalRevision,
      profile: { profileId: 'profile-test', image: 'test', imageDigest: canonicalRev,
        user: '1000:1000', readOnlyRootFilesystem: true, network: 'none',
        limits: { timeoutMs: 30000, maxMemoryBytes: 2147483648, maxCpuCores: 2, maxPids: 256 }, mounts: [] },
    });
    fsPort.setRevision(context.canonicalRevision);
    const nextRevision = 'sha256:' + 'a'.repeat(64);
    let effects = 0;
    const tools = new ControlledRepositoryTools({
      guardCapability: guard, fsPort, limits: defaultLimits, statePort: journal,
      workspaceManager: manager, adapterIdentity: 'diagnostic', processIncarnation: 'diag-1', fencingGeneration: 1,
      patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
      attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
      unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
      patchReceiver: async () => {
        effects++;
        fsPort.setRevision(nextRevision);
        manager.setCanonicalRevision(context.workspaceId, nextRevision);
        return { applied: true, newRevisionDigest: nextRevision };
      },
    });
    assert.equal(context.action.kind, 'apply_patch');
    if (context.action.kind !== 'apply_patch') throw new Error('fixture requires patch');
    const result = await tools.applyPatch(context.action, context);
    assert.equal(result.applied, true);
    assert.equal(result.newRevisionDigest, nextRevision);
    assert.equal(result.executionReceipt.settlement.outcome, 'settled');
    assert.equal(result.executionReceipt.outcome.observedResultRevisionDigest, nextRevision);
    const persisted = await journal.loadTask(context.taskId);
    assert.equal(persisted?.node, 'Investigate');
    assert.equal(persisted?.repositoryRevisionDigest, nextRevision);
    assert.equal(persisted?.budgetLedgers?.find((ledger) => ledger.kind === 'repair')?.consumed, 0);
    assert.equal(journal.getJournalSnapshot().activeClaimId, null);
    assert.equal(journal.getJournalSnapshot().outcomes.length, 1);
    await assert.rejects(() => tools.applyPatch(context.action as ApplyPatchAction, context));
    assert.equal(effects, 1);
    assert.equal(journal.getJournalSnapshot().outcomes.length, 1);
  });

  describe('Patch admission binds the exact caller payload', () => {
    it('rejects changed content, paths, or base before beginAttempt and patch effects', async () => {
      const admittedPatch: ApplyPatchAction = {
        actionId: 'act-bound-patch-1',
        kind: 'apply_patch',
        patchContent: '--- a/src/a.py\n+++ b/src/a.py\n',
        targetPaths: ['src/a.py'],
        baseRevisionDigest: canonicalRev,
      };
      const context = createTestAdmissionContext({
        action: admittedPatch,
        actionDigest: computeActionDigest(admittedPatch),
        baseRevision: canonicalRev,
      });
      const changedPayloads: ApplyPatchAction[] = [
        { ...admittedPatch, patchContent: '--- a/src/a.py\n+++ b/src/a.py\n+changed\n' },
        { ...admittedPatch, targetPaths: ['src/b.py'] },
        { ...admittedPatch, baseRevisionDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
      ];
      let patchEffects = 0;
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        patchReceiver: async () => {
          patchEffects += 1;
          return { applied: true, newRevisionDigest: canonicalRev };
        },
      });

      for (const changedPatch of changedPayloads) {
        await assert.rejects(() => tools.applyPatch(changedPatch, context), /PATCH_ADMISSION_MISMATCH/);
      }

      assert.equal(statePort.beginAttemptCalls.length, 0);
      assert.equal(patchEffects, 0);
    });

    it('requires an actual patch receiver before claiming', async () => {
      const patch: ApplyPatchAction = {
        actionId: 'act-gated-patch-1',
        kind: 'apply_patch',
        patchContent: '--- a/src/a.py\n+++ b/src/a.py\n',
        targetPaths: ['src/a.py'],
        baseRevisionDigest: canonicalRev,
      };
      const context = createTestAdmissionContext({ action: patch, actionDigest: computeActionDigest(patch) });
      const { manager } = await createWorkspaceManager();
      const noReceiver = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
      });

      await assert.rejects(() => noReceiver.applyPatch(patch, context), /PATCH_RECEIVER_REQUIRED/);
      assert.equal(statePort.claimCalls.length, 0);
      assert.equal(statePort.beginAttemptCalls.length, 0);
    });

    it('requires the exclusive workspace gate before claiming', async () => {
      const patch: ApplyPatchAction = {
        actionId: 'act-no-gate-patch-1',
        kind: 'apply_patch',
        patchContent: '--- a/src/a.py\n+++ b/src/a.py\n',
        targetPaths: ['src/a.py'],
        baseRevisionDigest: canonicalRev,
      };
      const context = createTestAdmissionContext({ action: patch, actionDigest: computeActionDigest(patch) });
      const missingGateState = new FakeStatePortV02();
      let patchEffects = 0;
      const noGate = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort: missingGateState,
        patchReceiver: async () => {
          patchEffects += 1;
          return { applied: true, newRevisionDigest: canonicalRev };
        },
      });

      await assert.rejects(() => noGate.applyPatch(patch, context), /WORKSPACE_GATE_REQUIRED/);
      assert.equal(missingGateState.claimCalls.length, 0);
      assert.equal(missingGateState.beginAttemptCalls.length, 0);
      assert.equal(patchEffects, 0);
    });

    it('uses detached action and context snapshots across awaited attempt admission', async () => {
      const targetPaths = ['src/a.py'];
      const patch: ApplyPatchAction = {
        actionId: 'act-detached-patch-1',
        kind: 'apply_patch',
        patchContent: '--- a/src/a.py\n+++ b/src/a.py\n+original\n',
        targetPaths,
        baseRevisionDigest: canonicalRev,
      };
      const actionDigest = computeActionDigest(patch);
      const context = createTestAdmissionContext({ action: patch, actionDigest });
      const { manager } = await createWorkspaceManager();
      let continueBeginAttempt: (() => void) | undefined;
      let beginAttemptStarted: (() => void) | undefined;
      const began = new Promise<void>((resolve) => { beginAttemptStarted = resolve; });
      const resume = new Promise<void>((resolve) => { continueBeginAttempt = resolve; });
      statePort.beforeBeginAttempt = async () => {
        beginAttemptStarted?.();
        await resume;
      };
      const received: { patch?: ApplyPatchAction; context?: RepositoryAdmissionContextV02 } = {};
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        adapterIdentity: 'patch-receiver',
        processIncarnation: 'inc-patch-detached',
        fencingGeneration: 1,
        patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
        patchReceiver: async (admittedPatch, admittedContext) => {
          received.patch = admittedPatch;
          received.context = admittedContext;
          return { applied: true, newRevisionDigest: canonicalRev };
        },
      });

      const pending = tools.applyPatch(patch, context);
      await began;
      Object.assign(patch, { patchContent: 'mutated-after-admission' });
      targetPaths[0] = 'src/mutated.py';
      Object.assign(context, { actionDigest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' });
      continueBeginAttempt?.();
      await pending;

      assert.equal(received.patch?.patchContent, '--- a/src/a.py\n+++ b/src/a.py\n+original\n');
      assert.deepEqual(received.patch?.targetPaths, ['src/a.py']);
      assert.equal(received.context?.actionDigest, actionDigest);
    });

    it('rejects a duplicate attempt and a fence published during beginAttempt before patch invocation', async () => {
      const patch: ApplyPatchAction = {
        actionId: 'act-fenced-patch-1',
        kind: 'apply_patch',
        patchContent: '--- a/src/a.py\n+++ b/src/a.py\n',
        targetPaths: ['src/a.py'],
        baseRevisionDigest: canonicalRev,
      };
      const context = createTestAdmissionContext({ action: patch, actionDigest: computeActionDigest(patch) });
      const { manager } = await createWorkspaceManager();
      let patchEffects = 0;
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        adapterIdentity: 'patch-receiver',
        processIncarnation: 'inc-patch-1',
        fencingGeneration: 1,
        patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
        patchReceiver: async () => {
          patchEffects += 1;
          return { applied: true, newRevisionDigest: canonicalRev };
        },
      });

      await tools.applyPatch(patch, context);
      const recordedOutcomesAfterFirstAttempt = statePort.outcomeReceipts.length;
      await assert.rejects(() => tools.applyPatch(patch, context), /DUPLICATE_ATTEMPT/);
      assert.equal(statePort.outcomeReceipts.length, recordedOutcomesAfterFirstAttempt, 'A duplicate attempt does not rewrite its prior outcome');

      const fencedState = new FakeStatePortV02();
      let continueBeginAttempt: (() => void) | undefined;
      let beginAttemptStarted: (() => void) | undefined;
      const began = new Promise<void>((resolve) => { beginAttemptStarted = resolve; });
      const resume = new Promise<void>((resolve) => { continueBeginAttempt = resolve; });
      fencedState.beforeBeginAttempt = async () => {
        beginAttemptStarted?.();
        await resume;
      };
      let fencedPatchEffects = 0;
      const fencedTools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort: fencedState,
        workspaceManager: manager,
        adapterIdentity: 'patch-receiver',
        processIncarnation: 'inc-patch-1',
        fencingGeneration: 1,
        patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
        patchReceiver: async () => {
          fencedPatchEffects += 1;
          return { applied: true, newRevisionDigest: canonicalRev };
        },
      });
      const pending = fencedTools.applyPatch(patch, context);
      await began;
      manager.setFencingGeneration('ws-test-1', 2);
      continueBeginAttempt?.();
      await assert.rejects(() => pending, /PATCH_OUTCOME_PENDING/);
      assert.equal(fencedState.outcomeReceipts.length, 1, 'A begun but fenced attempt records one uncertain outcome');
      assert.equal(fencedState.outcomeReceipts[0]?.outcome, 'uncertain');
      assert.equal(fencedState.attemptReceipts.length, 1);
      assert.equal(fencedPatchEffects, 0);
      assert.equal(patchEffects, 1);
    });
  });

  describe('Read holds: zero filesystem reads when paused or claim is open', () => {
    it('produces ZERO filesystem reads in listDir, readFile, and searchCode when task is paused', async () => {
      fsPort.setFile('src/file.py', 'print(1)');
      const taskControl = new FakeTaskControlPortV02(makeJournalSnapshot({
        mode: 'paused',
        holdRef: 'pause-hold-1',
        holdEventDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }));

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        taskControl,
      });

      await assert.rejects(() => tools.listDir('src'), /TASK_PAUSED_OR_HELD/);
      await assert.rejects(() => tools.readFile('src/file.py'), /TASK_PAUSED_OR_HELD/);
      await assert.rejects(() => tools.searchCode('print'), /TASK_PAUSED_OR_HELD/);

      assert.equal(fsPort.statCalls.length, 0, 'Zero stat calls when paused');
      assert.equal(fsPort.lstatCalls.length, 0, 'Zero lstat calls when paused');
      assert.equal(fsPort.realpathCalls.length, 0, 'Zero realpath calls when paused');
      assert.equal(fsPort.readDirCalls.length, 0, 'Zero readDir calls when paused');
      assert.equal(fsPort.readTextFileCalls.length, 0, 'Zero readTextFile calls when paused');
    });

    it('produces ZERO filesystem reads in listDir, readFile, and searchCode when any claim is open', async () => {
      fsPort.setFile('src/file.py', 'print(1)');
      const taskControl = new FakeTaskControlPortV02(makeJournalSnapshot({
        claims: [{ claimId: 'claim-open-1', status: 'outcome-recorded', attemptId: 'att-open-1' }],
      }));

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        taskControl,
      });

      await assert.rejects(() => tools.listDir('src'), /CLAIM_OPEN_READ_DENIED/);
      await assert.rejects(() => tools.readFile('src/file.py'), /CLAIM_OPEN_READ_DENIED/);
      await assert.rejects(() => tools.searchCode('print'), /CLAIM_OPEN_READ_DENIED/);

      assert.equal(fsPort.statCalls.length, 0, 'Zero stat calls when claim is open');
      assert.equal(fsPort.lstatCalls.length, 0, 'Zero lstat calls when claim is open');
      assert.equal(fsPort.realpathCalls.length, 0, 'Zero realpath calls when claim is open');
      assert.equal(fsPort.readDirCalls.length, 0, 'Zero readDir calls when claim is open');
      assert.equal(fsPort.readTextFileCalls.length, 0, 'Zero readTextFile calls when claim is open');
    });

    it('requires an explicit authoritative task control port when a state port is configured', async () => {
      fsPort.setFile('src/calc.py', 'def add(a, b): return a + b');
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort: new FakeStatePortV02(),
      });

      await assert.rejects(() => tools.readFile('src/calc.py'), /TASK_CONTROL_REQUIRED/);
      assert.equal(fsPort.getRevisionCalls, 0);
      assert.equal(fsPort.statCalls.length, 0);
      assert.equal(fsPort.realpathCalls.length, 0);
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });

    it('rejects malformed task-control snapshots before filesystem IO', async () => {
      fsPort.setFile('src/calc.py', 'def add(a, b): return a + b');
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort: new FakeStatePortV02(),
        taskControl: new FakeTaskControlPortV02({ mode: 'runnable', holdRef: null }),
      });

      await assert.rejects(() => tools.readFile('src/calc.py'), /INVALID_TASK_CONTROL_SNAPSHOT/);
      assert.equal(fsPort.getRevisionCalls, 0);
      assert.equal(fsPort.statCalls.length, 0);
      assert.equal(fsPort.realpathCalls.length, 0);
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });

    it('rechecks task control at the guarded filesystem handoff', async () => {
      fsPort.setFile('src/calc.py', 'def add(a, b): return a + b');
      const taskControl = new FakeTaskControlPortV02();
      const gate = new FakeGuardCapability();
      gate.beforeExecute = async () => {
        taskControl.snapshot = makeJournalSnapshot({
          mode: 'paused',
          holdRef: 'pause-at-handoff-1',
          holdEventDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        });
      };
      const tools = new ControlledRepositoryTools({
        guardCapability: gate,
        fsPort,
        limits: defaultLimits,
        statePort: new FakeStatePortV02(),
        taskControl,
      });

      await assert.rejects(() => tools.readFile('src/calc.py'), /TASK_PAUSED_OR_HELD/);
      assert.equal(fsPort.getRevisionCalls, 0);
      assert.equal(fsPort.statCalls.length, 0);
      assert.equal(fsPort.lstatCalls.length, 0);
      assert.equal(fsPort.realpathCalls.length, 0);
      assert.equal(fsPort.readTextFileCalls.length, 0);
    });
  });

  describe('Missing admission context fails closed (v0.1 compatibility)', () => {
    it('fails closed when applyPatch, runCommand, or runTests is called without v0.2 context', async () => {
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
      });

      const patch: ApplyPatchAction = { actionId: 'p1', kind: 'apply_patch', patchContent: '', targetPaths: [], baseRevisionDigest: canonicalRev };
      const command: RunCommandAction = { actionId: 'c1', kind: 'run_command', executable: 'pytest', argv: [], workingDirectory: '/workspace/repo' };
      const check: CheckDefinition = { checkId: 'chk1', executable: 'pytest', argv: [], purpose: 'reproduction' };
      await assert.rejects(() => tools.applyPatch(patch), /NOT_IMPLEMENTED/);
      await assert.rejects(() => tools.runCommand(command), /NOT_IMPLEMENTED/);
      await assert.rejects(() => tools.runTests(check), /NOT_IMPLEMENTED/);
    });
  });

  describe('Section 10 Case 4: Repository writer and view drift before beginAttempt', () => {
    it('applyPatch: denies with zero beginAttempt and zero patch effects when base revision drifts', async () => {
      const { manager } = await createWorkspaceManager();
      let patchEffects = 0;
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        adapterIdentity: 'patch-receiver',
        processIncarnation: 'inc-stale-base-1',
        fencingGeneration: 1,
        patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
        patchReceiver: async () => {
          patchEffects += 1;
          return { applied: true, newRevisionDigest: canonicalRev };
        },
      });

      const patchAction: ApplyPatchAction = {
        actionId: 'act-patch-drift-1',
        kind: 'apply_patch',
        patchContent: '--- a/src/app.py\n+++ b/src/app.py\n',
        targetPaths: ['src/app.py'],
        baseRevisionDigest: 'sha256:stale-base-revision-0000000000000000000000000000000000000000',
      };

      const context = createTestAdmissionContext({
        action: patchAction,
        actionDigest: computeActionDigest(patchAction),
        baseRevision: 'sha256:stale-base-revision-0000000000000000000000000000000000000000',
      });

      await assert.rejects(
        () => tools.applyPatch(patchAction, context),
        /STALE_REVISION_DRIFT/
      );

      assert.equal(statePort.beginAttemptCalls.length, 0, 'Zero beginAttempt calls on base revision drift');
      assert.equal(patchEffects, 0, 'Zero patch effects on base revision drift');
    });

    it('runCommand & runTests: denies with zero beginAttempt and zero controller dispatch when command view drifts', async () => {
      const controller = new RepositoryTestDockerController();
      const manager = new DockerWorkspaceManager({ controller });
      const ws = await manager.createWorkspace({
        taskId: 'task-test-1',
        workspaceId: 'ws-test-1',
        initialRevisionDigest: canonicalRev,
        profile: {
          profileId: 'profile-uc03-test',
          image: 'ghcr.io/test:0.1',
          imageDigest: canonicalRev,
          user: '1000:1000',
          readOnlyRootFilesystem: true,
          network: 'none',
          limits: { timeoutMs: 30000, maxMemoryBytes: 2147483648, maxCpuCores: 2, maxPids: 256 },
          mounts: [],
        },
      });

      controller.snapshotToReturn = {
        canonicalRevisionDigest: canonicalRev,
        entries: [{ path: 'src/app.py', kind: 'regular', content: 'test', digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }],
      };
      await manager.admitCommandView({ workspaceId: ws.workspaceId });

      const executor = new StructuredCommandExecutor({
        manager,
        controller,
        profile: ws ? {
          profileId: 'profile-uc03-test',
          image: 'ghcr.io/test:0.1',
          imageDigest: canonicalRev,
          user: '1000:1000',
          readOnlyRootFilesystem: true,
          network: 'none',
          limits: { timeoutMs: 30000, maxMemoryBytes: 2147483648, maxCpuCores: 2, maxPids: 256 },
          mounts: [],
        } : undefined,
      });

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        commandExecutor: executor,
        trustedCommandResourcePolicy: {
          isolationProfileRef: 'profile-uc03-test',
          limits: { timeoutMs: 30000, maxOutputBytes: 65536, maxCpuCores: 2, maxMemoryBytes: 2147483648, maxPids: 256 },
        },
        patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
      });

      const commandAction: RunCommandAction = {
        actionId: 'act-cmd-drift-1',
        kind: 'run_command',
        executable: 'pytest',
        argv: ['-q'],
        workingDirectory: '/workspace/repo',
      };

      // Context with mismatching commandView digest
      const context = createTestAdmissionContext({
        action: commandAction,
        actionDigest: computeActionDigest(commandAction),
        checkId: 'chk-drift-1',
        commandView: {
          viewId: 'view-mismatch',
          viewDigest: 'sha256:mismatch-digest-9999999999999999999999999999999999999999999',
          taskId: 'task-test-1',
          workspaceId: 'ws-test-1',
          canonicalRevision: canonicalRev,
          admittedFiles: [],
          exclusionsPolicyVersion: '0.1.0',
          scratchIdentity: 'scratch-1',
          mountedReadOnly: true,
          isolationProfileRef: 'profile-uc03-test',
        },
      });

      await assert.rejects(
        () => tools.runCommand(commandAction, context),
        /STALE_COMMAND_VIEW/
      );
      assert.equal(statePort.beginAttemptCalls.length, 0, 'Zero beginAttempt calls on command view drift');
      assert.equal(controller.executedPlans.length, 0, 'Zero controller executions on command view drift');

      const check: CheckDefinition = { checkId: 'chk-drift-1', executable: 'pytest', argv: ['-q'], workingDirectory: '/workspace/repo', purpose: 'reproduction' };
      await assert.rejects(
        () => tools.runTests(check, context),
        /STALE_COMMAND_VIEW/
      );
      assert.equal(statePort.beginAttemptCalls.length, 0, 'Zero beginAttempt calls on runTests view drift');
      assert.equal(controller.executedPlans.length, 0, 'Zero controller executions on runTests view drift');
    });
  });

  describe('Patch settlement keeps the workspace fenced', () => {
    const nextRevision = 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

    it('closes a pre-begin claim only through the journal-backed fenced UC-05 boundary', async () => {
      const patch: ApplyPatchAction = {
        actionId: 'act-patch-prebegin-closure',
        kind: 'apply_patch',
        patchContent: '--- a/src/a.py\n+++ b/src/a.py\n+prebegin\n',
        targetPaths: ['src/a.py'],
        baseRevisionDigest: canonicalRev,
      };
      const context = createJournalBackedPatchContext(patch);
      const journal = createJournalForRepositoryAdmission(context);
      const { manager } = await createWorkspaceManager();
      const claim = journal.claim.bind(journal);
      journal.claim = async (admission) => {
        const receipt = await claim(admission);
        manager.setFencingGeneration(context.workspaceId, 2);
        return receipt;
      };
      let patchEffects = 0;
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort: journal,
        workspaceManager: manager,
        adapterIdentity: 'patch-prebegin-closure',
        processIncarnation: 'inc-patch-prebegin-closure',
        fencingGeneration: 1,
        patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createJournalBackedClaimClosureHandoff(journal),
        patchReceiver: async () => {
          patchEffects += 1;
          return { applied: true, newRevisionDigest: canonicalRev };
        },
      });

      await assert.rejects(() => tools.applyPatch(patch, context), /FENCED_EXECUTOR/);
      const snapshot = journal.getJournalSnapshot();
      assert.equal(patchEffects, 0);
      assert.equal(snapshot.claims[0]?.status, 'closed');
      assert.equal(snapshot.claims[0]?.attemptId, null);
      assert.equal(snapshot.attempts.length, 0);
      assert.equal(snapshot.closures.length, 1);
      assert.equal(snapshot.activeClaimId, null);
      assert.equal(snapshot.mode, 'paused');
      assert.equal(snapshot.fencedIncarnations.includes('patch-prebegin-closure\u0000inc-patch-prebegin-closure'), true);
      const repair = journal.getLedgers().find((ledger) => ledger.kind === 'repair');
      assert.equal(repair?.consumed, 0);
      assert.equal(repair?.reservations.length, 0);
      const lease = await manager.acquireWriteLease(context.workspaceId, canonicalRev);
      await lease.release();
    });

    it('records a post-begin fence failure as uncertain and settles only with journal fence proof', async () => {
      const patch: ApplyPatchAction = {
        actionId: 'act-patch-postbegin-fence',
        kind: 'apply_patch',
        patchContent: '--- a/src/a.py\n+++ b/src/a.py\n+postbegin\n',
        targetPaths: ['src/a.py'],
        baseRevisionDigest: canonicalRev,
      };
      const context = createJournalBackedPatchContext(patch);
      const journal = createJournalForRepositoryAdmission(context);
      const { manager } = await createWorkspaceManager();
      const begin = journal.beginAttempt.bind(journal);
      journal.beginAttempt = async (claimId, executor) => {
        const attempt = await begin(claimId, executor);
        manager.setFencingGeneration(context.workspaceId, 2);
        return attempt;
      };
      let patchEffects = 0;
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort: journal,
        workspaceManager: manager,
        adapterIdentity: 'patch-postbegin-fence',
        processIncarnation: 'inc-patch-postbegin-fence',
        fencingGeneration: 1,
        patchRecoveryHandoff: createJournalBackedRecoveryHandoff(journal),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
        patchReceiver: async () => {
          patchEffects += 1;
          return { applied: true, newRevisionDigest: canonicalRev };
        },
      });

      const pendingError = await tools.applyPatch(patch, context).then(() => null, (error: unknown) => error);
      assert.equal(pendingError instanceof Error, true);
      assert.match((pendingError as Error).message, /PATCH_OUTCOME_PENDING/);
      const attempt = journal.getJournalSnapshot().attempts[0];
      assert.ok(attempt);
      const held = journal.getJournalSnapshot();
      assert.equal(held.claims[0]?.status, 'uncertain');
      assert.equal(held.attempts[0]?.status, 'uncertain');
      assert.equal(held.outcomes[0]?.outcome, 'uncertain');
      assert.equal(held.activeClaimId, held.claims[0]?.claimId);
      assert.equal(patchEffects, 0);
      assert.equal(journal.getLedgers().find((ledger) => ledger.kind === 'repair')?.consumed, 1);

      const settled = await tools.recoverPatchOutcome(attempt.attemptId);
      const recovered = journal.getJournalSnapshot();
      assert.equal(settled.outcome, 'settled');
      assert.equal(recovered.reconciliations.length, 1);
      assert.equal(recovered.fenceProofs.length, 1);
      assert.equal(recovered.claims[0]?.status, 'settled');
      assert.equal(recovered.activeClaimId, null);
      assert.equal(recovered.mode, 'paused');
      assert.equal(patchEffects, 0);
      const lease = await manager.acquireReadLease(context.workspaceId, canonicalRev);
      await lease.release();
    });

    it('fails closed before beginAttempt when the typed recovery handoff is missing', async () => {
      const { manager } = await createWorkspaceManager();
      let patchCalls = 0;
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        adapterIdentity: 'patch-missing-recovery',
        processIncarnation: 'inc-patch-missing-recovery',
        fencingGeneration: 1,
        patchReceiver: async () => {
          patchCalls += 1;
          return { applied: true, newRevisionDigest: canonicalRev };
        },
      });
      const patch: ApplyPatchAction = {
        actionId: 'act-patch-missing-recovery',
        kind: 'apply_patch',
        patchContent: '--- a/src/a.py\n+++ b/src/a.py\n+missing-recovery\n',
        targetPaths: ['src/a.py'],
        baseRevisionDigest: canonicalRev,
      };
      const context = createTestAdmissionContext({ action: patch, actionDigest: computeActionDigest(patch) });

      await assert.rejects(() => tools.applyPatch(patch, context), /PATCH_RECOVERY_REQUIRED/);
      assert.equal(statePort.beginAttemptCalls.length, 0, 'missing recovery handoff denies before beginAttempt');
      assert.equal(patchCalls, 0, 'missing recovery handoff denies before patch dispatch');

      const noClosure = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        adapterIdentity: 'patch-missing-closure',
        processIncarnation: 'inc-patch-missing-closure',
        fencingGeneration: 1,
        patchRecoveryHandoff: createUnavailableRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        patchReceiver: async () => {
          patchCalls += 1;
          return { applied: true, newRevisionDigest: canonicalRev };
        },
      });
      await assert.rejects(() => noClosure.applyPatch(patch, context), /CLAIM_CLOSURE_REQUIRED/);
      assert.equal(statePort.claimCalls.length, 0, 'missing no-attempt closure capability denies before claim admission');
      assert.equal(statePort.beginAttemptCalls.length, 0);
      assert.equal(patchCalls, 0);
    });

    it('blocks competing writers and view builders until recordOutcome reports settled', async () => {
      const { manager, controller } = await createWorkspaceManager();
      controller.snapshotToReturn = {
        canonicalRevisionDigest: nextRevision,
        entries: [{ path: 'src/a.py', kind: 'regular', content: 'test', digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }],
      };
      let recordedOutcome: AttemptOutcomeReceiptV02 | undefined;
      let releaseRecord: (() => void) | undefined;
      const recordBarrier = new Promise<void>((resolve) => { releaseRecord = resolve; });
      statePort.recordOutcomeHandler = async (receipt) => {
        recordedOutcome = receipt;
        await recordBarrier;
        return { outcome: 'settled', receiptId: receipt.receiptId };
      };
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        adapterIdentity: 'patch-settlement',
        processIncarnation: 'inc-patch-settlement',
        fencingGeneration: 1,
        patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
        patchReceiver: async () => {
          fsPort.setRevision(nextRevision);
          manager.setCanonicalRevision('ws-test-1', nextRevision);
          return { applied: true, newRevisionDigest: nextRevision };
        },
      });
      const patch: ApplyPatchAction = {
        actionId: 'act-patch-settlement',
        kind: 'apply_patch',
        patchContent: '--- a/src/a.py\n+++ b/src/a.py\n+settled\n',
        targetPaths: ['src/a.py'],
        baseRevisionDigest: canonicalRev,
      };
      const context = createTestAdmissionContext({ action: patch, actionDigest: computeActionDigest(patch) });
      const applying = tools.applyPatch(patch, context);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const enteredSettlement = recordedOutcome !== undefined;

      let writerAcquired = false;
      const competingWriter = manager.acquireWriteLease('ws-test-1', nextRevision).then((lease) => {
        writerAcquired = true;
        return lease;
      });
      const viewBuild = manager.admitCommandView({ workspaceId: 'ws-test-1' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const blockedBeforeSettlement = !writerAcquired && controller.snapshotRequests === 0;
      const recordedOutcomeKind = recordedOutcome?.outcome;
      releaseRecord?.();
      const applicationResult: unknown = await applying.catch((error: unknown) => error);
      assert.equal(enteredSettlement, true, 'applyPatch records its observed result before returning');
      assert.equal(recordedOutcomeKind, 'observed');
      assert.equal(applicationResult instanceof Error, false, 'settled outcome returns the observed patch result');
      assert.equal(recordedOutcome?.outcome, 'observed');
      if (recordedOutcome?.subjectKind === 'repository-action') {
        assert.equal(recordedOutcome.observedResultRevisionDigest, nextRevision);
      }
      assert.equal(blockedBeforeSettlement, true, 'writer and view builder stay behind the unsettled patch lease');
      const writerLease = await competingWriter;
      await writerLease.release();
      await viewBuild;
      assert.equal(controller.snapshotRequests, 1, 'view builder proceeds after UC-04 settlement');
    });

    it('keeps the lease after recorded-unsettled and releases only after trusted recovery settles', async () => {
      const { manager, controller } = await createWorkspaceManager();
      controller.snapshotToReturn = {
        canonicalRevisionDigest: nextRevision,
        entries: [{ path: 'src/a.py', kind: 'regular', content: 'test', digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }],
      };
      statePort.recordOutcomeHandler = async (receipt) => ({ outcome: 'recorded-unsettled', receiptId: receipt.receiptId });
      let recoveryCalls = 0;
      statePort.observedReconciliationHandler = async (receipt) => ({
        outcome: ++recoveryCalls === 1 ? 'blocked' : 'settled',
        receiptId: receipt.reconciliationId,
      });
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        adapterIdentity: 'patch-observed-recovery',
        processIncarnation: 'inc-patch-observed-recovery',
        fencingGeneration: 1,
        patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
        patchReceiver: async () => {
          fsPort.setRevision(nextRevision);
          manager.setCanonicalRevision('ws-test-1', nextRevision);
          return { applied: true, newRevisionDigest: nextRevision };
        },
      });
      const patch: ApplyPatchAction = {
        actionId: 'act-patch-observed-recovery',
        kind: 'apply_patch',
        patchContent: '--- a/src/a.py\n+++ b/src/a.py\n+observed\n',
        targetPaths: ['src/a.py'],
        baseRevisionDigest: canonicalRev,
      };
      const context = createTestAdmissionContext({ action: patch, actionDigest: computeActionDigest(patch) });
      await assert.rejects(() => tools.applyPatch(patch, context), /PATCH_OUTCOME_PENDING/);
      assert.equal(statePort.outcomeReceipts.at(-1)?.outcome, 'observed');

      let writerAcquired = false;
      const competingWriter = manager.acquireWriteLease('ws-test-1', nextRevision).then((lease) => {
        writerAcquired = true;
        return lease;
      });
      const viewBuild = manager.admitCommandView({ workspaceId: 'ws-test-1' });
      const attempt = statePort.attemptReceipts.at(-1);
      assert.ok(attempt);
      const blocked = await tools.recoverPatchOutcome(attempt.attemptId);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(blocked.outcome, 'blocked');
      assert.equal(writerAcquired, false, 'recorded-unsettled alone does not release the writer lease');
      assert.equal(controller.snapshotRequests, 0, 'recorded-unsettled alone does not admit a view');

      const settled = await tools.recoverPatchOutcome(attempt.attemptId);
      assert.equal(settled.outcome, 'settled');
      const writerLease = await competingWriter;
      await writerLease.release();
      await viewBuild;
      assert.equal(statePort.observedReconciliations.length, 2);
      assert.equal(controller.snapshotRequests, 1);
    });

    it('does not treat already-recorded as settlement proof', async () => {
      const { manager } = await createWorkspaceManager();
      statePort.recordOutcomeHandler = async (receipt) => ({ outcome: 'already-recorded', receiptId: receipt.receiptId });
      let recoveryCalls = 0;
      statePort.observedReconciliationHandler = async (receipt) => ({
        outcome: ++recoveryCalls === 1 ? 'conflict' : 'settled',
        receiptId: receipt.reconciliationId,
      });
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        adapterIdentity: 'patch-already-recorded',
        processIncarnation: 'inc-patch-already-recorded',
        fencingGeneration: 1,
        patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
        patchReceiver: async () => ({ applied: true, newRevisionDigest: canonicalRev }),
      });
      const patch: ApplyPatchAction = {
        actionId: 'act-patch-already-recorded',
        kind: 'apply_patch',
        patchContent: '--- a/src/a.py\n+++ b/src/a.py\n+already-recorded\n',
        targetPaths: ['src/a.py'],
        baseRevisionDigest: canonicalRev,
      };
      const context = createTestAdmissionContext({ action: patch, actionDigest: computeActionDigest(patch) });
      await assert.rejects(() => tools.applyPatch(patch, context), /PATCH_OUTCOME_PENDING/);
      const attempt = statePort.attemptReceipts.at(-1);
      assert.ok(attempt);
      let writerAcquired = false;
      const competingWriter = manager.acquireWriteLease('ws-test-1', canonicalRev).then((lease) => {
        writerAcquired = true;
        return lease;
      });

      const conflict = await tools.recoverPatchOutcome(attempt.attemptId);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(conflict.outcome, 'conflict');
      assert.equal(writerAcquired, false, 'already-recorded followed by conflicting recovery remains fenced');

      const settled = await tools.recoverPatchOutcome(attempt.attemptId);
      assert.equal(settled.outcome, 'settled');
      const writerLease = await competingWriter;
      await writerLease.release();
    });

    it('keeps an uncertain patch fenced until UC-04 confirms fenced recovery', async () => {
      const { manager, controller } = await createWorkspaceManager();
      controller.snapshotToReturn = {
        canonicalRevisionDigest: canonicalRev,
        entries: [{ path: 'src/a.py', kind: 'regular', content: 'test', digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }],
      };
      statePort.recordOutcomeHandler = async (receipt) => ({ outcome: 'uncertain', receiptId: receipt.receiptId });
      statePort.uncertainReconciliationHandler = async (receipt) => ({ outcome: 'settled', receiptId: receipt.reconciliationId });
      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        adapterIdentity: 'patch-uncertain-recovery',
        processIncarnation: 'inc-patch-uncertain-recovery',
        fencingGeneration: 1,
        patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
        patchReceiver: async () => { throw new Error('receiver interrupted after dispatch'); },
      });
      const patch: ApplyPatchAction = {
        actionId: 'act-patch-uncertain-recovery',
        kind: 'apply_patch',
        patchContent: '--- a/src/a.py\n+++ b/src/a.py\n+uncertain\n',
        targetPaths: ['src/a.py'],
        baseRevisionDigest: canonicalRev,
      };
      const context = createTestAdmissionContext({ action: patch, actionDigest: computeActionDigest(patch) });
      await assert.rejects(() => tools.applyPatch(patch, context), /PATCH_OUTCOME_PENDING/);
      const attempt = statePort.attemptReceipts.at(-1);
      assert.ok(attempt);
      assert.equal(statePort.outcomeReceipts.at(-1)?.outcome, 'uncertain');

      let writerAcquired = false;
      const competingWriter = manager.acquireWriteLease('ws-test-1', canonicalRev).then((lease) => {
        writerAcquired = true;
        return lease;
      });
      const viewBuild = manager.admitCommandView({ workspaceId: 'ws-test-1' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(writerAcquired, false, 'uncertain receiver outcome retains the patch lease');
      assert.equal(controller.snapshotRequests, 0, 'uncertain receiver outcome blocks view construction');

      const settled = await tools.recoverPatchOutcome(attempt.attemptId);
      assert.equal(settled.outcome, 'settled');
      const reconciliation = statePort.uncertainReconciliations.at(-1);
      assert.ok(reconciliation);
      assert.equal(reconciliation.reconciliationKind, 'uncertain-attempt');
      if ('disposition' in reconciliation) assert.equal(reconciliation.disposition, 'proven-not-dispatched');
      const writerLease = await competingWriter;
      await writerLease.release();
      await viewBuild;
      assert.equal(controller.snapshotRequests, 1);
    });
  });

  describe('Command outcome accounting holds the command lease', () => {
    it('records canonical run-command outcomes for runCommand and runTests before allowing reads', async () => {
      const command = await createJournalBackedCommandHarness('act-command-outcome-success');
      command.controller.outputToReturn = { exitCode: 0, stdout: 'command passed\n', stderr: '', durationMs: 8 };
      const commandResult = await command.tools.runCommand(command.action, command.context);
      assert.equal(commandResult.exitCode, 0);
      assert.equal(commandResult.executionReceipt.attempt.attemptId, command.journal.getJournalSnapshot().attempts[0]?.attemptId);
      assert.equal(commandResult.executionReceipt.settlement.receiptId, commandResult.executionReceipt.outcome.receiptId);
      assert.equal(commandResult.executionReceipt.outcome.outcome, 'observed');
      assert.equal(command.journal.getJournalSnapshot().outcomes[0]?.outcome, 'observed');
      assert.equal(command.journal.getJournalSnapshot().claims[0]?.status, 'settled');
      assert.equal(command.journal.getJournalSnapshot().attempts[0]?.status, 'settled');
      assert.equal(command.journal.getJournalSnapshot().activeClaimId, null);
      const commandLedgers = command.journal.getLedgers().filter((ledger) =>
        ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].includes(ledger.kind));
      assert.equal(commandLedgers.length, 10);
      assert.equal(commandLedgers.every((ledger) => ledger.reservations.length === 0 && ledger.consumed > 0), true);
      assert.deepEqual(await command.tools.listDir('src'), ['app.py'], 'A settled command allows the next guarded read');

      const tests = await createJournalBackedCommandHarness('act-command-outcome-tests');
      tests.controller.outputToReturn = { exitCode: 0, stdout: '1 passed\n', stderr: '', durationMs: 12 };
      const check: CheckDefinition = {
        checkId: 'chk-act-command-outcome-tests',
        executable: 'pytest',
        argv: ['-q'],
        workingDirectory: '/workspace/repo',
        purpose: 'reproduction',
      };
      const checkResult = await tests.tools.runTests(check, tests.context);
      assert.equal(checkResult.outcome, 'pass');
      assert.equal(tests.journal.getJournalSnapshot().outcomes[0]?.outcome, 'observed');
      assert.equal(tests.journal.getJournalSnapshot().attempts[0]?.status, 'settled');
      assert.equal(tests.journal.getJournalSnapshot().activeClaimId, null);
      assert.deepEqual(await tests.tools.listDir('src'), ['app.py'], 'A settled test command allows the next guarded read');
    });

    it('keeps uncertain executor results, reservations, and leases held for recovery', async () => {
      const command = await createJournalBackedCommandHarness('act-command-outcome-uncertain');
      command.controller.executionFailure = new Error('controller lost its response');
      await assert.rejects(
        () => command.tools.runCommand(command.action, command.context),
        /COMMAND_OUTCOME_PENDING/,
      );
      const snapshot = command.journal.getJournalSnapshot();
      assert.equal(snapshot.outcomes[0]?.outcome, 'uncertain');
      assert.equal(snapshot.claims[0]?.status, 'uncertain');
      assert.equal(snapshot.attempts[0]?.status, 'uncertain');
      assert.ok(snapshot.activeClaimId);
      const heldLedgers = command.journal.getLedgers().filter((ledger) =>
        ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].includes(ledger.kind));
      assert.equal(heldLedgers.reduce((count, ledger) => count + ledger.reservations.length, 0), 10);
      assert.equal(heldLedgers.every((ledger) => ledger.consumed === 0), true);
      const attemptId = snapshot.attempts[0]?.attemptId;
      assert.ok(attemptId);

      await assert.rejects(() => command.tools.recoverCommandOutcome(attemptId), /NO_TRUSTED_RECOVERY_EVIDENCE/);
      await assert.rejects(() => command.tools.runCommand(command.action, command.context), /CLAIM_DENIED/);
      assert.equal(command.journal.getJournalSnapshot().attempts.length, 1, 'A retry cannot begin a second attempt');
      assert.equal(command.controller.executedPlans.length, 1, 'A retry cannot redispatch the ambiguous command');

      let writerAcquired = false;
      const blockedWriter = command.manager.acquireWriteLease('ws-test-1', canonicalRev).then((lease) => {
        writerAcquired = true;
        return lease;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(writerAcquired, false, 'The uncertain command retains its read lease');
      await assert.rejects(() => command.tools.recoverCommandOutcome(attemptId), /NO_TRUSTED_RECOVERY_EVIDENCE/);
      assert.equal(writerAcquired, false, 'Missing proof does not release the lease or reservations');
      void blockedWriter;
    });

    it('records an uncertain charge when a possibly dispatched result cannot be normalized', async () => {
      const command = await createJournalBackedCommandHarness('act-command-outcome-malformed');
      command.controller.outputToReturn = { exitCode: 0, stdout: 'ran once\n', stderr: '', durationMs: 5 };
      const execute = command.executor.execute.bind(command.executor);
      command.executor.execute = async (params) => {
        const result = await execute(params);
        return { ...result, stdout: undefined } as unknown as StructuredExecutionResult;
      };

      await assert.rejects(
        () => command.tools.runCommand(command.action, command.context),
        /COMMAND_OUTCOME_PENDING/,
      );
      const snapshot = command.journal.getJournalSnapshot();
      assert.equal(snapshot.outcomes[0]?.outcome, 'uncertain');
      assert.equal(snapshot.claims[0]?.status, 'uncertain');
      assert.equal(snapshot.attempts.length, 1);
      assert.equal(command.controller.executedPlans.length, 1, 'The command effect may have occurred before normalization failed');
      const ledgers = command.journal.getLedgers().filter((ledger) =>
        ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].includes(ledger.kind));
      assert.equal(ledgers.reduce((count, ledger) => count + ledger.reservations.length, 0), 10);
      assert.equal(ledgers.every((ledger) => ledger.consumed === 0), true);
    });

    it('recovers a committed command attempt through the public owner handoff after unknown, blocked, and conflicting replies', async () => {
      const command = await createJournalBackedCommandHarness('act-command-attempt-start-recovery', true);
      const acquireReadLease = command.manager.acquireReadLease.bind(command.manager);
      let leaseReleaseCalls = 0;
      command.manager.acquireReadLease = async (workspaceId, expectedRevision) => {
        const lease = await acquireReadLease(workspaceId, expectedRevision);
        const release = lease.release.bind(lease);
        lease.release = async () => { leaseReleaseCalls += 1; await release(); };
        return lease;
      };
      const begin = command.journal.beginAttempt.bind(command.journal);
      command.journal.beginAttempt = async (claimId, identity) => {
        await begin(claimId, identity);
        throw new Error('beginAttempt response was lost after journal commit');
      };
      const recoveryId = await getAttemptStartRecoveryId(() => command.tools.runCommand(command.action, command.context));
      const before = command.journal.getJournalSnapshot();
      assert.equal(before.attempts.length, 1);
      assert.equal(before.attempts[0]?.status, 'attempting');
      assert.equal(before.outcomes.length, 0, 'No outcome is recorded until the owner confirms the committed attempt');
      assert.equal(command.controller.executedPlans.length, 0, 'A beginAttempt response loss never dispatches the command');
      const reserved = command.journal.getLedgers().filter((ledger) =>
        ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].includes(ledger.kind));
      assert.equal(reserved.reduce((count, ledger) => count + ledger.reservations.length, 0), 10);

      let ownerMode: 'unknown' | 'invalid' | 'trusted' = 'unknown';
      const query = command.attemptStartRecoveryHandoff.queryAttemptStart.bind(command.attemptStartRecoveryHandoff);
      command.attemptStartRecoveryHandoff.queryAttemptStart = async (request) => {
        if (ownerMode === 'unknown') return { outcome: 'unknown' };
        if (ownerMode === 'invalid') return {
          outcome: 'committed',
          attempt: { ...command.attempts[0], claimId: 'another-claim' },
        };
        return await query(request);
      };

      const unknown = await command.tools.recoverAttemptStart(recoveryId);
      assert.equal(unknown.outcome, 'blocked');
      const writer = command.manager.acquireWriteLease('ws-test-1', canonicalRev);
      let writerAcquired = false;
      const waitingWriter = writer.then((lease) => { writerAcquired = true; return lease; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(writerAcquired, false, 'Unknown owner state retains the command read lease');
      assert.equal(command.journal.getJournalSnapshot().attempts[0]?.status, 'attempting');
      assert.equal(command.journal.getLedgers().filter((ledger) =>
        ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].includes(ledger.kind))
        .reduce((count, ledger) => count + ledger.reservations.length, 0), 10);

      ownerMode = 'invalid';
      const invalid = await command.tools.recoverAttemptStart(recoveryId);
      assert.equal(invalid.outcome, 'blocked', 'A mismatched owner attempt receipt cannot become reconciliation evidence');
      assert.equal(command.journal.getJournalSnapshot().outcomes.length, 0);
      assert.equal(writerAcquired, false);

      ownerMode = 'trusted';
      command.recoveryBehavior.failNextPrepare = true;
      const blocked = await command.tools.recoverAttemptStart(recoveryId);
      assert.equal(blocked.outcome, 'blocked', 'Missing UC-04 settlement evidence keeps the attempt pending');
      assert.equal(command.journal.getJournalSnapshot().outcomes[0]?.outcome, 'uncertain');
      assert.equal(command.journal.getJournalSnapshot().claims[0]?.status, 'uncertain');
      assert.equal(writerAcquired, false);

      command.recoveryBehavior.conflictNextPrepare = true;
      const conflict = await command.tools.recoverAttemptStart(recoveryId);
      assert.equal(conflict.outcome, 'conflict', 'A canonical journal conflict keeps the attempt pending');
      assert.equal(command.journal.getJournalSnapshot().activeClaimId, command.journal.getJournalSnapshot().claims[0]?.claimId);
      assert.equal(writerAcquired, false);

      command.recoveryBehavior.conflictNextPrepare = false;
      const settled = await command.tools.recoverAttemptStart(recoveryId);
      const recovered = command.journal.getJournalSnapshot();
      assert.equal(settled.outcome, 'settled');
      assert.equal(recovered.reconciliations.length, 1);
      assert.equal(recovered.claims[0]?.status, 'settled');
      assert.equal(recovered.attempts[0]?.status, 'settled');
      assert.equal(recovered.activeClaimId, null);
      assert.equal(recovered.outcomes.length, 1);
      assert.equal(command.journal.getLedgers().filter((ledger) =>
        ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].includes(ledger.kind))
        .every((ledger) => ledger.reservations.length === 0 && ledger.consumed === 0), true);
      assert.equal(command.attempts.length, 1, 'Recovery does not retry beginAttempt');
      assert.equal(command.controller.executedPlans.length, 0, 'Recovery does not dispatch the command');
      assert.equal(leaseReleaseCalls, 1, 'The command lease is released once after canonical settlement');
      const writerLease = await waitingWriter;
      await writerLease.release();
    });

    it('closes a rejected pre-commit command start only with trusted fenced no-attempt proof', async () => {
      const command = await createJournalBackedCommandHarness('act-command-attempt-start-rejected');
      const acquireReadLease = command.manager.acquireReadLease.bind(command.manager);
      let leaseReleaseCalls = 0;
      command.manager.acquireReadLease = async (workspaceId, expectedRevision) => {
        const lease = await acquireReadLease(workspaceId, expectedRevision);
        const release = lease.release.bind(lease);
        lease.release = async () => { leaseReleaseCalls += 1; await release(); };
        return lease;
      };
      command.journal.beginAttempt = async () => { throw new Error('beginAttempt explicitly rejected before commit'); };
      const recoveryId = await getAttemptStartRecoveryId(() => command.tools.runCommand(command.action, command.context));
      let writerAcquired = false;
      const waitingWriter = command.manager.acquireWriteLease('ws-test-1', canonicalRev).then((lease) => {
        writerAcquired = true;
        return lease;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const pending = command.journal.getJournalSnapshot();
      assert.equal(pending.claims[0]?.status, 'claimed');
      assert.equal(pending.attempts.length, 0);
      assert.equal(pending.closures.length, 0);
      assert.equal(writerAcquired, false);
      assert.equal(command.controller.executedPlans.length, 0);

      const trustedQuery = command.attemptStartRecoveryHandoff.queryAttemptStart.bind(command.attemptStartRecoveryHandoff);
      let allowTrustedNoAttemptProof = false;
      command.attemptStartRecoveryHandoff.queryAttemptStart = async (request) => allowTrustedNoAttemptProof
        ? await trustedQuery(request)
        : {
            outcome: 'unattempted',
            claim: { ...request.claim, hasCommittedAttempt: false },
            closureReceipt: createTestClaimClosureReceiptV02(request.claim, request.executorIdentity),
          };
      const invalidProof = await command.tools.recoverAttemptStart(recoveryId);
      assert.equal(invalidProof.outcome, 'blocked', 'An unfenced owner reply cannot close an unattempted claim');
      assert.equal(command.journal.getJournalSnapshot().closures.length, 0);
      assert.equal(command.journal.getJournalSnapshot().claims[0]?.status, 'claimed');
      assert.equal(writerAcquired, false);

      allowTrustedNoAttemptProof = true;
      const result = await command.tools.recoverAttemptStart(recoveryId);
      const closed = command.journal.getJournalSnapshot();
      assert.equal(result.outcome, 'settled');
      assert.equal(closed.claims[0]?.status, 'closed');
      assert.equal(closed.attempts.length, 0);
      assert.equal(closed.closures.length, 1);
      assert.equal(closed.activeClaimId, null);
      assert.equal(command.journal.getLedgers().filter((ledger) =>
        ['timeoutMs', 'maxOutputBytes', 'maxCpuSeconds', 'maxMemoryBytes', 'maxProcessCount'].includes(ledger.kind))
        .every((ledger) => ledger.reservations.length === 0 && ledger.consumed === 0), true);
      assert.equal(command.attempts.length, 0, 'Recovery does not retry a rejected beginAttempt');
      assert.equal(command.controller.executedPlans.length, 0);
      assert.equal(leaseReleaseCalls, 1, 'The command lease is released once after canonical closure');
      const writerLease = await waitingWriter;
      assert.equal(writerAcquired, true);
      await writerLease.release();
    });

    it('retries a failed lease release after closing an unattempted command claim', async () => {
      const command = await createJournalBackedCommandHarness('act-command-closure-release-retry');
      const acquireReadLease = command.manager.acquireReadLease.bind(command.manager);
      let leaseReleaseCalls = 0;
      command.manager.acquireReadLease = async (workspaceId, expectedRevision) => {
        const lease = await acquireReadLease(workspaceId, expectedRevision);
        const release = lease.release.bind(lease);
        lease.release = async () => {
          if (++leaseReleaseCalls === 1) throw new Error('lease release failed');
          await release();
        };
        return lease;
      };
      command.journal.beginAttempt = async () => { throw new Error('beginAttempt rejected before commit'); };
      const recoveryId = await getAttemptStartRecoveryId(() => command.tools.runCommand(command.action, command.context));
      assert.equal((await command.tools.recoverAttemptStart(recoveryId)).outcome, 'blocked');
      const closed = command.journal.getJournalSnapshot();
      const ledgers = command.journal.getLedgers();
      assert.equal(closed.claims[0]?.status, 'closed');
      assert.equal(closed.closures.length, 1);
      assert.equal(leaseReleaseCalls, 1);
      let writerAcquired = false;
      const waitingWriter = command.manager.acquireWriteLease('ws-test-1', canonicalRev).then((lease) => {
        writerAcquired = true;
        return lease;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(writerAcquired, false, 'The failed release retains the lease');

      const result = await command.tools.recoverAttemptStart(recoveryId);
      assert.deepEqual(result, { outcome: 'settled', recoveryId, receiptId: closed.closures[0]?.receiptId });
      assert.equal(leaseReleaseCalls, 2);
      assert.deepEqual(command.journal.getJournalSnapshot(), closed, 'Retry preserves the closed journal');
      assert.deepEqual(command.journal.getLedgers(), ledgers, 'Retry does not repeat reservation refunds');
      assert.equal(command.controller.executedPlans.length, 0);
      assert.throws(() => command.tools.recoverAttemptStart(recoveryId), /ATTEMPT_START_RECOVERY_NOT_FOUND/);
      const writerLease = await waitingWriter;
      assert.equal(writerAcquired, true);
      await writerLease.release();
    });

    it('retries a failed lease release after outcome settlement without repeating reconciliation', async () => {
      const command = await createJournalBackedCommandHarness('act-command-outcome-release-retry', true);
      const acquireReadLease = command.manager.acquireReadLease.bind(command.manager);
      const releaseStarted = Promise.withResolvers<undefined>();
      const finishRelease = Promise.withResolvers<undefined>();
      let leaseAcquisitions = 0;
      let leaseReleaseCalls = 0;
      command.manager.acquireReadLease = async (workspaceId, expectedRevision) => {
        const lease = await acquireReadLease(workspaceId, expectedRevision);
        if (++leaseAcquisitions !== 1) return lease;
        const release = lease.release.bind(lease);
        lease.release = async () => {
          if (++leaseReleaseCalls === 1) throw new Error('lease release failed');
          releaseStarted.resolve(undefined);
          await finishRelease.promise;
          await release();
        };
        return lease;
      };
      command.controller.executionFailure = new Error('controller lost its response');
      await assert.rejects(() => command.tools.runCommand(command.action, command.context), /COMMAND_OUTCOME_PENDING/);
      const attemptId = command.attempts[0]?.attemptId;
      assert.ok(attemptId);
      await assert.rejects(() => command.tools.recoverCommandOutcome(attemptId), /lease release failed/);
      const settled = command.journal.getJournalSnapshot();
      const ledgers = command.journal.getLedgers();
      assert.equal(settled.claims[0]?.status, 'settled');
      assert.equal(settled.reconciliations.length, 1);
      let writerAcquired = false;
      const waitingWriter = command.manager.acquireWriteLease('ws-test-1', canonicalRev).then((lease) => {
        writerAcquired = true;
        return lease;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(writerAcquired, false);

      command.recoveryBehavior.failNextPrepare = true;
      const retry = command.tools.recoverCommandOutcome(attemptId);
      await Promise.race([releaseStarted.promise, retry]);
      try {
        assert.equal(leaseReleaseCalls, 2, 'The settled outcome retries only lease release');
        await assert.rejects(() => command.tools.recoverCommandOutcome(attemptId), /REPOSITORY_OUTCOME_RECOVERY_IN_PROGRESS/);
        assert.equal(leaseReleaseCalls, 2, 'Concurrent recovery cannot release the lease twice');
        assert.equal(writerAcquired, false, 'The lease stays held until release completes');
      } finally {
        finishRelease.resolve(undefined);
      }
      assert.deepEqual(await retry, { outcome: 'settled', receiptId: settled.reconciliations[0]?.reconciliationId });
      assert.equal(command.recoveryBehavior.failNextPrepare, true, 'Retry does not request new recovery evidence');
      assert.deepEqual(command.journal.getJournalSnapshot(), settled);
      assert.deepEqual(command.journal.getLedgers(), ledgers, 'Retry does not settle accounting twice');
      assert.equal(command.controller.executedPlans.length, 1);
      await assert.rejects(() => command.tools.recoverCommandOutcome(attemptId), /COMMAND_RECOVERY_NOT_FOUND/);
      const writerLease = await waitingWriter;
      assert.equal(writerAcquired, true);
      await writerLease.release();
    });

    it('recovers a malformed committed command receipt without retrying the attempt or dispatch', async () => {
      const command = await createJournalBackedCommandHarness('act-command-attempt-start-malformed', true);
      const begin = command.journal.beginAttempt.bind(command.journal);
      command.journal.beginAttempt = async (claimId, identity) => {
        const committed = await begin(claimId, identity);
        return { ...committed, executorIdentity: { ...committed.executorIdentity, payloadDigest: 'sha256:wrong' } };
      };
      const recoveryId = await getAttemptStartRecoveryId(() => command.tools.runCommand(command.action, command.context));
      const pending = command.journal.getJournalSnapshot();
      assert.equal(pending.attempts.length, 1, 'The malformed response followed a real journal commit');
      assert.equal(pending.outcomes.length, 0);
      assert.equal(command.controller.executedPlans.length, 0);

      const result = await command.tools.recoverAttemptStart(recoveryId);
      const settled = command.journal.getJournalSnapshot();
      assert.equal(result.outcome, 'settled');
      assert.equal(settled.attempts[0]?.status, 'settled');
      assert.equal(settled.claims[0]?.status, 'settled');
      assert.equal(settled.reconciliations.length, 1);
      assert.equal(settled.activeClaimId, null);
      assert.equal(command.attempts.length, 1);
      assert.equal(command.controller.executedPlans.length, 0);
      const readerLease = await command.manager.acquireReadLease('ws-test-1', canonicalRev);
      await readerLease.release();
    });

    it('holds a patch write lease through beginAttempt response loss until public recovery settles the journal', async () => {
      const patch = await createJournalBackedPatchHarness('act-patch-attempt-start-lost-response');
      const acquireWriteLease = patch.manager.acquireWriteLease.bind(patch.manager);
      let trackOriginalWriteLease = true;
      let leaseReleaseCalls = 0;
      patch.manager.acquireWriteLease = async (workspaceId, expectedRevision) => {
        const lease = await acquireWriteLease(workspaceId, expectedRevision);
        if (trackOriginalWriteLease) {
          trackOriginalWriteLease = false;
          const release = lease.release.bind(lease);
          lease.release = async () => { leaseReleaseCalls += 1; await release(); };
        }
        return lease;
      };
      const begin = patch.journal.beginAttempt.bind(patch.journal);
      patch.journal.beginAttempt = async (claimId, identity) => {
        await begin(claimId, identity);
        throw new Error('beginAttempt response was lost after patch claim commit');
      };
      const recoveryId = await getAttemptStartRecoveryId(() => patch.tools.applyPatch(patch.patch, patch.context));
      const pending = patch.journal.getJournalSnapshot();
      assert.equal(pending.attempts.length, 1);
      assert.equal(pending.outcomes.length, 0);
      assert.equal(patch.patchCalls(), 0, 'The patch effect is not invoked while attempt start is unknown');

      let readerAcquired = false;
      const waitingReader = patch.manager.acquireReadLease('ws-test-1', canonicalRev).then((lease) => {
        readerAcquired = true;
        return lease;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(readerAcquired, false, 'The patch write lease remains held after the original call fails');

      const result = await patch.tools.recoverAttemptStart(recoveryId);
      const recovered = patch.journal.getJournalSnapshot();
      assert.equal(result.outcome, 'settled');
      assert.equal(recovered.outcomes[0]?.outcome, 'uncertain');
      assert.equal(recovered.reconciliations.length, 1);
      assert.equal(recovered.claims[0]?.status, 'settled');
      assert.equal(recovered.attempts[0]?.status, 'settled');
      assert.equal(recovered.activeClaimId, null);
      assert.equal(patch.journal.getLedgers().every((ledger) => ledger.reservations.length === 0), true);
      assert.equal(patch.attempts.length, 1, 'Recovery does not retry beginAttempt');
      assert.equal(patch.patchCalls(), 0, 'Recovery does not dispatch the patch effect');
      assert.equal(leaseReleaseCalls, 1, 'The patch lease is released once after canonical settlement');
      const readerLease = await waitingReader;
      assert.equal(readerAcquired, true);
      await readerLease.release();
      const writerLease = await patch.manager.acquireWriteLease('ws-test-1', canonicalRev);
      await writerLease.release();
    });
  });

  describe('Positive execution through controller boundary & exact attempt identity forwarding', () => {
    it('runCommand: acquires workspace read lease, calls beginAttempt once, and dispatches to controller spy', async () => {
      const controller = new RepositoryTestDockerController();
      controller.outputToReturn = { exitCode: 0, stdout: 'pytest passed\n', stderr: '', durationMs: 5 };

      const manager = new DockerWorkspaceManager({ controller });
      const profile = {
        profileId: 'profile-uc03-test',
        image: 'ghcr.io/test:0.1',
        imageDigest: canonicalRev,
        user: '1000:1000',
        readOnlyRootFilesystem: true as const,
        network: 'none' as const,
        limits: { timeoutMs: 30000, maxMemoryBytes: 2147483648, maxCpuCores: 2, maxPids: 256 },
        mounts: [],
      };

      const ws = await manager.createWorkspace({
        taskId: 'task-test-1',
        workspaceId: 'ws-test-1',
        initialRevisionDigest: canonicalRev,
        profile,
      });

      controller.snapshotToReturn = {
        canonicalRevisionDigest: canonicalRev,
        entries: [{ path: 'src/app.py', kind: 'regular', content: 'test', digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }],
      };
      const view = await manager.admitCommandView({ workspaceId: ws.workspaceId });

      const executor = new StructuredCommandExecutor({
        manager,
        controller,
        profile,
        adapterIdentity: 'structured-command-executor',
        processIncarnation: 'inc-repo-receiver-1',
        fencingGeneration: 1,
      });

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        commandExecutor: executor,
        trustedCommandResourcePolicy: {
          isolationProfileRef: 'profile-uc03-test',
          limits: { timeoutMs: 30000, maxOutputBytes: 65536, maxCpuCores: 2, maxMemoryBytes: 2147483648, maxPids: 256 },
        },
        adapterIdentity: 'structured-command-executor',
        processIncarnation: 'inc-repo-receiver-1',
        fencingGeneration: 1,
        patchRecoveryHandoff: createUnavailableRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
      });

      const action: RunCommandAction = {
        actionId: 'act-cmd-pos-1',
        kind: 'run_command',
        executable: 'pytest',
        argv: ['-q'],
        workingDirectory: '/workspace/repo',
      };
      const actionDigest = computeActionDigest(action);

      const context = createTestAdmissionContext({
        action,
        actionDigest,
        commandBounds: {
          timeoutMs: 11,
          maxOutputBytes: 13,
          maxCpuSeconds: 0.005,
          maxMemoryBytes: 134217728,
          maxProcessCount: 3,
          isolationProfileRef: 'profile-uc03-test',
        },
        commandView: {
          viewId: view.viewId,
          viewDigest: view.viewDigest,
          taskId: 'task-test-1',
          workspaceId: 'ws-test-1',
          canonicalRevision: canonicalRev,
          admittedFiles: view.admittedFiles,
          exclusionsPolicyVersion: '0.1.0',
          scratchIdentity: 'scratch-1',
          mountedReadOnly: true,
          isolationProfileRef: 'profile-uc03-test',
        },
      });

      assert.equal(context.commandView?.viewId, view.viewId);
      assert.equal(context.commandView?.viewDigest, view.viewDigest);
      assert.equal(context.commandView?.canonicalRevision, view.canonicalRevisionDigest);

      const res = await tools.runCommand(action, context);
      assert.equal(res.exitCode, 0);
      assert.equal(res.stdout, 'pytest passed');

      // Verify beginAttempt was called exactly ONCE
      assert.equal(statePort.beginAttemptCalls.length, 1);
      assert.equal(statePort.beginAttemptCalls[0]?.claimId, 'claim-act-cmd-pos-1');

      // Verify controller was dispatched exactly ONCE
      assert.equal(controller.executedPlans.length, 1);
      assert.equal(controller.executedPlans[0]?.executable, 'pytest');
      assert.equal(controller.executedPlans[0]?.limits.timeoutMs, 11);
      assert.equal(controller.executedPlans[0]?.limits.maxOutputBytes, 13);
      assert.equal(controller.executedPlans[0]?.limits.maxCpuCores, 0.005 * 1000 / 11);
      assert.equal(controller.executedPlans[0]?.limits.maxMemoryBytes, 134217728);
      assert.equal(controller.executedPlans[0]?.limits.maxPids, 3);

      const timeoutAction: RunCommandAction = { ...action, actionId: 'act-cmd-timeout-1' };
      const timeoutContext = createTestAdmissionContext({
        action: timeoutAction,
        actionDigest: computeActionDigest(timeoutAction),
        commandView: context.commandView,
      });
      controller.outputToReturn = { exitCode: 0, stdout: '', stderr: '', durationMs: 11, timedOut: true };
      await assert.rejects(() => tools.runCommand(timeoutAction, timeoutContext), /COMMAND_TIMED_OUT/);
    });

    it('runTests: calls beginAttempt once and returns CheckResult with execution output', async () => {
      const controller = new RepositoryTestDockerController();
      controller.outputToReturn = { exitCode: 0, stdout: '1 passed\n', stderr: '', durationMs: 55 };

      const manager = new DockerWorkspaceManager({ controller });
      const profile = {
        profileId: 'profile-uc03-test',
        image: 'ghcr.io/test:0.1',
        imageDigest: canonicalRev,
        user: '1000:1000',
        readOnlyRootFilesystem: true as const,
        network: 'none' as const,
        limits: { timeoutMs: 30000, maxMemoryBytes: 2147483648, maxCpuCores: 2, maxPids: 256 },
        mounts: [],
      };

      const ws = await manager.createWorkspace({
        taskId: 'task-test-1',
        workspaceId: 'ws-test-1',
        initialRevisionDigest: canonicalRev,
        profile,
      });

      controller.snapshotToReturn = {
        canonicalRevisionDigest: canonicalRev,
        entries: [{ path: 'src/app.py', kind: 'regular', content: 'test', digest: 'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }],
      };
      const view = await manager.admitCommandView({ workspaceId: ws.workspaceId });

      const executor = new StructuredCommandExecutor({
        manager,
        controller,
        profile,
        adapterIdentity: 'structured-command-executor',
        processIncarnation: 'inc-test-runner-1',
        fencingGeneration: 1,
      });

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        commandExecutor: executor,
        trustedCommandResourcePolicy: {
          isolationProfileRef: 'profile-uc03-test',
          limits: { timeoutMs: 30000, maxOutputBytes: 65536, maxCpuCores: 2, maxMemoryBytes: 2147483648, maxPids: 256 },
        },
        adapterIdentity: 'structured-command-executor',
        processIncarnation: 'inc-test-runner-1',
        fencingGeneration: 1,
        patchRecoveryHandoff: createUnavailableRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
      });

      const action: RunCommandAction = {
        actionId: 'act-test-run-1',
        kind: 'run_command',
        executable: 'pytest',
        argv: ['-q'],
        workingDirectory: '/workspace/repo',
      };
      const actionDigest = computeActionDigest(action);

      const context = createTestAdmissionContext({
        action,
        actionDigest,
        checkId: 'chk-pytest-1',
        commandView: {
          viewId: view.viewId,
          viewDigest: view.viewDigest,
          taskId: 'task-test-1',
          workspaceId: 'ws-test-1',
          canonicalRevision: canonicalRev,
          admittedFiles: view.admittedFiles,
          exclusionsPolicyVersion: '0.1.0',
          scratchIdentity: 'scratch-1',
          mountedReadOnly: true,
          isolationProfileRef: 'profile-uc03-test',
        },
      });

      const check: CheckDefinition = { checkId: 'chk-pytest-1', executable: 'pytest', argv: ['-q'], workingDirectory: '/workspace/repo', purpose: 'reproduction' };
      const mismatchedCheck = { ...check, executable: 'python' };
      await assert.rejects(() => tools.runTests(mismatchedCheck, context), /CHECK_ADMISSION_MISMATCH/);
      const checkWithoutWorkingDirectory: CheckDefinition = { checkId: check.checkId, executable: check.executable, argv: check.argv, purpose: check.purpose };
      await assert.rejects(() => tools.runTests(checkWithoutWorkingDirectory, context), /CHECK_ADMISSION_MISMATCH/);
      assert.equal(statePort.beginAttemptCalls.length, 0);
      assert.equal(controller.executedPlans.length, 0);

      const checkRes = await tools.runTests(check, context);

      assert.equal(checkRes.checkId, 'chk-pytest-1');
      assert.equal(checkRes.outcome, 'pass');
      assert.equal(checkRes.outputExcerpt, '1 passed\n');

      assert.equal(statePort.beginAttemptCalls.length, 1);
      assert.equal(controller.executedPlans.length, 1);

      const admittedView = context.commandView;
      assert.ok(admittedView);
      const reportedZeroTimeoutAction: RunCommandAction = { ...action, actionId: 'act-test-reported-zero-timeout-1' };
      const reportedZeroTimeoutContext = createTestAdmissionContext({
        action: reportedZeroTimeoutAction,
        actionDigest: computeActionDigest(reportedZeroTimeoutAction),
        checkId: 'chk-reported-zero-timeout-1',
        commandView: admittedView,
      });
      const reportedZeroTimeoutCheck: CheckDefinition = { ...check, checkId: 'chk-reported-zero-timeout-1' };
      controller.outputToReturn = { exitCode: 0, stdout: 'partial output', stderr: '', durationMs: 55, timedOut: true };
      const reportedZeroTimeoutResult = await tools.runTests(reportedZeroTimeoutCheck, reportedZeroTimeoutContext);
      assert.equal(reportedZeroTimeoutResult.outcome, 'timeout');

      const timeoutAction: RunCommandAction = { ...action, actionId: 'act-test-timeout-1' };
      const timeoutContext = createTestAdmissionContext({
        action: timeoutAction,
        actionDigest: computeActionDigest(timeoutAction),
        checkId: 'chk-timeout-1',
        commandView: admittedView,
      });
      const timeoutCheck: CheckDefinition = { ...check, checkId: 'chk-timeout-1' };
      controller.outputToReturn = { exitCode: null, stdout: '', stderr: '', durationMs: 55, timedOut: true };
      const timeoutResult = await tools.runTests(timeoutCheck, timeoutContext);
      assert.equal(timeoutResult.outcome, 'timeout');
    });

    it('applyPatch: acquires writer lease, calls beginAttempt once, and executes patch receiver', async () => {
      let patchReceiverCalled = false;
      let attemptPassedToPatch: AttemptReceiptV02 | null = null;
      const { manager } = await createWorkspaceManager();

      const tools = new ControlledRepositoryTools({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
        statePort,
        workspaceManager: manager,
        adapterIdentity: 'patch-receiver',
        processIncarnation: 'inc-patch-1',
        fencingGeneration: 1,
        patchRecoveryHandoff: createTestPatchRecoveryHandoff(),
        attemptStartRecoveryHandoff: createUnknownAttemptStartRecoveryHandoff(),
        unattemptedClaimClosureHandoff: createRefusingClaimClosureHandoff(),
        patchReceiver: async (_patch, _context, attempt) => {
          patchReceiverCalled = true;
          attemptPassedToPatch = attempt;
          return { applied: true, newRevisionDigest: canonicalRev };
        },
      });

      const patchAction: ApplyPatchAction = {
        actionId: 'act-patch-pos-1',
        kind: 'apply_patch',
        patchContent: '--- a/src/app.py\n+++ b/src/app.py\n@@ -1 +1 @@\n-old\n+new\n',
        targetPaths: ['src/app.py'],
        baseRevisionDigest: canonicalRev,
      };
      const actionDigest = computeActionDigest(patchAction);

      const context = createTestAdmissionContext({
        action: patchAction,
        actionDigest,
        baseRevision: canonicalRev,
      });

      const res = await tools.applyPatch(patchAction, context);

      assert.equal(res.applied, true);
      assert.equal(res.newRevisionDigest, canonicalRev);
      assert.equal(patchReceiverCalled, true);
      assert.ok(attemptPassedToPatch);
      assert.equal(statePort.beginAttemptCalls.length, 1);
      assert.equal(statePort.beginAttemptCalls[0]?.claimId, 'claim-act-patch-pos-1');
    });
  });

  describe('ControlledRepositoryToolsV02 and createRepositoryReceiverV02 entrypoints', () => {
    it('creates compile-safe RepositoryPortV02 receiver instances', () => {
      const v02Instance: RepositoryPortV02 = new ControlledRepositoryToolsV02({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });
      assert.ok(v02Instance instanceof ControlledRepositoryTools);
      assert.equal(Object.getOwnPropertyDescriptor(v02Instance, 'executionGuardApiVersion')?.value, '0.2.0');

      const receiver: RepositoryPortV02 = createRepositoryReceiverV02({
        guardCapability: guard,
        fsPort,
        limits: defaultLimits,
      });
      assert.ok(receiver);
      assert.equal(Object.getOwnPropertyDescriptor(receiver, 'executionGuardApiVersion')?.value, '0.2.0');
    });
  });
});
