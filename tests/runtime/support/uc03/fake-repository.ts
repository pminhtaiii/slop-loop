/**
 * UC-03 Phase 2 - FakeRepositoryPort
 *
 * Owned path: tests/runtime/support/uc03/fake-repository.ts
 * Feature: specs/001-verified-code-repair
 *
 * Deterministic test-only implementation of RepositoryPort for controlled offline testing.
 * Replaced by real Docker workspace lifecycle (T006), controlled repository tools (T007),
 * and authoritative execution guard composition (T022), wired at integration (T028).
 *
 * Invariants:
 * - Provenance is strictly 'mock'; rejected by isAdmittedForProduction.
 * - Zero real filesystem access or child process execution; purely memory-backed snapshots and spies.
 * - Enforces path containment (isCanonicalRelativePath) and rejects protected paths (isProtectedPath).
 * - Tracks versioned repository snapshots with SHA-256 revision digests.
 * - Commands and test runners act strictly as spies, returning only scripted diagnostics.
 */

import {
  type RepositoryPort,
  type PortProvenance,
  type SourceEvidence,
  type ApplyPatchAction,
  type RunCommandAction,
  type CheckDefinition,
  type CheckResult,
  type ValidationError,
  isCanonicalRelativePath,
  isProtectedPath,
  validateNormalizedAction,
  validateCheckDefinition,
  validateSourceEvidence,
  validateCheckResult,
  computeCanonicalSha256,
} from '../../../../src/contracts/uc03.ts';

export interface RepositorySnapshot {
  readonly revisionDigest: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface ScriptedCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ScriptedDiffResult {
  readonly diff: string;
  readonly diffDigest: string;
  readonly changedFiles: readonly string[];
}

export interface FakeRepositoryOptions {
  readonly initialRevision?: string | undefined;
  readonly initialFiles?: Readonly<Record<string, string>> | undefined;
  readonly commandResults?: Readonly<Record<string, ScriptedCommandResult>> | undefined;
  readonly testResults?: Readonly<Record<string, CheckResult>> | undefined;
  readonly diffResults?: Readonly<Record<string, ScriptedDiffResult>> | undefined;
}

export class FakeRepositoryPort implements RepositoryPort {
  readonly provenance: PortProvenance = 'mock';

  private currentRevisionDigest: string;
  private snapshots = new Map<string, Map<string, string>>();
  private commandResponses = new Map<string, ScriptedCommandResult>();
  private testResponses = new Map<string, CheckResult>();
  private diffResponses = new Map<string, ScriptedDiffResult>();

  // Spies
  private commandSpy: RunCommandAction[] = [];
  private testSpy: CheckDefinition[] = [];
  private patchSpy: ApplyPatchAction[] = [];
  private readSpy: string[] = [];
  private searchSpy: string[] = [];
  private listSpy: string[] = [];

  constructor(options?: FakeRepositoryOptions) {
    const rev =
      options?.initialRevision ??
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    this.currentRevisionDigest = rev;

    const initialMap = new Map<string, string>();
    if (options?.initialFiles) {
      for (const [path, content] of Object.entries(options.initialFiles)) {
        initialMap.set(path, content);
      }
    } else {
      // Default initial python calculator files
      initialMap.set(
        'src/calculator.py',
        'class Calculator:\n    def divide(self, a, b):\n        return a / b\n'
      );
      initialMap.set(
        'tests/test_calculator.py',
        'import pytest\nfrom src.calculator import Calculator\n\ndef test_divide():\n    calc = Calculator()\n    assert calc.divide(10, 2) == 5\n'
      );
    }
    this.snapshots.set(rev, initialMap);

    if (options?.commandResults) {
      for (const [k, v] of Object.entries(options.commandResults)) {
        this.commandResponses.set(k, v);
      }
    }
    if (options?.testResults) {
      for (const [k, v] of Object.entries(options.testResults)) {
        this.testResponses.set(k, v);
      }
    }
    if (options?.diffResults) {
      for (const [k, v] of Object.entries(options.diffResults)) {
        this.diffResponses.set(k, v);
      }
    }
  }

  get currentRevision(): string {
    return this.currentRevisionDigest;
  }

  get commands(): readonly RunCommandAction[] {
    return [...this.commandSpy];
  }

  get tests(): readonly CheckDefinition[] {
    return [...this.testSpy];
  }

