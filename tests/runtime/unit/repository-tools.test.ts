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
  containsProtectedContent,
  type TrustedFilesystemPort,
  type TrustedFilesystemEntry,
  type FileStat,
  type ExecutionGuardReadCapability,
  type GuardedReadOperation,
  type RepositoryReadLimits,
} from '../../../src/foundation/repository-tools.ts';
import { validateSourceEvidence } from '../../../src/contracts/uc03.ts';

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

  async mediateRead<T>(operation: GuardedReadOperation<T>): Promise<T> {
    this.mediatedOperations.push(operation as GuardedReadOperation<unknown>);
    if (!this.allowOperations) {
      throw new Error(`GUARD_DENIED: ${this.denialReason}`);
    }
    return await operation.execute();
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