  get patches(): readonly ApplyPatchAction[] {
    return [...this.patchSpy];
  }

  get reads(): readonly string[] {
    return [...this.readSpy];
  }

  get searches(): readonly string[] {
    return [...this.searchSpy];
  }

  get lists(): readonly string[] {
    return [...this.listSpy];
  }

  setSnapshot(revisionDigest: string, files: Readonly<Record<string, string>>): void {
    const fileMap = new Map<string, string>();
    for (const [path, content] of Object.entries(files)) {
      fileMap.set(path, content);
    }
    this.snapshots.set(revisionDigest, fileMap);
    this.currentRevisionDigest = revisionDigest;
  }

  setCommandResult(commandKey: string, result: ScriptedCommandResult): void {
    this.commandResponses.set(commandKey, result);
  }

  setTestResult(checkId: string, result: CheckResult): void {
    this.testResponses.set(checkId, result);
  }

  setDiffResult(baseRevisionDigest: string, result: ScriptedDiffResult): void {
    this.diffResponses.set(baseRevisionDigest, result);
  }

  private getCurrentFiles(): Map<string, string> {
    const files = this.snapshots.get(this.currentRevisionDigest);
    if (!files) {
      const empty = new Map<string, string>();
      this.snapshots.set(this.currentRevisionDigest, empty);
      return empty;
    }
    return files;
  }

  async listDir(dirPath: string): Promise<readonly string[]> {
    this.listSpy.push(dirPath);

    // Root listing can be empty string or '.'
    const normalized = dirPath === '' || dirPath === '.' ? '' : dirPath;
    if (normalized.length > 0) {
      if (!isCanonicalRelativePath(normalized)) {
        throw new Error(
          `WORKSPACE_ESCAPE: Path '${dirPath}' is not a canonical relative path`
        );
      }
      if (isProtectedPath(normalized)) {
        throw new Error(
          `PROTECTED_PATH_FORBIDDEN: Path '${dirPath}' is protected and cannot be listed`
        );
      }
    }

    const files = this.getCurrentFiles();
    const prefix = normalized.length > 0 ? `${normalized}/` : '';
    const entries = new Set<string>();

    for (const filePath of files.keys()) {
      if (isProtectedPath(filePath)) continue;
      if (prefix.length === 0) {
        const seg = filePath.split('/')[0];
        if (seg) entries.add(seg);
      } else if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const seg = rest.split('/')[0];
        if (seg) entries.add(seg);
      }
    }

    return Array.from(entries).sort();
  }

  async readFile(filePath: string): Promise<SourceEvidence> {
    this.readSpy.push(filePath);

    if (!isCanonicalRelativePath(filePath)) {
      throw new Error(
        `WORKSPACE_ESCAPE: Path '${filePath}' must be a canonical relative path`
      );
    }
    if (isProtectedPath(filePath)) {
      throw new Error(
        `PROTECTED_PATH_FORBIDDEN: Path '${filePath}' is protected and cannot be read`
      );
    }

    const files = this.getCurrentFiles();
    const content = files.get(filePath);
    if (content === undefined) {
      throw new Error(`FILE_NOT_FOUND: Path '${filePath}' does not exist in repository snapshot`);
    }

    const evidence: SourceEvidence = {
      path: filePath,
      revisionDigest: this.currentRevisionDigest,
      boundedExcerpt: content,
      resultCount: 1,
      truncated: false,
    };

    const valid = validateSourceEvidence(evidence);
    if (!valid.ok) {
      throw new Error(
        `INVALID_SOURCE_EVIDENCE: ${valid.errors.map((e) => e.message).join('; ')}`
      );
    }

    return valid.value;
  }

  async searchCode(query: string): Promise<readonly SourceEvidence[]> {
    this.searchSpy.push(query);

    const files = this.getCurrentFiles();
    const results: SourceEvidence[] = [];

    for (const [filePath, content] of files.entries()) {
      if (isProtectedPath(filePath)) continue;
      if (content.includes(query)) {
        const evidence: SourceEvidence = {
          path: filePath,
          revisionDigest: this.currentRevisionDigest,
          boundedExcerpt: content,
          resultCount: 1,
          truncated: false,
        };
        const valid = validateSourceEvidence(evidence);
        if (valid.ok) {
          results.push(valid.value);
        }
      }
    }

    return results;
  }

  async applyPatch(
    patch: ApplyPatchAction
  ): Promise<{ readonly applied: boolean; readonly newRevisionDigest: string }> {
    this.patchSpy.push(patch);

    const validation = validateNormalizedAction(patch);
    if (!validation.ok) {
      throw new Error(
        `INVALID_PATCH_ACTION: ${validation.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`
      );
    }

    // Base revision check
    if (patch.baseRevisionDigest !== this.currentRevisionDigest) {
      return {
        applied: false,
        newRevisionDigest: this.currentRevisionDigest,
      };
    }

    // Target path check: must not target protected files
    for (const target of patch.targetPaths) {
      if (!isCanonicalRelativePath(target)) {
        throw new Error(`WORKSPACE_ESCAPE: Target path '${target}' is not canonical`);
      }
      if (isProtectedPath(target)) {
        throw new Error(`PROTECTED_PATH_FORBIDDEN: Target path '${target}' is protected`);
      }
    }

    // Clone current snapshot to new snapshot
    const currentFiles = this.getCurrentFiles();
    const newFiles = new Map<string, string>(currentFiles);

    // Apply simple replacement if target is known or append patchContent marker
    for (const target of patch.targetPaths) {
      const existing = newFiles.get(target) ?? '';
      newFiles.set(target, `${existing}\n# patch:${patch.actionId}\n${patch.patchContent}`);
    }

    const newRev = computeCanonicalSha256({
      priorRevision: this.currentRevisionDigest,
      patchActionId: patch.actionId,
      patchDigest: computeCanonicalSha256(patch.patchContent),
    });

    this.snapshots.set(newRev, newFiles);
    this.currentRevisionDigest = newRev;

    return {
      applied: true,
      newRevisionDigest: newRev,
    };
  }

  async runCommand(
    action: RunCommandAction
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    this.commandSpy.push(action);

    const validation = validateNormalizedAction(action);
    if (!validation.ok) {
      throw new Error(
        `INVALID_COMMAND_ACTION: ${validation.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}`
      );
    }

    // Check scripted responses by exact command key or executable
    const fullKey = `${action.executable} ${action.argv.join(' ')}`;
    const scripted =
      this.commandResponses.get(fullKey) ??
      this.commandResponses.get(action.executable) ??
      this.commandResponses.get('default');

    if (scripted) {
      return scripted;
    }

    // Default clean output
    return {
      exitCode: 0,
      stdout: `[FakeRepositoryPort] executed command: ${fullKey}`,
      stderr: '',
    };
  }

  async runTests(check: CheckDefinition): Promise<CheckResult> {
    this.testSpy.push(check);

    const validationErrors: ValidationError[] = [];
    const valid = validateCheckDefinition(check, 'check', validationErrors);
    if (!valid) {
      throw new Error('INVALID_CHECK_DEFINITION: check failed validation');
    }

    const scripted =
      this.testResponses.get(check.checkId) ??
      this.testResponses.get('default');

    if (scripted) {
      const checked = validateCheckResult(scripted);
      if (checked.ok) return checked.value;
      return scripted;
    }

    // Default passing check result
    const defaultResult: CheckResult = {
      checkId: check.checkId,
      outcome: 'pass',
      outputExcerpt: `1 passed in 0.05s (${check.checkId})`,
      durationMs: 50,
    };

    return defaultResult;
  }

  async inspectDiff(
    baseRevisionDigest: string
  ): Promise<{ readonly diff: string; readonly diffDigest: string; readonly changedFiles: readonly string[] }> {
    const scripted = this.diffResponses.get(baseRevisionDigest);
    if (scripted) {
      return scripted;
    }

    const baseFiles = this.snapshots.get(baseRevisionDigest) ?? new Map<string, string>();
    const currentFiles = this.getCurrentFiles();

    const changedFiles: string[] = [];
    let diff = '';

    for (const [path, content] of currentFiles.entries()) {
      const baseContent = baseFiles.get(path);
      if (baseContent !== content) {
        changedFiles.push(path);
        diff += `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${baseContent ?? ''}\n+${content}\n`;
      }
    }

    const diffDigest = computeCanonicalSha256(diff);

    return {
      diff,
      diffDigest,
      changedFiles,
    };
  }
}
